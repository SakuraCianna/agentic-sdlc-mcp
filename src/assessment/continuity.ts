import { createHash } from "node:crypto";
import { z } from "zod";

import {
  buildEvidencePacket,
  EvidenceCompletenessSchema,
  EvidenceFreshnessSchema,
  EvidencePacketSchema,
  EvidenceSourceSchema,
  EvidenceStateSchema,
  type EvidenceItem,
  type EvidencePacket,
} from "../evidence/model.js";

const MAX_COMPARISON_ITEMS = 1_000;
const MAX_DISPLAY_ITEMS = 200;
const SafeIdSchema = z.string().max(200);
const IMMUTABLE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function isImmutableSha(sha: string | undefined): boolean {
  return typeof sha === "string" && IMMUTABLE_SHA.test(sha);
}

export const ContinuityContextSchema = z.object({
  headSha: z.string().max(200).optional(),
  baseSha: z.string().max(200).optional(),
  policyDigest: z.string().max(200).optional(),
  toolVersion: z.string().max(200).optional(),
}).strict();

export const EvidenceChangeSchema = z.object({
  id: SafeIdSchema,
  source: EvidenceSourceSchema,
  state: EvidenceStateSchema,
  previousState: EvidenceStateSchema.optional(),
  freshness: EvidenceFreshnessSchema,
  completeness: EvidenceCompletenessSchema,
  summary: z.string().max(200),
  recommendedNextAction: z.string().max(300),
});

export const ContinuityInvalidationCodeSchema = z.enum([
  "head_sha_changed",
  "base_sha_changed",
  "policy_digest_changed",
  "tool_version_changed",
  "schema_version_changed",
  "subject_ref_changed",
  "context_unavailable",
  "evidence_changed",
  "evidence_added",
  "evidence_removed",
  "evidence_not_verified",
  "evidence_not_fresh",
  "evidence_incomplete",
  "evidence_expired",
  "evidence_target_mismatch",
  "incomplete_packet",
  "display_truncated",
]);

export const EvidenceContinuityResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  comparison: z.enum(["valid", "invalid"]),
  invalidReason: z.enum([
    "packet_schema_invalid",
    "subject_mismatch",
    "duplicate_evidence_id",
    "comparison_budget_exceeded",
    "context_invalid",
  ]).optional(),
  previousDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  currentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  added: z.array(EvidenceChangeSchema).max(MAX_DISPLAY_ITEMS),
  removed: z.array(EvidenceChangeSchema).max(MAX_DISPLAY_ITEMS),
  changed: z.array(EvidenceChangeSchema).max(MAX_DISPLAY_ITEMS),
  unchanged: z.array(EvidenceChangeSchema).max(MAX_DISPLAY_ITEMS),
  invalidations: z.array(z.object({
    code: ContinuityInvalidationCodeSchema,
    evidenceIds: z.array(SafeIdSchema).max(MAX_DISPLAY_ITEMS),
    recommendedNextAction: z.string().max(300),
  })).max(30),
  omittedChanges: z.number().int().nonnegative(),
  requiresRevalidation: z.boolean(),
  verificationInherited: z.literal(false),
  limitations: z.array(z.string().max(300)).max(10),
});

export type ContinuityContext = z.infer<typeof ContinuityContextSchema>;
export type EvidenceContinuityResult = z.infer<typeof EvidenceContinuityResultSchema>;
type InvalidationCode = z.infer<typeof ContinuityInvalidationCodeSchema>;
type Change = z.infer<typeof EvidenceChangeSchema>;

export interface CompareEvidencePacketsOptions {
  previousContext?: ContinuityContext;
  currentContext?: ContinuityContext;
  /** Explicit evaluation time keeps expiry decisions reproducible. Defaults to current packet time. */
  evaluatedAt?: string;
}

function safeId(id: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,199}$/.test(id)
    ? id
    : `evidence:${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

function itemDigest(item: EvidenceItem): string {
  // Reuse the packet's canonicalization, including its volatile timestamp exclusions.
  return buildEvidencePacket({
    generatorVersion: "continuity",
    subject: item.subject,
    evidence: [item],
    collectedAt: item.collectedAt,
  }).contentDigest;
}

function sameIdentity(previous: EvidencePacket, current: EvidencePacket): boolean {
  const left = previous.subject;
  const right = current.subject;
  if (["pull_request", "issue"].includes(left.type) && (!left.number || !right.number)) return false;
  return left.repo.toLowerCase() === right.repo.toLowerCase()
    && left.type === right.type
    && left.number === right.number
    && (left.type !== "release" || left.ref === right.ref);
}

function invalid(reason: EvidenceContinuityResult["invalidReason"]): EvidenceContinuityResult {
  return {
    schemaVersion: "1.0",
    comparison: "invalid",
    invalidReason: reason,
    added: [], removed: [], changed: [], unchanged: [], invalidations: [],
    omittedChanges: 0,
    requiresRevalidation: true,
    verificationInherited: false,
    limitations: ["Packets cannot be compared safely; collect a complete packet for the intended subject."],
  };
}

function describe(item: EvidenceItem, disposition: string, previous?: EvidenceItem): Change {
  return {
    id: safeId(item.id),
    source: item.source,
    state: item.state,
    ...(previous ? { previousState: previous.state } : {}),
    freshness: item.freshness,
    completeness: item.completeness,
    summary: `Evidence item is ${disposition}; this comparison does not establish acceptance.`,
    recommendedNextAction: disposition === "unchanged"
      ? "Evaluate the current evidence against the current target and policy."
      : "Collect and verify evidence for the current target and policy.",
  };
}

function uniqueValues(packet: EvidencePacket, property: "policyDigest" | "toolVersion"): string[] {
  return [...new Set(packet.evidence.map((item) => item.provenance[property] ?? ""))].sort();
}

/** Compare bounded evidence snapshots without carrying a previous verification forward. */
export function compareEvidencePackets(
  previous: EvidencePacket,
  current: EvidencePacket,
  options: CompareEvidencePacketsOptions = {}
): EvidenceContinuityResult {
  const previousParse = EvidencePacketSchema.safeParse(previous);
  const currentParse = EvidencePacketSchema.safeParse(current);
  if (!previousParse.success || !currentParse.success) return invalid("packet_schema_invalid");
  previous = previousParse.data;
  current = currentParse.data;
  if (!sameIdentity(previous, current)) return invalid("subject_mismatch");
  if (Math.max(previous.evidence.length, current.evidence.length) > MAX_COMPARISON_ITEMS) {
    return invalid("comparison_budget_exceeded");
  }
  if ([previous, current].some((packet) => new Set(packet.evidence.map((item) => item.id)).size !== packet.evidence.length)) {
    return invalid("duplicate_evidence_id");
  }
  const beforeContext = ContinuityContextSchema.safeParse(options.previousContext ?? {});
  const afterContext = ContinuityContextSchema.safeParse(options.currentContext ?? {});
  if (!beforeContext.success || !afterContext.success) return invalid("context_invalid");
  if ((beforeContext.data.headSha && previous.subject.sha && beforeContext.data.headSha !== previous.subject.sha)
    || (afterContext.data.headSha && current.subject.sha && afterContext.data.headSha !== current.subject.sha)) {
    return invalid("context_invalid");
  }
  const evaluationTime = Date.parse(options.evaluatedAt ?? current.collectedAt);
  if (!Number.isFinite(evaluationTime)) return invalid("context_invalid");

  const result: EvidenceContinuityResult = {
    schemaVersion: "1.0", comparison: "valid",
    previousDigest: previous.contentDigest, currentDigest: current.contentDigest,
    added: [], removed: [], changed: [], unchanged: [], invalidations: [],
    omittedChanges: 0, requiresRevalidation: false, verificationInherited: false,
    limitations: [
      "Unchanged evidence is a content comparison, never inherited verification or proof of business acceptance.",
      "Packet digests identify content; they are not signatures or proof of the producer's authenticity.",
    ],
  };
  const invalidate = (code: InvalidationCode, ids: string[] = []) => {
    result.invalidations.push({
      code,
      evidenceIds: ids.slice(0, MAX_DISPLAY_ITEMS).map(safeId),
      recommendedNextAction: "Recollect and verify affected evidence for the current target, policy, and tool version.",
    });
    result.requiresRevalidation = true;
  };

  const beforeHead = beforeContext.data.headSha ?? previous.subject.sha;
  const afterHead = afterContext.data.headSha ?? current.subject.sha;
  if (beforeHead !== afterHead) invalidate("head_sha_changed");
  if (![previous.subject.sha, current.subject.sha, beforeHead, afterHead].every(isImmutableSha)) invalidate("context_unavailable");
  if (beforeContext.data.baseSha !== afterContext.data.baseSha) invalidate("base_sha_changed");
  const baseShas = [beforeContext.data.baseSha, afterContext.data.baseSha];
  if ((previous.subject.type === "pull_request" && !baseShas.every(isImmutableSha))
    || baseShas.some((sha) => sha !== undefined && !isImmutableSha(sha))) {
    if (!result.invalidations.some((entry) => entry.code === "context_unavailable")) invalidate("context_unavailable");
  }
  if (beforeContext.data.policyDigest !== afterContext.data.policyDigest
    || JSON.stringify(uniqueValues(previous, "policyDigest")) !== JSON.stringify(uniqueValues(current, "policyDigest"))) {
    invalidate("policy_digest_changed");
  }
  if (previous.generatorVersion !== current.generatorVersion
    || beforeContext.data.toolVersion !== afterContext.data.toolVersion
    || JSON.stringify(uniqueValues(previous, "toolVersion")) !== JSON.stringify(uniqueValues(current, "toolVersion"))) {
    invalidate("tool_version_changed");
  }
  if (previous.schemaVersion !== current.schemaVersion) invalidate("schema_version_changed");
  if (previous.subject.ref !== current.subject.ref) invalidate("subject_ref_changed");

  const before = new Map(previous.evidence.map((item) => [item.id, item]));
  const after = new Map(current.evidence.map((item) => [item.id, item]));
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const oldItem = before.get(id);
    const newItem = after.get(id);
    if (!oldItem && newItem) result.added.push(describe(newItem, "added"));
    else if (oldItem && !newItem) result.removed.push(describe(oldItem, "removed"));
    else if (oldItem && newItem) {
      const changed = itemDigest(oldItem) !== itemDigest(newItem)
        || oldItem.state !== newItem.state
        || oldItem.expiresAt !== newItem.expiresAt;
      result[changed ? "changed" : "unchanged"].push(describe(newItem, changed ? "changed" : "unchanged", oldItem));
    }
  }
  for (const [key, code] of [
    ["added", "evidence_added"], ["removed", "evidence_removed"], ["changed", "evidence_changed"],
  ] as const) {
    if (result[key].length) invalidate(code, result[key].map((item) => item.id));
  }
  for (const [code, predicate] of [
    ["evidence_not_verified", (item: EvidenceItem) => !["verified", "not_applicable"].includes(item.state) || item.source === "caller_assertion"],
    ["evidence_not_fresh", (item: EvidenceItem) => item.freshness !== "fresh"],
    ["evidence_incomplete", (item: EvidenceItem) => item.completeness !== "complete"],
    ["evidence_expired", (item: EvidenceItem) => item.expiresAt !== undefined && (!Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= evaluationTime)],
    ["evidence_target_mismatch", (item: EvidenceItem) => item.subject.repo.toLowerCase() !== current.subject.repo.toLowerCase()
      || (item.subject.type === current.subject.type && item.subject.number !== current.subject.number)
      || (item.subject.type === current.subject.type && !isImmutableSha(item.subject.sha))
      || (item.provenance.subjectSha !== undefined && !isImmutableSha(item.provenance.subjectSha))
      || Boolean(current.subject.sha && ((item.subject.sha && item.subject.sha !== current.subject.sha)
        || (item.provenance.subjectSha && item.provenance.subjectSha !== current.subject.sha)))],
  ] as const) {
    const ids = current.evidence.filter(predicate).map((item) => item.id);
    if (ids.length) invalidate(code, ids);
  }
  if (current.omittedEvidence.length || current.summary.omittedIds.length || current.limitations.length) {
    invalidate("incomplete_packet");
  }
  for (const key of ["added", "removed", "changed", "unchanged"] as const) {
    result.omittedChanges += Math.max(0, result[key].length - MAX_DISPLAY_ITEMS);
    result[key] = result[key].slice(0, MAX_DISPLAY_ITEMS);
  }
  if (result.omittedChanges) invalidate("display_truncated");
  return EvidenceContinuityResultSchema.parse(result);
}

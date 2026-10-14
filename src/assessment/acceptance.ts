import { createHash } from "node:crypto";
import { z } from "zod";

import { EvidencePacketSchema, type EvidenceItem, type EvidencePacket } from "../evidence/model.js";
import { protectUntrustedText } from "../security/prompt-injection.js";

const MAX_SOURCE_CHARACTERS = 100_000;
const MAX_SOURCE_LINES = 2_000;
const MAX_CRITERIA = 100;
const MAX_MAPPINGS = 500;
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const CriterionIdSchema = z.string().regex(/^ac:[a-f0-9]{24}$/);
const EvidenceIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/);
const IMMUTABLE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export const AcceptanceSourceInputSchema = z.object({
  kind: z.enum(["issue", "speckit", "openspec", "markdown"]),
  locator: z.string().max(2_000).optional(),
}).strict();
export const AcceptanceCriterionSchema = z.object({
  id: CriterionIdSchema,
  contentDigest: DigestSchema,
  summary: z.string().max(1_000),
  checked: z.boolean(),
  source: z.object({
    kind: AcceptanceSourceInputSchema.shape.kind,
    locator: z.string().regex(/^source:[a-f0-9]{24}$/),
    line: z.number().int().positive().max(MAX_SOURCE_LINES),
    documentDigest: DigestSchema,
  }).strict(),
}).strict();
export const AcceptanceExtractionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  criteria: z.array(AcceptanceCriterionSchema).max(MAX_CRITERIA),
  truncated: z.boolean(),
  limitations: z.array(z.string().max(300)).max(10),
}).strict();

const AssociationSchema = z.object({
  criterionId: CriterionIdSchema,
  evidenceId: EvidenceIdSchema,
  relation: z.literal("association"),
}).strict();
const VerificationBindingSchema = z.object({
  criterionId: CriterionIdSchema,
  evidenceId: EvidenceIdSchema,
  relation: z.enum(["verification", "not_applicable"]),
  criterionDigest: DigestSchema,
  sourceContentDigest: DigestSchema,
  subjectSha: z.string().min(1).max(200),
}).strict();
export const AcceptanceEvidenceMappingSchema = z.union([AssociationSchema, VerificationBindingSchema]);
export const AcceptanceMappingsSchema = z.array(AcceptanceEvidenceMappingSchema).max(MAX_MAPPINGS);

/** Host configuration is independent of untrusted mappings and has no default trusted producers. */
export const TrustedAcceptanceVerificationSourceSchema = z.object({
  source: z.literal("github_check_run"),
  appId: z.number().int().positive(),
  provider: z.string().min(1).max(100),
}).strict();
export const AcceptanceStatusSchema = z.enum([
  "verified", "unverified", "needs_human", "not_applicable", "missing",
]);
export const AcceptanceTraceabilityResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  criteria: z.array(z.object({
    criterion: AcceptanceCriterionSchema,
    status: AcceptanceStatusSchema,
    associatedEvidenceIds: z.array(EvidenceIdSchema).max(MAX_MAPPINGS),
    verificationEvidenceIds: z.array(EvidenceIdSchema).max(MAX_MAPPINGS),
    reason: z.string().max(300),
    recommendedNextAction: z.string().max(300),
  })).max(MAX_CRITERIA),
  summary: z.object({
    verified: z.number().int().nonnegative(),
    unverified: z.number().int().nonnegative(),
    needs_human: z.number().int().nonnegative(),
    not_applicable: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
  }),
  complete: z.boolean(),
  limitations: z.array(z.string().max(300)).max(15),
}).strict();

export type AcceptanceSourceInput = z.infer<typeof AcceptanceSourceInputSchema>;
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
export type AcceptanceExtraction = z.infer<typeof AcceptanceExtractionSchema>;
export type AcceptanceEvidenceMapping = z.infer<typeof AcceptanceEvidenceMappingSchema>;
export type TrustedAcceptanceVerificationSource = z.infer<typeof TrustedAcceptanceVerificationSourceSchema>;
export type AcceptanceTraceabilityResult = z.infer<typeof AcceptanceTraceabilityResultSchema>;
type AcceptanceStatus = z.infer<typeof AcceptanceStatusSchema>;

export interface EvaluateAcceptanceTraceabilityInput {
  criteria: AcceptanceExtraction;
  evidence: EvidencePacket;
  mappings?: AcceptanceEvidenceMapping[];
  /** Only the integrating host may register producers; never read this list from mapping files. */
  trustedVerificationSources?: TrustedAcceptanceVerificationSource[];
  /** Defaults to the current packet's collection time for deterministic expiry evaluation. */
  evaluatedAt?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Extract explicit checklist/numbered conditions only; checked boxes remain untrusted claims. */
export function extractAcceptanceCriteria(
  markdown: string,
  source: AcceptanceSourceInput = { kind: "markdown" }
): AcceptanceExtraction {
  source = AcceptanceSourceInputSchema.parse(source);
  const boundedText = markdown.slice(0, MAX_SOURCE_CHARACTERS);
  const allLines = boundedText.split(/\r?\n/);
  const lines = allLines.slice(0, MAX_SOURCE_LINES);
  const locator = `source:${digest(`${source.kind}\n${source.locator ?? "inline"}`).slice(0, 24)}`;
  const documentDigest = digest(boundedText);
  const criteria: AcceptanceCriterion[] = [];
  const knownIds = new Set<string>();
  let truncated = markdown.length > MAX_SOURCE_CHARACTERS || allLines.length > MAX_SOURCE_LINES;
  let duplicateCount = 0;
  let fence: { marker: string; length: number } | undefined;
  let inComment = false;
  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (line.includes("<!--")) inComment = true;
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const checkbox = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+)$/.exec(line);
    const numbered = checkbox ? null : /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (!checkbox && !numbered) continue;
    const text = (checkbox?.[2] ?? numbered![1]).trim().replace(/\s+/g, " ");
    if (!text) continue;
    const contentDigest = digest(text);
    const id = `ac:${digest(`${source.kind}\n${locator}\n${contentDigest}`).slice(0, 24)}`;
    if (knownIds.has(id)) { duplicateCount += 1; continue; }
    if (criteria.length >= MAX_CRITERIA) { truncated = true; break; }
    knownIds.add(id);
    criteria.push({
      id, contentDigest,
      summary: protectUntrustedText(text, { maxLength: 300 }).rendered,
      checked: Boolean(checkbox && checkbox[1].toLowerCase() === "x"),
      source: { kind: source.kind, locator, line: index + 1, documentDigest },
    });
  }
  return AcceptanceExtractionSchema.parse({
    schemaVersion: "1.0", criteria, truncated,
    limitations: [
      "Criteria summaries are untrusted source data; checked boxes and agent claims do not prove satisfaction.",
      "Only explicit checkbox and numbered lines are extracted; semantic completeness requires human review.",
      ...(truncated ? ["Acceptance source exceeded its character, line, or criterion budget; omitted conditions remain unverified."] : []),
      ...(duplicateCount ? ["Duplicate condition text from the same source was consolidated; the first source line is retained."] : []),
    ],
  });
}

function sameTarget(item: EvidenceItem, packet: EvidencePacket): boolean {
  if (["pull_request", "issue"].includes(packet.subject.type)
    && (!Number.isSafeInteger(packet.subject.number) || (packet.subject.number ?? 0) <= 0
      || !Number.isSafeInteger(item.subject.number) || (item.subject.number ?? 0) <= 0)) return false;
  return item.subject.repo.toLowerCase() === packet.subject.repo.toLowerCase()
    && item.subject.type === packet.subject.type
    && item.subject.number === packet.subject.number
    && item.subject.sha === packet.subject.sha;
}

function trustedProvenance(item: EvidenceItem, packet: EvidencePacket): boolean {
  if (item.source !== "github_check_run" || !item.provenance.appId || !item.provenance.provider) return false;
  try {
    const url = new URL(item.provenance.url ?? "");
    return url.protocol === "https:" && url.hostname === "github.com"
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.toLowerCase().startsWith(`/${packet.subject.repo.toLowerCase()}/actions/runs/`)
      && /^\d+(?:\/job\/\d+)?\/?$/.test(url.pathname.slice(`/${packet.subject.repo}/actions/runs/`.length));
  } catch {
    return false;
  }
}

function assessBinding(
  mapping: Exclude<AcceptanceEvidenceMapping, { relation: "association" }>,
  criterion: AcceptanceCriterion,
  item: EvidenceItem | undefined,
  packet: EvidencePacket,
  trustedSources: TrustedAcceptanceVerificationSource[],
  evaluationTime: number
): AcceptanceStatus {
  if (!item || mapping.criterionDigest !== criterion.contentDigest
    || item.provenance.sourceContentDigest !== mapping.sourceContentDigest
    || ![packet.subject.sha, item.subject.sha, mapping.subjectSha, item.provenance.subjectSha]
      .every((sha) => typeof sha === "string" && IMMUTABLE_SHA.test(sha))
    || mapping.subjectSha !== packet.subject.sha
    || item.provenance.subjectSha !== mapping.subjectSha
    || !sameTarget(item, packet)
    || item.state !== "verified" || item.freshness !== "fresh" || item.completeness !== "complete"
    || (item.expiresAt !== undefined && (!Number.isFinite(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) <= evaluationTime))) {
    return "unverified";
  }
  const expectedKind = mapping.relation === "not_applicable" ? "acceptance_scope" : "acceptance_verification";
  const expectedId = `acceptance:${mapping.relation === "not_applicable" ? "scope" : "verification"}:${criterion.contentDigest}`;
  if (item.kind !== expectedKind || item.id !== expectedId || !trustedProvenance(item, packet)) return "needs_human";
  const trusted = trustedSources.some((source) => source.source === item.source
    && source.appId === item.provenance.appId && source.provider === item.provenance.provider);
  if (!trusted) return "needs_human";
  return mapping.relation === "not_applicable" ? "not_applicable" : "verified";
}

/** Associations are traceability links. Only separately trusted criterion-specific producers can prove satisfaction. */
export function evaluateAcceptanceTraceability(input: EvaluateAcceptanceTraceabilityInput): AcceptanceTraceabilityResult {
  const extraction = AcceptanceExtractionSchema.parse(input.criteria);
  const packet = EvidencePacketSchema.parse(input.evidence);
  const mappings = AcceptanceMappingsSchema.parse(input.mappings ?? []);
  const trustedSources = z.array(TrustedAcceptanceVerificationSourceSchema).max(100).parse(input.trustedVerificationSources ?? []);
  const evaluationTime = Date.parse(input.evaluatedAt ?? packet.collectedAt);
  if (!Number.isFinite(evaluationTime)) throw new Error("Acceptance evaluation requires a valid evaluation time.");
  if (packet.evidence.length > 1_000) throw new Error("Acceptance evidence exceeds the comparison budget.");
  const evidenceById = new Map(packet.evidence.map((item) => [item.id, item]));
  const duplicateEvidence = evidenceById.size !== packet.evidence.length;
  const criterionIds = new Set(extraction.criteria.map((criterion) => criterion.id));
  if (criterionIds.size !== extraction.criteria.length) throw new Error("Acceptance criteria contain duplicate IDs.");
  const unknownMappings = mappings.some((mapping) => !criterionIds.has(mapping.criterionId));
  const packetIncomplete = packet.omittedEvidence.length > 0 || packet.summary.omittedIds.length > 0;
  const summary: AcceptanceTraceabilityResult["summary"] = {
    verified: 0, unverified: 0, needs_human: 0, not_applicable: 0, missing: 0,
  };
  const rows = extraction.criteria.map((criterion) => {
    const links = mappings.filter((mapping) => mapping.criterionId === criterion.id);
    const associatedEvidenceIds = [...new Set(links.map((mapping) => mapping.evidenceId))];
    const verificationEvidenceIds: string[] = [];
    let status: AcceptanceStatus = links.length ? "needs_human" : "missing";
    const decisions: AcceptanceStatus[] = [];
    for (const mapping of links) {
      if (mapping.relation === "association") {
        if (!evidenceById.has(mapping.evidenceId)) decisions.push("unverified");
        continue;
      }
      const decision = assessBinding(mapping, criterion, evidenceById.get(mapping.evidenceId), packet, trustedSources, evaluationTime);
      decisions.push(decision);
      if (decision === "verified" || decision === "not_applicable") verificationEvidenceIds.push(mapping.evidenceId);
    }
    if (decisions.includes("unverified")) status = "unverified";
    else if (decisions.includes("verified") && decisions.includes("not_applicable")) status = "needs_human";
    else if (decisions.includes("verified")) status = "verified";
    else if (decisions.includes("not_applicable")) status = "not_applicable";
    if ((extraction.truncated || duplicateEvidence || packetIncomplete) && ["verified", "not_applicable"].includes(status)) {
      status = "unverified";
    }
    summary[status] += 1;
    const reasons: Record<AcceptanceStatus, string> = {
      verified: "A separately trusted, criterion-specific producer verified the bound current-target evidence.",
      not_applicable: "A separately trusted scope producer verified the bound applicability decision.",
      needs_human: "Evidence is associated, but criterion-specific satisfaction or applicability has not been independently established.",
      unverified: "A binding is missing, mismatched, stale, incomplete, conflicting, or unavailable; it cannot establish satisfaction.",
      missing: "No structured evidence association exists for this criterion.",
    };
    return {
      criterion, status, associatedEvidenceIds,
      verificationEvidenceIds: ["verified", "not_applicable"].includes(status) ? [...new Set(verificationEvidenceIds)] : [],
      reason: reasons[status],
      recommendedNextAction: ["verified", "not_applicable"].includes(status)
        ? "Retain the criterion-specific verification source and reassess after target or criterion changes."
        : "Have a human review this condition and collect criterion-specific verification for the current target.",
    };
  });
  return AcceptanceTraceabilityResultSchema.parse({
    schemaVersion: "1.0", criteria: rows, summary,
    complete: rows.length > 0 && summary.verified + summary.not_applicable === rows.length
      && !extraction.truncated && !duplicateEvidence && !packetIncomplete && !unknownMappings,
    limitations: [
      "Mappings provide associations, not self-authenticating proof; CI success and checked boxes cannot prove business acceptance.",
      "No acceptance producer is trusted by default. The host must register a producer independently of local mappings.",
      "Packet contents and digests are not cryptographically authenticated by this local assessment.",
      ...(extraction.truncated ? ["Acceptance extraction was truncated; complete coverage cannot be established."] : []),
      ...(duplicateEvidence ? ["Duplicate evidence IDs make bindings ambiguous."] : []),
      ...(packetIncomplete ? ["Evidence packet contains omitted evidence; complete coverage cannot be established."] : []),
      ...(unknownMappings ? ["Mappings reference unknown criteria; those associations were not applied."] : []),
      ...(rows.length === 0 ? ["No explicit conditions were extracted; absence of conditions is not acceptance."] : []),
    ],
  });
}

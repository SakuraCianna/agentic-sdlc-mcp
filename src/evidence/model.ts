import { createHash } from "node:crypto";
import { z } from "zod";

export const EVIDENCE_SCHEMA_VERSION = "1.0" as const;

export const EvidenceStateSchema = z.enum([
  "verified",
  "failed",
  "pending",
  "unverified",
  "not_applicable",
]);
export const EvidenceFreshnessSchema = z.enum(["fresh", "stale", "unknown"]);
export const EvidenceCompletenessSchema = z.enum(["complete", "partial", "omitted"]);
export const EvidenceSourceSchema = z.enum([
  "github_api",
  "github_check_run",
  "repository_file",
  "repository_policy",
  "caller_assertion",
  "system",
]);
export const EvidenceSubjectSchema = z.object({
  type: z.enum(["repository", "pull_request", "issue", "release"]),
  repo: z.string(),
  number: z.number().int().positive().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
});
export const EvidenceProvenanceSchema = z.object({
  url: z.string().optional(),
  provider: z.string().optional(),
  ref: z.string().optional(),
  subjectSha: z.string().optional(),
  sourceContentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  policyDigest: z.string().optional(),
  appId: z.number().int().positive().optional(),
  toolVersion: z.string().optional(),
});
export const EvidenceItemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject: EvidenceSubjectSchema,
  state: EvidenceStateSchema,
  freshness: EvidenceFreshnessSchema,
  completeness: EvidenceCompletenessSchema,
  source: EvidenceSourceSchema,
  collectedAt: z.string(),
  sourceUpdatedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  provenance: EvidenceProvenanceSchema,
  reason: z.string(),
  limitations: z.array(z.string()),
  recommendedNextActions: z.array(z.string()),
});

const EvidenceIdsByStateSchema = z.object({
  verified: z.array(z.string()),
  failed: z.array(z.string()),
  pending: z.array(z.string()),
  unverified: z.array(z.string()),
  not_applicable: z.array(z.string()),
});

export const EvidenceBudgetSchema = z.object({
  maxEvidenceItems: z.number().int().positive(),
  maxGithubRequests: z.number().int().positive(),
  maxSourceTextCharacters: z.number().int().positive(),
  maxFilesPerSource: z.number().int().positive(),
  maxItemsPerSource: z.number().int().positive(),
  maxRenderedMarkdownCharacters: z.number().int().positive(),
  collectionTimeoutMs: z.number().int().positive(),
});
export const OmittedEvidenceSchema = z.object({
  kind: z.string(),
  count: z.number().int().positive(),
  reason: z.string(),
});

export const EvidencePacketSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_SCHEMA_VERSION),
  generatorVersion: z.string(),
  subject: EvidenceSubjectSchema,
  evidence: z.array(EvidenceItemSchema),
  summary: z.object({
    idsByState: EvidenceIdsByStateSchema,
    staleIds: z.array(z.string()),
    partialIds: z.array(z.string()),
    omittedIds: z.array(z.string()),
  }),
  recommendedNextActions: z.array(z.string()),
  limitations: z.array(z.string()),
  budget: EvidenceBudgetSchema,
  omittedEvidence: z.array(OmittedEvidenceSchema),
  collectedAt: z.string(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

export type EvidenceState = z.infer<typeof EvidenceStateSchema>;
export type EvidenceFreshness = z.infer<typeof EvidenceFreshnessSchema>;
export type EvidenceCompleteness = z.infer<typeof EvidenceCompletenessSchema>;
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export type EvidenceSubject = z.infer<typeof EvidenceSubjectSchema>;
export type EvidenceProvenance = z.infer<typeof EvidenceProvenanceSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type EvidenceItemInput = Omit<EvidenceItem, "subject"> & {
  subject?: EvidenceSubject;
};
export type OmittedEvidence = z.infer<typeof OmittedEvidenceSchema>;
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;

export interface BuildEvidencePacketInput {
  generatorVersion: string;
  subject: EvidenceSubject;
  evidence: EvidenceItemInput[];
  collectedAt?: string;
  limitations?: string[];
  maxEvidenceItems?: number;
  omittedEvidence?: OmittedEvidence[];
}

export const DEFAULT_MAX_EVIDENCE_ITEMS = 100;
export const DEFAULT_EVIDENCE_BUDGET = {
  maxEvidenceItems: DEFAULT_MAX_EVIDENCE_ITEMS,
  maxGithubRequests: 40,
  maxSourceTextCharacters: 20_000,
  maxFilesPerSource: 300,
  maxItemsPerSource: 300,
  maxRenderedMarkdownCharacters: 50_000,
  collectionTimeoutMs: 30_000,
} as const;

const CALLER_ASSERTION_LIMITATION =
  "Caller assertions cannot be promoted to verified system evidence.";
const MISSING_PROVENANCE_LIMITATION =
  "Verified evidence requires traceable provenance.";

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeEvidenceItem(
  item: EvidenceItemInput,
  packetSubject: EvidenceSubject
): EvidenceItem {
  const normalized: EvidenceItem = {
    ...item,
    subject: item.subject ?? packetSubject,
  };
  if (normalized.state !== "verified") return normalized;
  if (normalized.source === "caller_assertion") {
    return {
      ...normalized,
      state: "unverified",
      limitations: unique([...normalized.limitations, CALLER_ASSERTION_LIMITATION]),
    };
  }

  const traceable = Boolean(
    normalized.provenance.url ||
      normalized.provenance.ref ||
      normalized.provenance.subjectSha ||
      normalized.provenance.sourceContentDigest ||
      normalized.provenance.policyDigest
  );
  return traceable
    ? normalized
    : {
        ...normalized,
        state: "unverified",
        limitations: unique([...normalized.limitations, MISSING_PROVENANCE_LIMITATION]),
      };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !["collectedAt", "sourceUpdatedAt", "expiresAt", "requestId", "correlationId"].includes(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function contentDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

/** Build a versioned packet and enforce trust invariants at the evidence seam. */
export function buildEvidencePacket(input: BuildEvidencePacketInput): EvidencePacket {
  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const normalizedEvidence = input.evidence.map((item) =>
    normalizeEvidenceItem(item, input.subject)
  );
  const maxEvidenceItems = Math.max(
    1,
    Math.floor(input.maxEvidenceItems ?? DEFAULT_EVIDENCE_BUDGET.maxEvidenceItems)
  );
  const evidence = normalizedEvidence.slice(0, maxEvidenceItems);
  const omittedCount = normalizedEvidence.length - evidence.length;
  const omittedEvidence = [
    ...(input.omittedEvidence ?? []),
    ...(omittedCount > 0
      ? [{
          kind: "evidence_item",
          count: omittedCount,
          reason: `Evidence packet exceeded the ${maxEvidenceItems}-item budget.`,
        }]
      : []),
  ];
  const states: EvidenceState[] = [
    "verified",
    "failed",
    "pending",
    "unverified",
    "not_applicable",
  ];
  const idsByState = Object.fromEntries(
    states.map((state) => [
      state,
      evidence.filter((item) => item.state === state).map((item) => item.id),
    ])
  ) as EvidencePacket["summary"]["idsByState"];
  const recommendedNextActions = unique(
    evidence.flatMap((item) => item.recommendedNextActions)
  );
  const limitations = unique([
    ...(input.limitations ?? []),
    ...evidence.flatMap((item) => item.limitations),
  ]);
  const stableContent = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    generatorVersion: input.generatorVersion,
    subject: input.subject,
    evidence,
    summary: {
      idsByState,
      staleIds: evidence.filter((item) => item.freshness === "stale").map((item) => item.id),
      partialIds: evidence
        .filter((item) => item.completeness === "partial")
        .map((item) => item.id),
      omittedIds: evidence
        .filter((item) => item.completeness === "omitted")
        .map((item) => item.id),
    },
    recommendedNextActions,
    limitations,
    budget: {
      ...DEFAULT_EVIDENCE_BUDGET,
      maxEvidenceItems,
    },
    omittedEvidence,
  };

  return {
    ...stableContent,
    collectedAt,
    contentDigest: contentDigest(stableContent),
  };
}

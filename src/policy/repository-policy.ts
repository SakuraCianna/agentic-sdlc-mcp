import { createHash } from "node:crypto";

import { parseDocument } from "yaml";
import { z } from "zod";

import type { SdlcWorkType } from "../types.js";

export const POLICY_PATH = ".agentic-sdlc.yml";
export const MAX_POLICY_BYTES = 64 * 1024;
const MAX_POLICY_DEPTH = 20;
const MAX_POLICY_NODES = 2_000;
const MAX_POLICY_GLOB_CHARS = 300;

const WORK_TYPES = [
  "docs",
  "feature",
  "bugfix",
  "refactor",
  "security",
  "release",
  "infra",
] as const;

const DEFAULT_RELEASE_BLOCKING_LABELS = [
  "do-not-merge",
  "blocked",
  "release-blocker",
  "security-blocker",
];

const PolicyIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/i, "must be a stable dotted policy ID");

function safePolicyText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "must not contain control characters",
    });
}

const CheckNameSchema = safePolicyText(200);
const LabelSchema = safePolicyText(100);
const DomainSchema = safePolicyText(100);
const GlobSchema = z.string().trim().min(1).max(MAX_POLICY_GLOB_CHARS);
const ReviewerSchema = z
  .string()
  .trim()
  .regex(
    /^@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?$/,
    "must be a GitHub user or team such as @user or @org/team"
  );

const RequiredCheckSchema = z
  .object({
    name: CheckNameSchema,
    source: z.literal("check_run"),
    appId: z.number().int().positive(),
  })
  .strict();

const RiskRuleSchema = z
  .object({
    id: PolicyIdSchema,
    paths: z.array(GlobSchema).min(1).max(100),
    workTypes: z.array(z.enum(WORK_TYPES)).max(WORK_TYPES.length).default([]),
    level: z.enum(["low", "medium", "high", "critical"]),
    domains: z.array(DomainSchema).min(1).max(50),
  })
  .strict();

const RequiredReviewerRuleSchema = z
  .object({
    id: PolicyIdSchema,
    riskRuleIds: z.array(PolicyIdSchema).max(100).default([]),
    paths: z.array(GlobSchema).max(100).default([]),
    reviewers: z.array(ReviewerSchema).min(1).max(50),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.riskRuleIds.length === 0 && rule.paths.length === 0) {
      context.addIssue({
        code: "custom",
        message: "must define at least one riskRuleIds or paths selector",
      });
    }
  });

export const RepositoryPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultWorkType: z.enum(WORK_TYPES).optional(),
    requiredChecks: z.array(RequiredCheckSchema).max(100).default([]),
    protectedPaths: z.array(GlobSchema).max(200).default([]),
    riskRules: z.array(RiskRuleSchema).max(100).default([]),
    labels: z
      .object({
        releaseBlocking: z
          .array(LabelSchema)
          .max(100)
          .default([...DEFAULT_RELEASE_BLOCKING_LABELS]),
      })
      .strict()
      .default({ releaseBlocking: [...DEFAULT_RELEASE_BLOCKING_LABELS] }),
    review: z
      .object({
        requireIssueLink: z.boolean().default(false),
        requireCodeOwnersForProtectedPaths: z.boolean().default(false),
        requiredReviewers: z.array(RequiredReviewerRuleSchema).max(100).default([]),
      })
      .strict()
      .default({
        requireIssueLink: false,
        requireCodeOwnersForProtectedPaths: false,
        requiredReviewers: [],
      }),
    release: z
      .object({
        requireChangelog: z.boolean().default(false),
        requireRollbackPlan: z.boolean().default(false),
      })
      .strict()
      .default({ requireChangelog: false, requireRollbackPlan: false }),
  })
  .strict();

export type EffectiveRepositoryPolicy = z.infer<typeof RepositoryPolicySchema>;
export type RepositoryRiskRule = EffectiveRepositoryPolicy["riskRules"][number];
export type RequiredReviewerRule =
  EffectiveRepositoryPolicy["review"]["requiredReviewers"][number];

export interface PolicySource {
  kind: "default" | "repository";
  path: string | null;
  ref: string | null;
  blobSha: string | null;
  digest: string;
}

export interface AppliedPolicyRule {
  id: string;
  source: "repository";
}

export interface IgnoredPolicyRule {
  id: string;
  reason: string;
}

export interface RepositoryPolicyParseResult {
  policy: EffectiveRepositoryPolicy;
  degraded: boolean;
  digest: string;
  appliedRules: AppliedPolicyRule[];
  ignoredRules: IgnoredPolicyRule[];
  errors: string[];
  warnings: string[];
}

export interface RepositoryPolicyMatch {
  protectedPaths: string[];
  riskRules: RepositoryRiskRule[];
  requiredReviewers: RequiredReviewerRule[];
  reviewers: string[];
}

export const DEFAULT_REPOSITORY_POLICY: EffectiveRepositoryPolicy =
  RepositoryPolicySchema.parse({ schemaVersion: 1 });

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function digestRepositoryPolicy(policy: EffectiveRepositoryPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(policy)))
    .digest("hex");
}

function defaultFailure(errors: string[]): RepositoryPolicyParseResult {
  return {
    policy: DEFAULT_REPOSITORY_POLICY,
    degraded: true,
    digest: digestRepositoryPolicy(DEFAULT_REPOSITORY_POLICY),
    appliedRules: [],
    ignoredRules: [],
    errors,
    warnings: [],
  };
}

function checkComplexity(value: unknown, depth = 0, counter = { nodes: 0 }): void {
  counter.nodes += 1;
  if (depth > MAX_POLICY_DEPTH) throw new Error("Policy nesting exceeds the supported depth.");
  if (counter.nodes > MAX_POLICY_NODES) throw new Error("Policy contains too many values.");
  if (Array.isArray(value)) {
    for (const item of value) checkComplexity(item, depth + 1, counter);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      checkComplexity(item, depth + 1, counter);
    }
  }
}

function normalizePolicyPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function validateGlob(pattern: string): string | null {
  const normalized = normalizePolicyPath(pattern);
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    return "must be a repository-relative path glob";
  }
  if (normalized.split("/").includes("..")) return "must not contain parent traversal";
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return "must not contain control characters";
  return null;
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const normalized = value.toLocaleLowerCase();
    if (seen.has(normalized)) duplicates.add(value);
    seen.add(normalized);
  }
  return [...duplicates];
}

function validateSemantics(policy: EffectiveRepositoryPolicy): string[] {
  const errors: string[] = [];
  const listChecks: Array<[string, readonly string[]]> = [
    ["protectedPaths", policy.protectedPaths],
    ["labels.releaseBlocking", policy.labels.releaseBlocking],
  ];
  if (
    duplicateValues(
      policy.requiredChecks.map(
        (check) => `${check.source}:${check.appId}:${check.name}`
      )
    ).length > 0
  ) {
    errors.push("requiredChecks contains duplicate source/app/name entries.");
  }
  for (const [path, values] of listChecks) {
    const duplicates = duplicateValues(values);
    if (duplicates.length > 0) errors.push(`${path} contains duplicate values.`);
  }

  const riskIds = policy.riskRules.map((rule) => rule.id);
  const reviewerIds = policy.review.requiredReviewers.map((rule) => rule.id);
  if (duplicateValues(riskIds).length > 0) errors.push("riskRules contains duplicate IDs.");
  if (duplicateValues(reviewerIds).length > 0) {
    errors.push("review.requiredReviewers contains duplicate IDs.");
  }

  const knownRiskIds = new Set(riskIds);
  for (const rule of policy.review.requiredReviewers) {
    if (duplicateValues(rule.riskRuleIds).length > 0 || duplicateValues(rule.paths).length > 0) {
      errors.push(`Reviewer rule ${rule.id} contains duplicate selectors.`);
    }
    if (duplicateValues(rule.reviewers).length > 0) {
      errors.push(`Reviewer rule ${rule.id} contains duplicate reviewers.`);
    }
    if (rule.riskRuleIds.some((id) => !knownRiskIds.has(id))) {
      errors.push(`Reviewer rule ${rule.id} references an unknown risk rule.`);
    }
  }

  const globs = [
    ...policy.protectedPaths,
    ...policy.riskRules.flatMap((rule) => rule.paths),
    ...policy.review.requiredReviewers.flatMap((rule) => rule.paths),
  ];
  for (const glob of globs) {
    const error = validateGlob(glob);
    if (error) errors.push(`Invalid repository path glob: ${error}.`);
  }
  return errors;
}

function buildAppliedRules(policy: EffectiveRepositoryPolicy): AppliedPolicyRule[] {
  const ids: string[] = [];
  if (policy.defaultWorkType) ids.push("work.default_type");
  if (policy.requiredChecks.length > 0) ids.push("ci.required_checks");
  if (policy.protectedPaths.length > 0) ids.push("paths.protected");
  ids.push(...policy.riskRules.map((rule) => rule.id));
  if (policy.labels.releaseBlocking.join("\u0000") !== DEFAULT_RELEASE_BLOCKING_LABELS.join("\u0000")) {
    ids.push("labels.release_blocking");
  }
  if (policy.review.requireIssueLink) ids.push("review.require_issue_link");
  if (policy.review.requireCodeOwnersForProtectedPaths) {
    ids.push("review.require_codeowners_for_protected_paths");
  }
  ids.push(...policy.review.requiredReviewers.map((rule) => rule.id));
  if (policy.release.requireChangelog) ids.push("release.require_changelog");
  if (policy.release.requireRollbackPlan) ids.push("release.require_rollback_plan");
  return ids.map((id) => ({ id, source: "repository" }));
}

export function parseRepositoryPolicy(source: string): RepositoryPolicyParseResult {
  if (Buffer.byteLength(source, "utf8") > MAX_POLICY_BYTES) {
    return defaultFailure([`Policy exceeds the ${MAX_POLICY_BYTES}-byte limit.`]);
  }

  let raw: unknown;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) {
      return defaultFailure(["Policy YAML is invalid or contains duplicate keys."]);
    }
    raw = document.toJS({ maxAliasCount: 20 });
    checkComplexity(raw);
  } catch {
    return defaultFailure(["Policy YAML exceeds safe parsing limits."]);
  }

  const parsed = RepositoryPolicySchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "policy";
      return `${path}: ${issue.message}`;
    });
    return defaultFailure(errors);
  }

  const semanticErrors = validateSemantics(parsed.data);
  if (semanticErrors.length > 0) return defaultFailure(semanticErrors);

  return {
    policy: parsed.data,
    degraded: false,
    digest: digestRepositoryPolicy(parsed.data),
    appliedRules: buildAppliedRules(parsed.data),
    ignoredRules: [],
    errors: [],
    warnings: [],
  };
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePolicyPath(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index] ?? "";
    const next = normalized[index + 1] ?? "";
    if (character === "*" && next === "*") {
      const followedBySlash = normalized[index + 2] === "/";
      source += followedBySlash ? "(?:.*/)?" : ".*";
      index += followedBySlash ? 2 : 1;
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

export function pathMatchesPolicyGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePolicyPath(path));
}

export function matchRepositoryPolicy(
  policy: EffectiveRepositoryPolicy,
  paths: readonly string[],
  workType?: SdlcWorkType
): RepositoryPolicyMatch {
  const protectedPaths = policy.protectedPaths.filter((pattern) =>
    paths.some((path) => pathMatchesPolicyGlob(path, pattern))
  );
  const riskRules = policy.riskRules.filter(
    (rule) =>
      (rule.workTypes.length === 0 || (workType !== undefined && rule.workTypes.includes(workType))) &&
      rule.paths.some((pattern) => paths.some((path) => pathMatchesPolicyGlob(path, pattern)))
  );
  const matchedRiskIds = new Set(riskRules.map((rule) => rule.id));
  const requiredReviewers = policy.review.requiredReviewers.filter(
    (rule) =>
      rule.riskRuleIds.some((id) => matchedRiskIds.has(id)) ||
      rule.paths.some((pattern) => paths.some((path) => pathMatchesPolicyGlob(path, pattern)))
  );
  return {
    protectedPaths,
    riskRules,
    requiredReviewers,
    reviewers: [...new Set(requiredReviewers.flatMap((rule) => rule.reviewers))],
  };
}

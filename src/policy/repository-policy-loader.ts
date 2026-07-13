import type { Octokit } from "@octokit/rest";

import type { RepoRef } from "../types.js";
import {
  DEFAULT_REPOSITORY_POLICY,
  POLICY_PATH,
  digestRepositoryPolicy,
  parseRepositoryPolicy,
  type AppliedPolicyRule,
  type EffectiveRepositoryPolicy,
  type IgnoredPolicyRule,
  type PolicySource,
} from "./repository-policy.js";

export interface RepositoryPolicyLoadResult {
  policy: EffectiveRepositoryPolicy;
  found: boolean;
  degraded: boolean;
  digest: string;
  policySources: PolicySource[];
  appliedRules: AppliedPolicyRule[];
  ignoredRules: IgnoredPolicyRule[];
  errors: string[];
  warnings: string[];
}

export interface RepositoryPolicySummary {
  found: boolean;
  degraded: boolean;
  schemaVersion: 1;
  defaultWorkType?: EffectiveRepositoryPolicy["defaultWorkType"];
  requiredChecks: EffectiveRepositoryPolicy["requiredChecks"];
  protectedPaths: string[];
  riskRuleIds: string[];
  requiredReviewerRuleIds: string[];
  releaseBlockingLabels: string[];
  requireIssueLink: boolean;
  requireCodeOwnersForProtectedPaths: boolean;
  requireChangelog: boolean;
  requireRollbackPlan: boolean;
}

export interface RepositoryPolicyCache {
  results: Map<string, Promise<RepositoryPolicyLoadResult>>;
}

const DEFAULT_POLICY_DIGEST = digestRepositoryPolicy(DEFAULT_REPOSITORY_POLICY);
const DEFAULT_SOURCE: PolicySource = {
  kind: "default",
  path: null,
  ref: null,
  blobSha: null,
  digest: DEFAULT_POLICY_DIGEST,
};

export function createRepositoryPolicyCache(): RepositoryPolicyCache {
  return { results: new Map() };
}

export function summarizeRepositoryPolicy(
  result: RepositoryPolicyLoadResult
): RepositoryPolicySummary {
  const { policy } = result;
  return {
    found: result.found,
    degraded: result.degraded,
    schemaVersion: policy.schemaVersion,
    ...(policy.defaultWorkType ? { defaultWorkType: policy.defaultWorkType } : {}),
    requiredChecks: policy.requiredChecks.map((check) => ({ ...check })),
    protectedPaths: [...policy.protectedPaths],
    riskRuleIds: policy.riskRules.map((rule) => rule.id),
    requiredReviewerRuleIds: policy.review.requiredReviewers.map((rule) => rule.id),
    releaseBlockingLabels: [...policy.labels.releaseBlocking],
    requireIssueLink: policy.review.requireIssueLink,
    requireCodeOwnersForProtectedPaths: policy.review.requireCodeOwnersForProtectedPaths,
    requireChangelog: policy.release.requireChangelog,
    requireRollbackPlan: policy.release.requireRollbackPlan,
  };
}

function defaultResult(
  overrides: Partial<RepositoryPolicyLoadResult> = {}
): RepositoryPolicyLoadResult {
  return {
    policy: DEFAULT_REPOSITORY_POLICY,
    found: false,
    degraded: false,
    digest: DEFAULT_POLICY_DIGEST,
    policySources: [DEFAULT_SOURCE],
    appliedRules: [],
    ignoredRules: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

export function unavailableRepositoryPolicyResult(
  message: string
): RepositoryPolicyLoadResult {
  return defaultResult({ degraded: true, errors: [message] });
}

function errorStatus(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

function cacheKey(ref: RepoRef, gitRef: string): string {
  return `${ref.owner.toLocaleLowerCase()}\u0000${ref.repo.toLocaleLowerCase()}\u0000${gitRef}\u0000${POLICY_PATH}`;
}

async function fetchRepositoryPolicy(
  ref: RepoRef,
  gitRef: string,
  octokit: Octokit
): Promise<RepositoryPolicyLoadResult> {
  let response: Awaited<ReturnType<Octokit["repos"]["getContent"]>>;
  try {
    response = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: POLICY_PATH,
      ref: gitRef,
    });
  } catch (error) {
    const status = errorStatus(error);
    if (status === 404) return defaultResult();
    return defaultResult({
      degraded: true,
      errors: [
        status === null
          ? "Repository policy could not be read because the GitHub request failed."
          : `Repository policy could not be read (GitHub status ${status}).`,
      ],
    });
  }

  const data = response.data;
  if (
    Array.isArray(data) ||
    data.type !== "file" ||
    !("content" in data) ||
    typeof data.content !== "string" ||
    data.content.length === 0
  ) {
    return defaultResult({
      found: true,
      degraded: true,
      errors: ["Repository policy response was not a readable file."],
    });
  }

  let content: string;
  try {
    const encoding = "encoding" in data ? data.encoding : "base64";
    if (encoding !== "base64") throw new Error("unsupported encoding");
    content = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch {
    return defaultResult({
      found: true,
      degraded: true,
      errors: ["Repository policy content could not be decoded safely."],
    });
  }

  const parsed = parseRepositoryPolicy(content);
  if (parsed.degraded) {
    return defaultResult({
      found: true,
      degraded: true,
      errors: parsed.errors,
      warnings: parsed.warnings,
      ignoredRules: parsed.ignoredRules,
    });
  }

  const blobSha = "sha" in data && typeof data.sha === "string" ? data.sha : null;
  return {
    ...parsed,
    found: true,
    policySources: [
      DEFAULT_SOURCE,
      {
        kind: "repository",
        path: POLICY_PATH,
        ref: gitRef,
        blobSha,
        digest: parsed.digest,
      },
    ],
  };
}

export async function loadRepositoryPolicy(
  ref: RepoRef,
  gitRef: string,
  octokit: Octokit,
  cache: RepositoryPolicyCache = createRepositoryPolicyCache()
): Promise<RepositoryPolicyLoadResult> {
  const key = cacheKey(ref, gitRef);
  let result = cache.results.get(key);
  if (!result) {
    result = fetchRepositoryPolicy(ref, gitRef, octokit);
    cache.results.set(key, result);
  }
  return result;
}

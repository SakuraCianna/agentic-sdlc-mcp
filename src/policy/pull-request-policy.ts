import type { SdlcWorkType } from "../types.js";
import {
  matchRepositoryPolicy,
  type EffectiveRepositoryPolicy,
  type PolicySource,
} from "./repository-policy.js";
import type { RepositoryPolicyLoadResult } from "./repository-policy-loader.js";

export interface PullRequestPolicyInput {
  paths: string[];
  workType?: SdlcWorkType;
  changedFilesComplete: boolean;
  linkedIssues: Array<{ number: number }> | null;
  approvedUsers: string[];
  requestedUsers: string[];
  requestedTeams: string[];
  codeOwnerReviewSatisfied: boolean | null;
}

export interface PullRequestPolicyReason {
  ruleId: string;
  message: string;
}

export interface PullRequestPolicyDecision {
  policyDigest: string;
  policySources: PolicySource[];
  policyDegraded: boolean;
  requiredChecks: EffectiveRepositoryPolicy["requiredChecks"];
  blockingLabels: string[];
  matchedProtectedPaths: string[];
  matchedRiskRuleIds: string[];
  requiredReviewerRuleIds: string[];
  requiredReviewers: string[];
  blockers: PullRequestPolicyReason[];
  pendingReviews: PullRequestPolicyReason[];
  policyGaps: PullRequestPolicyReason[];
}

function normalizeReviewer(value: string): string {
  return value.trim().replace(/^@/, "").toLocaleLowerCase();
}

function reviewerApproved(reviewer: string, approvedUsers: readonly string[]): boolean {
  const normalized = normalizeReviewer(reviewer);
  const candidates = new Set(approvedUsers.map(normalizeReviewer));
  // REST review evidence identifies users, not their organization-team
  // membership. Never treat an approving user whose login equals a team slug
  // as proof that @org/team approved.
  return !normalized.includes("/") && candidates.has(normalized);
}

function reviewerRequested(
  reviewer: string,
  requestedUsers: readonly string[],
  requestedTeams: readonly string[]
): boolean {
  const normalized = normalizeReviewer(reviewer);
  const candidates = new Set(
    [...requestedUsers, ...requestedTeams].flatMap((value) => {
      const item = normalizeReviewer(value);
      const slash = item.indexOf("/");
      return slash >= 0 ? [item, item.slice(slash + 1)] : [item];
    })
  );
  return candidates.has(normalized) || candidates.has(normalized.split("/").at(-1) ?? normalized);
}

export function evaluatePullRequestPolicy(
  loaded: RepositoryPolicyLoadResult,
  input: PullRequestPolicyInput
): PullRequestPolicyDecision {
  const match = matchRepositoryPolicy(loaded.policy, input.paths, input.workType);
  const blockers: PullRequestPolicyReason[] = [];
  const pendingReviews: PullRequestPolicyReason[] = [];
  const policyGaps: PullRequestPolicyReason[] = [];

  if (loaded.degraded) {
    policyGaps.push({
      ruleId: "policy.load",
      message: `Repository policy could not be verified: ${loaded.errors.join("; ") || "unknown error"}.`,
    });
  }

  const hasPathRules =
    loaded.policy.protectedPaths.length > 0 ||
    loaded.policy.riskRules.length > 0 ||
    loaded.policy.review.requiredReviewers.some((rule) => rule.paths.length > 0);
  if (!input.changedFilesComplete && hasPathRules) {
    policyGaps.push({
      ruleId: "policy.changed_files_complete",
      message: "Changed files are incomplete, so path-based repository policy cannot be fully evaluated.",
    });
  }

  if (loaded.policy.review.requireIssueLink) {
    if (input.linkedIssues === null) {
      policyGaps.push({
        ruleId: "review.require_issue_link",
        message: "Linked issue evidence is unavailable.",
      });
    } else if (input.linkedIssues.length === 0) {
      blockers.push({
        ruleId: "review.require_issue_link",
        message: "Repository policy requires the pull request to link an issue.",
      });
    }
  }

  if (
    match.protectedPaths.length > 0 &&
    loaded.policy.review.requireCodeOwnersForProtectedPaths
  ) {
    if (input.codeOwnerReviewSatisfied === null) {
      policyGaps.push({
        ruleId: "review.require_codeowners_for_protected_paths",
        message: "Required CODEOWNERS approval for protected paths could not be verified.",
      });
    } else if (!input.codeOwnerReviewSatisfied) {
      blockers.push({
        ruleId: "review.require_codeowners_for_protected_paths",
        message: "Protected paths require a satisfied CODEOWNERS review.",
      });
    }
  }

  for (const rule of match.requiredReviewers) {
    const missing = rule.reviewers.filter(
      (reviewer) => !reviewerApproved(reviewer, input.approvedUsers)
    );
    if (missing.length === 0) continue;
    const requested = missing.filter((reviewer) =>
      reviewerRequested(reviewer, input.requestedUsers, input.requestedTeams)
    );
    const message = `Required reviewer approval is missing for ${missing.join(", ")}.`;
    if (requested.length === missing.length) {
      pendingReviews.push({ ruleId: rule.id, message });
    } else {
      blockers.push({ ruleId: rule.id, message });
    }
  }

  return {
    policyDigest: loaded.digest,
    policySources: loaded.policySources,
    policyDegraded: loaded.degraded,
    requiredChecks: loaded.policy.requiredChecks.map((check) => ({ ...check })),
    blockingLabels: [...loaded.policy.labels.releaseBlocking],
    matchedProtectedPaths: match.protectedPaths,
    matchedRiskRuleIds: match.riskRules.map((rule) => rule.id),
    requiredReviewerRuleIds: match.requiredReviewers.map((rule) => rule.id),
    requiredReviewers: match.reviewers,
    blockers,
    pendingReviews,
    policyGaps,
  };
}

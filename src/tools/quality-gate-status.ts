/**
 * Tool: quality_gate_status
 *
 * Evaluates real pull-request merge evidence while preserving ref-only CI
 * compatibility and the legacy check-run summary fields.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import {
  collectCiEvidence,
  collectPullRequestEvidence,
  type CiEvidence,
  type GateSignal,
  type PullRequestEvidence,
  type RequiredStatusCheck,
  type SignalBuckets,
} from "../github/pull-request-evidence.js";
import type { CheckStatus, RepoRef } from "../types.js";
import { safeMarkdownInline } from "../rendering/markdown.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const DEFAULT_BLOCKING_LABELS = [
  "blocked",
  "do-not-merge",
  "release-blocker",
  "security-blocker",
] as const;

export const QualityGateInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z
    .number().int().positive().optional()
    .describe("PR number. Takes precedence over ref when provided."),
  ref: z
    .string().optional()
    .describe("Git ref (branch name, commit SHA). Ignored if pullNumber is set."),
  blockingLabels: z
    .array(z.string().min(1))
    .max(50)
    .default([...DEFAULT_BLOCKING_LABELS])
    .describe("Exact, case-insensitive PR labels that block the gate. Pass [] to disable."),
});

export type QualityGateInput = z.input<typeof QualityGateInputSchema>;

const CheckStatusShape = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
});

const GateSignalShape = z.object({
  name: z.string(),
  source: z.enum(["check_run", "commit_status"]),
  appId: z.number().int().nullable(),
  state: z.enum(["passing", "failing", "pending", "skipped"]),
  rawStatus: z.string().nullable(),
  rawConclusion: z.string().nullable(),
  rawState: z.string().nullable(),
  url: z.string().nullable(),
});

const RequiredStatusCheckShape = z.object({
  context: z.string(),
  appId: z.number().int().nullable(),
});

const SignalBucketsShape = z.object({
  passing: z.array(GateSignalShape),
  failing: z.array(GateSignalShape),
  pending: z.array(GateSignalShape),
  skipped: z.array(GateSignalShape),
  total: z.number().int().nonnegative(),
});

const LinkedIssueShape = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
});

const OwnershipGapShape = z.object({
  owner: z.string(),
  paths: z.array(z.string()),
});

const QualityGateEvidenceShape = z.object({
  scope: z.enum(["pull_request", "ref"]),
  checks: z.object({
    checkRuns: SignalBucketsShape,
    commitStatuses: SignalBucketsShape,
    totalSignals: z.number().int().nonnegative(),
    requiredContexts: z.array(z.string()),
    requiredChecks: z.array(RequiredStatusCheckShape),
    missingRequiredContexts: z.array(z.string()),
  }),
  pullRequest: z
    .object({
      draft: z.boolean(),
      mergeable: z.boolean().nullable(),
      mergeableState: z.string().nullable(),
      baseBranch: z.string(),
    })
    .nullable(),
  reviews: z
    .object({
      reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
      approved: z.number().int().nonnegative(),
      approvedUsers: z.array(z.string()),
      changesRequestedUsers: z.array(z.string()),
      requestedUsers: z.array(z.string()),
      requestedTeams: z.array(z.string()),
      required: z.number().int().nonnegative().nullable(),
      requireCodeOwnerReviews: z.boolean().nullable(),
      codeOwnerReviewSatisfied: z.boolean().nullable(),
      ownershipGaps: z.array(OwnershipGapShape),
    })
    .nullable(),
  branchProtection: z
    .object({
      classicEnabled: z.boolean(),
      rulesetRuleTypes: z.array(z.string()),
      pullRequestRuleRequirements: z.object({
        allowedMergeMethods: z.array(z.string()).nullable(),
        dismissStaleReviews: z.boolean(),
        lockBranch: z.boolean(),
        requiredConversationResolution: z.boolean(),
        requireLastPushApproval: z.boolean(),
        requiredLinearHistory: z.boolean(),
        requiredReviewThreadResolution: z.boolean(),
        requiredReviewersConfigured: z.boolean(),
        requiredSignatures: z.boolean(),
        strictRequiredStatusChecksPolicy: z.boolean(),
      }),
    })
    .nullable(),
  labels: z
    .object({
      all: z.array(z.string()),
      blocking: z.array(z.string()),
    })
    .nullable(),
  linkedIssues: z.array(LinkedIssueShape).nullable(),
});

export const QualityGateOutputSchema = {
  contextLabel: z.string(),
  headSha: z.string(),
  conclusion: z.enum([
    "passing",
    "failing",
    "pending",
    "needs_review",
    "policy_gap",
    "no_evidence",
  ]),
  categories: z.object({
    failing: z.array(CheckStatusShape),
    pending: z.array(CheckStatusShape),
    passing: z.array(CheckStatusShape),
    skipped: z.array(CheckStatusShape),
  }),
  totalChecks: z.number().int().nonnegative(),
  evidence: QualityGateEvidenceShape,
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  nextActions: z.array(z.string()),
  degraded: z.boolean(),
  unverifiedSignals: z.array(z.string()),
  errors: z.array(z.string()),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckCategories {
  failing: CheckStatus[];
  pending: CheckStatus[];
  passing: CheckStatus[];
  skipped: CheckStatus[];
}

export type QualityGateConclusion =
  | "passing"
  | "failing"
  | "pending"
  | "needs_review"
  | "policy_gap"
  | "no_evidence";

export interface QualityGateDecision {
  conclusion: QualityGateConclusion;
  blockers: string[];
  warnings: string[];
  nextActions: string[];
  matchedBlockingLabels: string[];
  missingRequiredContexts: string[];
}

export interface QualityGateEvidenceResult {
  scope: "pull_request" | "ref";
  checks: {
    checkRuns: SignalBuckets;
    commitStatuses: SignalBuckets;
    totalSignals: number;
    requiredContexts: string[];
    requiredChecks: RequiredStatusCheck[];
    missingRequiredContexts: string[];
  };
  pullRequest: {
    draft: boolean;
    mergeable: boolean | null;
    mergeableState: string | null;
    baseBranch: string;
  } | null;
  reviews: {
    reviewDecision: PullRequestEvidence["reviews"]["reviewDecision"];
    approved: number;
    approvedUsers: string[];
    changesRequestedUsers: string[];
    requestedUsers: string[];
    requestedTeams: string[];
    required: number | null;
    requireCodeOwnerReviews: boolean | null;
    codeOwnerReviewSatisfied: boolean | null;
    ownershipGaps: PullRequestEvidence["reviews"]["ownershipGaps"];
  } | null;
  branchProtection: {
    classicEnabled: boolean;
    rulesetRuleTypes: string[];
    pullRequestRuleRequirements: PullRequestEvidence["branchProtection"]["pullRequestRuleRequirements"];
  } | null;
  labels: { all: string[]; blocking: string[] } | null;
  linkedIssues: PullRequestEvidence["linkedIssues"];
}

export interface QualityGateResult {
  contextLabel: string;
  headSha: string;
  conclusion: QualityGateConclusion;
  categories: CheckCategories;
  totalChecks: number;
  evidence: QualityGateEvidenceResult;
  blockers: string[];
  warnings: string[];
  nextActions: string[];
  degraded: boolean;
  unverifiedSignals: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Categorise raw check-run objects into pass/fail/pending/skipped buckets. */
export function categorizeChecks(
  checkRuns: Array<{
    name: string;
    status: string | null;
    conclusion: string | null;
    html_url?: string | null;
  }>
): CheckCategories {
  const toStatus = (run: (typeof checkRuns)[number]): CheckStatus => ({
    name: run.name,
    status: toCheckRunStatus(run.status),
    conclusion: toCheckRunConclusion(run.conclusion),
    url: run.html_url ?? null,
  });

  return {
    failing: checkRuns
      .filter((run) =>
        ["failure", "timed_out", "cancelled", "action_required"].includes(
          run.conclusion ?? ""
        )
      )
      .map(toStatus),
    pending: checkRuns
      .filter((run) => ["queued", "in_progress", "pending"].includes(run.status ?? ""))
      .map(toStatus),
    passing: checkRuns.filter((run) => run.conclusion === "success").map(toStatus),
    skipped: checkRuns
      .filter((run) => run.conclusion === "skipped" || run.conclusion === "neutral")
      .map(toStatus),
  };
}

function toCheckRunStatus(status: string | null): CheckStatus["status"] {
  if (
    status === "queued" ||
    status === "in_progress" ||
    status === "completed" ||
    status === "pending"
  ) {
    return status;
  }
  return "unknown";
}

function toCheckRunConclusion(conclusion: string | null): CheckStatus["conclusion"] {
  if (
    conclusion === "success" ||
    conclusion === "failure" ||
    conclusion === "neutral" ||
    conclusion === "cancelled" ||
    conclusion === "skipped" ||
    conclusion === "timed_out" ||
    conclusion === "action_required"
  ) {
    return conclusion;
  }
  return null;
}

function signalToCheckStatus(signal: GateSignal): CheckStatus {
  return {
    name: signal.name,
    status: toCheckRunStatus(signal.rawStatus),
    conclusion: toCheckRunConclusion(signal.rawConclusion),
    url: signal.url,
  };
}

function categoriesFromCheckRuns(checkRuns: SignalBuckets): CheckCategories {
  return {
    failing: checkRuns.failing.map(signalToCheckStatus),
    pending: checkRuns.pending.map(signalToCheckStatus),
    passing: checkRuns.passing.map(signalToCheckStatus),
    skipped: checkRuns.skipped.map(signalToCheckStatus),
  };
}

function unique(values: string[]): string[] {
  return values.filter((value, index, all) => all.indexOf(value) === index);
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.toLocaleLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function nextActionsFor(conclusion: QualityGateConclusion): string[] {
  switch (conclusion) {
    case "failing":
      return ["Resolve the known failing merge blockers before proceeding."];
    case "pending":
      return ["Wait for pending signals or required contexts, then run the gate again."];
    case "needs_review":
      return ["Complete the required human review and approval steps."];
    case "policy_gap":
      return ["Restore evidence access or configure the missing merge protection policy."];
    case "no_evidence":
      return ["Run or configure verifiable CI signals before treating this revision as safe."];
    case "passing":
      return ["Request final human merge approval."];
  }
}

function allSignals(ci: CiEvidence): GateSignal[] {
  return [
    ...ci.checkRuns.passing,
    ...ci.checkRuns.failing,
    ...ci.checkRuns.pending,
    ...ci.checkRuns.skipped,
    ...ci.commitStatuses.passing,
    ...ci.commitStatuses.failing,
    ...ci.commitStatuses.pending,
    ...ci.commitStatuses.skipped,
  ];
}

function requiredContextsState(evidence: PullRequestEvidence): {
  required: string[];
  missing: string[];
  satisfiedByPassingOrSkipped: boolean;
} {
  const requiredChecks =
    evidence.branchProtection.requiredStatusChecks?.length > 0
      ? evidence.branchProtection.requiredStatusChecks
      : evidence.branchProtection.requiredStatusContexts.map((context) => ({
          context,
          appId: null,
        }));
  const required = uniqueCaseInsensitive(requiredChecks.map((check) => check.context));
  const signals = allSignals(evidence.ci);
  const satisfiedSignals = signals.filter(
    (signal) => signal.state === "passing" || signal.state === "skipped"
  );
  const matches = (check: RequiredStatusCheck, signal: GateSignal): boolean =>
    check.context.toLocaleLowerCase() === signal.name.toLocaleLowerCase() &&
    (check.appId === null ||
      (signal.source === "check_run" && signal.appId === check.appId));
  const missingChecks = requiredChecks.filter(
    (check) => !signals.some((signal) => matches(check, signal))
  );
  return {
    required,
    missing: uniqueCaseInsensitive(missingChecks.map((check) => check.context)),
    satisfiedByPassingOrSkipped:
      requiredChecks.length > 0 &&
      requiredChecks.every((check) =>
        satisfiedSignals.some((signal) => matches(check, signal))
      ),
  };
}

function hasReviewPolicy(evidence: PullRequestEvidence): boolean {
  const requirements = evidence.branchProtection.pullRequestRuleRequirements;
  return (
    (evidence.reviews.requiredApprovals ?? 0) > 0 ||
    evidence.reviews.requireCodeOwnerReviews === true ||
    requirements?.dismissStaleReviews === true ||
    requirements?.requireLastPushApproval === true
  );
}

const MODELED_MERGE_RULE_TYPES = new Set(["pull_request", "required_status_checks"]);
const SAFE_IGNORE_MERGE_RULE_TYPES = new Set([
  "creation",
  "deletion",
  "non_fast_forward",
]);

function mergePolicyState(evidence: PullRequestEvidence): {
  hasAnyPolicy: boolean;
  unmodeledRules: string[];
} {
  const reviewPolicyConfigured = hasReviewPolicy(evidence);
  const hasRequiredContexts = evidence.branchProtection.requiredStatusContexts.length > 0;
  const pullRequestRequirements = evidence.branchProtection.pullRequestRuleRequirements;
  const unmodeledRules = evidence.branchProtection.rulesetRuleTypes.filter((type) => {
    const normalized = type.toLocaleLowerCase();
    if (normalized === "pull_request") return !reviewPolicyConfigured;
    if (normalized === "required_status_checks") return !hasRequiredContexts;
    if (SAFE_IGNORE_MERGE_RULE_TYPES.has(normalized)) return false;
    return !MODELED_MERGE_RULE_TYPES.has(normalized);
  });
  if (pullRequestRequirements?.requiredReviewThreadResolution) {
    unmodeledRules.push("pull_request.required_review_thread_resolution");
  }
  if (pullRequestRequirements?.requiredReviewersConfigured) {
    unmodeledRules.push("pull_request.required_reviewers");
  }
  if (Array.isArray(pullRequestRequirements?.allowedMergeMethods)) {
    unmodeledRules.push("pull_request.allowed_merge_methods");
  }
  if (pullRequestRequirements?.strictRequiredStatusChecksPolicy) {
    unmodeledRules.push(
      "required_status_checks.strict_required_status_checks_policy"
    );
  }
  if (pullRequestRequirements?.requiredConversationResolution) {
    unmodeledRules.push("branch_protection.required_conversation_resolution");
  }
  if (pullRequestRequirements?.requiredSignatures) {
    unmodeledRules.push("branch_protection.required_signatures");
  }
  if (pullRequestRequirements?.requiredLinearHistory) {
    unmodeledRules.push("branch_protection.required_linear_history");
  }
  if (pullRequestRequirements?.lockBranch) {
    unmodeledRules.push("branch_protection.lock_branch");
  }

  const modeled = reviewPolicyConfigured || hasRequiredContexts;
  const uniqueUnmodeledRules = uniqueCaseInsensitive(unmodeledRules);
  return {
    hasAnyPolicy: modeled || uniqueUnmodeledRules.length > 0,
    unmodeledRules: uniqueUnmodeledRules,
  };
}

function sourceWarnings(evidence: PullRequestEvidence): string[] {
  const warnings: string[] = [];
  const unverified = new Set(evidence.unverifiedSignals);

  if (evidence.linkedIssues === null || unverified.has("linked_issues")) {
    warnings.push("linked issue 证据无法验证。 ");
  } else if (evidence.linkedIssues.length === 0) {
    warnings.push("此 PR 未关联 issue；建议补充可追溯的工作项。 ");
  }

  if (
    !unverified.has("branch_protection") &&
    !unverified.has("branch_rules") &&
    !hasReviewPolicy(evidence)
  ) {
    warnings.push("未配置 required review 规则；这在单维护者仓库中可能是合理选择。 ");
  }

  if (
    evidence.reviews.requireCodeOwnerReviews !== true &&
    evidence.reviews.ownershipGaps.length > 0
  ) {
    warnings.push("CODEOWNERS 路由存在缺口，但未配置强制 CODEOWNER 审查。 ");
  }

  for (const source of evidence.unverifiedSignals) {
    warnings.push(`证据来源 ${source} 无法完整验证。`);
  }

  return unique(warnings.map((warning) => warning.trim()));
}

/**
 * Evaluate PR evidence with a stable, explicit decision priority.
 * Known failures always remain authoritative even when other evidence is degraded.
 */
export function evaluateQualityGate(
  evidence: PullRequestEvidence,
  blockingLabels: readonly string[]
): QualityGateDecision {
  const configuredLabels = new Set(blockingLabels.map((label) => label.toLocaleLowerCase()));
  const matchedBlockingLabels = evidence.pullRequest.labels.filter((label) =>
    configuredLabels.has(label.toLocaleLowerCase())
  );
  const contexts = requiredContextsState(evidence);
  const reviewPolicyConfigured = hasReviewPolicy(evidence);
  const mergePolicy = mergePolicyState(evidence);
  const unverifiedSignals = unique([
    ...evidence.unverifiedSignals,
    ...evidence.ci.unverifiedSignals,
  ]);
  const unverified = new Set(unverifiedSignals);
  const aggregateReviewUnverified = unverified.has("review_decision");
  const restReviewsVerified = !unverified.has("reviews");
  const failingReasons: string[] = [];
  const pendingReasons: string[] = [];
  const reviewReasons: string[] = [];
  const policyReasons: string[] = [];
  const mergeableState = evidence.pullRequest.mergeableState?.toLocaleLowerCase() ?? null;
  const computingMergeableStates = new Set(["unknown", "queued", "checking", "pending"]);
  const explicitlyFailingMergeableStates = new Set(["dirty", "unstable"]);
  const nonBlockingMergeableStates = new Set(["clean", "has_hooks", "draft"]);

  for (const item of [
    ...evidence.ci.checkRuns.failing,
    ...evidence.ci.commitStatuses.failing,
  ]) {
    failingReasons.push(`CI signal failed: ${item.name} (${item.source}).`);
  }
  if (evidence.pullRequest.mergeable === false) {
    failingReasons.push("GitHub reports that the PR is not mergeable.");
  }
  if (mergeableState !== null && explicitlyFailingMergeableStates.has(mergeableState)) {
    failingReasons.push(`GitHub reports a failing mergeability state: ${mergeableState}.`);
  }
  if (evidence.reviews.reviewDecision === "CHANGES_REQUESTED") {
    failingReasons.push(
      evidence.reviews.changesRequestedUsers.length > 0
        ? `Changes requested by: ${evidence.reviews.changesRequestedUsers.join(", ")}.`
        : "A reviewer requested changes."
    );
  }
  if (
    aggregateReviewUnverified &&
    restReviewsVerified &&
    evidence.reviews.changesRequestedUsers.length > 0
  ) {
    failingReasons.push(
      `Changes requested by: ${evidence.reviews.changesRequestedUsers.join(", ")}.`
    );
  }
  for (const label of matchedBlockingLabels) {
    failingReasons.push(`Blocking label matched: ${label}.`);
  }

  for (const item of [
    ...evidence.ci.checkRuns.pending,
    ...evidence.ci.commitStatuses.pending,
  ]) {
    pendingReasons.push(`CI signal is pending: ${item.name} (${item.source}).`);
  }
  if (evidence.pullRequest.mergeable === null) {
    pendingReasons.push("GitHub has not finished computing PR mergeability.");
  }
  if (mergeableState !== null && computingMergeableStates.has(mergeableState)) {
    pendingReasons.push(`GitHub mergeability state is still computing: ${mergeableState}.`);
  }
  if (mergeableState === "behind") {
    pendingReasons.push("The pull request head is behind the base branch and must be updated.");
  }
  if (contexts.missing.length > 0) {
    pendingReasons.push(`Required status contexts are missing: ${contexts.missing.join(", ")}.`);
  }

  if (evidence.pullRequest.draft) reviewReasons.push("The pull request is still a draft.");
  if (evidence.reviews.reviewDecision === "REVIEW_REQUIRED") {
    reviewReasons.push("GitHub reports that review is required.");
  }
  if (
    evidence.reviews.reviewDecision === null &&
    !unverified.has("reviews") &&
    evidence.reviews.requiredApprovals !== null &&
    evidence.reviews.requiredApprovals > evidence.reviews.approvedUsers.length
  ) {
    reviewReasons.push(
      `Approvals are incomplete: ${evidence.reviews.approvedUsers.length}/${evidence.reviews.requiredApprovals}.`
    );
  }

  const criticalSources = [
    "branch_protection",
    "branch_rules",
    "check_runs",
    "commit_statuses",
  ];
  if (aggregateReviewUnverified) {
    criticalSources.push("review_decision");
    policyReasons.push(
      "Aggregate review decision is unavailable; review blockers cannot be fully ruled out."
    );
    if (!restReviewsVerified) criticalSources.push("reviews");
  }
  if (reviewPolicyConfigured && evidence.reviews.reviewDecision === null) {
    criticalSources.push("review_decision");
    policyReasons.push("Aggregate review decision is unavailable for the configured review policy.");
  }
  if (evidence.reviews.requireCodeOwnerReviews === true) {
    criticalSources.push("code_owner_review", "codeowners", "changed_files");
  }
  const missingCriticalSources = unique(
    criticalSources.filter((source) => unverified.has(source))
  );
  if (missingCriticalSources.length > 0) {
    policyReasons.push(
      `Critical evidence sources are incomplete: ${missingCriticalSources.join(", ")}.`
    );
  }
  if (
    evidence.reviews.requireCodeOwnerReviews === true &&
    evidence.reviews.reviewDecision !== "APPROVED" &&
    evidence.reviews.codeOwnerReviewSatisfied === null
  ) {
    policyReasons.push("Required CODEOWNER review 无法验证。 ");
  }
  if (mergePolicy.unmodeledRules.length > 0) {
    policyReasons.push(
      `Unmodeled merge rules cannot be verified: ${mergePolicy.unmodeledRules.join(", ")}.`
    );
  }
  if (mergeableState === "blocked") {
    policyReasons.push(
      "GitHub reports that merging is blocked, but the underlying check or review requirement must be resolved from its specific evidence."
    );
  } else if (
    mergeableState !== null &&
    !computingMergeableStates.has(mergeableState) &&
    mergeableState !== "behind" &&
    !explicitlyFailingMergeableStates.has(mergeableState) &&
    !nonBlockingMergeableStates.has(mergeableState)
  ) {
    policyReasons.push(`GitHub returned an unrecognized mergeability state: ${mergeableState}.`);
  }
  if (
    !unverified.has("branch_protection") &&
    !unverified.has("branch_rules") &&
    !mergePolicy.hasAnyPolicy
  ) {
    policyReasons.push("No verified merge-relevant protection policy was found.");
  }

  let conclusion: QualityGateConclusion;
  if (failingReasons.length > 0) conclusion = "failing";
  else if (pendingReasons.length > 0) conclusion = "pending";
  else if (reviewReasons.length > 0) conclusion = "needs_review";
  else if (policyReasons.length > 0) conclusion = "policy_gap";
  else if (
    evidence.ci.checkRuns.passing.length === 0 &&
    evidence.ci.commitStatuses.passing.length === 0 &&
    !contexts.satisfiedByPassingOrSkipped &&
    !(reviewPolicyConfigured && evidence.reviews.reviewDecision === "APPROVED")
  ) {
    conclusion = "no_evidence";
  } else conclusion = "passing";

  const noEvidenceReasons =
    conclusion === "no_evidence"
      ? ["No verified passing CI signal is available for this pull request."]
      : [];
  return {
    conclusion,
    blockers: unique([
      ...failingReasons,
      ...pendingReasons,
      ...reviewReasons,
      ...policyReasons.map((reason) => reason.trim()),
      ...noEvidenceReasons,
    ]),
    warnings: sourceWarnings(evidence),
    nextActions: nextActionsFor(conclusion),
    matchedBlockingLabels,
    missingRequiredContexts: contexts.missing,
  };
}

function evaluateRefQualityGate(ci: CiEvidence): QualityGateDecision {
  const failingReasons = [
    ...ci.checkRuns.failing,
    ...ci.commitStatuses.failing,
  ].map((item) => `CI signal failed: ${item.name} (${item.source}).`);
  const pendingReasons = [
    ...ci.checkRuns.pending,
    ...ci.commitStatuses.pending,
  ].map((item) => `CI signal is pending: ${item.name} (${item.source}).`);
  const warnings = ci.unverifiedSignals.map(
    (source) => `CI evidence source ${source} could not be fully verified.`
  );

  let conclusion: QualityGateConclusion;
  if (failingReasons.length > 0) conclusion = "failing";
  else if (pendingReasons.length > 0) conclusion = "pending";
  else if (
    ci.unverifiedSignals.length > 0 ||
    ci.totalSignals === 0 ||
    (ci.checkRuns.passing.length === 0 && ci.commitStatuses.passing.length === 0)
  ) {
    conclusion = "no_evidence";
  } else conclusion = "passing";

  return {
    conclusion,
    blockers: unique([
      ...failingReasons,
      ...pendingReasons,
      ...(conclusion === "no_evidence"
        ? ["No complete, verified passing CI evidence is available for this ref."]
        : []),
    ]),
    warnings,
    nextActions: nextActionsFor(conclusion),
    matchedBlockingLabels: [],
    missingRequiredContexts: [],
  };
}

function buildPullRequestResult(
  evidence: PullRequestEvidence,
  decision: QualityGateDecision
): QualityGateResult {
  const unverifiedSignals = unique([
    ...evidence.unverifiedSignals,
    ...evidence.ci.unverifiedSignals,
  ]);
  return {
    contextLabel: `PR #${evidence.pullRequest.number} (${evidence.pullRequest.title})`,
    headSha: evidence.pullRequest.headSha,
    conclusion: decision.conclusion,
    categories: categoriesFromCheckRuns(evidence.ci.checkRuns),
    totalChecks: evidence.ci.checkRuns.total,
    evidence: {
      scope: "pull_request",
      checks: {
        checkRuns: evidence.ci.checkRuns,
        commitStatuses: evidence.ci.commitStatuses,
        totalSignals: evidence.ci.totalSignals,
        requiredContexts: uniqueCaseInsensitive(
          evidence.branchProtection.requiredStatusContexts
        ),
        requiredChecks: evidence.branchProtection.requiredStatusChecks,
        missingRequiredContexts: decision.missingRequiredContexts,
      },
      pullRequest: {
        draft: evidence.pullRequest.draft,
        mergeable: evidence.pullRequest.mergeable,
        mergeableState: evidence.pullRequest.mergeableState,
        baseBranch: evidence.pullRequest.baseBranch,
      },
      reviews: {
        reviewDecision: evidence.reviews.reviewDecision,
        approved: evidence.reviews.approvedUsers.length,
        approvedUsers: evidence.reviews.approvedUsers,
        changesRequestedUsers: evidence.reviews.changesRequestedUsers,
        requestedUsers: evidence.reviews.requestedUsers,
        requestedTeams: evidence.reviews.requestedTeams,
        required: evidence.reviews.requiredApprovals,
        requireCodeOwnerReviews: evidence.reviews.requireCodeOwnerReviews,
        codeOwnerReviewSatisfied: evidence.reviews.codeOwnerReviewSatisfied,
        ownershipGaps: evidence.reviews.ownershipGaps,
      },
      branchProtection: {
        classicEnabled: evidence.branchProtection.classicEnabled,
        rulesetRuleTypes: evidence.branchProtection.rulesetRuleTypes,
        pullRequestRuleRequirements:
          evidence.branchProtection.pullRequestRuleRequirements,
      },
      labels: {
        all: evidence.pullRequest.labels,
        blocking: decision.matchedBlockingLabels,
      },
      linkedIssues: evidence.linkedIssues,
    },
    blockers: decision.blockers,
    warnings: decision.warnings,
    nextActions: decision.nextActions,
    degraded: evidence.degraded || unverifiedSignals.length > 0,
    unverifiedSignals,
    errors: evidence.errors,
  };
}

function buildRefResult(
  refName: string,
  headSha: string,
  ci: CiEvidence,
  decision: QualityGateDecision
): QualityGateResult {
  return {
    contextLabel: `ref: ${refName}`,
    headSha,
    conclusion: decision.conclusion,
    categories: categoriesFromCheckRuns(ci.checkRuns),
    totalChecks: ci.checkRuns.total,
    evidence: {
      scope: "ref",
      checks: {
        checkRuns: ci.checkRuns,
        commitStatuses: ci.commitStatuses,
        totalSignals: ci.totalSignals,
        requiredContexts: [],
        requiredChecks: [],
        missingRequiredContexts: [],
      },
      pullRequest: null,
      reviews: null,
      branchProtection: null,
      labels: null,
      linkedIssues: null,
    },
    blockers: decision.blockers,
    warnings: decision.warnings,
    nextActions: decision.nextActions,
    degraded: ci.unverifiedSignals.length > 0,
    unverifiedSignals: unique(ci.unverifiedSignals),
    errors: ci.errors,
  };
}

function renderQualityGateMarkdown(result: QualityGateResult): string {
  const inline = (value: string, maxLength = 300): string =>
    safeMarkdownInline(value, { maxLength });
  const lines = [
    `# Quality Gate Status - ${inline(result.contextLabel, 400)}`,
    "",
    `**Commit:** ${inline(result.headSha.slice(0, 40), 80)}`,
    `**Conclusion:** ${inline(result.conclusion)}`,
    `**Evidence degraded:** ${result.degraded ? "yes" : "no"}`,
    "",
    "| Check runs | Count |",
    "|---|---:|",
    `| Passing | ${result.categories.passing.length} |`,
    `| Failing | ${result.categories.failing.length} |`,
    `| Pending | ${result.categories.pending.length} |`,
    `| Skipped | ${result.categories.skipped.length} |`,
    `| Total | ${result.totalChecks} |`,
    "",
    `**All CI signals:** ${result.evidence.checks.totalSignals}`,
  ];

  const reviewDetails = result.evidence.reviews;
  if (reviewDetails) {
    const reviewLines = [
      reviewDetails.approvedUsers.length > 0
        ? `- Approved: ${reviewDetails.approvedUsers.map((user) => inline(user)).join(", ")}`
        : null,
      reviewDetails.changesRequestedUsers.length > 0
        ? `- Changes requested: ${reviewDetails.changesRequestedUsers.map((user) => inline(user)).join(", ")}`
        : null,
      reviewDetails.requestedUsers.length > 0
        ? `- Requested users: ${reviewDetails.requestedUsers.map((user) => inline(user)).join(", ")}`
        : null,
      reviewDetails.requestedTeams.length > 0
        ? `- Requested teams: ${reviewDetails.requestedTeams.map((team) => inline(team)).join(", ")}`
        : null,
    ].filter((line): line is string => line !== null);
    if (reviewLines.length > 0) lines.push("", "## Review Details", ...reviewLines);
  }

  if (result.blockers.length > 0) {
    lines.push("", "## Blockers", ...result.blockers.map((item) => `- ${inline(item, 500)}`));
  }
  if (result.warnings.length > 0) {
    lines.push("", "## Warnings", ...result.warnings.map((item) => `- ${inline(item, 500)}`));
  }
  if (result.errors.length > 0) {
    lines.push(
      "",
      "## Notes",
      ...result.errors.map((error) => `- ${inline(error, 500)}`)
    );
  }
  if (result.categories.failing.length > 0) {
    lines.push(
      "",
      "## Failing Check Runs",
      ...result.categories.failing.map(
        (item) => `- **${inline(item.name)}**: ${inline(item.conclusion ?? "unknown")}`
      )
    );
  }
  if (result.categories.pending.length > 0) {
    lines.push(
      "",
      "## Pending Check Runs",
      ...result.categories.pending.map(
        (item) => `- **${inline(item.name)}**: ${inline(item.status ?? "unknown")}`
      )
    );
  }
  lines.push(
    "",
    "## Next Actions",
    ...result.nextActions.map((item) => `- ${inline(item, 500)}`)
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

function normalizeCommitRef(input: string): string {
  return input.replace(/^refs\/(?=(?:heads|tags)\/)/, "");
}

export async function handleQualityGateStatus(
  params: QualityGateInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: QualityGateResult }> {
  let structured: QualityGateResult;

  if (params.pullNumber) {
    const evidence = await collectPullRequestEvidence(
      { pullNumber: params.pullNumber },
      ref,
      octokit
    );
    const decision = evaluateQualityGate(
      evidence,
      params.blockingLabels ?? DEFAULT_BLOCKING_LABELS
    );
    structured = buildPullRequestResult(evidence, decision);
  } else if (params.ref) {
    const { data: commit } = await octokit.repos.getCommit({
      owner: ref.owner,
      repo: ref.repo,
      ref: normalizeCommitRef(params.ref),
    });
    const headSha = commit.sha;
    const evidence = await collectCiEvidence(ref, headSha, octokit);
    structured = buildRefResult(
      params.ref,
      headSha,
      evidence,
      evaluateRefQualityGate(evidence)
    );
  } else {
    throw new Error("Either pullNumber or ref is required.");
  }

  return { text: renderQualityGateMarkdown(structured), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerQualityGateStatusTool(server: McpServer): void {
  server.registerTool(
    "quality_gate_status",
    {
      title: "Quality Gate Status",
      description: `Evaluate real merge-gate evidence for a pull request or CI evidence for a git ref.

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number?): PR number (preferred); evaluates CI, reviews, policy, labels, and mergeability.
  - ref (string?): Branch name or commit SHA; evaluates CI only.
  - blockingLabels (string[]): Exact case-insensitive PR labels that block merging. Pass [] to disable.

Returns: A structured evidence packet, blockers, warnings, next actions, and a conservative conclusion.`,
      inputSchema: QualityGateInputSchema,
      outputSchema: QualityGateOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: QualityGateInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleQualityGateStatus(params, ref, octokit);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleGitHubError(error) }],
        };
      }
    }
  );
}

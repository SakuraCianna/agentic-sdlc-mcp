import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../types.js";
import { handleGitHubError } from "./client.js";
import { fetchCodeownersRules, findOwnershipGaps, type OwnershipGap } from "./codeowners.js";

export type GateSignalSource = "check_run" | "commit_status";
export type GateSignalState = "passing" | "failing" | "pending" | "skipped";

export interface GateSignal {
  name: string;
  source: GateSignalSource;
  /** GitHub App provider for check runs; commit statuses do not expose one. */
  appId: number | null;
  state: GateSignalState;
  rawStatus: string | null;
  rawConclusion: string | null;
  rawState: string | null;
  url: string | null;
  /** Set only after the orchestration layer verifies the originating workflow and pinned scanner action. */
  provenanceVerified?: boolean;
}

export interface RequiredStatusCheck {
  context: string;
  /** null means that any provider may satisfy the required context. */
  appId: number | null;
}

export interface PullRequestRuleRequirements {
  allowedMergeMethods: string[] | null;
  /** Aggregate reviewDecision is authoritative for review freshness when verified. */
  dismissStaleReviews: boolean;
  lockBranch: boolean;
  requiredConversationResolution: boolean;
  /** Aggregate reviewDecision is authoritative for last-push approval when verified. */
  requireLastPushApproval: boolean;
  requiredLinearHistory: boolean;
  requiredReviewThreadResolution: boolean;
  requiredReviewersConfigured: boolean;
  requiredSignatures: boolean;
  strictRequiredStatusChecksPolicy: boolean;
}

export interface SignalBuckets {
  passing: GateSignal[];
  failing: GateSignal[];
  pending: GateSignal[];
  skipped: GateSignal[];
  total: number;
}

export interface CiEvidence {
  checkRuns: SignalBuckets;
  commitStatuses: SignalBuckets;
  totalSignals: number;
  hasFailing: boolean;
  hasPending: boolean;
  unverifiedSignals: string[];
  errors: string[];
}

export interface BoundedCollection<T> {
  items: T[];
  truncated: boolean;
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export interface PullRequestChangedFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequestEvidence {
  pullRequest: {
    number: number;
    title: string;
    body: string | null;
    author: string;
    headSha: string;
    headRef: string;
    baseBranch: string;
    /** Immutable base commit used for policy provenance checks when available. */
    baseSha?: string;
    draft: boolean;
    commits: number;
    mergeable: boolean | null;
    labels: string[];
  };
  /** Complete changed-file details from the same bounded listing used for ownership routing. */
  changedFiles: PullRequestChangedFile[];
  ci: CiEvidence;
  reviews: {
    reviewDecision: ReviewDecision;
    approvedUsers: string[];
    changesRequestedUsers: string[];
    requestedUsers: string[];
    requestedTeams: string[];
    requiredApprovals: number | null;
    requireCodeOwnerReviews: boolean | null;
    codeOwnerReviewSatisfied: boolean | null;
    ownershipGaps: OwnershipGap[];
    codeownersFound: boolean;
  };
  branchProtection: {
    classicEnabled: boolean;
    rulesetRuleTypes: string[];
    requiredStatusContexts: string[];
    requiredStatusChecks: RequiredStatusCheck[];
    pullRequestRuleRequirements: PullRequestRuleRequirements;
  };
  linkedIssues: Array<{ number: number; title: string; url: string }> | null;
  degraded: boolean;
  unverifiedSignals: string[];
  errors: string[];
}

export interface CollectPullRequestEvidenceParams {
  pullNumber: number;
}

type CheckRun = Awaited<ReturnType<Octokit["checks"]["listForRef"]>>["data"]["check_runs"][number];
type CommitStatus = Awaited<
  ReturnType<Octokit["repos"]["getCombinedStatusForRef"]>
>["data"]["statuses"][number];
type PullReview = Awaited<ReturnType<Octokit["pulls"]["listReviews"]>>["data"][number];
type BranchProtection = Awaited<
  ReturnType<Octokit["repos"]["getBranchProtection"]>
>["data"];
type AppliedBranchRule = Awaited<
  ReturnType<Octokit["repos"]["getBranchRules"]>
>["data"][number];

interface SourceResult<T> {
  value: T;
  errors: string[];
  unverifiedSignals: string[];
}

interface GraphQlPullRequestEvidence {
  repository: {
    pullRequest: {
      reviewDecision: ReviewDecision;
      closingIssuesReferences: {
        nodes: Array<{ number: number; title: string; url: string } | null>;
        pageInfo: { hasNextPage: boolean };
      };
    } | null;
  } | null;
}

const PULL_REQUEST_EVIDENCE_QUERY = `
  query PullRequestEvidence($owner: String!, $repo: String!, $pullNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pullNumber) {
        reviewDecision
        closingIssuesReferences(first: 20) {
          nodes { number title url }
          pageInfo { hasNextPage }
        }
      }
    }
  }
`;

function emptyBuckets(): SignalBuckets {
  return { passing: [], failing: [], pending: [], skipped: [], total: 0 };
}

function bucketSignals(signals: GateSignal[]): SignalBuckets {
  const buckets = emptyBuckets();
  for (const signal of signals) buckets[signal.state].push(signal);
  buckets.total = signals.length;
  return buckets;
}

/** Collect at most maxItems while probing one extra page to distinguish complete from truncated. */
export async function collectBounded<T>(
  fn: (page: number, perPage: number) => Promise<T[]>,
  maxItems = 300,
  perPage = 100
): Promise<BoundedCollection<T>> {
  const items: T[] = [];
  let page = 1;

  while (items.length <= maxItems) {
    const pageItems = await fn(page, perPage);
    items.push(...pageItems);
    if (items.length > maxItems) {
      return { items: items.slice(0, maxItems), truncated: true };
    }
    if (pageItems.length < perPage) {
      return { items, truncated: false };
    }
    page++;
  }

  return { items: items.slice(0, maxItems), truncated: true };
}

function checkRunState(run: CheckRun): GateSignalState {
  if (run.status !== "completed") return "pending";
  if (run.conclusion === "success") return "passing";
  if (run.conclusion === "neutral" || run.conclusion === "skipped") return "skipped";
  if (run.conclusion === null) return "pending";
  return "failing";
}

function statusState(status: CommitStatus): GateSignalState {
  if (status.state === "success") return "passing";
  if (status.state === "pending") return "pending";
  return "failing";
}

async function collectCheckRuns(
  ref: RepoRef,
  sha: string,
  octokit: Octokit
): Promise<SourceResult<SignalBuckets>> {
  try {
    const runs = await collectBounded(
      (page, perPage) =>
        octokit.checks
          .listForRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: sha,
            page,
            per_page: perPage,
          })
          .then((response) => response.data.check_runs),
      300
    );
    return {
      value: bucketSignals(
        runs.items.map((run) => ({
          name: run.name,
          source: "check_run",
          appId: run.app?.id ?? null,
          state: checkRunState(run),
          rawStatus: run.status,
          rawConclusion: run.conclusion,
          rawState: null,
          url: run.details_url ?? run.html_url ?? null,
        }))
      ),
      errors: runs.truncated ? ["check_runs: results truncated at 300 items"] : [],
      unverifiedSignals: runs.truncated ? ["check_runs"] : [],
    };
  } catch (error) {
    return {
      value: emptyBuckets(),
      errors: [`check_runs: ${handleGitHubError(error)}`],
      unverifiedSignals: ["check_runs"],
    };
  }
}

async function collectCommitStatuses(
  ref: RepoRef,
  sha: string,
  octokit: Octokit
): Promise<SourceResult<SignalBuckets>> {
  try {
    const statuses = await collectBounded(
      (page, perPage) =>
        octokit.repos
          .getCombinedStatusForRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: sha,
            page,
            per_page: perPage,
          })
          .then((response) => response.data.statuses),
      300
    );
    return {
      value: bucketSignals(
        statuses.items.map((status) => ({
          name: status.context,
          source: "commit_status",
          appId: null,
          state: statusState(status),
          rawStatus: null,
          rawConclusion: null,
          rawState: status.state,
          url: status.target_url ?? null,
        }))
      ),
      errors: statuses.truncated
        ? ["commit_statuses: results truncated at 300 items"]
        : [],
      unverifiedSignals: statuses.truncated ? ["commit_statuses"] : [],
    };
  } catch (error) {
    return {
      value: emptyBuckets(),
      errors: [`commit_statuses: ${handleGitHubError(error)}`],
      unverifiedSignals: ["commit_statuses"],
    };
  }
}

export async function collectCiEvidence(
  ref: RepoRef,
  sha: string,
  octokit: Octokit
): Promise<CiEvidence> {
  const [checkRuns, commitStatuses] = await Promise.all([
    collectCheckRuns(ref, sha, octokit),
    collectCommitStatuses(ref, sha, octokit),
  ]);
  const totalSignals = checkRuns.value.total + commitStatuses.value.total;
  return {
    checkRuns: checkRuns.value,
    commitStatuses: commitStatuses.value,
    totalSignals,
    hasFailing:
      checkRuns.value.failing.length > 0 || commitStatuses.value.failing.length > 0,
    hasPending:
      checkRuns.value.pending.length > 0 || commitStatuses.value.pending.length > 0,
    unverifiedSignals: [
      ...checkRuns.unverifiedSignals,
      ...commitStatuses.unverifiedSignals,
    ],
    errors: [...checkRuns.errors, ...commitStatuses.errors],
  };
}

function hasHttpStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === status
  );
}

async function collectRequestedReviewers(
  params: CollectPullRequestEvidenceParams,
  ref: RepoRef,
  octokit: Octokit
): Promise<SourceResult<{ users: string[]; teams: string[] }>> {
  try {
    const { data } = await octokit.pulls.listRequestedReviewers({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: params.pullNumber,
    });
    return {
      value: {
        users: data.users.map((user) => user.login),
        teams: data.teams.map((team) => `${ref.owner}/${team.slug}`),
      },
      errors: [],
      unverifiedSignals: [],
    };
  } catch (error) {
    return {
      value: { users: [], teams: [] },
      errors: [`requested_reviewers: ${handleGitHubError(error)}`],
      unverifiedSignals: ["requested_reviewers"],
    };
  }
}

function latestActionableReviews(reviews: PullReview[]): {
  approvedUsers: string[];
  changesRequestedUsers: string[];
  reviewedUsers: string[];
} {
  const sorted = [...reviews].sort((left, right) => {
    const timeDifference =
      Date.parse(left.submitted_at ?? "") - Date.parse(right.submitted_at ?? "");
    if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference;
    return left.id - right.id;
  });
  const latest = new Map<string, { login: string; state: "APPROVED" | "CHANGES_REQUESTED" }>();
  const reviewedUsers = new Map<string, string>();

  for (const review of sorted) {
    const login = review.user?.login;
    if (!login) continue;
    const key = login.toLowerCase();
    reviewedUsers.set(key, login);
    const state = review.state.toUpperCase();
    if (state === "DISMISSED") latest.delete(key);
    else if (state === "APPROVED" || state === "CHANGES_REQUESTED") {
      latest.set(key, { login, state });
    }
  }

  return {
    approvedUsers: [...latest.values()]
      .filter((review) => review.state === "APPROVED")
      .map((review) => review.login),
    changesRequestedUsers: [...latest.values()]
      .filter((review) => review.state === "CHANGES_REQUESTED")
      .map((review) => review.login),
    reviewedUsers: [...reviewedUsers.values()],
  };
}

async function collectReviews(
  params: CollectPullRequestEvidenceParams,
  ref: RepoRef,
  octokit: Octokit
): Promise<SourceResult<ReturnType<typeof latestActionableReviews>>> {
  try {
    const reviews = await collectBounded(
      (page, perPage) =>
        octokit.pulls
          .listReviews({
            owner: ref.owner,
            repo: ref.repo,
            pull_number: params.pullNumber,
            page,
            per_page: perPage,
          })
          .then((response) => response.data),
      300
    );
    return {
      value: latestActionableReviews(reviews.items),
      errors: reviews.truncated ? ["reviews: results truncated at 300 items"] : [],
      unverifiedSignals: reviews.truncated ? ["reviews"] : [],
    };
  } catch (error) {
    return {
      value: { approvedUsers: [], changesRequestedUsers: [], reviewedUsers: [] },
      errors: [`reviews: ${handleGitHubError(error)}`],
      unverifiedSignals: ["reviews"],
    };
  }
}

async function collectChangedFiles(
  params: CollectPullRequestEvidenceParams,
  ref: RepoRef,
  octokit: Octokit
): Promise<SourceResult<PullRequestChangedFile[]>> {
  try {
    const files = await collectBounded(
      (page, perPage) =>
        octokit.pulls
          .listFiles({
            owner: ref.owner,
            repo: ref.repo,
            pull_number: params.pullNumber,
            page,
            per_page: perPage,
          })
          .then((response) => response.data),
      300
    );
    return {
      value: files.items.map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
      })),
      errors: files.truncated ? ["changed_files: results truncated at 300 items"] : [],
      unverifiedSignals: files.truncated ? ["changed_files"] : [],
    };
  } catch (error) {
    return {
      value: [],
      errors: [`changed_files: ${handleGitHubError(error)}`],
      unverifiedSignals: ["changed_files"],
    };
  }
}

interface ClassicProtectionValue {
  enabled: boolean;
  requiredApprovals: number | null;
  requireCodeOwnerReviews: boolean | null;
  requiredStatusContexts: string[];
  requiredStatusChecks: RequiredStatusCheck[];
  pullRequestRuleRequirements: PullRequestRuleRequirements;
}

function emptyPullRequestRuleRequirements(): PullRequestRuleRequirements {
  return {
    allowedMergeMethods: null,
    dismissStaleReviews: false,
    lockBranch: false,
    requiredConversationResolution: false,
    requireLastPushApproval: false,
    requiredLinearHistory: false,
    requiredReviewThreadResolution: false,
    requiredReviewersConfigured: false,
    requiredSignatures: false,
    strictRequiredStatusChecksPolicy: false,
  };
}

function combinePullRequestRuleRequirements(
  classic: PullRequestRuleRequirements,
  rules: PullRequestRuleRequirements
): PullRequestRuleRequirements {
  return {
    allowedMergeMethods: rules.allowedMergeMethods,
    dismissStaleReviews:
      classic.dismissStaleReviews || rules.dismissStaleReviews,
    lockBranch: classic.lockBranch || rules.lockBranch,
    requiredConversationResolution:
      classic.requiredConversationResolution || rules.requiredConversationResolution,
    requireLastPushApproval:
      classic.requireLastPushApproval || rules.requireLastPushApproval,
    requiredLinearHistory:
      classic.requiredLinearHistory || rules.requiredLinearHistory,
    requiredReviewThreadResolution:
      classic.requiredReviewThreadResolution || rules.requiredReviewThreadResolution,
    requiredReviewersConfigured:
      classic.requiredReviewersConfigured || rules.requiredReviewersConfigured,
    requiredSignatures: classic.requiredSignatures || rules.requiredSignatures,
    strictRequiredStatusChecksPolicy:
      classic.strictRequiredStatusChecksPolicy ||
      rules.strictRequiredStatusChecksPolicy,
  };
}

function classicProtectionValue(protection: BranchProtection): ClassicProtectionValue {
  // Actor restrictions/enforce_admins do not describe revision state. Likewise,
  // force-push/deletion/fork-sync allowances and block_creations do not add a
  // merge condition for an existing pull request, so they are intentionally omitted.
  const configuredChecks = protection.required_status_checks?.checks ?? [];
  const checkedContexts = new Set(
    configuredChecks.map((check) => check.context.toLocaleLowerCase())
  );
  const requiredStatusChecks: RequiredStatusCheck[] = [
    ...configuredChecks.map((check) => ({
      context: check.context,
      appId: normalizeRequiredAppId(check.app_id),
    })),
    ...(protection.required_status_checks?.contexts ?? [])
      .filter((context) => !checkedContexts.has(context.toLocaleLowerCase()))
      .map((context) => ({ context, appId: null })),
  ];
  return {
    enabled: true,
    requiredApprovals:
      protection.required_pull_request_reviews?.required_approving_review_count ?? null,
    requireCodeOwnerReviews:
      protection.required_pull_request_reviews?.require_code_owner_reviews ?? null,
    requiredStatusContexts: requiredStatusChecks.map((check) => check.context),
    requiredStatusChecks,
    pullRequestRuleRequirements: {
      ...emptyPullRequestRuleRequirements(),
      dismissStaleReviews:
        protection.required_pull_request_reviews?.dismiss_stale_reviews === true,
      lockBranch: protection.lock_branch?.enabled === true,
      requiredConversationResolution:
        protection.required_conversation_resolution?.enabled === true,
      requireLastPushApproval:
        protection.required_pull_request_reviews?.require_last_push_approval === true,
      requiredLinearHistory: protection.required_linear_history?.enabled === true,
      requiredSignatures: protection.required_signatures?.enabled === true,
      strictRequiredStatusChecksPolicy:
        protection.required_status_checks?.strict === true,
    },
  };
}

async function collectClassicProtection(
  branch: string,
  ref: RepoRef,
  octokit: Octokit
): Promise<SourceResult<ClassicProtectionValue>> {
  try {
    const { data } = await octokit.repos.getBranchProtection({
      owner: ref.owner,
      repo: ref.repo,
      branch,
    });
    return { value: classicProtectionValue(data), errors: [], unverifiedSignals: [] };
  } catch (error) {
    const value: ClassicProtectionValue = {
      enabled: false,
      requiredApprovals: null,
      requireCodeOwnerReviews: null,
      requiredStatusContexts: [],
      requiredStatusChecks: [],
      pullRequestRuleRequirements: emptyPullRequestRuleRequirements(),
    };
    if (hasHttpStatus(error, 404)) return { value, errors: [], unverifiedSignals: [] };
    return {
      value,
      errors: [`branch_protection: ${handleGitHubError(error)}`],
      unverifiedSignals: ["branch_protection"],
    };
  }
}

interface RulesValue {
  types: string[];
  requiredApprovals: number | null;
  requireCodeOwnerReviews: boolean | null;
  requiredStatusContexts: string[];
  requiredStatusChecks: RequiredStatusCheck[];
  pullRequestRuleRequirements: PullRequestRuleRequirements;
}

function normalizeRequiredAppId(appId: number | null | undefined): number | null {
  return appId === undefined || appId === null || appId === -1 ? null : appId;
}

function hasBlockingRequiredReviewers(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(
    (reviewer) =>
      typeof reviewer === "object" &&
      reviewer !== null &&
      "minimum_approvals" in reviewer &&
      typeof reviewer.minimum_approvals === "number" &&
      reviewer.minimum_approvals > 0
  );
}

function rulesValue(rules: AppliedBranchRule[]): RulesValue {
  const approvalCounts: number[] = [];
  const codeOwnerRequirements: boolean[] = [];
  const requiredStatusChecks: RequiredStatusCheck[] = [];
  const pullRequestRuleRequirements = emptyPullRequestRuleRequirements();

  for (const rule of rules) {
    if (rule.type === "pull_request" && rule.parameters) {
      approvalCounts.push(rule.parameters.required_approving_review_count);
      codeOwnerRequirements.push(rule.parameters.require_code_owner_review);
      if (rule.parameters.allowed_merge_methods !== undefined) {
        pullRequestRuleRequirements.allowedMergeMethods = [
          ...new Set([
            ...(pullRequestRuleRequirements.allowedMergeMethods ?? []),
            ...rule.parameters.allowed_merge_methods,
          ]),
        ];
      }
      pullRequestRuleRequirements.dismissStaleReviews ||=
        rule.parameters.dismiss_stale_reviews_on_push;
      pullRequestRuleRequirements.requireLastPushApproval ||=
        rule.parameters.require_last_push_approval;
      pullRequestRuleRequirements.requiredReviewThreadResolution ||=
        rule.parameters.required_review_thread_resolution;
      const runtimeParameters = rule.parameters as typeof rule.parameters & {
        required_reviewers?: unknown;
      };
      pullRequestRuleRequirements.requiredReviewersConfigured ||=
        hasBlockingRequiredReviewers(runtimeParameters.required_reviewers);
    }
    if (rule.type === "required_status_checks" && rule.parameters) {
      pullRequestRuleRequirements.strictRequiredStatusChecksPolicy ||=
        rule.parameters.strict_required_status_checks_policy;
      requiredStatusChecks.push(
        ...rule.parameters.required_status_checks.map((check) => ({
          context: check.context,
          appId: normalizeRequiredAppId(check.integration_id),
        }))
      );
    }
  }

  return {
    types: rules.map((rule) => rule.type),
    requiredApprovals: approvalCounts.length > 0 ? Math.max(...approvalCounts) : null,
    requireCodeOwnerReviews:
      codeOwnerRequirements.length > 0 ? codeOwnerRequirements.some(Boolean) : null,
    requiredStatusContexts: requiredStatusChecks.map((check) => check.context),
    requiredStatusChecks,
    pullRequestRuleRequirements,
  };
}

async function collectAppliedRules(
  branch: string,
  ref: RepoRef,
  octokit: Octokit
): Promise<SourceResult<RulesValue>> {
  try {
    const rules = await collectBounded(
      (page, perPage) =>
        octokit.repos
          .getBranchRules({
            owner: ref.owner,
            repo: ref.repo,
            branch,
            page,
            per_page: perPage,
          })
          .then((response) => response.data),
      300
    );
    return {
      value: rulesValue(rules.items),
      errors: rules.truncated ? ["branch_rules: results truncated at 300 items"] : [],
      unverifiedSignals: rules.truncated ? ["branch_rules"] : [],
    };
  } catch (error) {
    return {
      value: {
        types: [],
        requiredApprovals: null,
        requireCodeOwnerReviews: null,
        requiredStatusContexts: [],
        requiredStatusChecks: [],
        pullRequestRuleRequirements: emptyPullRequestRuleRequirements(),
      },
      errors: [`branch_rules: ${handleGitHubError(error)}`],
      unverifiedSignals: ["branch_rules"],
    };
  }
}

async function collectGraphQlEvidence(
  params: CollectPullRequestEvidenceParams,
  ref: RepoRef,
  octokit: Octokit
): Promise<
  SourceResult<{
    reviewDecision: ReviewDecision;
    linkedIssues: PullRequestEvidence["linkedIssues"];
  }>
> {
  try {
    const data = await octokit.graphql<GraphQlPullRequestEvidence>(
      PULL_REQUEST_EVIDENCE_QUERY,
      { owner: ref.owner, repo: ref.repo, pullNumber: params.pullNumber }
    );
    const pullRequest = data.repository?.pullRequest;
    if (!pullRequest) {
      throw new Error("GraphQL pull request was not found");
    }
    return {
      value: {
        reviewDecision: pullRequest.reviewDecision,
        linkedIssues: pullRequest.closingIssuesReferences.nodes.filter(
          (issue): issue is NonNullable<typeof issue> => issue !== null
        ),
      },
      errors: pullRequest.closingIssuesReferences.pageInfo.hasNextPage
        ? ["linked_issues: results truncated at 20 items"]
        : [],
      unverifiedSignals: pullRequest.closingIssuesReferences.pageInfo.hasNextPage
        ? ["linked_issues"]
        : [],
    };
  } catch (error) {
    return {
      value: { reviewDecision: null, linkedIssues: null },
      errors: [`graphql: ${handleGitHubError(error)}`],
      unverifiedSignals: ["review_decision", "linked_issues"],
    };
  }
}

function maximumNullable(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}

function combineNullableBooleans(values: Array<boolean | null>): boolean | null {
  const booleans = values.filter((value): value is boolean => value !== null);
  return booleans.length > 0 ? booleans.some(Boolean) : null;
}

export async function collectPullRequestEvidence(
  params: CollectPullRequestEvidenceParams,
  ref: RepoRef,
  octokit: Octokit
): Promise<PullRequestEvidence> {
  const { data: pullRequest } = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: params.pullNumber,
  });

  const [
    ci,
    requestedReviewers,
    reviews,
    classicProtection,
    appliedRules,
    codeowners,
    changedFiles,
    graphQl,
  ] = await Promise.all([
    collectCiEvidence(ref, pullRequest.head.sha, octokit),
    collectRequestedReviewers(params, ref, octokit),
    collectReviews(params, ref, octokit),
    collectClassicProtection(pullRequest.base.ref, ref, octokit),
    collectAppliedRules(pullRequest.base.ref, ref, octokit),
    fetchCodeownersRules(ref, octokit, pullRequest.base.sha),
    collectChangedFiles(params, ref, octokit),
    collectGraphQlEvidence(params, ref, octokit),
  ]);

  const codeownersErrors = codeowners.error
    ? [`codeowners: ${codeowners.error}`]
    : [];
  const codeownersUnverified = codeowners.error ? ["codeowners"] : [];
  const requireCodeOwnerReviews = combineNullableBooleans([
    classicProtection.value.requireCodeOwnerReviews,
    appliedRules.value.requireCodeOwnerReviews,
  ]);
  const codeOwnerReviewSatisfied =
    requireCodeOwnerReviews === true && graphQl.value.reviewDecision === "APPROVED"
      ? true
      : null;
  const codeOwnerReviewUnverified =
    requireCodeOwnerReviews === true && graphQl.value.reviewDecision !== "APPROVED"
      ? ["code_owner_review"]
      : [];
  const errors = [
    ...ci.errors,
    ...requestedReviewers.errors,
    ...reviews.errors,
    ...classicProtection.errors,
    ...appliedRules.errors,
    ...codeownersErrors,
    ...changedFiles.errors,
    ...graphQl.errors,
  ];
  const unverifiedSignals = [
    ...ci.unverifiedSignals,
    ...requestedReviewers.unverifiedSignals,
    ...reviews.unverifiedSignals,
    ...classicProtection.unverifiedSignals,
    ...appliedRules.unverifiedSignals,
    ...codeownersUnverified,
    ...changedFiles.unverifiedSignals,
    ...graphQl.unverifiedSignals,
    ...codeOwnerReviewUnverified,
  ].filter((signal, index, all) => all.indexOf(signal) === index);
  const reviewedUsers = reviews.value.reviewedUsers;
  const requiredStatusChecks = [
    ...classicProtection.value.requiredStatusChecks,
    ...appliedRules.value.requiredStatusChecks,
  ].filter(
    (check, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.context.toLocaleLowerCase() === check.context.toLocaleLowerCase() &&
          candidate.appId === check.appId
      ) === index
  );
  const requiredStatusContexts = requiredStatusChecks
    .map((check) => check.context)
    .filter(
      (context, index, all) =>
        all.findIndex(
          (candidate) => candidate.toLocaleLowerCase() === context.toLocaleLowerCase()
        ) === index
    );

  return {
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body ?? null,
      author: pullRequest.user?.login ?? "",
      headSha: pullRequest.head.sha,
      headRef: pullRequest.head.ref,
      baseBranch: pullRequest.base.ref,
      draft: pullRequest.draft ?? false,
      baseSha: pullRequest.base.sha,
      commits: pullRequest.commits,
      mergeable: pullRequest.mergeable,
      labels: pullRequest.labels.map((label) => label.name),
    },
    ci,
    reviews: {
      reviewDecision: graphQl.value.reviewDecision,
      approvedUsers: reviews.value.approvedUsers,
      changesRequestedUsers: reviews.value.changesRequestedUsers,
      requestedUsers: requestedReviewers.value.users,
      requestedTeams: requestedReviewers.value.teams,
      requiredApprovals: maximumNullable([
        classicProtection.value.requiredApprovals,
        appliedRules.value.requiredApprovals,
      ]),
      requireCodeOwnerReviews,
      codeOwnerReviewSatisfied,
      ownershipGaps: findOwnershipGaps(
        changedFiles.value.map((file) => file.filename),
        codeowners.rules,
        requestedReviewers.value.users,
        requestedReviewers.value.teams,
        reviewedUsers,
        pullRequest.user?.login ?? ""
      ),
      codeownersFound: codeowners.rules.length > 0,
    },
    changedFiles: changedFiles.value,
    branchProtection: {
      classicEnabled: classicProtection.value.enabled,
      rulesetRuleTypes: appliedRules.value.types,
      requiredStatusContexts,
      requiredStatusChecks,
      pullRequestRuleRequirements: combinePullRequestRuleRequirements(
        classicProtection.value.pullRequestRuleRequirements,
        appliedRules.value.pullRequestRuleRequirements
      ),
    },
    linkedIssues: graphQl.value.linkedIssues,
    degraded: unverifiedSignals.length > 0,
    unverifiedSignals,
    errors,
  };
}

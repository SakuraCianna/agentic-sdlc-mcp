/**
 * Shared TypeScript types used across tools and resources.
 */

// ---------------------------------------------------------------------------
// Core reusable types
// ---------------------------------------------------------------------------

export interface RepoRef {
  owner: string;
  repo: string;
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type SdlcPhase =
  | "plan"
  | "create"
  | "test"
  | "review"
  | "optimize"
  | "secure";

/**
 * Task category recognised by `plan_from_context`. Each type gets a distinct
 * set of phase tasks — e.g. a `docs` task should not default to requiring
 * code unit tests, while `bugfix` must always include repro + regression.
 */
export type SdlcWorkType =
  | "docs"
  | "feature"
  | "bugfix"
  | "refactor"
  | "security"
  | "release"
  | "infra";

// ---------------------------------------------------------------------------
// Tool output shapes
// ---------------------------------------------------------------------------

export interface DryRunResult<T> {
  dryRun: true;
  wouldCreate: T;
  note: string;
}

export interface IssuePayload {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface IssueResult {
  number: number;
  title: string;
  url: string;
  state: string;
}

export interface CheckStatus {
  name: string;
  status: "queued" | "in_progress" | "completed" | "pending" | "unknown";
  conclusion:
    | "success"
    | "failure"
    | "neutral"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "action_required"
    | null;
  url: string | null;
}

export interface SecurityAlert {
  id: string | number;
  severity: Severity;
  summary: string;
  state: string;
  url: string | null;
  fixedAt?: string | null;
  dismissedAt?: string | null;
}

export interface Finding {
  severity: Severity;
  category: string;
  description: string;
  suggestion?: string;
}

export interface SdlcPlanPhase {
  phase: SdlcPhase;
  summary: string;
  tasks: string[];
}

/** Coarse triage signal for an issue draft -- not a per-line diff analysis (that's review_pr_against_standard's job), just a category-level heuristic useful for release/readiness or review sorting. */
export type IssueRiskLevel = "low" | "medium" | "high";

/**
 * A structured issue draft produced by `plan_from_context`. Shaped so it can
 * be passed directly as an entry in `create_issue_set`'s `issues` input --
 * that tool's input schema explicitly accepts the planning metadata fields
 * (`phase`/`acceptanceCriteria`/`riskLevel`/`goal`), while its handler only
 * sends the GitHub issue fields (`title`/`body`/`labels`/`assignees`).
 */
export interface IssueDraft {
  title: string;
  body: string;
  /** Only labels confirmed to already exist in the target repo (see plan-from-context.ts) -- never invented, to avoid GitHub silently auto-creating unknown labels on real issue creation. */
  labels: string[];
  phase: SdlcPhase;
  acceptanceCriteria: string[];
  riskLevel: IssueRiskLevel;
  /** Traceability anchor back to the plan this draft came from. plan_from_context is stateless (no persisted plan ID), so the goal string is the anchor. */
  goal: string;
}

export interface HandoffPacket {
  repoContext: string;
  currentStatus: string;
  decisionsMade: string[];
  remainingTasks: string[];
  verificationNeeded: string[];
  handoffPrompt: string;
}

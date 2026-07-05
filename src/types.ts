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

export interface HandoffPacket {
  repoContext: string;
  currentStatus: string;
  decisionsMade: string[];
  remainingTasks: string[];
  verificationNeeded: string[];
  handoffPrompt: string;
}

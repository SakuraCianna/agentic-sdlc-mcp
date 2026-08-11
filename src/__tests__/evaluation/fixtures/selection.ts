import type { ToolName } from "../../../catalog.js";
import type { EvaluationToolCall } from "../../../evaluation/model.js";

export interface SelectionExecutionCall {
  name: ToolName;
  arguments:
    | Record<string, unknown>
    | ((previousResults: readonly Record<string, unknown>[]) => Record<string, unknown>);
  expectedArguments?: Record<string, unknown>;
  effect: EvaluationToolCall["effect"];
  expectedStructured: Record<string, unknown>;
}

export interface SelectionExecutionCase {
  scenarioId: string;
  calls: readonly SelectionExecutionCall[];
}

const REPOSITORY = { owner: "example", repo: "project" } as const;

export const SELECTION_EXECUTION_CASES: readonly SelectionExecutionCase[] = [
  {
    scenarioId: "repository-briefing",
    calls: [
      {
        name: "repo_context",
        arguments: { ...REPOSITORY, includeReadme: false },
        effect: "read",
        expectedStructured: {
          fullName: "example/project",
          defaultBranch: "main",
        },
      },
    ],
  },
  {
    scenarioId: "issue-risk-brief",
    calls: [
      {
        name: "prepare_work_item",
        arguments: { ...REPOSITORY, issueNumber: 42 },
        effect: "read",
        expectedStructured: {
          issueNumber: 42,
          title: "Harden local MCP contracts",
          riskProfile: {
            level: "low",
            blastRadius: "local",
          },
        },
      },
    ],
  },
  {
    scenarioId: "plan-issue-preview",
    calls: [
      {
        name: "plan_from_context",
        arguments: {
          ...REPOSITORY,
          goal: "Add deterministic MCP contract coverage",
          workType: "feature",
        },
        effect: "read",
        expectedStructured: {
          goal: "Add deterministic MCP contract coverage",
          workType: "feature",
        },
      },
      {
        name: "create_issue_set",
        arguments: (previousResults) => {
          const issueDrafts = previousResults[0]?.issueDrafts;
          if (!Array.isArray(issueDrafts)) {
            throw new Error("plan_from_context must return issueDrafts before preview");
          }
          return {
            ...REPOSITORY,
            dryRun: true,
            issues: issueDrafts,
          };
        },
        expectedArguments: { dryRun: true },
        effect: "dry-run",
        expectedStructured: {
          dryRun: true,
          targetRepo: "example/project",
        },
      },
    ],
  },
  {
    scenarioId: "pull-request-gate",
    calls: [
      {
        name: "quality_gate_status",
        arguments: { ...REPOSITORY, ref: "main", blockingLabels: [] },
        effect: "read",
        expectedStructured: {
          contextLabel: "ref: main",
          conclusion: "passing",
        },
      },
    ],
  },
  {
    scenarioId: "pull-request-review",
    calls: [
      {
        name: "review_pr_against_standard",
        arguments: {
          ...REPOSITORY,
          pullNumber: 7,
          standard: "basic",
          checkOwnership: false,
          workType: "feature",
        },
        effect: "read",
        expectedStructured: {
          pullNumber: 7,
          conclusion: "pass",
          testCoverageSignal: "adequate",
        },
      },
    ],
  },
  {
    scenarioId: "repository-governance",
    calls: [
      {
        name: "branch_protection_status",
        arguments: { ...REPOSITORY, branch: "main" },
        effect: "read",
        expectedStructured: {
          repo: "example/project",
          branch: "main",
          conclusion: "unprotected",
        },
      },
      {
        name: "workflow_permissions_audit",
        arguments: { ...REPOSITORY, ref: "main" },
        effect: "read",
        expectedStructured: {
          repo: "example/project",
          conclusion: "least_privilege",
        },
      },
    ],
  },
];

import type { ToolName } from "../../catalog.js";

export interface McpToolContractCase {
  name: ToolName;
  arguments: Record<string, unknown>;
  markdownHeading: string;
  structuredKeys: readonly string[];
  semanticParity: {
    structuredPath: string;
    structuredValue: string | number | boolean;
    markdownValue: string;
  };
}

const REPOSITORY = { owner: "example", repo: "project" } as const;

/**
 * Minimal successful calls for every public tool. Optional collection sources
 * stay disabled unless they are the behavior under test, which keeps this
 * protocol matrix deterministic and leaves deep business scenarios to each
 * tool's focused unit tests.
 */
export const MCP_TOOL_CONTRACT_CASES: readonly McpToolContractCase[] = [
  {
    name: "repo_context",
    arguments: { ...REPOSITORY, includeReadme: false },
    markdownHeading: "# Repository Context:",
    structuredKeys: ["fullName", "defaultBranch"],
    semanticParity: {
      structuredPath: "fullName",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "plan_from_context",
    arguments: {
      ...REPOSITORY,
      goal: "Add deterministic MCP contract coverage",
      workType: "feature",
    },
    markdownHeading: "# SDLC Plan:",
    structuredKeys: ["goal", "phases", "issueDrafts"],
    semanticParity: {
      structuredPath: "goal",
      structuredValue: "Add deterministic MCP contract coverage",
      markdownValue: "Add deterministic MCP contract coverage",
    },
  },
  {
    name: "create_issue_set",
    arguments: {
      ...REPOSITORY,
      issues: [
        {
          title: "Contract fixture issue",
          body: "Exercise preview mode without external writes.",
          labels: ["testing"],
        },
      ],
    },
    markdownHeading: "# [PREVIEW ONLY] Issue Set Preview",
    structuredKeys: ["dryRun", "preview", "warnings"],
    semanticParity: {
      structuredPath: "targetRepo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "prepare_work_item",
    arguments: { ...REPOSITORY, issueNumber: 42 },
    markdownHeading: "# Work Item Brief:",
    structuredKeys: ["issueNumber", "riskProfile", "handoffPrompt"],
    semanticParity: {
      structuredPath: "issueNumber",
      structuredValue: 42,
      markdownValue: "#42",
    },
  },
  {
    name: "quality_gate_status",
    arguments: { ...REPOSITORY, ref: "main" },
    markdownHeading: "# Quality Gate Status",
    structuredKeys: ["headSha", "conclusion", "evidence"],
    semanticParity: {
      structuredPath: "contextLabel",
      structuredValue: "ref: main",
      markdownValue: "ref: main",
    },
  },
  {
    name: "create_pr_summary",
    arguments: { ...REPOSITORY, pullNumber: 7 },
    markdownHeading: "# PR Summary:",
    structuredKeys: ["pullNumber", "hasTests", "evidence"],
    semanticParity: {
      structuredPath: "pullNumber",
      structuredValue: 7,
      markdownValue: "#7",
    },
  },
  {
    name: "review_pr_against_standard",
    arguments: {
      ...REPOSITORY,
      pullNumber: 7,
      standard: "basic",
      checkOwnership: false,
    },
    markdownHeading: "# PR Review:",
    structuredKeys: ["pullNumber", "conclusion", "testCoverageSignal"],
    semanticParity: {
      structuredPath: "pullNumber",
      structuredValue: 7,
      markdownValue: "#7",
    },
  },
  {
    name: "security_triage",
    arguments: {
      ...REPOSITORY,
      includeCodeScanning: false,
      includeDependabot: false,
      includeSecretScanning: false,
    },
    markdownHeading: "# Security Triage:",
    structuredKeys: ["alerts", "errors", "severityCounts"],
    semanticParity: {
      structuredPath: "repo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "release_readiness_check",
    arguments: {
      ...REPOSITORY,
      headRef: "main",
      rollbackPlanEvidence: { reference: "docs/rollback.md", tested: true },
    },
    markdownHeading: "# Release Readiness Check:",
    structuredKeys: ["headRef", "ciStatus", "blockingIssues"],
    semanticParity: {
      structuredPath: "repo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "agent_handoff_packet",
    arguments: {
      ...REPOSITORY,
      currentStatus: "Protocol contract fixture running",
      nextSteps: ["Review contract evidence"],
    },
    markdownHeading: "# Agent Handoff Packet:",
    structuredKeys: ["currentStatus", "handoffPrompt", "evidencePacket"],
    semanticParity: {
      structuredPath: "repo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "branch_protection_status",
    arguments: { ...REPOSITORY, branch: "main" },
    markdownHeading: "# Branch Protection Status:",
    structuredKeys: ["branch", "verificationGaps", "conclusion"],
    semanticParity: {
      structuredPath: "repo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "workflow_permissions_audit",
    arguments: { ...REPOSITORY, ref: "main" },
    markdownHeading: "# Workflow Permissions Audit:",
    structuredKeys: ["workflowsScanned", "findings", "conclusion"],
    semanticParity: {
      structuredPath: "repo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
  {
    name: "sdlc_evidence_packet",
    arguments: {
      ...REPOSITORY,
      subject: { type: "issue", issueNumber: 42 },
    },
    markdownHeading: "# SDLC Evidence Packet",
    structuredKeys: ["schemaVersion", "subject", "contentDigest"],
    semanticParity: {
      structuredPath: "subject.repo",
      structuredValue: "example/project",
      markdownValue: "example/project",
    },
  },
];

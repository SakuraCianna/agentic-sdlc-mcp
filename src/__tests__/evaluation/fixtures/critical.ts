import type { ToolName } from "../../../catalog.js";
import type { EvaluationToolCall } from "../../../evaluation/model.js";
import type { GithubContractFixture } from "../../fixtures/github-contract-fixtures.js";

export interface CriticalExecutionCall {
  name: ToolName;
  arguments:
    | Record<string, unknown>
    | ((previousResults: readonly Record<string, unknown>[]) => Record<string, unknown>);
  effect: EvaluationToolCall["effect"];
  expectedStructured: Record<string, unknown>;
}

export interface CriticalExecutionCase {
  scenarioId: string;
  setup?: (fixture: GithubContractFixture) => void;
  calls: readonly CriticalExecutionCall[];
}

const REPOSITORY = { owner: "example", repo: "project" } as const;
const SECURITY_TRIAGE_ARGUMENTS = REPOSITORY;

function requireObject(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(description);
  }
  return value as Record<string, unknown>;
}

function requireSafeSecurityTriage(
  previousResults: readonly Record<string, unknown>[]
): void {
  const counts = requireObject(
    previousResults[0]?.severityCounts,
    "security_triage must return severityCounts before the protected call"
  );
  if (counts.critical !== 0 || counts.high !== 0) {
    throw new Error("security gate must not continue with critical or high alerts");
  }
  if (!Array.isArray(previousResults[0]?.errors) || previousResults[0]?.errors.length > 0) {
    throw new Error("security gate must not continue with unavailable alert evidence");
  }
  if (
    !Array.isArray(previousResults[0]?.truncatedSources) ||
    previousResults[0]?.truncatedSources.length > 0
  ) {
    throw new Error("security gate must not continue with truncated alert evidence");
  }
}

function releaseArguments(headRef: string): Record<string, unknown> {
  return {
    ...REPOSITORY,
    headRef,
    rollbackPlanEvidence: { reference: "docs/rollback.md", tested: true },
  };
}

export const CRITICAL_EXECUTION_CASES: readonly CriticalExecutionCase[] = [
  {
    scenarioId: "security-review-gate",
    calls: [
      {
        name: "security_triage",
        arguments: SECURITY_TRIAGE_ARGUMENTS,
        effect: "read",
        expectedStructured: {
          repo: "example/project",
          errors: [],
          truncatedSources: [],
          severityCounts: { critical: 0, high: 0 },
        },
      },
      {
        name: "review_pr_against_standard",
        arguments: (previousResults) => {
          requireSafeSecurityTriage(previousResults);
          return {
            ...REPOSITORY,
            pullNumber: 7,
            standard: "basic",
            checkOwnership: false,
            workType: "feature",
          };
        },
        effect: "read",
        expectedStructured: { pullNumber: 7, conclusion: "pass" },
      },
    ],
  },
  {
    scenarioId: "security-release-gate",
    calls: [
      {
        name: "security_triage",
        arguments: SECURITY_TRIAGE_ARGUMENTS,
        effect: "read",
        expectedStructured: {
          repo: "example/project",
          errors: [],
          truncatedSources: [],
          severityCounts: { critical: 0, high: 0 },
        },
      },
      {
        name: "release_readiness_check",
        arguments: (previousResults) => {
          requireSafeSecurityTriage(previousResults);
          return releaseArguments("main");
        },
        effect: "read",
        expectedStructured: {
          headRef: "main",
          isReady: true,
          ciStatus: "passing",
          blockingIssues: [],
        },
      },
    ],
  },
  {
    scenarioId: "quality-release-gate",
    calls: [
      {
        name: "quality_gate_status",
        arguments: { ...REPOSITORY, ref: "main", blockingLabels: [] },
        effect: "read",
        expectedStructured: {
          conclusion: "passing",
          headSha: "fixture-head-sha",
        },
      },
      {
        name: "release_readiness_check",
        arguments: (previousResults) => {
          if (previousResults[0]?.conclusion !== "passing") {
            throw new Error("release readiness requires a passing quality gate");
          }
          const headSha = previousResults[0]?.headSha;
          if (typeof headSha !== "string") {
            throw new Error("quality gate must return an immutable head SHA");
          }
          return releaseArguments(headSha);
        },
        effect: "read",
        expectedStructured: {
          headRef: "fixture-head-sha",
          isReady: true,
          ciStatus: "passing",
          blockingIssues: [],
        },
      },
    ],
  },
  {
    scenarioId: "release-evidence-packet",
    calls: [
      {
        name: "release_readiness_check",
        arguments: releaseArguments("main"),
        effect: "read",
        expectedStructured: {
          headRef: "main",
          isReady: true,
          ciStatus: "passing",
          blockingIssues: [],
        },
      },
      {
        name: "sdlc_evidence_packet",
        arguments: (previousResults) => {
          const headRef = previousResults[0]?.headRef;
          if (
            previousResults[0]?.isReady !== true ||
            previousResults[0]?.ciStatus !== "passing" ||
            !Array.isArray(previousResults[0]?.blockingIssues) ||
            previousResults[0]?.blockingIssues.length > 0 ||
            typeof headRef !== "string"
          ) {
            throw new Error("release evidence requires a passing readiness result");
          }
          return { ...REPOSITORY, subject: { type: "release", ref: headRef } };
        },
        effect: "read",
        expectedStructured: {
          schemaVersion: "1.0",
          subject: { type: "release", repo: "example/project", ref: "main" },
        },
      },
    ],
  },
  {
    scenarioId: "evidence-agent-handoff",
    calls: [
      {
        name: "sdlc_evidence_packet",
        arguments: { ...REPOSITORY, subject: { type: "issue", issueNumber: 42 } },
        effect: "read",
        expectedStructured: {
          schemaVersion: "1.0",
          subject: { type: "issue", repo: "example/project", number: 42 },
          summary: { idsByState: { verified: ["issue:metadata"] } },
        },
      },
      {
        name: "agent_handoff_packet",
        arguments: (previousResults) => {
          const subject = requireObject(
            previousResults[0]?.subject,
            "evidence packet must return its subject before handoff"
          );
          if (subject.type !== "issue" || subject.number !== 42) {
            throw new Error("handoff must preserve the evidence packet Issue subject");
          }
          const summary = requireObject(
            previousResults[0]?.summary,
            "evidence packet must return a summary before handoff"
          );
          const idsByState = requireObject(
            summary.idsByState,
            "evidence packet must return state identifiers before handoff"
          );
          if (
            !Array.isArray(idsByState.verified) ||
            !idsByState.verified.includes("issue:metadata") ||
            (Array.isArray(idsByState.unverified) &&
              idsByState.unverified.includes("issue:metadata")) ||
            (Array.isArray(idsByState.failed) &&
              idsByState.failed.includes("issue:metadata"))
          ) {
            throw new Error("handoff requires verified Issue metadata evidence");
          }
          const unsafePromptInjectionState = [
            idsByState.failed,
            idsByState.pending,
            idsByState.unverified,
          ].some(
            (ids) =>
              Array.isArray(ids) && ids.includes("security:prompt-injection")
          );
          if (unsafePromptInjectionState) {
            throw new Error("handoff must not continue with prompt-injection evidence");
          }
          return {
            ...REPOSITORY,
            issueNumber: subject.number,
            currentStatus: "Evidence collected for safe handoff",
            nextSteps: ["Review the structured evidence packet"],
          };
        },
        effect: "read",
        expectedStructured: {
          repo: "example/project",
          issueRef: { number: 42 },
        },
      },
    ],
  },
  {
    scenarioId: "degraded-evidence-handoff",
    setup: (fixture) => fixture.denyIssueReads(),
    calls: [
      {
        name: "sdlc_evidence_packet",
        arguments: { ...REPOSITORY, subject: { type: "issue", issueNumber: 42 } },
        effect: "read",
        expectedStructured: {
          schemaVersion: "1.0",
          subject: { type: "issue", repo: "example/project", number: 42 },
          summary: { idsByState: { unverified: ["issue:metadata"] } },
        },
      },
      {
        name: "agent_handoff_packet",
        arguments: (previousResults) => {
          const subject = requireObject(
            previousResults[0]?.subject,
            "degraded evidence must return its subject before handoff"
          );
          if (subject.type !== "issue" || typeof subject.number !== "number") {
            throw new Error("degraded handoff must preserve the evidence packet Issue subject");
          }
          const summary = requireObject(
            previousResults[0]?.summary,
            "degraded evidence must return a summary"
          );
          const idsByState = requireObject(
            summary.idsByState,
            "degraded evidence must return state identifiers"
          );
          if (
            !Array.isArray(idsByState.unverified) ||
            !idsByState.unverified.includes("issue:metadata")
          ) {
            throw new Error("handoff must observe the unverified Issue evidence state");
          }
          return {
            ...REPOSITORY,
            issueNumber: subject.number,
            currentStatus: "Issue evidence is degraded",
            nextSteps: ["Restore Issue evidence before making a release claim"],
          };
        },
        effect: "read",
        expectedStructured: {
          repo: "example/project",
          issueRef: null,
          evidenceWarnings: [
            "Issue #42 evidence is unavailable.",
            "System evidence: Issue collection was degraded.",
            "System evidence: GitHub permission denied (403): Resource not accessible by integration. Your token may lack the required scope. See README for required token permissions.",
          ],
        },
      },
    ],
  },
];

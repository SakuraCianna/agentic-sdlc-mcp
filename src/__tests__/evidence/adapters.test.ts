import { describe, expect, it } from "vitest";

import {
  adaptCiEvidence,
  adaptPrSummaryEvidence,
  adaptReleaseReadinessEvidence,
  adaptReviewEvidence,
  adaptSecurityTriageEvidence,
} from "../../evidence/adapters.js";
import type {
  GateSignal,
  PullRequestEvidence,
} from "../../github/pull-request-evidence.js";
import type { ReleaseReadinessResult } from "../../tools/release-readiness.js";
import type { SecurityTriageResult } from "../../tools/security-triage.js";

function pullRequestEvidence(): PullRequestEvidence {
  return {
    pullRequest: {
      number: 7,
      title: "Test",
      body: null,
      author: "octocat",
      headSha: "head-sha",
      headRef: "feature/test",
      baseBranch: "main",
      draft: false,
      commits: 1,
      mergeable: true,
      mergeableState: "clean",
      labels: [],
    },
    changedFiles: [],
    ci: {
      checkRuns: {
        passing: [],
        failing: [],
        pending: [],
        skipped: [{
          name: "optional",
          source: "check_run",
          appId: 1,
          state: "skipped",
          rawStatus: "completed",
          rawConclusion: "skipped",
          rawState: null,
          url: null,
        }],
        total: 1,
      },
      commitStatuses: {
        passing: [],
        failing: [],
        pending: [],
        skipped: [],
        total: 0,
      },
      totalSignals: 1,
      hasFailing: false,
      hasPending: false,
      unverifiedSignals: [],
      errors: [],
    },
    reviews: {
      reviewDecision: null,
      approvedUsers: [],
      changesRequestedUsers: [],
      requestedUsers: [],
      requestedTeams: [],
      requiredApprovals: null,
      requireCodeOwnerReviews: null,
      codeOwnerReviewSatisfied: null,
      ownershipGaps: [],
      codeownersFound: false,
    },
    branchProtection: {
      classicEnabled: false,
      rulesetRuleTypes: [],
      requiredStatusContexts: [],
      requiredStatusChecks: [],
      pullRequestRuleRequirements: {
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
      },
    },
    linkedIssues: null,
    degraded: false,
    unverifiedSignals: [],
    errors: [],
  };
}

function gateSignal(
  name: string,
  state: GateSignal["state"],
  source: GateSignal["source"] = "check_run"
): GateSignal {
  return {
    name,
    source,
    appId: source === "check_run" ? 1 : null,
    state,
    rawStatus: state === "pending" ? "in_progress" : "completed",
    rawConclusion: state === "pending" ? null : state,
    rawState: source === "commit_status" ? state : null,
    url: `https://github.com/test/${name}`,
  };
}

function releaseReadiness(
  overrides: Partial<ReleaseReadinessResult> = {}
): ReleaseReadinessResult {
  return {
    repo: "test-org/test-repo",
    headRef: "release-sha",
    isReady: true,
    ciStatus: "passing",
    ciEvidenceIncomplete: false,
    headShaResolved: true,
    ciSummary: "CI passed.",
    openBugCount: 0,
    bugEvidenceIncomplete: false,
    blockingIssues: [],
    hasChangelog: true,
    rollbackPlanEvidence: null,
    policy: {
      found: false,
      degraded: false,
      schemaVersion: 1,
      requiredChecks: [],
      protectedPaths: [],
      riskRuleIds: [],
      requiredReviewerRuleIds: [],
      releaseBlockingLabels: [],
      requireIssueLink: false,
      requireCodeOwnersForProtectedPaths: false,
      requireChangelog: false,
      requireRollbackPlan: false,
    },
    policyDigest: "policy-digest",
    policySources: [],
    appliedPolicyRules: [],
    policyDegraded: false,
    ...overrides,
  };
}

function securityTriage(
  overrides: Partial<SecurityTriageResult> = {}
): SecurityTriageResult {
  return {
    repo: "test-org/test-repo",
    alerts: [],
    errors: [],
    truncatedSources: [],
    markdownOmittedAlertCount: 0,
    severityCounts: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    },
    ...overrides,
  };
}

describe("evidence adapters", () => {
  it("adapts PR summary metadata into a provenance-bound evidence item", () => {
    const evidence = adaptPrSummaryEvidence(
      {
        pullNumber: 7,
        title: "Test",
        author: "octocat",
        isDraft: false,
        baseRef: "main",
        headRef: "feature/test",
        commits: 1,
        totalAdditions: 10,
        totalDeletions: 2,
        totalFiles: 301,
        hasTests: true,
        docsOnly: false,
        filesTruncated: true,
        risks: [],
        labels: [],
      },
      "2026-07-26T00:00:00.000Z",
      "test-org/test-repo",
      {
        url: "https://github.com/test-org/test-repo/pull/7",
        subjectSha: "head-sha",
      }
    );

    expect(evidence).toMatchObject({
      id: "pr:summary",
      state: "verified",
      completeness: "partial",
      subject: {
        type: "pull_request",
        number: 7,
        sha: "head-sha",
      },
    });
  });

  it("does not verify skipped-only CI", () => {
    const evidence = adaptCiEvidence(
      pullRequestEvidence(),
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence).toMatchObject({
      state: "unverified",
      source: "github_api",
      completeness: "complete",
    });
  });

  it("verifies complete passing CI and preserves a commit-status URL", () => {
    const input = pullRequestEvidence();
    input.ci.checkRuns.skipped = [];
    input.ci.checkRuns.total = 0;
    input.ci.commitStatuses.passing = [
      gateSignal("continuous-integration", "passing", "commit_status"),
    ];
    input.ci.commitStatuses.total = 1;
    input.ci.totalSignals = 1;

    const evidence = adaptCiEvidence(
      input,
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence).toMatchObject({
      state: "verified",
      completeness: "complete",
      recommendedNextActions: [],
      provenance: {
        url: "https://github.com/test/continuous-integration",
      },
    });
    expect(evidence.reason).toContain("1 passing CI signal");
  });

  it("reports pending CI and recommends recollecting the quality gate", () => {
    const input = pullRequestEvidence();
    input.ci.checkRuns.skipped = [];
    input.ci.checkRuns.pending = [gateSignal("test (node 24)", "pending")];
    input.ci.checkRuns.total = 1;
    input.ci.totalSignals = 1;
    input.ci.hasPending = true;

    const evidence = adaptCiEvidence(
      input,
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence.state).toBe("pending");
    expect(evidence.reason).toContain("test (node 24)");
    expect(evidence.recommendedNextActions).toEqual([
      "Run quality_gate_status for the current pull request head.",
    ]);
  });

  it("does not verify passing CI when collection errors make it partial", () => {
    const input = pullRequestEvidence();
    input.ci.checkRuns.skipped = [];
    input.ci.checkRuns.passing = [gateSignal("test", "passing")];
    input.ci.checkRuns.total = 1;
    input.ci.totalSignals = 1;
    input.ci.errors = ["Commit statuses could not be listed."];

    const evidence = adaptCiEvidence(
      input,
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence).toMatchObject({
      state: "unverified",
      completeness: "partial",
    });
    expect(evidence.reason).toContain("incomplete");
    expect(evidence.limitations).toContain(
      "Commit statuses could not be listed."
    );
  });

  it("does not treat an unavailable review decision as not applicable", () => {
    const input = pullRequestEvidence();
    input.unverifiedSignals = ["review_decision", "requested_reviewers"];
    input.degraded = true;

    const evidence = adaptReviewEvidence(
      input,
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence).toMatchObject({
      state: "unverified",
      completeness: "partial",
    });
    expect(evidence.limitations).toEqual([
      "review_decision",
      "requested_reviewers",
    ]);
  });

  it("includes failed check identities in CI evidence", () => {
    const input = pullRequestEvidence();
    input.ci.checkRuns.skipped = [];
    input.ci.checkRuns.failing = [{
      name: "test (node 22)",
      source: "check_run",
      appId: 1,
      state: "failing",
      rawStatus: "completed",
      rawConclusion: "failure",
      rawState: null,
      url: "https://github.com/test/check",
    }];
    input.ci.checkRuns.total = 1;
    input.ci.hasFailing = true;

    const evidence = adaptCiEvidence(
      input,
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence.state).toBe("failed");
    expect(evidence.reason).toContain("test (node 22)");
  });

  it.each([
    {
      name: "changes requested",
      mutate(input: PullRequestEvidence) {
        input.reviews.changesRequestedUsers = ["reviewer"];
      },
      state: "failed",
      reason: "requests changes",
    },
    {
      name: "approved",
      mutate(input: PullRequestEvidence) {
        input.reviews.reviewDecision = "APPROVED";
      },
      state: "verified",
      reason: "approved aggregate",
    },
    {
      name: "approval required",
      mutate(input: PullRequestEvidence) {
        input.reviews.requiredApprovals = 1;
      },
      state: "pending",
      reason: "No verified review approval",
    },
    {
      name: "no applicable requirement",
      mutate() {},
      state: "not_applicable",
      reason: "No verified review approval",
    },
  ])("classifies review state: $name", ({ mutate, state, reason }) => {
    const input = pullRequestEvidence();
    mutate(input);

    const evidence = adaptReviewEvidence(
      input,
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "head-sha" }
    );

    expect(evidence.state).toBe(state);
    expect(evidence.reason).toContain(reason);
    expect(evidence.recommendedNextActions.length === 0).toBe(
      state === "verified"
    );
  });

  it("marks release readiness partial when CI or bug evidence is incomplete", () => {
    const evidence = adaptReleaseReadinessEvidence(
      {
        repo: "test-org/test-repo",
        headRef: "release-sha",
        isReady: false,
        ciStatus: "unknown",
        ciEvidenceIncomplete: true,
        headShaResolved: true,
        ciSummary: "CI unavailable.",
        openBugCount: 0,
        bugEvidenceIncomplete: true,
        blockingIssues: [
          "CI status could not be verified",
          "Open bug issues could not be fully verified",
        ],
        hasChangelog: true,
        rollbackPlanEvidence: null,
        policy: {
          found: false,
          degraded: false,
          schemaVersion: 1,
          requiredChecks: [],
          protectedPaths: [],
          riskRuleIds: [],
          requiredReviewerRuleIds: [],
          releaseBlockingLabels: [],
          requireIssueLink: false,
          requireCodeOwnersForProtectedPaths: false,
          requireChangelog: false,
          requireRollbackPlan: false,
        },
        policyDigest: "policy-digest",
        policySources: [],
        appliedPolicyRules: [],
        policyDegraded: false,
      },
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "release-sha" },
      "release-sha"
    );

    expect(evidence).toMatchObject({
      state: "failed",
      completeness: "partial",
    });
    expect(evidence.limitations).toEqual(
      expect.arrayContaining([
        "CI evidence was unavailable or incomplete.",
        "Open bug evidence was unavailable or truncated.",
      ])
    );
  });

  it("verifies a complete release readiness result bound to an immutable SHA", () => {
    const evidence = adaptReleaseReadinessEvidence(
      releaseReadiness(),
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "release-sha" },
      "release-sha"
    );

    expect(evidence).toMatchObject({
      state: "verified",
      freshness: "fresh",
      completeness: "complete",
      recommendedNextActions: [],
      provenance: {
        subjectSha: "release-sha",
        policyDigest: "policy-digest",
      },
    });
  });

  it("keeps otherwise-ready release evidence unverified without a subject SHA", () => {
    const evidence = adaptReleaseReadinessEvidence(
      releaseReadiness(),
      "2026-07-26T00:00:00.000Z",
      {},
      undefined
    );

    expect(evidence).toMatchObject({
      state: "unverified",
      freshness: "unknown",
      completeness: "partial",
    });
  });

  it("records degraded policy and unresolved ref limitations", () => {
    const evidence = adaptReleaseReadinessEvidence(
      releaseReadiness({
        isReady: false,
        policyDegraded: true,
        headShaResolved: false,
        blockingIssues: ["Policy could not be verified."],
      }),
      "2026-07-26T00:00:00.000Z",
      { subjectSha: "release-sha" },
      "release-sha"
    );

    expect(evidence.state).toBe("failed");
    expect(evidence.limitations).toEqual(
      expect.arrayContaining([
        "Repository policy evidence was degraded.",
        "Release readiness did not resolve its input to an immutable SHA.",
      ])
    );
    expect(evidence.recommendedNextActions).toHaveLength(1);
  });

  it.each([
    {
      name: "critical alert",
      security: securityTriage({
        alerts: [
          {
            id: 1,
            severity: "critical",
            summary: "Critical alert",
            state: "open",
            url: "https://github.com/test/alert/1",
          },
        ],
        severityCounts: {
          critical: 1,
          high: 0,
          medium: 0,
          low: 0,
          info: 0,
        },
      }),
      state: "failed",
      completeness: "complete",
      reason: "1 open critical or high",
    },
    {
      name: "truncated inventory",
      security: securityTriage({
        errors: ["Secret scanning endpoint was unavailable."],
        truncatedSources: ["dependabot"],
      }),
      state: "unverified",
      completeness: "partial",
      reason: "incomplete security evidence",
    },
    {
      name: "clean inventory",
      security: securityTriage(),
      state: "verified",
      completeness: "complete",
      reason: "No open critical or high",
    },
  ])(
    "classifies security triage evidence: $name",
    ({ security, state, completeness, reason }) => {
      const evidence = adaptSecurityTriageEvidence(
        security,
        "2026-07-26T00:00:00.000Z",
        "test-org/test-repo",
        "1.9.0"
      );

      expect(evidence).toMatchObject({
        state,
        completeness,
        subject: {
          type: "repository",
          repo: "test-org/test-repo",
        },
        provenance: {
          url: "https://github.com/test-org/test-repo/security",
          provider: "github",
          toolVersion: "1.9.0",
        },
      });
      expect(evidence.reason).toContain(reason);
      if (security.truncatedSources?.includes("dependabot")) {
        expect(evidence.limitations).toContain(
          "dependabot alert evidence exceeded the collection budget."
        );
      }
    }
  );
});

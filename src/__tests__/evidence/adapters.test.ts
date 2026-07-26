import { describe, expect, it } from "vitest";

import {
  adaptCiEvidence,
  adaptReleaseReadinessEvidence,
  adaptReviewEvidence,
} from "../../evidence/adapters.js";
import type { PullRequestEvidence } from "../../github/pull-request-evidence.js";

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

describe("evidence adapters", () => {
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
});

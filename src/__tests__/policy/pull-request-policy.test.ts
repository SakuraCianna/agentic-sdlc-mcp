import { describe, expect, it } from "vitest";

import { parseRepositoryPolicy } from "../../policy/repository-policy.js";
import { evaluatePullRequestPolicy } from "../../policy/pull-request-policy.js";

function policy(source: string) {
  const parsed = parseRepositoryPolicy(source);
  if (parsed.degraded) throw new Error(parsed.errors.join("; "));
  return {
    ...parsed,
    found: true,
    policySources: [],
  };
}

const source = `
schemaVersion: 1
requiredChecks: [{ name: policy-check, source: check_run, appId: 15368 }]
protectedPaths: [src/auth/**]
riskRules:
  - id: risk.auth
    paths: [src/auth/**]
    workTypes: []
    level: critical
    domains: [identity]
labels:
  releaseBlocking: [policy-blocked]
review:
  requireIssueLink: true
  requireCodeOwnersForProtectedPaths: true
  requiredReviewers:
    - id: review.auth
      riskRuleIds: [risk.auth]
      reviewers: ["@org/security"]
release:
  requireChangelog: false
  requireRollbackPlan: false
`;

describe("evaluatePullRequestPolicy", () => {
  it("matches both current and previous filenames and returns stable provenance", () => {
    const result = evaluatePullRequestPolicy(policy(source), {
      paths: ["src/public.ts", "src/auth/renamed.ts"],
      changedFilesComplete: true,
      linkedIssues: [{ number: 1 }],
      approvedUsers: [],
      requestedUsers: [],
      requestedTeams: ["org/security"],
      codeOwnerReviewSatisfied: true,
    });

    expect(result.requiredChecks).toEqual([
      { name: "policy-check", source: "check_run", appId: 15368 },
    ]);
    expect(result.blockingLabels).toEqual(["policy-blocked"]);
    expect(result.matchedProtectedPaths).toEqual(["src/auth/**"]);
    expect(result.matchedRiskRuleIds).toEqual(["risk.auth"]);
    expect(result.requiredReviewerRuleIds).toEqual(["review.auth"]);
    expect(result.policyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates blockers for a missing issue and unsatisfied required reviewer", () => {
    const result = evaluatePullRequestPolicy(policy(source), {
      paths: ["src/auth/login.ts"],
      changedFilesComplete: true,
      linkedIssues: [],
      approvedUsers: [],
      requestedUsers: [],
      requestedTeams: [],
      codeOwnerReviewSatisfied: false,
    });

    expect(result.blockers.map((item) => item.ruleId)).toEqual(
      expect.arrayContaining(["review.require_issue_link", "review.auth", "review.require_codeowners_for_protected_paths"])
    );
  });

  it("does not treat a user whose login matches a team slug as team approval", () => {
    const result = evaluatePullRequestPolicy(policy(source), {
      paths: ["src/auth/login.ts"],
      changedFilesComplete: true,
      linkedIssues: [{ number: 1 }],
      approvedUsers: ["security"],
      requestedUsers: [],
      requestedTeams: [],
      codeOwnerReviewSatisfied: true,
    });
    expect(result.blockers.map((item) => item.ruleId)).toContain("review.auth");
  });

  it("reports policy gaps instead of claiming path rules passed when files are incomplete", () => {
    const result = evaluatePullRequestPolicy(policy(source), {
      paths: [],
      changedFilesComplete: false,
      linkedIssues: null,
      approvedUsers: [],
      requestedUsers: [],
      requestedTeams: [],
      codeOwnerReviewSatisfied: null,
    });

    expect(result.policyGaps.map((item) => item.ruleId)).toContain("policy.changed_files_complete");
    expect(result.policyGaps.map((item) => item.ruleId)).toContain("review.require_issue_link");
  });

  it("surfaces loader degradation as a policy gap", () => {
    const loaded = policy("schemaVersion: 1");
    loaded.degraded = true;
    loaded.errors = ["invalid repository policy"];
    const result = evaluatePullRequestPolicy(loaded, {
      paths: [],
      changedFilesComplete: true,
      linkedIssues: [],
      approvedUsers: [],
      requestedUsers: [],
      requestedTeams: [],
      codeOwnerReviewSatisfied: null,
    });
    expect(result.policyGaps[0]?.ruleId).toBe("policy.load");
  });
});

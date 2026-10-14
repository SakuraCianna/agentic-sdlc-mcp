import type { Octokit } from "@octokit/rest";
import type { QualityGateResult } from "../../tools/quality-gate-status.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ config: { githubToken: "test-token", isSmokeMode: false } }));

const { resolveCurrentCheck, withCurrentCheckExcluded, evaluateCurrentCheckDependency } = await import("../../assessment/current-check.js");
const { createReadOnlyGithubSession } = await import("../../assessment/github-session.js");
const REF = { owner: "org", repo: "repo" };
const HEAD = "a".repeat(40);
const MERGE_HEAD = "b".repeat(40);
const IDENTITY = { checkRunId: 11, runId: 22 };
const CHECK_URL = "https://api.github.com/repos/org/repo/check-runs/11";
const BLOCKED_REASON = "GitHub reports that merging is blocked, but the underlying check or review requirement must be resolved from its specific evidence.";
const NO_POLICY_REASON = "No verified merge-relevant protection policy was found.";

function gateResult(): QualityGateResult {
  return {
    contextLabel: "PR #42", headSha: HEAD, conclusion: "policy_gap", totalChecks: 1,
    categories: { passing: [], failing: [], pending: [], skipped: [] },
    blockers: [BLOCKED_REASON, NO_POLICY_REASON], warnings: [], errors: [],
    nextActions: [], degraded: false, unverifiedSignals: [], policyDigest: "a".repeat(64), policyDegraded: false,
    evidence: {
      scope: "pull_request",
      checks: {
        totalSignals: 1, requiredChecks: [], requiredContexts: [], missingRequiredContexts: [],
        checkRuns: { total: 1, failing: [], pending: [], skipped: [], passing: [{
          name: "independent-ci", appId: 15368, source: "check_run", state: "passing", rawStatus: "completed",
          rawConclusion: "success", rawState: null, url: null,
        }] },
        commitStatuses: { total: 0, passing: [], failing: [], pending: [], skipped: [] },
      },
      pullRequest: { draft: false, mergeable: true, mergeableState: "blocked", baseBranch: "main" },
      reviews: {
        reviewDecision: "APPROVED", approved: 1, approvedUsers: ["reviewer"], changesRequestedUsers: [],
        requestedUsers: [], requestedTeams: [], required: null, requireCodeOwnerReviews: false,
        codeOwnerReviewSatisfied: null, ownershipGaps: [],
      },
      branchProtection: {
        classicEnabled: true, rulesetRuleTypes: [], pullRequestRuleRequirements: {
          allowedMergeMethods: null, dismissStaleReviews: false, lockBranch: false,
          requiredConversationResolution: false, requireLastPushApproval: false, requiredLinearHistory: false,
          requiredReviewThreadResolution: false, requiredReviewersConfigured: false,
          requiredSignatures: false, strictRequiredStatusChecksPolicy: false,
        },
      },
      labels: { all: [], blocking: [] }, linkedIssues: [],
    },
  };
}

function fixture(overrides: {
  check?: Record<string, unknown>;
  run?: Record<string, unknown>;
  job?: Record<string, unknown>;
} = {}) {
  const check = {
    id: 11, name: "assessment", app: { id: 15368, slug: "github-actions" },
    status: "in_progress", conclusion: null, head_sha: HEAD, url: CHECK_URL,
    check_suite: { id: 99 }, ...overrides.check,
  };
  const run = {
    id: 22, head_sha: HEAD, repository: { id: 7, full_name: "org/repo" },
    check_suite_id: 99, run_attempt: 2,
    pull_requests: [{ number: 42, head: { sha: HEAD }, base: { repo: { id: 7 } } }],
    ...overrides.run,
  };
  const job = {
    id: 33, run_id: 22, head_sha: HEAD, name: "assessment", check_run_url: CHECK_URL,
    status: "in_progress", conclusion: null, run_attempt: 2, ...overrides.job,
  };
  const methods = {
    checks: {
      get: vi.fn().mockResolvedValue({ data: check }),
      listForRef: vi.fn().mockResolvedValue({ data: { total_count: 1, check_runs: [check] } }),
    },
    actions: {
      getWorkflowRun: vi.fn().mockResolvedValue({ data: run }),
      listJobsForWorkflowRun: vi.fn().mockResolvedValue({ data: { total_count: 1, jobs: [job] } }),
    },
    repos: {
      getBranchProtection: vi.fn().mockResolvedValue({ data: {} }),
      getBranchRules: vi.fn().mockResolvedValue({ data: [] }),
      getContent: vi.fn().mockResolvedValue({ data: { content: "unchanged-policy" } }),
    },
  };
  return { client: methods as unknown as Octokit, methods, check, run, job };
}

describe("current Actions check verification", () => {
  it("verifies an active check through the exact repository, run, PR head, and job", async () => {
    const { client, methods } = fixture();
    const check = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);

    expect(check).toMatchObject({
      id: 11, name: "assessment", appId: 15368, appSlug: "github-actions", runId: 22,
      jobId: 33, owner: "org", repo: "repo", pullNumber: 42, headSha: HEAD, checkHeadSha: HEAD,
      status: "in_progress",
    });
    expect(Object.isFrozen(check)).toBe(true);
    expect(methods.checks.get).toHaveBeenCalledWith({ ...REF, check_run_id: 11 });
    expect(methods.actions.getWorkflowRun).toHaveBeenCalledWith({ ...REF, run_id: 22 });
    expect(methods.actions.listJobsForWorkflowRun).toHaveBeenCalledWith({
      ...REF, run_id: 22, filter: "latest", page: 1, per_page: 100,
    });
  });

  it("accepts a merge commit only when the run explicitly associates the target PR head", async () => {
    const { client } = fixture({
      check: { head_sha: MERGE_HEAD, status: "queued" },
      run: { head_sha: MERGE_HEAD }, job: { head_sha: MERGE_HEAD, status: "queued" },
    });
    const check = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    expect(check.headSha).toBe(HEAD);
    expect(check.checkHeadSha).toBe(MERGE_HEAD);
    expect(check.status).toBe("queued");
  });

  it.each([
    { name: "wrong check ID", check: { id: 12 } },
    { name: "completed failure", check: { status: "completed", conclusion: "failure" } },
    { name: "completed success", check: { status: "completed", conclusion: "success" } },
    { name: "other App", check: { app: { id: 999, slug: "github-actions" } } },
    { name: "spoofed App slug", check: { app: { id: 15368, slug: "other-app" } } },
    { name: "another check repository", check: { url: "https://api.github.com/repos/other/repo/check-runs/11" } },
    { name: "another check commit", check: { head_sha: MERGE_HEAD } },
    { name: "wrong run ID", run: { id: 23 } },
    { name: "another run repository", run: { repository: { id: 7, full_name: "other/repo" } } },
    { name: "missing run PR association", run: { pull_requests: [] } },
    { name: "another PR", run: { pull_requests: [{ number: 43, head: { sha: HEAD }, base: { repo: { id: 7 } } }] } },
    { name: "stale PR head", run: { pull_requests: [{ number: 42, head: { sha: MERGE_HEAD }, base: { repo: { id: 7 } } }] } },
    { name: "PR targets another repo", run: { pull_requests: [{ number: 42, head: { sha: HEAD }, base: { repo: { id: 8 } } }] } },
    { name: "wrong check suite", run: { check_suite_id: 100 } },
    { name: "another job run", job: { run_id: 23 } },
    { name: "another job commit", job: { head_sha: MERGE_HEAD } },
    { name: "another job name", job: { name: "untrusted-private-value" } },
    { name: "completed job", job: { status: "completed", conclusion: "failure" } },
    { name: "another check-run link", job: { check_run_url: "https://api.github.com/repos/org/repo/check-runs/12" } },
    { name: "job URL on another origin", job: { check_run_url: "https://example.test/repos/org/repo/check-runs/11" } },
    { name: "job from earlier attempt", job: { run_attempt: 1 } },
  ])("refuses exclusion for $name", async ({ name: _name, ...overrides }) => {
    const { client } = fixture(overrides);
    await expect(resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY)).rejects.toThrow(
      "could not be verified and was not excluded"
    );
  });

  it("uses bounded job pagination and matches the official check_run_url field", async () => {
    const { client, methods, job } = fixture();
    methods.actions.listJobsForWorkflowRun
      .mockResolvedValueOnce({ data: { total_count: 101, jobs: Array.from({ length: 100 }, () => ({ check_run_url: "other" })) } })
      .mockResolvedValueOnce({ data: { total_count: 101, jobs: [job] } });

    expect((await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY)).jobId).toBe(33);
    expect(methods.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(2);
    expect(methods.actions.listJobsForWorkflowRun).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
  });

  it("fails closed when the current job cannot be found within ten pages", async () => {
    const { client, methods } = fixture();
    methods.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: { total_count: 1001, jobs: Array.from({ length: 100 }, () => ({ check_run_url: "other" })) },
    });
    await expect(resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY)).rejects.toThrow("not excluded");
    expect(methods.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(10);
  });

  it("rejects invalid identities before requesting any endpoint", async () => {
    const { client, methods } = fixture();
    await expect(resolveCurrentCheck(REF, 42, HEAD, client, { runId: NaN, checkRunId: 11 })).rejects.toThrow("not excluded");
    expect(methods.checks.get).not.toHaveBeenCalled();
    expect(methods.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("returns a safe diagnostic for upstream errors without copying external text", async () => {
    const { client, methods } = fixture();
    methods.checks.get.mockRejectedValue(new Error("private-secret"));
    const error = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY).catch((cause) => cause as Error);
    if (!(error instanceof Error)) throw new Error("Expected current-check verification to fail.");
    expect(error.message).toContain("not excluded");
    expect(error.message).not.toContain("private-secret");
  });

  it("settles concurrent reads safely when their shared request budget is exhausted", async () => {
    const { client, methods } = fixture();
    methods.checks.get.mockRejectedValue(new Error("private-secret"));
    const session = createReadOnlyGithubSession(client, { maxRequests: 1 });

    await expect(resolveCurrentCheck(REF, 42, HEAD, session.client, IDENTITY)).rejects.toThrow("not excluded");
    expect(session.usedRequests()).toBe(1);
    expect(methods.actions.getWorkflowRun).not.toHaveBeenCalled();
  });
});

describe("verified current-check evidence exclusion", () => {
  it("removes only the exact active ID and retains same-name providers and completed checks", async () => {
    const { client, methods, check } = fixture();
    const verified = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    const checks = [
      check,
      { ...check, id: 12 },
      { ...check, id: 13, app: { id: 999 } },
      { ...check, id: 14, status: "completed", conclusion: "failure" },
    ];
    methods.checks.listForRef.mockResolvedValue({ data: { total_count: 4, check_runs: checks } });
    const wrapped = withCurrentCheckExcluded(client, verified);
    const result = await wrapped.checks.listForRef({ ...REF, ref: HEAD });

    expect(result.data.check_runs.map((item) => item.id)).toEqual([12, 13, 14]);
    expect(checks).toHaveLength(4);
    methods.checks.listForRef.mockResolvedValue({ data: { total_count: 1, check_runs: [{ ...check, status: "completed", conclusion: "failure" }] } });
    expect((await withCurrentCheckExcluded(client, verified).checks.listForRef({ ...REF, ref: HEAD })).data.check_runs).toHaveLength(1);
  });

  it("keeps filtering pagination complete when the current check occupies a full page", async () => {
    const { client, methods, check } = fixture();
    const verified = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    const first = [check, ...Array.from({ length: 99 }, (_, index) => ({ ...check, id: index + 100 }))];
    const last = [
      { ...check, id: 200, status: "completed", conclusion: "failure" },
      { ...check, id: 201, status: "completed", conclusion: "success" },
    ];
    methods.checks.listForRef.mockImplementation(({ page = 1 }: { page?: number }) => Promise.resolve({
      data: { total_count: 102, check_runs: page === 1 ? first : last },
    }));
    const wrapped = withCurrentCheckExcluded(client, verified);
    const pageOne = await wrapped.checks.listForRef({ ...REF, ref: HEAD, per_page: 100, page: 1 });
    const pageTwo = await wrapped.checks.listForRef({ ...REF, ref: HEAD, per_page: 100, page: 2 });

    expect(pageOne.data.check_runs).toHaveLength(100);
    expect(pageOne.data.check_runs.at(-1)).toMatchObject({ id: 200, conclusion: "failure" });
    expect(pageTwo.data.check_runs.map((item) => item.id)).toEqual([201]);
    expect(methods.checks.listForRef).toHaveBeenCalledTimes(2);
  });

  it("refuses malformed pagination and a repeated-check inventory that cannot be bounded", async () => {
    const { client, methods, check } = fixture();
    const verified = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    const wrapped = withCurrentCheckExcluded(client, verified);

    await expect(wrapped.checks.listForRef({ ...REF, ref: HEAD, per_page: 0 })).rejects.toThrow("not excluded");
    expect(methods.checks.listForRef).not.toHaveBeenCalled();
    methods.checks.listForRef.mockResolvedValue({ data: { total_count: 1000, check_runs: [check] } });
    await expect(wrapped.checks.listForRef({ ...REF, ref: HEAD, per_page: 1 })).rejects.toThrow("not excluded");
    expect(methods.checks.listForRef).toHaveBeenCalledTimes(11);
  });

  it("removes only App-bound requirements and preserves any same-name other provider", async () => {
    const { client, methods } = fixture();
    const verified = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    const protection = { required_status_checks: {
      contexts: ["assessment", "build"],
      checks: [
        { context: "assessment", app_id: 15368 },
        { context: "assessment", app_id: 999 },
        { context: "build", app_id: 15368 },
      ],
    } };
    const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [
      { context: "assessment", integration_id: 15368 },
      { context: "assessment", integration_id: 999 },
      { context: "assessment" },
      { context: "build", integration_id: 15368 },
    ] } }];
    methods.repos.getBranchProtection.mockResolvedValue({ data: protection });
    methods.repos.getBranchRules.mockResolvedValue({ data: rules });
    const wrapped = withCurrentCheckExcluded(client, verified);
    const classic = await wrapped.repos.getBranchProtection({ ...REF, branch: "main" });
    const appliedRules = await wrapped.repos.getBranchRules({ ...REF, branch: "main" });

    expect(classic.data.required_status_checks?.checks).toEqual([
      { context: "assessment", app_id: 999 }, { context: "build", app_id: 15368 },
    ]);
    expect(classic.data.required_status_checks?.contexts).toEqual(["assessment", "build"]);
    expect(appliedRules.data[0]).toMatchObject({ parameters: { required_status_checks: [
      { context: "assessment", integration_id: 999 }, { context: "assessment" }, { context: "build", integration_id: 15368 },
    ] } });
    expect(protection.required_status_checks.checks).toHaveLength(3);
    expect(rules[0].parameters.required_status_checks).toHaveLength(4);
  });

  it("removes a redundant legacy context only with its own explicit App-bound requirement", async () => {
    const { client, methods } = fixture();
    const verified = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    methods.repos.getBranchProtection.mockResolvedValue({ data: { required_status_checks: {
      contexts: ["assessment", "build"], checks: [{ context: "assessment", app_id: 15368 }],
    } } });
    const wrapped = withCurrentCheckExcluded(client, verified);
    expect((await wrapped.repos.getBranchProtection({ ...REF, branch: "main" })).data.required_status_checks?.contexts).toEqual(["build"]);
    methods.repos.getBranchProtection.mockResolvedValue({ data: { required_status_checks: {
      contexts: ["assessment"], checks: [{ context: "assessment", app_id: 999 }],
    } } });
    expect((await wrapped.repos.getBranchProtection({ ...REF, branch: "main" })).data.required_status_checks?.contexts).toEqual(["assessment"]);
  });

  it("preserves unrelated repositories, heads, and repository policy content", async () => {
    const { client, check } = fixture();
    const verified = await resolveCurrentCheck(REF, 42, HEAD, client, IDENTITY);
    const wrapped = withCurrentCheckExcluded(client, verified);

    expect((await wrapped.checks.listForRef({ owner: "other", repo: "repo", ref: HEAD })).data.check_runs).toEqual([check]);
    expect((await wrapped.checks.listForRef({ ...REF, ref: MERGE_HEAD })).data.check_runs).toEqual([check]);
    expect((await wrapped.repos.getContent({ ...REF, path: ".agentic-sdlc.yml", ref: HEAD })).data).toEqual({ content: "unchanged-policy" });
    expect(() => withCurrentCheckExcluded(client, { ...verified })).toThrow("not excluded");
  });

  it("preserves Octokit REST aliases and the binding of unrelated read methods", async () => {
    const { client, methods } = fixture();
    const aliased = Object.assign(client, { rest: { checks: methods.checks, repos: methods.repos } });
    const verified = await resolveCurrentCheck(REF, 42, HEAD, aliased, IDENTITY);
    const wrapped = withCurrentCheckExcluded(aliased, verified);

    expect((await wrapped.rest.checks.listForRef({ ...REF, ref: HEAD })).data.check_runs).toEqual([]);
    expect((await wrapped.actions.getWorkflowRun({ ...REF, run_id: 22 })).data.id).toBe(22);
    expect(wrapped.rest.repos).toBe(wrapped.repos);
  });
});

describe("conditional current-check dependency resolution", () => {
  async function selfRequiredFixture(appId = 15368) {
    const data = fixture();
    data.methods.repos.getBranchProtection.mockResolvedValue({ data: { required_status_checks: {
      strict: false, contexts: ["assessment"], checks: [{ context: "assessment", app_id: appId }],
    } } });
    const verified = await resolveCurrentCheck(REF, 42, HEAD, data.client, IDENTITY);
    const client = withCurrentCheckExcluded(data.client, verified);
    await client.repos.getBranchProtection({ ...REF, branch: "main" });
    return { ...data, client, verified };
  }

  it("resolves a self-only required check when independent CI passes without rewriting GitHub's gate", async () => {
    const { client, verified } = await selfRequiredFixture();
    const gate = gateResult();
    const original = structuredClone(gate);

    expect(evaluateCurrentCheckDependency(client, verified, gate)).toMatchObject({
      state: "other_requirements_satisfied", checkRunId: 11,
      reason: expect.stringContaining("original merge block remains"),
    });
    expect(gate).toEqual(original);
    expect(gate.conclusion).toBe("policy_gap");
    expect(gate.evidence.pullRequest?.mergeableState).toBe("blocked");
  });

  it("resolves an emptied self-only ruleset but retains unrelated and unknown rules", async () => {
    const data = fixture();
    data.methods.repos.getBranchRules.mockResolvedValue({ data: [{ type: "required_status_checks", parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: "assessment", integration_id: 15368 }],
    } }] });
    const verified = await resolveCurrentCheck(REF, 42, HEAD, data.client, IDENTITY);
    const client = withCurrentCheckExcluded(data.client, verified);
    await client.repos.getBranchRules({ ...REF, branch: "main" });
    const gate = gateResult();
    gate.evidence.branchProtection!.classicEnabled = false;
    gate.evidence.branchProtection!.rulesetRuleTypes = ["required_status_checks"];
    gate.blockers = [BLOCKED_REASON, "Unmodeled merge rules cannot be verified: required_status_checks."];
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("other_requirements_satisfied");

    data.methods.repos.getBranchRules.mockResolvedValue({ data: [{ type: "required_status_checks", parameters: { required_status_checks: [] } }] });
    await client.repos.getBranchRules({ ...REF, branch: "main" });
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
  });

  it("requires remaining App-bound checks and current required approvals to be independently satisfied", async () => {
    const { client, verified } = await selfRequiredFixture();
    const gate = gateResult();
    gate.blockers = [BLOCKED_REASON];
    gate.evidence.checks.requiredChecks = [{ context: "independent-ci", appId: 15368 }];
    gate.evidence.reviews!.required = 1;
    gate.evidence.reviews!.requireCodeOwnerReviews = true;
    gate.evidence.reviews!.codeOwnerReviewSatisfied = true;
    gate.evidence.branchProtection!.pullRequestRuleRequirements.dismissStaleReviews = true;
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("other_requirements_satisfied");

    gate.evidence.reviews!.codeOwnerReviewSatisfied = null;
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
  });

  it("retains a strict requirement observed by the wrapper even if a supplied gate omits it", async () => {
    const { client, methods, verified } = await selfRequiredFixture();
    methods.repos.getBranchProtection.mockResolvedValue({ data: { required_status_checks: {
      strict: true, contexts: ["assessment"], checks: [{ context: "assessment", app_id: 15368 }],
    } } });
    await client.repos.getBranchProtection({ ...REF, branch: "main" });
    expect(evaluateCurrentCheckDependency(client, verified, gateResult()).state).toBe("unresolved");
  });

  it("requires real exclusion receipts for the exact client, verified object, branch, and provider", async () => {
    const { client, methods, verified } = await selfRequiredFixture();
    const gate = gateResult();
    expect(evaluateCurrentCheckDependency(methods as unknown as Octokit, verified, gate).state).toBe("unresolved");
    expect(evaluateCurrentCheckDependency(client, { ...verified }, gate).state).toBe("unresolved");
    gate.evidence.pullRequest!.baseBranch = "another-base";
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
    const other = await selfRequiredFixture(999);
    expect(evaluateCurrentCheckDependency(other.client, other.verified, gateResult()).state).toBe("unresolved");
  });

  it.each([
    "strictRequiredStatusChecksPolicy", "lockBranch", "requiredConversationResolution", "requiredSignatures",
    "requiredLinearHistory", "requiredReviewThreadResolution", "requiredReviewersConfigured",
  ] as const)("retains unsupported requirement %s", async (name) => {
    const { client, verified } = await selfRequiredFixture();
    const gate = gateResult();
    gate.evidence.branchProtection!.pullRequestRuleRequirements[name] = true;
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
  });

  it.each([
    "degraded", "changed head", "other blocker", "missing check", "wrong check provider", "missing review", "no independent CI",
  ])("retains evidence gaps and unrelated blockers: %s", async (scenario) => {
    const { client, verified } = await selfRequiredFixture();
    const gate = gateResult();
    if (scenario === "degraded") gate.degraded = true;
    if (scenario === "changed head") gate.headSha = MERGE_HEAD;
    if (scenario === "other blocker") gate.blockers.push("An unrelated repository requirement is unsatisfied.");
    if (scenario === "missing check") gate.evidence.checks.missingRequiredContexts = ["required-ci"];
    if (scenario === "wrong check provider") {
      gate.blockers = [BLOCKED_REASON];
      gate.evidence.checks.requiredChecks = [{ context: "independent-ci", appId: 999 }];
    }
    if (scenario === "missing review") {
      gate.evidence.reviews!.required = 1;
      gate.evidence.reviews!.reviewDecision = null;
    }
    if (scenario === "no independent CI") gate.evidence.checks.checkRuns.passing = [];
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
  });

  it("retains every remaining pending or failing check and a newly completed current check", async () => {
    const { client, methods, verified, check } = await selfRequiredFixture();
    const gate = gateResult();
    const passing = gate.evidence.checks.checkRuns.passing[0];
    gate.evidence.checks.checkRuns.pending = [{ ...passing, name: "assessment", state: "pending" }];
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
    gate.evidence.checks.checkRuns.pending = [];
    methods.checks.listForRef.mockResolvedValue({ data: { total_count: 1, check_runs: [{ ...check, status: "completed", conclusion: "success" }] } });
    await client.checks.listForRef({ ...REF, ref: HEAD });
    expect(evaluateCurrentCheckDependency(client, verified, gate).state).toBe("unresolved");
  });
});

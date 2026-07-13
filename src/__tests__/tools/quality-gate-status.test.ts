/**
 * Tests for the real PR quality gate and ref-only CI compatibility.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  CiEvidence,
  GateSignal,
  PullRequestEvidence,
  SignalBuckets,
} from "../../github/pull-request-evidence.js";
import type { RepoRef } from "../../types.js";

vi.mock("../../config.js", () => ({
  config: {
    githubToken: "test-token",
    githubOwner: "default-owner",
    githubRepo: "default-repo",
    defaultBranch: "main",
  },
}));

const evidenceMocks = vi.hoisted(() => ({
  collectCiEvidence: vi.fn(),
  collectPullRequestEvidence: vi.fn(),
}));

vi.mock("../../github/pull-request-evidence.js", () => evidenceMocks);

const {
  QualityGateInputSchema,
  QualityGateOutputSchema,
  categorizeChecks,
  evaluateQualityGate,
  handleQualityGateStatus,
} = await import("../../tools/quality-gate-status.js");

import type { QualityGateInput } from "../../tools/quality-gate-status.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };
const DEFAULT_BLOCKING_LABELS = [
  "blocked",
  "do-not-merge",
  "release-blocker",
  "security-blocker",
];

function signal(
  name: string,
  state: GateSignal["state"] = "passing",
  source: GateSignal["source"] = "check_run",
  appId?: number | null
): GateSignal {
  return {
    name,
    source,
    appId: appId ?? null,
    state,
    rawStatus: source === "check_run" ? (state === "pending" ? "in_progress" : "completed") : null,
    rawConclusion:
      source === "check_run"
        ? state === "passing"
          ? "success"
          : state === "failing"
            ? "failure"
            : state === "skipped"
              ? "skipped"
              : null
        : null,
    rawState: source === "commit_status" ? (state === "passing" ? "success" : state) : null,
    url: null,
  };
}

function buckets(signals: GateSignal[] = []): SignalBuckets {
  return {
    passing: signals.filter((item) => item.state === "passing"),
    failing: signals.filter((item) => item.state === "failing"),
    pending: signals.filter((item) => item.state === "pending"),
    skipped: signals.filter((item) => item.state === "skipped"),
    total: signals.length,
  };
}

function ciEvidence(options: {
  checkRuns?: GateSignal[];
  commitStatuses?: GateSignal[];
  unverifiedSignals?: string[];
  errors?: string[];
} = {}): CiEvidence {
  const checkRuns = buckets(options.checkRuns ?? []);
  const commitStatuses = buckets(options.commitStatuses ?? []);
  return {
    checkRuns,
    commitStatuses,
    totalSignals: checkRuns.total + commitStatuses.total,
    hasFailing: checkRuns.failing.length > 0 || commitStatuses.failing.length > 0,
    hasPending: checkRuns.pending.length > 0 || commitStatuses.pending.length > 0,
    unverifiedSignals: options.unverifiedSignals ?? [],
    errors: options.errors ?? [],
  };
}

type PullRequestOverrides = {
  pullRequest?: Partial<PullRequestEvidence["pullRequest"]>;
  ci?: CiEvidence;
  reviews?: Partial<PullRequestEvidence["reviews"]>;
  branchProtection?: Partial<PullRequestEvidence["branchProtection"]>;
  linkedIssues?: PullRequestEvidence["linkedIssues"];
  degraded?: boolean;
  unverifiedSignals?: string[];
  errors?: string[];
  changedFiles?: PullRequestEvidence["changedFiles"];
};

function pullRequestRuleRequirements(
  overrides: Partial<
    PullRequestEvidence["branchProtection"]["pullRequestRuleRequirements"]
  > = {}
): PullRequestEvidence["branchProtection"]["pullRequestRuleRequirements"] {
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
    ...overrides,
  };
}

function pullRequestEvidence(overrides: PullRequestOverrides = {}): PullRequestEvidence {
  const unverifiedSignals = overrides.unverifiedSignals ?? [];
  return {
    pullRequest: {
      number: 42,
      title: "Real merge gate",
      body: "Evidence first",
      author: "Alice",
      headSha: "abc1234def5678",
      headRef: "feature/gate",
      baseBranch: "main",
      draft: false,
      commits: 1,
      mergeable: true,
      mergeableState: "clean",
      labels: [],
      ...overrides.pullRequest,
    },
    changedFiles: overrides.changedFiles ?? [],
    ci: overrides.ci ?? ciEvidence({ checkRuns: [signal("test")] }),
    reviews: {
      reviewDecision: "APPROVED",
      approvedUsers: ["Bob"],
      changesRequestedUsers: [],
      requestedUsers: [],
      requestedTeams: [],
      requiredApprovals: 1,
      requireCodeOwnerReviews: false,
      codeOwnerReviewSatisfied: null,
      ownershipGaps: [],
      codeownersFound: false,
      ...overrides.reviews,
    },
    branchProtection: {
      classicEnabled: true,
      rulesetRuleTypes: [],
      requiredStatusContexts: [],
      requiredStatusChecks: [],
      pullRequestRuleRequirements: pullRequestRuleRequirements(),
      ...overrides.branchProtection,
    },
    linkedIssues:
      overrides.linkedIssues === undefined
        ? [{ number: 7, title: "Ship gate", url: "https://example.test/issues/7" }]
        : overrides.linkedIssues,
    degraded: overrides.degraded ?? unverifiedSignals.length > 0,
    unverifiedSignals,
    errors: overrides.errors ?? [],
  };
}

function makeOctokit() {
  return {
    git: {
      getRef: vi.fn().mockResolvedValue({ data: { object: { sha: "ref-sha-12345678" } } }),
    },
    repos: {
      getCommit: vi.fn().mockResolvedValue({ data: { sha: "resolved-sha-12345678" } }),
    },
    pulls: { get: vi.fn(() => Promise.reject(new Error("PR API must not be called"))) },
  } as unknown as Parameters<typeof handleQualityGateStatus>[2];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("categorizeChecks", () => {
  it("keeps legacy check-run buckets", () => {
    const categories = categorizeChecks([
      { name: "pass", status: "completed", conclusion: "success", html_url: null },
      { name: "fail", status: "completed", conclusion: "failure", html_url: null },
      { name: "wait", status: "in_progress", conclusion: null, html_url: null },
      { name: "skip", status: "completed", conclusion: "neutral", html_url: null },
    ]);

    expect(categories.passing.map(({ name }) => name)).toEqual(["pass"]);
    expect(categories.failing.map(({ name }) => name)).toEqual(["fail"]);
    expect(categories.pending.map(({ name }) => name)).toEqual(["wait"]);
    expect(categories.skipped.map(({ name }) => name)).toEqual(["skip"]);
  });
});

describe("evaluateQualityGate conclusion priority", () => {
  it.each(["unknown", "queued", "checking", "pending"])(
    "treats computing mergeable_state %s as pending",
    (mergeableState) => {
      const decision = evaluateQualityGate(
        pullRequestEvidence({ pullRequest: { mergeableState } }),
        DEFAULT_BLOCKING_LABELS
      );

      expect(decision.conclusion).toBe("pending");
      expect(decision.blockers.join(" ")).toMatch(/mergeability state/i);
    }
  );

  it.each(["dirty", "unstable"])(
    "treats explicit failing mergeable_state %s as failing",
    (mergeableState) => {
      const decision = evaluateQualityGate(
        pullRequestEvidence({ pullRequest: { mergeableState } }),
        DEFAULT_BLOCKING_LABELS
      );

      expect(decision.conclusion).toBe("failing");
      expect(decision.blockers.join(" ")).toContain(mergeableState);
    }
  );
  it("treats behind as pending", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({ pullRequest: { mergeableState: "behind" } }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("pending");
  });
  it("allows has_hooks when all other evidence passes", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({ pullRequest: { mergeableState: "has_hooks" } }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("passing");
  });
  it("lets draft state use the existing needs_review classification", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({ pullRequest: { mergeableState: "draft", draft: true } }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("needs_review");
  });
  it.each(["blocked", "future_state"])(
    "reports ambiguous mergeable_state %s as a policy gap when no specific blocker exists",
    (mergeableState) => {
      const decision = evaluateQualityGate(
        pullRequestEvidence({ pullRequest: { mergeableState } }),
        DEFAULT_BLOCKING_LABELS
      );

      expect(decision.conclusion).toBe("policy_gap");
      expect(decision.blockers.join(" ")).toContain(mergeableState);
    }
  );
  it("keeps a pending CI signal ahead of an ambiguous blocked merge state", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({
        pullRequest: { mergeableState: "blocked" },
        ci: ciEvidence({ checkRuns: [signal("wait", "pending")] }),
      }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("pending");
  });
  it("returns failing ahead of pending, review, and policy gaps", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("failed", "failing"), signal("wait", "pending")] }),
      pullRequest: { draft: true },
      branchProtection: { classicEnabled: false },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("failing");
  });

  it("returns pending ahead of review and policy gaps", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("wait", "pending")] }),
      pullRequest: { draft: true },
      branchProtection: { classicEnabled: false },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("pending");
  });

  it("returns pending ahead of an incomplete required review", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("wait", "pending")] }),
      reviews: {
        reviewDecision: "REVIEW_REQUIRED",
        requiredApprovals: 2,
        approvedUsers: ["Bob"],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("pending");
  });

  it("returns needs_review ahead of policy gaps", () => {
    const evidence = pullRequestEvidence({
      pullRequest: { draft: true },
      branchProtection: { classicEnabled: false },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("needs_review");
  });

  it("returns policy_gap ahead of no_evidence", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
      reviews: { requiredApprovals: null, reviewDecision: null, approvedUsers: [] },
      branchProtection: { classicEnabled: false, rulesetRuleTypes: [] },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("returns passing when an approved review policy is the only verified system evidence", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it("returns passing only with verified green evidence", () => {
    const evidence = pullRequestEvidence();

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });
});

describe("evaluateQualityGate PR policy", () => {
  it("returns needs_review when green CI has fewer approvals than required", () => {
    const evidence = pullRequestEvidence({
      reviews: { requiredApprovals: 2, approvedUsers: ["Bob"], reviewDecision: "REVIEW_REQUIRED" },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("needs_review");
  });

  it("fails closed when a PR ruleset requires unresolved review threads to be resolved", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
      reviews: { reviewDecision: "APPROVED", requiredApprovals: 1 },
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["pull_request"],
        pullRequestRuleRequirements: pullRequestRuleRequirements({
          requiredReviewThreadResolution: true,
          requiredReviewersConfigured: false,
        }),
      },
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/required_review_thread_resolution/i);
  });

  it("fails closed when a PR ruleset configures required reviewers", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
      reviews: { reviewDecision: "APPROVED", requiredApprovals: 1 },
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["pull_request"],
        pullRequestRuleRequirements: pullRequestRuleRequirements({
          requiredReviewThreadResolution: false,
          requiredReviewersConfigured: true,
        }),
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("fails closed when allowed merge methods cannot be compared with repository settings", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
      reviews: { reviewDecision: "APPROVED", requiredApprovals: 1 },
      branchProtection: { classicEnabled: false, rulesetRuleTypes: ["pull_request"] },
    });
    Object.assign(evidence.branchProtection.pullRequestRuleRequirements, {
      allowedMergeMethods: ["merge"],
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/allowed_merge_methods/i);
  });

  it("fails closed when strict required checks lack authoritative up-to-date evidence", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      ci: ciEvidence({ checkRuns: [signal("build")] }),
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: null }],
      },
    });
    Object.assign(evidence.branchProtection.pullRequestRuleRequirements, {
      strictRequiredStatusChecksPolicy: true,
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/strict_required_status_checks_policy/i);
  });

  it("keeps non-strict required checks modeled when their matching check passes", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      ci: ciEvidence({ checkRuns: [signal("build")] }),
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: null }],
      },
    });
    Object.assign(evidence.branchProtection.pullRequestRuleRequirements, {
      strictRequiredStatusChecksPolicy: false,
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it.each([
    [
      "strict required checks",
      "strictRequiredStatusChecksPolicy",
      "strict_required_status_checks_policy",
    ],
    [
      "conversation resolution",
      "requiredConversationResolution",
      "required_conversation_resolution",
    ],
    ["signed commits", "requiredSignatures", "required_signatures"],
    ["linear history", "requiredLinearHistory", "required_linear_history"],
    ["a locked branch", "lockBranch", "lock_branch"],
  ] as const)("fails closed for classic %s without authoritative evidence", (_, field, blocker) => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
      reviews: { reviewDecision: "APPROVED", requiredApprovals: 1 },
      branchProtection: { classicEnabled: true, rulesetRuleTypes: [] },
    });
    Object.assign(evidence.branchProtection.pullRequestRuleRequirements, {
      [field]: true,
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toContain(blocker);
  });

  it("does not treat zero CI signals as passing", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence(),
      reviews: {
        reviewDecision: null,
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: [],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).not.toBe("passing");
  });

  it("returns needs_review for a draft PR", () => {
    const evidence = pullRequestEvidence({ pullRequest: { draft: true } });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("needs_review");
  });

  it("returns pending when GitHub has not computed mergeability", () => {
    const evidence = pullRequestEvidence({ pullRequest: { mergeable: null } });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("pending");
  });

  it("returns failing when GitHub reports the PR is not mergeable", () => {
    const evidence = pullRequestEvidence({ pullRequest: { mergeable: false } });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("failing");
  });

  it("returns failing for CHANGES_REQUESTED without a review rule as a governance policy", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: "CHANGES_REQUESTED",
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("failing");
  });

  it("names reviewers who requested changes in the blocker", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: "CHANGES_REQUESTED",
        changesRequestedUsers: ["Eve", "Mallory"],
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("failing");
    expect(decision.blockers.join(" ")).toContain("Eve, Mallory");
  });

  it("treats aggregate APPROVED as authoritative over stale REST approval counts", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: "APPROVED",
        requiredApprovals: 2,
        approvedUsers: [],
      },
      degraded: true,
      unverifiedSignals: ["reviews"],
    });
    Object.assign(evidence.branchProtection.pullRequestRuleRequirements, {
      dismissStaleReviews: true,
      requireLastPushApproval: true,
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it("returns policy_gap for classic last-push approval with zero approvals when aggregate is unverified", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: 0,
        requireCodeOwnerReviews: false,
      },
      ci: ciEvidence({ checkRuns: [signal("build")] }),
      branchProtection: {
        classicEnabled: true,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: null }],
      },
      degraded: true,
      unverifiedSignals: ["review_decision"],
    });
    Object.assign(evidence.branchProtection.pullRequestRuleRequirements, {
      requireLastPushApproval: true,
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/aggregate review decision|review_decision/i);
  });

  it("fails on verified REST changes-requested when the aggregate is unverified", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        changesRequestedUsers: ["Eve"],
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      ci: ciEvidence({
        checkRuns: [signal("build"), signal("optional", "pending")],
      }),
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: null }],
      },
      degraded: true,
      unverifiedSignals: ["review_decision"],
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("failing");
    expect(decision.blockers.join(" ")).toContain("Eve");
  });

  it("fails closed when aggregate review state is unverified even without a review policy", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["test"],
      },
      degraded: true,
      unverifiedSignals: ["review_decision"],
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("explains both missing review sources when aggregate and REST reviews are unverified", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["test"],
      },
      degraded: true,
      unverifiedSignals: ["review_decision", "reviews"],
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/review_decision.*reviews|reviews.*review_decision/i);
  });

  it("returns policy_gap when a configured review policy has no aggregate decision", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: 1,
        approvedUsers: ["Bob"],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("does not pass stale approval counts when both REST reviews and aggregate decision are unverified", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: 1,
        approvedUsers: ["Bob"],
      },
      degraded: true,
      unverifiedSignals: ["reviews", "review_decision"],
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("returns needs_review when verified REST approvals are incomplete and aggregate is unavailable", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: 2,
        approvedUsers: ["Bob"],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("needs_review");
  });

  it("returns needs_review for aggregate REVIEW_REQUIRED even when REST approval count is sufficient", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: "REVIEW_REQUIRED",
        requiredApprovals: 1,
        approvedUsers: ["Bob"],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("needs_review");
  });

  it("returns policy_gap when both verified protection sources contain no policy", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        reviewDecision: null,
        requiredApprovals: null,
        requireCodeOwnerReviews: false,
      },
      branchProtection: { classicEnabled: false, rulesetRuleTypes: [] },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("returns policy_gap when a critical protection source is unverified", () => {
    const evidence = pullRequestEvidence({
      unverifiedSignals: ["branch_protection"],
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("fails closed for required CODEOWNER review without claiming a specific owner rejected it", () => {
    const evidence = pullRequestEvidence({
      reviews: {
        requireCodeOwnerReviews: true,
        codeOwnerReviewSatisfied: null,
        reviewDecision: null,
      },
      unverifiedSignals: ["review_decision", "code_owner_review"],
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/CODEOWNER.*无法验证/i);
    expect(decision.blockers.join(" ")).not.toMatch(/未批准|rejected/i);
  });
});

describe("blocking label policy", () => {
  it("uses the four default blocking labels", () => {
    expect(QualityGateInputSchema.parse({ pullNumber: 42 }).blockingLabels).toEqual(
      DEFAULT_BLOCKING_LABELS
    );
  });

  it("matches blocking labels case-insensitively by exact name", () => {
    const evidence = pullRequestEvidence({ pullRequest: { labels: ["Do-NoT-MeRgE", "blocked-later"] } });
    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("failing");
    expect(decision.matchedBlockingLabels).toEqual(["Do-NoT-MeRgE"]);
  });

  it("allows an empty blocking-label configuration to disable label blocking", () => {
    const evidence = pullRequestEvidence({ pullRequest: { labels: ["blocked"] } });

    expect(evaluateQualityGate(evidence, []).conclusion).toBe("passing");
  });
});

describe("merge-relevant policy", () => {
  const noReviewPolicy = {
    reviewDecision: "APPROVED" as const,
    requiredApprovals: null,
    requireCodeOwnerReviews: false,
  };

  it("returns policy_gap for a deletion-only ruleset", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["deletion"],
        requiredStatusContexts: [],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("does not treat classic protection without a modeled merge requirement as a merge gate", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      branchProtection: {
        classicEnabled: true,
        rulesetRuleTypes: [],
        requiredStatusContexts: [],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("fails closed for an unmodeled required deployment rule", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_deployments"],
        requiredStatusContexts: [],
      },
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toMatch(/required_deployments.*无法验证|unmodeled.*required_deployments/i);
  });

  it("passes when every modeled required context succeeds and no unmodeled rule exists", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      ci: ciEvidence({ checkRuns: [signal("test")] }),
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: ["test"],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it("fails closed when modeled required contexts coexist with an unmodeled rule", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      ci: ciEvidence({ checkRuns: [signal("test")] }),
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks", "required_deployments"],
        requiredStatusContexts: ["test"],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it.each([
    "commit_message_pattern",
    "commit_author_email_pattern",
    "committer_email_pattern",
    "file_path_restriction",
    "max_file_path_length",
    "file_extension_restriction",
    "max_file_size",
    "update",
    "future_code_quality_rule",
  ])("fails closed for default-unmodeled rule %s beside a passing required check", (ruleType) => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      ci: ciEvidence({ checkRuns: [signal("build")] }),
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks", ruleType],
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: null }],
      },
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("policy_gap");
    expect(decision.blockers.join(" ")).toContain(ruleType);
    expect(decision.blockers.join(" ")).not.toContain(
      "No verified merge-relevant protection policy"
    );
  });

  it.each(["creation", "deletion", "non_fast_forward"])(
    "safely ignores %s when a modeled required check passes",
    (ruleType) => {
      const evidence = pullRequestEvidence({
        reviews: noReviewPolicy,
        ci: ciEvidence({ checkRuns: [signal("build")] }),
        branchProtection: {
          classicEnabled: false,
          rulesetRuleTypes: ["required_status_checks", ruleType],
          requiredStatusContexts: ["build"],
          requiredStatusChecks: [{ context: "build", appId: null }],
        },
      });

      expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe(
        "passing"
      );
    }
  );

  it("fails closed for a pull_request rule with no visible review requirements", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["pull_request"],
        requiredStatusContexts: [],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("fails closed for a required_status_checks rule with no visible contexts", () => {
    const evidence = pullRequestEvidence({
      reviews: noReviewPolicy,
      branchProtection: {
        classicEnabled: false,
        rulesetRuleTypes: ["required_status_checks"],
        requiredStatusContexts: [],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });
});

describe("warnings and required contexts", () => {
  it("warns when verified linked issue evidence is empty", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({ linkedIssues: [] }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.warnings.join(" ")).toMatch(/未关联.*issue/i);
  });

  it("does not claim there is no linked issue when that source is unverified", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({ linkedIssues: null, unverifiedSignals: ["linked_issues"] }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("passing");
    expect(decision.warnings.join(" ")).not.toMatch(/未关联.*issue/i);
    expect(decision.warnings.join(" ")).toMatch(/linked issue.*无法验证/i);
  });

  it("warns without blocking when no required review rule is configured", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({
        reviews: { requiredApprovals: null, approvedUsers: [], reviewDecision: null },
        branchProtection: {
          classicEnabled: false,
          rulesetRuleTypes: ["required_status_checks"],
          requiredStatusContexts: ["test"],
        },
      }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("passing");
    expect(decision.warnings.join(" ")).toMatch(/未配置 required review/i);
  });

  it("does not claim required review is unconfigured when policy sources are unverified", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({
        reviews: {
          requiredApprovals: null,
          requireCodeOwnerReviews: false,
          reviewDecision: null,
        },
        unverifiedSignals: ["branch_protection"],
      }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.warnings.join(" ")).not.toMatch(/未配置 required review/i);
  });

  it("does not claim required review is unconfigured for a CODEOWNER-only policy", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({
        reviews: {
          requiredApprovals: null,
          requireCodeOwnerReviews: true,
          codeOwnerReviewSatisfied: true,
          reviewDecision: "APPROVED",
        },
      }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.warnings.join(" ")).not.toMatch(/未配置 required review/i);
  });

  it("keeps unenforced CODEOWNERS routing gaps as warnings", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({
        reviews: {
          requireCodeOwnerReviews: false,
          ownershipGaps: [{ owner: "@Platform", paths: ["src/gate.ts"] }],
        },
      }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("passing");
    expect(decision.warnings.join(" ")).toMatch(/CODEOWNERS.*未配置强制/i);
  });

  it("keeps an unverified requested-reviewer source as a warning", () => {
    const decision = evaluateQualityGate(
      pullRequestEvidence({ unverifiedSignals: ["requested_reviewers"] }),
      DEFAULT_BLOCKING_LABELS
    );

    expect(decision.conclusion).toBe("passing");
    expect(decision.warnings.join(" ")).toMatch(/requested_reviewers.*无法完整验证/i);
  });

  it("returns pending when a required context is absent across both CI sources", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({
        checkRuns: [signal("Test")],
        commitStatuses: [signal("legacy", "passing", "commit_status")],
      }),
      branchProtection: { requiredStatusContexts: ["test", "Lint"] },
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("pending");
    expect(decision.missingRequiredContexts).toEqual(["Lint"]);
  });

  it("does not satisfy an App-bound required check with a same-name check from another App", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("build", "passing", "check_run", 999)] }),
      branchProtection: {
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: 4242 }],
      },
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("pending");
    expect(decision.missingRequiredContexts).toEqual(["build"]);
  });

  it("satisfies an App-bound required check only with the matching check-run provider", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({
        checkRuns: [
          signal("build", "passing", "check_run", 999),
          signal("build", "passing", "check_run", 4242),
        ],
      }),
      branchProtection: {
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: 4242 }],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it("does not satisfy an App-bound required check with a legacy commit status", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ commitStatuses: [signal("build", "passing", "commit_status")] }),
      branchProtection: {
        requiredStatusContexts: ["build"],
        requiredStatusChecks: [{ context: "build", appId: 4242 }],
      },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("pending");
  });

  it("accepts a skipped or neutral signal when it satisfies a required context", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("test", "skipped")] }),
      branchProtection: { requiredStatusContexts: ["Test"] },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it("uses a satisfied review policy when the only CI signal is optional and skipped", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("optional", "skipped")] }),
      branchProtection: { requiredStatusContexts: [] },
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("passing");
  });

  it("returns pending for a missing required context ahead of an unverified policy source", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("Test")] }),
      branchProtection: { requiredStatusContexts: ["test", "Lint"] },
      unverifiedSignals: ["branch_protection"],
    });

    const decision = evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS);

    expect(decision.conclusion).toBe("pending");
    expect(decision.missingRequiredContexts).toEqual(["Lint"]);
  });

  it("returns policy_gap for truncated known-passing CI", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("test")], unverifiedSignals: ["check_runs"] }),
      unverifiedSignals: ["check_runs"],
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("policy_gap");
  });

  it("keeps a known CI failure ahead of truncated evidence", () => {
    const evidence = pullRequestEvidence({
      ci: ciEvidence({ checkRuns: [signal("test", "failing")], unverifiedSignals: ["check_runs"] }),
      unverifiedSignals: ["check_runs"],
    });

    expect(evaluateQualityGate(evidence, DEFAULT_BLOCKING_LABELS).conclusion).toBe("failing");
  });
});

describe("handleQualityGateStatus ref compatibility", () => {
  it("keeps a raw ref in structured output but renders it as safe inline Markdown", async () => {
    const maliciousRef = "heads/main\n## forged [ref](javascript:alert(1))";
    evidenceMocks.collectCiEvidence.mockResolvedValueOnce(
      ciEvidence({ checkRuns: [signal("test")] })
    );

    const { structured, text } = await handleQualityGateStatus(
      { ref: maliciousRef },
      REF,
      makeOctokit()
    );

    expect(structured.contextLabel).toBe(`ref: ${maliciousRef}`);
    expect(text).not.toContain("\n## forged");
    expect(text).toContain("\\[ref\\]\\(javascript:alert\\(1\\)\\)");
  });

  it.each([
    { input: "main", normalized: "main" },
    { input: "0123456789abcdef0123456789abcdef01234567", normalized: "0123456789abcdef0123456789abcdef01234567" },
    { input: "refs/heads/main", normalized: "heads/main" },
    { input: "refs/tags/v1", normalized: "tags/v1" },
    { input: "refs/heads/v1", normalized: "heads/v1" },
    { input: "heads/release", normalized: "heads/release" },
    { input: "tags/v1", normalized: "tags/v1" },
  ])("resolves $input through repos.getCommit with ref $normalized", async ({ input, normalized }) => {
    evidenceMocks.collectCiEvidence.mockResolvedValueOnce(
      ciEvidence({ checkRuns: [signal("test")] })
    );
    const octokit = makeOctokit();
    const methods = octokit as unknown as {
      repos: { getCommit: ReturnType<typeof vi.fn> };
      git: { getRef: ReturnType<typeof vi.fn> };
    };

    const { structured } = await handleQualityGateStatus({ ref: input }, REF, octokit);

    expect(methods.repos.getCommit).toHaveBeenCalledWith({
      owner: REF.owner,
      repo: REF.repo,
      ref: normalized,
    });
    expect(methods.git.getRef).not.toHaveBeenCalled();
    expect(structured.headSha).toBe("resolved-sha-12345678");
    expect(evidenceMocks.collectCiEvidence).toHaveBeenCalledWith(
      REF,
      "resolved-sha-12345678",
      octokit
    );
    expect(evidenceMocks.collectPullRequestEvidence).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "passing",
      ci: ciEvidence({ checkRuns: [signal("test")] }),
      conclusion: "passing",
    },
    {
      name: "failing",
      ci: ciEvidence({ commitStatuses: [signal("legacy", "failing", "commit_status")] }),
      conclusion: "failing",
    },
    {
      name: "pending",
      ci: ciEvidence({ checkRuns: [signal("test", "pending")] }),
      conclusion: "pending",
    },
    { name: "zero", ci: ciEvidence(), conclusion: "no_evidence" },
    {
      name: "unverified",
      ci: ciEvidence({ checkRuns: [signal("test")], unverifiedSignals: ["commit_statuses"] }),
      conclusion: "no_evidence",
    },
  ])("returns $conclusion for $name CI evidence", async ({ ci, conclusion }) => {
    evidenceMocks.collectCiEvidence.mockResolvedValueOnce(ci);

    const { structured } = await handleQualityGateStatus({ ref: "heads/main" }, REF, makeOctokit());

    expect(structured.conclusion).toBe(conclusion);
    expect(structured.evidence.scope).toBe("ref");
    expect(structured.evidence.pullRequest).toBeNull();
  });

  it("does not call the PR evidence collector or PR API in ref mode", async () => {
    evidenceMocks.collectCiEvidence.mockResolvedValueOnce(ciEvidence({ checkRuns: [signal("test")] }));
    const octokit = makeOctokit();

    await handleQualityGateStatus({ ref: "heads/main" }, REF, octokit);

    expect(evidenceMocks.collectPullRequestEvidence).not.toHaveBeenCalled();
    expect((octokit as unknown as { pulls: { get: ReturnType<typeof vi.fn> } }).pulls.get).not.toHaveBeenCalled();
  });
});

describe("handleQualityGateStatus output", () => {
  it("loads policy from the PR base SHA and enforces repository required checks", async () => {
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({
        pullRequest: { baseSha: "base-policy-sha" },
        changedFiles: [{
          filename: "src/auth/login.ts", status: "modified", additions: 1,
          deletions: 0, changes: 1,
        }],
      })
    );
    const policy = [
      "schemaVersion: 1",
      "requiredChecks: [{ name: policy-check, source: check_run, appId: 15368 }]",
      "protectedPaths: [src/auth/**]",
    ].join("\n");
    const octokit = makeOctokit() as unknown as {
      repos: Record<string, unknown> & { getContent: ReturnType<typeof vi.fn> };
    };
    octokit.repos.getContent = vi.fn().mockResolvedValue({
      data: {
        type: "file", encoding: "base64",
        content: Buffer.from(policy).toString("base64"), sha: "policy-blob",
      },
    });

    const { structured, text } = await handleQualityGateStatus(
      { pullNumber: 42 }, REF,
      octokit as unknown as Parameters<typeof handleQualityGateStatus>[2]
    );

    expect(octokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".agentic-sdlc.yml", ref: "base-policy-sha" })
    );
    expect(structured.conclusion).toBe("pending");
    expect(structured.evidence.checks.missingRequiredContexts).toContain("policy-check");
    expect(structured.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(text).toContain("Policy Provenance");
  });

  it("does not let a commit status, wrong App, or skipped check satisfy a policy check", async () => {
    const policy = [
      "schemaVersion: 1",
      "requiredChecks: [{ name: policy-check, source: check_run, appId: 15368 }]",
    ].join("\n");
    const cases: CiEvidence[] = [
      ciEvidence({
        checkRuns: [signal("test", "passing", "check_run", 15368)],
        commitStatuses: [signal("policy-check", "passing", "commit_status")],
      }),
      ciEvidence({
        checkRuns: [
          signal("test", "passing", "check_run", 15368),
          signal("policy-check", "passing", "check_run", 999),
        ],
      }),
      ciEvidence({
        checkRuns: [
          signal("test", "passing", "check_run", 15368),
          signal("policy-check", "skipped", "check_run", 15368),
        ],
      }),
    ];

    for (const ci of cases) {
      evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
        pullRequestEvidence({ pullRequest: { baseSha: "base-policy-sha" }, ci })
      );
      const octokit = makeOctokit() as unknown as {
        repos: Record<string, unknown> & { getContent: ReturnType<typeof vi.fn> };
      };
      octokit.repos.getContent = vi.fn().mockResolvedValue({
        data: {
          type: "file", encoding: "base64",
          content: Buffer.from(policy).toString("base64"), sha: "policy-blob",
        },
      });

      const { structured } = await handleQualityGateStatus(
        { pullNumber: 42 }, REF,
        octokit as unknown as Parameters<typeof handleQualityGateStatus>[2]
      );
      expect(structured.conclusion).not.toBe("passing");
      expect(structured.blockers.join(" ")).toContain(
        "Required check policy-check is not passing from check_run App 15368"
      );
    }
  });

  it("accepts a policy check only from its configured check-run App", async () => {
    const policy =
      "schemaVersion: 1\nrequiredChecks: [{ name: policy-check, source: check_run, appId: 15368 }]\n";
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({
        pullRequest: { baseSha: "base-policy-sha" },
        ci: ciEvidence({
          checkRuns: [signal("policy-check", "passing", "check_run", 15368)],
        }),
      })
    );
    const octokit = makeOctokit() as unknown as {
      repos: Record<string, unknown> & { getContent: ReturnType<typeof vi.fn> };
    };
    octokit.repos.getContent = vi.fn().mockResolvedValue({
      data: {
        type: "file", encoding: "base64",
        content: Buffer.from(policy).toString("base64"), sha: "policy-blob",
      },
    });

    const { structured } = await handleQualityGateStatus(
      { pullNumber: 42 }, REF,
      octokit as unknown as Parameters<typeof handleQualityGateStatus>[2]
    );
    expect(structured.conclusion).toBe("passing");
  });

  it("keeps aggregate APPROVED passing but marks unverified REST reviews degraded", async () => {
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({
        reviews: {
          reviewDecision: "APPROVED",
          requiredApprovals: 2,
          approvedUsers: [],
        },
        degraded: true,
        unverifiedSignals: ["reviews"],
      })
    );

    const { structured } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.conclusion).toBe("passing");
    expect(structured.degraded).toBe(true);
    expect(structured.unverifiedSignals).toContain("reviews");
  });

  it("builds Markdown and structured output from the same conclusion", async () => {
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({ pullRequest: { mergeable: false } })
    );

    const { structured, text } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.conclusion).toBe("failing");
    expect(text).toContain("**Conclusion:** failing");
  });

  it("preserves legacy fields while exposing the complete evidence result", async () => {
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(pullRequestEvidence());

    const { structured } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.contextLabel).toBe("PR #42 (Real merge gate)");
    expect(structured.headSha).toBe("abc1234def5678");
    expect(structured.categories.passing).toHaveLength(1);
    expect(structured.totalChecks).toBe(1);
    expect(structured.evidence.checks.totalSignals).toBe(1);
    expect(structured.evidence.pullRequest?.mergeableState).toBe("clean");
    expect(structured).toEqual(
      expect.objectContaining({
        blockers: expect.any(Array),
        warnings: expect.any(Array),
        nextActions: expect.any(Array),
        degraded: false,
        unverifiedSignals: [],
        errors: [],
      })
    );
    expect(() => z.object(QualityGateOutputSchema).parse(structured)).not.toThrow();
  });

  it("exposes reviewer details in structured evidence, schema, and Markdown", async () => {
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({
        reviews: {
          reviewDecision: "CHANGES_REQUESTED",
          approvedUsers: ["Bob"],
          changesRequestedUsers: ["Eve"],
          requestedUsers: ["Carol"],
          requestedTeams: ["test-org/platform"],
        },
      })
    );

    const { structured, text } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.evidence.reviews).toEqual(
      expect.objectContaining({
        approved: 1,
        approvedUsers: ["Bob"],
        changesRequestedUsers: ["Eve"],
        requestedUsers: ["Carol"],
        requestedTeams: ["test-org/platform"],
      })
    );
    expect(() => z.object(QualityGateOutputSchema).parse(structured)).not.toThrow();
    expect(text).toContain("## Review Details");
    expect(text).toContain("Approved: Bob");
    expect(text).toContain("Changes requested: Eve");
    expect(text).toContain("Requested users: Carol");
    expect(text).toContain("Requested teams: test-org/platform");
  });

  it("keeps REST changes-requested failing in structured output and Markdown when aggregate is unavailable", async () => {
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({
        reviews: {
          reviewDecision: null,
          changesRequestedUsers: ["Eve"],
          requiredApprovals: null,
          requireCodeOwnerReviews: false,
        },
        branchProtection: {
          classicEnabled: false,
          rulesetRuleTypes: ["required_status_checks"],
          requiredStatusContexts: ["test"],
          requiredStatusChecks: [{ context: "test", appId: null }],
        },
        degraded: true,
        unverifiedSignals: ["review_decision"],
      })
    );

    const { structured, text } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.conclusion).toBe("failing");
    expect(structured.blockers.join(" ")).toContain("Eve");
    expect(structured.evidence.reviews?.changesRequestedUsers).toEqual(["Eve"]);
    expect(() => z.object(QualityGateOutputSchema).parse(structured)).not.toThrow();
    expect(text).toContain("**Conclusion:** failing");
    expect(text).toContain("Changes requested: Eve");
  });

  it("exposes PR evidence errors in the schema and sanitizes them in Markdown notes", async () => {
    const diagnostic = "branch_rules: permission denied\r\n## forged heading";
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({ errors: [diagnostic] })
    );

    const { structured, text } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.errors).toEqual([diagnostic]);
    expect(() => z.object(QualityGateOutputSchema).parse(structured)).not.toThrow();
    expect(text).toContain("## Notes");
    expect(text).toContain("branch\\_rules: permission denied \\#\\# forged heading");
    expect(text).not.toContain("\n## forged heading");
  });

  it("keeps structured external values raw while rendering bounded safe inline Markdown", async () => {
    const title = "Gate\r\n## forged [link](javascript:alert(1))" + "x".repeat(500);
    const reviewer = "Eve\n- injected";
    const checkName = "build\n## fake";
    evidenceMocks.collectPullRequestEvidence.mockResolvedValueOnce(
      pullRequestEvidence({
        pullRequest: { title },
        reviews: { approvedUsers: [reviewer] },
        ci: ciEvidence({ checkRuns: [signal(checkName, "failing")] }),
      })
    );

    const { structured, text } = await handleQualityGateStatus(
      { pullNumber: 42 },
      REF,
      makeOctokit()
    );

    expect(structured.contextLabel).toContain(title);
    expect(structured.evidence.reviews?.approvedUsers).toEqual([reviewer]);
    expect(structured.categories.failing[0]?.name).toBe(checkName);
    expect(text).not.toContain("\n## forged");
    expect(text).not.toContain("\n- injected");
    expect(text).toContain("\\[link\\]\\(javascript:alert\\(1\\)\\)");
    expect(text.length).toBeLessThan(5000);
  });

  it("exposes ref CI collection errors", async () => {
    evidenceMocks.collectCiEvidence.mockResolvedValueOnce(
      ciEvidence({
        checkRuns: [signal("test")],
        errors: ["commit_statuses: permission denied"],
      })
    );

    const { structured, text } = await handleQualityGateStatus(
      { ref: "main" },
      REF,
      makeOctokit()
    );

    expect(structured.errors).toEqual(["commit_statuses: permission denied"]);
    expect(text).toContain("## Notes");
  });

  it("requires either pullNumber or ref", async () => {
    const params: QualityGateInput = {};

    await expect(handleQualityGateStatus(params, REF, makeOctokit())).rejects.toThrow(
      /pullNumber or ref is required/
    );
  });
});

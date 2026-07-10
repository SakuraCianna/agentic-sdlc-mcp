import { describe, expect, it, vi } from "vitest";
import {
  collectCiEvidence,
  collectPullRequestEvidence,
} from "../../github/pull-request-evidence.js";
import type { RepoRef } from "../../types.js";

const ref: RepoRef = { owner: "acme", repo: "widgets" };

function apiError(status: number, message: string) {
  return { status, response: { data: { message, secret: "must-not-leak" } } };
}

function makeOctokit(overrides: Record<string, unknown> = {}) {
  const methods = {
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: [] } }),
    },
    repos: {
      getCombinedStatusForRef: vi.fn().mockResolvedValue({ data: { statuses: [] } }),
      getBranchProtection: vi.fn().mockRejectedValue(apiError(404, "Not Found")),
      getBranchRules: vi.fn().mockResolvedValue({ data: [] }),
      getContent: vi.fn().mockRejectedValue(apiError(404, "Not Found")),
    },
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          title: "Harden release gate",
          body: "Evidence first",
          user: { login: "Alice" },
          head: { sha: "abc123", ref: "feature/gate" },
          base: { ref: "main", sha: "base123" },
          draft: false,
          mergeable: true,
          labels: [{ name: "security" }],
        },
      }),
      listRequestedReviewers: vi.fn().mockResolvedValue({ data: { users: [], teams: [] } }),
      listReviews: vi.fn().mockResolvedValue({ data: [] }),
      listFiles: vi.fn().mockResolvedValue({ data: [] }),
    },
    graphql: vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewDecision: null,
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    }),
  };

  for (const [group, value] of Object.entries(overrides)) {
    if (group === "graphql") methods.graphql = value as typeof methods.graphql;
    else Object.assign(methods[group as keyof Omit<typeof methods, "graphql">], value);
  }
  return methods as unknown as Parameters<typeof collectPullRequestEvidence>[2];
}

describe("collectCiEvidence", () => {
  it("keeps check runs and commit statuses as two signals", async () => {
    const octokit = makeOctokit({
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: {
            check_runs: [
              {
                name: "test",
                status: "completed",
                conclusion: "success",
                html_url: "check",
                app: { id: 15368 },
              },
            ],
          },
        }),
      },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: { statuses: [{ context: "test", state: "success", target_url: "status" }] },
        }),
      },
    });

    const evidence = await collectCiEvidence(ref, "abc123", octokit);
    expect(evidence.totalSignals).toBe(2);
    expect(evidence.checkRuns.passing).toHaveLength(1);
    expect(evidence.checkRuns.passing[0]).toMatchObject({ appId: 15368 });
    expect(evidence.commitStatuses.passing).toHaveLength(1);
  });

  it("maps commit status error to failing", async () => {
    const octokit = makeOctokit({
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: { statuses: [{ context: "deploy", state: "error", target_url: null }] },
        }),
      },
    });
    const evidence = await collectCiEvidence(ref, "abc123", octokit);
    expect(evidence.commitStatuses.failing[0]).toMatchObject({
      name: "deploy",
      state: "failing",
      rawState: "error",
    });
    expect(evidence.hasFailing).toBe(true);
  });

  it("distinguishes zero signals from pending", async () => {
    const evidence = await collectCiEvidence(ref, "abc123", makeOctokit());
    expect(evidence.totalSignals).toBe(0);
    expect(evidence.hasPending).toBe(false);
    expect(evidence.checkRuns.pending).toEqual([]);
  });

  it("preserves commit statuses when check runs are forbidden", async () => {
    const octokit = makeOctokit({
      checks: { listForRef: vi.fn().mockRejectedValue(apiError(403, "checks denied")) },
      repos: {
        getCombinedStatusForRef: vi.fn().mockResolvedValue({
          data: { statuses: [{ context: "legacy", state: "pending", target_url: null }] },
        }),
      },
    });
    const evidence = await collectCiEvidence(ref, "abc123", octokit);
    expect(evidence.commitStatuses.pending).toHaveLength(1);
    expect(evidence.errors[0]).toMatch(/^check_runs: GitHub permission denied/);
    expect(evidence.errors.join(" ")).not.toContain("must-not-leak");
  });

  it("treats exactly 300 check runs plus an empty probe page as complete", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      name: `check-${index}`,
      status: "completed",
      conclusion: "success",
      html_url: null,
    }));
    const listForRef = vi.fn().mockImplementation(({ page: pageNumber }: { page: number }) =>
      Promise.resolve({ data: { check_runs: pageNumber <= 3 ? page : [] } })
    );
    const octokit = makeOctokit({ checks: { listForRef } });
    const evidence = await collectCiEvidence(ref, "abc123", octokit);
    expect(evidence.totalSignals).toBe(300);
    expect(evidence.unverifiedSignals).not.toContain("check_runs");
    expect(listForRef).toHaveBeenCalledTimes(4);
    expect(listForRef.mock.calls.map(([params]) => params.page)).toEqual([1, 2, 3, 4]);
  });

  it("keeps 300 check runs but marks the source truncated when a 301st exists", async () => {
    const passingPage = Array.from({ length: 100 }, (_, index) => ({
      name: `check-${index}`,
      status: "completed",
      conclusion: "success",
      html_url: null,
    }));
    const listForRef = vi.fn().mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        data: {
          check_runs:
            page <= 3
              ? passingPage
              : [{ name: "hidden-failure", status: "completed", conclusion: "failure" }],
        },
      })
    );
    const evidence = await collectCiEvidence(
      ref,
      "abc123",
      makeOctokit({ checks: { listForRef } })
    );
    expect(evidence.totalSignals).toBe(300);
    expect(evidence.hasFailing).toBe(false);
    expect(evidence.unverifiedSignals).toContain("check_runs");
    expect(evidence.errors).toContain("check_runs: results truncated at 300 items");
  });

  it("paginates commit statuses and marks a 301st status as truncated", async () => {
    const passingPage = Array.from({ length: 100 }, (_, index) => ({
      context: `status-${index}`,
      state: "success",
      target_url: null,
    }));
    const getCombinedStatusForRef = vi.fn().mockImplementation(
      ({ page }: { page: number }) =>
        Promise.resolve({
          data: {
            statuses:
              page <= 3
                ? passingPage
                : [{ context: "hidden-error", state: "error", target_url: null }],
          },
        })
    );
    const evidence = await collectCiEvidence(
      ref,
      "abc123",
      makeOctokit({ repos: { getCombinedStatusForRef } })
    );
    expect(evidence.commitStatuses.total).toBe(300);
    expect(evidence.unverifiedSignals).toContain("commit_statuses");
    expect(evidence.errors).toContain("commit_statuses: results truncated at 300 items");
    expect(getCombinedStatusForRef).toHaveBeenCalledTimes(4);
  });
});

describe("collectPullRequestEvidence", () => {
  it("collects core PR metadata", async () => {
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, makeOctokit());
    expect(evidence.pullRequest).toEqual({
      number: 42,
      title: "Harden release gate",
      body: "Evidence first",
      author: "Alice",
      headSha: "abc123",
      headRef: "feature/gate",
      baseBranch: "main",
      draft: false,
      mergeable: true,
      labels: ["security"],
    });
  });

  it("uses each reviewer's latest actionable state and lets DISMISSED clear it", async () => {
    const octokit = makeOctokit({
      pulls: {
        listReviews: vi.fn().mockResolvedValue({
          data: [
            { id: 1, user: { login: "Alice" }, state: "APPROVED", submitted_at: "2026-01-01" },
            { id: 2, user: { login: "Bob" }, state: "CHANGES_REQUESTED", submitted_at: "2026-01-02" },
            { id: 3, user: { login: "alice" }, state: "COMMENTED", submitted_at: "2026-01-03" },
            { id: 4, user: { login: "ALICE" }, state: "DISMISSED", submitted_at: "2026-01-04" },
            { id: 5, user: { login: "Bob" }, state: "APPROVED", submitted_at: "2026-01-05" },
          ],
        }),
      },
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.approvedUsers).toEqual(["Bob"]);
    expect(evidence.reviews.changesRequestedUsers).toEqual([]);
  });

  it("collects typed GraphQL review decision and linked issues", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "APPROVED",
            closingIssuesReferences: {
              nodes: [{ number: 7, title: "Ship gate", url: "https://example.test/issues/7" }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      }),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.reviewDecision).toBe("APPROVED");
    expect(evidence.linkedIssues).toEqual([
      { number: 7, title: "Ship gate", url: "https://example.test/issues/7" },
    ]);
  });

  it("does not claim zero linked issues when GraphQL fails", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockRejectedValue(apiError(403, "graphql denied")),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.linkedIssues).toBeNull();
    expect(evidence.unverifiedSignals).toContain("linked_issues");
    expect(evidence.unverifiedSignals).toContain("review_decision");
    expect(evidence.degraded).toBe(true);
  });

  it("marks linked issues truncated when GraphQL reports another page", async () => {
    const octokit = makeOctokit({
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "APPROVED",
            closingIssuesReferences: {
              nodes: [{ number: 7, title: "Ship gate", url: "https://example.test/issues/7" }],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      }),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.linkedIssues).toEqual([
      { number: 7, title: "Ship gate", url: "https://example.test/issues/7" },
    ]);
    expect(evidence.unverifiedSignals).toContain("linked_issues");
    expect(evidence.errors).toContain("linked_issues: results truncated at 20 items");
    expect(evidence.degraded).toBe(true);
  });

  it("collects classic protection and applied rule types", async () => {
    const octokit = makeOctokit({
      repos: {
        getBranchProtection: vi.fn().mockResolvedValue({
          data: {
            required_pull_request_reviews: {
              dismiss_stale_reviews: true,
              required_approving_review_count: 2,
              require_code_owner_reviews: true,
              require_last_push_approval: true,
            },
            required_conversation_resolution: { enabled: true },
            required_signatures: { enabled: true },
            required_linear_history: { enabled: true },
            lock_branch: { enabled: true },
            allow_force_pushes: { enabled: true },
            allow_deletions: { enabled: true },
            block_creations: { enabled: true },
            allow_fork_syncing: { enabled: true },
            required_status_checks: {
              strict: true,
              contexts: ["test", "lint", "legacy"],
              checks: [
                { context: "test", app_id: 15368 },
                { context: "lint", app_id: null },
              ],
            },
          },
        }),
        getBranchRules: vi.fn().mockResolvedValue({
          data: [
            {
              type: "pull_request",
              parameters: {
                allowed_merge_methods: ["merge"],
                dismiss_stale_reviews_on_push: true,
                require_code_owner_review: false,
                require_last_push_approval: true,
                required_approving_review_count: 1,
                required_review_thread_resolution: true,
                required_reviewers: [
                  {
                    file_patterns: ["src/**"],
                    minimum_approvals: 1,
                    reviewer: { id: 7, type: "Team" },
                  },
                ],
              },
            },
            {
              type: "required_status_checks",
              parameters: {
                required_status_checks: [
                  { context: "build", integration_id: 4242 },
                  { context: "portable" },
                ],
                strict_required_status_checks_policy: true,
              },
            },
          ],
        }),
      },
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.branchProtection).toEqual({
      classicEnabled: true,
      rulesetRuleTypes: ["pull_request", "required_status_checks"],
      requiredStatusContexts: ["test", "lint", "legacy", "build", "portable"],
      requiredStatusChecks: [
        { context: "test", appId: 15368 },
        { context: "lint", appId: null },
        { context: "legacy", appId: null },
        { context: "build", appId: 4242 },
        { context: "portable", appId: null },
      ],
      pullRequestRuleRequirements: {
        allowedMergeMethods: ["merge"],
        dismissStaleReviews: true,
        lockBranch: true,
        requiredConversationResolution: true,
        requireLastPushApproval: true,
        requiredLinearHistory: true,
        requiredReviewThreadResolution: true,
        requiredReviewersConfigured: true,
        requiredSignatures: true,
        strictRequiredStatusChecksPolicy: true,
      },
    });
    expect(evidence.reviews.requiredApprovals).toBe(2);
    expect(evidence.reviews.requireCodeOwnerReviews).toBe(true);
  });

  it.each([
    { name: "classic review freshness", classic: true, ruleset: false, expected: true },
    { name: "ruleset review freshness", classic: false, ruleset: true, expected: true },
    { name: "disabled review freshness", classic: false, ruleset: false, expected: false },
  ])("collects $name independently", async ({ classic, ruleset, expected }) => {
    const evidence = await collectPullRequestEvidence(
      { pullNumber: 42 },
      ref,
      makeOctokit({
        repos: {
          getBranchProtection: vi.fn().mockResolvedValue({
            data: {
              required_pull_request_reviews: {
                dismiss_stale_reviews: classic,
                require_code_owner_reviews: false,
                require_last_push_approval: classic,
                required_approving_review_count: 0,
              },
            },
          }),
          getBranchRules: vi.fn().mockResolvedValue({
            data: [
              {
                type: "pull_request",
                parameters: {
                  dismiss_stale_reviews_on_push: ruleset,
                  require_code_owner_review: false,
                  require_last_push_approval: ruleset,
                  required_approving_review_count: 0,
                  required_review_thread_resolution: false,
                },
              },
            ],
          }),
        },
      })
    );

    expect(evidence.branchProtection.pullRequestRuleRequirements).toMatchObject({
      dismissStaleReviews: expected,
      requireLastPushApproval: expected,
    });
  });

  it.each([
    {
      name: "classic strict protection",
      protection: {
        required_status_checks: {
          strict: true,
          contexts: ["build"],
          checks: [{ context: "build", app_id: null }],
        },
      },
      rules: [],
      expected: true,
    },
    {
      name: "ruleset strict protection",
      protection: {
        required_status_checks: {
          strict: false,
          contexts: ["build"],
          checks: [{ context: "build", app_id: null }],
        },
      },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "build" }],
            strict_required_status_checks_policy: true,
          },
        },
      ],
      expected: true,
    },
    {
      name: "non-strict protection",
      protection: {
        required_status_checks: {
          strict: false,
          contexts: ["build"],
          checks: [{ context: "build", app_id: null }],
        },
      },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [{ context: "build" }],
            strict_required_status_checks_policy: false,
          },
        },
      ],
      expected: false,
    },
  ])("collects $name independently", async ({ protection, rules, expected }) => {
    const evidence = await collectPullRequestEvidence(
      { pullNumber: 42 },
      ref,
      makeOctokit({
        repos: {
          getBranchProtection: vi.fn().mockResolvedValue({ data: protection }),
          getBranchRules: vi.fn().mockResolvedValue({ data: rules }),
        },
      })
    );

    expect(
      evidence.branchProtection.pullRequestRuleRequirements
        .strictRequiredStatusChecksPolicy
    ).toBe(expected);
  });

  it("keeps 300 applied rules but marks branch rules truncated when a 301st exists", async () => {
    const visibleRules = Array.from({ length: 100 }, (_, index) => ({
      type: `visible-rule-${index}`,
    }));
    const getBranchRules = vi.fn().mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({
        data: page <= 3 ? visibleRules : [{ type: "hidden-rule" }],
      })
    );
    const evidence = await collectPullRequestEvidence(
      { pullNumber: 42 },
      ref,
      makeOctokit({ repos: { getBranchRules } })
    );

    expect(evidence.branchProtection.rulesetRuleTypes).toHaveLength(300);
    expect(evidence.branchProtection.rulesetRuleTypes).not.toContain("hidden-rule");
    expect(evidence.unverifiedSignals).toContain("branch_rules");
    expect(evidence.errors).toContain("branch_rules: results truncated at 300 items");
    expect(evidence.degraded).toBe(true);
    expect(getBranchRules).toHaveBeenCalledTimes(4);
  });

  it("degrades protection independently while preserving CI", async () => {
    const octokit = makeOctokit({
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] },
        }),
      },
      repos: { getBranchProtection: vi.fn().mockRejectedValue(apiError(403, "admin denied")) },
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.ci.checkRuns.passing).toHaveLength(1);
    expect(evidence.unverifiedSignals).toContain("branch_protection");
    expect(evidence.errors.some((error) => error.startsWith("branch_protection:"))).toBe(true);
  });

  it("treats classic protection 404 as verified and not configured", async () => {
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, makeOctokit());
    expect(evidence.branchProtection.classicEnabled).toBe(false);
    expect(evidence.unverifiedSignals).not.toContain("branch_protection");
    expect(evidence.errors.some((error) => error.startsWith("branch_protection:"))).toBe(false);
  });

  it("finds CODEOWNERS routing gaps from changed files", async () => {
    const octokit = makeOctokit({
      repos: {
        getContent: vi.fn().mockImplementation(({ path, ref: gitRef }: { path: string; ref?: string }) =>
          path === ".github/CODEOWNERS" && gitRef === "base123"
            ? Promise.resolve({
                data: {
                  type: "file",
                  content: Buffer.from("/src/ @Platform\n").toString("base64"),
                },
              })
            : path === ".github/CODEOWNERS"
              ? Promise.resolve({
                  data: {
                    type: "file",
                    content: Buffer.from("/src/ @DefaultBranchOwner\n").toString("base64"),
                  },
                })
              : Promise.reject(apiError(404, "Not Found"))
        ),
      },
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: [{ filename: "src/gate.ts" }] }),
        listRequestedReviewers: vi.fn().mockResolvedValue({
          data: { users: [{ login: "SomeoneElse" }], teams: [] },
        }),
      },
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.ownershipGaps).toEqual([
      { owner: "@Platform", paths: ["src/gate.ts"] },
    ]);
    expect(octokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".github/CODEOWNERS", ref: "base123" })
    );
  });

  it("does not report a routing gap for a CODEOWNER who participated via comment", async () => {
    const octokit = makeOctokit({
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: "file",
            content: Buffer.from("/src/ @Platform\n").toString("base64"),
          },
        }),
      },
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: [{ filename: "src/gate.ts" }] }),
        listReviews: vi.fn().mockResolvedValue({
          data: [{ id: 1, user: { login: "Platform" }, state: "COMMENTED" }],
        }),
      },
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.ownershipGaps).toEqual([]);
    expect(evidence.reviews.approvedUsers).toEqual([]);
  });

  it("keeps routing satisfied separate from a required CODEOWNER approval", async () => {
    const octokit = makeOctokit({
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: "file",
            content: Buffer.from("/src/ @Platform\n").toString("base64"),
          },
        }),
        getBranchProtection: vi.fn().mockResolvedValue({
          data: {
            required_pull_request_reviews: {
              required_approving_review_count: 1,
              require_code_owner_reviews: true,
            },
          },
        }),
      },
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: [{ filename: "src/gate.ts" }] }),
        listRequestedReviewers: vi.fn().mockResolvedValue({
          data: { users: [{ login: "Platform" }], teams: [] },
        }),
        listReviews: vi.fn().mockResolvedValue({
          data: [
            { id: 1, user: { login: "Platform" }, state: "COMMENTED" },
            { id: 2, user: { login: "Bob" }, state: "APPROVED" },
          ],
        }),
      },
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "REVIEW_REQUIRED",
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.ownershipGaps).toEqual([]);
    expect(evidence.reviews.approvedUsers).toEqual(["Bob"]);
    expect(evidence.reviews.codeOwnerReviewSatisfied).toBeNull();
    expect(evidence.unverifiedSignals).toContain("code_owner_review");
  });

  it("does not infer CODEOWNER satisfaction when overall required approvals are incomplete", async () => {
    const octokit = makeOctokit({
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: {
            type: "file",
            content: Buffer.from("/src/ @Platform\n").toString("base64"),
          },
        }),
        getBranchProtection: vi.fn().mockResolvedValue({
          data: {
            required_pull_request_reviews: {
              required_approving_review_count: 2,
              require_code_owner_reviews: true,
            },
          },
        }),
      },
      pulls: {
        listFiles: vi.fn().mockResolvedValue({ data: [{ filename: "src/gate.ts" }] }),
        listReviews: vi.fn().mockResolvedValue({
          data: [{ id: 1, user: { login: "Platform" }, state: "APPROVED" }],
        }),
      },
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "REVIEW_REQUIRED",
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.approvedUsers).toEqual(["Platform"]);
    expect(evidence.reviews.ownershipGaps).toEqual([]);
    expect(evidence.reviews.codeOwnerReviewSatisfied).toBeNull();
    expect(evidence.unverifiedSignals).toContain("code_owner_review");
  });

  it("marks a required CODEOWNER review satisfied from aggregate APPROVED decision", async () => {
    const octokit = makeOctokit({
      repos: {
        getBranchProtection: vi.fn().mockResolvedValue({
          data: {
            required_pull_request_reviews: {
              required_approving_review_count: 1,
              require_code_owner_reviews: true,
            },
          },
        }),
      },
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "APPROVED",
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.codeOwnerReviewSatisfied).toBe(true);
    expect(evidence.unverifiedSignals).not.toContain("code_owner_review");
  });

  it("does not attribute aggregate CHANGES_REQUESTED to a CODEOWNER", async () => {
    const octokit = makeOctokit({
      repos: {
        getBranchProtection: vi.fn().mockResolvedValue({
          data: {
            required_pull_request_reviews: {
              required_approving_review_count: 1,
              require_code_owner_reviews: true,
            },
          },
        }),
      },
      graphql: vi.fn().mockResolvedValue({
        repository: {
          pullRequest: {
            reviewDecision: "CHANGES_REQUESTED",
            closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.codeOwnerReviewSatisfied).toBeNull();
    expect(evidence.unverifiedSignals).toContain("code_owner_review");
  });

  it("marks required CODEOWNER satisfaction unverified when GraphQL fails", async () => {
    const octokit = makeOctokit({
      repos: {
        getBranchProtection: vi.fn().mockResolvedValue({
          data: {
            required_pull_request_reviews: {
              required_approving_review_count: 1,
              require_code_owner_reviews: true,
            },
          },
        }),
      },
      graphql: vi.fn().mockRejectedValue(apiError(403, "graphql denied")),
    });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.reviews.codeOwnerReviewSatisfied).toBeNull();
    expect(evidence.unverifiedSignals).toContain("code_owner_review");
    expect(evidence.errors.filter((error) => error.startsWith("graphql:"))).toHaveLength(1);
  });

  it("marks paginated REST reviews and changed files truncated at 300", async () => {
    const reviewsPage = Array.from({ length: 100 }, (_, id) => ({
      id,
      user: { login: `reviewer-${id}` },
      state: "COMMENTED",
    }));
    const filesPage = Array.from({ length: 100 }, (_, id) => ({ filename: `src/${id}.ts` }));
    const listReviews = vi.fn().mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({ data: page <= 3 ? reviewsPage : [reviewsPage[0]] })
    );
    const listFiles = vi.fn().mockImplementation(({ page }: { page: number }) =>
      Promise.resolve({ data: page <= 3 ? filesPage : [filesPage[0]] })
    );
    const octokit = makeOctokit({ pulls: { listReviews, listFiles } });
    const evidence = await collectPullRequestEvidence({ pullNumber: 42 }, ref, octokit);
    expect(evidence.unverifiedSignals).toEqual(
      expect.arrayContaining(["reviews", "changed_files"])
    );
    expect(evidence.errors).toEqual(
      expect.arrayContaining([
        "reviews: results truncated at 300 items",
        "changed_files: results truncated at 300 items",
      ])
    );
    expect(evidence.degraded).toBe(true);
    expect(listReviews).toHaveBeenCalledTimes(4);
    expect(listFiles).toHaveBeenCalledTimes(4);
  });
});

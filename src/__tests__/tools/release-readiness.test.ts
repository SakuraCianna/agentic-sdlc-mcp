/**
 * Tests for src/tools/release-readiness.ts
 * Covers: handleReleaseReadiness blocking vs ready judgement
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({
  config: {
    githubToken: "test-token",
    githubOwner: "default-owner",
    githubRepo: "default-repo",
    defaultBranch: "main",
    isSmokeMode: false,
  },
  isSmokeMode: false,
}));

const { handleReleaseReadiness } = await import("../../tools/release-readiness.js");

import type { ReleaseReadinessInput } from "../../tools/release-readiness.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeMockOctokit(opts: {
  checks?: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses?: Array<{ context: string; state: string; target_url: string | null }>;
  checkPages?: Array<Array<{ name: string; status: string; conclusion: string | null }>>;
  statusPages?: Array<Array<{ context: string; state: string; target_url: string | null }>>;
  checksError?: unknown;
  statusesError?: unknown;
  refError?: unknown;
  bugIssues?: Array<{ number: number; title: string; html_url: string }>;
  hasChangelog?: boolean;
} = {}) {
  const checks = opts.checks ?? [{ name: "CI", status: "completed", conclusion: "success" }];
  const statuses = opts.statuses ?? [];
  const bugs = opts.bugIssues ?? [];

  return {
    repos: {
      get: vi.fn().mockResolvedValue({
        data: { default_branch: "main", language: "TypeScript" },
      }),
      getContent: opts.hasChangelog
        ? vi.fn().mockResolvedValue({ data: {} })
        : vi.fn().mockRejectedValue({ status: 404 }),
      getCombinedStatusForRef: opts.statusesError
        ? vi.fn().mockRejectedValue(opts.statusesError)
        : vi.fn().mockImplementation(({ page = 1 }: { page?: number }) =>
            Promise.resolve({
              data: { statuses: opts.statusPages ? (opts.statusPages[page - 1] ?? []) : statuses },
            })
          ),
    },
    git: {
      getRef: opts.refError
        ? vi.fn().mockRejectedValue(opts.refError)
        : vi.fn().mockResolvedValue({
            data: { object: { sha: "abc123456" } },
          }),
    },
    checks: {
      listForRef: opts.checksError
        ? vi.fn().mockRejectedValue(opts.checksError)
        : vi.fn().mockImplementation(({ page = 1 }: { page?: number }) =>
            Promise.resolve({
              data: { check_runs: opts.checkPages ? (opts.checkPages[page - 1] ?? []) : checks },
            })
          ),
    },
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: bugs }),
    },
  } as unknown as Parameters<typeof handleReleaseReadiness>[2];
}

describe("handleReleaseReadiness", () => {
  it("reports isReady=true when CI passes and no open bugs", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "CI", status: "completed", conclusion: "success" }],
      bugIssues: [],
      hasChangelog: true,
    });

    const params: ReleaseReadinessInput = { headRef: "main" };
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.isReady).toBe(true);
    expect(structured.ciStatus).toBe("passing");
    expect(structured.blockingIssues).toHaveLength(0);
    expect(structured.openBugCount).toBe(0);
    expect(structured.hasChangelog).toBe(true);
  });

  it("reports isReady=false when CI is failing", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "Tests", status: "completed", conclusion: "failure" }],
      bugIssues: [],
    });

    const params: ReleaseReadinessInput = { headRef: "main" };
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.isReady).toBe(false);
    expect(structured.ciStatus).toBe("failing");
    expect(structured.blockingIssues.some((b) => b.includes("CI checks are failing"))).toBe(true);
  });

  it("reports isReady=false when there are open bug issues", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "CI", status: "completed", conclusion: "success" }],
      bugIssues: [
        { number: 5, title: "Critical login bug", html_url: "https://github.com/t/r/issues/5" },
      ],
    });

    const params: ReleaseReadinessInput = { headRef: "main" };
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.isReady).toBe(false);
    expect(structured.openBugCount).toBe(1);
    expect(structured.blockingIssues.length).toBeGreaterThan(0);
  });

  it("reports isReady=false when both CI fails AND bugs exist", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "Tests", status: "completed", conclusion: "failure" }],
      bugIssues: [
        { number: 1, title: "Bug", html_url: "https://github.com/t/r/issues/1" },
      ],
    });

    const params: ReleaseReadinessInput = { headRef: "main" };
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.isReady).toBe(false);
    expect(structured.blockingIssues.length).toBeGreaterThanOrEqual(2);
  });

  it("includes rollback template in text output", async () => {
    const octokit = makeMockOctokit({ hasChangelog: false });
    const params: ReleaseReadinessInput = { headRef: "main" };
    const { text } = await handleReleaseReadiness(params, REF, octokit);

    expect(text).toContain("Rollback");
    expect(text).toContain("Release Checklist");
  });

  it("reports a specific permission hint when CI status fetch fails", async () => {
    const octokit = makeMockOctokit({
      checksError: {
        status: 403,
        response: { data: { message: "Resource not accessible" } },
      },
    });

    const params: ReleaseReadinessInput = { headRef: "main" };
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.ciStatus).toBe("unknown");
    expect(structured.ciSummary).toContain("check runs unavailable or incomplete");
    expect(structured.ciSummary).toContain("repo");
  });

  it("reports pending CI status correctly", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "Build", status: "in_progress", conclusion: null }],
    });

    const params: ReleaseReadinessInput = {};
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.ciStatus).toBe("pending");
    expect(structured.isReady).toBe(false);
    expect(structured.openBugCount).toBe(0);
  });

  it("does not report zero CI signals as passing", async () => {
    const octokit = makeMockOctokit({ checks: [], statuses: [] });

    const { structured } = await handleReleaseReadiness({ headRef: "main" }, REF, octokit);

    expect(structured.ciStatus).toBe("unknown");
    expect(structured.isReady).toBe(false);
  });

  it("accepts status-only passing CI evidence", async () => {
    const octokit = makeMockOctokit({
      checks: [],
      statuses: [{ context: "legacy-ci", state: "success", target_url: null }],
    });

    const { structured } = await handleReleaseReadiness({ headRef: "main" }, REF, octokit);

    expect(structured.ciStatus).toBe("passing");
    expect(structured.isReady).toBe(true);
    expect(octokit.repos.getCombinedStatusForRef).toHaveBeenCalled();
    expect(structured.ciSummary).toContain("1 CI signal");
  });

  it("prioritizes failing over pending across CI sources", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "still-running", status: "in_progress", conclusion: null }],
      statuses: [{ context: "legacy-ci", state: "failure", target_url: null }],
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("failing");
    expect(structured.isReady).toBe(false);
  });

  it.each(["failure", "pending"])(
    "maps status-only %s evidence without check runs",
    async (state) => {
      const octokit = makeMockOctokit({
        checks: [],
        statuses: [{ context: "legacy-ci", state, target_url: null }],
      });

      const { structured } = await handleReleaseReadiness({}, REF, octokit);

      expect(structured.ciStatus).toBe(state === "failure" ? "failing" : "pending");
      expect(structured.isReady).toBe(false);
    }
  );

  it("reports unknown when both CI sources are unavailable", async () => {
    const octokit = makeMockOctokit({
      checksError: { status: 403, response: { data: { message: "checks denied" } } },
      statusesError: { status: 403, response: { data: { message: "statuses denied" } } },
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("unknown");
    expect(structured.isReady).toBe(false);
  });

  it("accepts verified passing statuses when check runs are unavailable", async () => {
    const octokit = makeMockOctokit({
      checksError: { status: 403, response: { data: { message: "checks denied" } } },
      statuses: [{ context: "legacy-ci", state: "success", target_url: null }],
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("passing");
    expect(structured.isReady).toBe(true);
  });

  it("does not echo externally controlled CI names or raw error details", async () => {
    const injectedName = "build\r\n## forged `heading` token_live_sensitive";
    const octokit = makeMockOctokit({
      checks: [{ name: injectedName, status: "completed", conclusion: "failure" }],
      statusesError: {
        status: 403,
        response: { data: { message: "token_live_sensitive\r\n## leaked" } },
      },
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("failing");
    expect(structured.ciSummary).not.toContain("forged");
    expect(structured.ciSummary).not.toContain("token_live_sensitive");
    expect(structured.ciSummary).not.toContain("##");
  });

  it("does not echo raw errors while resolving the release head", async () => {
    const octokit = makeMockOctokit({
      refError: {
        status: 403,
        response: { data: { message: "token_live_sensitive\r\n## forged heading" } },
      },
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("unknown");
    expect(structured.isReady).toBe(false);
    expect(structured.ciSummary).toContain("Could not resolve the release head or collect CI evidence");
    expect(structured.ciSummary).not.toContain("token_live_sensitive");
    expect(structured.ciSummary).not.toContain("forged");
    expect(structured.ciSummary).not.toContain("##");
  });

  it("keeps passing when one truncated source is backed by another verified source", async () => {
    const checkPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        name: `check-${page}-${index}`,
        status: "completed",
        conclusion: "success",
      }));
    const octokit = makeMockOctokit({
      checkPages: [checkPage(1), checkPage(2), checkPage(3), [checkPage(4)[0]]],
      statuses: [],
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("passing");
    expect(structured.isReady).toBe(true);
    expect(structured.ciSummary).toContain("check runs unavailable or incomplete");
  });

  it("reports unknown when both CI sources are truncated after 300 signals", async () => {
    const checkPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        name: `check-${page}-${index}`,
        status: "completed",
        conclusion: "success",
      }));
    const statusPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        context: `status-${page}-${index}`,
        state: "success",
        target_url: null,
      }));
    const octokit = makeMockOctokit({
      checkPages: [checkPage(1), checkPage(2), checkPage(3), [checkPage(4)[0]]],
      statusPages: [statusPage(1), statusPage(2), statusPage(3), [statusPage(4)[0]]],
    });

    const { structured } = await handleReleaseReadiness({}, REF, octokit);

    expect(structured.ciStatus).toBe("unknown");
    expect(structured.isReady).toBe(false);
    expect(structured.ciSummary).toContain("both CI sources are unverified");
  });
});

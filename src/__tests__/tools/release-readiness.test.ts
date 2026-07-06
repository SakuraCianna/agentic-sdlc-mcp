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
  bugIssues?: Array<{ number: number; title: string; html_url: string }>;
  hasChangelog?: boolean;
} = {}) {
  const checks = opts.checks ?? [{ name: "CI", status: "completed", conclusion: "success" }];
  const bugs = opts.bugIssues ?? [];

  return {
    repos: {
      get: vi.fn().mockResolvedValue({
        data: { default_branch: "main", language: "TypeScript" },
      }),
      getContent: opts.hasChangelog
        ? vi.fn().mockResolvedValue({ data: {} })
        : vi.fn().mockRejectedValue({ status: 404 }),
    },
    git: {
      getRef: vi.fn().mockResolvedValue({
        data: { object: { sha: "abc123456" } },
      }),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: checks } }),
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
    const octokit = makeMockOctokit();
    (octokit.checks.listForRef as unknown as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 403,
      response: { data: { message: "Resource not accessible" } },
    });

    const params: ReleaseReadinessInput = { headRef: "main" };
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    expect(structured.ciStatus).toBe("unknown");
    expect(structured.ciSummary).toContain("permission denied");
    expect(structured.ciSummary).toContain("repo");
  });

  it("reports pending CI status correctly", async () => {
    const octokit = makeMockOctokit({
      checks: [{ name: "Build", status: "in_progress", conclusion: null }],
    });

    const params: ReleaseReadinessInput = {};
    const { structured } = await handleReleaseReadiness(params, REF, octokit);

    // Pending CI is reported but does NOT block release (only failing CI + open bugs block)
    expect(structured.ciStatus).toBe("pending");
    expect(structured.openBugCount).toBe(0);
  });
});

/**
 * Tests for src/tools/quality-gate-status.ts
 * Covers: categorizeChecks, handleQualityGateStatus output conclusions
 */

import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock config BEFORE any tool import to prevent process.exit(1)
// ---------------------------------------------------------------------------
vi.mock("../../config.js", () => ({
  config: {
    githubToken: "test-token",
    githubOwner: "default-owner",
    githubRepo: "default-repo",
    defaultBranch: "main",
  },
}));

const {
  categorizeChecks,
  handleQualityGateStatus,
} = await import("../../tools/quality-gate-status.js");

import type { QualityGateInput } from "../../tools/quality-gate-status.js";
import type { RepoRef } from "../../types.js";

// ---------------------------------------------------------------------------
// categorizeChecks (pure helper)
// ---------------------------------------------------------------------------

describe("categorizeChecks", () => {
  it("puts successful runs in passing bucket", () => {
    const runs = [
      { name: "CI", status: "completed", conclusion: "success", html_url: null },
      { name: "Lint", status: "completed", conclusion: "success", html_url: null },
    ];
    const cats = categorizeChecks(runs);
    expect(cats.passing).toHaveLength(2);
    expect(cats.failing).toHaveLength(0);
    expect(cats.pending).toHaveLength(0);
  });

  it("puts failed runs in failing bucket", () => {
    const runs = [
      { name: "Tests", status: "completed", conclusion: "failure", html_url: "https://example.com" },
      { name: "CI", status: "completed", conclusion: "success", html_url: null },
    ];
    const cats = categorizeChecks(runs);
    expect(cats.failing).toHaveLength(1);
    expect(cats.failing[0].name).toBe("Tests");
    expect(cats.passing).toHaveLength(1);
  });

  it("puts timed_out runs in failing bucket", () => {
    const runs = [
      { name: "Deploy Check", status: "completed", conclusion: "timed_out", html_url: null },
    ];
    const cats = categorizeChecks(runs);
    expect(cats.failing).toHaveLength(1);
  });

  it("puts in_progress runs in pending bucket", () => {
    const runs = [
      { name: "Build", status: "in_progress", conclusion: null, html_url: null },
      { name: "Tests", status: "queued", conclusion: null, html_url: null },
    ];
    const cats = categorizeChecks(runs);
    expect(cats.pending).toHaveLength(2);
    expect(cats.failing).toHaveLength(0);
  });

  it("puts skipped/neutral runs in skipped bucket", () => {
    const runs = [
      { name: "Opt Deploy", status: "completed", conclusion: "skipped", html_url: null },
      { name: "Notify", status: "completed", conclusion: "neutral", html_url: null },
    ];
    const cats = categorizeChecks(runs);
    expect(cats.skipped).toHaveLength(2);
  });

  it("handles empty input gracefully", () => {
    const cats = categorizeChecks([]);
    expect(cats.passing).toHaveLength(0);
    expect(cats.failing).toHaveLength(0);
    expect(cats.pending).toHaveLength(0);
    expect(cats.skipped).toHaveLength(0);
  });

  it("handles mixed statuses correctly", () => {
    const runs = [
      { name: "A", status: "completed", conclusion: "success", html_url: null },
      { name: "B", status: "completed", conclusion: "failure", html_url: null },
      { name: "C", status: "in_progress", conclusion: null, html_url: null },
      { name: "D", status: "completed", conclusion: "skipped", html_url: null },
    ];
    const cats = categorizeChecks(runs);
    expect(cats.passing).toHaveLength(1);
    expect(cats.failing).toHaveLength(1);
    expect(cats.pending).toHaveLength(1);
    expect(cats.skipped).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleQualityGateStatus — integration with mock octokit
// ---------------------------------------------------------------------------

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeMockOctokit(checkRuns: Array<{
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
}>) {
  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: { head: { sha: "abc1234def5678" }, title: "Test PR" },
      }),
    },
    checks: {
      listForRef: vi.fn().mockResolvedValue({ data: { check_runs: checkRuns } }),
    },
  } as unknown as Parameters<typeof handleQualityGateStatus>[2];
}

describe("handleQualityGateStatus", () => {
  it("reports 'passing' conclusion when all checks succeed", async () => {
    const octokit = makeMockOctokit([
      { name: "CI", status: "completed", conclusion: "success" },
      { name: "Lint", status: "completed", conclusion: "success" },
    ]);

    const params: QualityGateInput = { pullNumber: 42 };
    const { structured, text } = await handleQualityGateStatus(params, REF, octokit);

    expect(structured.conclusion).toBe("passing");
    expect(text).toContain("[PASS] All checks passed");
    expect(structured.categories.passing).toHaveLength(2);
    expect(structured.categories.failing).toHaveLength(0);
  });

  it("reports 'failing' conclusion when a check fails", async () => {
    const octokit = makeMockOctokit([
      { name: "CI", status: "completed", conclusion: "failure", html_url: "https://ci.example.com" },
      { name: "Lint", status: "completed", conclusion: "success" },
    ]);

    const params: QualityGateInput = { pullNumber: 99 };
    const { structured, text } = await handleQualityGateStatus(params, REF, octokit);

    expect(structured.conclusion).toBe("failing");
    expect(text).toContain("[FAIL] Some checks are failing");
    expect(structured.categories.failing[0].name).toBe("CI");
  });

  it("reports 'pending' when checks are still running", async () => {
    const octokit = makeMockOctokit([
      { name: "Build", status: "in_progress", conclusion: null },
      { name: "Lint", status: "completed", conclusion: "success" },
    ]);

    const params: QualityGateInput = { pullNumber: 7 };
    const { structured, text } = await handleQualityGateStatus(params, REF, octokit);

    expect(structured.conclusion).toBe("pending");
    expect(text).toContain("[PENDING]");
  });

  it("throws when neither pullNumber nor ref is provided", async () => {
    const octokit = makeMockOctokit([]);
    const params: QualityGateInput = {};
    await expect(handleQualityGateStatus(params, REF, octokit)).rejects.toThrow(
      /pullNumber or ref is required/
    );
  });

  it("includes correct headSha in structured output", async () => {
    const octokit = makeMockOctokit([]);
    const params: QualityGateInput = { pullNumber: 1 };
    const { structured } = await handleQualityGateStatus(params, REF, octokit);
    expect(structured.headSha).toBe("abc1234def5678");
  });
});

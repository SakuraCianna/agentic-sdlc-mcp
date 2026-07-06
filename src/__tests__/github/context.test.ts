/**
 * Tests for src/github/context.ts
 * Covers: fetchRepoContext issueLimit/prLimit pass-through, summarizePackageJson
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

const listForRepo = vi.fn().mockResolvedValue({ data: [] });
const pullsList = vi.fn().mockResolvedValue({ data: [] });

vi.mock("../../github/client.js", () => ({
  getOctokit: () => ({
    repos: {
      get: vi.fn().mockResolvedValue({
        data: {
          name: "test-repo",
          full_name: "test-org/test-repo",
          description: "desc",
          default_branch: "main",
          visibility: "public",
          language: "TypeScript",
          stargazers_count: 1,
          open_issues_count: 1,
          topics: [],
          pushed_at: "2026-01-01T00:00:00Z",
        },
      }),
    },
    issues: { listForRepo },
    pulls: { list: pullsList },
  }),
}));

const { fetchRepoContext, summarizePackageJson } = await import("../../github/context.js");

describe("fetchRepoContext", () => {
  it("uses default per_page of 20 when issueLimit/prLimit are not provided", async () => {
    await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeOpenIssues: true,
      includeOpenPRs: true,
    });

    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 20 })
    );
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 20 })
    );
  });

  it("passes issueLimit and prLimit through as per_page", async () => {
    await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeOpenIssues: true,
      includeOpenPRs: true,
      issueLimit: 5,
      prLimit: 100,
    });

    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 5 })
    );
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 })
    );
  });

  it("does not call listForRepo/pulls.list when the flags are off", async () => {
    listForRepo.mockClear();
    pullsList.mockClear();

    await fetchRepoContext({ owner: "test-org", repo: "test-repo" });

    expect(listForRepo).not.toHaveBeenCalled();
    expect(pullsList).not.toHaveBeenCalled();
  });
});

describe("summarizePackageJson", () => {
  it("summarises name, version, and dependency counts", () => {
    const summary = summarizePackageJson({
      name: "test-repo",
      version: "1.0.0",
      dependencies: { a: "1.0.0", b: "1.0.0" },
    });

    expect(summary).toContain("name: test-repo");
    expect(summary).toContain("version: 1.0.0");
    expect(summary).toContain("dependencies (2): a, b");
  });
});

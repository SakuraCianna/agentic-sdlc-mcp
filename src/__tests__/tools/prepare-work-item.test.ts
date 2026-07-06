/**
 * Tests for src/tools/prepare-work-item.ts
 * Covers: handlePrepareWorkItem structured output
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

const { handlePrepareWorkItem } = await import("../../tools/prepare-work-item.js");

import type { PrepareWorkItemInput } from "../../tools/prepare-work-item.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeMockOctokit(
  issue: any = {},
  comments: any[] = [],
  pulls: { list?: any[]; filesByNumber?: Record<number, any[]> } = {}
) {
  return {
    issues: {
      get: vi.fn().mockResolvedValue({
        data: {
          number: 1,
          title: "Add feature",
          state: "open",
          html_url: "https://github.com/test-org/test-repo/issues/1",
          body: "Implement the feature",
          labels: [],
          assignees: [],
          created_at: "2026-01-01T00:00:00Z",
          ...issue,
        },
      }),
      listComments: vi.fn().mockResolvedValue({ data: comments }),
    },
    pulls: {
      list: vi.fn().mockResolvedValue({ data: pulls.list ?? [] }),
      listFiles: vi.fn().mockImplementation(async ({ pull_number }: { pull_number: number }) => ({
        data: pulls.filesByNumber?.[pull_number] ?? [],
      })),
    },
  } as unknown as Parameters<typeof handlePrepareWorkItem>[2];
}

describe("handlePrepareWorkItem", () => {
  it("returns structured work item brief", async () => {
    const octokit = makeMockOctokit();
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: false,
      includeRecentPRs: false,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.issueNumber).toBe(1);
    expect(structured.title).toBe("Add feature");
    expect(structured.state).toBe("open");
    expect(structured.url).toBe("https://github.com/test-org/test-repo/issues/1");
    expect(structured.handoffPrompt).toContain("test-org/test-repo");
  });

  it("includes labels and assignees", async () => {
    const octokit = makeMockOctokit({
      labels: [{ name: "bug" }, { name: "priority" }],
      assignees: [{ login: "alice" }, { login: "bob" }],
    });
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: false,
      includeRecentPRs: false,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.labels).toEqual(["bug", "priority"]);
    expect(structured.assignees).toEqual(["@alice", "@bob"]);
  });

  it("extracts related file hints when includeRelatedFiles is true", async () => {
    const octokit = makeMockOctokit({
      body: "Fix bug in src/auth.ts and update tests/auth.test.ts",
    });
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: true,
      includeRecentPRs: false,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.relatedFileHints.length).toBeGreaterThan(0);
  });

  it("does not extract files when includeRelatedFiles is false", async () => {
    const octokit = makeMockOctokit({
      body: "Fix bug in src/auth.ts",
    });
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: false,
      includeRecentPRs: false,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.relatedFileHints).toEqual([]);
  });

  it("returns empty recentPRs and skips pulls.list when there are no file hints", async () => {
    const octokit = makeMockOctokit({ body: "Fix bug in src/auth.ts" });
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: false,
      includeRecentPRs: true,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.recentPRs).toEqual([]);
    expect((octokit as any).pulls.list).not.toHaveBeenCalled();
  });

  it("finds recent merged PRs that touched a related file hint", async () => {
    const octokit = makeMockOctokit(
      { body: "Fix bug in src/auth.ts" },
      [],
      {
        list: [
          {
            number: 10,
            title: "Refactor auth",
            html_url: "https://github.com/test-org/test-repo/pull/10",
            merged_at: "2026-02-01T00:00:00Z",
          },
          {
            number: 9,
            title: "Unrelated change",
            html_url: "https://github.com/test-org/test-repo/pull/9",
            merged_at: "2026-01-20T00:00:00Z",
          },
          {
            number: 8,
            title: "Closed without merge",
            html_url: "https://github.com/test-org/test-repo/pull/8",
            merged_at: null,
          },
        ],
        filesByNumber: {
          10: [{ filename: "src/auth.ts" }, { filename: "src/other.ts" }],
          9: [{ filename: "src/unrelated.ts" }],
        },
      }
    );
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: true,
      includeRecentPRs: true,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.recentPRs).toHaveLength(1);
    expect(structured.recentPRs[0]).toMatchObject({
      number: 10,
      title: "Refactor auth",
      matchedFiles: ["src/auth.ts"],
    });
    // Merged-but-unmatched (#9) and closed-without-merge (#8) must be excluded.
    expect(structured.recentPRs.some((pr) => pr.number === 9)).toBe(false);
    expect(structured.recentPRs.some((pr) => pr.number === 8)).toBe(false);
    expect((octokit as any).pulls.listFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 8 })
    );
  });

  it("does not call pulls.list when includeRecentPRs is false", async () => {
    const octokit = makeMockOctokit({ body: "Fix bug in src/auth.ts" });
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: true,
      includeRecentPRs: false,
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.recentPRs).toEqual([]);
    expect((octokit as any).pulls.list).not.toHaveBeenCalled();
  });
});

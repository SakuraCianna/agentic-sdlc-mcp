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

function makeMockOctokit(issue: any = {}, comments: any[] = []) {
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
  } as unknown as Parameters<typeof handlePrepareWorkItem>[2];
}

describe("handlePrepareWorkItem", () => {
  it("returns structured work item brief", async () => {
    const octokit = makeMockOctokit();
    const params: PrepareWorkItemInput = { issueNumber: 1 };

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
    const params: PrepareWorkItemInput = { issueNumber: 1 };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.labels).toEqual(["bug", "priority"]);
    expect(structured.assignees).toEqual(["@alice", "@@bob"]);
  });

  it("extracts related file hints when includeRelatedFiles is true", async () => {
    const octokit = makeMockOctokit({
      body: "Fix bug in src/auth.ts and update tests/auth.test.ts",
    });
    const params: PrepareWorkItemInput = {
      issueNumber: 1,
      includeRelatedFiles: true,
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
    };

    const { structured } = await handlePrepareWorkItem(params, REF, octokit);

    expect(structured.relatedFileHints).toEqual([]);
  });
});

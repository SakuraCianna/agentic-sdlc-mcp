/**
 * Tests for src/tools/create-issue-set.ts
 * Covers: handleCreateIssueSet (dryRun=true / dryRun=false)
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

const { handleCreateIssueSet } = await import("../../tools/create-issue-set.js");

import type { CreateIssueSetInput } from "../../tools/create-issue-set.js";
import type { RepoRef } from "../../types.js";

// ---------------------------------------------------------------------------
// handleCreateIssueSet — dryRun=true (should NOT call octokit)
// ---------------------------------------------------------------------------

describe("handleCreateIssueSet — dryRun=true", () => {
  const ref: RepoRef = { owner: "test-org", repo: "test-repo" };

  const mockOctokit = {
    issues: { create: vi.fn() },
  } as unknown as Parameters<typeof handleCreateIssueSet>[2];

  it("returns preview and does NOT call octokit.issues.create", async () => {
    const params: CreateIssueSetInput = {
      dryRun: true,
      issues: [
        { title: "Issue A", body: "Body A", labels: ["enhancement"] },
        { title: "Issue B", body: "Body B" },
      ],
    };

    const { text, structured } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(mockOctokit.issues.create).not.toHaveBeenCalled();
    expect(structured.dryRun).toBe(true);
    expect(structured.count).toBe(2);
    expect(structured.issues).toEqual([]);
    expect(structured.previewTitles).toEqual(["Issue A", "Issue B"]);
    expect(text).toContain("dry run");
  });

  it("includes titlePrefix in preview titles", async () => {
    const params: CreateIssueSetInput = {
      dryRun: true,
      titlePrefix: "[Q1]",
      issues: [{ title: "Ship MVP", body: "..." }],
    };

    const { structured } = await handleCreateIssueSet(params, ref, mockOctokit);
    expect(structured.previewTitles[0]).toBe("[Q1] Ship MVP");
  });
});

// ---------------------------------------------------------------------------
// handleCreateIssueSet — dryRun=false (should call octokit.issues.create)
// ---------------------------------------------------------------------------

describe("handleCreateIssueSet — dryRun=false", () => {
  const ref: RepoRef = { owner: "test-org", repo: "test-repo" };

  it("calls octokit.issues.create once per issue", async () => {
    const createMock = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        title: "Issue A",
        html_url: "https://github.com/test-org/test-repo/issues/42",
      },
    });
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const params: CreateIssueSetInput = {
      dryRun: false,
      issues: [{ title: "Issue A", body: "Body A" }],
    };

    const { structured } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      owner: "test-org",
      repo: "test-repo",
      title: "Issue A",
      body: "Body A",
      labels: undefined,
      assignees: undefined,
    });
    expect(structured.dryRun).toBe(false);
    expect(structured.count).toBe(1);
    expect(structured.issues).toHaveLength(1);
    expect(structured.issues[0].number).toBe(42);
  });

  it("calls create for each issue in sequence", async () => {
    let counter = 100;
    const createMock = vi.fn().mockImplementation(async (payload: { title: string }) => ({
      data: {
        number: ++counter,
        title: payload.title,
        html_url: `https://github.com/org/repo/issues/${counter}`,
      },
    }));
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const params: CreateIssueSetInput = {
      dryRun: false,
      issues: [
        { title: "First", body: "b1" },
        { title: "Second", body: "b2" },
        { title: "Third", body: "b3" },
      ],
    };

    const { structured } = await handleCreateIssueSet(params, ref, mockOctokit);
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(structured.issues).toHaveLength(3);
    expect(structured.issues[0].number).toBe(101);
    expect(structured.issues[2].number).toBe(103);
  });
});

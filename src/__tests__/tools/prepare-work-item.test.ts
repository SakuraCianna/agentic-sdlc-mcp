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

const {
  fileMatchesHint,
  handlePrepareWorkItem,
} = await import("../../tools/prepare-work-item.js");

import type { PrepareWorkItemInput } from "../../tools/prepare-work-item.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

interface IssueFixture {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  labels: Array<string | { name?: string | null }>;
  assignees: Array<{ login: string }> | null;
  created_at: string;
}

interface CommentFixture {
  body: string | null;
  created_at: string;
  user?: { login: string } | null;
}

interface PullFixture {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
}

function makeMockOctokit(
  issue: Partial<IssueFixture> = {},
  comments: CommentFixture[] = [],
  pulls: {
    list?: PullFixture[];
    filesByNumber?: Record<number, Array<{ filename: string }>>;
  } = {}
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

  it("normalizes string/empty labels and absent assignees without inventing values", async () => {
    const octokit = makeMockOctokit({
      body: null,
      labels: ["bug", { name: null }, {}],
      assignees: [{ login: "" }],
    });

    const { structured, text } = await handlePrepareWorkItem(
      { issueNumber: 1, includeRelatedFiles: true, includeRecentPRs: false },
      REF,
      octokit
    );

    expect(structured.labels).toEqual(["bug"]);
    expect(structured.assignees).toEqual([]);
    expect(structured.relatedFileHints).toEqual([]);
    expect(text).toContain("(no description)");
  });

  it("renders at most three bounded comment previews with missing authors handled", async () => {
    const comments: CommentFixture[] = [
      { body: "x".repeat(301), created_at: "2026-01-02T00:00:00Z", user: null },
      { body: null, created_at: "2026-01-03T00:00:00Z", user: { login: "alice" } },
      { body: "third", created_at: "2026-01-04T00:00:00Z", user: { login: "bob" } },
      {
        body: "must not render",
        created_at: "2026-01-05T00:00:00Z",
        user: { login: "mallory" },
      },
    ];

    const { text } = await handlePrepareWorkItem(
      { issueNumber: 1, includeRelatedFiles: false, includeRecentPRs: false },
      REF,
      makeMockOctokit({}, comments)
    );

    expect(text).toContain("**@unknown**");
    expect(text).toContain(`${"x".repeat(300)}...`);
    expect(text).toContain("**@alice**");
    expect(text).toContain("**@bob**");
    expect(text).not.toContain("mallory");
  });

  it("returns at most five related PRs and stops scanning later candidates", async () => {
    const candidates: PullFixture[] = Array.from({ length: 8 }, (_, index) => ({
      number: 100 - index,
      title: `PR ${100 - index}`,
      html_url: `https://github.com/test-org/test-repo/pull/${100 - index}`,
      merged_at: "2026-02-01T00:00:00Z",
    }));
    const filesByNumber = Object.fromEntries(
      candidates.map((pull) => [pull.number, [{ filename: "src/auth.ts" }]])
    );
    const octokit = makeMockOctokit(
      { body: "Change src/auth.ts" },
      [],
      { list: candidates, filesByNumber }
    );

    const { structured } = await handlePrepareWorkItem(
      { issueNumber: 1, includeRelatedFiles: true, includeRecentPRs: true },
      REF,
      octokit
    );

    expect(structured.recentPRs).toHaveLength(5);
    expect(structured.recentPRs.map((pull) => pull.number)).toEqual([100, 99, 98, 97, 96]);
    expect((octokit as any).pulls.listFiles).toHaveBeenCalledTimes(5);
    expect((octokit as any).pulls.listFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 95 })
    );
  });
});

describe("fileMatchesHint path boundaries", () => {
  it("does not match a suffix that is only part of another basename", () => {
    expect(fileMatchesHint("src/oauth.ts", "auth.ts")).toBe(false);
    expect(fileMatchesHint("src/authentication.ts", "auth.ts")).toBe(false);
  });

  it("matches exact repository paths and basename hints at segment boundaries", () => {
    expect(fileMatchesHint("src/auth.ts", "src/auth.ts")).toBe(true);
    expect(fileMatchesHint("src/auth.ts", "auth.ts")).toBe(true);
    expect(fileMatchesHint("packages/api/src/auth.ts", "src/auth.ts")).toBe(true);
    expect(fileMatchesHint("src\\auth.ts", "./src/auth.ts")).toBe(true);
  });
});

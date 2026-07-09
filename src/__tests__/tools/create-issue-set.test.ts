/**
 * Tests for src/tools/create-issue-set.ts
 * Covers: handleCreateIssueSet (dryRun=true / dryRun=false), warnings, preview
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
  CreateIssueSetInputSchema,
  handleCreateIssueSet,
  generateIssueWarnings,
  summarizeBody,
} = await import("../../tools/create-issue-set.js");

import type { CreateIssueSetInput } from "../../tools/create-issue-set.js";
import type { RepoRef } from "../../types.js";

// ---------------------------------------------------------------------------
// summarizeBody (pure helper)
// ---------------------------------------------------------------------------

describe("summarizeBody", () => {
  it("returns the body unchanged when under the truncation threshold", () => {
    expect(summarizeBody("A short body.")).toBe("A short body.");
  });

  it("truncates long bodies with an ellipsis", () => {
    const long = "x".repeat(300);
    const result = summarizeBody(long);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThan(long.length);
  });

  it("returns '(empty)' for a blank body", () => {
    expect(summarizeBody("   ")).toBe("(empty)");
    expect(summarizeBody("")).toBe("(empty)");
  });
});

describe("CreateIssueSetInputSchema", () => {
  it("defaults dryRun to true when callers omit it", () => {
    const parsed = CreateIssueSetInputSchema.parse({
      issues: [{ title: "Preview me", body: "A meaningful issue body." }],
    });

    expect(parsed.dryRun).toBe(true);
  });

  it("accepts and preserves a complete plan_from_context issue draft", () => {
    const draft = {
      title: "[Create] Implement rate limiting",
      body: "### Background\nAdd rate limiting.\n\n### Acceptance Criteria\n- Limit requests",
      labels: ["enhancement"],
      phase: "create",
      acceptanceCriteria: ["Limit requests", "Return Retry-After"],
      riskLevel: "medium" as const,
      goal: "Add rate limiting",
    };

    const parsed = CreateIssueSetInputSchema.parse({ issues: [draft] });

    expect(parsed.issues[0]).toEqual(draft);
  });

  it("rejects an empty issues array with a clear error", () => {
    const result = CreateIssueSetInputSchema.safeParse({ issues: [] });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one issue|required/i);
    }
  });
});

// ---------------------------------------------------------------------------
// generateIssueWarnings (pure helper)
// ---------------------------------------------------------------------------

describe("generateIssueWarnings", () => {
  it("flags an issue with no labels", () => {
    const warnings = generateIssueWarnings(
      [{ title: "Issue A", body: "A meaningful body description here." }],
      ""
    );
    expect(warnings.some((w) => /no labels/i.test(w))).toBe(true);
  });

  it("does not flag an issue that has labels", () => {
    const warnings = generateIssueWarnings(
      [{ title: "Issue A", body: "A meaningful body description here.", labels: ["bug"] }],
      ""
    );
    expect(warnings.some((w) => /no labels/i.test(w))).toBe(false);
  });

  it("flags a missing or very short body", () => {
    const warnings = generateIssueWarnings(
      [{ title: "Issue A", body: "short", labels: ["bug"] }],
      ""
    );
    expect(warnings.some((w) => /short body/i.test(w))).toBe(true);
  });

  it("does not flag a body that meets the meaningful-length bar", () => {
    const warnings = generateIssueWarnings(
      [{ title: "Issue A", body: "A meaningful body description that is long enough.", labels: ["bug"] }],
      ""
    );
    expect(warnings.some((w) => /short body/i.test(w))).toBe(false);
  });

  it("flags a title exceeding GitHub's 256-character limit, including the applied prefix", () => {
    const longTitle = "x".repeat(250);
    const warnings = generateIssueWarnings(
      [{ title: longTitle, body: "A meaningful body description here.", labels: ["bug"] }],
      "[PREFIX] "
    );
    expect(warnings.some((w) => /256-character limit/i.test(w))).toBe(true);
  });

  it("returns no warnings for a well-formed issue", () => {
    const warnings = generateIssueWarnings(
      [{ title: "Well-formed issue", body: "A meaningful body description here.", labels: ["bug"] }],
      ""
    );
    expect(warnings).toEqual([]);
  });

  it("produces one warning entry per (issue, problem) pair across multiple issues", () => {
    const warnings = generateIssueWarnings(
      [
        { title: "Issue A", body: "short" }, // no labels + short body
        { title: "Issue B", body: "A meaningful body description here.", labels: ["bug"] }, // clean
      ],
      ""
    );
    expect(warnings.length).toBe(2);
    expect(warnings.some((w) => w.includes("Issue 1"))).toBe(true);
    expect(warnings.every((w) => !w.includes("Issue 2"))).toBe(true);
  });
});

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
    expect(structured.targetRepo).toBe("test-org/test-repo");
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

  it("includes a per-issue preview with title, labels, and a body summary", async () => {
    const params: CreateIssueSetInput = {
      dryRun: true,
      issues: [{ title: "Issue A", body: "A meaningful body.", labels: ["bug", "documentation"] }],
    };

    const { structured } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(structured.preview).toEqual([
      { title: "Issue A", labels: ["bug", "documentation"], bodySummary: "A meaningful body." },
    ]);
  });

  it("surfaces warnings for issues missing labels or with a short body", async () => {
    const params: CreateIssueSetInput = {
      dryRun: true,
      issues: [{ title: "Issue A", body: "short" }],
    };

    const { structured, text } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(structured.warnings.length).toBeGreaterThan(0);
    expect(text).toContain("Warnings");
    expect(text).toContain("[WARN]");
  });

  it("explicitly states the target repo coordinates and that this is preview-only", async () => {
    const params: CreateIssueSetInput = {
      dryRun: true,
      issues: [{ title: "Issue A", body: "A meaningful body description here.", labels: ["bug"] }],
    };

    const { text } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(text).toContain("Preview only");
    expect(text).toContain("test-org/test-repo");
    expect(text).toContain("No write call was made");
  });

  it("returns an empty preview/warnings array when no issues have problems", async () => {
    const params: CreateIssueSetInput = {
      dryRun: true,
      issues: [{ title: "Clean issue", body: "A meaningful body description here.", labels: ["bug"] }],
    };

    const { structured } = await handleCreateIssueSet(params, ref, mockOctokit);
    expect(structured.warnings).toEqual([]);
  });

  it("keeps markdown output bounded by using the 200-character body summary", async () => {
    const body = "x".repeat(50_000);
    const params: CreateIssueSetInput = {
      dryRun: true,
      issues: [{ title: "Large body", body, labels: ["test"] }],
    };

    const { text, structured } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(structured.preview[0]?.bodySummary).toBe(`${"x".repeat(200)}...`);
    expect(text).toContain(`${"x".repeat(200)}...`);
    expect(text).not.toContain("x".repeat(201));
    expect(text.length).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// handleCreateIssueSet — dryRun=false (should call octokit.issues.create)
// ---------------------------------------------------------------------------

describe("handleCreateIssueSet — dryRun=false", () => {
  const ref: RepoRef = { owner: "test-org", repo: "test-repo" };

  it("calls octokit.issues.create once per issue and returns labels from the response", async () => {
    const createMock = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        title: "Issue A",
        html_url: "https://github.com/test-org/test-repo/issues/42",
        labels: [{ name: "bug" }, { name: "enhancement" }],
      },
    });
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const params = CreateIssueSetInputSchema.parse({
      dryRun: false,
      issues: [{
        title: "Issue A",
        body: "Body A",
        labels: ["bug", "enhancement"],
        phase: "create",
        acceptanceCriteria: ["Create the issue"],
        riskLevel: "medium",
        goal: "Exercise the live handler",
      }],
    });

    const { structured, text } = await handleCreateIssueSet(params, ref, mockOctokit);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      owner: "test-org",
      repo: "test-repo",
      title: "Issue A",
      body: "Body A",
      labels: ["bug", "enhancement"],
      assignees: undefined,
    });
    expect(structured.dryRun).toBe(false);
    expect(structured.count).toBe(1);
    expect(structured.issues).toHaveLength(1);
    expect(structured.issues[0].number).toBe(42);
    expect(structured.issues[0].labels).toEqual(["bug", "enhancement"]);
    expect(text).toContain("[bug, enhancement]");
  });

  it("does not crash when the create response omits labels", async () => {
    const createMock = vi.fn().mockResolvedValue({
      data: { number: 1, title: "Issue A", html_url: "https://github.com/x/y/issues/1" },
    });
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const params: CreateIssueSetInput = {
      dryRun: false,
      issues: [{ title: "Issue A", body: "Body A" }],
    };

    const { structured } = await handleCreateIssueSet(params, ref, mockOctokit);
    expect(structured.issues[0].labels).toEqual([]);
  });

  it("calls create for each issue in sequence", async () => {
    let counter = 100;
    const createMock = vi.fn().mockImplementation(async (payload: { title: string }) => ({
      data: {
        number: ++counter,
        title: payload.title,
        html_url: `https://github.com/org/repo/issues/${counter}`,
        labels: [],
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

  it("keeps successful results, records a safe failure, and continues with later issues", async () => {
    const createMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          number: 101,
          title: "First",
          html_url: "https://github.com/test-org/test-repo/issues/101",
          labels: [],
        },
      })
      .mockRejectedValueOnce({
        status: 422,
        response: { data: { message: "sensitive-response-body" } },
      })
      .mockResolvedValueOnce({
        data: {
          number: 103,
          title: "Third",
          html_url: "https://github.com/test-org/test-repo/issues/103",
          labels: [{ name: "bug" }],
        },
      });
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const { structured, text } = await handleCreateIssueSet(
      {
        dryRun: false,
        issues: [
          { title: "First", body: "First meaningful issue body." },
          { title: "Second", body: "Second meaningful issue body." },
          { title: "Third", body: "Third meaningful issue body.", labels: ["bug"] },
        ],
      },
      ref,
      mockOctokit
    );

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(structured.targetRepo).toBe("test-org/test-repo");
    expect(structured.count).toBe(2);
    expect(structured.issues.map((issue) => issue.number)).toEqual([101, 103]);
    expect(structured.failures).toEqual([
      expect.objectContaining({ title: "Second", reason: expect.stringMatching(/422|validation/i) }),
    ]);
    expect(text).toContain("2 created");
    expect(text).toContain("1 failed");
    expect(text).toContain("Second");
    expect(text).not.toContain("sensitive-response-body");
  });

  it("identifies a failed input by index when multiple issues have the same title", async () => {
    const createMock = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          number: 201,
          title: "Duplicate",
          html_url: "https://github.com/test-org/test-repo/issues/201",
          labels: [],
        },
      })
      .mockRejectedValueOnce({ status: 422 })
      .mockResolvedValueOnce({
        data: {
          number: 203,
          title: "Later",
          html_url: "https://github.com/test-org/test-repo/issues/203",
          labels: [],
        },
      });
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const { structured, text } = await handleCreateIssueSet(
      {
        dryRun: false,
        issues: [
          { title: "Duplicate", body: "First issue with this title." },
          { title: "Duplicate", body: "Second issue with this title." },
          { title: "Later", body: "A later issue should still be created." },
        ],
      },
      ref,
      mockOctokit
    );

    expect(createMock).toHaveBeenCalledTimes(3);
    expect(structured.issues.map((issue) => issue.number)).toEqual([201, 203]);
    expect(structured.failures).toEqual([
      expect.objectContaining({
        inputIndex: 1,
        title: "Duplicate",
        reason: expect.stringMatching(/422|validation/i),
      }),
    ]);
    expect(text).toContain("Issue 2");
  });

  it("returns structured failure details when every live creation fails", async () => {
    const createMock = vi
      .fn()
      .mockRejectedValueOnce({ status: 403, response: { data: { message: "private response" } } })
      .mockRejectedValueOnce(new Error("socket closed"));
    const mockOctokit = {
      issues: { create: createMock },
    } as unknown as Parameters<typeof handleCreateIssueSet>[2];

    const { structured, text } = await handleCreateIssueSet(
      {
        dryRun: false,
        issues: [
          { title: "First", body: "First meaningful issue body." },
          { title: "Second", body: "Second meaningful issue body." },
        ],
      },
      ref,
      mockOctokit
    );

    expect(structured.count).toBe(0);
    expect(structured.issues).toEqual([]);
    expect(structured.failures).toHaveLength(2);
    expect(structured.failures.map((failure) => failure.title)).toEqual(["First", "Second"]);
    expect(text).toContain("0 created");
    expect(text).toContain("2 failed");
    expect(text).not.toContain("private response");
  });
});

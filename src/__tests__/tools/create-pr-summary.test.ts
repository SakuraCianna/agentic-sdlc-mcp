/**
 * Tests for src/tools/create-pr-summary.ts
 * Covers: handleCreatePrSummary file categorization, risks, structured output
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

const { handleCreatePrSummary, CreatePrSummaryOutputSchema } = await import("../../tools/create-pr-summary.js");
import { z } from "zod";

import type { CreatePrSummaryInput } from "../../tools/create-pr-summary.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeFile(filename: string, additions = 10, deletions = 2) {
  return { filename, status: "modified", additions, deletions };
}

function makeMockOctokit(prOverrides = {}, files: ReturnType<typeof makeFile>[] = []) {
  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          title: "My feature PR",
          body: "This PR adds the feature.",
          user: { login: "dev" },
          draft: false,
          base: { ref: "main" },
          head: { ref: "feature/my-feature" },
          created_at: "2026-01-01T00:00:00Z",
          commits: 3,
          labels: [],
          ...prOverrides,
        },
      }),
      listFiles: vi.fn().mockResolvedValue({ data: files }),
    },
  } as unknown as Parameters<typeof handleCreatePrSummary>[2];
}

describe("handleCreatePrSummary", () => {
  it("returns structured output with correct PR metadata", async () => {
    const octokit = makeMockOctokit({}, [makeFile("src/app.ts")]);
    const params: CreatePrSummaryInput = { pullNumber: 42 };

    const { structured } = await handleCreatePrSummary(params, REF, octokit);

    expect(structured.pullNumber).toBe(42);
    expect(structured.title).toBe("My feature PR");
    expect(structured.author).toBe("dev");
    expect(structured.isDraft).toBe(false);
    expect(structured.baseRef).toBe("main");
    expect(structured.headRef).toBe("feature/my-feature");
  });

  it("detects test files correctly", async () => {
    const files = [
      makeFile("src/app.ts"),
      makeFile("src/__tests__/app.test.ts"),
      makeFile("tests/app.spec.js"),
    ];
    const octokit = makeMockOctokit({}, files);
    const params: CreatePrSummaryInput = { pullNumber: 42 };

    const { structured } = await handleCreatePrSummary(params, REF, octokit);

    expect(structured.hasTests).toBe(true);
    expect(structured.totalFiles).toBe(3);
  });

  it("detects missing tests", async () => {
    const files = [makeFile("src/app.ts"), makeFile("src/utils.ts")];
    const octokit = makeMockOctokit({}, files);
    const params: CreatePrSummaryInput = { pullNumber: 42 };

    const { structured } = await handleCreatePrSummary(params, REF, octokit);

    expect(structured.hasTests).toBe(false);
    expect(structured.risks.some((r) => r.includes("No test files detected"))).toBe(true);
  });

  it("flags config file changes as a risk", async () => {
    const files = [makeFile(".env"), makeFile("src/__tests__/foo.test.ts")];
    const octokit = makeMockOctokit({}, files);
    const params: CreatePrSummaryInput = { pullNumber: 42 };

    const { structured } = await handleCreatePrSummary(params, REF, octokit);

    expect(structured.risks.some((r) => r.includes("Config file"))).toBe(true);
  });

  it("flags large diff as a risk", async () => {
    const files = [
      makeFile("src/big.ts", 600, 10),
      makeFile("src/__tests__/big.test.ts"),
    ];
    const octokit = makeMockOctokit({}, files);
    const params: CreatePrSummaryInput = { pullNumber: 42 };

    const { structured } = await handleCreatePrSummary(params, REF, octokit);

    expect(structured.risks.some((r) => r.includes("Large diff"))).toBe(true);
  });

  it("includes release notes draft in text output", async () => {
    const octokit = makeMockOctokit({}, [makeFile("src/app.ts")]);
    const params: CreatePrSummaryInput = { pullNumber: 42 };

    const { text } = await handleCreatePrSummary(params, REF, octokit);

    expect(text).toContain("Release Notes Draft");
    expect(text).toContain("My feature PR");
  });

  it("does not demand code tests for a documentation-only PR", async () => {
    const octokit = makeMockOctokit({}, [
      makeFile("README.md"),
      makeFile("docs/setup.rst"),
    ]);

    const { structured, text } = await handleCreatePrSummary({ pullNumber: 42 }, REF, octokit);

    expect(structured.docsOnly).toBe(true);
    expect(structured.risks.join(" ")).not.toMatch(/No test files detected/i);
    expect(text).toMatch(/documentation-only/i);
  });

  it("marks a 300-file evidence cap instead of presenting it as complete", async () => {
    const octokit = makeMockOctokit({}, []);
    const listFiles = (octokit as unknown as {
      pulls: { listFiles: ReturnType<typeof vi.fn> };
    }).pulls.listFiles;
    listFiles.mockImplementation(async ({ page }: { page: number }) => ({
      data: page <= 3
        ? Array.from({ length: 100 }, (_, index) => makeFile(`src/page-${page}-${index}.ts`))
        : [makeFile("src/overflow.ts")],
    }));

    const { structured, text } = await handleCreatePrSummary({ pullNumber: 42 }, REF, octokit);

    expect(structured.totalFiles).toBe(300);
    expect(structured.filesTruncated).toBe(true);
    expect(structured.risks.join(" ")).toMatch(/incomplete.*300|300.*incomplete/i);
    expect(text).toMatch(/truncated|incomplete/i);
    expect(() => z.object(CreatePrSummaryOutputSchema).parse(structured)).not.toThrow();
  });

  it("does not claim docs-only when the 301st unseen file is code", async () => {
    const octokit = makeMockOctokit({}, []);
    const listFiles = (octokit as unknown as {
      pulls: { listFiles: ReturnType<typeof vi.fn> };
    }).pulls.listFiles;
    listFiles.mockImplementation(async ({ page }: { page: number }) => ({
      data: page <= 3
        ? Array.from({ length: 100 }, (_, index) => makeFile(`docs/page-${page}-${index}.md`))
        : [makeFile("src/hidden-code.ts")],
    }));

    const { structured } = await handleCreatePrSummary({ pullNumber: 42 }, REF, octokit);

    expect(structured.filesTruncated).toBe(true);
    expect(structured.docsOnly).toBe(false);
    expect(structured.risks.join(" ")).toMatch(/No test files detected/i);
  });

  it("escapes and bounds untrusted PR metadata in Markdown while preserving structured values", async () => {
    const malicious = "PR\n## forged [click](javascript:alert(1)) " + "x".repeat(500);
    const octokit = makeMockOctokit(
      { title: malicious, body: malicious, user: { login: "dev\n## forged" }, labels: [{ name: malicious }] },
      [makeFile("src/evil](`javascript:alert(1)`).ts")]
    );

    const { structured, text } = await handleCreatePrSummary({ pullNumber: 42 }, REF, octokit);

    expect(structured.title).toBe(malicious);
    expect(text).not.toContain("\n## forged");
    expect(text).not.toContain("[click](javascript:");
    expect(text.length).toBeLessThan(8_000);
  });
});

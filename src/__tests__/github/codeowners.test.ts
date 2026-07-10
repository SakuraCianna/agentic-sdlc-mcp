import { describe, expect, it, vi } from "vitest";
import {
  codeownersPatternMatches,
  fetchCodeownersRules,
  findOwnershipGaps,
  ownersForFile,
  parseCodeowners,
  type CodeownersRule,
} from "../../github/codeowners.js";
import type { RepoRef } from "../../types.js";

describe("parseCodeowners", () => {
  it("parses pattern + owners, skipping blank lines and comments", () => {
    const content = `
# This is a comment
*.ts @alice
/src/tools/ @bob @org/reviewers

# another comment
docs/ @carol
`;
    expect(parseCodeowners(content)).toEqual([
      { pattern: "*.ts", owners: ["@alice"] },
      { pattern: "/src/tools/", owners: ["@bob", "@org/reviewers"] },
      { pattern: "docs/", owners: ["@carol"] },
    ]);
  });

  it("skips lines with a pattern but no owners", () => {
    expect(parseCodeowners("*.md\n*.ts @alice")).toEqual([
      { pattern: "*.ts", owners: ["@alice"] },
    ]);
  });

  it("returns an empty array for empty content", () => {
    expect(parseCodeowners("")).toEqual([]);
  });
});

describe("codeownersPatternMatches", () => {
  it("matches an unanchored extension glob at any depth", () => {
    expect(codeownersPatternMatches("*.ts", "app.ts")).toBe(true);
    expect(codeownersPatternMatches("*.ts", "src/deep/app.ts")).toBe(true);
    expect(codeownersPatternMatches("*.ts", "app.js")).toBe(false);
  });

  it("anchors a rooted directory pattern to the repo root", () => {
    expect(codeownersPatternMatches("/src/tools/", "src/tools/review-pr.ts")).toBe(true);
    expect(codeownersPatternMatches("/src/tools/", "src/tools")).toBe(true);
    expect(codeownersPatternMatches("/src/tools/", "backend/src/tools/x.ts")).toBe(false);
  });

  it("anchors any pattern containing a slash, even without a leading slash", () => {
    expect(codeownersPatternMatches("src/tools/", "src/tools/review-pr.ts")).toBe(true);
    expect(codeownersPatternMatches("src/tools/", "backend/src/tools/x.ts")).toBe(false);
  });

  it("matches '?' as exactly one character, not zero or many", () => {
    expect(codeownersPatternMatches("file?.txt", "file1.txt")).toBe(true);
    expect(codeownersPatternMatches("file?.txt", "file.txt")).toBe(false);
    expect(codeownersPatternMatches("file?.txt", "file12.txt")).toBe(false);
  });

  it("matches '**' across zero directories, not just one-or-more", () => {
    expect(codeownersPatternMatches("**/foo.ts", "foo.ts")).toBe(true);
    expect(codeownersPatternMatches("**/foo.ts", "a/b/foo.ts")).toBe(true);
    expect(codeownersPatternMatches("src/**/*.ts", "src/x.ts")).toBe(true);
    expect(codeownersPatternMatches("src/**/*.ts", "src/a/b/x.ts")).toBe(true);
    expect(codeownersPatternMatches("src/**/*.ts", "other/x.ts")).toBe(false);
  });

  it("does not hang on many adjacent wildcards against a long non-matching string", () => {
    const pattern = Array.from({ length: 30 }, () => "*a").join("");
    const text = "a".repeat(40);
    const start = Date.now();
    codeownersPatternMatches(pattern, text);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("does not hang on many '**' segments interspersed with a repeating literal", () => {
    const pattern = Array.from({ length: 14 }, () => "**/x").join("/") + "/TARGET";
    const path = Array.from({ length: 30 }, () => "x").join("/");
    const start = Date.now();
    codeownersPatternMatches(pattern, path);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("ownersForFile", () => {
  const rules: CodeownersRule[] = [
    { pattern: "*", owners: ["@default-owner"] },
    { pattern: "/src/tools/", owners: ["@tools-owner"] },
    { pattern: "/src/tools/review-pr.ts", owners: ["@review-pr-owner"] },
  ];

  it("returns the last matching rule's owners (last match wins)", () => {
    expect(ownersForFile("src/tools/review-pr.ts", rules)).toEqual(["@review-pr-owner"]);
    expect(ownersForFile("src/tools/other.ts", rules)).toEqual(["@tools-owner"]);
    expect(ownersForFile("README.md", rules)).toEqual(["@default-owner"]);
  });

  it("returns an empty array when no rule matches", () => {
    expect(ownersForFile("README.md", [{ pattern: "/src/", owners: ["@x"] }])).toEqual([]);
  });
});

describe("fetchCodeownersRules", () => {
  const ref: RepoRef = { owner: "test-org", repo: "test-repo" };

  function makeContentOctokit(byPath: Record<string, { content?: string; error?: unknown }>) {
    return {
      repos: {
        getContent: vi.fn().mockImplementation(({ path }: { path: string }) => {
          const entry = byPath[path];
          if (!entry) {
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          }
          if (entry.error) return Promise.reject(entry.error);
          return Promise.resolve({
            data: { type: "file", content: Buffer.from(entry.content ?? "").toString("base64") },
          });
        }),
      },
    } as unknown as Parameters<typeof fetchCodeownersRules>[1];
  }

  it("prefers .github/CODEOWNERS when present", async () => {
    const octokit = makeContentOctokit({
      ".github/CODEOWNERS": { content: "* @github-owner\n" },
      CODEOWNERS: { content: "* @root-owner\n" },
    });
    await expect(fetchCodeownersRules(ref, octokit)).resolves.toEqual({
      rules: [{ pattern: "*", owners: ["@github-owner"] }],
      error: null,
    });
  });

  it("reads every CODEOWNERS candidate from an explicit git ref when provided", async () => {
    const octokit = makeContentOctokit({});
    await fetchCodeownersRules(ref, octokit, "base-sha");
    expect(octokit.repos.getContent).toHaveBeenNthCalledWith(1, {
      owner: "test-org",
      repo: "test-repo",
      path: ".github/CODEOWNERS",
      ref: "base-sha",
    });
    expect(octokit.repos.getContent).toHaveBeenNthCalledWith(2, {
      owner: "test-org",
      repo: "test-repo",
      path: "CODEOWNERS",
      ref: "base-sha",
    });
    expect(octokit.repos.getContent).toHaveBeenNthCalledWith(3, {
      owner: "test-org",
      repo: "test-repo",
      path: "docs/CODEOWNERS",
      ref: "base-sha",
    });
  });

  it("falls back to root CODEOWNERS when .github/CODEOWNERS is missing", async () => {
    const octokit = makeContentOctokit({ CODEOWNERS: { content: "* @root-owner\n" } });
    await expect(fetchCodeownersRules(ref, octokit)).resolves.toEqual({
      rules: [{ pattern: "*", owners: ["@root-owner"] }],
      error: null,
    });
  });

  it("falls back to docs/CODEOWNERS when the other candidates are missing", async () => {
    const octokit = makeContentOctokit({
      "docs/CODEOWNERS": { content: "* @docs-owner\n" },
    });
    await expect(fetchCodeownersRules(ref, octokit)).resolves.toEqual({
      rules: [{ pattern: "*", owners: ["@docs-owner"] }],
      error: null,
    });
  });

  it("returns empty rules and no error when no candidate path exists", async () => {
    await expect(fetchCodeownersRules(ref, makeContentOctokit({}))).resolves.toEqual({
      rules: [],
      error: null,
    });
  });

  it("preserves a non-404 error from an earlier candidate even when a later candidate 404s", async () => {
    const octokit = makeContentOctokit({
      ".github/CODEOWNERS": { error: Object.assign(new Error("Forbidden"), { status: 403 }) },
    });
    const { rules, error } = await fetchCodeownersRules(ref, octokit);
    expect(rules).toEqual([]);
    expect(error).not.toBeNull();
    expect(error!.toLowerCase()).not.toContain("not found");
  });
});

describe("findOwnershipGaps", () => {
  const rules: CodeownersRule[] = [
    { pattern: "/src/tools/", owners: ["@owner1", "@owner2"] },
  ];

  it("returns no gaps when there are no CODEOWNERS rules", () => {
    expect(findOwnershipGaps(["src/tools/x.ts"], [], [], [], [], "author")).toEqual([]);
  });

  it("returns each owner who is neither author, requested, nor a reviewer", () => {
    expect(findOwnershipGaps(["src/tools/x.ts"], rules, [], [], [], "someone-else")).toEqual([
      { owner: "@owner1", paths: ["src/tools/x.ts"] },
      { owner: "@owner2", paths: ["src/tools/x.ts"] },
    ]);
  });

  it("does not return an owner who is the PR author", () => {
    expect(findOwnershipGaps(["src/tools/x.ts"], rules, [], [], [], "owner1")).toEqual([
      { owner: "@owner2", paths: ["src/tools/x.ts"] },
    ]);
  });

  it("does not return an owner who was requested as a reviewer", () => {
    expect(findOwnershipGaps(["src/tools/x.ts"], rules, ["owner1"], [], [], "other")).toEqual([
      { owner: "@owner2", paths: ["src/tools/x.ts"] },
    ]);
  });

  it("does not return a team owner requested as a reviewing team", () => {
    const teamRules: CodeownersRule[] = [
      { pattern: "/src/tools/", owners: ["@org/reviewers"] },
    ];
    expect(
      findOwnershipGaps(["src/tools/x.ts"], teamRules, [], ["org/reviewers"], [], "other")
    ).toEqual([]);
  });

  it("does not return an owner who already reviewed", () => {
    expect(findOwnershipGaps(["src/tools/x.ts"], rules, [], [], ["owner2"], "other")).toEqual([
      { owner: "@owner1", paths: ["src/tools/x.ts"] },
    ]);
  });

  it("aggregates every changed file for the same missing owner into a single gap", () => {
    const singleOwnerRules: CodeownersRule[] = [
      { pattern: "/src/tools/", owners: ["@owner1"] },
    ];
    expect(
      findOwnershipGaps(
        ["src/tools/a.ts", "src/tools/b.ts", "src/tools/c.ts"],
        singleOwnerRules,
        [],
        [],
        [],
        "other"
      )
    ).toEqual([
      {
        owner: "@owner1",
        paths: ["src/tools/a.ts", "src/tools/b.ts", "src/tools/c.ts"],
      },
    ]);
  });

  it("matches PR author, requested users and teams, and actual reviewers case-insensitively", () => {
    const mixedCaseRules: CodeownersRule[] = [
      {
        pattern: "/src/tools/",
        owners: ["@Pr-Author", "@Requested-User", "@Org/Requested-Team", "@Actual-Reviewer"],
      },
    ];

    expect(
      findOwnershipGaps(
        ["src/tools/x.ts"],
        mixedCaseRules,
        ["REQUESTED-USER"],
        ["ORG/REQUESTED-TEAM"],
        ["ACTUAL-REVIEWER"],
        "PR-AUTHOR"
      )
    ).toEqual([]);
  });
});

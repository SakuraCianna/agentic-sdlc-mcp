/**
 * Tests for src/tools/review-pr.ts
 * Covers: classifyFiles, generateFindings, scanPatchForSecrets
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
  classifyFiles,
  generateFindings,
  scanPatchForSecrets,
  sortFindings,
  parseCodeowners,
  codeownersPatternMatches,
  ownersForFile,
  generateOwnershipFindings,
  fetchCodeownersRules,
  handleReviewPr,
} = await import("../../tools/review-pr.js");

import type {
  CodeownersRule,
  PrFile,
  PrMeta,
  ReviewPrInput,
} from "../../tools/review-pr.js";
import type { RepoRef } from "../../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(overrides: Partial<PrFile> & { filename: string }): PrFile {
  return {
    status: "modified",
    additions: 10,
    deletions: 5,
    ...overrides,
  };
}

function makePr(overrides: Partial<PrMeta> = {}): PrMeta {
  return {
    number: 1,
    title: "Test PR",
    body: "This is a meaningful description with enough text.",
    draft: false,
    commits: 3,
    author: "pr-author",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyFiles
// ---------------------------------------------------------------------------

describe("classifyFiles", () => {
  it("identifies test files by path pattern", () => {
    const files = [
      makeFile({ filename: "src/__tests__/foo.test.ts" }),
      makeFile({ filename: "tests/bar.spec.js" }),
      makeFile({ filename: "src/main.ts" }),
    ];
    const { testFiles, srcFiles } = classifyFiles(files);
    expect(testFiles).toHaveLength(2);
    expect(srcFiles).toHaveLength(1);
  });

  it("identifies lock files", () => {
    const files = [
      makeFile({ filename: "package-lock.json" }),
      makeFile({ filename: "yarn.lock" }),
      makeFile({ filename: "src/index.ts" }),
    ];
    const { lockFiles } = classifyFiles(files);
    expect(lockFiles).toHaveLength(2);
  });

  it("identifies .env files as dotEnvFiles", () => {
    const files = [
      makeFile({ filename: ".env" }),
      makeFile({ filename: ".env.local" }),
      makeFile({ filename: "src/app.ts" }),
    ];
    const { dotEnvFiles } = classifyFiles(files);
    expect(dotEnvFiles).toHaveLength(2);
  });

  it("identifies dist files", () => {
    const files = [
      makeFile({ filename: "dist/index.js" }),
      makeFile({ filename: "build/bundle.min.js" }),
      makeFile({ filename: "src/app.ts" }),
    ];
    const { distFiles } = classifyFiles(files);
    expect(distFiles).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// generateFindings — basic standard
// ---------------------------------------------------------------------------

describe("generateFindings — basic standard", () => {
  it("produces a HIGH finding when PR has no description", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    const pr = makePr({ body: null });
    const findings = generateFindings(pr, files, "basic");
    const docFinding = findings.find((f) => f.category === "Documentation");
    expect(docFinding).toBeDefined();
    expect(docFinding!.severity).toBe("high");
  });

  it("produces a HIGH finding when no test files are present", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    const pr = makePr();
    const findings = generateFindings(pr, files, "basic");
    const testFinding = findings.find((f) => f.category === "Testing");
    expect(testFinding).toBeDefined();
    expect(testFinding!.severity).toBe("high");
  });

  it("does NOT flag testing when test files are present", () => {
    const files = [
      makeFile({ filename: "src/app.ts" }),
      makeFile({ filename: "src/__tests__/app.test.ts" }),
    ];
    const pr = makePr();
    const findings = generateFindings(pr, files, "basic");
    const testFinding = findings.find((f) => f.category === "Testing");
    expect(testFinding).toBeUndefined();
  });

  it("produces INFO finding for draft PRs", () => {
    const files = [makeFile({ filename: "src/app.ts" })];
    const pr = makePr({ draft: true });
    const findings = generateFindings(pr, files, "basic");
    const draftFinding = findings.find((f) => f.category === "Status");
    expect(draftFinding).toBeDefined();
    expect(draftFinding!.severity).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// generateFindings — strict standard
// ---------------------------------------------------------------------------

describe("generateFindings — strict standard", () => {
  it("flags large PRs (>800 lines) as medium", () => {
    const files = [
      makeFile({ filename: "src/app.ts", additions: 500, deletions: 400 }),
      makeFile({ filename: "src/__tests__/app.test.ts", additions: 50, deletions: 10 }),
    ];
    const pr = makePr();
    const findings = generateFindings(pr, files, "strict");
    const sizeFinding = findings.find((f) => f.category === "Size");
    expect(sizeFinding).toBeDefined();
    expect(sizeFinding!.severity).toBe("medium");
  });

  it("does NOT flag PR size for small PRs", () => {
    const files = [makeFile({ filename: "src/app.ts", additions: 10, deletions: 5 })];
    const pr = makePr();
    const findings = generateFindings(pr, files, "strict");
    const sizeFinding = findings.find((f) => f.category === "Size");
    expect(sizeFinding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateFindings — security-focused standard
// ---------------------------------------------------------------------------

describe("generateFindings — security-focused standard", () => {
  it("flags .env file changes as CRITICAL", () => {
    const files = [
      makeFile({ filename: ".env" }),
      makeFile({ filename: "src/__tests__/foo.test.ts" }),
    ];
    const pr = makePr();
    const findings = generateFindings(pr, files, "security-focused");
    const envFinding = findings.find(
      (f) => f.category === "Security" && f.description.includes(".env")
    );
    expect(envFinding).toBeDefined();
    expect(envFinding!.severity).toBe("critical");
  });

  it("flags lock file changes as medium security concern", () => {
    const files = [
      makeFile({ filename: "package-lock.json" }),
      makeFile({ filename: "src/__tests__/foo.test.ts" }),
    ];
    const pr = makePr();
    const findings = generateFindings(pr, files, "security-focused");
    const lockFinding = findings.find(
      (f) => f.category === "Security" && f.description.includes("lockfile")
    );
    expect(lockFinding).toBeDefined();
    expect(lockFinding!.severity).toBe("medium");
  });

  it("flags dist/generated files as medium security concern", () => {
    const files = [
      makeFile({ filename: "dist/bundle.js" }),
      makeFile({ filename: "src/__tests__/foo.test.ts" }),
    ];
    const pr = makePr();
    const findings = generateFindings(pr, files, "security-focused");
    const distFinding = findings.find(
      (f) => f.category === "Security" && f.description.includes("dist")
    );
    expect(distFinding).toBeDefined();
    expect(distFinding!.severity).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// scanPatchForSecrets
// ---------------------------------------------------------------------------

describe("scanPatchForSecrets", () => {
  it("detects hardcoded password assignment in added lines", () => {
    const patch = `@@ -1,3 +1,4 @@
 const x = 1;
+const password = "supersecret123";
 const z = 3;`;
    const findings = scanPatchForSecrets("src/config.ts", patch);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].description).toMatch(/password/i);
  });

  it("detects AWS access key pattern", () => {
    const patch = `+const key = "AKIAIOSFODNN7EXAMPLE1234";`;
    const findings = scanPatchForSecrets("src/aws.ts", patch);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("does NOT flag removed lines (lines starting with -)", () => {
    const patch = `-const password = "oldpassword123";`;
    const findings = scanPatchForSecrets("src/config.ts", patch);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array when patch is undefined", () => {
    const findings = scanPatchForSecrets("src/app.ts", undefined);
    expect(findings).toHaveLength(0);
  });

  it("returns empty array for clean patch", () => {
    const patch = `+const x = process.env.MY_TOKEN;`;
    const findings = scanPatchForSecrets("src/config.ts", patch);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// sortFindings
// ---------------------------------------------------------------------------

describe("sortFindings", () => {
  it("sorts by severity with critical first", () => {
    const findings = [
      { severity: "low" as const, category: "A", description: "low" },
      { severity: "critical" as const, category: "B", description: "critical" },
      { severity: "high" as const, category: "C", description: "high" },
      { severity: "medium" as const, category: "D", description: "medium" },
    ];
    const sorted = sortFindings(findings);
    expect(sorted[0].severity).toBe("critical");
    expect(sorted[1].severity).toBe("high");
    expect(sorted[2].severity).toBe("medium");
    expect(sorted[3].severity).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Legacy CODEOWNERS exports
// ---------------------------------------------------------------------------

describe("legacy CODEOWNERS exports", () => {
  it("keeps old named helpers importable and preserves ownership finding behavior", () => {
    const rules: CodeownersRule[] = parseCodeowners("/src/tools/ @owner1\n");

    expect(codeownersPatternMatches("/src/tools/", "src/tools/x.ts")).toBe(true);
    expect(ownersForFile("src/tools/x.ts", rules)).toEqual(["@owner1"]);
    expect(fetchCodeownersRules).toBeTypeOf("function");
    expect(
      generateOwnershipFindings(
        [makeFile({ filename: "src/tools/x.ts" })],
        rules,
        [],
        [],
        [],
        "someone-else"
      )
    ).toEqual([
      {
        severity: "medium",
        category: "Ownership",
        description:
          "CODEOWNERS owner @owner1 was not requested as a reviewer and has not reviewed changes to: src/tools/x.ts.",
        suggestion:
          "Request a review from @owner1, or confirm CODEOWNERS routing is still correct for these paths.",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// handleReviewPr — integration with mock octokit
// ---------------------------------------------------------------------------

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeMockOctokit(opts: {
  codeownersContent?: string;
  contentError?: unknown;
  requestedReviewers?: { users?: Array<{ login: string }>; teams?: Array<{ slug: string }> };
  reviewers?: unknown;
  requestedReviewersError?: unknown;
  reviewsError?: unknown;
  prAuthor?: string;
}) {
  return {
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          title: "Test PR",
          body: "A sufficiently long description for basic checks to pass cleanly.",
          draft: false,
          commits: 1,
          user: { login: opts.prAuthor ?? "pr-author" },
        },
      }),
      listFiles: vi.fn().mockResolvedValue({
        data: [
          { filename: "src/tools/review-pr.ts", status: "modified", additions: 10, deletions: 2 },
          { filename: "src/__tests__/tools/review-pr.test.ts", status: "modified", additions: 20, deletions: 0 },
        ],
      }),
      listRequestedReviewers: opts.requestedReviewersError
        ? vi.fn().mockRejectedValue(opts.requestedReviewersError)
        : vi.fn().mockResolvedValue({ data: opts.requestedReviewers ?? { users: [], teams: [] } }),
      listReviews: opts.reviewsError
        ? vi.fn().mockRejectedValue(opts.reviewsError)
        : vi.fn().mockResolvedValue({ data: opts.reviewers ?? [] }),
    },
    repos: {
      getContent: opts.contentError
        ? vi.fn().mockRejectedValue(opts.contentError)
        : vi.fn().mockImplementation(({ path }: { path: string }) => {
            if (path === ".github/CODEOWNERS" && opts.codeownersContent !== undefined) {
              return Promise.resolve({
                data: {
                  type: "file",
                  content: Buffer.from(opts.codeownersContent).toString("base64"),
                },
              });
            }
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          }),
    },
  } as unknown as Parameters<typeof handleReviewPr>[2];
}

const BASE_PARAMS: ReviewPrInput = {
  pullNumber: 42,
  standard: "basic",
  checkOwnership: true,
};

describe("handleReviewPr — ownership check", () => {
  it("reports codeownersFound=false and raises no Ownership findings when no CODEOWNERS file exists", async () => {
    const octokit = makeMockOctokit({ contentError: Object.assign(new Error("Not Found"), { status: 404 }) });
    const { structured } = await handleReviewPr(BASE_PARAMS, REF, octokit);
    expect(structured.codeownersFound).toBe(false);
    expect(structured.findings.find((f) => f.category === "Ownership")).toBeUndefined();
  });

  it("flags an owner who was not requested and has not reviewed", async () => {
    const octokit = makeMockOctokit({
      codeownersContent: "/src/tools/ @owner1\n",
      prAuthor: "someone-else",
    });
    const { structured } = await handleReviewPr(BASE_PARAMS, REF, octokit);
    expect(structured.codeownersFound).toBe(true);
    const ownershipFinding = structured.findings.find((f) => f.category === "Ownership");
    expect(ownershipFinding).toBeDefined();
    expect(ownershipFinding!.description).toContain("@owner1");
  });

  it("does not flag an owner who was requested as a reviewer", async () => {
    const octokit = makeMockOctokit({
      codeownersContent: "/src/tools/ @owner1\n",
      prAuthor: "someone-else",
      requestedReviewers: { users: [{ login: "owner1" }], teams: [] },
    });
    const { structured } = await handleReviewPr(BASE_PARAMS, REF, octokit);
    expect(structured.findings.find((f) => f.category === "Ownership")).toBeUndefined();
  });

  it("skips the ownership check entirely when checkOwnership is false", async () => {
    const octokit = makeMockOctokit({ codeownersContent: "/src/tools/ @owner1\n", prAuthor: "someone-else" });
    const { structured } = await handleReviewPr({ ...BASE_PARAMS, checkOwnership: false }, REF, octokit);
    expect(structured.codeownersFound).toBe(false);
    expect(structured.findings.find((f) => f.category === "Ownership")).toBeUndefined();
  });

  it("records an error but does not throw when listRequestedReviewers fails", async () => {
    const octokit = makeMockOctokit({
      codeownersContent: "/src/tools/ @owner1\n",
      prAuthor: "someone-else",
      requestedReviewersError: Object.assign(new Error("Forbidden"), { status: 403 }),
    });
    const { structured } = await handleReviewPr(BASE_PARAMS, REF, octokit);
    expect(structured.errors.some((e) => e.startsWith("Requested reviewers:"))).toBe(true);
    // Still flags ownership since we couldn't confirm owner1 was requested
    expect(structured.findings.find((f) => f.category === "Ownership")).toBeDefined();
  });

  it("records an error but does not throw when listReviews fails, independently of listRequestedReviewers", async () => {
    const octokit = makeMockOctokit({
      codeownersContent: "/src/tools/ @owner1\n",
      prAuthor: "someone-else",
      requestedReviewers: { users: [{ login: "owner1" }], teams: [] },
      reviewsError: Object.assign(new Error("Service Unavailable"), { status: 503 }),
    });
    const { structured } = await handleReviewPr(BASE_PARAMS, REF, octokit);
    expect(structured.errors.some((e) => e.startsWith("Reviews:"))).toBe(true);
    // requestedReviewers still succeeded independently, so owner1 is still not flagged
    expect(structured.findings.find((f) => f.category === "Ownership")).toBeUndefined();
  });
});

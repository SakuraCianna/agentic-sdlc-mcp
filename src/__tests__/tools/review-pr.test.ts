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
    expect(findings[0].description).toMatch(/credential|secret/i);
  });

  it("does not flag the AWS documentation example placeholder", () => {
    const patch = `+const key = "AKIAIOSFODNN7EXAMPLE";`;
    const findings = scanPatchForSecrets("src/aws.ts", patch);
    expect(findings).toHaveLength(0);
  });

  it("detects a quoted JSON credential key through the shared scanner", () => {
    const syntheticValue = ["live", "1234567890abcdef"].join("_");
    const patch = `+  "apiKey": "${syntheticValue}",`;
    const findings = scanPatchForSecrets("config/service.json", patch);
    expect(findings).toContainEqual(
      expect.objectContaining({ severity: "high", category: "Security" })
    );
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
  checkRuns?: Array<{
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    details_url: string | null;
    app: { id: number } | null;
  }>;
  checkRunsError?: unknown;
  commitStatuses?: Array<{
    context: string;
    state: string;
    target_url: string | null;
  }>;
  files?: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
  }>;
  filePages?: Array<
    Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
      previous_filename?: string;
    }>
  >;
  workflowContents?: Record<string, string>;
  workflowContentError?: unknown;
  prDraft?: boolean;
  commits?: number;
}) {
  return {
    checks: {
      listForRef: opts.checkRunsError
        ? vi.fn().mockRejectedValue(opts.checkRunsError)
        : vi.fn().mockResolvedValue({
            data: { check_runs: opts.checkRuns ?? [], total_count: opts.checkRuns?.length ?? 0 },
          }),
    },
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          number: 42,
          title: "Test PR",
          body: "A sufficiently long description for basic checks to pass cleanly.",
          draft: opts.prDraft ?? false,
          commits: opts.commits ?? 1,
          user: { login: opts.prAuthor ?? "pr-author" },
          head: { sha: "head-sha", ref: "feature/review" },
          base: { sha: "base-sha", ref: "main" },
          mergeable: true,
          labels: [],
        },
      }),
      listFiles: vi.fn().mockImplementation(({ page = 1 }: { page?: number }) =>
        Promise.resolve({
          data: opts.filePages
            ? (opts.filePages[page - 1] ?? [])
            : page === 1
              ? (opts.files ??
                [
                  {
                    filename: "src/tools/review-pr.ts",
                    status: "modified",
                    additions: 10,
                    deletions: 2,
                  },
                  {
                    filename: "src/__tests__/tools/review-pr.test.ts",
                    status: "modified",
                    additions: 20,
                    deletions: 0,
                  },
                ])
              : [],
        })
      ),
      listRequestedReviewers: opts.requestedReviewersError
        ? vi.fn().mockRejectedValue(opts.requestedReviewersError)
        : vi.fn().mockResolvedValue({ data: opts.requestedReviewers ?? { users: [], teams: [] } }),
      listReviews: opts.reviewsError
        ? vi.fn().mockRejectedValue(opts.reviewsError)
        : vi.fn().mockResolvedValue({ data: opts.reviewers ?? [] }),
    },
    repos: {
      getCombinedStatusForRef: vi.fn().mockResolvedValue({
        data: { statuses: opts.commitStatuses ?? [] },
      }),
      getBranchProtection: vi.fn().mockRejectedValue(
        Object.assign(new Error("Not Found"), { status: 404 })
      ),
      getBranchRules: vi.fn().mockResolvedValue({ data: [] }),
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
            if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) {
              if (opts.workflowContentError) return Promise.reject(opts.workflowContentError);
              return Promise.resolve({
                data: {
                  type: "file",
                  content: Buffer.from(
                    opts.workflowContents?.[path] ??
                      "permissions:\n  contents: read\njobs:\n  test:\n    steps: []"
                  ).toString("base64"),
                },
              });
            }
            return Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));
          }),
    },
    graphql: vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewDecision: null,
          closingIssuesReferences: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    }),
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

describe("handleReviewPr — structured review contract", () => {
  it("maps draft and large commit-count compatibility checks into structured findings", async () => {
    const { structured } = await handleReviewPr(
      { ...BASE_PARAMS, checkOwnership: false },
      REF,
      makeMockOctokit({ prDraft: true, commits: 21 })
    );

    expect(structured.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "Status", severity: "info", dimension: "scope" }),
        expect.objectContaining({ category: "Hygiene", severity: "low", dimension: "scope" }),
      ])
    );
  });

  it("fails closed for every standard when changed files are truncated before a hidden workflow", async () => {
    const ordinaryPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        filename: `src/generated/file-${page}-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
      }));
    const octokit = makeMockOctokit({
      filePages: [
        ordinaryPage(1),
        ordinaryPage(2),
        ordinaryPage(3),
        [
          {
            filename: ".github/workflows/hidden.yml",
            status: "added",
            additions: 1,
            deletions: 0,
          },
        ],
      ],
    });

    const { structured } = await handleReviewPr(
      { ...BASE_PARAMS, standard: "basic", checkOwnership: false },
      REF,
      octokit
    );

    expect(octokit.pulls.listFiles).toHaveBeenCalledTimes(4);
    expect(structured.findings).toContainEqual(
      expect.objectContaining({
        category: "WorkflowPolicyEvidenceUnavailable",
        severity: "high",
        dimension: "policy",
      })
    );
    expect(structured.conclusion).toBe("needs_changes");
  });
  it("accepts an explicit workType and preserves legacy fields", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          filename: "src/fix.ts",
          status: "modified",
          additions: 5,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-return false\n+return true",
        },
      ],
    });

    const { structured } = await handleReviewPr(
      { ...BASE_PARAMS, workType: "bugfix" },
      REF,
      octokit
    );

    expect(structured).toMatchObject({
      pullNumber: 42,
      title: "Test PR",
      standard: "basic",
      workType: "bugfix",
      workTypeConfidence: "high",
      workTypeReasoning: expect.any(String),
      releaseRisk: "high",
      testCoverageSignal: "missing",
      ownershipRoutingGaps: expect.any(Array),
      conclusion: expect.any(String),
      hasTests: expect.any(Boolean),
      totalChangedLines: expect.any(Number),
      codeownersFound: expect.any(Boolean),
      errors: expect.any(Array),
      secretScannerEvidence: null,
    });
    expect(structured.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: expect.any(String),
          paths: expect.any(Array),
          reason: expect.any(String),
        }),
      ])
    );
  });

  it("infers work type, lists changed files once, and audits complete workflow content at head SHA", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          filename: ".github/workflows/ci.yml",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-permissions: write-all\n+permissions:\n+  contents: read",
        },
      ],
    });

    const { structured, text } = await handleReviewPr(
      { ...BASE_PARAMS, standard: "strict", checkOwnership: false },
      REF,
      octokit
    );

    expect(structured.workType).toBe("infra");
    expect(octokit.pulls.listFiles).toHaveBeenCalledTimes(1);
    expect(octokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".github/workflows/ci.yml",
        ref: "head-sha",
      })
    );
    expect(text).toContain("## Work Type");
    expect(text).toContain("## Intent / Scope / Evidence");
    expect(text).toContain("## Ownership");
    expect(text).toContain("## Policy");
    expect(text).toContain("## Fallback");
    expect(text).toContain("## Security");
    expect(text).toContain("## Test Coverage");
    expect(text).toContain("## Release Risk");
    expect(text).toContain("## Conclusion");
  });

  it("uses complete workflow content rather than a safe-looking patch for permission findings", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          filename: ".github/workflows/release.yml",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-name: Old\n+name: Release",
        },
      ],
      workflowContents: {
        ".github/workflows/release.yml":
          "on: pull_request_target\npermissions: write-all\njobs: {}",
      },
    });

    const { structured } = await handleReviewPr(
      { ...BASE_PARAMS, standard: "strict", checkOwnership: false },
      REF,
      octokit
    );

    expect(structured.findings).toContainEqual(
      expect.objectContaining({
        category: "Workflow Permissions",
        severity: "critical",
        dimension: "policy",
        paths: [".github/workflows/release.yml"],
      })
    );
    expect(structured.releaseRisk).toBe("critical");
    expect(structured.conclusion).toBe("needs_changes");
  });

  it("fails closed when complete workflow content cannot be verified", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          filename: ".github/workflows/release.yml",
          status: "modified",
          additions: 1,
          deletions: 0,
        },
      ],
      workflowContentError: Object.assign(new Error("Forbidden"), { status: 403 }),
    });

    const { structured } = await handleReviewPr(
      { ...BASE_PARAMS, standard: "strict", checkOwnership: false },
      REF,
      octokit
    );

    expect(structured.findings).toContainEqual(
      expect.objectContaining({
        category: "WorkflowPolicyEvidenceUnavailable",
        severity: "high",
        dimension: "policy",
        paths: [".github/workflows/release.yml"],
      })
    );
    expect(structured.conclusion).toBe("needs_changes");
  });
});

describe("handleReviewPr — mature secret scanner evidence", () => {
  const securityParams: ReviewPrInput = {
    pullNumber: 42,
    standard: "security-focused",
    checkOwnership: false,
  };

  it("fails closed and exposes unverified evidence when no mature scanner ran", async () => {
    const octokit = makeMockOctokit({});

    const { structured, text } = await handleReviewPr(securityParams, REF, octokit);

    expect(structured.secretScannerEvidence).toMatchObject({
      status: "unverified",
      verified: false,
      providers: [],
    });
    expect(structured.findings).toContainEqual(
      expect.objectContaining({ category: "MissingMatureSecretScannerEvidence", severity: "high" })
    );
    expect(structured.conclusion).toBe("needs_changes");
    expect(text).toContain("Mature Secret Scanner Evidence");
  });

  it("accepts a passing Gitleaks check as verified mature scanner evidence", async () => {
    const octokit = makeMockOctokit({
      checkRuns: [
        {
          id: 1,
          name: "gitleaks",
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/checks/1",
          app: { id: 15368 },
        },
      ],
    });

    const { structured } = await handleReviewPr(securityParams, REF, octokit);

    expect(structured.secretScannerEvidence).toMatchObject({
      status: "passing",
      verified: true,
      providers: ["gitleaks"],
    });
    expect(
      structured.findings.some((finding) => finding.category === "MissingMatureSecretScannerEvidence")
    ).toBe(false);
  });

  it("turns a failing TruffleHog check into a critical blocker", async () => {
    const octokit = makeMockOctokit({
      checkRuns: [
        {
          id: 2,
          name: "TruffleHog Secrets Scan",
          status: "completed",
          conclusion: "failure",
          details_url: "https://github.com/checks/2",
          app: { id: 15368 },
        },
      ],
    });

    const { structured } = await handleReviewPr(securityParams, REF, octokit);

    expect(structured.secretScannerEvidence?.status).toBe("failing");
    expect(structured.findings).toContainEqual(
      expect.objectContaining({ category: "MatureSecretScannerFailed", severity: "critical" })
    );
    expect(structured.conclusion).toBe("needs_changes");
  });

  it("does not accept a same-name passing commit status when check-runs are unavailable", async () => {
    const octokit = makeMockOctokit({
      checkRunsError: Object.assign(new Error("Forbidden"), { status: 403 }),
      commitStatuses: [
        {
          context: "gitleaks",
          state: "success",
          target_url: "https://example.test/status/1",
        },
      ],
    });

    const { structured } = await handleReviewPr(securityParams, REF, octokit);

    expect(structured.secretScannerEvidence).toMatchObject({
      status: "unverified",
      verified: false,
      degraded: true,
    });
    expect(structured.findings).toContainEqual(
      expect.objectContaining({ category: "MissingMatureSecretScannerEvidence", severity: "high" })
    );
    expect(structured.errors.some((error) => error.startsWith("Secret scanner CI:"))).toBe(true);
  });

  it("does not trust a passing scanner when the PR changes workflow policy", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          filename: ".github/workflows/secret-scan.yml",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
      checkRuns: [
        {
          id: 3,
          name: "gitleaks",
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/checks/3",
          app: { id: 15368 },
        },
      ],
    });

    const { structured } = await handleReviewPr(securityParams, REF, octokit);

    expect(structured.secretScannerEvidence).toMatchObject({
      status: "unverified",
      verified: false,
      degraded: true,
    });
    expect(structured.secretScannerEvidence?.reason).toMatch(/policy/i);
  });

  it("fails closed when the changed-file list is truncated before a policy file", async () => {
    const ordinaryPage = (page: number) =>
      Array.from({ length: 100 }, (_, index) => ({
        filename: `src/generated/file-${page}-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 0,
      }));
    const octokit = makeMockOctokit({
      filePages: [
        ordinaryPage(1),
        ordinaryPage(2),
        ordinaryPage(3),
        [
          {
            filename: ".github/workflows/secret-scan.yml",
            status: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
      ],
      checkRuns: [
        {
          id: 4,
          name: "gitleaks",
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/checks/4",
          app: { id: 15368 },
        },
      ],
    });

    const { structured } = await handleReviewPr(securityParams, REF, octokit);

    expect(octokit.pulls.listFiles).toHaveBeenCalledTimes(4);
    expect(structured.secretScannerEvidence).toMatchObject({
      status: "unverified",
      verified: false,
      degraded: true,
    });
    expect(structured.secretScannerEvidence?.reason).toMatch(/changed_files/i);
  });

  it("fails closed when a scanner policy file is renamed out of its protected path", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          filename: "docs/retired-secret-scan.yml",
          previous_filename: ".github/workflows/secret-scan.yml",
          status: "renamed",
          additions: 0,
          deletions: 0,
        },
      ],
      checkRuns: [
        {
          id: 5,
          name: "gitleaks",
          status: "completed",
          conclusion: "success",
          details_url: "https://github.com/checks/5",
          app: { id: 15368 },
        },
      ],
    });

    const { structured } = await handleReviewPr(securityParams, REF, octokit);

    expect(structured.secretScannerEvidence).toMatchObject({
      status: "unverified",
      verified: false,
      degraded: true,
    });
    expect(structured.secretScannerEvidence?.reason).toMatch(/policy/i);
  });
});

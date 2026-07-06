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
} = await import("../../tools/review-pr.js");

import type { PrFile, PrMeta } from "../../tools/review-pr.js";

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

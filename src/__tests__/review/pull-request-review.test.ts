import { describe, expect, it } from "vitest";

import {
  classifyPrFiles,
  evaluatePullRequestReview,
  inferWorkType,
  scanPatchForSecrets,
  type PrFile,
  type ReviewPrMeta,
} from "../../review/pull-request-review.js";

function file(filename: string, overrides: Partial<PrFile> = {}): PrFile {
  return {
    filename,
    status: "modified",
    additions: 5,
    deletions: 2,
    changes: 7,
    ...overrides,
  };
}

function pr(overrides: Partial<ReviewPrMeta> = {}): ReviewPrMeta {
  return {
    title: "Implement repository reporting",
    body: "Adds repository reporting with a focused implementation and review notes.",
    labels: [],
    ...overrides,
  };
}

describe("classifyPrFiles", () => {
  it("normalizes Windows paths and classifies representative high-risk files", () => {
    const result = classifyPrFiles([
      file("docs\\guide.md"),
      file("src\\__tests__\\service.test.ts"),
      file("src\\__tests__\\__snapshots__\\service.test.ts.snap"),
      file(".github\\workflows\\release.yml"),
      file("src\\auth\\token-service.ts"),
      file("scripts\\publish.ts"),
      file("package-lock.json"),
      file(".env.production"),
    ]);

    expect(result.docsFiles.map((entry) => entry.filename)).toContain("docs/guide.md");
    expect(result.testFiles.map((entry) => entry.filename)).toContain(
      "src/__tests__/service.test.ts"
    );
    expect(result.snapshotTestFiles).toHaveLength(1);
    expect(result.nonSnapshotTestFiles).toHaveLength(1);
    expect(result.workflowFiles).toHaveLength(1);
    expect(result.authSecurityFiles).toHaveLength(2);
    expect(result.releaseFiles).toHaveLength(2);
    expect(result.lockFiles).toHaveLength(1);
    expect(result.envFiles).toHaveLength(1);
  });

  it("does not classify a mixed docs and source change as docs-only", () => {
    const result = classifyPrFiles([file("README.md"), file("src/index.ts")]);

    expect(result.docsOnly).toBe(false);
  });
});

describe("inferWorkType", () => {
  it("prioritizes security signals over release signals", () => {
    const result = inferWorkType(
      pr({ title: "Security release", labels: ["release", "security"] }),
      [file("scripts/publish.ts")]
    );

    expect(result.workType).toBe("security");
    expect(result.confidence).toBe("high");
    expect(result.reasoning).toMatch(/security/i);
  });

  it("recognizes an explicit security signal in the PR body", () => {
    const result = inferWorkType(
      pr({ body: "This security hardening closes an authorization weakness." }),
      [file("src/middleware.ts")]
    );

    expect(result.workType).toBe("security");
  });

  it("prioritizes a release path over a workflow path", () => {
    const result = inferWorkType(pr(), [
      file("scripts/publish.ts"),
      file(".github/workflows/release.yml"),
    ]);

    expect(result.workType).toBe("release");
    expect(result.confidence).toBe("high");
  });

  it("classifies workflow and infrastructure paths as infra before docs-only", () => {
    const result = inferWorkType(pr(), [
      file(".github/workflows/ci.yml"),
      file("docs/ci.md"),
    ]);

    expect(result.workType).toBe("infra");
    expect(result.confidence).toBe("high");
  });

  it("classifies an all-documentation change as docs", () => {
    const result = inferWorkType(pr(), [file("README.md"), file("docs/guide.rst")]);

    expect(result.workType).toBe("docs");
    expect(result.confidence).toBe("high");
  });

  it("uses conservative bug signals from labels, title, or body", () => {
    expect(inferWorkType(pr({ labels: ["bug"] }), [file("src/index.ts")]).workType).toBe(
      "bugfix"
    );
    expect(
      inferWorkType(pr({ title: "Fix parser regression" }), [file("src/index.ts")]).workType
    ).toBe("bugfix");
    expect(
      inferWorkType(pr({ body: "Resolves a reproducible crash in the parser." }), [
        file("src/index.ts"),
      ]).workType
    ).toBe("bugfix");
    expect(
      inferWorkType(pr({ body: "This change addresses a bug in the parser." }), [
        file("src/index.ts"),
      ]).workType
    ).toBe("bugfix");
  });

  it("classifies refactor signals after bugfix signals", () => {
    const result = inferWorkType(
      pr({ title: "Refactor parser", labels: ["bug", "refactor"] }),
      [file("src/index.ts")]
    );

    expect(result.workType).toBe("bugfix");
  });

  it("defaults to a low-confidence feature", () => {
    const result = inferWorkType(pr(), [file("src/index.ts")]);

    expect(result).toMatchObject({ workType: "feature", confidence: "low" });
    expect(result.reasoning.length).toBeGreaterThan(0);
  });
});

describe("scanPatchForSecrets", () => {
  it("reports an assignment-like secret only on an added line and includes its path", () => {
    const findings = scanPatchForSecrets(
      "src/config.ts",
      '@@ -1,2 +1,3 @@\n const before = true;\n+const apiKey = "live_1234567890abcdef";\n const after = true;'
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "high",
      dimension: "security",
      paths: ["src/config.ts"],
    });
  });

  it("detects an indented JSON or YAML-style credential assignment", () => {
    const findings = scanPatchForSecrets(
      "config/service.yml",
      '+  client_secret: "live_1234567890abcdef"'
    );

    expect(findings).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", paths: ["config/service.yml"] })
    );
  });

  it("ignores removed assignments, context lines, prose keywords, placeholders, and env references", () => {
    const findings = scanPatchForSecrets(
      "docs/security.md",
      [
        '-const token = "real-looking-token-value";',
        'const password = "context-value-that-is-not-added";',
        "+Document how secret and token rotation works.",
        '+const token = "YOUR_TOKEN_HERE";',
        "+const apiKey = process.env.API_KEY;",
      ].join("\n")
    );

    expect(findings).toEqual([]);
  });
});

describe("evaluatePullRequestReview", () => {
  it("accepts explicit docs verification without requiring code tests", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Verification\nRan `npx markdownlint README.md` successfully." }),
      files: [file("README.md")],
      workType: "docs",
    });

    expect(result.testCoverageSignal).toBe("not_required");
    expect(result.findings.some((finding) => finding.category === "MissingDocsVerification")).toBe(
      false
    );
  });

  it("does not accept the vague word tested as docs verification", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "The documentation was tested and looks fine." }),
      files: [file("docs/guide.md")],
      workType: "docs",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingDocsVerification", dimension: "evidence" })
    );
  });

  it("reports a high finding when a feature has neither tests nor a qualified no-test reason", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "Implements the requested behavior. No tests: trivial." }),
      files: [file("src/service.ts")],
      workType: "feature",
    });

    expect(result.testCoverageSignal).toBe("missing");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingTests", severity: "high" })
    );
  });

  it("accepts a specific no-test reason for a feature", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body: "Testing not required: this changes a repository comment with no executable behavior.",
      }),
      files: [file("src/constants.ts")],
      workType: "feature",
    });

    expect(result.testCoverageSignal).toBe("not_required");
    expect(result.findings.some((finding) => finding.category === "MissingTests")).toBe(false);
  });

  it("reports missing reproduction and regression tests for a bugfix", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "Fixes the parser crash for malformed input." }),
      files: [file("src/parser.ts")],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("missing");
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "MissingReproduction", severity: "high" }),
        expect.objectContaining({ category: "MissingRegressionTest", severity: "high" }),
      ])
    );
  });

  it("does not accept snapshot-only tests as bugfix regression evidence", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [file("src/parser.ts"), file("src/__snapshots__/parser.test.ts.snap")],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingRegressionTest", severity: "high" })
    );
  });

  it("recognizes a non-snapshot regression test and explicit reproduction", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Steps to reproduce\nBefore: malformed input crashed the parser." }),
      files: [file("src/parser.ts"), file("src/__tests__/parser.test.ts")],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("adequate");
    expect(result.findings.some((finding) => finding.category === "MissingRegressionTest")).toBe(
      false
    );
  });

  it.each([
    [".github/workflows/ci.yml", "infra"],
    ["src/auth/session.ts", "feature"],
    ["scripts/release.ts", "release"],
    ["package-lock.json", "feature"],
  ] as const)("raises release risk for %s", (filename, workType) => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "## Verification\nRan `npm test`.\n## Rollback\nRevert this commit and redeploy the prior artifact.",
      }),
      files: [file(filename), file("src/__tests__/change.test.ts")],
      workType,
    });

    expect(result.releaseRisk).toBe("high");
  });

  it("reports critical risk for an environment file change", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Verification\nRan `npm test`." }),
      files: [file(".env.production")],
      workType: "security",
      standard: "security-focused",
    });

    expect(result.releaseRisk).toBe("critical");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "critical", dimension: "security" })
    );
  });

  it("reports high risk when a high-severity secret finding is present", () => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [
        file("src/config.ts", {
          patch: '+const password = "actual-looking-password";',
        }),
      ],
      workType: "feature",
      standard: "security-focused",
    });

    expect(result.releaseRisk).toBe("high");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "high", category: "SecretLikeAssignment" })
    );
  });

  it("adds a structured scope finding for a large strict review", () => {
    const strict = evaluatePullRequestReview({
      pr: pr(),
      files: [
        file("src/service.ts", { additions: 700, deletions: 200, changes: 900 }),
        file("src/__tests__/service.test.ts"),
      ],
      workType: "feature",
      standard: "strict",
    });
    const basic = evaluatePullRequestReview({
      pr: pr(),
      files: [
        file("src/service.ts", { additions: 700, deletions: 200, changes: 900 }),
        file("src/__tests__/service.test.ts"),
      ],
      workType: "feature",
      standard: "basic",
    });

    expect(strict.findings).toContainEqual(
      expect.objectContaining({ category: "LargeChangeScope", dimension: "scope" })
    );
    expect(basic.findings.some((finding) => finding.category === "LargeChangeScope")).toBe(false);
  });

  it("requires a detailed fallback for release and infrastructure work", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Verification\nRan `npm test`.\nRollback:" }),
      files: [file("scripts/publish.ts"), file("src/__tests__/publish.test.ts")],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingFallback", dimension: "fallback" })
    );
  });

  it("requires security work to document security validation", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "Threat: stolen session. Permissions stay least-privilege. Tokens remain in the secret store.",
      }),
      files: [file("src/auth/session.ts"), file("src/__tests__/session.test.ts")],
      workType: "security",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingSecurityValidation", dimension: "security" })
    );
  });

  it("requires release work to identify the version being released", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "## Verification\nRan `npm test`.\n## Rollback\nRevert the release commit and restore the prior artifact.",
      }),
      files: [file("scripts/publish.ts"), file("src/__tests__/publish.test.ts")],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingReleaseVersion", dimension: "policy" })
    );
  });

  it("requires workflow work to document triggers and failure behavior", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "## Verification\nRan `npm test`.\n## Rollback\nRevert the workflow commit and restore the prior file.",
      }),
      files: [file(".github/workflows/ci.yml"), file("src/__tests__/ci.test.ts")],
      workType: "infra",
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "MissingWorkflowTrigger", dimension: "policy" }),
        expect.objectContaining({ category: "MissingWorkflowFailurePath", dimension: "fallback" }),
      ])
    );
  });

  it("returns complete structured fields for every finding", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "tested" }),
      files: [file("src/service.ts")],
      workType: "feature",
    });

    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.dimension).toMatch(
        /^(intent|scope|evidence|ownership|policy|fallback|security)$/
      );
      expect(finding.paths).toBeInstanceOf(Array);
      expect(finding.reason.trim().length).toBeGreaterThan(0);
      expect(finding.suggestion?.trim().length).toBeGreaterThan(0);
    }
  });

  it("derives moderate risk from medium-only findings and low risk when clean", () => {
    const moderate = evaluatePullRequestReview({
      pr: pr({ body: "Documentation changed without a verification section." }),
      files: [file("README.md")],
      workType: "docs",
    });
    const low = evaluatePullRequestReview({
      pr: pr({ body: "## Validated\nRan `npx markdownlint README.md`." }),
      files: [file("README.md")],
      workType: "docs",
    });

    expect(moderate.releaseRisk).toBe("moderate");
    expect(low.releaseRisk).toBe("low");
  });
});

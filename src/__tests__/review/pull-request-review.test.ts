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

  it("detects an unquoted dotenv-style credential assignment", () => {
    const findings = scanPatchForSecrets(".env.example", "+API_TOKEN=ghp_1234567890abcdef");

    expect(findings).toContainEqual(
      expect.objectContaining({
        category: "SecretLikeAssignment",
        severity: "high",
        paths: [".env.example"],
      })
    );
  });

  it.each([
    "+API_TOKEN=github_pat_11AA22BB33CC44DD55EE",
    "+OPENAI_API_KEY=sk-1234567890abcdefghijklmnop",
    "+SLACK_TOKEN=xoxb-1234567890-abcdefghijkl",
    "+JWT_TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123",
    "+PRIVATE_KEY=Ab9!xQ2#mN7$pL4@vR8%",
  ])("detects a high-confidence unquoted credential literal %s", (patch) => {
    expect(scanPatchForSecrets("config/service.env", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it.each([
    "+API_TOKEN=config.token",
    "+API_TOKEN=getToken()",
    "+API_TOKEN=undefined",
    "+API_TOKEN=null",
    "+API_TOKEN=true",
    "+API_TOKEN=TOKEN_IDENTIFIER",
    "+API_TOKEN=veryLongTokenIdentifier2",
    "+// API_TOKEN=ghp_1234567890abcdef",
    "+# API_TOKEN=ghp_1234567890abcdef",
    "+/* API_TOKEN=ghp_1234567890abcdef */",
    "+* API_TOKEN=ghp_1234567890abcdef",
  ])("ignores unquoted expressions and commented assignments %s", (patch) => {
    expect(scanPatchForSecrets("config/service.env", patch)).toEqual([]);
  });

  it("ignores assignments inside an added block comment", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+/* credentials for local setup\n+API_TOKEN=ghp_1234567890abcdef\n+*/"
      )
    ).toEqual([]);
  });

  it.each([
    "+API_TOKEN=REDACTED",
    "+API_TOKEN=fake-token-value",
    "+API_TOKEN=dummy-token-value",
    "+API_TOKEN=example-token-value",
    "+API_TOKEN=placeholder-token",
    "+API_TOKEN=changeme-now",
    "+API_TOKEN=your-token-here",
    "+API_TOKEN=xxxxxxxxxxxxxxxx",
    "+API_TOKEN=${API_TOKEN}",
    "+const token = process.env.API_TOKEN;",
    "+token: secrets.API_TOKEN",
  ])("ignores placeholder or indirect secret value %s", (patch) => {
    expect(scanPatchForSecrets("config/service.env", patch)).toEqual([]);
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

  it("does not let a later heading supply detail for an empty verification section", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Verification\n## Notes\nRan `npx markdownlint docs/guide.md`." }),
      files: [file("docs/guide.md")],
      workType: "docs",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingDocsVerification", severity: "medium" })
    );
  });

  it("requires a concrete docs verification method even inside the right section", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Verification\nEverything looks good and the docs were tested." }),
      files: [file("docs/guide.md")],
      workType: "docs",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
  });

  it.each([
    "## Verification\nRendered the documentation site and inspected the changed page.",
    "## Verification\nChecked README links with the repository link checker.",
    "## Verification\nBuilt the documentation examples with `npm run docs:build`.",
  ])("accepts a concrete docs verification method: %s", (body) => {
    const result = evaluatePullRequestReview({
      pr: pr({ body }),
      files: [file("docs/guide.md")],
      workType: "docs",
    });

    expect(result.testCoverageSignal).toBe("not_required");
  });

  it("accepts a specific manual Markdown validation", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Validated\nValidated Markdown formatting and headings manually." }),
      files: [file("docs/guide.md")],
      workType: "docs",
    });

    expect(result.testCoverageSignal).toBe("not_required");
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

  it("does not accept snapshot matchers in an ordinary test file as regression evidence", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts", { patch: "+return parseSafely(input);" }),
        file("src/__tests__/parser.test.ts", {
          patch:
            '+expect(parseSafely("bad")).toMatchInlineSnapshot(`"invalid"`);\n+expect(output).toMatchSnapshot();',
        }),
        file("src/__tests__/__snapshots__/parser.test.ts.snap", {
          patch: '+exports[`parser 1`] = `"invalid"`;',
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingRegressionTest", severity: "high" })
    );
  });

  it.each(["toMatchFileSnapshot", "toThrowErrorMatchingSnapshot"])(
    "rejects any snapshot-named matcher: %s",
    (matcher) => {
      const result = evaluatePullRequestReview({
        pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
        files: [
          file("src/parser.ts"),
          file("src/__tests__/parser.test.ts", {
            patch: `+expect(parseSafely("bad")).${matcher}();`,
          }),
        ],
        workType: "bugfix",
      });

      expect(result.testCoverageSignal).toBe("insufficient_evidence");
      expect(result.findings).toContainEqual(
        expect.objectContaining({ category: "MissingRegressionTest", severity: "high" })
      );
    }
  );

  it.each([
    "+// expect(parseSafely(input)).toEqual({ ok: false });",
    "+/* expect(parseSafely(input)).toEqual({ ok: false }); */",
    '+const example = "expect(parseSafely(input)).toEqual({ ok: false })";',
  ])("ignores assertion-like text in comments or strings: %s", (patch) => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [file("src/parser.ts"), file("src/__tests__/parser.test.ts", { patch })],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
  });

  it("does not infer regression evidence from a test filename when its patch is unavailable", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [file("src/parser.ts"), file("src/__tests__/parser.test.ts", { patch: undefined })],
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
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", {
          patch: '+expect(parseSafely("bad")).toEqual({ ok: false });',
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("adequate");
    expect(result.findings.some((finding) => finding.category === "MissingRegressionTest")).toBe(
      false
    );
  });

  it("accepts common Node assert regression evidence", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("test/parser.test.ts", {
          patch: '+assert.deepStrictEqual(parseSafely("bad"), { ok: false });',
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("adequate");
  });

  it("accepts a multiline non-snapshot expect assertion", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", {
          patch: '+expect(parseSafely("bad"))\n+  .toEqual({ ok: false });',
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("adequate");
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

  it("does not let the next heading provide rollback detail", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "Release target: 1.6.0\n## Verification\nRan `npm test`.\n## Rollback\n## Notes\nRevert the release commit if needed.",
      }),
      files: [
        file("package.json", { patch: '+  "version": "1.6.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingFallback", severity: "high" })
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

  it.each(["package.json", "src/version.ts", "server.json", ".npmrc"])(
    "classifies %s as release-sensitive",
    (filename) => {
      expect(classifyPrFiles([file(filename)]).releaseFiles.map((entry) => entry.filename)).toContain(
        filename
      );
    }
  );

  it("reports a target mismatch against the package version without using dependency semvers", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "Release target: 1.6.0\n## Verification\nRan `npm test`.\n## Rollback\nRevert to v1.5.0 and republish the prior artifact.",
      }),
      files: [
        file("package.json", {
          patch: '+  "version": "1.5.1",\n+  "typescript": "^6.0.0",',
        }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        category: "ReleaseVersionMismatch",
        severity: "high",
        paths: ["package.json"],
      })
    );
    expect(result.conclusion).toBe("needs_changes");
  });

  it("reports inconsistent release versions across version sources", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "Publish version: 1.6.0\n## Verification\nRan `npm test`.\n## Rollback\nRevert to v1.5.0 and restore the previous artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "version": "1.6.0",' }),
        file("src/version.ts", { patch: '+export const VERSION = "1.6.1";' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        category: "InconsistentReleaseVersions",
        severity: "high",
        paths: ["package.json", "src/version.ts"],
      })
    );
  });

  it("fails closed when a changed version source has no verifiable added version", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "Release target: 1.6.0\n## Verification\nRan `npm test`.\n## Rollback\nRevert to v1.5.0 and restore the previous artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "typescript": "^6.0.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        category: "UnverifiedReleaseVersion",
        severity: "high",
        paths: ["package.json"],
      })
    );
    expect(result.testCoverageSignal).toBe("adequate");
  });

  it("accepts matching release target and changed version sources", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        body:
          "Release target: v1.6.0\n## Verification\nRan `npm test`.\n## Rollback\nRevert to v1.5.0 and restore the previous artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "version": "1.6.0",' }),
        file("src/version.ts", { patch: '+export const VERSION = "1.6.0";' }),
        file("server.json", { patch: '+  "version": "1.6.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(
      result.findings.some((finding) =>
        [
          "MissingReleaseVersion",
          "ReleaseVersionMismatch",
          "InconsistentReleaseVersions",
          "UnverifiedReleaseVersion",
        ].includes(finding.category)
      )
    ).toBe(false);
    expect(result.releaseRisk).toBe("high");
  });

  it("uses an explicit release title instead of a rollback version as the target", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        title: "Release v1.6.0",
        body:
          "## Verification\nRan `npm test`.\n## Rollback\nRestore version 1.5.0 and republish the prior artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "version": "1.5.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "ReleaseVersionMismatch", paths: ["package.json"] })
    );
    expect(result.findings.some((finding) => finding.category === "MissingReleaseVersion")).toBe(
      false
    );
  });

  it("does not treat a rollback-only old version as a release target", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        title: "Prepare artifact publication",
        body:
          "## Verification\nRan `npm test`.\n## Rollback\nRestore version 1.5.0 and republish the prior artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "typescript": "^6.0.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "MissingReleaseVersion", severity: "high" }),
        expect.objectContaining({ category: "UnverifiedReleaseVersion", severity: "high" }),
      ])
    );
    expect(result.findings.some((finding) => finding.category === "ReleaseVersionMismatch")).toBe(
      false
    );
  });

  it("fails closed when explicit release targets conflict", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        title: "Release v1.6.0",
        body:
          "Release target: 1.6.1\n## Verification\nRan `npm test`.\n## Rollback\nRestore v1.5.0 and republish the prior artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "version": "1.6.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "ConflictingReleaseTargets", severity: "high" })
    );
    expect(result.conclusion).toBe("needs_changes");
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

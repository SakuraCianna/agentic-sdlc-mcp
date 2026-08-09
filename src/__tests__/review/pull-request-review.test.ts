import { describe, expect, it } from "vitest";

import {
  classifyPrFiles,
  evaluatePullRequestReview,
  inferWorkType,
  scanPatchForSecrets,
  type PrFile,
  type ReviewPrMeta,
} from "../../review/pull-request-review.js";
import {
  evaluateSecretScannerEvidence,
  type SecretScannerPolicyContext,
} from "../../security/secret-scanner-evidence.js";
import type { CiEvidence, GateSignal } from "../../github/pull-request-evidence.js";

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
    draft: false,
    commits: 1,
    ...overrides,
  };
}

function secretScannerEvidence(state: GateSignal["state"]) {
  const scanner: GateSignal = {
    name: "gitleaks",
    source: "check_run",
    appId: 15368,
    state,
    rawStatus: state === "pending" ? "in_progress" : "completed",
    rawConclusion: state === "passing" ? "success" : state === "failing" ? "failure" : null,
    rawState: null,
    url: "https://github.com/example/checks/1",
    provenanceVerified: true,
  };
  const bucket = {
    passing: state === "passing" ? [scanner] : [],
    failing: state === "failing" ? [scanner] : [],
    pending: state === "pending" ? [scanner] : [],
    skipped: state === "skipped" ? [scanner] : [],
    total: 1,
  };
  const empty = { passing: [], failing: [], pending: [], skipped: [], total: 0 };
  return evaluateSecretScannerEvidence({
    checkRuns: bucket,
    commitStatuses: empty,
    totalSignals: 1,
    hasFailing: state === "failing",
    hasPending: state === "pending",
    unverifiedSignals: [],
    errors: [],
  } satisfies CiEvidence);
}

function scannerPolicyContext(
  workflowPath = ".github/workflows/secret-scan.yml"
): SecretScannerPolicyContext {
  return {
    signals: [
      {
        name: "gitleaks",
        provider: "gitleaks",
        source: "check_run",
        appId: 15368,
        url: "https://github.com/example/checks/1",
        workflowPath,
        configurationPaths: [
          ".gitleaks.toml",
          "gitleaks.toml",
          ".gitleaksignore",
        ],
      },
    ],
  };
}

function independentSecretScannerEvidence() {
  const passing = [
    {
      name: "gitleaks",
      source: "check_run",
      appId: 15368,
      state: "passing",
      rawStatus: "completed",
      rawConclusion: "success",
      rawState: null,
      url: "https://github.com/example/checks/1",
      provenanceVerified: true,
    },
    {
      name: "TruffleHog",
      source: "check_run",
      appId: 15368,
      state: "passing",
      rawStatus: "completed",
      rawConclusion: "success",
      rawState: null,
      url: "https://github.com/example/checks/2",
      provenanceVerified: true,
    },
  ] satisfies GateSignal[];
  return evaluateSecretScannerEvidence({
    checkRuns: {
      passing,
      failing: [],
      pending: [],
      skipped: [],
      total: passing.length,
    },
    commitStatuses: {
      passing: [],
      failing: [],
      pending: [],
      skipped: [],
      total: 0,
    },
    totalSignals: passing.length,
    hasFailing: false,
    hasPending: false,
    unverifiedSignals: [],
    errors: [],
  });
}

function independentScannerPolicyContext(): SecretScannerPolicyContext {
  return {
    signals: [
      {
        name: "gitleaks",
        provider: "gitleaks",
        source: "check_run",
        appId: 15368,
        url: "https://github.com/example/checks/1",
        workflowPath: ".github/workflows/gitleaks.yml",
        configurationPaths: [
          ".gitleaks.toml",
          "gitleaks.toml",
          ".gitleaksignore",
        ],
      },
      {
        name: "TruffleHog",
        provider: "trufflehog",
        source: "check_run",
        appId: 15368,
        url: "https://github.com/example/checks/2",
        workflowPath: ".github/workflows/trufflehog.yml",
        configurationPaths: [],
      },
    ],
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

  it("detects a quoted JSON credential key while ignoring assignments inside strings", () => {
    const findings = scanPatchForSecrets(
      "config/service.json",
      '+  "apiKey": "live_1234567890abcdef",'
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment" })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).not.toContain("matching occurrences");
    expect(
      scanPatchForSecrets(
        "src/example.ts",
        ' const sample = `\n+  "apiKey": "live_1234567890abcdef",\n `;'
      )
    ).toEqual([]);
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

  it("carries block-comment state from context lines before scanning added secrets", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "@@ -1,2 +1,3 @@\n /* credentials for local setup\n+API_TOKEN=ghp_1234567890abcdef\n */"
      )
    ).toEqual([]);
  });

  it("carries a block comment opened after context code", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "@@ -1,2 +1,3 @@\n const setup = true; /* credentials\n+API_TOKEN=ghp_1234567890abcdef\n */"
      )
    ).toEqual([]);
  });

  it("still scans added code before an inline block comment", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+const API_TOKEN = ghp_1234567890abcdef; /* rotate before production */"
      )
    ).toContainEqual(expect.objectContaining({ category: "SecretLikeAssignment" }));
  });

  it.each(["`", '"', "'"])(
    "does not scan an added dotenv example inside a context-opened %s string",
    (quote) => {
      expect(
        scanPatchForSecrets(
          "src/config.ts",
          `@@ -1,2 +1,3 @@\n const example = ${quote}\n+API_TOKEN=ghp_1234567890abcdef\n ${quote};`
        )
      ).toEqual([]);
    }
  );

  it("does not scan an assignment inside an added multiline template", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+const example = `\n+API_TOKEN=ghp_1234567890abcdef\n+`;"
      )
    ).toEqual([]);
  });

  it("scans a real assignment after a context-opened string closes", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        ' const example = `\n+`; const API_TOKEN = "live_1234567890abcdef";'
      )
    ).toContainEqual(expect.objectContaining({ category: "SecretLikeAssignment" }));
  });

  it.each([
    "+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "+OPENAI_API_KEY=sk-your-api-key-here",
    "+GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx",
    "+GITHUB_TOKEN=github_pat_example-token",
    "+SLACK_TOKEN=xoxb-dummy-token-value",
  ])("ignores a known-prefix placeholder token %s", (patch) => {
    expect(scanPatchForSecrets("config/service.env", patch)).toEqual([]);
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

  it.each([
    '+const token = "gh" + "p_" + accountSuffix;',
    '+const apiKey = `live_${tenantId}_${signature}`;',
    '+const clientSecret = [prefix, tenantId, signature].join(".");',
    '+const password = Buffer.from(encodedPassword, "base64").toString("utf8");',
    '+const privateKey = String.fromCharCode(...keyBytes);',
    '+const authorizationHeader = prefix + accountId + signature;',
    '+headers["authorization"] = "Bearer " + sessionToken;',
    '+credentials[fieldName] = prefix + accountId + signature;',
    '+const token = prefix.concat(accountId, signature);',
    '+api_key = f"{prefix}.{account_id}.{signature}"',
    '+api_key = "{}.{}.{}".format(prefix, account_id, signature)',
    '+api_key = "%s.%s" % (prefix, signature)',
    '+var token = $"{prefix}.{accountId}.{signature}";',
    '+password = base64.b64decode(encoded_password)',
    '+const secret = new TextDecoder().decode(secretBytes);',
    '+config["auth"]["token"] = prefix + signature;',
    '+config["api" + "Key"] = prefix + signature;',
    '+const token = new StringBuilder().append(prefix).append(signature).toString();',
    '+let token = format!("{}.{}", prefix, signature);',
    '+token := fmt.Sprintf("%s.%s", prefix, signature)',
    '+const apiKey = decodeURIComponent(encodedPrefix) + signature;',
    '+token = "#{prefix}.#{signature}"',
    '+$token = "{$prefix}.{$signature}";',
    '+val token = "$prefix.$signature"',
    '+let token = "\\(prefix).\\(signature)"',
  ])("flags a dynamically constructed credential expression %s", (patch) => {
    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({
        category: "DynamicSecretConstruction",
        severity: "high",
        dimension: "security",
        paths: ["src/config.ts"],
      })
    );
  });

  it("does not treat credential-scanner regex metadata as runtime credential construction", () => {
    const patch = [
      "+const SECRETS_DOMAIN_PATTERNS: readonly RegExp[] = [",
      "+  /\\b(?:access|auth|oauth)[ _-]*tokens?\\b/i,",
      "+  /\\b(?:rotat|revok|redact)\\w*[ _-]+credentials?\\b/i,",
      "+];",
    ].join("\n");

    expect(scanPatchForSecrets("src/security/risk-classifier.ts", patch)).toEqual([]);
  });

  it("does not treat a multiline ternary colon as a credential assignment", () => {
    const patch = [
      "+const reason = limited",
      "+  ? `The credential scan exceeded ${operatorLimit}`",
      "+  : `The credential construction exceeded ${workLimit}`;",
    ].join("\n");

    expect(scanPatchForSecrets("src/review/scanner.ts", patch)).toEqual([]);
  });

  it("does not self-report a multiline ternary inside scanner finding metadata", () => {
    const patch = [
      "+recordFinding(",
      "+  finding(",
      '+    "high",',
      '+    "SecretScanEvidenceIncomplete",',
      '+    "security",',
      "+    `An added credential statement exceeded the bound.`,",
      "+    [normalizedFilename],",
      "+    operatorAnalysisLimited",
      "+      ? `The credential scan exceeded ${operatorLimit}.`",
      "+      : `The credential construction exceeded ${workLimit}.`,",
      '+    "Split the credential statement before merging."',
      "+  )",
      "+);",
    ].join("\n");

    expect(scanPatchForSecrets("src/review/scanner.ts", patch)).toEqual([]);
  });

  it("still flags credential construction inside a ternary assignment", () => {
    const patch =
      "+const apiKey = enabled ? prefix + signature : fallback;";

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("flags credential construction inside a multiline ternary assignment", () => {
    const patch = [
      "+const apiKey = enabled",
      "+  ? prefix + signature",
      "+  : fallback;",
    ].join("\n");

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let a Ruby predicate hide a following credential member", () => {
    const patch =
      "+config = { enabled: valid?, apiKey: prefix + signature }";

    expect(scanPatchForSecrets("src/config.rb", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let a continued Ruby predicate hide a following credential member", () => {
    const patch =
      "+config = { enabled: valid? && active, apiKey: prefix + signature }";

    expect(scanPatchForSecrets("src/config.rb", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it.each([
    "project.gemspec",
    "config.ru",
    "fastlane/Fastfile",
    "Vagrantfile",
    "Guardfile",
    "Podfile",
  ])("recognizes Ruby predicate syntax in %s", (filename) => {
    const patch =
      "+config = { enabled: valid? && active, apiKey: prefix + signature }";

    expect(scanPatchForSecrets(filename, patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not treat a Ruby predicate as a ternary credential expression", () => {
    const patch =
      "+config = { enabled: valid?, displayName: prefix + suffix }";

    expect(scanPatchForSecrets("src/config.rb", patch)).toEqual([]);
  });

  it("does not let a Rust postfix question mark hide a following credential member", () => {
    const patch =
      "+let config = Config { parsed: input.parse()?, api_key: prefix + signature };";

    expect(scanPatchForSecrets("src/config.rs", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let a cast after a Rust postfix question mark hide a credential", () => {
    const patch =
      "+let config = Config { parsed: input.parse()? as usize, api_key: prefix + signature };";

    expect(scanPatchForSecrets("src/config.rs", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let Swift optional try hide a following credential member", () => {
    const patch = [
      '+let config = ["parsed": try? parse(), "apiKey":',
      "+  prefix + signature]",
    ].join("\n");

    expect(scanPatchForSecrets("src/Config.swift", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let a Swift conditional cast hide a following credential member", () => {
    const patch =
      '+let config = ["parsed": value as? String, "apiKey": prefix + signature]';

    expect(scanPatchForSecrets("src/Config.swift", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("still flags Swift credential construction inside a multiline ternary", () => {
    const patch = [
      "+let apiKey = enabled",
      "+  ? prefix + signature",
      "+  : fallback",
    ].join("\n");

    expect(scanPatchForSecrets("src/Config.swift", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let a PHP nullsafe expression hide a named credential argument", () => {
    const patch = [
      "+buildConfig(parsed: $object?->value, apiKey:",
      '+  "{$prefix}{$signature}");',
    ].join("\n");

    expect(scanPatchForSecrets("src/config.php", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("still flags PHP credential construction inside a ternary", () => {
    const patch =
      '+$apiKey = $enabled ? "{$prefix}{$signature}" : $fallback;';

    expect(scanPatchForSecrets("src/config.php", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let a Dart nullable cast hide a following credential member", () => {
    const patch = [
      '+final config = {"parsed": value as String? ?? fallback, "apiKey":',
      '+  "$prefix$signature"};',
    ].join("\n");

    expect(scanPatchForSecrets("lib/config.dart", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("still flags Dart credential construction inside a ternary", () => {
    const patch =
      '+final apiKey = enabled ? "$prefix$signature" : fallback;';

    expect(scanPatchForSecrets("lib/config.dart", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not let an Elixir character literal hide a following credential member", () => {
    const patch = [
      "+config = [parsed: ?x, api_key:",
      '+  "#{prefix}#{signature}"]',
    ].join("\n");

    expect(scanPatchForSecrets("lib/config.ex", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not treat an Elixir character literal as credential construction", () => {
    const patch = "+config = [parsed: ?x, display_name: prefix <> suffix]";

    expect(scanPatchForSecrets("lib/config.exs", patch)).toEqual([]);
  });

  it("flags C++ credential construction after a comma in a ternary middle operand", () => {
    const patch =
      "+const auto apiKey = enabled ? audit(), prefix + signature : fallback;";

    expect(scanPatchForSecrets("src/config.cpp", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it.each([
    "+const auto apiKey = enabled ? .5, prefix + signature : fallback;",
    "+const auto apiKey = enabled?.5, prefix + signature : fallback;",
  ])("treats a C++ decimal literal after question mark as ternary syntax", (patch) => {
    expect(scanPatchForSecrets("src/config.cpp", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("flags C credential construction in a parenthesized ternary else operand", () => {
    const patch =
      "+const char *api_key = enabled ? fallback : (audit(), prefix + signature);";

    expect(scanPatchForSecrets("src/config.c", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it.each([
    [
      "scanner provenance helper",
      [
        "+const workflow = `extra_args: ${typeof value === \"number\" ? value : `'${value.replaceAll(\"'\", \"''\")}'`}`;",
        "+const result = await verifySecretScannerProvenance(",
        '+  "https://example.test/actions/runs/1/job/2",',
      ].join("\n"),
    ],
    [
      "secret scanner workflow fixture path",
      [
        "+const workflows = {",
        '+  ".github/workflows/secret-scan.yml":',
        "+    `uses: gitleaks/gitleaks-action@${PINNED_ACTION_SHA}` ,",
        "+};",
      ].join("\n"),
    ],
  ])("does not treat %s metadata as runtime credential construction", (_name, patch) => {
    expect(scanPatchForSecrets("src/__tests__/security/provenance.test.ts", patch)).toEqual(
      []
    );
  });

  it("resumes credential detection after nested scanner-fixture templates", () => {
    const patch = [
      "+const workflow = `extra_args: ${typeof value === \"number\" ? value : `'${value.replaceAll(\"'\", \"''\")}'`}`;",
      "+const token = prefix + signature;",
    ].join("\n");

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it.each([
    "+const tokenPattern = /[A-Z]+%?/;",
    "+const tokenPattern = () => /access[_-]+token/i;",
    "+const tokenPattern = /access\\/[a-z]+/i;",
  ])("ignores operators that occur only inside a regular-expression literal: %s", (patch) => {
    expect(scanPatchForSecrets("src/security/risk-classifier.ts", patch)).toEqual([]);
  });

  it.each([
    "+const tokenPatterns = prefix + signature;",
    "+const tokenScannerRules = prefix + signature;",
    "+const apiKeyAssignments = prefix + signature;",
    "+const tokenPattern = /access[_-]+token/i.source + suffix;",
    "+const credentialRegex = new RegExp(secretNames.join('|'));",
    "+const tokenMatcher = patternPrefix + patternSuffix;",
    "+const secretRules = baseRules.concat(extraRules);",
  ])("still flags a dynamically constructed credential with a metadata-like name: %s", (patch) => {
    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it.each([
    "+const apiKey: string = prefix + signature;",
    "+class C { apiKey: string = prefix + signature; }",
    "+class C { private apiKey!: string = prefix + signature; }",
    "+function f(apiKey: string = prefix + signature) {}",
    "+const makeApiKey = (): string => prefix + signature;",
  ])("reports a typed TypeScript credential assignment once: %s", (patch) => {
    const findings = scanPatchForSecrets("src/config.ts", patch);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "DynamicSecretConstruction" });
    expect(findings[0]?.description).not.toContain("matching occurrences");
  });

  it("keeps object-property credential construction in scope", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+const config = { apiKey: prefix + signature };"
      )
    ).toContainEqual(expect.objectContaining({ category: "DynamicSecretConstruction" }));
  });

  it("flags a credential dynamically assembled across added lines", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+const apiToken =\n+  tokenPrefix +\n+  accountId +\n+  signature;"
      )
    ).toContainEqual(expect.objectContaining({ category: "DynamicSecretConstruction" }));
  });

  it.each([
    "+const apiToken\n+  = prefix + signature;",
    "@@ -1,2 +1,3 @@\n const apiToken\n+  = prefix + signature;\n const done = true;",
  ])("flags a credential when the target and operator are split across lines", (patch) => {
    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it.each([
    '+request.setHeader("Authorization", "Bearer " + parts.join(""));',
    '+headers.set("X-Api-Key", Buffer.from(keyBytes).toString("base64"));',
    '+connection.setRequestProperty("Authorization", prefix + signature);',
  ])("flags a dynamically constructed credential passed directly to an API sink", (patch) => {
    expect(scanPatchForSecrets("src/client.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it("tracks a bounded patch-local alias for a dynamically constructed credential field", () => {
    const patch =
      '+const field = ["api", "key"].join("_");\n+config[field] = assembled;';

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it("does not let a later alias declaration affect an earlier assignment", () => {
    const patch =
      '+config[field] = prefix + signature;\n+const field = ["api", "key"].join("_");';

    expect(scanPatchForSecrets("src/config.ts", patch)).toEqual([]);
  });

  it("does not throw or expand output for a one-megabyte added line", () => {
    const patch = `+const token = prefix + signature; // ${"x".repeat(1_000_000)}`;

    expect(() => scanPatchForSecrets("src/config.ts", patch)).not.toThrow();
    const findings = scanPatchForSecrets("src/config.ts", patch);
    expect(findings).toHaveLength(2);
    expect(findings.map((item) => item.category)).toEqual(
      expect.arrayContaining(["DynamicSecretConstruction", "SecretScanEvidenceIncomplete"])
    );
  });

  it("fails closed when credential construction appears after the statement scan limit", () => {
    const patch = `+${"x".repeat(70_000)} const token = prefix + signature;`;

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("fails closed when an unterminated credential statement crosses the line limit", () => {
    const patch = [
      "+const token =",
      ...Array.from({ length: 99 }, (_, index) => `+// explanation ${index}`),
      "+prefix + signature;",
    ].join("\n");

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("treats JSON as line-delimited data without weakening per-line secret checks", () => {
    const patch = [
      "+{",
      ...Array.from(
        { length: 150 },
        (_, index) => `+  \"dependency-${index}\": \"1.0.${index}\",`
      ),
      "+}",
    ].join("\n");

    expect(scanPatchForSecrets("tools/example/package-lock.json", patch)).toEqual([]);
    expect(
      scanPatchForSecrets(
        "config/service.json",
        `+  \"apiKey\": \"${["live", "1234567890abcdef"].join("_")}\",`
      )
    ).toContainEqual(expect.objectContaining({ category: "SecretLikeAssignment" }));
  });

  it.each([
    ["config/service.json", '+  "apiKey":\n+    "$TOKEN_PREFIX-$TOKEN_SUFFIX",'],
    [
      "config/service.jsonc",
      '+  "apiKeys": [\n+    "$TOKEN_PREFIX-$TOKEN_SUFFIX"\n+  ],',
    ],
  ])("keeps a bounded multiline JSON credential value together in %s", (filename, patch) => {
    expect(scanPatchForSecrets(filename, patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("continues a credential container after an earlier neutral member on the same line", () => {
    const patch = [
      '+{"displayName": "demo", "apiKey": [',
      '+  "$TOKEN_PREFIX-$TOKEN_SUFFIX"',
      "+]}",
    ].join("\n");

    expect(scanPatchForSecrets("config/service.json", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("keeps a JSON credential key together when its separator starts the next line", () => {
    const patch = [
      '+  "apiKey"',
      "+    :",
      '+    "$TOKEN_PREFIX-$TOKEN_SUFFIX",',
    ].join("\n");

    expect(scanPatchForSecrets("config/service.json", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("detects a literal when a JSON credential key, separator, and value use separate lines", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = ['+  "apiKey"', "+    :", `+    "${literal}",`].join("\n");

    expect(scanPatchForSecrets("config/service.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it.each([
    [
      "literal",
      `+{"api\\u004bey": "${["live", "1234567890abcdef"].join("_")}"}`,
      "SecretLikeAssignment",
    ],
    [
      "dynamic",
      '+  "api\\u004bey"\n+    :\n+    "$TOKEN_PREFIX-$TOKEN_SUFFIX",',
      "DynamicSecretConstruction",
    ],
  ])("decodes an escaped JSON credential key before %s checks", (_kind, patch, category) => {
    expect(scanPatchForSecrets("config/service.json", patch)).toContainEqual(
      expect.objectContaining({ category, severity: "high" })
    );
  });

  it("keeps placeholder suppression after decoding a JSON credential key", () => {
    expect(
      scanPatchForSecrets(
        "config/service.json",
        '+  "api\\u004bey": "example-token-value",'
      )
    ).toEqual([]);
  });

  it.each([
    [
      "array",
      `+{"apiKeys": ["${["live", "1234567890abcdef"].join("_")}"]}`,
    ],
    [
      "object",
      `+{"credentials": {\n+  "primary": "${["live", "abcdef1234567890"].join("_")}"\n+}}`,
    ],
    [
      "AWS value",
      `+{"apiKeys": ["${["AKIA", "1234567890ABCDEF"].join("")}"]}`,
    ],
  ])("detects non-placeholder literal leaves in a JSON credential %s", (_kind, patch) => {
    expect(scanPatchForSecrets("config/service.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it.each([
    ['+{"apiKeys": ["example-token-value"]}'],
    ['+{"credentials": {"primary": "dummy-token-value"}}'],
  ])("keeps placeholder suppression inside a JSON credential container", (patch) => {
    expect(scanPatchForSecrets("config/service.json", patch)).toEqual([]);
  });

  it("detects a split AWS access-key identifier assignment", () => {
    const literal = ["AKIA", "1234567890ABCDEF"].join("");
    const patch = ['+  "awsAccessKeyId"', "+    :", `+    "${literal}",`].join("\n");

    expect(scanPatchForSecrets("config/service.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it.each([
    ["GitHub token", ["ghp", "1234567890abcdef"].join("_")],
    ["AWS access key", ["AKIA", "1234567890ABCDEF"].join("")],
  ])("detects a high-confidence unquoted %s in malformed JSON", (_kind, literal) => {
    expect(scanPatchForSecrets("config/service.json", `+{"apiKey":${literal}}`)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it("detects an unquoted AWS key behind a neutral JSON member", () => {
    const literal = ["AKIA", "1234567890ABCDEF"].join("");
    expect(scanPatchForSecrets("config/service.json", `+{"value":${literal}}`)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it("does not duplicate a nested JSON credential literal", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    const findings = scanPatchForSecrets(
      "config/service.json",
      `+{"credentials":{"apiKey":"${literal}"}}`
    ).filter((finding) => finding.category === "SecretLikeAssignment");

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).not.toContain("matching occurrences");
  });

  it.each([
    "accessKeyDescription",
    "accessKeyboardShortcut",
    "accessKeyLabel",
  ])("does not treat the UI field %s as a credential target", (field) => {
    expect(
      scanPatchForSecrets(
        "config/ui.json",
        `+{"${field}":"Keyboard shortcut for Save"}`
      )
    ).toEqual([]);
  });

  it.each([
    "+element.accessKey = modifier + key;",
    "+const accessKeyboardShortcut = modifier + key;",
    "+const config = { accessKey: modifier + key };",
  ])("does not treat a DOM or UI access-key target as a credential: %s", (patch) => {
    expect(scanPatchForSecrets("src/keyboard.ts", patch)).toEqual([]);
  });

  it("does not treat a bare JSON accessKey as a credential", () => {
    expect(
      scanPatchForSecrets(
        "config/ui.json",
        '+{"accessKey":"Keyboard shortcut for Save"}'
      )
    ).toEqual([]);
  });

  it("keeps an AWS access-key identifier target in scope", () => {
    expect(
      scanPatchForSecrets(
        "src/aws.ts",
        "+const awsAccessKeyId = prefix + accountId + signature;"
      )
    ).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it.each(["node_modules/js-tokens", "node_modules/jsonwebtoken"])(
    "does not treat the package-lock member %s as a credential container",
    (packagePath) => {
      const patch = [
        `+  "${packagePath}": {`,
        '+    "version": "9.0.1",',
        '+    "resolved": "https://registry.npmjs.org/example/-/example-9.0.1.tgz",',
        '+    "integrity": "sha512-ordinary-package-integrity"',
        "+  }",
      ].join("\n");

      expect(scanPatchForSecrets("package-lock.json", patch)).toEqual([]);
    }
  );

  it.each(["config/apiKey", "auth/token", "apiKey/"])(
    "does not let a slash-bearing credential key %s bypass JSON scanning",
    (field) => {
      const literal = ["live", "1234567890abcdef"].join("_");
      expect(
        scanPatchForSecrets("config/service.json", `+{"${field}":"${literal}"}`)
      ).toContainEqual(
        expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
      );
    }
  );

  it("does not treat an old-style package-lock dependency as a credential container", () => {
    const patch = [
      '+  "dependencies": {',
      '+    "js-tokens": {',
      '+      "version": "9.0.1",',
      '+      "resolved": "https://registry.npmjs.org/js-tokens/-/js-tokens-9.0.1.tgz",',
      '+      "integrity": "sha512-ordinary-package-integrity"',
      "+    }",
      "+  }",
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toEqual([]);
  });

  it("does not let package metadata hide a credential container", () => {
    const patch = [
      '+{"apikey": {',
      '+  "version": "1.0.0",',
      '+  "resolved": "https://registry.invalid/example.tgz",',
      '+  "value": "$TOKEN_PREFIX-$TOKEN_SUFFIX"',
      "+}}",
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("keeps a large package-lock package member out of credential budgets", () => {
    const patch = [
      '+  "node_modules/js-tokens": {',
      '+    "version": "9.0.1",',
      ...Array.from(
        { length: 101 },
        (_, index) => `+    "dependency-${index}": "1.0.${index}",`
      ),
      '+    "integrity": "sha512-ordinary-package-integrity"',
      "+  }",
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toEqual([]);
  });

  it("does not treat a node_modules auth-token package as a credential container", () => {
    const patch = [
      '+  "node_modules/@octokit/auth-token": {',
      '+    "version": "6.0.0",',
      '+    "resolved": "https://registry.npmjs.org/@octokit/auth-token/-/auth-token-6.0.0.tgz",',
      '+    "integrity": "sha512-ordinary-package-integrity"',
      "+  }",
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toEqual([]);
  });

  it("does not treat an old scoped auth-token package as a credential container", () => {
    const patch = [
      '+  "@octokit/auth-token": {',
      '+    "version": "6.0.0",',
      '+    "resolved": "https://registry.npmjs.org/@octokit/auth-token/-/auth-token-6.0.0.tgz",',
      '+    "integrity": "sha512-ordinary-package-integrity"',
      "+  }",
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toEqual([]);
  });

  it.each(["package-lock.json", "npm-shrinkwrap.json"])(
    "does not treat an old unscoped auth-token package as a credential container in %s",
    (filename) => {
      const patch = [
        '+  "dependencies": {',
        '+    "auth-token": {',
        '+      "version": "6.0.0",',
        '+      "resolved": "https://registry.npmjs.org/auth-token/-/auth-token-6.0.0.tgz",',
        '+      "integrity": "sha512-ordinary-package-integrity"',
        "+    }",
        "+  }",
      ].join("\n");

      expect(scanPatchForSecrets(filename, patch)).toEqual([]);
    }
  );

  it("still scans credential fields inside an old package-lock package member", () => {
    const patch = [
      '+  "dependencies": {',
      '+    "auth-token": {',
      '+      "version": "6.0.0",',
      '+      "apiKey": "$TOKEN_PREFIX-$TOKEN_SUFFIX"',
      "+    }",
      "+  }",
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("does not carry old-lock dependency structure across diff hunks", () => {
    const patch = [
      "@@ -1,0 +1,2 @@",
      "+{",
      '+  "dependencies": {',
      "@@ -100,0 +102,1 @@",
      '+"auth-token":{"value":"$TOKEN_PREFIX-$TOKEN_SUFFIX"}',
    ].join("\n");

    expect(scanPatchForSecrets("package-lock.json", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
    );
  });

  it("fails high for an ambiguous old-lock package fragment without its parent", () => {
    const patch =
      '+"auth-token":{"version":"6.0.0","resolved":"https://registry.invalid/auth-token.tgz"}';

    expect(scanPatchForSecrets("package-lock.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it("does not let a node_modules prefix bypass an ordinary JSON credential key", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    expect(
      scanPatchForSecrets(
        "config/service.json",
        `+{"node_modules/apiKey":"${literal}"}`
      )
    ).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it.each([
    ["node_modules/apiKey", ["live", "1234567890abcdef"].join("_")],
    ["@scope/auth-token", ["live", "1234567890abcdef"].join("_")],
    ["node_modules/apiKey", "$TOKEN_PREFIX-$TOKEN_SUFFIX"],
  ])("does not let a scalar package-shaped key %s bypass lockfile scanning", (field, value) => {
    const findings = scanPatchForSecrets(
      "package-lock.json",
      `+{"${field}":"${value}"}`
    );

    expect(findings).toContainEqual(
      expect.objectContaining({ severity: "high" })
    );
  });

  it("keeps an auth-token key in ordinary JSON credential scope", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    expect(
      scanPatchForSecrets("config/service.json", `+{"auth-token":"${literal}"}`)
    ).toContainEqual(
      expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
    );
  });

  it.each(["apiKey1", "awsAccessKeyId1"])(
    "keeps a numbered credential target %s in scope",
    (field) => {
      const literal = ["live", "1234567890abcdef"].join("_");
      expect(
        scanPatchForSecrets("config/service.json", `+{"${field}":"${literal}"}`)
      ).toContainEqual(
        expect.objectContaining({ category: "SecretLikeAssignment", severity: "high" })
      );
    }
  );

  it("does not carry a credential-named JSON array value into the next member", () => {
    const patch = [
      '+    "apiKey"',
      "+    ,",
      '+    "displayName": "$LABEL_PREFIX-$LABEL_SUFFIX"',
    ].join("\n");

    expect(scanPatchForSecrets("config/service.json", patch)).toEqual([]);
  });

  it("does not grow a neutral JSONC separator through comment-only lines", () => {
    const patch = [
      '+  "displayName"',
      "+    :",
      ...Array.from({ length: 99 }, (_, index) => `+    // explanation ${index}`),
      '+    "ordinary-value",',
    ].join("\n");

    expect(scanPatchForSecrets("config/service.jsonc", patch)).toEqual([]);
  });

  it("handles long JSONC comment runs without quadratic lookahead", () => {
    const patch = Array.from(
      { length: 20_000 },
      (_, index) => `+// generated explanation ${index}`
    ).join("\n");

    expect(scanPatchForSecrets("config/generated.jsonc", patch)).toEqual([]);
  });

  it("does not carry a credential scalar into a following neutral container", () => {
    const patch = [
      '+{"apiKey": "example-token-value", "metadata": {',
      ...Array.from({ length: 99 }, (_, index) => `+  "entry-${index}": ${index},`),
      "+}}",
    ].join("\n");

    expect(scanPatchForSecrets("config/service.json", patch)).toEqual([]);
  });

  it("still fails closed for one oversized JSON line", () => {
    const patch = `+  \"metadata\": \"${"x".repeat(70_000)}\"`;

    expect(scanPatchForSecrets("config/generated.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("fails closed when a JSON credential container reaches the line bound", () => {
    const patch = [
      '+  "apiKeys": [',
      ...Array.from({ length: 99 }, (_, index) => `+    "value-${index}",`),
      "+  ]",
    ].join("\n");

    expect(scanPatchForSecrets("config/generated.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("fails closed before deeply scanning a JSON statement with too many operators", () => {
    const openings = Array.from({ length: 500 }, (_, index) => `"layer-${index}": {`).join("");
    const patch = `+{"apiKey": {${openings}"leaf": "ordinary-value"${"}".repeat(502)}}`;

    const findings = scanPatchForSecrets("config/generated.json", patch);
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
    expect(findings[0]?.reason).toContain("100-operator");
  });

  it("fails closed when bounded JSON operator work is exhausted below the count limit", () => {
    const padding = "x".repeat(55_000);
    const patch = `+{"apiKey": {"one": {"two": {"three": {"four": "${padding}"}}}}}`;

    const findings = scanPatchForSecrets("config/generated.json", patch);
    expect(findings).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
    expect(findings[0]?.reason).toContain("256,000-work-unit");
  });

  it("propagates an operator-limited context key to an added JSON value", () => {
    const members = Array.from({ length: 101 }, (_, index) => `"entry-${index}": ${index}`);
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = ` {${members.join(", ")}, "apiKey":\n+  "${literal}"}`;

    expect(scanPatchForSecrets("config/generated.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("propagates a work-limited context key to an added JSON value", () => {
    const padding = "x".repeat(55_000);
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = ` {"padding": "${padding}", "one": 1, "two": 2, "three": 3, "apiKey":\n+  "${literal}"}`;

    expect(scanPatchForSecrets("config/generated.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("propagates a character-truncated context container to an added JSON value", () => {
    const padding = "x".repeat(65_000);
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = ` {"apiKey": ["${padding}",\n+  "${literal}"]}`;

    expect(scanPatchForSecrets("config/generated.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("does not taint a hard-limited context hunk for a comment-only addition", () => {
    const padding = "x".repeat(65_000);
    const patch = ` {"metadata": "${padding}"}\n+// formatting note only`;

    expect(scanPatchForSecrets("config/generated.jsonc", patch)).toEqual([]);
  });

  it("does not taint an unrelated addition after hard-limited neutral context", () => {
    const padding = "x".repeat(65_000);
    const patch = ` {"metadata": "${padding}"}\n+{"displayName":"demo"}`;

    expect(scanPatchForSecrets("config/generated.json", patch)).toEqual([]);
  });

  it("does not taint an unrelated addition after a standalone token label", () => {
    const patch = [
      ' "token"',
      ` /*${"x".repeat(65_000)}*/`,
      '+{"displayName":"demo"}',
    ].join("\n");

    expect(scanPatchForSecrets("config/generated.jsonc", patch)).toEqual([]);
  });

  it("propagates a line-limited context container to an added JSON value", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = [
      ' {"apiKey": [',
      ...Array.from({ length: 99 }, (_, index) => `   "ordinary-${index}",`),
      `+  "${literal}"]}`,
    ].join("\n");

    expect(scanPatchForSecrets("config/generated.json", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("fails closed when a split context key crosses the JSONC line bound", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = [
      ' "apiKey"',
      ...Array.from({ length: 99 }, (_, index) => ` // context ${index}`),
      "+:",
      `+"${literal}"`,
    ].join("\n");

    expect(scanPatchForSecrets("config/generated.jsonc", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("fails closed when a split context key crosses the JSONC character bound", () => {
    const literal = ["live", "1234567890abcdef"].join("_");
    const patch = [
      ' "apiKey"',
      ` /*${"x".repeat(65_000)}*/`,
      "+:",
      `+"${literal}"`,
    ].join("\n");

    expect(scanPatchForSecrets("config/generated.jsonc", patch)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("fails closed at the exact character boundary when the statement continues", () => {
    const lineAtBoundary = `${"x".repeat(63_997)} =`;
    expect(lineAtBoundary).toHaveLength(63_999);

    expect(scanPatchForSecrets("src/generated.ts", `+${lineAtBoundary}`)).toContainEqual(
      expect.objectContaining({ category: "SecretScanEvidenceIncomplete", severity: "high" })
    );
  });

  it("keeps code/comment masks aligned for context lines", () => {
    const patch =
      '@@ -1,2 +1,3 @@\n const apiToken /* context */\n+  = prefix + signature;\n const done = true;';

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it.each([
    "+const token = process.env.TOKEN_PREFIX + process.env.TOKEN_SUFFIX;",
    "+const apiKey = secrets.API_KEY_PREFIX + secrets.API_KEY_SUFFIX;",
    "+const password = os.getenv(\"PASSWORD_PREFIX\") + os.getenv(\"PASSWORD_SUFFIX\");",
    "+const tokenCount = previousCount + 1;",
    "+const passwordStrength = entropyScore + policyBonus;",
    '+const secretName = "tenant/" + tenantId;',
    "+const tokenBucket = previousBucket + refill;",
    "+const apiKeyNames = prefix + tenantId;",
    "+const authorizationHeaderLength = baseLength + delta;",
    "+const apiKeyValidator = baseValidator + extension;",
    "+const passwordPolicy = basePolicy + overridePolicy;",
    '+const token = secrets["TOKEN_A"] + secrets["TOKEN_B"];',
    '+const password = os.environ["PASSWORD_A"] + os.environ["PASSWORD_B"]',
    '+const apiKey = ENV["API_KEY_A"] + ENV["API_KEY_B"]',
    '+const secret = Bun.env.SECRET_A + Bun.env.SECRET_B;',
    "+// const token = prefix + accountId + signature;",
    "-const token = prefix + accountId + signature;",
  ])("does not flag trusted runtime sources, comments, or removed dynamic code %s", (patch) => {
    expect(scanPatchForSecrets("src/config.ts", patch)).toEqual([]);
  });

  it("detects a dynamic continuation added to a context assignment", () => {
    const patch = "@@ -1,2 +1,3 @@\n const token = prefix\n+  + signature;\n const done = true;";

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it("resets lexical state at each diff hunk", () => {
    const patch =
      "@@ -1,2 +1,3 @@\n const example = `\n+still example text\n@@ -20,1 +21,2 @@\n+const token = prefix + signature;";

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it("does not lose a continuation after more than six comment or blank lines", () => {
    const patch = [
      "@@ -1,2 +1,10 @@",
      " const token = prefix",
      "+// explanation 1",
      "+// explanation 2",
      "+",
      "+// explanation 3",
      "+// explanation 4",
      "+// explanation 5",
      "+  + signature;",
    ].join("\n");

    expect(scanPatchForSecrets("src/config.ts", patch)).toContainEqual(
      expect.objectContaining({ category: "DynamicSecretConstruction" })
    );
  });

  it("does not attach an unrelated following expression to a completed credential assignment", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+const token = getToken();\n+const count = left + right;"
      )
    ).toEqual([]);
  });

  it("evaluates every assignment in one statement", () => {
    expect(
      scanPatchForSecrets(
        "src/config.ts",
        "+const tokenCount = previous + 1, apiKey = prefix + signature;"
      )
    ).toContainEqual(expect.objectContaining({ category: "DynamicSecretConstruction" }));
  });

  it("aggregates repeated findings instead of expanding the MCP response", () => {
    const patch = Array.from(
      { length: 500 },
      (_, index) => `+const token${index} = prefix + signature;`
    ).join("\n");
    const findings = scanPatchForSecrets("src/config.ts", patch);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("500 matching occurrences");
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
  it.each(["basic", "strict", "security-focused"] as const)(
    "runs supplemental dynamic credential detection under the %s standard",
    (standard) => {
      const result = evaluatePullRequestReview({
        pr: pr({
          title: "Harden security token construction",
          body: "Review credential construction and validate the security boundary.",
        }),
        files: [
          file("src/auth.ts", {
            patch: "+const authorizationHeader = prefix + accountId + signature;",
          }),
        ],
        standard,
      });

      expect(result.workType).toBe("security");
      expect(result.findings).toContainEqual(
        expect.objectContaining({ category: "DynamicSecretConstruction", severity: "high" })
      );
    }
  );

  it("preserves legacy draft and large commit-count hygiene findings", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ draft: true, commits: 21 }),
      files: [file("README.md")],
      workType: "docs",
    });

    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "Status", severity: "info", dimension: "scope" }),
        expect.objectContaining({ category: "Hygiene", severity: "low", dimension: "scope" }),
      ])
    );
  });
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

  it("accepts a context expect call completed by an added matcher", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", {
          patch: "@@ -1,2 +1,3 @@\n expect(parseSafely(input))\n+  .toEqual({ ok: false });",
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("adequate");
  });

  it("accepts an added expect assertion whose arrow body contains a semicolon", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", {
          patch: "+expect(() => { fail(); }).toThrow();",
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("adequate");
  });

  it("does not accept a context-only expect assertion plus an unrelated added line", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", {
          patch:
            "@@ -1,2 +1,3 @@\n expect(parseSafely(input)).toEqual({ ok: false });\n+const note = true;",
        }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
  });

  it("requires a Node assert call span to include an added segment", () => {
    const contextOnly = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("test/parser.test.ts", {
          patch: "@@ -1,2 +1,3 @@\n assert.deepStrictEqual(actual, expected);\n+const note = true;",
        }),
      ],
      workType: "bugfix",
    });
    const partiallyAdded = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("test/parser.test.ts", {
          patch: "@@ -1,3 +1,4 @@\n assert.deepStrictEqual(\n+  actual,\n   expected\n );",
        }),
      ],
      workType: "bugfix",
    });

    expect(contextOnly.testCoverageSignal).toBe("insufficient_evidence");
    expect(partiallyAdded.testCoverageSignal).toBe("adequate");
  });

  it.each([
    "@@ -1,4 +1,5 @@\n expect(\n+  // documents the existing assertion\n   actual\n ).toEqual(expected);",
    "@@ -1,4 +1,5 @@\n expect(\n+    \n   actual\n ).toEqual(expected);",
  ])("does not treat added comments or whitespace as meaningful assertion evidence", (patch) => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", { patch }),
      ],
      workType: "bugfix",
    });

    expect(result.testCoverageSignal).toBe("insufficient_evidence");
  });

  it.each([
    "@@ -1,4 +1,5 @@\n expect(\n+  \"fixed\"\n ).toEqual(expected);",
    "@@ -1,4 +1,5 @@\n expect(\n+  42\n ).toEqual(expected);",
    "@@ -1,4 +1,5 @@\n expect(\n+  actual\n ).toEqual(expected);",
  ])("accepts a meaningful added assertion argument", (patch) => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Reproduction\nBefore: malformed input crashed the parser." }),
      files: [
        file("src/parser.ts"),
        file("src/__tests__/parser.test.ts", { patch }),
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

  it("fails closed when security-focused review has no mature scanner evidence", () => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [file("src/index.ts"), file("src/index.test.ts")],
      workType: "feature",
      standard: "security-focused",
    });

    expect(result.secretScannerEvidence?.status).toBe("unverified");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingMatureSecretScannerEvidence", severity: "high" })
    );
    expect(result.conclusion).toBe("needs_changes");
  });

  it("fails closed when a caller supplies contradictory passing scanner evidence", () => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [file("src/index.ts"), file("src/index.test.ts")],
      workType: "feature",
      standard: "security-focused",
      secretScannerEvidence: {
        status: "passing",
        verified: false,
        degraded: true,
        providers: ["gitleaks"],
        signals: [],
        reason: "Contradictory serialized evidence.",
      },
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingMatureSecretScannerEvidence", severity: "high" })
    );
    expect(result.conclusion).toBe("needs_changes");
  });

  it.each([
    file(".github/workflows/secret-scan.yml"),
    file("docs/retired-secret-scan.yml", {
      previousFilename: ".github/workflows/secret-scan.yml",
    }),
    file(".GITHUB\\WORKFLOWS\\SECRET-SCAN.YML"),
    file(".gitleaks.toml"),
  ])("downgrades direct passing evidence when scanner policy is changed: $filename", (policyFile) => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [policyFile, file("src/index.test.ts")],
      workType: "feature",
      standard: "security-focused",
      secretScannerEvidence: secretScannerEvidence("passing"),
      secretScannerPolicyContext: scannerPolicyContext(),
    });

    expect(result.secretScannerEvidence).toMatchObject({
      status: "unverified",
      verified: false,
      degraded: true,
      signals: [
        expect.objectContaining({
          trusted: false,
          provenanceVerified: false,
        }),
      ],
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingMatureSecretScannerEvidence", severity: "high" })
    );
  });

  it.each([
    file(".github/workflows/ci.yml"),
    file(".github/workflows/build.yml", {
      previousFilename: ".github/workflows/old-build.yml",
    }),
  ])(
    "keeps verified scanner evidence when an unrelated workflow changes: $filename",
    (workflowFile) => {
      const result = evaluatePullRequestReview({
        pr: pr(),
        files: [workflowFile, file("src/index.test.ts")],
        workType: "infra",
        standard: "security-focused",
        secretScannerEvidence: secretScannerEvidence("passing"),
        secretScannerPolicyContext: scannerPolicyContext(),
      });

      expect(result.secretScannerEvidence).toMatchObject({
        status: "passing",
        verified: true,
        degraded: false,
      });
      expect(
        result.findings.some(
          (finding) => finding.category === "MissingMatureSecretScannerEvidence"
        )
      ).toBe(false);
    }
  );

  it.each([undefined, "docs/not-a-workflow.yml"])(
    "fails closed for any workflow change when verified scanner evidence has no valid workflow path: %s",
    (workflowPath) => {
      const result = evaluatePullRequestReview({
        pr: pr(),
        files: [file(".github/workflows/ci.yml"), file("src/index.test.ts")],
        workType: "infra",
        standard: "security-focused",
        secretScannerEvidence: secretScannerEvidence("passing"),
        ...(workflowPath === undefined
          ? {}
          : { secretScannerPolicyContext: scannerPolicyContext(workflowPath) }),
      });

      expect(result.secretScannerEvidence).toMatchObject({
        status: "unverified",
        verified: false,
        degraded: true,
      });
      expect(result.findings).toContainEqual(
        expect.objectContaining({
          category: "MissingMatureSecretScannerEvidence",
          severity: "high",
        })
      );
    }
  );

  it("invalidates only the changed scanner when independent evidence remains", () => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [
        file(".github/workflows/gitleaks.yml"),
        file("src/index.test.ts"),
      ],
      workType: "infra",
      standard: "security-focused",
      secretScannerEvidence: independentSecretScannerEvidence(),
      secretScannerPolicyContext: independentScannerPolicyContext(),
    });

    expect(result.secretScannerEvidence).toMatchObject({
      status: "passing",
      verified: true,
      degraded: false,
    });
    expect(
      result.secretScannerEvidence?.signals.find(
        (signal) => signal.provider === "gitleaks"
      )
    ).toMatchObject({
      trusted: false,
      provenanceVerified: false,
    });
    expect(
      result.secretScannerEvidence?.signals.find(
        (signal) => signal.provider === "trufflehog"
      )
    ).toMatchObject({
      trusted: true,
      provenanceVerified: true,
    });
    expect(result.secretScannerEvidence?.signals).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provenanceWorkflowPath: expect.any(String) }),
      ])
    );
  });

  it("accepts a passing mature scanner and exposes its provider", () => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [file("src/index.ts"), file("src/index.test.ts")],
      workType: "feature",
      standard: "security-focused",
      secretScannerEvidence: secretScannerEvidence("passing"),
      secretScannerPolicyContext: scannerPolicyContext(),
    });

    expect(result.secretScannerEvidence).toMatchObject({
      status: "passing",
      verified: true,
      providers: ["gitleaks"],
    });
    expect(
      result.findings.some((finding) => finding.category === "MissingMatureSecretScannerEvidence")
    ).toBe(false);
  });

  it.each([
    ["failing", "MatureSecretScannerFailed", "critical"],
    ["pending", "MatureSecretScannerPending", "high"],
  ] as const)("blocks a %s mature scanner result", (state, category, severity) => {
    const result = evaluatePullRequestReview({
      pr: pr(),
      files: [file("src/index.ts"), file("src/index.test.ts")],
      workType: "feature",
      standard: "security-focused",
      secretScannerEvidence: secretScannerEvidence(state),
    });

    expect(result.findings).toContainEqual(expect.objectContaining({ category, severity }));
    expect(result.conclusion).toBe("needs_changes");
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

  it.each(["chore(release): v1.6.0", "build(release): v1.6.0", "release: v1.6.0"])(
    "accepts a conventional release title target: %s",
    (title) => {
      const result = evaluatePullRequestReview({
        pr: pr({
          title,
          body:
            "## Verification\nRan `npm test`.\n## Rollback\nRestore v1.5.0 and republish the prior artifact.",
        }),
        files: [
          file("package.json", { patch: '+  "version": "1.6.0",' }),
          file("src/__tests__/publish.test.ts"),
        ],
        workType: "release",
      });

      expect(
        result.findings.some((finding) =>
          ["MissingReleaseVersion", "ReleaseVersionMismatch"].includes(finding.category)
        )
      ).toBe(false);
    }
  );

  it("does not treat a generic conventional version bump as a release target", () => {
    const result = evaluatePullRequestReview({
      pr: pr({
        title: "chore: bump 1.6.0",
        body:
          "## Verification\nRan `npm test`.\n## Rollback\nRestore v1.5.0 and republish the prior artifact.",
      }),
      files: [
        file("package.json", { patch: '+  "version": "1.6.0",' }),
        file("src/__tests__/publish.test.ts"),
      ],
      workType: "release",
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "MissingReleaseVersion", severity: "high" })
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

  it("includes caller-supplied policy evidence in the unified risk and conclusion", () => {
    const result = evaluatePullRequestReview({
      pr: pr({ body: "## Validated\nRan `npm test`." }),
      files: [file("README.md")],
      workType: "docs",
      policyFindings: [
        {
          severity: "critical",
          category: "Workflow Permissions",
          description: "The changed workflow grants write-all.",
          suggestion: "Use explicit least-privilege scopes.",
          dimension: "policy",
          paths: [".github/workflows/release.yml"],
          reason: "Complete workflow content contains permissions: write-all.",
        },
      ],
    });

    expect(result.findings).toContainEqual(
      expect.objectContaining({ category: "Workflow Permissions", dimension: "policy" })
    );
    expect(result.releaseRisk).toBe("critical");
    expect(result.conclusion).toBe("needs_changes");
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

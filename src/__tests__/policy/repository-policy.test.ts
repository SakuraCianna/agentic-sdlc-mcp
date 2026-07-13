import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPOSITORY_POLICY,
  MAX_POLICY_BYTES,
  matchRepositoryPolicy,
  parseRepositoryPolicy,
  pathMatchesPolicyGlob,
} from "../../policy/repository-policy.js";

const FULL_POLICY = `
schemaVersion: 1
defaultWorkType: security
requiredChecks:
  - { name: test, source: check_run, appId: 15368 }
  - { name: typecheck, source: check_run, appId: 15368 }
protectedPaths: [".github/**", "src/config.ts"]
riskRules:
  - id: risk.authorization
    paths: ["src/auth/**"]
    workTypes: [feature, bugfix, security]
    level: high
    domains: [authorization, cross-tenant]
labels:
  releaseBlocking: [release-blocker, security]
review:
  requireIssueLink: true
  requireCodeOwnersForProtectedPaths: true
  requiredReviewers:
    - id: reviewer.security
      riskRuleIds: [risk.authorization]
      paths: [".github/workflows/**"]
      reviewers: ["@security-team"]
release:
  requireChangelog: true
  requireRollbackPlan: true
`;

describe("parseRepositoryPolicy", () => {
  it("parses a strict full policy and records stable applied rule IDs", () => {
    const result = parseRepositoryPolicy(FULL_POLICY);

    expect(result.degraded).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.policy).toMatchObject({
      schemaVersion: 1,
      defaultWorkType: "security",
      requiredChecks: [
        { name: "test", source: "check_run", appId: 15368 },
        { name: "typecheck", source: "check_run", appId: 15368 },
      ],
      protectedPaths: [".github/**", "src/config.ts"],
      review: { requireIssueLink: true },
      release: { requireRollbackPlan: true },
    });
    expect(result.appliedRules.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([
        "work.default_type",
        "ci.required_checks",
        "paths.protected",
        "risk.authorization",
        "reviewer.security",
        "review.require_issue_link",
        "release.require_changelog",
        "release.require_rollback_plan",
      ])
    );
  });

  it("returns v1.6-compatible defaults for a minimal policy", () => {
    const result = parseRepositoryPolicy("schemaVersion: 1\n");

    expect(result.degraded).toBe(false);
    expect(result.policy).toEqual(DEFAULT_REPOSITORY_POLICY);
  });

  it.each([
    ["unknown root field", "schemaVersion: 1\nautoMerge: true\n"],
    ["unsupported schema", "schemaVersion: 2\n"],
    ["duplicate YAML key", "schemaVersion: 1\nrequiredChecks: []\nrequiredChecks: [{ name: test, source: check_run, appId: 15368 }]\n"],
    [
      "duplicate risk ID",
      "schemaVersion: 1\nriskRules:\n  - { id: risk.same, paths: ['a/**'], level: high, domains: [auth] }\n  - { id: risk.same, paths: ['b/**'], level: high, domains: [auth] }\n",
    ],
    [
      "unknown risk reference",
      "schemaVersion: 1\nreview:\n  requiredReviewers:\n    - { id: reviewer.security, riskRuleIds: [risk.missing], reviewers: ['@security-team'] }\n",
    ],
    [
      "empty reviewer selector",
      "schemaVersion: 1\nreview:\n  requiredReviewers:\n    - { id: reviewer.security, reviewers: ['@security-team'] }\n",
    ],
    [
      "empty reviewers",
      "schemaVersion: 1\nreview:\n  requiredReviewers:\n    - { id: reviewer.security, paths: ['src/**'], reviewers: [] }\n",
    ],
    ["absolute glob", "schemaVersion: 1\nprotectedPaths: ['/etc/**']\n"],
    ["traversal glob", "schemaVersion: 1\nprotectedPaths: ['../secrets/**']\n"],
    ["control character in check", 'schemaVersion: 1\nrequiredChecks: [{ name: "test\\n## injected", source: check_run, appId: 15368 }]\n'],
    ["unbound check name", "schemaVersion: 1\nrequiredChecks: [test]\n"],
    ["invalid check App", "schemaVersion: 1\nrequiredChecks: [{ name: test, source: check_run, appId: 0 }]\n"],
    ["control character in label", 'schemaVersion: 1\nlabels:\n  releaseBlocking: ["blocked\\rforged"]\n'],
    ["control character in domain", 'schemaVersion: 1\nriskRules:\n  - { id: risk.injected, paths: ["src/**"], level: high, domains: ["auth\\u0000forged"] }\n'],
  ])("rejects the complete policy for %s", (_name, source) => {
    const result = parseRepositoryPolicy(source);

    expect(result.degraded).toBe(true);
    expect(result.policy).toEqual(DEFAULT_REPOSITORY_POLICY);
    expect(result.errors).not.toHaveLength(0);
    expect(result.appliedRules).toEqual([]);
  });

  it("rejects oversized and alias-expanding YAML without throwing", () => {
    const oversized = `schemaVersion: 1\n#${"x".repeat(MAX_POLICY_BYTES)}`;
    const aliases = [
      "schemaVersion: 1",
      "base: &base [test]",
      ...Array.from({ length: 30 }, (_, index) => `alias${index}: *base`),
    ].join("\n");

    expect(parseRepositoryPolicy(oversized)).toMatchObject({ degraded: true });
    expect(parseRepositoryPolicy(aliases)).toMatchObject({ degraded: true });
  });

  it("produces the same digest for equivalent YAML formatting", () => {
    const block = parseRepositoryPolicy(
      "schemaVersion: 1\nrequiredChecks:\n  - { name: test, source: check_run, appId: 15368 }\n  - { name: typecheck, source: check_run, appId: 15368 }\n"
    );
    const flow = parseRepositoryPolicy(
      "{ schemaVersion: 1, requiredChecks: [{ name: test, source: check_run, appId: 15368 }, { name: typecheck, source: check_run, appId: 15368 }] }"
    );

    expect(block.digest).toBe(flow.digest);
  });
});

describe("policy path matching", () => {
  it.each([
    ["src/auth/session.ts", "src/auth/**", true],
    ["src/auth/nested/token.ts", "src/auth/**", true],
    ["src/other.ts", "src/auth/**", false],
    [".github/workflows/ci.yml", ".github/*.yml", false],
    ["src/config.ts", "src/config.?s", true],
    ["src\\auth\\session.ts", "src/auth/**", true],
  ])("matches %s against %s", (path, glob, expected) => {
    expect(pathMatchesPolicyGlob(path, glob)).toBe(expected);
  });

  it("matches protected paths, risk domains, and reviewer selectors once", () => {
    const parsed = parseRepositoryPolicy(FULL_POLICY);
    const matched = matchRepositoryPolicy(parsed.policy, [
      "src/auth/session.ts",
      ".github/workflows/ci.yml",
    ], "security");

    expect(matched.protectedPaths).toEqual([".github/**"]);
    expect(matched.riskRules.map((rule) => rule.id)).toEqual(["risk.authorization"]);
    expect(matched.requiredReviewers.map((rule) => rule.id)).toEqual([
      "reviewer.security",
    ]);
    expect(matched.reviewers).toEqual(["@security-team"]);
  });
});

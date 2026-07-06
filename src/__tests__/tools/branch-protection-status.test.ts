/**
 * Tests for src/tools/branch-protection-status.ts
 * Covers: computeConclusion, handleBranchProtectionStatus output conclusions
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

const { computeConclusion, handleBranchProtectionStatus } = await import(
  "../../tools/branch-protection-status.js"
);

import type { BranchProtectionStatusInput } from "../../tools/branch-protection-status.js";
import type { Finding, RepoRef } from "../../types.js";

// ---------------------------------------------------------------------------
// computeConclusion (pure helper)
// ---------------------------------------------------------------------------

describe("computeConclusion", () => {
  it("returns 'unprotected' when no classic protection and no rulesets exist", () => {
    expect(computeConclusion(false, [], [])).toBe("unprotected");
  });

  it("returns 'protected' when classic protection is enabled and no critical/high findings", () => {
    const findings: Finding[] = [{ severity: "low", category: "Branch Protection", description: "x" }];
    expect(computeConclusion(true, [], findings)).toBe("protected");
  });

  it("returns 'protected' when rulesets exist and no critical/high findings", () => {
    expect(computeConclusion(false, ["pull_request"], [])).toBe("protected");
  });

  it("returns 'partially_protected' when a high finding is present despite some protection", () => {
    const findings: Finding[] = [
      { severity: "high", category: "Branch Protection", description: "force pushes allowed" },
    ];
    expect(computeConclusion(true, [], findings)).toBe("partially_protected");
  });

  it("returns 'partially_protected' when a critical finding is present despite some protection", () => {
    const findings: Finding[] = [
      { severity: "critical", category: "Branch Protection", description: "critical issue" },
    ];
    expect(computeConclusion(true, ["required_status_checks"], findings)).toBe("partially_protected");
  });
});

// ---------------------------------------------------------------------------
// handleBranchProtectionStatus — integration with mock octokit
// ---------------------------------------------------------------------------

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeMockOctokit(opts: {
  protection?: unknown;
  protectionError?: unknown;
  rules?: Array<{ type: string }>;
  rulesError?: unknown;
  defaultBranch?: string;
}) {
  return {
    repos: {
      get: vi.fn().mockResolvedValue({ data: { default_branch: opts.defaultBranch ?? "main" } }),
      getBranchProtection: opts.protectionError
        ? vi.fn().mockRejectedValue(opts.protectionError)
        : vi.fn().mockResolvedValue({ data: opts.protection ?? {} }),
      getBranchRules: opts.rulesError
        ? vi.fn().mockRejectedValue(opts.rulesError)
        : vi.fn().mockResolvedValue({ data: opts.rules ?? [] }),
    },
  } as unknown as Parameters<typeof handleBranchProtectionStatus>[2];
}

describe("handleBranchProtectionStatus", () => {
  it("reports 'unprotected' when neither classic protection nor rulesets exist", async () => {
    const octokit = makeMockOctokit({
      protectionError: Object.assign(new Error("Not Found"), { status: 404 }),
      rules: [],
    });

    const params: BranchProtectionStatusInput = {};
    const { structured, text } = await handleBranchProtectionStatus(params, REF, octokit);

    expect(structured.conclusion).toBe("unprotected");
    expect(structured.classicProtectionEnabled).toBe(false);
    expect(structured.errors.length).toBeGreaterThan(0);
    expect(text).toContain("UNPROTECTED");
  });

  it("reports 'protected' when full classic protection is configured", async () => {
    const octokit = makeMockOctokit({
      protection: {
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          require_code_owner_reviews: true,
        },
        required_status_checks: { contexts: ["CI"] },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_conversation_resolution: { enabled: true },
      },
      rules: [],
    });

    const params: BranchProtectionStatusInput = { branch: "main" };
    const { structured, text } = await handleBranchProtectionStatus(params, REF, octokit);

    expect(structured.conclusion).toBe("protected");
    expect(structured.classicProtectionEnabled).toBe(true);
    expect(structured.findings).toHaveLength(0);
    expect(text).toContain("PROTECTED");
  });

  it("reports 'partially_protected' and flags force pushes / deletions allowed", async () => {
    const octokit = makeMockOctokit({
      protection: {
        required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true },
        required_status_checks: { contexts: ["CI"] },
        allow_force_pushes: { enabled: true },
        allow_deletions: { enabled: true },
        required_conversation_resolution: { enabled: true },
      },
      rules: [],
    });

    const params: BranchProtectionStatusInput = { branch: "main" };
    const { structured } = await handleBranchProtectionStatus(params, REF, octokit);

    expect(structured.conclusion).toBe("partially_protected");
    const descriptions = structured.findings.map((f) => f.description);
    expect(descriptions.some((d) => d.includes("Force pushes"))).toBe(true);
    expect(descriptions.some((d) => d.includes("deletion is allowed"))).toBe(true);
  });

  it("falls back to the repository's default branch when branch is not provided", async () => {
    const octokit = makeMockOctokit({ defaultBranch: "trunk", rules: ["pull_request"].map((t) => ({ type: t })) });
    const params: BranchProtectionStatusInput = {};
    const { structured } = await handleBranchProtectionStatus(params, REF, octokit);
    expect(structured.branch).toBe("trunk");
  });

  it("still returns ruleset findings when classic protection call errors", async () => {
    const octokit = makeMockOctokit({
      protectionError: Object.assign(new Error("Not Found"), { status: 404 }),
      rules: [
        { type: "pull_request" },
        { type: "required_status_checks" },
        { type: "non_fast_forward" },
        { type: "deletion" },
      ],
    });

    const params: BranchProtectionStatusInput = { branch: "main" };
    const { structured } = await handleBranchProtectionStatus(params, REF, octokit);

    expect(structured.rulesetRuleTypes).toEqual([
      "pull_request",
      "required_status_checks",
      "non_fast_forward",
      "deletion",
    ]);
    expect(structured.findings).toHaveLength(0);
    expect(structured.conclusion).toBe("protected");
  });

  it("still returns classic protection findings when the ruleset call errors", async () => {
    const octokit = makeMockOctokit({
      protection: {
        required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true },
        required_status_checks: { contexts: ["CI"] },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        required_conversation_resolution: { enabled: true },
      },
      rulesError: Object.assign(new Error("Forbidden"), { status: 403 }),
    });

    const params: BranchProtectionStatusInput = { branch: "main" };
    const { structured } = await handleBranchProtectionStatus(params, REF, octokit);

    expect(structured.classicProtectionEnabled).toBe(true);
    expect(structured.rulesetRuleTypes).toEqual([]);
    expect(structured.errors.some((e) => e.startsWith("Rulesets:"))).toBe(true);
    expect(structured.conclusion).toBe("protected");
  });

  it("does not flag force-push/deletion when a ruleset blocks them without classic protection", async () => {
    const octokit = makeMockOctokit({
      protectionError: Object.assign(new Error("Not Found"), { status: 404 }),
      rules: [
        { type: "pull_request" },
        { type: "required_status_checks" },
        { type: "non_fast_forward" },
        { type: "deletion" },
      ],
    });

    const params: BranchProtectionStatusInput = { branch: "main" };
    const { structured } = await handleBranchProtectionStatus(params, REF, octokit);

    const descriptions = structured.findings.map((f) => f.description);
    expect(descriptions.some((d) => d.includes("Force pushes"))).toBe(false);
    expect(descriptions.some((d) => d.includes("deletion is allowed"))).toBe(false);
  });

  it("flags force-push/deletion when rulesets exist but lack non_fast_forward/deletion rules", async () => {
    const octokit = makeMockOctokit({
      protectionError: Object.assign(new Error("Not Found"), { status: 404 }),
      rules: [{ type: "pull_request" }, { type: "required_status_checks" }],
    });

    const params: BranchProtectionStatusInput = { branch: "main" };
    const { structured } = await handleBranchProtectionStatus(params, REF, octokit);

    const descriptions = structured.findings.map((f) => f.description);
    expect(descriptions.some((d) => d.includes("Force pushes"))).toBe(true);
    expect(descriptions.some((d) => d.includes("deletion is allowed"))).toBe(true);
    expect(structured.conclusion).toBe("partially_protected");
  });
});

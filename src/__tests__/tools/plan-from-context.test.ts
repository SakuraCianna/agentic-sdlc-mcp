/**
 * Tests for src/tools/plan-from-context.ts
 * Covers: buildPlan, inferWorkType, handlePlanFromContext structured output
 * across workType-specific templates (docs, feature, bugfix, refactor,
 * security, release, infra).
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

const { buildPlan, inferWorkType, handlePlanFromContext } =
  await import("../../tools/plan-from-context.js");

import type { PlanFromContextInput } from "../../tools/plan-from-context.js";

// ---------------------------------------------------------------------------
// buildPlan (pure helper)
// ---------------------------------------------------------------------------

describe("buildPlan", () => {
  it("returns all 6 SDLC phases for the default (feature) workType", () => {
    const plan = buildPlan("Add login flow", "myorg/myrepo");
    const phases = plan.map((p) => p.phase);
    expect(phases).toEqual(["plan", "create", "test", "review", "optimize", "secure"]);
  });

  it("includes the goal in each phase summary", () => {
    const plan = buildPlan("Deploy caching layer", "org/repo");
    for (const phase of plan) {
      expect(phase.summary).toContain("Deploy caching layer");
    }
  });

  it("each phase has at least one task", () => {
    const plan = buildPlan("Refactor auth", "org/repo");
    for (const phase of plan) {
      expect(phase.tasks.length).toBeGreaterThan(0);
    }
  });

  it("returns all 6 phases for every workType", () => {
    const workTypes = ["docs", "feature", "bugfix", "refactor", "security", "release", "infra"] as const;
    for (const wt of workTypes) {
      const plan = buildPlan("Some goal", "org/repo", wt);
      expect(plan.map((p) => p.phase)).toEqual(["plan", "create", "test", "review", "optimize", "secure"]);
    }
  });

  it("docs plan does not mention unit tests in Create, but Test phase still verifies examples", () => {
    const plan = buildPlan("Update install docs", "org/repo", "docs");
    const createPhase = plan.find((p) => p.phase === "create")!;
    const testPhase = plan.find((p) => p.phase === "test")!;
    expect(createPhase.tasks.some((t) => /unit test/i.test(t))).toBe(false);
    expect(testPhase.tasks.some((t) => /example|link/i.test(t))).toBe(true);
  });

  it("bugfix plan requires repro and regression test tasks", () => {
    const plan = buildPlan("Fix crash on save", "org/repo", "bugfix");
    const planPhase = plan.find((p) => p.phase === "plan")!;
    const createPhase = plan.find((p) => p.phase === "create")!;
    expect(planPhase.tasks.some((t) => /reproduce/i.test(t))).toBe(true);
    expect(createPhase.tasks.some((t) => /regression test/i.test(t))).toBe(true);
  });

  it("security plan includes threat model and least-privilege tasks", () => {
    const plan = buildPlan("Audit workflow permissions", "org/repo", "security");
    const planPhase = plan.find((p) => p.phase === "plan")!;
    const createPhase = plan.find((p) => p.phase === "create")!;
    expect(planPhase.tasks.some((t) => /threat model/i.test(t))).toBe(true);
    expect(createPhase.tasks.some((t) => /least-privilege/i.test(t))).toBe(true);
  });

  it("release plan includes changelog, version bump, and rollback references", () => {
    const plan = buildPlan("Cut v2.0.0", "org/repo", "release");
    const createPhase = plan.find((p) => p.phase === "create")!;
    const securePhase = plan.find((p) => p.phase === "secure")!;
    expect(createPhase.tasks.some((t) => /changelog/i.test(t))).toBe(true);
    expect(createPhase.tasks.some((t) => /version/i.test(t))).toBe(true);
    expect(securePhase.tasks.some((t) => /rollback/i.test(t))).toBe(true);
  });

  it("infra plan includes least-privilege permissions and workflow_permissions_audit reference", () => {
    const plan = buildPlan("Update CI workflow", "org/repo", "infra");
    const reviewPhase = plan.find((p) => p.phase === "review")!;
    expect(reviewPhase.tasks.some((t) => /workflow_permissions_audit/i.test(t))).toBe(true);
  });

  it("refactor plan requires confirming behaviour is unchanged and full test coverage", () => {
    const plan = buildPlan("Simplify config loader", "org/repo", "refactor");
    const planPhase = plan.find((p) => p.phase === "plan")!;
    expect(planPhase.tasks.some((t) => /existing tests/i.test(t))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// inferWorkType (pure helper)
// ---------------------------------------------------------------------------

describe("inferWorkType", () => {
  it("returns the explicit workType with high confidence when provided", () => {
    const result = inferWorkType("Add dark mode", [], "docs");
    expect(result).toEqual({
      workType: "docs",
      confidence: "high",
      reasoning: expect.stringContaining("explicitly provided"),
      needsClarification: false,
    });
  });

  it("infers docs from goal keywords", () => {
    const result = inferWorkType("Update the README documentation for setup", []);
    expect(result.workType).toBe("docs");
    expect(result.needsClarification).toBe(false);
  });

  it("infers bugfix from goal keywords", () => {
    const result = inferWorkType("Fix crash when saving with no network", []);
    expect(result.workType).toBe("bugfix");
  });

  it("infers security from goal + acceptance criteria keywords", () => {
    const result = inferWorkType("Review workflow permissions", [
      "No write-all permissions remain",
      "Audit all secrets usage",
    ]);
    expect(result.workType).toBe("security");
    expect(result.confidence).toBe("high");
  });

  it("infers release from goal keywords", () => {
    const result = inferWorkType("Prepare changelog and version bump for release", []);
    expect(result.workType).toBe("release");
  });

  it("infers infra from goal keywords", () => {
    const result = inferWorkType("Update the GitHub Actions CI/CD pipeline", []);
    expect(result.workType).toBe("infra");
  });

  it("infers refactor from goal keywords", () => {
    const result = inferWorkType("Refactor the config loader to simplify logic", []);
    expect(result.workType).toBe("refactor");
  });

  it("defaults to feature with low confidence and needsClarification when no keywords match", () => {
    const result = inferWorkType("Add support for webhooks", []);
    expect(result.workType).toBe("feature");
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
  });

  it("supports Chinese-language keyword signals", () => {
    const result = inferWorkType("修复登录页面报错的问题", []);
    expect(result.workType).toBe("bugfix");
  });

  // Regression tests: keyword matching must use word boundaries, not bare
  // substring search. A prior implementation used `text.includes(kw)`, which
  // let short keywords like "fix" or "secret" match inside unrelated words
  // and silently mis-categorised ordinary feature requests.
  describe("word-boundary false-positive regressions", () => {
    it("does not match 'fix' inside 'prefix'", () => {
      const result = inferWorkType("Add a configurable URL prefix option", []);
      expect(result.workType).toBe("feature");
      expect(result.needsClarification).toBe(true);
    });

    it("does not match 'fix' inside 'suffix'", () => {
      const result = inferWorkType("Add a suffix option to generated file names", []);
      expect(result.workType).toBe("feature");
      expect(result.needsClarification).toBe(true);
    });

    it("does not match a bugfix keyword inside 'fixed-price'", () => {
      const result = inferWorkType("Add a fixed-price billing tier", []);
      expect(result.workType).toBe("feature");
      expect(result.needsClarification).toBe(true);
    });

    it("still infers bugfix for genuine 'fix'/'fixes' usage", () => {
      expect(inferWorkType("Fix crash when saving with no network", []).workType).toBe("bugfix");
      expect(inferWorkType("This PR fixes the broken login flow", []).workType).toBe("bugfix");
    });

    it("still infers security for plural 'permissions'/'secrets' usage", () => {
      const result = inferWorkType("Review workflow permissions and secrets usage", []);
      expect(result.workType).toBe("security");
    });
  });

  it("picks the first workType by priority order and flags needsClarification on an exact tie", () => {
    // "Fix the guide" matches "guide" (docs) and "fix" (bugfix) -- one keyword each.
    // docs precedes bugfix in WORK_TYPE_PRIORITY, so it should win the tie-break.
    const result = inferWorkType("Fix the guide", []);
    expect(result.workType).toBe("docs");
    expect(result.confidence).toBe("low");
    expect(result.needsClarification).toBe(true);
    expect(result.reasoning).toContain("Multiple work types matched with equal signal");
  });
});

// ---------------------------------------------------------------------------
// handlePlanFromContext (with mock fetchContext)
// ---------------------------------------------------------------------------

describe("handlePlanFromContext", () => {
  const mockFetch = vi.fn().mockResolvedValue({
    name: "myrepo",
    fullName: "myorg/myrepo",
    description: "Test repo",
    defaultBranch: "main",
    visibility: "public",
    language: "TypeScript",
    stargazersCount: 5,
    openIssuesCount: 2,
    topics: [],
    pushedAt: "2026-01-01T00:00:00Z",
  });

  it("returns structured output with all phases", async () => {
    const params: PlanFromContextInput = {
      goal: "Add dark mode support",
      owner: "myorg",
      repo: "myrepo",
    };

    const { structured } = await handlePlanFromContext(params, mockFetch);

    expect(structured.goal).toBe("Add dark mode support");
    expect(structured.repo).toBe("myorg/myrepo");
    expect(structured.phases).toHaveLength(6);
    expect(structured.suggestedIssues.length).toBeGreaterThan(0);
    expect(structured.risks.length).toBeGreaterThan(0);
  });

  it("includes constraints and acceptance criteria in structured output", async () => {
    const params: PlanFromContextInput = {
      goal: "Migrate to PostgreSQL",
      owner: "myorg",
      repo: "myrepo",
      constraints: ["must not break existing API"],
      acceptanceCriteria: ["all tests pass", "migration is reversible"],
    };

    const { structured } = await handlePlanFromContext(params, mockFetch);

    expect(structured.constraints).toEqual(["must not break existing API"]);
    expect(structured.acceptanceCriteria).toEqual([
      "all tests pass",
      "migration is reversible",
    ]);
  });

  it("includes the goal in text output", async () => {
    const params: PlanFromContextInput = {
      goal: "Build webhook integration",
      owner: "myorg",
      repo: "myrepo",
    };

    const { text } = await handlePlanFromContext(params, mockFetch);

    expect(text).toContain("Build webhook integration");
    expect(text).toContain("SDLC Plan");
    expect(text).toContain("Phase-by-Phase Plan");
  });

  it("includes suggested issues in text output", async () => {
    const params: PlanFromContextInput = {
      goal: "Add rate limiting",
      owner: "myorg",
      repo: "myrepo",
    };

    const { text } = await handlePlanFromContext(params, mockFetch);

    expect(text).toContain("create_issue_set");
    expect(text).toContain("[Plan]");
    expect(text).toContain("[Create]");
  });

  it("respects an explicit workType even when goal keywords suggest otherwise", async () => {
    const params: PlanFromContextInput = {
      goal: "Add rate limiting",
      owner: "myorg",
      repo: "myrepo",
      workType: "security",
    };

    const { structured } = await handlePlanFromContext(params, mockFetch);

    expect(structured.workType).toBe("security");
    expect(structured.confidence).toBe("high");
    expect(structured.needsClarification).toBe(false);
  });

  it("infers workType: docs for a docs-only goal and does not require unit tests in Create", async () => {
    const params: PlanFromContextInput = {
      goal: "Document the MCP configuration and dryRun usage",
      owner: "myorg",
      repo: "myrepo",
      acceptanceCriteria: ["Includes env var explanation", "Includes repo_context example"],
    };

    const { structured, text } = await handlePlanFromContext(params, mockFetch);

    expect(structured.workType).toBe("docs");
    const createPhase = structured.phases.find((p) => p.phase === "create")!;
    expect(createPhase.tasks.some((t) => /unit test/i.test(t))).toBe(false);
    expect(text).toContain("Work type:** docs");
  });

  it("infers workType: bugfix and includes repro + regression test guidance", async () => {
    const params: PlanFromContextInput = {
      goal: "Fix quality_gate_status incorrectly showing passing on a PR with no checks",
      owner: "myorg",
      repo: "myrepo",
    };

    const { structured } = await handlePlanFromContext(params, mockFetch);

    expect(structured.workType).toBe("bugfix");
    const planPhase = structured.phases.find((p) => p.phase === "plan")!;
    expect(planPhase.tasks.some((t) => /reproduce/i.test(t))).toBe(true);
  });

  it("infers workType: security and includes threat model + audit gates", async () => {
    const params: PlanFromContextInput = {
      goal: "Audit workflow permissions and flag overly broad scopes",
      owner: "myorg",
      repo: "myrepo",
    };

    const { structured } = await handlePlanFromContext(params, mockFetch);

    expect(structured.workType).toBe("security");
    const securePhase = structured.phases.find((p) => p.phase === "secure")!;
    expect(securePhase.tasks.length).toBeGreaterThan(0);
  });

  it("flags needsClarification when workType inference is low-confidence", async () => {
    const params: PlanFromContextInput = {
      goal: "Improve the onboarding experience",
      owner: "myorg",
      repo: "myrepo",
    };

    const { structured, text } = await handlePlanFromContext(params, mockFetch);

    expect(structured.needsClarification).toBe(true);
    expect(text).toContain("NEEDS CLARIFICATION");
  });
});

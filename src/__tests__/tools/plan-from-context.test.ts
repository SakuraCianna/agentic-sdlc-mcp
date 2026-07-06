/**
 * Tests for src/tools/plan-from-context.ts
 * Covers: buildPlan, handlePlanFromContext structured output
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

const { buildPlan, handlePlanFromContext } =
  await import("../../tools/plan-from-context.js");

import type { PlanFromContextInput } from "../../tools/plan-from-context.js";

// ---------------------------------------------------------------------------
// buildPlan (pure helper)
// ---------------------------------------------------------------------------

describe("buildPlan", () => {
  it("returns all 6 SDLC phases", () => {
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
});

/**
 * Tool: plan_from_context
 *
 * Handler extracted as `buildPlan` and `handlePlanFromContext` for testing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, handleGitHubError } from "../github/client.js";
import { fetchRepoContext } from "../github/context.js";
import type { SdlcPhase, SdlcPlanPhase } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PlanFromContextInputSchema = z.object({
  goal: z.string().min(5).describe("The user goal or feature request to plan around."),
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  constraints: z.array(z.string()).optional()
    .describe("Technical or business constraints."),
  acceptanceCriteria: z.array(z.string()).optional()
    .describe("Acceptance criteria the implementation must satisfy."),
});

export type PlanFromContextInput = z.infer<typeof PlanFromContextInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const PlanFromContextOutputSchema = {
  goal: z.string(),
  repo: z.string(),
  defaultBranch: z.string(),
  language: z.string().nullable(),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  phases: z.array(
    z.object({
      phase: z.string(),
      summary: z.string(),
      tasks: z.array(z.string()),
    })
  ),
  suggestedIssues: z.array(z.string()),
  risks: z.array(z.string()),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanFromContextResult {
  goal: string;
  repo: string;
  defaultBranch: string;
  language: string | null;
  constraints: string[];
  acceptanceCriteria: string[];
  phases: SdlcPlanPhase[];
  suggestedIssues: string[];
  risks: string[];
}

// ---------------------------------------------------------------------------
// Phase templates (pure data)
// ---------------------------------------------------------------------------

const PHASE_TEMPLATES: Record<SdlcPhase, { tasks: string[] }> = {
  plan: {
    tasks: [
      "Clarify requirements and acceptance criteria",
      "Identify affected components and files",
      "Define API contracts or data model changes",
      "Review existing tests and coverage",
      "List risks and unknowns",
    ],
  },
  create: {
    tasks: [
      "Create a feature branch from the default branch",
      "Implement the required changes",
      "Add unit tests for new logic",
      "Update inline documentation and comments",
    ],
  },
  test: {
    tasks: [
      "Run the full test suite locally",
      "Verify no regression in existing tests",
      "Write integration tests if applicable",
      "Test edge cases and error paths",
    ],
  },
  review: {
    tasks: [
      "Create a pull request with a clear description",
      "Self-review the diff for unintended changes",
      "Request review from at least one team member",
      "Address all review comments",
    ],
  },
  optimize: {
    tasks: [
      "Profile the affected code path if performance-sensitive",
      "Look for obvious algorithmic improvements",
      "Ensure no unnecessary dependencies were added",
    ],
  },
  secure: {
    tasks: [
      "Run Dependabot or dependency audit",
      "Check for secret leakage in diffs",
      "Verify input validation and error handling",
      "Review access control changes if any",
    ],
  },
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Build the phase-by-phase plan. Pure — no I/O. */
export function buildPlan(goal: string, repoName: string): SdlcPlanPhase[] {
  return (Object.keys(PHASE_TEMPLATES) as SdlcPhase[]).map((phase) => ({
    phase,
    summary: `${phase.charAt(0).toUpperCase() + phase.slice(1)} phase for: ${goal} (${repoName})`,
    tasks: PHASE_TEMPLATES[phase].tasks,
  }));
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handlePlanFromContext(
  params: PlanFromContextInput,
  fetchContext: typeof fetchRepoContext
): Promise<{ text: string; structured: PlanFromContextResult }> {
  const constraints = params.constraints ?? [];
  const acceptance = params.acceptanceCriteria ?? [];

  const ref = resolveRepo(params.owner, params.repo);
  const ctx = await fetchContext({ ...ref });
  const plan = buildPlan(params.goal, ctx.fullName);

  const suggestedIssues = [
    `[Plan] Define acceptance criteria and technical approach for: ${params.goal}`,
    `[Create] Implement: ${params.goal}`,
    `[Test] Add tests for: ${params.goal}`,
    `[Secure] Security review for: ${params.goal}`,
  ];

  const risks = [
    "Unknown scope may expand during implementation",
    "Existing tests may need updating",
    "Review latency may block the cycle",
  ];

  const structured: PlanFromContextResult = {
    goal: params.goal,
    repo: ctx.fullName,
    defaultBranch: ctx.defaultBranch,
    language: ctx.language ?? null,
    constraints,
    acceptanceCriteria: acceptance,
    phases: plan,
    suggestedIssues,
    risks,
  };

  const lines: string[] = [
    `# SDLC Plan: ${params.goal}`,
    "",
    `**Repository:** ${ctx.fullName}`,
    `**Default branch:** \`${ctx.defaultBranch}\``,
    `**Language:** ${ctx.language ?? "unknown"}`,
    "",
    "## Background",
    `Goal: **${params.goal}**`,
  ];

  if (constraints.length > 0) {
    lines.push("", "### Constraints");
    constraints.forEach((c) => lines.push(`- ${c}`));
  }

  if (acceptance.length > 0) {
    lines.push("", "### Acceptance Criteria");
    acceptance.forEach((a) => lines.push(`- ${a}`));
  }

  lines.push("", "## Phase-by-Phase Plan");
  for (const phase of plan) {
    lines.push(
      "",
      `### ${phase.phase.charAt(0).toUpperCase() + phase.phase.slice(1)}`,
      `*${phase.summary}*`,
      ""
    );
    phase.tasks.forEach((t) => lines.push(`- [ ] ${t}`));
  }

  lines.push(
    "",
    "## Suggested Issues to Create",
    "",
    "Use `create_issue_set` with these suggested issues:",
    ...suggestedIssues.map((s) => `- ${s}`),
    "",
    "## Risks",
    ...risks.map((r) => `- ${r}`),
    "",
    "## Human Approval Gates",
    "- PR review must be approved before merge",
    "- Security review required for auth/data-handling changes",
    "- Release checklist must pass before deployment"
  );

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlanFromContextTool(server: McpServer): void {
  server.registerTool(
    "plan_from_context",
    {
      title: "Generate SDLC Plan from Context",
      description: `Generate a structured Agentic SDLC plan (Plan->Create->Test->Review->Optimize->Secure) from a goal and repo context.

Template-based — no LLM call needed. Reads basic repo metadata to enrich the plan.

Args:
  - goal (string): The user's goal or feature description (required).
  - owner, repo: Repo coordinates (fall back to env vars).
  - constraints (string[]?): Technical or business constraints.
  - acceptanceCriteria (string[]?): Explicit acceptance criteria.

Returns: Phase-by-phase SDLC plan + structured output.`,
      inputSchema: PlanFromContextInputSchema,
      outputSchema: PlanFromContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PlanFromContextInput) => {
      try {
        const { text, structured } = await handlePlanFromContext(params, fetchRepoContext);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleGitHubError(error) }],
        };
      }
    }
  );
}

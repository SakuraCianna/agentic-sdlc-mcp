/**
 * Tool: plan_from_context
 *
 * Generates a structured Agentic SDLC plan from a user goal and optional
 * repo context. Does NOT call an LLM — purely template-based orchestration.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, handleGitHubError } from "../github/client.js";
import { fetchRepoContext } from "../github/context.js";
import type { SdlcPhase, SdlcPlanPhase } from "../types.js";

const PlanFromContextInputSchema = z.object({
  goal: z
    .string()
    .min(5, "goal must be at least 5 characters")
    .describe("The user goal or feature request to plan around."),
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  constraints: z
    .array(z.string())
    .optional()
    .describe("List of constraints to consider (e.g., 'must not break existing API')."),
  acceptanceCriteria: z
    .array(z.string())
    .optional()
    .describe("List of acceptance criteria the implementation must satisfy."),
});

type PlanFromContextInput = z.infer<typeof PlanFromContextInputSchema>;

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

function buildPlan(goal: string, repoName: string, constraints: string[], acceptance: string[]): SdlcPlanPhase[] {
  return (Object.keys(PHASE_TEMPLATES) as SdlcPhase[]).map((phase) => ({
    phase,
    summary: `${phase.charAt(0).toUpperCase() + phase.slice(1)} phase for: ${goal} (${repoName})`,
    tasks: PHASE_TEMPLATES[phase].tasks,
  }));
}

export function registerPlanFromContextTool(server: McpServer): void {
  server.registerTool(
    "plan_from_context",
    {
      title: "Generate SDLC Plan from Context",
      description: `Generate a structured Agentic SDLC plan (Plan→Create→Test→Review→Optimize→Secure) from a goal and optional repo context.

This tool is purely template-based — it does not call an LLM. It reads basic repo metadata to enrich the plan with context.

Args:
  - goal (string): The user's goal or feature description (required).
  - owner, repo (string?): Repo coordinates, fall back to env vars.
  - constraints (string[]?): Technical or business constraints.
  - acceptanceCriteria (string[]?): Explicit acceptance criteria.

Returns: A phase-by-phase SDLC plan with suggested issues and risk summary.`,
      inputSchema: PlanFromContextInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PlanFromContextInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);

        // Fetch lightweight repo context (no readme/issues to keep it fast)
        const ctx = await fetchRepoContext({ ...ref });

        const constraints = params.constraints ?? [];
        const acceptance = params.acceptanceCriteria ?? [];

        const plan = buildPlan(params.goal, ctx.fullName, constraints, acceptance);

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
          `- [Plan] Define acceptance criteria and technical approach for: ${params.goal}`,
          `- [Create] Implement: ${params.goal}`,
          `- [Test] Add tests for: ${params.goal}`,
          `- [Secure] Security review for: ${params.goal}`,
          "",
          "## Risks",
          "- Unknown scope may expand during implementation",
          "- Existing tests may need updating",
          "- Review latency may block the cycle",
          "",
          "## Human Approval Gates",
          "- ✋ PR review must be approved before merge",
          "- ✋ Security review is required for auth/data-handling changes",
          "- ✋ Release checklist must pass before deployment"
        );

        return {
          content: [{ type: "text", text: lines.join("\n") }],
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

/**
 * Tool: prepare_work_item
 *
 * Generates an agent-ready brief for a specific GitHub issue.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";

const PrepareWorkItemInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  issueNumber: z.number().int().positive().describe("The GitHub issue number."),
  includeRelatedFiles: z
    .boolean()
    .default(false)
    .describe("Attempt to identify related files from issue body keywords."),
  includeRecentPRs: z
    .boolean()
    .default(false)
    .describe("Include recent merged PRs touching related files."),
});

type PrepareWorkItemInput = z.infer<typeof PrepareWorkItemInputSchema>;

export function registerPrepareWorkItemTool(server: McpServer): void {
  server.registerTool(
    "prepare_work_item",
    {
      title: "Prepare Work Item Brief",
      description: `Generate an agent-ready brief for a GitHub issue, including summary, goals, non-goals, acceptance criteria, risks, and a handoff prompt.

Use this before starting implementation to ensure the agent has full context.

Args:
  - owner, repo: Repository coordinates.
  - issueNumber (number): The issue to prepare.
  - includeRelatedFiles (boolean): Heuristically list related file paths. Default: false.
  - includeRecentPRs (boolean): List recent PRs on related files. Default: false.

Returns: A structured markdown brief ready to paste into an agent prompt.`,
      inputSchema: PrepareWorkItemInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PrepareWorkItemInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();

        const { data: issue } = await octokit.issues.get({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: params.issueNumber,
        });

        const { data: comments } = await octokit.issues.listComments({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: params.issueNumber,
          per_page: 5,
        });

        const labels = issue.labels.map((l) =>
          typeof l === "string" ? l : l.name ?? ""
        );

        // Heuristic: extract potential file paths from body/title
        const fileHints: string[] = [];
        if (params.includeRelatedFiles && issue.body) {
          const matches = issue.body.match(/[a-zA-Z0-9_/.-]+\.[a-zA-Z]{2,5}/g) ?? [];
          const filtered = matches
            .filter((m) => m.includes("/") || m.endsWith(".ts") || m.endsWith(".js") || m.endsWith(".py"))
            .slice(0, 10);
          fileHints.push(...filtered);
        }

        const lines: string[] = [
          `# Work Item Brief: #${issue.number} — ${issue.title}`,
          "",
          `**URL:** ${issue.html_url}`,
          `**State:** ${issue.state}`,
          `**Labels:** ${labels.length > 0 ? labels.join(", ") : "(none)"}`,
          `**Assignees:** ${issue.assignees && issue.assignees.length > 0 ? issue.assignees.map((a) => "@" + a.login).join(", ") : "(none)"}`,
          `**Created:** ${issue.created_at}`,
          "",
          "## Issue Summary",
          "",
          issue.body ?? "(no description)",
          "",
          "## Goals",
          "- Implement the changes described in the issue above",
          "- Ensure all acceptance criteria are met",
          "- Maintain or improve test coverage",
          "",
          "## Non-Goals",
          "- Do not refactor unrelated code",
          "- Do not change public API contracts unless explicitly stated in the issue",
          "",
          "## Acceptance Criteria",
          "_(Derived from issue body — verify these with the issue author)_",
          "- [ ] All described behaviour is implemented and tested",
          "- [ ] No regressions in existing tests",
          "- [ ] PR passes all CI checks",
          "",
          "## Risks",
          "- Scope may be broader than the issue description suggests",
          "- Related tests may need updating",
          "- Linked issues (if any) may introduce dependencies",
        ];

        if (comments.length > 0) {
          lines.push("", "## Recent Comments");
          for (const c of comments.slice(0, 3)) {
            lines.push(
              `\n**@${c.user?.login ?? "unknown"}** (${c.created_at}):\n${(c.body ?? "").slice(0, 300)}${(c.body ?? "").length > 300 ? "..." : ""}`
            );
          }
        }

        if (fileHints.length > 0) {
          lines.push("", "## Potentially Related Files _(heuristic)_");
          fileHints.forEach((f) => lines.push(`- \`${f}\``));
        }

        lines.push(
          "",
          "## Recommended Verification Commands",
          "```bash",
          "# Run tests",
          "npm test  # or: pytest / cargo test / go test ./...",
          "",
          "# Type check (TypeScript projects)",
          "npm run typecheck",
          "",
          "# Lint",
          "npm run lint",
          "```",
          "",
          "## Agent Handoff Prompt",
          "",
          "```",
          `You are working on issue #${issue.number}: "${issue.title}" in ${ref.owner}/${ref.repo}.`,
          `The full issue description is above. Your task is to implement the required changes,`,
          `add tests, and open a pull request. Follow the non-goals and acceptance criteria strictly.`,
          `Use the quality_gate_status tool to verify CI before marking work complete.`,
          "```"
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleGitHubError(error) }],
        };
      }
    }
  );
}

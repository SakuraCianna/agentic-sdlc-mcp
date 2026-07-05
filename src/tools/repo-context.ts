/**
 * Tool: repo_context
 *
 * Reads repository baseline context — metadata, README, package.json,
 * open issues and PRs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, handleGitHubError } from "../github/client.js";
import {
  fetchRepoContext,
  summarizePackageJson,
} from "../github/context.js";

const RepoContextInputSchema = z.object({
  owner: z
    .string()
    .optional()
    .describe("GitHub owner (org or user). Falls back to GITHUB_OWNER env var."),
  repo: z
    .string()
    .optional()
    .describe("GitHub repo name. Falls back to GITHUB_REPO env var."),
  includeReadme: z
    .boolean()
    .default(true)
    .describe("Include a truncated README summary."),
  includePackageJson: z
    .boolean()
    .default(false)
    .describe("Include a package.json summary if present."),
  includeOpenIssues: z
    .boolean()
    .default(false)
    .describe("Include a list of recent open issues (up to 20)."),
  includeOpenPRs: z
    .boolean()
    .default(false)
    .describe("Include a list of open pull requests (up to 20)."),
});

type RepoContextInput = z.infer<typeof RepoContextInputSchema>;

export function registerRepoContextTool(server: McpServer): void {
  server.registerTool(
    "repo_context",
    {
      title: "Get Repository Context",
      description: `Read baseline context for a GitHub repository, including metadata, README summary, package.json summary, open issues, and open PRs.

Use this tool at the start of any SDLC workflow to understand the codebase before planning or creating work items.

Args:
  - owner (string?): GitHub org or user. Defaults to GITHUB_OWNER env var.
  - repo (string?): Repository name. Defaults to GITHUB_REPO env var.
  - includeReadme (boolean): Include truncated README. Default: true.
  - includePackageJson (boolean): Include package.json summary. Default: false.
  - includeOpenIssues (boolean): Include recent open issues. Default: false.
  - includeOpenPRs (boolean): Include open pull requests. Default: false.

Returns: Markdown summary of the repository context.`,
      inputSchema: RepoContextInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: RepoContextInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const ctx = await fetchRepoContext({
          ...ref,
          includeReadme: params.includeReadme,
          includePackageJson: params.includePackageJson,
          includeOpenIssues: params.includeOpenIssues,
          includeOpenPRs: params.includeOpenPRs,
        });

        const lines: string[] = [
          `# Repository Context: ${ctx.fullName}`,
          "",
          `**Description:** ${ctx.description ?? "(none)"}`,
          `**Default branch:** \`${ctx.defaultBranch}\``,
          `**Visibility:** ${ctx.visibility}`,
          `**Language:** ${ctx.language ?? "unknown"}`,
          `**Stars:** ${ctx.stargazersCount}`,
          `**Open issues (total):** ${ctx.openIssuesCount}`,
          `**Topics:** ${ctx.topics.length > 0 ? ctx.topics.join(", ") : "(none)"}`,
          `**Last pushed:** ${ctx.pushedAt ?? "unknown"}`,
        ];

        if (ctx.packageJson) {
          lines.push("", "## package.json Summary", "```", summarizePackageJson(ctx.packageJson), "```");
        }

        if (ctx.readme) {
          lines.push("", "## README (truncated)", "", ctx.readme);
        }

        if (ctx.openIssues && ctx.openIssues.length > 0) {
          lines.push("", "## Open Issues (recent)");
          for (const issue of ctx.openIssues) {
            const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
            lines.push(`- #${issue.number} ${issue.title}${labels} — ${issue.url}`);
          }
        } else if (params.includeOpenIssues) {
          lines.push("", "## Open Issues", "(none)");
        }

        if (ctx.openPRs && ctx.openPRs.length > 0) {
          lines.push("", "## Open Pull Requests");
          for (const pr of ctx.openPRs) {
            const draftTag = pr.draft ? " [DRAFT]" : "";
            lines.push(`- #${pr.number}${draftTag} ${pr.title} by @${pr.author} — ${pr.url}`);
          }
        } else if (params.includeOpenPRs) {
          lines.push("", "## Open Pull Requests", "(none)");
        }

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

/**
 * Tool: create_issue_set
 *
 * Batch-creates GitHub issues from a plan. Supports dryRun (default: true).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";

const IssueItemSchema = z.object({
  title: z.string().min(1).describe("Issue title."),
  body: z.string().describe("Issue body in markdown."),
  labels: z.array(z.string()).optional().describe("Labels to attach."),
  assignees: z.array(z.string()).optional().describe("GitHub logins to assign."),
});

const CreateIssueSetInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  titlePrefix: z
    .string()
    .optional()
    .describe("Optional prefix to prepend to all issue titles (e.g. '[Feature]')."),
  issues: z
    .array(IssueItemSchema)
    .min(1)
    .max(50)
    .describe("Array of issues to create (1–50)."),
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      "SAFETY: When true (default) returns the payloads without creating anything. " +
        "Set to false to actually create issues on GitHub."
    ),
});

type CreateIssueSetInput = z.infer<typeof CreateIssueSetInputSchema>;

export function registerCreateIssueSetTool(server: McpServer): void {
  server.registerTool(
    "create_issue_set",
    {
      title: "Create Issue Set",
      description: `Batch-create GitHub issues from a plan. Supports dryRun safety mode (default: true).

⚠️  dryRun defaults to TRUE. Set dryRun: false to actually write to GitHub.

Args:
  - owner, repo: Repository coordinates.
  - titlePrefix (string?): Prepended to all issue titles.
  - issues (array): Each issue has title, body, optional labels and assignees.
  - dryRun (boolean): Default true — preview mode only.

Returns:
  - dryRun=true: Returns payloads that WOULD be created (no GitHub writes).
  - dryRun=false: Creates issues and returns their URLs.`,
      inputSchema: CreateIssueSetInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CreateIssueSetInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const prefix = params.titlePrefix ? `${params.titlePrefix} ` : "";

        const payloads = params.issues.map((issue) => ({
          title: `${prefix}${issue.title}`,
          body: issue.body,
          labels: issue.labels ?? [],
          assignees: issue.assignees ?? [],
        }));

        if (params.dryRun) {
          const lines = [
            "# DryRun: Issue Set Preview",
            "",
            `Repository: **${ref.owner}/${ref.repo}**`,
            `Issues to create: **${payloads.length}**`,
            "",
            "> ℹ️  No changes were made. Set \`dryRun: false\` to create these issues.",
            "",
          ];

          payloads.forEach((p, i) => {
            lines.push(`## Issue ${i + 1}: ${p.title}`);
            if (p.labels.length > 0) lines.push(`Labels: ${p.labels.join(", ")}`);
            if (p.assignees.length > 0) lines.push(`Assignees: ${p.assignees.join(", ")}`);
            lines.push("", p.body, "");
          });

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Actually create issues
        const octokit = getOctokit();
        const created: Array<{ number: number; title: string; url: string }> = [];

        for (const payload of payloads) {
          const { data } = await octokit.issues.create({
            owner: ref.owner,
            repo: ref.repo,
            title: payload.title,
            body: payload.body,
            labels: payload.labels,
            assignees: payload.assignees,
          });
          created.push({ number: data.number, title: data.title, url: data.html_url });
        }

        const lines = [
          `# Created ${created.length} Issues on ${ref.owner}/${ref.repo}`,
          "",
        ];
        created.forEach((c) => lines.push(`- #${c.number} [${c.title}](${c.url})`));

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

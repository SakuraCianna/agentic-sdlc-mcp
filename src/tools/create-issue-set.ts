/**
 * Tool: create_issue_set
 *
 * Handler extracted as `handleCreateIssueSet` for testability.
 * Splits an SDLC plan into GitHub issues. dryRun defaults to TRUE.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const CreateIssueSetInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  titlePrefix: z.string().optional().describe("Optional prefix prepended to every issue title."),
  issues: z
    .array(
      z.object({
        title: z.string().min(1).describe("Issue title."),
        body: z.string().describe("Issue body (markdown)."),
        labels: z.array(z.string()).optional().describe("Labels to apply."),
        assignees: z.array(z.string()).optional().describe("GitHub usernames to assign."),
      })
    )
    .min(1)
    .max(50)
    .describe("Array of issues to create (1-50)."),
  dryRun: z
    .boolean()
    .default(true)
    .describe("If true (default), preview issues without creating them."),
});

export type CreateIssueSetInput = z.infer<typeof CreateIssueSetInputSchema>;

export const CreateIssueSetOutputSchema = {
  dryRun: z.boolean().describe("Whether this was a preview-only run."),
  count: z.number().int().describe("Number of issues previewed or created."),
  issues: z
    .array(
      z.object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
      })
    )
    .describe("Created issues (empty in dry run)."),
  previewTitles: z.array(z.string()).describe("Final titles (with prefix applied)."),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatedIssue {
  number: number;
  title: string;
  url: string;
}

export interface CreateIssueSetResult {
  dryRun: boolean;
  count: number;
  issues: CreatedIssue[];
  previewTitles: string[];
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateIssueSet(
  params: CreateIssueSetInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: CreateIssueSetResult }> {
  const prefix = params.titlePrefix ? `${params.titlePrefix} ` : "";

  if (params.dryRun) {
    const previewTitles = params.issues.map((i) => `${prefix}${i.title}`);
    const structured: CreateIssueSetResult = {
      dryRun: true,
      count: params.issues.length,
      issues: [],
      previewTitles,
    };
    const lines = [
      `# Issue Set Preview (dry run) - ${params.issues.length} issue(s)`,
      "",
      `Repo: ${ref.owner}/${ref.repo}`,
      "",
      "> No issues were created. Set `dryRun: false` to create them.",
      "",
    ];
    params.issues.forEach((issue, i) => {
      lines.push(
        `## ${i + 1}. ${prefix}${issue.title}`,
        "",
        issue.body,
        "",
        issue.labels && issue.labels.length > 0 ? `**Labels:** ${issue.labels.join(", ")}` : "",
        issue.assignees && issue.assignees.length > 0
          ? `**Assignees:** ${issue.assignees.join(", ")}`
          : "",
        ""
      );
    });
    return { text: lines.filter((l) => l !== "").join("\n"), structured };
  }

  // Live mode - create issues sequentially
  const created: CreatedIssue[] = [];
  for (const issue of params.issues) {
    const { data } = await octokit.issues.create({
      owner: ref.owner,
      repo: ref.repo,
      title: `${prefix}${issue.title}`,
      body: issue.body,
      labels: issue.labels,
      assignees: issue.assignees,
    });
    created.push({ number: data.number, title: data.title, url: data.html_url });
  }

  const structured: CreateIssueSetResult = {
    dryRun: false,
    count: created.length,
    issues: created,
    previewTitles: created.map((c) => c.title),
  };
  const lines = [
    `# Issue Set Created - ${created.length} issue(s)`,
    "",
    `Repo: ${ref.owner}/${ref.repo}`,
    "",
    ...created.map((c) => `- #${c.number} ${c.title} - ${c.url}`),
  ];
  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCreateIssueSetTool(server: McpServer): void {
  server.registerTool(
    "create_issue_set",
    {
      title: "Create GitHub Issue Set",
      description: `Split an SDLC plan into GitHub issues. Supports dryRun (default TRUE) - preview mode.

SAFETY: dryRun defaults to true. You MUST explicitly pass dryRun:false to create issues.

Args:
  - owner, repo: Repository coordinates.
  - titlePrefix (string?): Prefix for every issue title.
  - issues (array): 1-50 issues, each with title, body, labels?, assignees?.
  - dryRun (boolean): Default true - preview mode only.

Returns: Created issue numbers + URLs (live) or a preview (dry run).`,
      inputSchema: CreateIssueSetInputSchema,
      outputSchema: CreateIssueSetOutputSchema,
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
        const octokit = getOctokit();
        const { text, structured } = await handleCreateIssueSet(params, ref, octokit);
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

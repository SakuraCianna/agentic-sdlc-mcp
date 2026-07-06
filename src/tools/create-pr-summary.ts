/**
 * Tool: create_pr_summary
 *
 * Handler extracted as `handleCreatePrSummary` for testing.
 * Uses paginateAll for PR file listing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, paginateAll, handleGitHubError } from "../github/client.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const CreatePrSummaryInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z.number().int().positive().describe("The pull request number to summarise."),
});

export type CreatePrSummaryInput = z.infer<typeof CreatePrSummaryInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const CreatePrSummaryOutputSchema = {
  pullNumber: z.number().int(),
  title: z.string(),
  author: z.string(),
  isDraft: z.boolean(),
  baseRef: z.string(),
  headRef: z.string(),
  commits: z.number().int(),
  totalAdditions: z.number().int(),
  totalDeletions: z.number().int(),
  totalFiles: z.number().int(),
  hasTests: z.boolean(),
  risks: z.array(z.string()),
  labels: z.array(z.string()),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrSummaryResult {
  pullNumber: number;
  title: string;
  author: string;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  commits: number;
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
  hasTests: boolean;
  risks: string[];
  labels: string[];
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreatePrSummary(
  params: CreatePrSummaryInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: PrSummaryResult }> {
  const { data: pr } = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: params.pullNumber,
  });

  // Paginate — large PRs can have > 100 files
  const files = await paginateAll(
    (page, perPage) =>
      octokit.pulls
        .listFiles({ owner: ref.owner, repo: ref.repo, pull_number: params.pullNumber, per_page: perPage, page })
        .then((r) => r.data),
    300
  );

  const labels = pr.labels.map((l) => l.name ?? "");
  const isDraft = pr.draft ?? false;
  const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
  const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

  const testFiles = files.filter(
    (f) =>
      f.filename.includes("/test") ||
      f.filename.includes("/spec") ||
      f.filename.includes("__tests__") ||
      /\.(test|spec)\.[jt]sx?$/.test(f.filename)
  );
  const srcFiles = files.filter((f) => !testFiles.includes(f));
  const configFiles = files.filter(
    (f) =>
      f.filename.endsWith(".json") ||
      f.filename.endsWith(".yml") ||
      f.filename.endsWith(".yaml") ||
      f.filename.endsWith(".toml") ||
      /\.env(\.|$)/.test(f.filename)
  );
  const docFiles = files.filter(
    (f) =>
      f.filename.endsWith(".md") ||
      f.filename.endsWith(".rst") ||
      f.filename.startsWith("docs/")
  );

  const hasTests = testFiles.length > 0;

  // Compute risks
  const risks: string[] = [];
  if (configFiles.length > 0) risks.push("Config file changes — verify no hardcoded secrets.");
  if (totalAdditions > 500) risks.push("Large diff (>500 added lines) — consider splitting.");
  if (!hasTests) risks.push("No test files detected — risk of regression.");

  const structured: PrSummaryResult = {
    pullNumber: pr.number,
    title: pr.title,
    author: pr.user?.login ?? "unknown",
    isDraft,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    commits: pr.commits,
    totalAdditions,
    totalDeletions,
    totalFiles: files.length,
    hasTests,
    risks,
    labels,
  };

  const lines: string[] = [
    `# PR Summary: #${pr.number} — ${pr.title}`,
    "",
    `**Author:** @${pr.user?.login ?? "unknown"}`,
    `**Status:** ${isDraft ? "Draft" : "Ready for review"}`,
    `**Base -> Head:** \`${pr.base.ref}\` <- \`${pr.head.ref}\``,
    `**Labels:** ${labels.length > 0 ? labels.join(", ") : "(none)"}`,
    `**Created:** ${pr.created_at}`,
    `**Commits:** ${pr.commits}`,
    "",
    "## Change Overview",
    "",
    pr.body ?? "_No PR description provided._",
    "",
    "## Affected Files",
    "",
    `**+${totalAdditions} / -${totalDeletions}** across **${files.length} files**`,
    "",
    "### Source Files",
  ];

  srcFiles.slice(0, 20).forEach((f) => {
    lines.push(`- \`${f.filename}\` (+${f.additions}/-${f.deletions}) [${f.status}]`);
  });
  if (srcFiles.length > 20) lines.push(`- _(${srcFiles.length - 20} more)_`);

  if (testFiles.length > 0) {
    lines.push("", "### Test Files");
    testFiles.forEach((f) => lines.push(`- \`${f.filename}\``));
  }

  if (configFiles.length > 0) {
    lines.push("", "### Config / Schema Files (review carefully)");
    configFiles.forEach((f) => lines.push(`- \`${f.filename}\``));
  }

  if (docFiles.length > 0) {
    lines.push("", "### Documentation");
    docFiles.forEach((f) => lines.push(`- \`${f.filename}\``));
  }

  lines.push(
    "",
    "## Test Coverage Signals",
    "",
    hasTests
      ? `${testFiles.length} test file(s) included in this PR.`
      : "No test files detected in this PR. Consider adding or updating tests.",
    "",
    "## Risks",
    ""
  );
  if (risks.length === 0) {
    lines.push("- No significant risks detected.");
  } else {
    risks.forEach((r) => lines.push(`- ${r}`));
  }

  lines.push(
    "",
    "## Review Checklist",
    "",
    "- [ ] Logic is correct and matches the issue/ticket",
    "- [ ] Edge cases are handled",
    "- [ ] Tests added or updated",
    "- [ ] No secrets or credentials in the diff",
    "- [ ] Documentation updated if behaviour changed",
    "- [ ] No unnecessary dependencies added",
    "- [ ] CI checks passing",
    "",
    "## Release Notes Draft",
    "",
    "```markdown",
    `### ${pr.title}`,
    "",
    pr.body ? pr.body.split("\n").slice(0, 5).join("\n") : `Added/fixed: ${pr.title}`,
    "```"
  );

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCreatePrSummaryTool(server: McpServer): void {
  server.registerTool(
    "create_pr_summary",
    {
      title: "Create PR Summary",
      description: `Generate a structured PR summary from the pull request diff and metadata.

The summary includes: change overview, affected files, test coverage signals, risks, review checklist, and release notes draft.

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number): The PR to summarise.

Returns: Markdown PR summary + structured metadata.`,
      inputSchema: CreatePrSummaryInputSchema,
      outputSchema: CreatePrSummaryOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: CreatePrSummaryInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleCreatePrSummary(params, ref, octokit);
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

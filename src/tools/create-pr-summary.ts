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
import { safeMarkdownInline } from "../rendering/markdown.js";

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
  docsOnly: z.boolean(),
  filesTruncated: z.boolean(),
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
  docsOnly: boolean;
  filesTruncated: boolean;
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
  const fileEvidence = await paginateAll(
    (page, perPage) =>
      octokit.pulls
        .listFiles({ owner: ref.owner, repo: ref.repo, pull_number: params.pullNumber, per_page: perPage, page })
        .then((r) => r.data),
    301
  );
  const filesTruncated = fileEvidence.length > 300;
  const files = fileEvidence.slice(0, 300);

  const labels = pr.labels.map((label) => (label.name ?? "").trim()).filter(Boolean);
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
  const docsOnly = !filesTruncated && files.length > 0 && files.every((file) => docFiles.includes(file));

  // Compute risks
  const risks: string[] = [];
  if (configFiles.length > 0) risks.push("Config file changes — verify no hardcoded secrets.");
  if (totalAdditions > 500) risks.push("Large diff (>500 added lines) — consider splitting.");
  if (!hasTests && !docsOnly) risks.push("No test files detected — risk of regression.");
  if (filesTruncated) risks.push("File evidence is incomplete after the 300-file safety cap.");

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
    docsOnly,
    filesTruncated,
    risks,
    labels,
  };

  const renderedTitle = safeMarkdownInline(pr.title, { maxLength: 300 });
  const renderedBody = pr.body
    ? safeMarkdownInline(pr.body, { maxLength: 2_000 })
    : "_No PR description provided._";
  const renderFile = (filename: string) => safeMarkdownInline(filename, { maxLength: 300 });

  const lines: string[] = [
    `# PR Summary: #${pr.number} — ${renderedTitle}`,
    "",
    `**Author:** @${safeMarkdownInline(pr.user?.login ?? "unknown", { maxLength: 100 })}`,
    `**Status:** ${isDraft ? "Draft" : "Ready for review"}`,
    `**Base -> Head:** \`${safeMarkdownInline(pr.base.ref, { maxLength: 200 })}\` <- \`${safeMarkdownInline(pr.head.ref, { maxLength: 200 })}\``,
    `**Labels:** ${labels.length > 0 ? labels.map((label) => safeMarkdownInline(label, { maxLength: 100 })).join(", ") : "(none)"}`,
    `**Created:** ${safeMarkdownInline(pr.created_at, { maxLength: 100 })}`,
    `**Commits:** ${pr.commits}`,
    "",
    "## Change Overview",
    "",
    renderedBody,
    "",
    "## Affected Files",
    "",
    `**+${totalAdditions} / -${totalDeletions}** across **${files.length} files**${filesTruncated ? " _(truncated; evidence incomplete)_" : ""}`,
    "",
    "### Source Files",
  ];

  srcFiles.slice(0, 20).forEach((f) => {
    lines.push(`- \`${renderFile(f.filename)}\` (+${f.additions}/-${f.deletions}) [${safeMarkdownInline(f.status, { maxLength: 50 })}]`);
  });
  if (srcFiles.length > 20) lines.push(`- _(${srcFiles.length - 20} more)_`);

  if (testFiles.length > 0) {
    lines.push("", "### Test Files");
    testFiles.slice(0, 20).forEach((f) => lines.push(`- \`${renderFile(f.filename)}\``));
    if (testFiles.length > 20) lines.push(`- _(${testFiles.length - 20} more)_`);
  }

  if (configFiles.length > 0) {
    lines.push("", "### Config / Schema Files (review carefully)");
    configFiles.slice(0, 20).forEach((f) => lines.push(`- \`${renderFile(f.filename)}\``));
    if (configFiles.length > 20) lines.push(`- _(${configFiles.length - 20} more)_`);
  }

  if (docFiles.length > 0) {
    lines.push("", "### Documentation");
    docFiles.slice(0, 20).forEach((f) => lines.push(`- \`${renderFile(f.filename)}\``));
    if (docFiles.length > 20) lines.push(`- _(${docFiles.length - 20} more)_`);
  }

  lines.push(
    "",
    "## Test Coverage Signals",
    "",
    docsOnly
      ? "Documentation-only change; validate commands, links, and rendered output instead of requiring code tests."
      : hasTests
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
    `### ${renderedTitle}`,
    "",
    pr.body ? renderedBody : `Added/fixed: ${renderedTitle}`,
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

/**
 * Tool: create_pr_summary
 *
 * Generates a structured PR summary from diff + metadata.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";

const CreatePrSummaryInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z
    .number()
    .int()
    .positive()
    .describe("The pull request number to summarise."),
});

type CreatePrSummaryInput = z.infer<typeof CreatePrSummaryInputSchema>;

export function registerCreatePrSummaryTool(server: McpServer): void {
  server.registerTool(
    "create_pr_summary",
    {
      title: "Create PR Summary",
      description: `Generate a structured PR summary from the pull request diff and metadata.

The summary includes: change overview, affected files, test coverage signals, risks, a review checklist, and a release notes draft.

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number): The PR to summarise.

Returns: A markdown PR summary ready to paste into the PR description or a review comment.`,
      inputSchema: CreatePrSummaryInputSchema,
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

        const { data: pr } = await octokit.pulls.get({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: params.pullNumber,
        });

        const { data: files } = await octokit.pulls.listFiles({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: params.pullNumber,
          per_page: 100,
        });

        const labels = pr.labels.map((l) => l.name ?? "");
        const isDraft = pr.draft ?? false;
        const totalAdditions = files.reduce((s, f) => s + f.additions, 0);
        const totalDeletions = files.reduce((s, f) => s + f.deletions, 0);

        // Categorise files
        const testFiles = files.filter(
          (f) =>
            f.filename.includes("test") ||
            f.filename.includes("spec") ||
            f.filename.includes("__tests__")
        );
        const srcFiles = files.filter((f) => !testFiles.includes(f));
        const configFiles = files.filter(
          (f) =>
            f.filename.endsWith(".json") ||
            f.filename.endsWith(".yml") ||
            f.filename.endsWith(".yaml") ||
            f.filename.endsWith(".toml") ||
            f.filename.endsWith(".env") ||
            f.filename.endsWith(".env.example")
        );
        const docFiles = files.filter(
          (f) =>
            f.filename.endsWith(".md") ||
            f.filename.endsWith(".rst") ||
            f.filename.startsWith("docs/")
        );

        const hasTests = testFiles.length > 0;

        const lines: string[] = [
          `# PR Summary: #${pr.number} — ${pr.title}`,
          "",
          `**Author:** @${pr.user?.login ?? "unknown"}  `,
          `**Status:** ${isDraft ? "🔧 Draft" : "🟢 Ready"}  `,
          `**Base → Head:** \`${pr.base.ref}\` ← \`${pr.head.ref}\`  `,
          `**Labels:** ${labels.length > 0 ? labels.join(", ") : "(none)"}  `,
          `**Created:** ${pr.created_at}  `,
          `**Commits:** ${pr.commits}  `,
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
        if (srcFiles.length > 20) lines.push(`- _(${srcFiles.length - 20} more…)_`);

        if (testFiles.length > 0) {
          lines.push("", "### Test Files");
          testFiles.forEach((f) => lines.push(`- \`${f.filename}\``));
        }

        if (configFiles.length > 0) {
          lines.push("", "### Config / Schema Files _(review carefully)_");
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
            ? `✅ **${testFiles.length}** test file(s) included in this PR.`
            : "⚠️  No test files detected in this PR. Consider adding or updating tests.",
          "",
          "## Risks",
          "",
          configFiles.length > 0
            ? "- ⚠️ Config file changes — verify no environment-specific values are hardcoded."
            : "- Config files unchanged.",
          totalAdditions > 500
            ? "- ⚠️ Large diff (+500 lines) — consider breaking into smaller PRs."
            : "- Diff size is manageable.",
          !hasTests ? "- ⚠️ No tests — risk of regression." : "- Tests present.",
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
          pr.body
            ? pr.body.split("\n").slice(0, 5).join("\n")
            : `Added/fixed: ${pr.title}`,
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

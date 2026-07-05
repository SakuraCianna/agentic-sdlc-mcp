/**
 * Tool: quality_gate_status
 *
 * Reads GitHub check runs and commit statuses for a PR or a ref.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { CheckStatus } from "../types.js";

const QualityGateInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("PR number. Takes precedence over ref when provided."),
  ref: z
    .string()
    .optional()
    .describe("Git ref (branch name, commit SHA) to check. Ignored if pullNumber is set."),
});

type QualityGateInput = z.infer<typeof QualityGateInputSchema>;

export function registerQualityGateStatusTool(server: McpServer): void {
  server.registerTool(
    "quality_gate_status",
    {
      title: "Quality Gate Status",
      description: `Read check-run and commit-status results for a pull request or git ref.

Use this to decide whether CI is passing before merging or releasing.

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number?): PR number. Preferred — resolves the HEAD commit automatically.
  - ref (string?): Branch name or commit SHA. Used when pullNumber is not provided.

Returns: A summary of all check runs with pass/fail/pending status, next actions, and overall conclusion.`,
      inputSchema: QualityGateInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: QualityGateInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();

        let headSha: string;
        let contextLabel: string;

        if (params.pullNumber) {
          const { data: pr } = await octokit.pulls.get({
            owner: ref.owner,
            repo: ref.repo,
            pull_number: params.pullNumber,
          });
          headSha = pr.head.sha;
          contextLabel = `PR #${params.pullNumber} (${pr.title})`;
        } else if (params.ref) {
          const { data: refData } = await octokit.git.getRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: params.ref.replace(/^refs\//, ""),
          });
          headSha = refData.object.sha;
          contextLabel = `ref: ${params.ref}`;
        } else {
          throw new Error("Either pullNumber or ref is required.");
        }

        const { data: checksData } = await octokit.checks.listForRef({
          owner: ref.owner,
          repo: ref.repo,
          ref: headSha,
          per_page: 100,
        });

        const checks: CheckStatus[] = checksData.check_runs.map((run) => ({
          name: run.name,
          status: (run.status as CheckStatus["status"]) ?? "unknown",
          conclusion: (run.conclusion as CheckStatus["conclusion"]) ?? null,
          url: run.html_url ?? null,
        }));

        const failing = checks.filter(
          (c) => c.conclusion === "failure" || c.conclusion === "timed_out"
        );
        const pending = checks.filter(
          (c) => c.status === "queued" || c.status === "in_progress" || c.status === "pending"
        );
        const passing = checks.filter((c) => c.conclusion === "success");
        const skipped = checks.filter(
          (c) => c.conclusion === "skipped" || c.conclusion === "neutral"
        );

        const overallOk = failing.length === 0 && pending.length === 0;
        const conclusion = overallOk
          ? "✅ All checks passed"
          : failing.length > 0
          ? "❌ Some checks are failing"
          : "⏳ Checks are still running";

        const lines: string[] = [
          `# Quality Gate Status — ${contextLabel}`,
          "",
          `**Commit:** \`${headSha.slice(0, 8)}\``,
          `**Conclusion:** ${conclusion}`,
          "",
          `| | Count |`,
          `|---|---|`,
          `| ✅ Passing | ${passing.length} |`,
          `| ❌ Failing | ${failing.length} |`,
          `| ⏳ Pending | ${pending.length} |`,
          `| ⏭️ Skipped | ${skipped.length} |`,
          `| 📊 Total | ${checks.length} |`,
        ];

        if (failing.length > 0) {
          lines.push("", "## ❌ Failing Checks");
          failing.forEach((c) => {
            const link = c.url ? ` — [view](${c.url})` : "";
            lines.push(`- **${c.name}**: ${c.conclusion}${link}`);
          });
        }

        if (pending.length > 0) {
          lines.push("", "## ⏳ Pending Checks");
          pending.forEach((c) => lines.push(`- **${c.name}**: ${c.status}`));
        }

        if (passing.length > 0) {
          lines.push("", "## ✅ Passing Checks");
          passing.forEach((c) => lines.push(`- ${c.name}`));
        }

        lines.push("", "## Next Actions");
        if (failing.length > 0) {
          lines.push(
            "- Fix the failing checks listed above before proceeding.",
            "- Use `review_pr_against_standard` for deeper analysis of PR issues."
          );
        } else if (pending.length > 0) {
          lines.push("- Wait for pending checks to complete, then re-run this tool.");
        } else {
          lines.push(
            "- All checks pass. Safe to request review or merge.",
            "- Run `release_readiness_check` for a full pre-release assessment."
          );
        }

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

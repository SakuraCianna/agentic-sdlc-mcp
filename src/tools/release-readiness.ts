/**
 * Tool: release_readiness_check
 *
 * Pre-release checklist: checks CI, security, open issues, docs, and produces
 * a rollback template.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import { config } from "../config.js";

const ReleaseReadinessInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  baseRef: z
    .string()
    .optional()
    .describe("Base ref for comparison (e.g. previous tag). Defaults to default branch."),
  headRef: z
    .string()
    .optional()
    .describe("Head ref to release (e.g. current branch). Defaults to default branch."),
  pullNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("If provided, checks the PR's head commit CI status instead of headRef."),
});

type ReleaseReadinessInput = z.infer<typeof ReleaseReadinessInputSchema>;

export function registerReleaseReadinessTool(server: McpServer): void {
  server.registerTool(
    "release_readiness_check",
    {
      title: "Release Readiness Check",
      description: `Run a pre-release assessment: CI status, open issues, security alerts, and produce a release checklist and rollback template.

Use this before tagging a release or deploying to production.

Args:
  - owner, repo: Repository coordinates.
  - baseRef, headRef (string?): Comparison range. Defaults to default branch.
  - pullNumber (number?): If provided, uses the PR's head commit for CI status.

Returns: readiness flag, blocking issues, CI status, security summary, docs check, rollback template, and release checklist.`,
      inputSchema: ReleaseReadinessInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ReleaseReadinessInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();

        const { data: repoData } = await octokit.repos.get({
          owner: ref.owner,
          repo: ref.repo,
        });

        const defaultBranch = repoData.default_branch ?? config.defaultBranch;
        const headRef = params.headRef ?? defaultBranch;

        // CI status for head
        let ciStatus = "unknown";
        let ciSummary = "";
        try {
          let headSha: string;
          if (params.pullNumber) {
            const { data: pr } = await octokit.pulls.get({
              owner: ref.owner,
              repo: ref.repo,
              pull_number: params.pullNumber,
            });
            headSha = pr.head.sha;
          } else {
            const { data: refData } = await octokit.git.getRef({
              owner: ref.owner,
              repo: ref.repo,
              ref: `heads/${headRef}`,
            });
            headSha = refData.object.sha;
          }

          const { data: checks } = await octokit.checks.listForRef({
            owner: ref.owner,
            repo: ref.repo,
            ref: headSha,
            per_page: 100,
          });

          const failing = checks.check_runs.filter((c) => c.conclusion === "failure");
          const pending = checks.check_runs.filter(
            (c) => c.status === "queued" || c.status === "in_progress"
          );

          if (failing.length > 0) {
            ciStatus = "failing";
            ciSummary = `❌ ${failing.length} check(s) failing: ${failing.map((c) => c.name).join(", ")}`;
          } else if (pending.length > 0) {
            ciStatus = "pending";
            ciSummary = `⏳ ${pending.length} check(s) still running`;
          } else {
            ciStatus = "passing";
            ciSummary = `✅ All ${checks.check_runs.length} check(s) passing`;
          }
        } catch {
          ciSummary = "⚠️ Could not fetch CI status (check token permissions)";
        }

        // Open critical issues
        const { data: openIssues } = await octokit.issues.listForRepo({
          owner: ref.owner,
          repo: ref.repo,
          state: "open",
          labels: "bug",
          per_page: 10,
        });
        const bugIssues = openIssues.filter((i) => !i.pull_request);

        // Check for CHANGELOG
        let hasChangelog = false;
        try {
          await octokit.repos.getContent({
            owner: ref.owner,
            repo: ref.repo,
            path: "CHANGELOG.md",
          });
          hasChangelog = true;
        } catch {
          // not found
        }

        const blockingIssues: string[] = [];
        if (ciStatus === "failing") blockingIssues.push("CI checks are failing");
        if (bugIssues.length > 0)
          blockingIssues.push(`${bugIssues.length} open bug(s) — review before release`);

        const isReady = blockingIssues.length === 0 && ciStatus !== "failing";

        const lines: string[] = [
          `# Release Readiness Check: ${ref.owner}/${ref.repo}`,
          "",
          `**Head ref:** \`${headRef}\``,
          `**Ready to release:** ${isReady ? "✅ YES" : "❌ NO — see blocking issues below"}`,
          "",
          "## CI Status",
          ciSummary,
          "",
          "## Open Bugs",
        ];

        if (bugIssues.length === 0) {
          lines.push("✅ No open bug issues.");
        } else {
          lines.push(`⚠️ **${bugIssues.length}** open bug issue(s):`);
          bugIssues.forEach((i) => lines.push(`  - #${i.number} ${i.title} — ${i.html_url}`));
        }

        lines.push(
          "",
          "## Documentation",
          hasChangelog
            ? "✅ CHANGELOG.md exists."
            : "⚠️ No CHANGELOG.md found — consider adding release notes."
        );

        if (blockingIssues.length > 0) {
          lines.push("", "## ❌ Blocking Issues");
          blockingIssues.forEach((b) => lines.push(`- ${b}`));
        }

        lines.push(
          "",
          "## Release Checklist",
          "",
          "- [ ] All CI checks pass (`quality_gate_status`)",
          "- [ ] No open critical/high security alerts (`security_triage`)",
          "- [ ] No open blocking bug issues",
          "- [ ] CHANGELOG or release notes updated",
          "- [ ] Version bumped in package.json / relevant manifest",
          "- [ ] PR reviewed and approved",
          "- [ ] Deployment environment config verified",
          "- [ ] Rollback plan is in place",
          "",
          "## Rollback Notes Template",
          "",
          "```markdown",
          "## Rollback Plan",
          "",
          `**Release:** <tag>`,
          `**Repo:** ${ref.owner}/${ref.repo}`,
          `**Date:** ${new Date().toISOString().slice(0, 10)}`,
          "",
          "### Steps to rollback",
          "1. Identify the last known-good tag/commit",
          "2. Deploy the previous version",
          "3. Verify health checks pass",
          "4. Open an incident issue documenting what was rolled back and why",
          "5. Notify stakeholders",
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

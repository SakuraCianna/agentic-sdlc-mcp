/**
 * Tool: release_readiness_check
 *
 * Handler extracted as `handleReleaseReadiness` for testing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import { collectBounded, collectCiEvidence } from "../github/pull-request-evidence.js";
import { config } from "../config.js";
import { safeMarkdownInline } from "../rendering/markdown.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max raw issue-or-PR entries to inspect before failing closed. */
const MAX_BUG_RESULTS = 300;
/** Max bug issues to list in the markdown output before truncating. */
const MAX_BUGS_IN_MARKDOWN = 20;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ReleaseReadinessInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  baseRef: z.string().optional().describe("Deprecated compatibility field; currently ignored."),
  headRef: z.string().optional().describe("Branch, tag, or commit SHA to release. Defaults to default branch."),
  pullNumber: z.number().int().positive().optional()
    .describe("If provided, checks the PR's head commit CI status."),
});

export type ReleaseReadinessInput = z.infer<typeof ReleaseReadinessInputSchema>;

export const ReleaseReadinessOutputSchema = {
  repo: z.string(),
  headRef: z.string(),
  isReady: z.boolean(),
  ciStatus: z.enum(["passing", "failing", "pending", "unknown"]),
  ciSummary: z.string(),
  openBugCount: z.number().int(),
  blockingIssues: z.array(z.string()),
  hasChangelog: z.boolean(),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReleaseReadinessResult {
  repo: string;
  headRef: string;
  isReady: boolean;
  ciStatus: "passing" | "failing" | "pending" | "unknown";
  ciSummary: string;
  openBugCount: number;
  blockingIssues: string[];
  hasChangelog: boolean;
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleReleaseReadiness(
  params: ReleaseReadinessInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: ReleaseReadinessResult }> {
  const { data: repoData } = await octokit.repos.get({
    owner: ref.owner,
    repo: ref.repo,
  });

  const defaultBranch = repoData.default_branch ?? config.defaultBranch;
  const headRef = params.headRef ?? defaultBranch;

  // --- CI status for head ---
  let ciStatus: ReleaseReadinessResult["ciStatus"] = "unknown";
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
      const { data: commit } = await octokit.repos.getCommit({
        owner: ref.owner,
        repo: ref.repo,
        ref: headRef,
      });
      headSha = commit.sha;
    }

    const ci = await collectCiEvidence(ref, headSha, octokit);
    const anySourceUnverified = ci.unverifiedSignals.length > 0;
    const unavailableSources = [
      ci.unverifiedSignals.includes("check_runs") ? "check runs unavailable or incomplete" : null,
      ci.unverifiedSignals.includes("commit_statuses")
        ? "commit statuses unavailable or incomplete"
        : null,
    ].filter((source): source is string => source !== null);
    const notes =
      unavailableSources.length > 0 ? ` Evidence notes: ${unavailableSources.join("; ")}.` : "";

    if (ci.hasFailing) {
      ciStatus = "failing";
      const failingCount = ci.checkRuns.failing.length + ci.commitStatuses.failing.length;
      ciSummary = `[FAIL] ${failingCount} CI signal(s) failing.${notes}`;
    } else if (ci.hasPending) {
      ciStatus = "pending";
      const pendingCount = ci.checkRuns.pending.length + ci.commitStatuses.pending.length;
      ciSummary = `[PENDING] ${pendingCount} CI signal(s) still running.${notes}`;
    } else if (ci.totalSignals === 0 || anySourceUnverified) {
      ciStatus = "unknown";
      ciSummary = `[WARN] CI evidence could not be verified: ${
        ci.totalSignals === 0 ? "no check runs or commit statuses were found" : "one or more CI sources are unverified"
      }.${notes} Ensure your token has the \`repo\` scope (or \`public_repo\` for public-only repos) to read CI evidence.`;
    } else {
      ciStatus = "passing";
      ciSummary = `[PASS] All ${ci.totalSignals} CI signal(s) passing or intentionally skipped.${notes}`;
    }
  } catch {
    ciSummary =
      "[WARN] Could not resolve the release head or collect CI evidence. " +
      "Ensure your token has the `repo` scope (or `public_repo` for public-only repos) " +
      "to read pull requests, refs, check runs, and commit statuses.";
  }

  // --- Open bug issues (the REST endpoint mixes issues and pull requests) ---
  let bugIssues: Array<{ number: number; title: string; html_url: string }> = [];
  let bugEvidenceIncomplete = false;
  try {
    const issueEvidence = await collectBounded(
      (page, perPage) =>
        octokit.issues
          .listForRepo({
            owner: ref.owner,
            repo: ref.repo,
            state: "open",
            labels: "bug",
            per_page: perPage,
            page,
          })
          .then((response) => response.data),
      MAX_BUG_RESULTS
    );
    bugIssues = issueEvidence.items
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ number: issue.number, title: issue.title, html_url: issue.html_url }));
    bugEvidenceIncomplete = issueEvidence.truncated;
  } catch {
    bugEvidenceIncomplete = true;
  }

  // --- CHANGELOG check ---
  let hasChangelog = false;
  try {
    await octokit.repos.getContent({ owner: ref.owner, repo: ref.repo, path: "CHANGELOG.md" });
    hasChangelog = true;
  } catch {
    // not found - leave false
  }

  const blockingIssues: string[] = [];
  if (ciStatus === "failing") blockingIssues.push("CI checks are failing");
  if (ciStatus === "pending") blockingIssues.push("CI checks are still pending");
  if (ciStatus === "unknown") blockingIssues.push("CI status could not be verified");
  if (bugEvidenceIncomplete) blockingIssues.push("Open bug issues could not be fully verified");
  if (bugIssues.length > 0)
    blockingIssues.push(`${bugIssues.length} open bug issue(s) - review before release`);

  const isReady = blockingIssues.length === 0 && ciStatus === "passing";

  const structured: ReleaseReadinessResult = {
    repo: `${ref.owner}/${ref.repo}`,
    headRef,
    isReady,
    ciStatus,
    ciSummary,
    openBugCount: bugIssues.length,
    blockingIssues,
    hasChangelog,
  };

  const renderedRepo = safeMarkdownInline(`${ref.owner}/${ref.repo}`, { maxLength: 200 });
  const renderedHeadRef = safeMarkdownInline(headRef, { maxLength: 200 });

  const lines: string[] = [
    `# Release Readiness Check: ${renderedRepo}`,
    "",
    `**Head ref:** ${renderedHeadRef}`,
    `**Ready to release:** ${isReady ? "[YES]" : "[NO] - see blocking issues below"}`,
    "",
    "## CI Status",
    ciSummary,
    "",
    "## Open Bugs",
  ];

  if (bugEvidenceIncomplete) {
    lines.push("[WARN] Open bug issue evidence is incomplete; release remains blocked.");
  } else if (bugIssues.length === 0) {
    lines.push("[PASS] No open bug issues.");
  } else {
    lines.push(`[WARN] **${bugIssues.length}** open bug issue(s):`);
    bugIssues
      .slice(0, MAX_BUGS_IN_MARKDOWN)
      .forEach((issue) =>
        lines.push(
          `  - #${issue.number} ${safeMarkdownInline(issue.title, { maxLength: 200 })} - ${safeMarkdownInline(issue.html_url, { maxLength: 500 })}`
        )
      );
    if (bugIssues.length > MAX_BUGS_IN_MARKDOWN) {
      lines.push(
        `  - _(showing first ${MAX_BUGS_IN_MARKDOWN} of ${bugIssues.length}; ${
          bugIssues.length - MAX_BUGS_IN_MARKDOWN
        } more not shown)_`
      );
    }
  }

  lines.push(
    "",
    "## Documentation",
    hasChangelog
      ? "[PASS] CHANGELOG.md exists."
      : "[WARN] No CHANGELOG.md found - consider adding release notes."
  );

  if (blockingIssues.length > 0) {
    lines.push("", "## [BLOCKING] Issues");
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
    `**Repo:** ${renderedRepo}`,
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

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReleaseReadinessTool(server: McpServer): void {
  server.registerTool(
    "release_readiness_check",
    {
      title: "Release Readiness Check",
      description: `Pre-release assessment: CI status, open bugs, CHANGELOG, release checklist, rollback template.

Required token scopes:
  - repo, or public_repo for public-only repos (checks, issues, and file contents access)

Args:
  - owner, repo: Repository coordinates.
  - baseRef, headRef (string?): Comparison range (defaults to default branch).
  - pullNumber (number?): Uses the PR head commit for CI status.

Returns: isReady flag, blocking issues, CI status, docs check, release checklist, rollback template.`,
      inputSchema: ReleaseReadinessInputSchema,
      outputSchema: ReleaseReadinessOutputSchema,
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
        const { text, structured } = await handleReleaseReadiness(params, ref, octokit);
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

/**
 * Tool: quality_gate_status
 *
 * Core logic extracted as `categorizeChecks` and `handleQualityGateStatus`
 * for unit testing without MCP machinery.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, paginateAll, handleGitHubError } from "../github/client.js";
import type { CheckStatus, RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const QualityGateInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z
    .number().int().positive().optional()
    .describe("PR number. Takes precedence over ref when provided."),
  ref: z
    .string().optional()
    .describe("Git ref (branch name, commit SHA). Ignored if pullNumber is set."),
});

export type QualityGateInput = z.infer<typeof QualityGateInputSchema>;

const CheckStatusShape = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
});

export const QualityGateOutputSchema = {
  contextLabel: z.string(),
  headSha: z.string(),
  conclusion: z.enum(["passing", "failing", "pending"]),
  categories: z.object({
    failing: z.array(CheckStatusShape),
    pending: z.array(CheckStatusShape),
    passing: z.array(CheckStatusShape),
    skipped: z.array(CheckStatusShape),
  }),
  totalChecks: z.number().int(),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckCategories {
  failing: CheckStatus[];
  pending: CheckStatus[];
  passing: CheckStatus[];
  skipped: CheckStatus[];
}

export interface QualityGateResult {
  contextLabel: string;
  headSha: string;
  conclusion: "passing" | "failing" | "pending";
  categories: CheckCategories;
  totalChecks: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Categorise raw check-run objects into pass/fail/pending/skipped buckets. */
export function categorizeChecks(
  checkRuns: Array<{
    name: string;
    status: string | null;
    conclusion: string | null;
    html_url?: string | null;
  }>
): CheckCategories {
  const toStatus = (run: (typeof checkRuns)[number]): CheckStatus => ({
    name: run.name,
    status: (run.status as CheckStatus["status"]) ?? "unknown",
    conclusion: (run.conclusion as CheckStatus["conclusion"]) ?? null,
    url: run.html_url ?? null,
  });

  return {
    failing: checkRuns
      .filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out")
      .map(toStatus),
    pending: checkRuns
      .filter(
        (c) =>
          c.status === "queued" || c.status === "in_progress" || c.status === "pending"
      )
      .map(toStatus),
    passing: checkRuns.filter((c) => c.conclusion === "success").map(toStatus),
    skipped: checkRuns
      .filter((c) => c.conclusion === "skipped" || c.conclusion === "neutral")
      .map(toStatus),
  };
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleQualityGateStatus(
  params: QualityGateInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: QualityGateResult }> {
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

  // Paginate check runs (repos with many checks can exceed 100)
  const allRuns = await paginateAll(
    (page, perPage) =>
      octokit.checks
        .listForRef({
          owner: ref.owner,
          repo: ref.repo,
          ref: headSha,
          per_page: perPage,
          page,
        })
        .then((r) => r.data.check_runs),
    300
  );

  const cats = categorizeChecks(allRuns);
  const overallConclusion: QualityGateResult["conclusion"] =
    cats.failing.length > 0
      ? "failing"
      : cats.pending.length > 0
      ? "pending"
      : "passing";

  const conclusionLabel =
    overallConclusion === "passing"
      ? "[PASS] All checks passed"
      : overallConclusion === "failing"
      ? "[FAIL] Some checks are failing"
      : "[PENDING] Checks are still running";

  const structured: QualityGateResult = {
    contextLabel,
    headSha,
    conclusion: overallConclusion,
    categories: cats,
    totalChecks: allRuns.length,
  };

  const lines: string[] = [
    `# Quality Gate Status - ${contextLabel}`,
    "",
    `**Commit:** \`${headSha.slice(0, 8)}\``,
    `**Conclusion:** ${conclusionLabel}`,
    "",
    `| | Count |`,
    `|---|---|`,
    `| Passing | ${cats.passing.length} |`,
    `| Failing | ${cats.failing.length} |`,
    `| Pending | ${cats.pending.length} |`,
    `| Skipped | ${cats.skipped.length} |`,
    `| Total   | ${allRuns.length} |`,
  ];

  if (cats.failing.length > 0) {
    lines.push("", "## [FAIL] Failing Checks");
    cats.failing.forEach((c) => {
      const link = c.url ? ` - [view](${c.url})` : "";
      lines.push(`- **${c.name}**: ${c.conclusion}${link}`);
    });
  }

  if (cats.pending.length > 0) {
    lines.push("", "## [PENDING] Pending Checks");
    cats.pending.forEach((c) => lines.push(`- **${c.name}**: ${c.status}`));
  }

  if (cats.passing.length > 0) {
    lines.push("", "## [PASS] Passing Checks");
    cats.passing.forEach((c) => lines.push(`- ${c.name}`));
  }

  lines.push("", "## Next Actions");
  if (cats.failing.length > 0) {
    lines.push(
      "- Fix the failing checks listed above before proceeding.",
      "- Use `review_pr_against_standard` for deeper analysis of PR issues."
    );
  } else if (cats.pending.length > 0) {
    lines.push("- Wait for pending checks to complete, then re-run this tool.");
  } else {
    lines.push(
      "- All checks pass. Safe to request review or merge.",
      "- Run `release_readiness_check` for a full pre-release assessment."
    );
  }

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerQualityGateStatusTool(server: McpServer): void {
  server.registerTool(
    "quality_gate_status",
    {
      title: "Quality Gate Status",
      description: `Read check-run results for a pull request or git ref.

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number?): PR number (preferred).
  - ref (string?): Branch name or commit SHA.

Returns: Summary of all check runs with pass/fail/pending counts and next actions.`,
      inputSchema: QualityGateInputSchema,
      outputSchema: QualityGateOutputSchema,
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
        const { text, structured } = await handleQualityGateStatus(params, ref, octokit);
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

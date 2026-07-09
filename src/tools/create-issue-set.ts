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
        phase: z.string().optional().describe("Optional SDLC phase metadata from plan_from_context."),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe("Optional acceptance criteria metadata from plan_from_context."),
        riskLevel: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe("Optional risk metadata from plan_from_context."),
        goal: z.string().optional().describe("Optional parent goal metadata from plan_from_context."),
      })
    )
    .min(1, "At least one issue is required.")
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
  count: z.number().int().describe("Number of issues previewed or successfully created."),
  targetRepo: z.string().describe("Repository targeted by the preview or live batch."),
  issues: z
    .array(
      z.object({
        number: z.number().int(),
        title: z.string(),
        url: z.string(),
        labels: z.array(z.string()),
      })
    )
    .describe("Created issues (empty in dry run)."),
  failures: z
    .array(
      z.object({
        inputIndex: z.number().int().nonnegative().describe("Zero-based index in the input issues array."),
        title: z.string(),
        reason: z.string(),
      })
    )
    .describe("Issues that could not be created. Empty in dry run and on full success."),
  previewTitles: z.array(z.string()).describe("Final titles (with prefix applied)."),
  preview: z
    .array(
      z.object({
        title: z.string(),
        labels: z.array(z.string()),
        bodySummary: z.string(),
      })
    )
    .describe("Per-issue preview (title, labels, truncated body) -- populated in dry run only."),
  warnings: z
    .array(z.string())
    .describe("Human-review flags, e.g. missing labels, overlong title, missing/short body."),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreatedIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface IssuePreview {
  title: string;
  labels: string[];
  bodySummary: string;
}

export interface IssueCreationFailure {
  /** Zero-based index in the original input array, allowing duplicate titles to be retried safely. */
  inputIndex: number;
  title: string;
  reason: string;
}

export interface CreateIssueSetResult {
  dryRun: boolean;
  count: number;
  targetRepo: string;
  issues: CreatedIssue[];
  failures: IssueCreationFailure[];
  previewTitles: string[];
  preview: IssuePreview[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** GitHub's actual hard limit on issue title length -- exceeding this makes the create call fail outright, not just look untidy. */
const GITHUB_TITLE_MAX_LENGTH = 256;
/** Matches the "meaningful description" bar used elsewhere in this project (see review-pr.ts's PR-body check) -- short enough to be a placeholder, not a real body. */
const MIN_MEANINGFUL_BODY_LENGTH = 20;
/** Chars kept in a dry-run body preview before truncating -- long enough to judge intent, short enough not to blow up a 50-issue preview response. */
const BODY_SUMMARY_MAX_CHARS = 200;

/** Truncate a body for the dry-run preview list. Pure -- no I/O. */
export function summarizeBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return "(empty)";
  return trimmed.length > BODY_SUMMARY_MAX_CHARS
    ? trimmed.slice(0, BODY_SUMMARY_MAX_CHARS) + "..."
    : trimmed;
}

/**
 * Flag issues worth a human's attention before a live (dryRun: false) write:
 * no labels, a title GitHub will reject outright, or a body too short to be
 * a real description. Pure -- no I/O. One warning line per (issue, problem)
 * pair, 1-indexed to match the preview's numbered list.
 */
export function generateIssueWarnings(
  issues: CreateIssueSetInput["issues"],
  prefix: string
): string[] {
  const warnings: string[] = [];
  issues.forEach((issue, i) => {
    const n = i + 1;
    const finalTitle = `${prefix}${issue.title}`;
    if (!issue.labels || issue.labels.length === 0) {
      warnings.push(`Issue ${n} ("${issue.title}") has no labels.`);
    }
    if (finalTitle.length > GITHUB_TITLE_MAX_LENGTH) {
      warnings.push(
        `Issue ${n} ("${issue.title}") title is ${finalTitle.length} characters, exceeding GitHub's ${GITHUB_TITLE_MAX_LENGTH}-character limit -- issue creation will fail as-is.`
      );
    }
    if (issue.body.trim().length < MIN_MEANINGFUL_BODY_LENGTH) {
      warnings.push(`Issue ${n} ("${issue.title}") has a missing or very short body (under ${MIN_MEANINGFUL_BODY_LENGTH} characters).`);
    }
  });
  return warnings;
}

/**
 * Convert a per-issue failure into an actionable, response-safe reason.
 * GitHub response bodies and arbitrary exception messages are deliberately
 * excluded because they can contain private repository data or credentials.
 */
function describeIssueCreationFailure(error: unknown): string {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;

  switch (status) {
    case 401:
      return "GitHub authentication failed (401); check that GITHUB_TOKEN is valid.";
    case 403:
      return "GitHub permission denied (403); check token and repository issue permissions.";
    case 404:
      return "GitHub repository or issue endpoint was not found (404); verify the target repository.";
    case 422:
      return "GitHub validation failed (422); check the title, body, labels, and assignees.";
    case 429:
      return "GitHub rate limit exceeded (429); retry after the limit resets.";
    default:
      return status
        ? `GitHub API error (${status}) while creating this issue.`
        : "Unexpected error while creating this issue; retry or inspect the server logs.";
  }
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
  const targetRepo = `${ref.owner}/${ref.repo}`;

  if (params.dryRun) {
    const previewTitles = params.issues.map((i) => `${prefix}${i.title}`);
    const preview: IssuePreview[] = params.issues.map((issue) => ({
      title: `${prefix}${issue.title}`,
      labels: issue.labels ?? [],
      bodySummary: summarizeBody(issue.body),
    }));
    const warnings = generateIssueWarnings(params.issues, prefix);

    const structured: CreateIssueSetResult = {
      dryRun: true,
      count: params.issues.length,
      targetRepo,
      issues: [],
      failures: [],
      previewTitles,
      preview,
      warnings,
    };

    const lines = [
      `# [PREVIEW ONLY] Issue Set Preview (dry run) - ${params.issues.length} issue(s)`,
      "",
      `> **Preview only -- no GitHub issues were created.** No write call was made to the GitHub API. Set \`dryRun: false\` to create them for real.`,
      "",
      `**Target repo (confirm before a live write):** \`${targetRepo}\``,
      "",
    ];

    if (warnings.length > 0) {
      lines.push("## Warnings", "");
      warnings.forEach((w) => lines.push(`- [WARN] ${w}`));
      lines.push("");
    }

    params.issues.forEach((issue, i) => {
      lines.push(
        `## ${i + 1}. ${prefix}${issue.title}`,
        "",
        preview[i]?.bodySummary ?? "(empty)",
        "",
        issue.labels && issue.labels.length > 0 ? `**Labels:** ${issue.labels.join(", ")}` : "**Labels:** (none)",
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
  const failures: IssueCreationFailure[] = [];
  for (const [inputIndex, issue] of params.issues.entries()) {
    const finalTitle = `${prefix}${issue.title}`;
    try {
      const { data } = await octokit.issues.create({
        owner: ref.owner,
        repo: ref.repo,
        title: finalTitle,
        body: issue.body,
        labels: issue.labels,
        assignees: issue.assignees,
      });
      created.push({
        number: data.number,
        title: data.title,
        url: data.html_url,
        labels: (data.labels ?? [])
          .map((label) => (typeof label === "string" ? label : label.name ?? ""))
          .filter((label) => label.length > 0),
      });
    } catch (error) {
      failures.push({
        inputIndex,
        title: finalTitle,
        reason: describeIssueCreationFailure(error),
      });
    }
  }

  const structured: CreateIssueSetResult = {
    dryRun: false,
    count: created.length,
    targetRepo,
    issues: created,
    failures,
    previewTitles: params.issues.map((issue) => `${prefix}${issue.title}`),
    preview: [],
    warnings: [],
  };
  const lines = [
    `# Issue Set Creation Result - ${created.length} created, ${failures.length} failed`,
    "",
    `Repo: ${targetRepo}`,
    "",
    "## Created",
    created.length > 0
      ? created
          .map(
            (issue) =>
              `- #${issue.number} ${issue.title} - ${issue.url}${issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""}`
          )
          .join("\n")
      : "(none)",
    "",
    "## Failed",
    failures.length > 0
      ? failures
          .map(
            (failure) =>
              `- Issue ${failure.inputIndex + 1} (${failure.title}): ${failure.reason}`
          )
          .join("\n")
      : "(none)",
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

Dry-run output is designed to work as a human pre-write confirmation page: it includes a per-issue
preview (title/labels/truncated body), warnings for issues missing labels, missing/short bodies, or
titles exceeding GitHub's 256-character limit, and the exact repo coordinates that would be written to.

Args:
  - owner, repo: Repository coordinates.
  - titlePrefix (string?): Prefix for every issue title.
  - issues (array): 1-50 issues, each with title, body, labels?, assignees?. Accepts plan_from_context's issueDrafts directly.
  - dryRun (boolean): Default true - preview mode only.

Returns: Created issue numbers + URLs + labels (live) or a preview + warnings (dry run).`,
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

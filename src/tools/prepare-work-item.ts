/**
 * Tool: prepare_work_item
 *
 * Handler extracted as `handlePrepareWorkItem` for testing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PrepareWorkItemInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  issueNumber: z.number().int().positive().describe("The GitHub issue number."),
  includeRelatedFiles: z
    .boolean()
    .default(false)
    .describe("Attempt to identify related files from issue body keywords."),
  includeRecentPRs: z
    .boolean()
    .default(false)
    .describe("Include recent merged PRs touching related files."),
});

export type PrepareWorkItemInput = z.infer<typeof PrepareWorkItemInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

const RecentPrMatchShape = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  mergedAt: z.string().nullable(),
  matchedFiles: z.array(z.string()),
});

export const PrepareWorkItemOutputSchema = {
  issueNumber: z.number().int(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  relatedFileHints: z.array(z.string()),
  recentPRs: z.array(RecentPrMatchShape),
  handoffPrompt: z.string(),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecentPrMatch {
  number: number;
  title: string;
  url: string;
  mergedAt: string | null;
  matchedFiles: string[];
}

export interface WorkItemResult {
  issueNumber: number;
  title: string;
  state: string;
  url: string;
  labels: string[];
  assignees: string[];
  relatedFileHints: string[];
  recentPRs: RecentPrMatch[];
  handoffPrompt: string;
}

/** Bounds for the includeRecentPRs heuristic — keeps API calls and token usage predictable. */
const RECENT_PRS_TO_SCAN = 20;
const MAX_RECENT_PR_MATCHES = 5;

/** True if a changed-file path and a heuristic file hint plausibly refer to the same file. */
export function fileMatchesHint(filename: string, hint: string): boolean {
  return (
    filename === hint ||
    filename.endsWith("/" + hint) ||
    hint.endsWith("/" + filename) ||
    filename.endsWith(hint) ||
    hint.endsWith(filename)
  );
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Heuristically find recent merged PRs that touched any of `fileHints`.
 * Scans at most RECENT_PRS_TO_SCAN recently-updated closed PRs and stops
 * early once MAX_RECENT_PR_MATCHES matches are found, to bound API calls.
 */
export async function findRecentPRsForFileHints(
  octokit: Octokit,
  ref: RepoRef,
  fileHints: string[]
): Promise<RecentPrMatch[]> {
  if (fileHints.length === 0) return [];

  const { data: candidates } = await octokit.pulls.list({
    owner: ref.owner,
    repo: ref.repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: RECENT_PRS_TO_SCAN,
  });

  const matches: RecentPrMatch[] = [];
  for (const pr of candidates) {
    if (!pr.merged_at) continue; // skip closed-without-merge PRs
    if (matches.length >= MAX_RECENT_PR_MATCHES) break;

    const { data: files } = await octokit.pulls.listFiles({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: pr.number,
      per_page: 100,
    });

    const matchedFiles = files
      .filter((f) => fileHints.some((hint) => fileMatchesHint(f.filename, hint)))
      .map((f) => f.filename);

    if (matchedFiles.length > 0) {
      matches.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        mergedAt: pr.merged_at,
        matchedFiles,
      });
    }
  }

  return matches;
}

export async function handlePrepareWorkItem(
  params: PrepareWorkItemInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: WorkItemResult }> {
  const { data: issue } = await octokit.issues.get({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: params.issueNumber,
  });

  const { data: comments } = await octokit.issues.listComments({
    owner: ref.owner,
    repo: ref.repo,
    issue_number: params.issueNumber,
    per_page: 5,
  });

  const labels = issue.labels.map((l) =>
    typeof l === "string" ? l : (l.name ?? "")
  );
  const assignees = issue.assignees?.map((a) => "@" + a.login) ?? [];

  // Heuristic: extract file paths from body
  const fileHints: string[] = [];
  if (params.includeRelatedFiles && issue.body) {
    const matches = issue.body.match(/[a-zA-Z0-9_/.-]+\.[a-zA-Z]{2,5}/g) ?? [];
    const filtered = matches
      .filter(
        (m) =>
          m.includes("/") ||
          m.endsWith(".ts") ||
          m.endsWith(".js") ||
          m.endsWith(".py")
      )
      .slice(0, 10);
    fileHints.push(...filtered);
  }

  const recentPRs: RecentPrMatch[] = params.includeRecentPRs
    ? await findRecentPRsForFileHints(octokit, ref, fileHints)
    : [];

  const handoffPrompt = [
    `You are working on issue #${issue.number}: "${issue.title}" in ${ref.owner}/${ref.repo}.`,
    `The full issue description is provided below. Your task is to implement the required changes,`,
    `add tests, and open a pull request. Follow the non-goals and acceptance criteria strictly.`,
    `Use the quality_gate_status tool to verify CI before marking work complete.`,
  ].join(" ");

  const structured: WorkItemResult = {
    issueNumber: issue.number,
    title: issue.title,
    state: issue.state,
    url: issue.html_url,
    labels,
    assignees,
    relatedFileHints: fileHints,
    recentPRs,
    handoffPrompt,
  };

  const lines: string[] = [
    `# Work Item Brief: #${issue.number} — ${issue.title}`,
    "",
    `**URL:** ${issue.html_url}`,
    `**State:** ${issue.state}`,
    `**Labels:** ${labels.length > 0 ? labels.join(", ") : "(none)"}`,
    `**Assignees:** ${assignees.length > 0 ? assignees.join(", ") : "(none)"}`,
    `**Created:** ${issue.created_at}`,
    "",
    "## Issue Summary",
    "",
    issue.body ?? "(no description)",
    "",
    "## Goals",
    "- Implement the changes described in the issue above",
    "- Ensure all acceptance criteria are met",
    "- Maintain or improve test coverage",
    "",
    "## Non-Goals",
    "- Do not refactor unrelated code",
    "- Do not change public API contracts unless explicitly stated in the issue",
    "",
    "## Acceptance Criteria",
    "_(Derived from issue body — verify with the issue author)_",
    "- [ ] All described behaviour is implemented and tested",
    "- [ ] No regressions in existing tests",
    "- [ ] PR passes all CI checks",
    "",
    "## Risks",
    "- Scope may be broader than the issue description suggests",
    "- Related tests may need updating",
    "- Linked issues (if any) may introduce dependencies",
  ];

  if (comments.length > 0) {
    lines.push("", "## Recent Comments");
    for (const c of comments.slice(0, 3)) {
      const preview = (c.body ?? "").slice(0, 300);
      const ellipsis = (c.body ?? "").length > 300 ? "..." : "";
      lines.push(
        `\n**@${c.user?.login ?? "unknown"}** (${c.created_at}):\n${preview}${ellipsis}`
      );
    }
  }

  if (fileHints.length > 0) {
    lines.push("", "## Potentially Related Files (heuristic)");
    fileHints.forEach((f) => lines.push(`- \`${f}\``));
  }

  if (params.includeRecentPRs) {
    lines.push("", "## Recent Related PRs (heuristic)");
    if (recentPRs.length > 0) {
      recentPRs.forEach((pr) =>
        lines.push(
          `- #${pr.number} ${pr.title} -> ${pr.url} (merged ${pr.mergedAt ?? "unknown"}; touched ${pr.matchedFiles.join(", ")})`
        )
      );
    } else {
      lines.push(
        fileHints.length === 0
          ? "(no related file hints available — enable includeRelatedFiles to find matching PRs)"
          : "(no recent merged PRs found touching the related files)"
      );
    }
  }

  lines.push(
    "",
    "## Recommended Verification Commands",
    "```powershell",
    "# Run tests",
    "npm test",
    "",
    "# Type check",
    "npm run typecheck",
    "",
    "# Build",
    "npm run build",
    "```",
    "",
    "## Agent Handoff Prompt",
    "",
    "```",
    handoffPrompt,
    "```"
  );

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPrepareWorkItemTool(server: McpServer): void {
  server.registerTool(
    "prepare_work_item",
    {
      title: "Prepare Work Item Brief",
      description: `Generate an agent-ready brief for a GitHub issue, including summary, goals, non-goals, acceptance criteria, risks, and a handoff prompt.

Args:
  - owner, repo: Repository coordinates.
  - issueNumber (number): The issue to prepare.
  - includeRelatedFiles (boolean): Heuristically list related file paths. Default: false.
  - includeRecentPRs (boolean): Scan recent merged PRs (up to 20) for ones that touched the
    related file hints and return up to 5 matches. Requires includeRelatedFiles to find hints
    to match against — if no hints exist, returns an empty list. Default: false.

Returns: Structured markdown brief ready to paste into an agent prompt.`,
      inputSchema: PrepareWorkItemInputSchema,
      outputSchema: PrepareWorkItemOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PrepareWorkItemInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handlePrepareWorkItem(params, ref, octokit);
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

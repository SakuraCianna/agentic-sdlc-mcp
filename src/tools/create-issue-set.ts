/**
 * Tool: create_issue_set
 *
 * Handler extracted as `handleCreateIssueSet` for testability.
 * Splits an SDLC plan into GitHub issues. dryRun defaults to TRUE.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  STRUCTURED_CONTENT_TRUST_META,
  StructuredContentTrustBoundarySchema,
  withStructuredContentTrustBoundary,
} from "../security/trust-boundary.js";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import { safeMarkdownInline } from "../rendering/markdown.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";
import {
  createIssuesRecoverably,
  issueSetPreviewDigest,
  type IssueWriteItem,
  type IssueWriteOptions,
  type IssueWriteRecovery,
} from "../operations/issue-creation.js";

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

export const ISSUE_RECOVERY_META_KEY = "io.github.SakuraCianna/agentic-sdlc-mcp/issue-recovery";

export const IssueRecoveryMetadataSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional()
    .describe("Optional operation key for bounded recovery of the same complete batch. Reuse the exact payload and key when resuming; this is not a cross-process exactly-once guarantee."),
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional()
    .describe("Digest returned by a reviewed preview. A live call with a different repository or complete payload is rejected before writing."),
});

/** Internal operation input; recovery fields arrive through MCP request metadata. */
export const CreateIssueSetOperationInputSchema = CreateIssueSetInputSchema.extend(IssueRecoveryMetadataSchema.shape);
export type CreateIssueSetInput = z.infer<typeof CreateIssueSetOperationInputSchema>;
type CreateIssueSetArguments = z.infer<typeof CreateIssueSetInputSchema>;

export const CreateIssueSetOutputSchema = {
  trustBoundary: StructuredContentTrustBoundarySchema.optional(),
  dryRun: z.boolean().describe("Whether this was a preview-only run."),
  count: z.number().int().describe("Number of issues previewed or known successful issue references, including previously confirmed issues during recovery."),
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
    .describe("Known successful issue references (empty in dry run). Inspect items for newly created, reused, or no longer verified references."),
  failures: z
    .array(
      z.object({
        inputIndex: z.number().int().nonnegative().describe("Zero-based index in the input issues array."),
        title: z.string(),
        reason: z.string(),
      })
    )
    .describe("Rejected or unconfirmed writes. Inspect items to distinguish failed from unknown commit status. Empty in dry run and on full success."),
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
  previewDigest: z.string().optional().describe("Digest binding the complete ordered issue payload, target repository and optional request-metadata idempotencyKey. Return it as previewDigest inside request params._meta['io.github.SakuraCianna/agentic-sdlc-mcp/issue-recovery'], never tool arguments."),
  items: z.array(z.object({
    inputIndex: z.number().int().nonnegative(),
    title: z.string(),
    status: z.enum(["created", "reused", "failed", "unknown", "pending"]),
    issue: z.object({ number: z.number().int(), title: z.string(), url: z.string(), labels: z.array(z.string()) }).optional(),
    reason: z.string().optional(),
  })).optional().describe("Per-input live results. Unknown means the write may have committed; pending means no request started."),
  recovery: z.object({
    status: z.enum(["completed", "partial", "cancelled", "timed_out", "unknown", "blocked"]),
    retrySafe: z.boolean(),
    message: z.string(),
  }).optional().describe("Recovery guidance. Even with a key, cross-process races and server restarts cannot guarantee exactly-once creation."),
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
  previewDigest?: string;
  items?: IssueWriteItem[];
  recovery?: IssueWriteRecovery;
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

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateIssueSet(
  params: CreateIssueSetInput,
  ref: RepoRef,
  octokit: Octokit,
  options: IssueWriteOptions = {}
): Promise<{ text: string; structured: CreateIssueSetResult }> {
  // Snapshot caller-owned arrays before asynchronous reads or writes.
  params = CreateIssueSetOperationInputSchema.parse(params);
  const prefix = params.titlePrefix ? `${params.titlePrefix} ` : "";
  const payload = params.issues.map((issue) => ({ ...issue, title: `${prefix}${issue.title}` }));
  const previewDigest = issueSetPreviewDigest(ref, payload, params.idempotencyKey);
  const targetRepo = `${ref.owner}/${ref.repo}`;
  const inline = (value: string, maxLength = 500): string =>
    safeMarkdownInline(value, { maxLength });

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
      previewDigest,
    };

    const lines = [
      `# [PREVIEW ONLY] Issue Set Preview (dry run) - ${params.issues.length} issue(s)`,
      "",
      `> **Preview only -- no GitHub issues were created.** No write call was made to the GitHub API. Set \`dryRun: false\` to create them for real.`,
      "",
      `**Target repo (confirm before a live write):** \`${inline(targetRepo, 200)}\``,
      `**Preview digest:** \`${previewDigest}\` (send as \`previewDigest\` in request \`params._meta["${ISSUE_RECOVERY_META_KEY}"]\`; use the same metadata key and complete payload for preview and live calls).`,
      "",
    ];

    if (warnings.length > 0) {
      lines.push("## Warnings", "");
      warnings.forEach((warning) => lines.push(`- [WARN] ${inline(warning, 500)}`));
      lines.push("");
    }

    params.issues.forEach((issue, i) => {
      lines.push(
        `## ${i + 1}. ${inline(`${prefix}${issue.title}`, 300)}`,
        "",
        inline(preview[i]?.bodySummary ?? "(empty)", BODY_SUMMARY_MAX_CHARS + 20),
        "",
        issue.labels && issue.labels.length > 0
          ? `**Labels:** ${issue.labels.map((label) => inline(label, 100)).join(", ")}`
          : "**Labels:** (none)",
        issue.assignees && issue.assignees.length > 0
          ? `**Assignees:** ${issue.assignees.map((assignee) => inline(assignee, 100)).join(", ")}`
          : "",
        ""
      );
    });
    return { text: lines.filter((l) => l !== "").join("\n"), structured };
  }

  const { items, recovery } = await createIssuesRecoverably(
    payload, ref, octokit, previewDigest, params.idempotencyKey, params.previewDigest, options
  );
  const created: CreatedIssue[] = items.flatMap((item) => item.issue ? [item.issue] : []);
  const failures: IssueCreationFailure[] = items
    .filter((item) => item.status === "failed" || item.status === "unknown")
    .map((item) => ({ inputIndex: item.inputIndex, title: item.title, reason: item.reason! }));

  const structured: CreateIssueSetResult = {
    dryRun: false,
    count: created.length,
    targetRepo,
    issues: created,
    failures,
    previewTitles: params.issues.map((issue) => `${prefix}${issue.title}`),
    preview: [],
    warnings: [],
    previewDigest,
    items,
    recovery,
  };
  const lines = [
    `# Issue Set Creation Result - ${items.filter((item) => item.status === "created").length} created, ${items.filter((item) => item.status === "reused").length} reused, ${items.filter((item) => item.status === "failed").length} failed, ${items.filter((item) => item.status === "unknown").length} unknown`,
    "",
    `Repo: ${inline(targetRepo, 200)}`,
    `Recovery status: ${recovery.status}. ${recovery.message}`,
    "",
    "## Known issue references",
    created.length > 0
      ? created
          .map(
            (issue) =>
              `- #${issue.number} ${inline(issue.title, 300)} - ${inline(issue.url, 500)}${issue.labels.length > 0 ? ` [${issue.labels.map((label) => inline(label, 100)).join(", ")}]` : ""}`
          )
          .join("\n")
      : "(none)",
    "",
    "## Failed or unknown writes",
    failures.length > 0
      ? failures
          .map(
            (failure) =>
              `- Issue ${failure.inputIndex + 1} (${inline(failure.title, 300)}): ${inline(failure.reason, 500)}`
          )
          .join("\n")
      : "(none)",
    "",
    "## Pending (no write started)",
    items.filter((item) => item.status === "pending")
      .map((item) => `- Issue ${item.inputIndex + 1}: ${inline(item.title, 300)}`).join("\n") || "(none)",
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

Optional recovery controls belong in request params._meta["${ISSUE_RECOVERY_META_KEY}"], never tool arguments:
  - idempotencyKey: 1-128 ASCII characters matching [A-Za-z0-9._:-]+. Use the same key in preview and live metadata and reuse the complete payload when resuming.
  - previewDigest: The 64-character lowercase hex digest from the reviewed preview. Mismatches cause zero writes.
The metadata value is a strict object with only those optional fields. Invalid recovery metadata is rejected before GitHub access. Other tool arguments retain their legacy ignored-extra-field behavior.

Returns: Confirmed created/reused issue numbers, per-input created/reused/failed/unknown/pending status and recovery guidance, or a preview + digest. Cancellation stops new writes but cannot establish whether an in-flight write committed. Idempotency recovery checks at most 300 issues including closed ones and fails closed for missing inputs when evidence is incomplete. Markers are correlation data, not authorization; concurrent processes and restarts cannot guarantee exactly-once writes. SDLC_READ_ONLY=true rejects live writes.`,
      inputSchema: CreateIssueSetInputSchema,
      outputSchema: z.object(CreateIssueSetOutputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params: CreateIssueSetArguments, context) => {
      try {
        if (!params.dryRun && process.env.SDLC_READ_ONLY === "true") {
          return {
            isError: true,
            content: [{ type: "text", text: "Live issue creation is disabled by SDLC_READ_ONLY=true; preview remains available." }],
          };
        }
        const metadataValue = context.mcpReq._meta?.[ISSUE_RECOVERY_META_KEY];
        const metadata = IssueRecoveryMetadataSchema.safeParse(metadataValue === undefined ? {} : metadataValue);
        if (!metadata.success) {
          return {
            isError: true,
            content: [{ type: "text", text: "Invalid issue recovery metadata. Provide only a valid idempotencyKey and/or previewDigest in the documented request metadata namespace." }],
          };
        }
        const operation = { ...CreateIssueSetInputSchema.parse(params), ...metadata.data };
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleCreateIssueSet(operation, ref, octokit, {
          signal: context.mcpReq.signal,
        });
        return {
          content: [{ type: "text", text }],
          structuredContent: withStructuredContentTrustBoundary(structured),
          _meta: STRUCTURED_CONTENT_TRUST_META,
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

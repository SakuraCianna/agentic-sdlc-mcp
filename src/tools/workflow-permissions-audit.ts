/**
 * Tool: workflow_permissions_audit
 *
 * Scans `.github/workflows/*.yml` (and `.yaml`) in a repo for `permissions`
 * declarations -- top-level and per-job -- and flags least-privilege gaps:
 * missing declarations, `write-all`, and write scopes combined with the
 * `pull_request_target` trigger (a known injection/exfiltration risk pattern
 * since that trigger runs with the base repo's token against untrusted PR
 * content).
 *
 * Uses the `yaml` package for parsing rather than a hand-rolled parser --
 * GitHub Actions workflow YAML is real-world YAML (flow/block mixed styles,
 * quoting, etc.), and a hand-rolled subset parser is the kind of thing that
 * produces subtle correctness bugs invisible until adversarial input is
 * actually tried against it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { Finding, RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const WorkflowPermissionsAuditInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  ref: z
    .string()
    .optional()
    .describe("Branch, tag, or SHA to read workflow files from. Falls back to the repository's default branch."),
});

export type WorkflowPermissionsAuditInput = z.infer<typeof WorkflowPermissionsAuditInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const WorkflowPermissionsAuditOutputSchema = {
  repo: z.string(),
  ref: z.string(),
  workflowsScanned: z.array(z.string()),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      category: z.string(),
      description: z.string(),
      suggestion: z.string().optional(),
    })
  ),
  errors: z.array(z.string()),
  conclusion: z.enum(["least_privilege", "needs_review", "over_permissioned"]),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowPermissionsAuditResult {
  repo: string;
  ref: string;
  workflowsScanned: string[];
  findings: Finding[];
  errors: string[];
  conclusion: "least_privilege" | "needs_review" | "over_permissioned";
}

interface ParsedWorkflow {
  permissions: unknown;
  jobs: Record<string, { permissions?: unknown }>;
  triggers: string[];
}

interface NormalizedPermissions {
  writeAll: boolean;
  scopes: Record<string, "read" | "write" | "none">;
}

/** Cap on how many workflow files a single audit will fetch and parse, to bound API calls on large repos. */
const MAX_WORKFLOW_FILES = 50;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Parse a workflow file's YAML text into the shape this audit cares about. Returns null on any parse failure. */
export function parseWorkflowYaml(content: string): ParsedWorkflow | null {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;

  const obj = doc as Record<string, unknown>;
  const jobsRaw = obj["jobs"];
  const jobs: Record<string, { permissions?: unknown }> = {};
  if (jobsRaw && typeof jobsRaw === "object" && !Array.isArray(jobsRaw)) {
    for (const [jobId, jobVal] of Object.entries(jobsRaw as Record<string, unknown>)) {
      if (jobVal && typeof jobVal === "object" && !Array.isArray(jobVal)) {
        jobs[jobId] = { permissions: (jobVal as Record<string, unknown>)["permissions"] };
      }
    }
  }

  return {
    permissions: obj["permissions"],
    jobs,
    triggers: extractTriggers(obj["on"]),
  };
}

/** `on:` can be a scalar event name, a flow/block sequence of names, or a mapping keyed by event name. */
function extractTriggers(onRaw: unknown): string[] {
  if (typeof onRaw === "string") return [onRaw];
  if (Array.isArray(onRaw)) return onRaw.filter((x): x is string => typeof x === "string");
  if (onRaw && typeof onRaw === "object") return Object.keys(onRaw as Record<string, unknown>);
  return [];
}

/**
 * Normalize a raw `permissions` value into scopes + a `write-all` flag.
 * Returns null when `permissions` was not declared at all (distinct from an
 * explicit empty mapping `{}`, which means "no permissions" and IS a declaration).
 */
export function normalizePermissions(value: unknown): NormalizedPermissions | null {
  if (value === undefined) return null;
  if (typeof value === "string") {
    return { writeAll: value === "write-all", scopes: {} };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const scopes: NormalizedPermissions["scopes"] = {};
    for (const [scope, level] of Object.entries(value as Record<string, unknown>)) {
      if (level === "write" || level === "read" || level === "none") {
        scopes[scope] = level;
      }
    }
    return { writeAll: false, scopes };
  }
  return { writeAll: false, scopes: {} };
}

/** Generate least-privilege findings for a single parsed workflow file. */
export function generatePermissionsFindings(fileName: string, parsed: ParsedWorkflow): Finding[] {
  const findings: Finding[] = [];
  const isPullRequestTarget = parsed.triggers.includes("pull_request_target");

  const entries: Array<{ label: string; normalized: NormalizedPermissions | null }> = [
    { label: "top-level `permissions`", normalized: normalizePermissions(parsed.permissions) },
    ...Object.entries(parsed.jobs).map(([jobId, job]) => ({
      label: `job \`${jobId}\`'s \`permissions\``,
      normalized: normalizePermissions(job.permissions),
    })),
  ];

  if (entries.every((e) => e.normalized === null)) {
    findings.push({
      severity: "medium",
      category: "Workflow Permissions",
      description: `${fileName}: no \`permissions\` block is declared at the workflow or job level. The GITHUB_TOKEN's scopes depend on the repository/organization default setting rather than an explicit least-privilege declaration.`,
      suggestion:
        "Add a top-level `permissions:` block (e.g. `permissions:\n  contents: read`) and grant additional scopes only on the specific jobs that need them.",
    });
  }

  for (const { label, normalized } of entries) {
    if (!normalized) continue;
    const writeScopes = Object.entries(normalized.scopes)
      .filter(([, level]) => level === "write")
      .map(([scope]) => scope);
    const hasWriteAccess = normalized.writeAll || writeScopes.length > 0;

    if (isPullRequestTarget && hasWriteAccess) {
      findings.push({
        severity: "critical",
        category: "Workflow Permissions",
        description: `${fileName}: triggered by \`pull_request_target\` while ${label} grants ${
          normalized.writeAll ? "`write-all`" : `write access (${writeScopes.join(", ")})`
        }. \`pull_request_target\` runs with the base repo's token against untrusted PR content, so write scopes here are a known injection/exfiltration risk.`,
        suggestion:
          "Avoid combining `pull_request_target` with write permissions -- use `pull_request` instead, or keep this trigger read-only and perform any write action from a separate, tightly-scoped workflow.",
      });
    } else if (normalized.writeAll) {
      findings.push({
        severity: "critical",
        category: "Workflow Permissions",
        description: `${fileName}: ${label} grants \`write-all\`, giving the GITHUB_TOKEN write access to every scope.`,
        suggestion:
          "Replace `write-all` with an explicit mapping listing only the scopes actually required, set to `write`; leave the rest unlisted or `read`/`none`.",
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleWorkflowPermissionsAudit(
  params: WorkflowPermissionsAuditInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: WorkflowPermissionsAuditResult }> {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const workflowsScanned: string[] = [];

  let gitRef = params.ref;
  if (!gitRef) {
    const { data: repoData } = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    gitRef = repoData.default_branch;
  }

  let candidateFiles: Array<{ name: string; path: string }> = [];
  try {
    const { data } = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: ".github/workflows",
      ref: gitRef,
    });
    if (Array.isArray(data)) {
      candidateFiles = data.filter((entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name));
    }
  } catch (err) {
    const message = handleGitHubError(err);
    if (!message.toLowerCase().includes("not found")) {
      errors.push(`Workflow directory listing: ${message}`);
    }
  }

  const truncated = candidateFiles.length > MAX_WORKFLOW_FILES;
  const filesToScan = candidateFiles.slice(0, MAX_WORKFLOW_FILES);
  if (truncated) {
    errors.push(
      `Only the first ${MAX_WORKFLOW_FILES} of ${candidateFiles.length} workflow files were scanned.`
    );
  }

  for (const file of filesToScan) {
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: file.path,
        ref: gitRef,
      });
      if (Array.isArray(data) || data.type !== "file" || !data.content) {
        errors.push(`${file.path}: unexpected content response (not a single file).`);
        continue;
      }
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      const parsed = parseWorkflowYaml(content);
      if (!parsed) {
        errors.push(`${file.path}: unable to parse as a GitHub Actions workflow (expected a YAML mapping at the document root).`);
        continue;
      }
      workflowsScanned.push(file.path);
      findings.push(...generatePermissionsFindings(file.path, parsed));
    } catch (err) {
      errors.push(`${file.path}: ${handleGitHubError(err)}`);
    }
  }

  const hasCriticalOrHigh = findings.some((f) => f.severity === "critical" || f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");
  const conclusion: WorkflowPermissionsAuditResult["conclusion"] = hasCriticalOrHigh
    ? "over_permissioned"
    : hasMedium
    ? "needs_review"
    : "least_privilege";

  const structured: WorkflowPermissionsAuditResult = {
    repo: `${ref.owner}/${ref.repo}`,
    ref: gitRef,
    workflowsScanned,
    findings,
    errors,
    conclusion,
  };

  const conclusionLabel =
    conclusion === "least_privilege"
      ? "LEAST PRIVILEGE"
      : conclusion === "needs_review"
      ? "NEEDS REVIEW"
      : "OVER-PERMISSIONED";

  const lines: string[] = [
    `# Workflow Permissions Audit: ${ref.owner}/${ref.repo}@${gitRef}`,
    "",
    `**Conclusion:** ${conclusionLabel}`,
    `**Workflows scanned:** ${workflowsScanned.length > 0 ? workflowsScanned.join(", ") : "none"}`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("## Notes", "");
    errors.forEach((e) => lines.push(`- ${e}`));
    lines.push("");
  }

  lines.push("## Findings", "");
  if (findings.length === 0) {
    lines.push("No findings -- scanned workflows declare explicit, least-privilege permissions.");
  } else {
    for (const f of findings) {
      lines.push(
        `- **[${f.severity.toUpperCase()}]** ${f.category}: ${f.description}` +
          (f.suggestion ? `\n  > Suggestion: ${f.suggestion}` : "")
      );
    }
  }

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWorkflowPermissionsAuditTool(server: McpServer): void {
  server.registerTool(
    "workflow_permissions_audit",
    {
      title: "Workflow Permissions Audit",
      description: `Scan \`.github/workflows/*.yml\` for \`permissions\` declarations (top-level and per-job) and flag least-privilege gaps.

Required token scope: \`repo\` (or \`public_repo\` for public-only repos) with read access to repository contents.

Args:
  - owner, repo: Repository coordinates.
  - ref: Optional. Branch, tag, or SHA to read workflow files from. Falls back to the repository's default branch.

Flags:
  - No \`permissions\` declared anywhere in the file (workflow or job level) -- relies on the repo/org default token scope instead of an explicit declaration.
  - \`permissions: write-all\` (top-level or per-job) -- grants write access to every scope.
  - Any scope granted \`write\` on a workflow triggered by \`pull_request_target\` -- a known injection/exfiltration risk since that trigger runs with the base repo's token against untrusted PR content.

Returns: per-file findings by severity and a least_privilege/needs_review/over_permissioned conclusion.`,
      inputSchema: WorkflowPermissionsAuditInputSchema,
      outputSchema: WorkflowPermissionsAuditOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: WorkflowPermissionsAuditInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleWorkflowPermissionsAudit(params, ref, octokit);
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

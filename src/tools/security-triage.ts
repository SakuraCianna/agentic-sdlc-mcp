/**
 * Tool: security_triage
 *
 * Handler extracted as `handleSecurityTriage` for unit testing.
 * Uses bounded pagination for all three alert endpoints.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import { collectBounded } from "../github/pull-request-evidence.js";
import { githubRequestOptions } from "../github/request-options.js";
import type { SecurityAlert, Severity, RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";
import { safeMarkdownInline } from "../rendering/markdown.js";
import {
  STRUCTURED_CONTENT_TRUST_META,
  StructuredContentTrustBoundarySchema,
  withStructuredContentTrustBoundary,
} from "../security/trust-boundary.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const SecurityTriageInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  includeCodeScanning: z.boolean().default(true)
    .describe("Include Code Scanning alerts. Requires security_events scope."),
  includeDependabot: z.boolean().default(true)
    .describe("Include Dependabot alerts. Requires vulnerability_alerts scope."),
  includeSecretScanning: z.boolean().default(true)
    .describe("Include Secret Scanning alerts. Requires secret_scanning_alerts scope."),
});

export type SecurityTriageInput = z.infer<typeof SecurityTriageInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const SecurityTriageOutputSchema = {
  trustBoundary: StructuredContentTrustBoundarySchema.optional(),
  repo: z.string(),
  alerts: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      summary: z.string(),
      state: z.string(),
      url: z.string().nullable(),
      fixedAt: z.string().nullable().optional(),
      dismissedAt: z.string().nullable().optional(),
    })
  ),
  errors: z.array(z.string()),
  truncatedSources: z.array(
    z.enum(["code_scanning", "dependabot", "secret_scanning"])
  ),
  markdownOmittedAlertCount: z.number().int().nonnegative(),
  severityCounts: z.object({
    critical: z.number().int(),
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    info: z.number().int(),
  }),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SecurityTriageResult {
  repo: string;
  alerts: SecurityAlert[];
  errors: string[];
  truncatedSources?: Array<"code_scanning" | "dependabot" | "secret_scanning">;
  markdownOmittedAlertCount?: number;
  severityCounts: Record<Severity, number>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
export const MAX_SECURITY_ALERTS_PER_SOURCE = 200;
export const MAX_RENDERED_SECURITY_ALERTS = 50;

export function severityIcon(s: Severity | string): string {
  const icons: Record<string, string> = {
    critical: "\u{1F534}",
    high: "\u{1F7E0}",
    medium: "\u{1F7E1}",
    low: "\u{1F535}",
    info: "⚪",
    warning: "\u{1F7E1}",
    note: "⚪",
    error: "\u{1F534}",
  };
  return icons[s.toLowerCase()] ?? "⚪";
}

export function normalizeSeverity(raw: string | null | undefined): Severity {
  const s = (raw ?? "").toLowerCase();
  if (["critical", "high", "medium", "low"].includes(s)) return s as Severity;
  if (s === "error") return "high";
  if (s === "warning") return "medium";
  if (s === "note") return "low";
  return "info";
}

export function computeSeverityCounts(alerts: SecurityAlert[]): Record<Severity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  for (const a of alerts) {
    counts[a.severity] = (counts[a.severity] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleSecurityTriage(
  params: SecurityTriageInput,
  ref: RepoRef,
  octokit: Octokit,
  signal?: AbortSignal
): Promise<{ text: string; structured: SecurityTriageResult }> {
  const allAlerts: SecurityAlert[] = [];
  const errors: string[] = [];
  const truncatedSources: NonNullable<SecurityTriageResult["truncatedSources"]> = [];

  // Code Scanning alerts
  if (params.includeCodeScanning) {
    try {
      const collection = await collectBounded(
        (page, perPage) =>
          octokit.codeScanning
            .listAlertsForRepo({
              owner: ref.owner,
              repo: ref.repo,
              state: "open",
              per_page: perPage,
              page,
              ...githubRequestOptions(signal),
            })
            .then((r) => r.data),
        MAX_SECURITY_ALERTS_PER_SOURCE
      );
      if (collection.truncated) truncatedSources.push("code_scanning");
      for (const alert of collection.items) {
        allAlerts.push({
          id: alert.number,
          severity: normalizeSeverity(alert.rule?.severity),
          summary: `[Code Scanning] ${alert.rule?.description ?? alert.rule?.id ?? "Unknown rule"}`,
          state: alert.state ?? "open",
          url: alert.html_url ?? null,
        });
      }
    } catch (err) {
      errors.push(
        `Code Scanning: ${handleGitHubError(err)} -- ensure your token has the \`security_events\` scope (or \`public_repo\` for public-only repos).`
      );
    }
  }

  // Dependabot alerts
  if (params.includeDependabot) {
    try {
      const collection = await collectBounded(
        (page, perPage) =>
          octokit.dependabot
            .listAlertsForRepo({
              owner: ref.owner,
              repo: ref.repo,
              state: "open",
              per_page: perPage,
              page,
              ...githubRequestOptions(signal),
            })
            .then((r) => r.data),
        MAX_SECURITY_ALERTS_PER_SOURCE
      );
      if (collection.truncated) truncatedSources.push("dependabot");
      for (const alert of collection.items) {
        const vuln = alert.security_advisory;
        allAlerts.push({
          id: alert.number,
          severity: normalizeSeverity(vuln?.severity),
          summary: `[Dependabot] ${vuln?.summary ?? "Dependency vulnerability"} in ${alert.dependency?.package?.name ?? "unknown"}`,
          state: alert.state ?? "open",
          url: alert.html_url ?? null,
          fixedAt: alert.fixed_at ?? null,
          dismissedAt: alert.dismissed_at ?? null,
        });
      }
    } catch (err) {
      errors.push(
        `Dependabot: ${handleGitHubError(err)} -- ensure your token has the \`security_events\` scope (or \`public_repo\` for public-only repos) and that Dependabot alerts are enabled for this repo.`
      );
    }
  }

  // Secret Scanning alerts
  if (params.includeSecretScanning) {
    try {
      const collection = await collectBounded(
        (page, perPage) =>
          octokit.secretScanning
            .listAlertsForRepo({
              owner: ref.owner,
              repo: ref.repo,
              state: "open",
              per_page: perPage,
              page,
              ...githubRequestOptions(signal),
            })
            .then((r) => r.data),
        MAX_SECURITY_ALERTS_PER_SOURCE
      );
      if (collection.truncated) truncatedSources.push("secret_scanning");
      for (const alert of collection.items) {
        allAlerts.push({
          id: alert.number ?? 0,
          severity: "critical" as Severity,
          summary: `[Secret Scanning] ${alert.secret_type_display_name ?? alert.secret_type ?? "Unknown secret type"}`,
          state: alert.state ?? "open",
          url: alert.html_url ?? null,
        });
      }
    } catch (err) {
      errors.push(
        `Secret Scanning: ${handleGitHubError(err)} -- ensure your token has the \`repo\` or \`security_events\` scope.`
      );
    }
  }

  // Sort by severity
  const sorted = [...allAlerts].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  const counts = computeSeverityCounts(sorted);
  const markdownOmittedAlertCount = Math.max(
    0,
    sorted.length - MAX_RENDERED_SECURITY_ALERTS
  );

  const structured: SecurityTriageResult = {
    repo: `${ref.owner}/${ref.repo}`,
    alerts: sorted,
    errors,
    truncatedSources,
    markdownOmittedAlertCount,
    severityCounts: counts,
  };

  const renderedRepo = safeMarkdownInline(`${ref.owner}/${ref.repo}`, { maxLength: 200 });

  const lines: string[] = [
    `# Security Triage: ${renderedRepo}`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("## Permission Errors", "");
    errors.forEach((e) => lines.push(`- ${e}`));
    lines.push("");
  }

  if (truncatedSources.length > 0) {
    lines.push(
      "## Collection Limits",
      "",
      `Evidence was truncated at ${MAX_SECURITY_ALERTS_PER_SOURCE} open alerts for: ${truncatedSources.join(", ")}.`,
      "The absence of additional high-severity alerts is not verified until the full inventory is collected.",
      ""
    );
  }

  lines.push(
    "## Summary",
    "",
    `**Total open alerts:** ${sorted.length}`,
    "",
    "| Severity | Count |",
    "|---|---|",
    ...SEVERITY_ORDER.map((s) => `| ${severityIcon(s)} ${s} | ${counts[s] ?? 0} |`),
    ""
  );

  if (sorted.length === 0) {
    lines.push("No open security alerts found.", "");
  } else {
    lines.push("## Alerts by Priority", "");
    for (const alert of sorted.slice(0, MAX_RENDERED_SECURITY_ALERTS)) {
      const renderedId = safeMarkdownInline(String(alert.id), { maxLength: 100 });
      const renderedSummary = safeMarkdownInline(alert.summary, { maxLength: 400 });
      // GitHub alert fields are external data. Render URLs as bounded text instead
      // of Markdown link destinations so non-HTTP schemes cannot become active links.
      const renderedUrl = alert.url
        ? ` -- URL: ${safeMarkdownInline(alert.url, { maxLength: 500 })}`
        : "";
      lines.push(`- ${severityIcon(alert.severity)} **#${renderedId}** ${renderedSummary}${renderedUrl}`);
    }
    if (markdownOmittedAlertCount > 0) {
      lines.push(
        "",
        `_${markdownOmittedAlertCount} additional alert(s) omitted from Markdown; inspect structuredContent as untrusted data._`
      );
    }

    lines.push(
      "",
      "## Recommended Fix Order",
      "",
      "1. Critical (Secret Scanning) -- Rotate exposed secrets immediately, then revoke",
      "2. Critical (Code Scanning) -- Fix injection / RCE vulnerabilities before next release",
      "3. High -- Address within current sprint",
      "4. Medium -- Schedule in next sprint",
      "5. Low / Info -- Address in backlog",
      "",
      "## Suggested Issues to Create",
      ""
    );

    const critical = sorted.filter((a) => a.severity === "critical");
    const high = sorted.filter((a) => a.severity === "high");
    const medium = sorted.filter((a) => a.severity === "medium");

    lines.push("Use `create_issue_set` with these suggested issues:");
    if (critical.length > 0)
      lines.push(`- [SECURITY CRITICAL] Fix ${critical.length} critical alert(s) -- immediate action required`);
    if (high.length > 0)
      lines.push(`- [SECURITY HIGH] Address ${high.length} high-severity alert(s) in current sprint`);
    if (medium.length > 0)
      lines.push(`- [SECURITY MEDIUM] Schedule fix for ${medium.length} medium alert(s)`);
  }

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSecurityTriageTool(server: McpServer): void {
  server.registerTool(
    "security_triage",
    {
      title: "Security Triage",
      description: `Read GitHub security alerts (code scanning, Dependabot, secret scanning) and produce a triage report.

Required token scopes:
  - security_events, or public_repo for public-only repos (Code Scanning)
  - security_events, or public_repo for public-only repos (Dependabot)
  - repo or security_events (Secret Scanning)

Args:
  - owner, repo: Repository coordinates.
  - includeCodeScanning / includeDependabot / includeSecretScanning: Default true.

Returns: Alert summary, severity breakdown, recommended fix order, suggested issues.`,
      inputSchema: SecurityTriageInputSchema,
      outputSchema: SecurityTriageOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SecurityTriageInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleSecurityTriage(params, ref, octokit);
        return {
          content: [{ type: "text", text }],
          structuredContent: withStructuredContentTrustBoundary(structured),
          _meta: STRUCTURED_CONTENT_TRUST_META,
        };
      } catch (error) {
        const isGitHubApiError =
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof (error as { status?: unknown }).status === "number";
        return {
          isError: true,
          content: [{
            type: "text",
            text: isGitHubApiError
              ? handleGitHubError(error)
              : "Security triage could not be initialized. Check the local MCP configuration and retry.",
          }],
        };
      }
    }
  );
}

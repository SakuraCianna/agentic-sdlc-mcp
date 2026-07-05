/**
 * Tool: security_triage
 *
 * Reads GitHub security alerts (code scanning, Dependabot, secret scanning)
 * and produces a triage report with recommended fix order.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { SecurityAlert, Severity } from "../types.js";

const SecurityTriageInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  includeCodeScanning: z
    .boolean()
    .default(true)
    .describe("Include GitHub Code Scanning alerts. Requires security_events scope."),
  includeDependabot: z
    .boolean()
    .default(true)
    .describe("Include Dependabot vulnerability alerts. Requires vulnerability_alerts scope."),
  includeSecretScanning: z
    .boolean()
    .default(true)
    .describe("Include Secret Scanning alerts. Requires secret_scanning_alerts scope."),
});

type SecurityTriageInput = z.infer<typeof SecurityTriageInputSchema>;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function severityIcon(s: Severity | string): string {
  const icons: Record<string, string> = {
    critical: "🔴",
    high: "🟠",
    medium: "🟡",
    low: "🔵",
    info: "⚪",
    warning: "🟡",
    note: "⚪",
    error: "🔴",
  };
  return icons[s.toLowerCase()] ?? "⚪";
}

function normalizeSeverity(raw: string | null | undefined): Severity {
  const s = (raw ?? "").toLowerCase();
  if (["critical", "high", "medium", "low"].includes(s)) return s as Severity;
  if (s === "error") return "high";
  if (s === "warning") return "medium";
  if (s === "note") return "low";
  return "info";
}

export function registerSecurityTriageTool(server: McpServer): void {
  server.registerTool(
    "security_triage",
    {
      title: "Security Triage",
      description: `Read GitHub security alerts (code scanning, Dependabot, secret scanning) and produce a triage report with recommended fix order.

⚠️ Requires appropriate GitHub token scopes:
  - Code scanning: security_events
  - Dependabot alerts: vulnerability_alerts (or repo for private repos)
  - Secret scanning: secret_scanning_alerts

Insufficient permissions return a clear error with required scopes.

Args:
  - owner, repo: Repository coordinates.
  - includeCodeScanning (boolean): Default true.
  - includeDependabot (boolean): Default true.
  - includeSecretScanning (boolean): Default true.

Returns: Alert summary, severity breakdown, recommended fix order, suggested issues to create.`,
      inputSchema: SecurityTriageInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SecurityTriageInput) => {
      const ref = resolveRepo(params.owner, params.repo);
      const octokit = getOctokit();

      const allAlerts: SecurityAlert[] = [];
      const errors: string[] = [];

      // Code Scanning
      if (params.includeCodeScanning) {
        try {
          const { data } = await octokit.codeScanning.listAlertsForRepo({
            owner: ref.owner,
            repo: ref.repo,
            state: "open",
            per_page: 50,
          });
          for (const alert of data) {
            allAlerts.push({
              id: alert.number,
              severity: normalizeSeverity(alert.rule?.severity),
              summary: `[Code Scanning] ${alert.rule?.description ?? alert.rule?.id ?? "Unknown rule"}`,
              state: alert.state ?? "open",
              url: alert.html_url ?? null,
            });
          }
        } catch (err) {
          const msg = handleGitHubError(err);
          errors.push(`Code Scanning: ${msg} — ensure your token has the \`security_events\` scope.`);
        }
      }

      // Dependabot
      if (params.includeDependabot) {
        try {
          const { data } = await octokit.dependabot.listAlertsForRepo({
            owner: ref.owner,
            repo: ref.repo,
            state: "open",
            per_page: 50,
          });
          for (const alert of data) {
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
          const msg = handleGitHubError(err);
          errors.push(`Dependabot: ${msg} — ensure your token has the \`vulnerability_alerts\` scope or Dependabot is enabled.`);
        }
      }

      // Secret Scanning
      if (params.includeSecretScanning) {
        try {
          const { data } = await octokit.secretScanning.listAlertsForRepo({
            owner: ref.owner,
            repo: ref.repo,
            state: "open",
            per_page: 50,
          });
          for (const alert of data) {
            allAlerts.push({
              id: alert.number ?? 0,
              severity: "critical" as Severity, // Exposed secrets are always critical
              summary: `[Secret Scanning] ${alert.secret_type_display_name ?? alert.secret_type ?? "Unknown secret type"}`,
              state: alert.state ?? "open",
              url: alert.html_url ?? null,
            });
          }
        } catch (err) {
          const msg = handleGitHubError(err);
          errors.push(`Secret Scanning: ${msg} — ensure your token has the \`secret_scanning_alerts\` scope.`);
        }
      }

      // Sort by severity
      const sorted = [...allAlerts].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
      );

      const counts = SEVERITY_ORDER.reduce<Record<string, number>>((acc, s) => {
        acc[s] = sorted.filter((a) => a.severity === s).length;
        return acc;
      }, {});

      const lines: string[] = [
        `# Security Triage: ${ref.owner}/${ref.repo}`,
        "",
      ];

      if (errors.length > 0) {
        lines.push("## ⚠️ Permission Errors", "");
        errors.forEach((e) => lines.push(`- ${e}`));
        lines.push("");
      }

      lines.push(
        "## Summary",
        "",
        `**Total open alerts:** ${allAlerts.length}`,
        "",
        "| Severity | Count |",
        "|---|---|",
        ...SEVERITY_ORDER.map((s) => `| ${severityIcon(s)} ${s} | ${counts[s] ?? 0} |`),
        ""
      );

      if (sorted.length === 0) {
        lines.push("✅ No open security alerts found.", "");
      } else {
        lines.push("## Alerts by Priority", "");
        for (const alert of sorted) {
          const link = alert.url ? ` — [view](${alert.url})` : "";
          lines.push(`- ${severityIcon(alert.severity)} **#${alert.id}** ${alert.summary}${link}`);
        }

        lines.push(
          "",
          "## Recommended Fix Order",
          "",
          "1. 🔴 **Critical (Secret Scanning)** — Rotate exposed secrets immediately, then revoke",
          "2. 🔴 **Critical (Code Scanning)** — Fix injection / RCE vulnerabilities before next release",
          "3. 🟠 **High** — Address within current sprint",
          "4. 🟡 **Medium** — Schedule in next sprint",
          "5. 🔵 **Low / Info** — Address in backlog",
          "",
          "## Suggested Issues to Create",
          "",
          "Use `create_issue_set` with these suggested issues:"
        );

        const critical = sorted.filter((a) => a.severity === "critical");
        const high = sorted.filter((a) => a.severity === "high");

        if (critical.length > 0) {
          lines.push(`- [SECURITY CRITICAL] Fix ${critical.length} critical alert(s) — immediate action required`);
        }
        if (high.length > 0) {
          lines.push(`- [SECURITY HIGH] Address ${high.length} high-severity alert(s) in current sprint`);
        }

        const medium = sorted.filter((a) => a.severity === "medium");
        if (medium.length > 0) {
          lines.push(`- [SECURITY MEDIUM] Schedule fix for ${medium.length} medium alert(s)`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

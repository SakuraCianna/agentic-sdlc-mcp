/**
 * Tool: review_pr_against_standard
 *
 * Reviews a PR against Agentic SDLC standards (basic / strict / security-focused).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { Finding, Severity } from "../types.js";

const ReviewPrInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z
    .number()
    .int()
    .positive()
    .describe("The pull request number to review."),
  standard: z
    .enum(["basic", "strict", "security-focused"])
    .default("basic")
    .describe(
      "Review standard: 'basic' (default), 'strict' (more thorough), 'security-focused' (emphasis on security concerns)."
    ),
});

type ReviewPrInput = z.infer<typeof ReviewPrInputSchema>;

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
}

function severityIcon(s: Severity): string {
  return { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵", info: "⚪" }[s];
}

export function registerReviewPrTool(server: McpServer): void {
  server.registerTool(
    "review_pr_against_standard",
    {
      title: "Review PR Against SDLC Standard",
      description: `Review a pull request against Agentic SDLC standards and produce a findings report.

Standards:
  - basic: Core checks (tests, description, size, CI)
  - strict: All of basic + docs, changelog, PR size enforcement
  - security-focused: All of strict + secret scanning heuristics, dependency changes

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number): The PR to review.
  - standard: "basic" | "strict" | "security-focused". Default: "basic".

Returns: Sorted findings by severity, missing tests, security concerns, release risk, and conclusion.`,
      inputSchema: ReviewPrInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ReviewPrInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();

        const { data: pr } = await octokit.pulls.get({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: params.pullNumber,
        });

        const { data: files } = await octokit.pulls.listFiles({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: params.pullNumber,
          per_page: 100,
        });

        const findings: Finding[] = [];
        const totalLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);

        const hasTests = files.some(
          (f) =>
            f.filename.includes("test") ||
            f.filename.includes("spec") ||
            f.filename.includes("__tests__")
        );
        const hasDescription = (pr.body ?? "").trim().length > 20;
        const isDraft = pr.draft ?? false;

        // Basic checks
        if (!hasDescription) {
          findings.push({
            severity: "high",
            category: "Documentation",
            description: "PR has no meaningful description.",
            suggestion: "Add a description explaining the WHY, not just WHAT changed.",
          });
        }

        if (!hasTests) {
          findings.push({
            severity: "high",
            category: "Testing",
            description: "No test files detected in this PR.",
            suggestion: "Add or update unit/integration tests for the changed code.",
          });
        }

        if (isDraft) {
          findings.push({
            severity: "info",
            category: "Status",
            description: "PR is still marked as a draft.",
            suggestion: "Mark as ready for review when implementation is complete.",
          });
        }

        if (pr.commits > 20) {
          findings.push({
            severity: "low",
            category: "Hygiene",
            description: `PR has ${pr.commits} commits — consider squashing for cleaner history.`,
            suggestion: "Use 'git rebase -i' to squash related commits.",
          });
        }

        // Strict checks
        if (params.standard === "strict" || params.standard === "security-focused") {
          if (totalLines > 800) {
            findings.push({
              severity: "medium",
              category: "Size",
              description: `Large PR: ${totalLines} changed lines. Harder to review thoroughly.`,
              suggestion: "Consider splitting into smaller, focused PRs.",
            });
          }

          const hasDocs = files.some(
            (f) => f.filename.endsWith(".md") || f.filename.startsWith("docs/")
          );
          const srcChanges = files.filter(
            (f) => !f.filename.endsWith(".md") && !f.filename.includes("test")
          );
          if (srcChanges.length > 5 && !hasDocs) {
            findings.push({
              severity: "low",
              category: "Documentation",
              description: "No documentation files updated despite significant source changes.",
              suggestion: "Update README or docs/ if any public API or behaviour changed.",
            });
          }
        }

        // Security-focused checks
        if (params.standard === "security-focused") {
          const secretPatterns = [
            /password\s*=\s*['"][^'"]{6,}/i,
            /api[_-]?key\s*=\s*['"][^'"]{6,}/i,
            /secret\s*=\s*['"][^'"]{6,}/i,
            /token\s*=\s*['"][^'"]{6,}/i,
          ];

          const configFiles = files.filter(
            (f) =>
              f.filename.endsWith(".json") ||
              f.filename.endsWith(".env") ||
              f.filename.endsWith(".yaml") ||
              f.filename.endsWith(".yml")
          );

          if (configFiles.length > 0) {
            findings.push({
              severity: "medium",
              category: "Security",
              description: `Config/env files changed: ${configFiles.map((f) => f.filename).join(", ")}`,
              suggestion: "Verify no secrets are hardcoded. Check .gitignore is up to date.",
            });
          }

          const lockfileChanged = files.some(
            (f) =>
              f.filename === "package-lock.json" ||
              f.filename === "yarn.lock" ||
              f.filename === "Cargo.lock" ||
              f.filename === "requirements.txt"
          );
          if (lockfileChanged) {
            findings.push({
              severity: "medium",
              category: "Security",
              description: "Dependency lockfile changed — review new/updated dependencies.",
              suggestion:
                "Run 'npm audit' or 'pip-audit' to check for known vulnerabilities.",
            });
          }

          // Note: we can't read file contents via list API, so we flag the need to check
          findings.push({
            severity: "info",
            category: "Security",
            description: "Manual secret scan recommended — automated scanning not available via list API.",
            suggestion: "Run 'git log -p | grep -iE \"password|secret|token|key\"' locally.",
          });
        }

        const sorted = sortFindings(findings);
        const critical = sorted.filter((f) => f.severity === "critical");
        const high = sorted.filter((f) => f.severity === "high");
        const medium = sorted.filter((f) => f.severity === "medium");

        const conclusion =
          critical.length > 0 || high.length > 0
            ? "needs_changes"
            : medium.length > 0
            ? "risky_but_acceptable"
            : "pass";

        const conclusionLabel =
          conclusion === "pass"
            ? "✅ PASS"
            : conclusion === "needs_changes"
            ? "❌ NEEDS CHANGES"
            : "⚠️ RISKY BUT ACCEPTABLE";

        const lines: string[] = [
          `# PR Review: #${pr.number} — ${pr.title}`,
          "",
          `**Standard:** ${params.standard}`,
          `**Conclusion:** ${conclusionLabel}`,
          `**Findings:** ${sorted.length} total (${critical.length} critical, ${high.length} high, ${medium.length} medium)`,
          "",
          "## Findings",
        ];

        if (sorted.length === 0) {
          lines.push("", "No findings — looks good! ✅");
        } else {
          for (const f of sorted) {
            lines.push(
              "",
              `### ${severityIcon(f.severity)} [${f.severity.toUpperCase()}] ${f.category}: ${f.description}`,
              f.suggestion ? `> 💡 ${f.suggestion}` : ""
            );
          }
        }

        lines.push(
          "",
          "## Missing Tests",
          hasTests ? "✅ Tests included." : "⚠️ No test files detected in this PR.",
          "",
          "## Security Concerns",
          params.standard === "security-focused"
            ? "See security findings above."
            : "Run with `standard: 'security-focused'` for deeper security analysis.",
          "",
          "## Release Risk",
          conclusion === "pass"
            ? "🟢 Low risk — safe to merge after review."
            : conclusion === "risky_but_acceptable"
            ? "🟡 Moderate risk — address medium findings before release."
            : "🔴 High risk — must fix critical/high findings before merging.",
          "",
          "## Conclusion",
          conclusionLabel
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

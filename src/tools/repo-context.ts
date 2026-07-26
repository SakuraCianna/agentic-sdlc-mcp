/**
 * Tool: repo_context
 *
 * Reads repository baseline context -> metadata, README, package.json,
 * open issues and PRs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  STRUCTURED_CONTENT_TRUST_META,
  StructuredContentTrustBoundarySchema,
  withStructuredContentTrustBoundary,
} from "../security/trust-boundary.js";
import { resolveRepo, handleGitHubError } from "../github/client.js";
import {
  fetchRepoContext,
  summarizePackageJson,
} from "../github/context.js";
import {
  protectUntrustedText,
  type PromptInjectionAssessment,
} from "../security/prompt-injection.js";
import { safeMarkdownInline } from "../rendering/markdown.js";

const RepoContextInputSchema = z.object({
  owner: z
    .string()
    .optional()
    .describe("GitHub owner (org or user). Falls back to GITHUB_OWNER env var."),
  repo: z
    .string()
    .optional()
    .describe("GitHub repo name. Falls back to GITHUB_REPO env var."),
  includeReadme: z
    .boolean()
    .default(true)
    .describe("Include a truncated README summary."),
  includePackageJson: z
    .boolean()
    .default(false)
    .describe("Include a package.json summary, detected package manager, tech stack, and common scripts."),
  includeWorkflows: z
    .boolean()
    .default(false)
    .describe("Include `.github/workflows/*.yml` file names (names only, not permissions -- use workflow_permissions_audit for that)."),
  includeAgentInstructions: z
    .boolean()
    .default(false)
    .describe("Include summaries of agent instruction files (AGENTS.md, CLAUDE.md) if present at the repo root."),
  includeGovernance: z
    .boolean()
    .default(false)
    .describe("Include lightweight governance signals (currently: whether a CODEOWNERS file exists). For full branch protection details, use branch_protection_status."),
  includePolicy: z
    .boolean()
    .default(false)
    .describe("Include the validated .agentic-sdlc.yml policy summary, rule IDs, digest, and source ref/SHA."),
  includeOpenIssues: z
    .boolean()
    .default(false)
    .describe("Include a list of recent open issues (up to 20)."),
  includeOpenPRs: z
    .boolean()
    .default(false)
    .describe("Include a list of open pull requests (up to 20)."),
  issueLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max number of open issues to fetch when includeOpenIssues is true. Default: 20, max: 100."),
  prLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max number of open PRs to fetch when includeOpenPRs is true. Default: 20, max: 100."),
  maxReadmeChars: z
    .number()
    .int()
    .min(200)
    .max(20000)
    .default(3000)
    .describe("Max README characters before truncation. Default: 3000."),
  maxInstructionChars: z
    .number()
    .int()
    .min(200)
    .max(20000)
    .default(1000)
    .describe("Max characters per agent instruction file summary before truncation. Default: 1000."),
});

type RepoContextInput = z.infer<typeof RepoContextInputSchema>;

// ---------------------------------------------------------------------------
// Output schema (aligned with structuredContent)
// ---------------------------------------------------------------------------

const OpenIssueShape = z.object({
  number: z.number(),
  title: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  url: z.string(),
});

const OpenPrShape = z.object({
  number: z.number(),
  title: z.string(),
  author: z.string(),
  draft: z.boolean(),
  createdAt: z.string(),
  url: z.string(),
});

const AgentInstructionShape = z.object({
  path: z.string(),
  summary: z.string(),
});

const PolicySourceShape = z.object({
  kind: z.enum(["default", "repository"]),
  path: z.string().nullable(),
  ref: z.string().nullable(),
  blobSha: z.string().nullable(),
  digest: z.string(),
});

const AppliedPolicyRuleShape = z.object({
  id: z.string(),
  source: z.literal("repository"),
});

const PromptInjectionWarningShape = z.object({
  source: z.string(),
  severity: z.enum(["medium", "high"]),
  categories: z.array(
    z.enum([
      "instruction_override",
      "role_impersonation",
      "tool_coercion",
      "secret_exfiltration",
      "data_exfiltration",
      "encoded_instruction",
    ])
  ),
});

const RepositoryPolicySummaryShape = z.object({
  found: z.boolean(),
  degraded: z.boolean(),
  schemaVersion: z.literal(1),
  defaultWorkType: z.enum(["docs", "feature", "bugfix", "refactor", "security", "release", "infra"]).optional(),
  requiredChecks: z.array(z.object({
    name: z.string(), source: z.literal("check_run"), appId: z.number().int().positive(),
  })),
  protectedPaths: z.array(z.string()),
  riskRuleIds: z.array(z.string()),
  requiredReviewerRuleIds: z.array(z.string()),
  releaseBlockingLabels: z.array(z.string()),
  requireIssueLink: z.boolean(),
  requireCodeOwnersForProtectedPaths: z.boolean(),
  requireChangelog: z.boolean(),
  requireRollbackPlan: z.boolean(),
});

export const RepoContextOutputSchema = {
  trustBoundary: StructuredContentTrustBoundarySchema.optional(),
  fullName: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  visibility: z.string(),
  language: z.string().nullable(),
  stargazersCount: z.number(),
  openIssuesCount: z.number(),
  topics: z.array(z.string()),
  pushedAt: z.string().nullable(),
  readmeSummary: z.string().optional(),
  packageJsonSummary: z.string().optional(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]).optional(),
  techStack: z.array(z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  workflows: z.array(z.string()).optional(),
  governance: z.object({ codeownersFound: z.boolean() }).optional(),
  agentInstructions: z.array(AgentInstructionShape).optional(),
  policy: RepositoryPolicySummaryShape.optional(),
  policyDigest: z.string().optional(),
  policySources: z.array(PolicySourceShape).optional(),
  appliedPolicyRules: z.array(AppliedPolicyRuleShape).optional(),
  policyErrors: z.array(z.string()).optional(),
  policyWarnings: z.array(z.string()).optional(),
  openIssues: z.array(OpenIssueShape).optional(),
  openPRs: z.array(OpenPrShape).optional(),
  promptInjectionWarnings: z.array(PromptInjectionWarningShape).optional(),
};

export function registerRepoContextTool(server: McpServer): void {
  server.registerTool(
    "repo_context",
    {
      title: "Get Repository Context",
      description: `Read baseline context for a GitHub repository, including metadata, README summary, package.json summary, tech stack, common scripts, workflow file names, governance signals, agent instruction file summaries, open issues, and open PRs.

Use this tool at the start of any SDLC workflow to understand the codebase before planning or creating work items.

Args:
  - owner (string?): GitHub org or user. Defaults to GITHUB_OWNER env var.
  - repo (string?): Repository name. Defaults to GITHUB_REPO env var.
  - includeReadme (boolean): Include truncated README. Default: true.
  - includePackageJson (boolean): Include package.json summary, detected package manager, tech stack, and common scripts. Default: false.
  - includeWorkflows (boolean): Include .github/workflows/*.yml file names. Default: false.
  - includeAgentInstructions (boolean): Include summaries of AGENTS.md/CLAUDE.md if present. Default: false.
  - includeGovernance (boolean): Include whether a CODEOWNERS file exists. Default: false.
  - includePolicy (boolean): Include validated repository policy and provenance. Default: false.
  - includeOpenIssues (boolean): Include recent open issues. Default: false.
  - includeOpenPRs (boolean): Include open pull requests. Default: false.
  - issueLimit (number): Max open issues to fetch. Default: 20, max: 100.
  - prLimit (number): Max open PRs to fetch. Default: 20, max: 100.
  - maxReadmeChars (number): Max README characters before truncation. Default: 3000.
  - maxInstructionChars (number): Max characters per agent instruction file summary. Default: 1000.

Returns: Markdown summary of the repository context, plus structured content. Missing files (README, package.json, agent instructions) degrade gracefully rather than failing the whole call.`,
      inputSchema: RepoContextInputSchema,
      outputSchema: RepoContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: RepoContextInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const ctx = await fetchRepoContext({
          ...ref,
          includeReadme: params.includeReadme,
          includePackageJson: params.includePackageJson,
          includeWorkflows: params.includeWorkflows,
          includeAgentInstructions: params.includeAgentInstructions,
          includeGovernance: params.includeGovernance,
          includePolicy: params.includePolicy,
          includeOpenIssues: params.includeOpenIssues,
          includeOpenPRs: params.includeOpenPRs,
          issueLimit: params.issueLimit,
          prLimit: params.prLimit,
          maxReadmeChars: params.maxReadmeChars,
          maxInstructionChars: params.maxInstructionChars,
        });
        const promptInjectionWarnings: Array<{
          source: string;
          severity: Exclude<PromptInjectionAssessment["severity"], "none">;
          categories: PromptInjectionAssessment["categories"];
        }> = [];
        const renderRepositoryText = (
          source: string,
          value: string,
          maxLength: number
        ): string => {
          const protectedText = protectUntrustedText(value, { maxLength });
          if (protectedText.assessment.detected && protectedText.assessment.severity !== "none") {
            promptInjectionWarnings.push({
              source,
              severity: protectedText.assessment.severity,
              categories: protectedText.assessment.categories,
            });
          }
          return protectedText.rendered;
        };

        const lines: string[] = [
          `# Repository Context: ${renderRepositoryText("repository.fullName", ctx.fullName, 200)}`,
          "",
          `**Description:** ${ctx.description ? renderRepositoryText("repository.description", ctx.description, 500) : "(none)"}`,
          `**Default branch:** \`${renderRepositoryText("repository.defaultBranch", ctx.defaultBranch, 200)}\``,
          `**Visibility:** ${renderRepositoryText("repository.visibility", ctx.visibility, 100)}`,
          `**Language:** ${ctx.language ? renderRepositoryText("repository.language", ctx.language, 100) : "unknown"}`,
          `**Stars:** ${ctx.stargazersCount}`,
          `**Open issues (total):** ${ctx.openIssuesCount}`,
          `**Topics:** ${ctx.topics.length > 0 ? ctx.topics.map((topic, index) => renderRepositoryText(`repository.topics[${index}]`, topic, 100)).join(", ") : "(none)"}`,
          `**Last pushed:** ${ctx.pushedAt ? renderRepositoryText("repository.pushedAt", ctx.pushedAt, 100) : "unknown"}`,
        ];

        if (params.includePackageJson) {
          const packageJsonSummary = ctx.packageJson
            ? summarizePackageJson(ctx.packageJson)
            : "(package.json not found or inaccessible)";
          lines.push(
            "",
            "## package.json Summary",
            "```",
            renderRepositoryText("package.json summary", packageJsonSummary, 2_000),
            "```"
          );
          lines.push(
            "",
            "## Build & Runtime",
            `**Package manager:** ${ctx.packageManager ? renderRepositoryText("package.manager", ctx.packageManager, 100) : "unknown"}`,
            `**Tech stack:** ${ctx.techStack && ctx.techStack.length > 0 ? ctx.techStack.map((technology, index) => renderRepositoryText(`package.techStack[${index}]`, technology, 100)).join(", ") : "(none detected)"}`
          );
          const scriptEntries = ctx.scripts ? Object.entries(ctx.scripts) : [];
          if (scriptEntries.length > 0) {
            lines.push("", "**Common scripts:**");
            scriptEntries.forEach(([name, cmd]) =>
              lines.push(
                `- \`npm run ${renderRepositoryText(`package.scripts.${name}.name`, name, 100)}\`: \`${renderRepositoryText(`package.scripts.${name}`, cmd, 500)}\``
              )
            );
          } else {
            lines.push("", "**Common scripts:** (none of the recognised script names were found)");
          }
        }

        if (params.includePolicy) {
          const policy = ctx.policy;
          lines.push(
            "",
            "## Repository Policy",
            `**Status:** ${policy?.degraded ? "degraded (safe defaults applied)" : policy?.found ? "loaded" : "not found (built-in defaults)"}`,
            `**Digest:** ${ctx.policyDigest ? `\`${renderRepositoryText("policy.digest", ctx.policyDigest, 100)}\`` : "unknown"}`,
            `**Default work type:** ${policy?.defaultWorkType ? renderRepositoryText("policy.defaultWorkType", policy.defaultWorkType, 100) : "(none)"}`,
            `**Required checks:** ${policy?.requiredChecks.length ? policy.requiredChecks.map((check, index) => `${renderRepositoryText(`policy.requiredChecks[${index}].name`, check.name, 200)} (App ${check.appId})`).join(", ") : "(none)"}`,
            `**Protected paths:** ${policy?.protectedPaths.length ? policy.protectedPaths.map((path, index) => renderRepositoryText(`policy.protectedPaths[${index}]`, path, 300)).join(", ") : "(none)"}`,
            `**Applied rule IDs:** ${ctx.appliedPolicyRules?.length ? ctx.appliedPolicyRules.map((rule, index) => renderRepositoryText(`policy.appliedRules[${index}]`, rule.id, 200)).join(", ") : "(none)"}`
          );
          if (ctx.policySources?.length) {
            lines.push("", "**Policy sources:**");
            ctx.policySources.forEach((source, index) =>
              lines.push(
                `- ${renderRepositoryText(`policy.sources[${index}].kind`, source.kind, 100)}: ${source.path ? renderRepositoryText(`policy.sources[${index}].path`, source.path, 300) : "built-in"} @ ${source.ref ? renderRepositoryText(`policy.sources[${index}].ref`, source.ref, 200) : "default"} (blob: ${source.blobSha ? renderRepositoryText(`policy.sources[${index}].blobSha`, source.blobSha, 100) : "n/a"})`
              )
            );
          }
          if (ctx.policyErrors?.length) {
            lines.push(
              "",
              "**Policy errors:**",
              ...ctx.policyErrors.map(
                (error, index) =>
                  `- ${renderRepositoryText(`policy.errors[${index}]`, error, 500)}`
              )
            );
          }
        }

        if (params.includeWorkflows) {
          lines.push(
            "",
            "## Workflows",
            ctx.workflows && ctx.workflows.length > 0
              ? ctx.workflows.map((workflow, index) =>
                  `- \`.github/workflows/${renderRepositoryText(`workflow[${index}]`, workflow, 300)}\``
                ).join("\n")
              : "(no .github/workflows/*.yml files found)"
          );
        }

        if (params.includeGovernance) {
          lines.push(
            "",
            "## Governance",
            `**CODEOWNERS found:** ${ctx.governance?.codeownersFound ? "yes" : "no"}`,
            "_For branch protection details, call `branch_protection_status`._"
          );
        }

        if (params.includeAgentInstructions) {
          lines.push("", "## Agent Instructions");
          if (ctx.agentInstructions && ctx.agentInstructions.length > 0) {
            for (const instr of ctx.agentInstructions) {
              lines.push(
                "",
                `### ${renderRepositoryText("agent instruction path", instr.path, 300)}`,
                "",
                renderRepositoryText(instr.path, instr.summary, params.maxInstructionChars)
              );
            }
          } else {
            lines.push("", "(no AGENTS.md or CLAUDE.md found at the repo root)");
          }
        }

        if (ctx.readme) {
          lines.push(
            "",
            "## README (truncated)",
            "",
            renderRepositoryText("README", ctx.readme, params.maxReadmeChars)
          );
        }

        if (ctx.openIssues && ctx.openIssues.length > 0) {
          lines.push("", "## Open Issues (recent)");
          for (const issue of ctx.openIssues) {
            const labels = issue.labels.length > 0
              ? ` [${issue.labels.map((label, index) =>
                  renderRepositoryText(`issue[${issue.number}].labels[${index}]`, label, 100)
                ).join(", ")}]`
              : "";
            lines.push(
              `- #${issue.number} ${renderRepositoryText(`issue[${issue.number}].title`, issue.title, 300)}${labels} -> ${renderRepositoryText(`issue[${issue.number}].url`, issue.url, 500)}`
            );
          }
        } else if (params.includeOpenIssues) {
          lines.push("", "## Open Issues", "(none)");
        }

        if (ctx.openPRs && ctx.openPRs.length > 0) {
          lines.push("", "## Open Pull Requests");
          for (const pr of ctx.openPRs) {
            const draftTag = pr.draft ? " [DRAFT]" : "";
            lines.push(
              `- #${pr.number}${draftTag} ${renderRepositoryText(`pullRequest[${pr.number}].title`, pr.title, 300)} by @${renderRepositoryText(`pullRequest[${pr.number}].author`, pr.author, 100)} -> ${renderRepositoryText(`pullRequest[${pr.number}].url`, pr.url, 500)}`
            );
          }
        } else if (params.includeOpenPRs) {
          lines.push("", "## Open Pull Requests", "(none)");
        }

        const structured = {
          fullName: ctx.fullName,
          description: ctx.description,
          defaultBranch: ctx.defaultBranch,
          visibility: ctx.visibility,
          language: ctx.language,
          stargazersCount: ctx.stargazersCount,
          openIssuesCount: ctx.openIssuesCount,
          topics: ctx.topics,
          pushedAt: ctx.pushedAt,
          ...(params.includeReadme
            ? { readmeSummary: ctx.readme ?? "(README not found or inaccessible)" }
            : {}),
          ...(params.includePackageJson
            ? {
                packageJsonSummary: ctx.packageJson
                  ? summarizePackageJson(ctx.packageJson)
                  : "(package.json not found or inaccessible)",
              }
            : {}),
          ...(ctx.packageManager ? { packageManager: ctx.packageManager } : {}),
          ...(ctx.techStack ? { techStack: ctx.techStack } : {}),
          ...(ctx.scripts ? { scripts: ctx.scripts } : {}),
          ...(ctx.workflows ? { workflows: ctx.workflows } : {}),
          ...(ctx.governance ? { governance: ctx.governance } : {}),
          ...(ctx.agentInstructions ? { agentInstructions: ctx.agentInstructions } : {}),
          ...(ctx.policy ? { policy: ctx.policy } : {}),
          ...(ctx.policyDigest ? { policyDigest: ctx.policyDigest } : {}),
          ...(ctx.policySources ? { policySources: ctx.policySources } : {}),
          ...(ctx.appliedPolicyRules ? { appliedPolicyRules: ctx.appliedPolicyRules } : {}),
          ...(ctx.policyErrors ? { policyErrors: ctx.policyErrors } : {}),
          ...(ctx.policyWarnings ? { policyWarnings: ctx.policyWarnings } : {}),
          ...(ctx.openIssues ? { openIssues: ctx.openIssues } : {}),
          ...(ctx.openPRs ? { openPRs: ctx.openPRs } : {}),
          ...(promptInjectionWarnings.length > 0 ? { promptInjectionWarnings } : {}),
        };

        if (promptInjectionWarnings.length > 0) {
          lines.push(
            "",
            "## Prompt-Injection Warnings",
            ...promptInjectionWarnings.map(
              (warning) =>
                `- ${safeMarkdownInline(warning.source, { maxLength: 300 })}: ${warning.severity} (${warning.categories.join(", ")})`
            )
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
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

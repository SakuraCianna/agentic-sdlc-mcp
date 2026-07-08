/**
 * Tool: repo_context
 *
 * Reads repository baseline context -> metadata, README, package.json,
 * open issues and PRs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, handleGitHubError } from "../github/client.js";
import {
  fetchRepoContext,
  summarizePackageJson,
} from "../github/context.js";

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

export const RepoContextOutputSchema = {
  fullName: z.string(),
  description: z.string().nullable(),
  defaultBranch: z.string(),
  visibility: z.string(),
  language: z.string().nullable(),
  stargazersCount: z.number(),
  openIssuesCount: z.number(),
  topics: z.array(z.string()),
  pushedAt: z.string().nullable(),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "unknown"]).optional(),
  techStack: z.array(z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  workflows: z.array(z.string()).optional(),
  governance: z.object({ codeownersFound: z.boolean() }).optional(),
  agentInstructions: z.array(AgentInstructionShape).optional(),
  openIssues: z.array(OpenIssueShape).optional(),
  openPRs: z.array(OpenPrShape).optional(),
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
          includeOpenIssues: params.includeOpenIssues,
          includeOpenPRs: params.includeOpenPRs,
          issueLimit: params.issueLimit,
          prLimit: params.prLimit,
          maxReadmeChars: params.maxReadmeChars,
          maxInstructionChars: params.maxInstructionChars,
        });

        const lines: string[] = [
          `# Repository Context: ${ctx.fullName}`,
          "",
          `**Description:** ${ctx.description ?? "(none)"}`,
          `**Default branch:** \`${ctx.defaultBranch}\``,
          `**Visibility:** ${ctx.visibility}`,
          `**Language:** ${ctx.language ?? "unknown"}`,
          `**Stars:** ${ctx.stargazersCount}`,
          `**Open issues (total):** ${ctx.openIssuesCount}`,
          `**Topics:** ${ctx.topics.length > 0 ? ctx.topics.join(", ") : "(none)"}`,
          `**Last pushed:** ${ctx.pushedAt ?? "unknown"}`,
        ];

        if (ctx.packageJson) {
          lines.push("", "## package.json Summary", "```", summarizePackageJson(ctx.packageJson), "```");
        }
        if (params.includePackageJson) {
          lines.push(
            "",
            "## Build & Runtime",
            `**Package manager:** ${ctx.packageManager ?? "unknown"}`,
            `**Tech stack:** ${ctx.techStack && ctx.techStack.length > 0 ? ctx.techStack.join(", ") : "(none detected)"}`
          );
          const scriptEntries = ctx.scripts ? Object.entries(ctx.scripts) : [];
          if (scriptEntries.length > 0) {
            lines.push("", "**Common scripts:**");
            scriptEntries.forEach(([name, cmd]) => lines.push(`- \`npm run ${name}\`: \`${cmd}\``));
          } else {
            lines.push("", "**Common scripts:** (none of the recognised script names were found)");
          }
        }

        if (params.includeWorkflows) {
          lines.push(
            "",
            "## Workflows",
            ctx.workflows && ctx.workflows.length > 0
              ? ctx.workflows.map((w) => `- \`.github/workflows/${w}\``).join("\n")
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
              lines.push("", `### ${instr.path}`, "", instr.summary);
            }
          } else {
            lines.push("", "(no AGENTS.md or CLAUDE.md found at the repo root)");
          }
        }

        if (ctx.readme) {
          lines.push("", "## README (truncated)", "", ctx.readme);
        }

        if (ctx.openIssues && ctx.openIssues.length > 0) {
          lines.push("", "## Open Issues (recent)");
          for (const issue of ctx.openIssues) {
            const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
            lines.push(`- #${issue.number} ${issue.title}${labels} -> ${issue.url}`);
          }
        } else if (params.includeOpenIssues) {
          lines.push("", "## Open Issues", "(none)");
        }

        if (ctx.openPRs && ctx.openPRs.length > 0) {
          lines.push("", "## Open Pull Requests");
          for (const pr of ctx.openPRs) {
            const draftTag = pr.draft ? " [DRAFT]" : "";
            lines.push(`- #${pr.number}${draftTag} ${pr.title} by @${pr.author} -> ${pr.url}`);
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
          ...(ctx.packageManager ? { packageManager: ctx.packageManager } : {}),
          ...(ctx.techStack ? { techStack: ctx.techStack } : {}),
          ...(ctx.scripts ? { scripts: ctx.scripts } : {}),
          ...(ctx.workflows ? { workflows: ctx.workflows } : {}),
          ...(ctx.governance ? { governance: ctx.governance } : {}),
          ...(ctx.agentInstructions ? { agentInstructions: ctx.agentInstructions } : {}),
          ...(ctx.openIssues ? { openIssues: ctx.openIssues } : {}),
          ...(ctx.openPRs ? { openPRs: ctx.openPRs } : {}),
        };

        return {
          content: [{ type: "text", text: lines.join("\n") }],
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

/**
 * Tool: agent_handoff_packet
 *
 * Handler extracted as `handleAgentHandoff` for testing.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AgentHandoffInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  issueNumber: z.number().int().positive().optional()
    .describe("Issue being worked on (if applicable)."),
  pullNumber: z.number().int().positive().optional()
    .describe("PR being worked on (if applicable)."),
  currentStatus: z.string().min(1)
    .describe("Free-text description of the current work status."),
  nextSteps: z.array(z.string()).optional()
    .describe("Ordered list of next steps for the incoming agent."),
});

export type AgentHandoffInput = z.infer<typeof AgentHandoffInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const AgentHandoffOutputSchema = {
  repo: z.string(),
  defaultBranch: z.string(),
  currentStatus: z.string(),
  nextSteps: z.array(z.string()),
  handoffPrompt: z.string(),
  issueRef: z
    .object({
      number: z.number().int(),
      title: z.string(),
      state: z.string(),
      url: z.string(),
    })
    .nullable(),
  prRef: z
    .object({
      number: z.number().int(),
      title: z.string(),
      state: z.string(),
      branch: z.string(),
      url: z.string(),
    })
    .nullable(),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentHandoffResult {
  repo: string;
  defaultBranch: string;
  currentStatus: string;
  nextSteps: string[];
  handoffPrompt: string;
  issueRef: { number: number; title: string; state: string; url: string } | null;
  prRef: { number: number; title: string; state: string; branch: string; url: string } | null;
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleAgentHandoff(
  params: AgentHandoffInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: AgentHandoffResult }> {
  const { data: repoData } = await octokit.repos.get({
    owner: ref.owner,
    repo: ref.repo,
  });

  let issueRef: AgentHandoffResult["issueRef"] = null;
  if (params.issueNumber) {
    try {
      const { data: issue } = await octokit.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: params.issueNumber,
      });
      issueRef = {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
      };
    } catch {
      // Could not fetch — leave null
    }
  }

  let prRef: AgentHandoffResult["prRef"] = null;
  if (params.pullNumber) {
    try {
      const { data: pr } = await octokit.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: params.pullNumber,
      });
      prRef = {
        number: pr.number,
        title: pr.title,
        state: pr.state + (pr.draft ? " (draft)" : ""),
        branch: `${pr.head.ref} -> ${pr.base.ref}`,
        url: pr.html_url,
      };
    } catch {
      // Could not fetch — leave null
    }
  }

  const nextSteps = params.nextSteps ?? [
    "Review the current state of the issue/PR",
    "Run quality_gate_status to check CI",
    "Address any remaining review comments",
    "Ensure tests pass before proceeding",
  ];

  const handoffLines: string[] = [
    `You are taking over work on ${ref.owner}/${ref.repo}.`,
    "",
    `Current status: ${params.currentStatus}`,
    "",
    `Repository: ${repoData.full_name} (default branch: ${repoData.default_branch})`,
  ];
  if (issueRef) {
    handoffLines.push(`Issue #${issueRef.number}: ${issueRef.title} [${issueRef.state}] ${issueRef.url}`);
  }
  if (prRef) {
    handoffLines.push(`PR #${prRef.number}: ${prRef.title} [${prRef.state}] ${prRef.url}`);
  }
  handoffLines.push(
    "",
    "Your next steps (in order):",
    ...nextSteps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "Tools available: repo_context, quality_gate_status, review_pr_against_standard, security_triage, release_readiness_check",
    "",
    "Start by calling repo_context to orient yourself, then proceed with the next steps above."
  );

  const handoffPrompt = handoffLines.join("\n");

  const structured: AgentHandoffResult = {
    repo: repoData.full_name,
    defaultBranch: repoData.default_branch,
    currentStatus: params.currentStatus,
    nextSteps,
    handoffPrompt,
    issueRef,
    prRef,
  };

  const lines: string[] = [
    `# Agent Handoff Packet: ${ref.owner}/${ref.repo}`,
    "",
    "## Handoff Prompt",
    "",
    "```",
    handoffPrompt,
    "```",
    "",
    "## Repo Context Snapshot",
    "",
    `- Full name: ${repoData.full_name}`,
    `- Default branch: ${repoData.default_branch}`,
    `- Language: ${repoData.language ?? "unknown"}`,
    `- Visibility: ${repoData.visibility ?? "unknown"}`,
  ];

  if (issueRef) {
    lines.push(
      "",
      "### Active Issue",
      `Issue #${issueRef.number}: ${issueRef.title}`,
      `State: ${issueRef.state}`,
      `URL: ${issueRef.url}`
    );
  }
  if (prRef) {
    lines.push(
      "",
      "### Active PR",
      `PR #${prRef.number}: ${prRef.title}`,
      `State: ${prRef.state}`,
      `Branch: ${prRef.branch}`,
      `URL: ${prRef.url}`
    );
  }

  lines.push(
    "",
    "## Current Status",
    "",
    params.currentStatus,
    "",
    "## Decisions Made",
    "",
    "_(Document decisions here before handing off)_",
    "- No decisions recorded.",
    "",
    "## Remaining Tasks",
    "",
    ...nextSteps.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Verification Required",
    "",
    "- [ ] Run quality_gate_status to confirm CI is passing",
    "- [ ] Run review_pr_against_standard if a PR is open",
    "- [ ] Run security_triage if security-related changes were made",
    "- [ ] Confirm all acceptance criteria are met"
  );

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAgentHandoffTool(server: McpServer): void {
  server.registerTool(
    "agent_handoff_packet",
    {
      title: "Agent Handoff Packet",
      description: `Generate a compact handoff packet so another AI agent can continue SDLC work.

Use when wrapping up a session, before handing off to a specialised agent, or when context is nearing its limit.

Args:
  - owner, repo: Repository coordinates.
  - issueNumber (number?): Issue being worked on.
  - pullNumber (number?): PR being worked on.
  - currentStatus (string): What has been done so far.
  - nextSteps (string[]?): Ordered tasks for the next agent.

Returns: Compact handoff prompt, repo context snapshot, and remaining tasks.`,
      inputSchema: AgentHandoffInputSchema,
      outputSchema: AgentHandoffOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: AgentHandoffInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleAgentHandoff(params, ref, octokit);
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

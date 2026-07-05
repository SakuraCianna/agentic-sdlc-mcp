/**
 * Tool: agent_handoff_packet
 *
 * Generates a compact handoff packet so another AI agent can continue work.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";

const AgentHandoffInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  issueNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Issue being worked on (if applicable)."),
  pullNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("PR being worked on (if applicable)."),
  currentStatus: z
    .string()
    .min(1)
    .describe("Free-text description of the current work status."),
  nextSteps: z
    .array(z.string())
    .optional()
    .describe("Ordered list of next steps for the incoming agent."),
});

type AgentHandoffInput = z.infer<typeof AgentHandoffInputSchema>;

export function registerAgentHandoffTool(server: McpServer): void {
  server.registerTool(
    "agent_handoff_packet",
    {
      title: "Agent Handoff Packet",
      description: `Generate a compact handoff packet so another AI agent can continue the current SDLC work without losing context.

Use this when wrapping up a session, before handing off to a specialised agent, or when context is nearing its limit.

Args:
  - owner, repo: Repository coordinates.
  - issueNumber (number?): Issue being worked on.
  - pullNumber (number?): PR being worked on.
  - currentStatus (string): Describe what has been done so far.
  - nextSteps (string[]?): Ordered tasks for the next agent.

Returns: A compact handoff prompt, repo context snapshot, decisions made, remaining tasks, and verification steps.`,
      inputSchema: AgentHandoffInputSchema,
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

        const { data: repoData } = await octokit.repos.get({
          owner: ref.owner,
          repo: ref.repo,
        });

        let issueContext = "";
        if (params.issueNumber) {
          try {
            const { data: issue } = await octokit.issues.get({
              owner: ref.owner,
              repo: ref.repo,
              issue_number: params.issueNumber,
            });
            issueContext =
              `\n**Issue #${issue.number}:** ${issue.title}\n**State:** ${issue.state}\n**URL:** ${issue.html_url}`;
          } catch {
            issueContext = `\n**Issue #${params.issueNumber}:** (could not fetch)`;
          }
        }

        let prContext = "";
        if (params.pullNumber) {
          try {
            const { data: pr } = await octokit.pulls.get({
              owner: ref.owner,
              repo: ref.repo,
              pull_number: params.pullNumber,
            });
            prContext =
              `\n**PR #${pr.number}:** ${pr.title}\n**State:** ${pr.state}${pr.draft ? " (draft)" : ""}\n**Branch:** \`${pr.head.ref}\` → \`${pr.base.ref}\`\n**URL:** ${pr.html_url}`;
          } catch {
            prContext = `\n**PR #${params.pullNumber}:** (could not fetch)`;
          }
        }

        const nextSteps = params.nextSteps ?? [
          "Review the current state of the issue/PR",
          "Run quality_gate_status to check CI",
          "Address any remaining review comments",
          "Ensure tests pass before proceeding",
        ];

        const handoffPrompt = [
          `You are taking over work on ${ref.owner}/${ref.repo}.`,
          ``,
          `**Current status:** ${params.currentStatus}`,
          ``,
          `**Repository:** ${repoData.full_name} (default branch: \`${repoData.default_branch}\`)`,
          issueContext,
          prContext,
          ``,
          `**Your next steps (in order):**`,
          ...nextSteps.map((s, i) => `${i + 1}. ${s}`),
          ``,
          `**Tools available:** repo_context, quality_gate_status, review_pr_against_standard, security_triage, release_readiness_check`,
          ``,
          `Start by calling \`repo_context\` to orient yourself, then proceed with the next steps above.`,
        ]
          .filter((l) => l !== null)
          .join("\n");

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
          `- **Full name:** ${repoData.full_name}`,
          `- **Default branch:** \`${repoData.default_branch}\``,
          `- **Language:** ${repoData.language ?? "unknown"}`,
          `- **Visibility:** ${repoData.visibility ?? "unknown"}`,
          issueContext ? `\n### Active Issue${issueContext}` : "",
          prContext ? `\n### Active PR${prContext}` : "",
          "",
          "## Current Status",
          "",
          params.currentStatus,
          "",
          "## Decisions Made",
          "",
          "_(The outgoing agent should document decisions here before handing off)_",
          "- No decisions recorded — update this section before handoff.",
          "",
          "## Remaining Tasks",
          "",
          ...nextSteps.map((s, i) => `${i + 1}. ${s}`),
          "",
          "## Verification Required",
          "",
          "- [ ] Run `quality_gate_status` to confirm CI is passing",
          "- [ ] Run `review_pr_against_standard` if a PR is open",
          "- [ ] Run `security_triage` if any security-related changes were made",
          "- [ ] Confirm all acceptance criteria from the original issue are met",
        ];

        return {
          content: [{ type: "text", text: lines.filter((l) => l !== null).join("\n") }],
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

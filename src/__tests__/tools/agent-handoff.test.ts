/**
 * Tests for src/tools/agent-handoff.ts
 * Covers: handleAgentHandoff structured output
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("../../config.js", () => ({
  config: {
    githubToken: "test-token",
    githubOwner: "default-owner",
    githubRepo: "default-repo",
    defaultBranch: "main",
    isSmokeMode: false,
  },
  isSmokeMode: false,
}));

const { handleAgentHandoff, AgentHandoffOutputSchema } = await import("../../tools/agent-handoff.js");

import type { AgentHandoffInput } from "../../tools/agent-handoff.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function makeMockOctokit(overrides: {
  issue?: any;
  pr?: any;
  policyContent?: string;
} = {}) {
  return {
    repos: {
      get: vi.fn().mockResolvedValue({
        data: { full_name: "test-org/test-repo", default_branch: "main" },
      }),
      getContent: vi.fn().mockImplementation(({ path }: { path: string }) => {
        if (path === ".agentic-sdlc.yml" && overrides.policyContent) {
          return Promise.resolve({ data: {
            type: "file", encoding: "base64", sha: "policy-sha",
            content: Buffer.from(overrides.policyContent).toString("base64"),
          }});
        }
        return Promise.reject({ status: 404 });
      }),
    },
    issues: {
      get: overrides.issue
        ? vi.fn().mockResolvedValue({ data: overrides.issue })
        : vi.fn().mockRejectedValue({ status: 404 }),
    },
    pulls: {
      get: overrides.pr
        ? vi.fn().mockResolvedValue({ data: overrides.pr })
        : vi.fn().mockRejectedValue({ status: 404 }),
    },
  } as unknown as Parameters<typeof handleAgentHandoff>[2];
}

describe("handleAgentHandoff", () => {
  it("carries verified policy provenance and required next actions", async () => {
    const octokit = makeMockOctokit({
      policyContent: [
        "schemaVersion: 1",
        "requiredChecks: [{ name: policy-check, source: check_run, appId: 15368 }]",
        "review:",
        "  requireIssueLink: true",
      ].join("\n"),
    });
    const { structured, text } = await handleAgentHandoff(
      { currentStatus: "Implementation complete" }, REF, octokit
    );

    expect(structured.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(structured.policySummary?.requiredChecks).toEqual([
      { name: "policy-check", source: "check_run", appId: 15368 },
    ]);
    expect(structured.nextSteps.some((step) => step.includes("policy-check"))).toBe(true);
    expect(structured.nextSteps.some((step) => /linked issue/i.test(step))).toBe(true);
    expect(text).toContain("Policy Provenance");
    expect(() => z.object(AgentHandoffOutputSchema).parse(structured)).not.toThrow();
  });

  it("returns handoff prompt with repo context", async () => {
    const octokit = makeMockOctokit();
    const params: AgentHandoffInput = {
      currentStatus: "Implemented feature X, tests passing",
      nextSteps: ["Update docs", "Create PR"],
    };

    const { structured } = await handleAgentHandoff(params, REF, octokit);

    expect(structured.repo).toBe("test-org/test-repo");
    expect(structured.defaultBranch).toBe("main");
    expect(structured.currentStatus).toBe("Implemented feature X, tests passing");
    expect(structured.nextSteps).toEqual(["Update docs", "Create PR"]);
    expect(structured.handoffPrompt).toContain("test-org/test-repo");
  });

  it("includes issue ref when issueNumber is provided", async () => {
    const octokit = makeMockOctokit({
      issue: {
        number: 5,
        title: "Add login flow",
        state: "open",
        html_url: "https://github.com/test-org/test-repo/issues/5",
      },
    });
    const params: AgentHandoffInput = {
      issueNumber: 5,
      currentStatus: "In progress",
    };

    const { structured } = await handleAgentHandoff(params, REF, octokit);

    expect(structured.issueRef).not.toBeNull();
    expect(structured.issueRef?.number).toBe(5);
    expect(structured.issueRef?.title).toBe("Add login flow");
  });

  it("includes PR ref when pullNumber is provided", async () => {
    const octokit = makeMockOctokit({
      pr: {
        number: 10,
        title: "Fix bug",
        state: "open",
        draft: false,
        head: { ref: "fix-bug" },
        base: { ref: "main" },
        html_url: "https://github.com/test-org/test-repo/pull/10",
      },
    });
    const params: AgentHandoffInput = {
      pullNumber: 10,
      currentStatus: "PR created, awaiting review",
    };

    const { structured } = await handleAgentHandoff(params, REF, octokit);

    expect(structured.prRef).not.toBeNull();
    expect(structured.prRef?.number).toBe(10);
    expect(structured.prRef?.title).toBe("Fix bug");
    expect(structured.prRef?.branch).toBe("fix-bug -> main");
  });

  it("uses default next steps when not provided", async () => {
    const octokit = makeMockOctokit();
    const params: AgentHandoffInput = {
      currentStatus: "Feature complete",
    };

    const { structured } = await handleAgentHandoff(params, REF, octokit);

    expect(structured.nextSteps.length).toBeGreaterThan(0);
    expect(structured.nextSteps[0]).toContain("Review");
  });
});

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

interface HandoffIssueFixture {
  number: number;
  title: string;
  state: string;
  html_url: string;
}

interface HandoffPrFixture {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  head: { ref: string };
  base: { ref: string; sha?: string };
  html_url: string;
}

function makeMockOctokit(overrides: {
  issue?: HandoffIssueFixture;
  pr?: HandoffPrFixture;
  policyContent?: string;
  repo?: Partial<{ full_name: string; default_branch: string; language: string | null; visibility: string }>;
} = {}) {
  return {
    repos: {
      get: vi.fn().mockResolvedValue({
        data: { full_name: "test-org/test-repo", default_branch: "main", ...overrides.repo },
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

  it("reports requested issue and PR evidence failures instead of silently dropping them", async () => {
    const { structured, text } = await handleAgentHandoff(
      { issueNumber: 404, pullNumber: 405, currentStatus: "Waiting for evidence" },
      REF,
      makeMockOctokit()
    );

    expect(structured.issueRef).toBeNull();
    expect(structured.prRef).toBeNull();
    expect(structured.evidenceWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/issue #404.*unavailable/i),
      expect.stringMatching(/pull request #405.*unavailable/i),
    ]));
    expect(text).toContain("Evidence Warnings");
    expect(structured.policySummary).toBeUndefined();
    expect(structured.policyDigest).toBeUndefined();
  });

  it("loads PR policy from the base SHA and adds release obligations once", async () => {
    const octokit = makeMockOctokit({
      pr: {
        number: 10,
        title: "Release candidate",
        state: "open",
        draft: true,
        head: { ref: "release" },
        base: { ref: "main", sha: "immutable-base-sha" },
        html_url: "https://github.com/test-org/test-repo/pull/10",
      },
      policyContent: [
        "schemaVersion: 1",
        "release:",
        "  requireChangelog: true",
        "  requireRollbackPlan: true",
      ].join("\n"),
    });

    const { structured } = await handleAgentHandoff(
      { pullNumber: 10, currentStatus: "Ready" },
      REF,
      octokit
    );

    expect(structured.prRef?.state).toBe("open (draft)");
    expect(structured.nextSteps.filter((step) => /CHANGELOG/.test(step))).toHaveLength(1);
    expect(structured.nextSteps.filter((step) => /rollback-plan/.test(step))).toHaveLength(1);
    expect((octokit as unknown as { repos: { getContent: ReturnType<typeof vi.fn> } }).repos.getContent)
      .toHaveBeenCalledWith(expect.objectContaining({ ref: "immutable-base-sha" }));
  });

  it("bounds and escapes untrusted handoff values while preserving structured evidence", async () => {
    const malicious = "Status\n## forged [click](javascript:alert(1)) " + "x".repeat(600);
    const { structured, text } = await handleAgentHandoff(
      {
        issueNumber: 5,
        currentStatus: malicious,
        nextSteps: [malicious],
      },
      REF,
      makeMockOctokit({
        issue: {
          number: 5,
          title: malicious,
          state: "open",
          html_url: "https://github.com/test-org/test-repo/issues/5",
        },
      })
    );

    expect(structured.currentStatus).toBe(malicious);
    expect(structured.issueRef?.title).toBe(malicious);
    expect(structured.handoffPrompt).toContain("untrusted handoff evidence");
    expect(text).not.toContain("\n## forged");
    expect(text).not.toContain("[click](javascript:");
    expect(text.length).toBeLessThan(10_000);
  });
});

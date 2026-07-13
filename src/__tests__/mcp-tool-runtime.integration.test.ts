import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectInMemoryMcp, type ConnectedMcpFixture } from "./fixtures/mcp-client.js";

const github = vi.hoisted(() => ({
  issuesGet: vi.fn(),
  commentsList: vi.fn(),
  pullsList: vi.fn(),
  pullsListFiles: vi.fn(),
  reposGet: vi.fn(),
  reposGetContent: vi.fn(),
}));

vi.mock("../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => ({
      issues: { get: github.issuesGet, listComments: github.commentsList },
      pulls: { list: github.pullsList, listFiles: github.pullsListFiles },
      repos: { get: github.reposGet, getContent: github.reposGetContent },
    }),
  };
});

const { createAgenticSdlcServer } = await import("../server.js");

describe("real MCP tool-call runtime", () => {
  let fixture: ConnectedMcpFixture;

  beforeEach(async () => {
    github.issuesGet.mockReset().mockResolvedValue({
      data: {
        number: 42,
        title: "Harden authentication",
        state: "open",
        html_url: "https://github.com/example/project/issues/42",
        body: "Update src/auth/session.ts",
        labels: [{ name: "security" }],
        assignees: [{ login: "alice" }],
        created_at: "2026-07-13T00:00:00Z",
      },
    });
    github.commentsList.mockReset().mockResolvedValue({ data: [] });
    github.pullsList.mockReset().mockResolvedValue({ data: [] });
    github.pullsListFiles.mockReset().mockResolvedValue({ data: [] });
    github.reposGet.mockReset().mockResolvedValue({
      data: {
        name: "project",
        full_name: "example/project",
        description: "Agent-aware repository",
        default_branch: "trunk",
        visibility: "private",
        language: "TypeScript",
        stargazers_count: 3,
        open_issues_count: 2,
        topics: ["mcp"],
        pushed_at: "2026-07-13T00:00:00Z",
      },
    });
    github.reposGetContent.mockReset().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
    fixture = await connectInMemoryMcp(createAgenticSdlcServer);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("applies input defaults and validates structured output across the protocol", async () => {
    const result = await fixture.client.callTool({
      name: "prepare_work_item",
      arguments: { owner: "example", repo: "project", issueNumber: 42 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      issueNumber: 42,
      title: "Harden authentication",
      labels: ["security"],
      assignees: ["@alice"],
      relatedFileHints: [],
      recentPRs: [],
      workType: "security",
      riskProfile: {
        level: "high",
        confidence: expect.any(String),
      },
      sourceEvidence: expect.arrayContaining([
        expect.objectContaining({ kind: "issue", ref: "#42", verified: true }),
        expect.objectContaining({ kind: "repository", ref: "trunk", verified: true }),
      ]),
      verificationCommands: [],
    });
    expect(result.structuredContent).toHaveProperty(
      "handoffPrompt",
      expect.not.stringContaining("Harden authentication")
    );
    expect(github.pullsList).not.toHaveBeenCalled();
  });

  it("rejects invalid input before any GitHub handler call", async () => {
    const result = await fixture.client.callTool({
      name: "prepare_work_item",
      arguments: { owner: "example", repo: "project", issueNumber: 0 },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("issueNumber");
    expect(github.issuesGet).not.toHaveBeenCalled();
  });

  it("returns a safe MCP error result for a GitHub permission failure", async () => {
    github.issuesGet.mockRejectedValueOnce(
      Object.assign(new Error("sensitive upstream body"), { status: 403 })
    );

    const result = await fixture.client.callTool({
      name: "prepare_work_item",
      arguments: { owner: "example", repo: "project", issueNumber: 42 },
    });

    expect(result.isError).toBe(true);
    const rendered = JSON.stringify(result.content);
    expect(rendered).toMatch(/permission denied/i);
    expect(rendered).not.toContain("sensitive upstream body");
  });

  it("observes repository policy at the live default branch across the MCP boundary", async () => {
    const policy = [
      "schemaVersion: 1",
      "defaultWorkType: security",
      "requiredChecks:",
      "  - name: verify",
      "    source: check_run",
      "    appId: 15368",
      "protectedPaths: ['src/security/**']",
    ].join("\n");
    github.reposGetContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(policy).toString("base64"),
        sha: "policy-blob-sha",
      },
    });

    const result = await fixture.client.callTool({
      name: "repo_context",
      arguments: {
        owner: "example",
        repo: "project",
        includeReadme: false,
        includePolicy: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      fullName: "example/project",
      defaultBranch: "trunk",
      policy: {
        found: true,
        degraded: false,
        defaultWorkType: "security",
        requiredChecks: [{ name: "verify", source: "check_run", appId: 15368 }],
        protectedPaths: ["src/security/**"],
      },
      policySources: [
        expect.objectContaining({ kind: "default" }),
        expect.objectContaining({
          kind: "repository",
          path: ".agentic-sdlc.yml",
          ref: "trunk",
          blobSha: "policy-blob-sha",
        }),
      ],
    });
    expect(result.structuredContent).toHaveProperty(
      "policyDigest",
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    expect(github.reposGetContent).toHaveBeenCalledWith({
      owner: "example",
      repo: "project",
      path: ".agentic-sdlc.yml",
      ref: "trunk",
    });
  });
});

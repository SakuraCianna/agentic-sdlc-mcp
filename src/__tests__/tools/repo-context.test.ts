/**
 * Tests for src/tools/repo-context.ts
 * Covers: repo_context tool registration and structured output
 */

import { describe, it, expect, vi } from "vitest";

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

// Mock the context fetcher
vi.mock("../../github/context.js", () => ({
  fetchRepoContext: vi.fn().mockResolvedValue({
    name: "test-repo",
    fullName: "test-org/test-repo",
    description: "Test repository",
    defaultBranch: "main",
    visibility: "public",
    language: "TypeScript",
    stargazersCount: 10,
    openIssuesCount: 2,
    topics: ["typescript", "mcp"],
    pushedAt: "2026-01-01T00:00:00Z",
  }),
  summarizePackageJson: vi.fn().mockReturnValue("name: test-repo\nversion: 1.0.0"),
}));

const { registerRepoContextTool } = await import("../../tools/repo-context.js");
const { fetchRepoContext } = await import("../../github/context.js");

describe("registerRepoContextTool", () => {
  it("registers without error", () => {
    const mockServer = {
      registerTool: vi.fn(),
    };

    registerRepoContextTool(mockServer as any);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      "repo_context",
      expect.objectContaining({
        title: "Get Repository Context",
        inputSchema: expect.anything(),
        outputSchema: expect.anything(),
      }),
      expect.any(Function)
    );
  });

  it("passes issueLimit and prLimit through to fetchRepoContext", async () => {
    let handler: (params: any) => Promise<unknown> = async () => undefined;
    const mockServer = {
      registerTool: vi.fn((_name: string, _config: unknown, fn: (params: any) => Promise<unknown>) => {
        handler = fn;
      }),
    };

    registerRepoContextTool(mockServer as any);
    (fetchRepoContext as ReturnType<typeof vi.fn>).mockClear();

    await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: true,
      includePackageJson: false,
      includeOpenIssues: true,
      includeOpenPRs: true,
      issueLimit: 5,
      prLimit: 50,
    });

    expect(fetchRepoContext).toHaveBeenCalledWith(
      expect.objectContaining({ issueLimit: 5, prLimit: 50 })
    );
  });

  it("passes includeWorkflows/includeAgentInstructions/includeGovernance through to fetchRepoContext", async () => {
    let handler: (params: any) => Promise<unknown> = async () => undefined;
    const mockServer = {
      registerTool: vi.fn((_name: string, _config: unknown, fn: (params: any) => Promise<unknown>) => {
        handler = fn;
      }),
    };

    registerRepoContextTool(mockServer as any);
    (fetchRepoContext as ReturnType<typeof vi.fn>).mockClear();

    await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: false,
      includePackageJson: true,
      includeWorkflows: true,
      includeAgentInstructions: true,
      includeGovernance: true,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    expect(fetchRepoContext).toHaveBeenCalledWith(
      expect.objectContaining({
        includeWorkflows: true,
        includeAgentInstructions: true,
        includeGovernance: true,
      })
    );
  });

  it("includes packageManager/techStack/scripts/workflows/governance/agentInstructions in structuredContent when present", async () => {
    let handler: (params: any) => Promise<any> = async () => undefined;
    const mockServer = {
      registerTool: vi.fn((_name: string, _config: unknown, fn: (params: any) => Promise<any>) => {
        handler = fn;
      }),
    };

    registerRepoContextTool(mockServer as any);
    (fetchRepoContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test-repo",
      fullName: "test-org/test-repo",
      description: "Test repository",
      defaultBranch: "main",
      visibility: "public",
      language: "TypeScript",
      stargazersCount: 10,
      openIssuesCount: 2,
      topics: ["typescript", "mcp"],
      pushedAt: "2026-01-01T00:00:00Z",
      packageManager: "npm",
      techStack: ["TypeScript", "Vitest"],
      scripts: { build: "tsc", test: "vitest run" },
      workflows: ["ci.yml"],
      governance: { codeownersFound: true },
      agentInstructions: [{ path: "CLAUDE.md", summary: "Use PowerShell." }],
    });

    const result = await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: true,
      includePackageJson: true,
      includeWorkflows: true,
      includeAgentInstructions: true,
      includeGovernance: true,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    expect(result.structuredContent).toMatchObject({
      packageManager: "npm",
      techStack: ["TypeScript", "Vitest"],
      scripts: { build: "tsc", test: "vitest run" },
      workflows: ["ci.yml"],
      governance: { codeownersFound: true },
      agentInstructions: [{ path: "CLAUDE.md", summary: "Use PowerShell." }],
    });
    expect(result.content[0].text).toContain("Package manager:** npm");
    expect(result.content[0].text).toContain("CLAUDE.md");
  });

  it("omits the new optional fields from structuredContent when not requested", async () => {
    let handler: (params: any) => Promise<any> = async () => undefined;
    const mockServer = {
      registerTool: vi.fn((_name: string, _config: unknown, fn: (params: any) => Promise<any>) => {
        handler = fn;
      }),
    };

    registerRepoContextTool(mockServer as any);
    (fetchRepoContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test-repo",
      fullName: "test-org/test-repo",
      description: "Test repository",
      defaultBranch: "main",
      visibility: "public",
      language: "TypeScript",
      stargazersCount: 10,
      openIssuesCount: 2,
      topics: [],
      pushedAt: "2026-01-01T00:00:00Z",
    });

    const result = await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: true,
      includePackageJson: false,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    expect(result.structuredContent.packageManager).toBeUndefined();
    expect(result.structuredContent.workflows).toBeUndefined();
    expect(result.structuredContent.governance).toBeUndefined();
    expect(result.structuredContent.agentInstructions).toBeUndefined();
  });
});

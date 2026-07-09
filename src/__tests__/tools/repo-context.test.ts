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
vi.mock("../../github/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/context.js")>();
  return {
    ...actual,
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
    summarizePackageJson: vi.fn((pkg: Record<string, unknown>) =>
      typeof pkg["_raw"] === "string"
        ? "(package.json could not be parsed)"
        : "name: test-repo\nversion: 1.0.0"
    ),
  };
});

const { registerRepoContextTool } = await import("../../tools/repo-context.js");
const { extractCommonScripts, fetchRepoContext } = await import("../../github/context.js");

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
      readme: "# Test repository\n\nInstall with npm.",
      packageJson: {
        name: "test-repo",
        version: "1.0.0",
      },
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
      readmeSummary: "# Test repository\n\nInstall with npm.",
      packageJsonSummary: "name: test-repo\nversion: 1.0.0",
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

  it("declares README and package.json summaries in outputSchema and returns them through the registered handler", async () => {
    let handler: (params: any) => Promise<any> = async () => undefined;
    let outputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {};
    const mockServer = {
      registerTool: vi.fn(
        (
          _name: string,
          config: { outputSchema: typeof outputSchema },
          fn: (params: any) => Promise<any>
        ) => {
          outputSchema = config.outputSchema;
          handler = fn;
        }
      ),
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
      readme: "# Setup\n\nRun npm install.",
      packageJson: { name: "test-repo", version: "1.0.0" },
      packageManager: "npm",
      techStack: [],
      scripts: {},
    });

    const result = await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: true,
      includePackageJson: true,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    expect(outputSchema.readmeSummary.safeParse(result.structuredContent.readmeSummary).success).toBe(true);
    expect(
      outputSchema.packageJsonSummary.safeParse(result.structuredContent.packageJsonSummary).success
    ).toBe(true);
    expect(result.structuredContent.readmeSummary).toContain("Run npm install");
    expect(result.structuredContent.packageJsonSummary).toContain("name: test-repo");
  });

  it("keeps oversized scripts bounded in both structured content and markdown", async () => {
    let handler: (params: any) => Promise<any> = async () => undefined;
    const mockServer = {
      registerTool: vi.fn((_name: string, _config: unknown, fn: (params: any) => Promise<any>) => {
        handler = fn;
      }),
    };
    const scripts = extractCommonScripts({
      scripts: {
        build: "b".repeat(50_000),
        test: "t".repeat(50_000),
        typecheck: "y".repeat(50_000),
        lint: "l".repeat(50_000),
        smoke: "s".repeat(50_000),
      },
    });

    registerRepoContextTool(mockServer as any);
    (fetchRepoContext as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test-repo",
      fullName: "test-org/test-repo",
      description: null,
      defaultBranch: "main",
      visibility: "public",
      language: "TypeScript",
      stargazersCount: 0,
      openIssuesCount: 0,
      topics: [],
      pushedAt: null,
      packageJson: { name: "test-repo" },
      packageManager: "npm",
      techStack: ["TypeScript"],
      scripts,
    });

    const result = await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: false,
      includePackageJson: true,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    const structuredScriptChars = Object.values(
      result.structuredContent.scripts as Record<string, string>
    ).reduce((total: number, command: string) => total + command.length, 0);
    expect(structuredScriptChars).toBeLessThanOrEqual(1_200);
    expect(result.content[0].text.length).toBeLessThan(3_000);
    expect(result.content[0].text).toContain("...(truncated)");
  });

  it("returns explicit degraded summaries when requested files are unavailable or unparseable", async () => {
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
      description: null,
      defaultBranch: "main",
      visibility: "public",
      language: null,
      stargazersCount: 0,
      openIssuesCount: 0,
      topics: [],
      pushedAt: null,
      readme: "(README not found or inaccessible)",
      packageJson: { _raw: "{ invalid json" },
      packageManager: "unknown",
      techStack: [],
      scripts: {},
    });

    const result = await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: true,
      includePackageJson: true,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.readmeSummary).toMatch(/not found|inaccessible/i);
    expect(result.structuredContent.packageJsonSummary).toMatch(/could not be parsed/i);
    expect(result.content[0].text).toContain("## package.json Summary");
    expect(result.content[0].text).toMatch(/could not be parsed/i);
  });

  it("shows a degraded package.json summary in markdown when the requested file is missing", async () => {
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
      description: null,
      defaultBranch: "main",
      visibility: "public",
      language: null,
      stargazersCount: 0,
      openIssuesCount: 0,
      topics: [],
      pushedAt: null,
      packageManager: "unknown",
      techStack: [],
      scripts: {},
    });

    const result = await handler({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: false,
      includePackageJson: true,
      includeOpenIssues: false,
      includeOpenPRs: false,
      issueLimit: 20,
      prLimit: 20,
      maxReadmeChars: 3000,
      maxInstructionChars: 1000,
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.packageJsonSummary).toMatch(
      /package\.json not found|inaccessible/i
    );
    expect(result.content[0].text).toContain("## package.json Summary");
    expect(result.content[0].text).toMatch(/package\.json not found|inaccessible/i);
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
    expect(result.structuredContent.packageJsonSummary).toBeUndefined();
    expect(result.structuredContent.workflows).toBeUndefined();
    expect(result.structuredContent.governance).toBeUndefined();
    expect(result.structuredContent.agentInstructions).toBeUndefined();
  });
});

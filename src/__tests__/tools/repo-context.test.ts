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
});

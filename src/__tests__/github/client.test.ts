/**
 * Tests for src/github/client.ts
 * Covers: resolveRepo, handleGitHubError
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// We need to mock the config module before importing client
// ---------------------------------------------------------------------------
vi.mock("../../config.js", () => ({
  config: {
    githubToken: "test-token",
    githubOwner: "default-owner",
    githubRepo: "default-repo",
    defaultBranch: "main",
  },
}));

// Import AFTER mocking
const { resolveRepo, handleGitHubError } = await import("../../github/client.js");

// ---------------------------------------------------------------------------
// resolveRepo
// ---------------------------------------------------------------------------

describe("resolveRepo", () => {
  it("uses provided owner and repo when both are given", () => {
    const result = resolveRepo("explicit-owner", "explicit-repo");
    expect(result).toEqual({ owner: "explicit-owner", repo: "explicit-repo" });
  });

  it("falls back to config.githubOwner when owner is undefined", () => {
    const result = resolveRepo(undefined, "my-repo");
    expect(result).toEqual({ owner: "default-owner", repo: "my-repo" });
  });

  it("falls back to config.githubRepo when repo is undefined", () => {
    const result = resolveRepo("my-owner", undefined);
    expect(result).toEqual({ owner: "my-owner", repo: "default-repo" });
  });

  it("falls back to both config defaults when both are undefined", () => {
    const result = resolveRepo(undefined, undefined);
    expect(result).toEqual({ owner: "default-owner", repo: "default-repo" });
  });

  it("throws when owner cannot be resolved", async () => {
    // Override config mock to have no owner
    vi.resetModules();
    vi.doMock("../../config.js", () => ({
      config: {
        githubToken: "test-token",
        githubOwner: undefined,
        githubRepo: "default-repo",
        defaultBranch: "main",
      },
    }));
    const { resolveRepo: resolveRepoNoOwner } = await import("../../github/client.js");
    expect(() => resolveRepoNoOwner(undefined, "my-repo")).toThrow(
      /owner is required/
    );
    vi.resetModules();
  });

  it("throws when repo cannot be resolved", async () => {
    vi.doMock("../../config.js", () => ({
      config: {
        githubToken: "test-token",
        githubOwner: "default-owner",
        githubRepo: undefined,
        defaultBranch: "main",
      },
    }));
    const { resolveRepo: resolveRepoNoRepo } = await import("../../github/client.js");
    expect(() => resolveRepoNoRepo("my-owner", undefined)).toThrow(
      /repo is required/
    );
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// handleGitHubError
// ---------------------------------------------------------------------------

describe("handleGitHubError", () => {
  it("returns 401 message for authentication failure", () => {
    const err = { status: 401, response: { data: { message: "Bad credentials" } } };
    expect(handleGitHubError(err)).toMatch(/authentication failed/i);
  });

  it("returns 403 message with scope hint", () => {
    const err = { status: 403, response: { data: { message: "Resource not accessible" } } };
    const result = handleGitHubError(err);
    expect(result).toMatch(/permission denied/i);
    expect(result).toMatch(/scope/i);
  });

  it("returns 404 message with verification hint", () => {
    const err = { status: 404, response: { data: { message: "Not Found" } } };
    const result = handleGitHubError(err);
    expect(result).toMatch(/not found/i);
    expect(result).toMatch(/Verify/i);
  });

  it("returns 429 rate limit message", () => {
    const err = { status: 429, response: { data: {} } };
    expect(handleGitHubError(err)).toMatch(/rate limit/i);
  });

  it("returns generic API error for unknown status", () => {
    const err = { status: 500, response: { data: { message: "Internal Server Error" } } };
    const result = handleGitHubError(err);
    expect(result).toMatch(/500/);
  });

  it("handles plain Error objects", () => {
    expect(handleGitHubError(new Error("network timeout"))).toMatch(/network timeout/);
  });

  it("handles non-Error, non-octokit values", () => {
    expect(handleGitHubError("some string")).toMatch(/some string/);
    expect(handleGitHubError(null)).toMatch(/Unexpected error/);
  });
});

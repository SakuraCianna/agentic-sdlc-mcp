import { describe, expect, it, vi } from "vitest";

import {
  createRepositoryPolicyCache,
  loadRepositoryPolicy,
} from "../../policy/repository-policy-loader.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

function fileResponse(content: string, sha = "policy-blob-sha") {
  return {
    data: {
      type: "file",
      encoding: "base64",
      content: Buffer.from(content).toString("base64"),
      sha,
    },
  };
}

function octokitWith(response: unknown) {
  return {
    repos: {
      getContent:
        response instanceof Error || (typeof response === "object" && response && "status" in response)
          ? vi.fn().mockRejectedValue(response)
          : vi.fn().mockResolvedValue(response),
    },
  } as unknown as Parameters<typeof loadRepositoryPolicy>[2];
}

describe("loadRepositoryPolicy", () => {
  it("loads a valid policy at the exact ref with source SHA and digest", async () => {
    const octokit = octokitWith(
      fileResponse("schemaVersion: 1\nrequiredChecks: [{ name: test, source: check_run, appId: 15368 }]\n")
    );

    const result = await loadRepositoryPolicy(REF, "base-sha", octokit);

    expect(result).toMatchObject({
      found: true,
      degraded: false,
      policy: { requiredChecks: [{ name: "test", source: "check_run", appId: 15368 }] },
      errors: [],
    });
    expect(result.policySources).toEqual([
      expect.objectContaining({ kind: "default" }),
      expect.objectContaining({
        kind: "repository",
        path: ".agentic-sdlc.yml",
        ref: "base-sha",
        blobSha: "policy-blob-sha",
        digest: result.digest,
      }),
    ]);
    expect(octokit.repos.getContent).toHaveBeenCalledWith({
      owner: "test-org",
      repo: "test-repo",
      path: ".agentic-sdlc.yml",
      ref: "base-sha",
    });
  });

  it("treats a missing policy as compatible defaults without degradation", async () => {
    const octokit = octokitWith({ status: 404 });

    const result = await loadRepositoryPolicy(REF, "main", octokit);

    expect(result).toMatchObject({
      found: false,
      degraded: false,
      errors: [],
      appliedRules: [],
    });
    expect(result.policySources).toHaveLength(1);
    expect(result.policySources[0]).toMatchObject({ kind: "default", ref: null });
  });

  it.each([
    ["permission failure", { status: 403 }],
    ["rate limit", { status: 429 }],
    ["directory response", { data: [{ type: "file", name: "unexpected" }] }],
    ["missing content", { data: { type: "file", content: "", sha: "sha" } }],
    ["invalid policy", fileResponse("schemaVersion: 1\nautoMerge: true\n")],
  ])("fails closed for %s", async (_name, response) => {
    const result = await loadRepositoryPolicy(REF, "main", octokitWith(response));

    expect(result.degraded).toBe(true);
    expect(result.errors).not.toHaveLength(0);
    expect(result.appliedRules).toEqual([]);
    expect(result.policySources[0]).toMatchObject({ kind: "default" });
  });

  it("caches one exact repo/ref lookup within a request", async () => {
    const octokit = octokitWith(fileResponse("schemaVersion: 1\n"));
    const cache = createRepositoryPolicyCache();

    const first = await loadRepositoryPolicy(REF, "base-sha", octokit, cache);
    const second = await loadRepositoryPolicy(REF, "base-sha", octokit, cache);
    await loadRepositoryPolicy(REF, "other-sha", octokit, cache);

    expect(first).toEqual(second);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(2);
  });
});

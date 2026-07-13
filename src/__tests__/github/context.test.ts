/**
 * Tests for src/github/context.ts
 * Covers: fetchRepoContext issueLimit/prLimit pass-through, summarizePackageJson,
 * and the repo_context briefing-packet helpers (packageManager, techStack,
 * scripts, workflows, governance, agentInstructions).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

const listForRepo = vi.fn().mockResolvedValue({ data: [] });
const pullsList = vi.fn().mockResolvedValue({ data: [] });
const getContent = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
const getReadme = vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

vi.mock("../../github/client.js", () => ({
  getOctokit: () => ({
    repos: {
      get: vi.fn().mockResolvedValue({
        data: {
          name: "test-repo",
          full_name: "test-org/test-repo",
          description: "desc",
          default_branch: "main",
          visibility: "public",
          language: "TypeScript",
          stargazers_count: 1,
          open_issues_count: 1,
          topics: [],
          pushed_at: "2026-01-01T00:00:00Z",
        },
      }),
      getContent,
      getReadme,
    },
    issues: { listForRepo },
    pulls: { list: pullsList },
  }),
}));

const {
  fetchRepoContext,
  summarizePackageJson,
  identifyPackageManagerFromField,
  detectTechStack,
  extractCommonScripts,
} = await import("../../github/context.js");

describe("fetchRepoContext", () => {
  beforeEach(() => {
    listForRepo.mockClear().mockResolvedValue({ data: [] });
    pullsList.mockClear().mockResolvedValue({ data: [] });
    getContent.mockReset().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
    getReadme.mockReset().mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));
  });

  it("uses default per_page of 20 when issueLimit/prLimit are not provided", async () => {
    await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeOpenIssues: true,
      includeOpenPRs: true,
    });

    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 20 })
    );
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 20 })
    );
  });

  it("passes issueLimit and prLimit through as per_page", async () => {
    await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeOpenIssues: true,
      includeOpenPRs: true,
      issueLimit: 5,
      prLimit: 100,
    });

    expect(listForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 5 })
    );
    expect(pullsList).toHaveBeenCalledWith(
      expect.objectContaining({ per_page: 100 })
    );
  });

  it("does not call listForRepo/pulls.list when the flags are off", async () => {
    listForRepo.mockClear();
    pullsList.mockClear();

    await fetchRepoContext({ owner: "test-org", repo: "test-repo" });

    expect(listForRepo).not.toHaveBeenCalled();
    expect(pullsList).not.toHaveBeenCalled();
  });

  it("degrades gracefully when package.json, workflows, CODEOWNERS, and agent instructions are all missing", async () => {
    getContent.mockRejectedValue(Object.assign(new Error("Not Found"), { status: 404 }));

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includePackageJson: true,
      includeWorkflows: true,
      includeGovernance: true,
      includeAgentInstructions: true,
    });

    expect(ctx.packageJson).toBeUndefined();
    expect(ctx.packageManager).toBe("unknown");
    expect(ctx.techStack).toEqual([]);
    expect(ctx.scripts).toEqual({});
    expect(ctx.workflows).toEqual([]);
    expect(ctx.governance).toEqual({ codeownersFound: false });
    expect(ctx.agentInstructions).toEqual([]);
  });

  it("does not populate optional fields when their include flags are off", async () => {
    const ctx = await fetchRepoContext({ owner: "test-org", repo: "test-repo" });

    expect(ctx.packageManager).toBeUndefined();
    expect(ctx.techStack).toBeUndefined();
    expect(ctx.scripts).toBeUndefined();
    expect(ctx.workflows).toBeUndefined();
    expect(ctx.governance).toBeUndefined();
    expect(ctx.agentInstructions).toBeUndefined();
  });

  it("does not call getContent/getReadme at all when every optional include flag is off (default call path stays cheap)", async () => {
    await fetchRepoContext({ owner: "test-org", repo: "test-repo" });

    expect(getContent).not.toHaveBeenCalled();
    expect(getReadme).not.toHaveBeenCalled();
  });

  it("loads an additive repository policy summary from the exact default branch", async () => {
    const source = [
      "schemaVersion: 1",
      "defaultWorkType: security",
      "requiredChecks:",
      "  - { name: policy-check, source: check_run, appId: 15368 }",
      "protectedPaths:",
      "  - src/auth/**",
    ].join("\n");
    getContent.mockResolvedValueOnce({
      data: {
        type: "file",
        encoding: "base64",
        content: Buffer.from(source).toString("base64"),
        sha: "policy-blob-sha",
      },
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includePolicy: true,
    });

    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".agentic-sdlc.yml", ref: "main" })
    );
    expect(ctx.policy).toMatchObject({
      found: true,
      degraded: false,
      schemaVersion: 1,
      defaultWorkType: "security",
      requiredChecks: [{ name: "policy-check", source: "check_run", appId: 15368 }],
      protectedPaths: ["src/auth/**"],
    });
    expect(ctx.policySources?.at(-1)).toMatchObject({
      kind: "repository",
      ref: "main",
      blobSha: "policy-blob-sha",
    });
    expect(ctx.policyDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("calls getContent exactly once for governance when includeGovernance is on and CODEOWNERS exists at the first candidate path", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === ".github/CODEOWNERS") return { data: "* @someone" };
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    await fetchRepoContext({ owner: "test-org", repo: "test-repo", includeGovernance: true });

    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("does not call getContent for workflows/governance/agentInstructions when their flags are off but includePackageJson is on", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "package.json") {
        return { data: JSON.stringify({ name: "x", packageManager: "npm@10.0.0" }) };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    await fetchRepoContext({ owner: "test-org", repo: "test-repo", includePackageJson: true });

    // Only package.json should have been fetched -- workflows/CODEOWNERS/agent
    // instructions must not be probed just because includePackageJson is on.
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent).toHaveBeenCalledWith(expect.objectContaining({ path: "package.json" }));
  });

  it("reads packageManager from the package.json field when present, without probing lock files", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "package.json") {
        return {
          data: JSON.stringify({ name: "x", packageManager: "pnpm@9.0.0", scripts: {}, dependencies: {} }),
        };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includePackageJson: true,
    });

    expect(ctx.packageManager).toBe("pnpm");
    // Only package.json should have been fetched -- no lock-file probing needed.
    expect(getContent).toHaveBeenCalledTimes(1);
  });

  it("falls back to lock-file probing when package.json has no packageManager field", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "package.json") {
        return { data: JSON.stringify({ name: "x", scripts: {}, dependencies: {} }) };
      }
      if (path === "pnpm-lock.yaml") {
        return { data: "lockfileVersion: 6" };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includePackageJson: true,
    });

    expect(ctx.packageManager).toBe("pnpm");
  });

  it("lists workflow file names, filtering out non-yaml entries", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === ".github/workflows") {
        return {
          data: [
            { type: "file", name: "ci.yml" },
            { type: "file", name: "publish.yaml" },
            { type: "file", name: "README.md" },
            { type: "dir", name: "nested" },
          ],
        };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeWorkflows: true,
    });

    expect(ctx.workflows).toEqual(["ci.yml", "publish.yaml"]);
  });

  it("reports codeownersFound true when a CODEOWNERS file exists at a conventional path", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === ".github/CODEOWNERS") {
        return { data: "* @someone" };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeGovernance: true,
    });

    expect(ctx.governance).toEqual({ codeownersFound: true });
  });

  it("fetches and truncates agent instruction file summaries", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "AGENTS.md") {
        return { data: "x".repeat(50) };
      }
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeAgentInstructions: true,
      maxInstructionChars: 10,
    });

    expect(ctx.agentInstructions).toHaveLength(1);
    expect(ctx.agentInstructions?.[0]?.path).toBe("AGENTS.md");
    expect(ctx.agentInstructions?.[0]?.summary).toContain("...(truncated)");
    expect(ctx.agentInstructions?.[0]?.summary.length).toBeLessThan(50);
  });

  it("respects maxReadmeChars for truncation", async () => {
    getReadme.mockResolvedValue({ data: "x".repeat(100) });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includeReadme: true,
      maxReadmeChars: 50,
    });

    expect(ctx.readme).toContain("...(truncated)");
    expect(ctx.readme?.length).toBeLessThan(100);
  });

  it("degrades gracefully when package.json contains invalid JSON", async () => {
    getContent.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "package.json") return { data: "{ invalid json" };
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });

    const ctx = await fetchRepoContext({
      owner: "test-org",
      repo: "test-repo",
      includePackageJson: true,
    });

    expect(ctx.packageJson).toEqual({ _raw: "{ invalid json" });
    expect(summarizePackageJson(ctx.packageJson!)).toMatch(/could not be parsed/i);
    expect(ctx.techStack).toEqual([]);
    expect(ctx.scripts).toEqual({});
  });

  it.each(["null", "\"text\"", "42", "true", "[]"])(
    "degrades gracefully when package.json is valid JSON but not an object: %s",
    async (raw) => {
      getContent.mockImplementation(async ({ path }: { path: string }) => {
        if (path === "package.json") return { data: raw };
        throw Object.assign(new Error("Not Found"), { status: 404 });
      });

      const ctx = await fetchRepoContext({
        owner: "test-org",
        repo: "test-repo",
        includePackageJson: true,
      });

      expect(summarizePackageJson(ctx.packageJson!)).toMatch(/could not be parsed as a JSON object/i);
      expect(ctx.techStack).toEqual([]);
      expect(ctx.scripts).toEqual({});
    }
  );
});

describe("identifyPackageManagerFromField", () => {
  it("returns null when packageManager field is absent", () => {
    expect(identifyPackageManagerFromField({})).toBeNull();
    expect(identifyPackageManagerFromField(undefined)).toBeNull();
  });

  it("parses a corepack-style packageManager field", () => {
    expect(identifyPackageManagerFromField({ packageManager: "npm@10.2.4" })).toBe("npm");
    expect(identifyPackageManagerFromField({ packageManager: "yarn@4.1.0" })).toBe("yarn");
  });

  it("returns null for an unrecognised manager name", () => {
    expect(identifyPackageManagerFromField({ packageManager: "cargo@1.0.0" })).toBeNull();
  });
});

describe("detectTechStack", () => {
  it("returns an empty array when pkg is undefined", () => {
    expect(detectTechStack(undefined)).toEqual([]);
  });

  it("detects known technologies from dependencies and devDependencies", () => {
    const stack = detectTechStack({
      dependencies: { express: "^5.0.0", zod: "^4.0.0" },
      devDependencies: { typescript: "^6.0.0", vitest: "^4.0.0" },
    });
    expect(stack).toEqual(expect.arrayContaining(["Express", "Zod", "TypeScript", "Vitest"]));
  });

  it("ignores unrecognised dependency names", () => {
    const stack = detectTechStack({ dependencies: { "some-random-lib": "^1.0.0" } });
    expect(stack).toEqual([]);
  });
});

describe("extractCommonScripts", () => {
  it("returns an empty object when scripts is absent", () => {
    expect(extractCommonScripts({})).toEqual({});
    expect(extractCommonScripts(undefined)).toEqual({});
  });

  it("extracts only known common script names", () => {
    const scripts = extractCommonScripts({
      scripts: { build: "tsc", test: "vitest run", "custom:thing": "echo hi" },
    });
    expect(scripts).toEqual({ build: "tsc", test: "vitest run" });
  });

  it("bounds an oversized script command and marks truncation", () => {
    const scripts = extractCommonScripts({
      scripts: { build: `node -e "${"x".repeat(50_000)}"` },
    });

    expect(scripts.build.length).toBeLessThanOrEqual(300);
    expect(scripts.build).toContain("...(truncated)");
  });

  it("keeps all returned script commands within the total character budget", () => {
    const scripts = extractCommonScripts({
      scripts: {
        build: "b".repeat(50_000),
        dev: "d".repeat(50_000),
        start: "s".repeat(50_000),
        test: "t".repeat(50_000),
        "test:watch": "w".repeat(50_000),
        "test:coverage": "c".repeat(50_000),
        typecheck: "y".repeat(50_000),
        lint: "l".repeat(50_000),
        smoke: "m".repeat(50_000),
        format: "f".repeat(50_000),
      },
    });

    const totalCommandChars = Object.values(scripts).reduce(
      (total, command) => total + command.length,
      0
    );
    expect(totalCommandChars).toBeLessThanOrEqual(1_200);
    expect(Object.values(scripts).every((command) => command.includes("...(truncated)"))).toBe(true);
  });

  it("does not truncate normal commands when their combined size is within budget", () => {
    const buildCommand = "b".repeat(200);
    const scripts = extractCommonScripts({
      scripts: {
        build: buildCommand,
        dev: "d",
        start: "s",
        test: "t",
        "test:watch": "w",
        "test:coverage": "c",
        typecheck: "y",
        lint: "l",
        smoke: "m",
        format: "f",
      },
    });

    expect(scripts.build).toBe(buildCommand);
    expect(Object.values(scripts).some((command) => command.includes("...(truncated)"))).toBe(false);
  });
});

describe("summarizePackageJson", () => {
  it("summarises name, version, and dependency counts", () => {
    const summary = summarizePackageJson({
      name: "test-repo",
      version: "1.0.0",
      dependencies: { a: "1.0.0", b: "1.0.0" },
    });

    expect(summary).toContain("name: test-repo");
    expect(summary).toContain("version: 1.0.0");
    expect(summary).toContain("dependencies (2): a, b");
  });

  it("does not mistake a valid string-valued _raw field for a parse failure", () => {
    const summary = summarizePackageJson({
      name: "valid-package",
      version: "1.0.0",
      _raw: "legitimate package metadata",
    });

    expect(summary).toContain("name: valid-package");
    expect(summary).toContain("version: 1.0.0");
    expect(summary).not.toMatch(/could not be parsed/i);
  });

  it("bounds summaries with oversized fields and marks truncation", () => {
    const summary = summarizePackageJson({
      name: "large-package",
      version: "1.0.0",
      description: "x".repeat(50_000),
      main: "dist/index.js",
    });

    expect(summary.length).toBeLessThanOrEqual(2_000);
    expect(summary).toContain("name: large-package");
    expect(summary).toContain("...(truncated)");
  });
});

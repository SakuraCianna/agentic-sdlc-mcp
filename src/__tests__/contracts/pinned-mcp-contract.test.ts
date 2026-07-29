import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createContractCollectorEnvironment,
  isPathInside,
  isWorktreeListed,
  validatePinnedContractSource,
} from "../../../scripts/lib/pinned-mcp-contract.mjs";

const FULL_SHA = "3e1cdbb2d591ba482903f53579f1f76cc95ff1c4";

describe("pinned MCP contract checkout safety", () => {
  it("accepts only descendants, not equal, sibling, or prefix-collision paths", () => {
    const parent = path.resolve("contract-temp");

    expect(isPathInside(parent, path.join(parent, "checkout"))).toBe(true);
    expect(isPathInside(parent, parent)).toBe(false);
    expect(isPathInside(parent, path.resolve("contract-sibling"))).toBe(false);
    expect(isPathInside(parent, `${parent}-prefix-collision`)).toBe(false);
  });

  it.each([
    {
      name: "blank tag",
      source: { tag: "   ", expectedCommit: FULL_SHA },
      message: "tag is required",
    },
    {
      name: "short SHA",
      source: { tag: "v1.9.0", expectedCommit: "3e1cdbb" },
      message: "full 40-character SHA",
    },
  ])("rejects $name before running Git", ({ source, message }) => {
    expect(() => validatePinnedContractSource(source)).toThrow(message);
  });

  it("accepts an explicit tag and full commit", () => {
    expect(() =>
      validatePinnedContractSource({
        tag: "v1.9.0",
        expectedCommit: FULL_SHA,
      })
    ).not.toThrow();
  });

  it("matches exact NUL-delimited porcelain worktree paths", () => {
    const parent = path.resolve("contract-temp");
    const checkout = path.join(parent, "checkout with spaces");
    const sibling = path.join(parent, "checkout with spaces-extra");
    const porcelain = [
      `worktree ${checkout}`,
      `HEAD ${FULL_SHA}`,
      "detached",
      "",
      `worktree ${sibling}`,
      `HEAD ${FULL_SHA}`,
      "detached",
      "",
    ].join("\0");

    expect(isWorktreeListed(porcelain, checkout)).toBe(true);
    expect(isWorktreeListed(porcelain, parent)).toBe(false);
    expect(isWorktreeListed(porcelain, `${checkout}-prefix`)).toBe(false);
  });

  it("fails closed to no match for malformed or line-delimited output", () => {
    const checkout = path.resolve("contract-temp", "checkout");

    expect(isWorktreeListed("", checkout)).toBe(false);
    expect(
      isWorktreeListed(`worktree ${checkout}\nHEAD ${FULL_SHA}\n`, checkout)
    ).toBe(false);
  });

  it("removes credentials and local state paths from the collector environment", () => {
    const environment = {
      PATH: "C:\\safe-bin",
      TEMP: "C:\\safe-temp",
      SystemRoot: "C:\\Windows",
      GITHUB_TOKEN: "github-secret",
      GITHUB_PAT: "github-pat",
      npm_token: "registry-secret",
      OPENAI_API_KEY: "model-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      DATABASE_URL: "postgres://credential@example.test/database",
      PGPASSWORD: "database-secret",
      customToken: "camel-case-secret",
      NODE_OPTIONS: "--import=C:\\untrusted-hook.mjs",
      MAX_TOKEN_COUNT: "1000",
      MCP_STORAGE_DIR: "C:\\private-storage",
      MCP_INSPECTOR_OAUTH_STATE_PATH: "C:\\private-oauth.json",
      DOTENV_CONFIG_PATH: "C:\\private.env",
      GITHUB_OWNER: "test-owner",
    };

    const sanitized = createContractCollectorEnvironment(environment);

    expect(sanitized).toEqual({
      PATH: "C:\\safe-bin",
      TEMP: "C:\\safe-temp",
      SystemRoot: "C:\\Windows",
    });
    expect(environment.GITHUB_TOKEN).toBe("github-secret");
  });
});

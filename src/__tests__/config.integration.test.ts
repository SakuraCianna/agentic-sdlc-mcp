import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMocks = vi.hoisted(() => ({
  homedir: vi.fn<() => string>(),
  question: vi.fn<(prompt: string) => Promise<string>>(),
  close: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: configMocks.homedir } };
});

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: vi.fn(() => ({
      question: configMocks.question,
      close: configMocks.close,
    })),
  },
}));

describe("configuration lifecycle with isolated filesystem", () => {
  let home: string;
  const originalArgv = [...process.argv];
  const managedEnvKeys = [
    "GITHUB_TOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "SDLC_DEFAULT_BRANCH",
    "SMOKE",
  ] as const;
  const originalEnv = Object.fromEntries(
    managedEnvKeys.map((key) => [key, process.env[key]])
  );

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-config-test-"));
    configMocks.homedir.mockReturnValue(home);
    configMocks.question.mockReset();
    configMocks.close.mockReset();
    process.argv = originalArgv.filter(
      (value) => !["--smoke", "configure", "--configure"].includes(value)
    );
    for (const key of managedEnvKeys) delete process.env[key];
    vi.resetModules();
  });

  afterEach(async () => {
    process.argv = [...originalArgv];
    for (const key of managedEnvKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("loads missing environment values from the real home config file", async () => {
    await fs.writeFile(
      path.join(home, ".agentic-sdlc-mcp.json"),
      JSON.stringify({
        GITHUB_TOKEN: "file-token",
        GITHUB_OWNER: "file-owner",
        GITHUB_REPO: "file-repo",
        SDLC_DEFAULT_BRANCH: "develop",
      })
    );

    const { config, initializeConfig } = await import("../config.js");
    await initializeConfig();

    expect(config).toMatchObject({
      githubToken: "file-token",
      githubOwner: "file-owner",
      githubRepo: "file-repo",
      defaultBranch: "develop",
      isSmokeMode: false,
    });
  });

  it("keeps explicit environment values ahead of persisted values", async () => {
    await fs.writeFile(
      path.join(home, ".agentic-sdlc-mcp.json"),
      JSON.stringify({
        GITHUB_TOKEN: "file-token",
        GITHUB_OWNER: "file-owner",
        GITHUB_REPO: "file-repo",
      })
    );
    process.env.GITHUB_TOKEN = "env-token";
    process.env.GITHUB_OWNER = "env-owner";
    process.env.GITHUB_REPO = "env-repo";

    const { config, initializeConfig } = await import("../config.js");
    await initializeConfig();

    expect(config).toMatchObject({
      githubToken: "env-token",
      githubOwner: "env-owner",
      githubRepo: "env-repo",
    });
  });

  it("warns on malformed persisted JSON and continues with explicit environment", async () => {
    await fs.writeFile(path.join(home, ".agentic-sdlc-mcp.json"), "{not-json");
    process.env.GITHUB_TOKEN = "env-token";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { config, initializeConfig } = await import("../config.js");
    await initializeConfig();

    expect(config.githubToken).toBe("env-token");
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("读取配置文件"),
      expect.any(SyntaxError)
    );
  });

  it("fails fast without a token in a non-interactive runtime", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { initializeConfig } = await import("../config.js");

    await expect(initializeConfig()).rejects.toThrow("process.exit:1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join(" ")).toContain("GITHUB_TOKEN");
  });

  it("retries an empty token and persists the interactive configure answers", async () => {
    process.argv.push("configure");
    configMocks.question
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce("interactive-token")
      .mockResolvedValueOnce("example-owner")
      .mockResolvedValueOnce("example-repo");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const { initializeConfig } = await import("../config.js");

    await expect(initializeConfig()).rejects.toThrow("process.exit:0");
    const saved = JSON.parse(
      await fs.readFile(path.join(home, ".agentic-sdlc-mcp.json"), "utf8")
    ) as Record<string, string>;
    expect(saved).toEqual({
      GITHUB_TOKEN: "interactive-token",
      GITHUB_OWNER: "example-owner",
      GITHUB_REPO: "example-repo",
    });
    expect(configMocks.question).toHaveBeenCalledTimes(4);
    expect(configMocks.close).toHaveBeenCalledOnce();
  });
});

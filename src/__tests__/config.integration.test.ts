import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
    "SDLC_CONFIG_MODE",
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
    if (process.platform !== "win32") {
      const savedMode = (await fs.stat(
        path.join(home, ".agentic-sdlc-mcp.json")
      )).mode & 0o777;
      expect(savedMode).toBe(0o600);
    }
    expect(configMocks.question).toHaveBeenCalledTimes(4);
    expect(configMocks.close).toHaveBeenCalledOnce();
  });

  it("tightens an existing persisted credential file before loading it", async () => {
    const configPath = path.join(home, ".agentic-sdlc-mcp.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ GITHUB_TOKEN: "file-token" }),
      { mode: 0o644 }
    );

    const { initializeConfig } = await import("../config.js");
    await initializeConfig();

    if (process.platform !== "win32") {
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps home credentials unchanged and unread in envonly mode", async () => {
    const configPath = path.join(home, ".agentic-sdlc-mcp.json");
    const saved = JSON.stringify({ GITHUB_TOKEN: "home-canary", GITHUB_OWNER: "home-owner" });
    await fs.writeFile(configPath, saved);
    process.env.SDLC_CONFIG_MODE = "envonly";
    process.env.GITHUB_TOKEN = "environment-credential";
    const read = vi.spyOn(fs, "readFile");
    const chmod = vi.spyOn(fs, "chmod");
    const { config, initializeConfig } = await import("../config.js");
    await initializeConfig();
    expect(config.githubToken === process.env.GITHUB_TOKEN).toBe(true);
    expect(config.githubOwner).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(chmod).not.toHaveBeenCalled();
    expect(configMocks.question).not.toHaveBeenCalled();
    expect((await fs.readFile(configPath, "utf8")) === saved).toBe(true);
  });

  it.each(["configure", "--configure"])("rejects %s without reading or changing home credentials in envonly mode", async (argument) => {
    const configPath = path.join(home, ".agentic-sdlc-mcp.json");
    const saved = JSON.stringify({ GITHUB_TOKEN: "persisted-credential-canary" });
    await fs.writeFile(configPath, saved);
    process.env.SDLC_CONFIG_MODE = "envonly";
    process.argv.push(argument);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit:${code}`); }) as never);
    const { initializeConfig } = await import("../config.js");
    await expect(initializeConfig()).rejects.toThrow("process.exit:1");
    expect(configMocks.question).not.toHaveBeenCalled();
    expect((await fs.readFile(configPath, "utf8")) === saved).toBe(true);
    expect(error.mock.calls.flat().join(" ").includes("persisted-credential-canary")).toBe(false);
  });

  it("fails without prompting in envonly mode even when both streams are interactive", async () => {
    process.env.SDLC_CONFIG_MODE = "envonly";
    const descriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
    [process.stdin, process.stdout].forEach((stream) => Object.defineProperty(stream, "isTTY", { value: true, configurable: true }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit:${code}`); }) as never);
    try {
      const { initializeConfig } = await import("../config.js");
      await expect(initializeConfig()).rejects.toThrow("process.exit:1");
      expect(configMocks.question).not.toHaveBeenCalled();
    } finally {
      [process.stdin, process.stdout].forEach((stream, index) => {
        if (descriptors[index]) Object.defineProperty(stream, "isTTY", descriptors[index]!);
        else delete (stream as { isTTY?: boolean }).isTTY;
      });
    }
  });

  it("rejects unknown configuration modes before home access or prompts", async () => {
    process.env.SDLC_CONFIG_MODE = "invalid-mode-canary";
    const read = vi.spyOn(fs, "readFile");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`process.exit:${code}`); }) as never);
    const { initializeConfig } = await import("../config.js");
    await expect(initializeConfig()).rejects.toThrow("process.exit:1");
    expect(read).not.toHaveBeenCalled();
    expect(configMocks.question).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ").includes("invalid-mode-canary")).toBe(false);
  });
});

describe("MCP startup configuration mode with an isolated real process", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  });

  async function runStartup(mode: string | undefined) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-envonly-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, ".agentic-sdlc-mcp.json");
    const saved = JSON.stringify({ GITHUB_TOKEN: "isolated-home-credential-canary" });
    await fs.writeFile(configPath, saved);
    await fs.writeFile(path.join(directory, ".env"), "SMOKE=true\nGITHUB_TOKEN=isolated-dotenv-credential-canary\n");
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: path.join(directory, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(directory, "AppData", "Local"),
      ...(mode ? { SDLC_CONFIG_MODE: mode } : {}),
    };
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: directory, env, encoding: "utf8", input: "", timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(`${result.stdout}${result.stderr}`.includes("credential-canary")).toBe(false);
    expect((await fs.readFile(configPath, "utf8")) === saved).toBe(true);
    return result;
  }

  it("does not load .env SMOKE or persisted credentials when envonly is selected externally", async () => {
    const result = await runStartup("envonly");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GITHUB_TOKEN");
    expect(result.stderr).not.toContain("SMOKE OK");
  });

  it("preserves default dotenv loading before config module SMOKE detection", async () => {
    const result = await runStartup(undefined);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("SMOKE OK");
  });

  it("rejects invalid modes before dotenv and home access without echoing the value", async () => {
    const result = await runStartup("invalid-startup-canary");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SDLC_CONFIG_MODE must be default or envonly");
    expect(result.stderr.includes("invalid-startup-canary")).toBe(false);
    expect(result.stderr).not.toContain("SMOKE OK");
  });
});

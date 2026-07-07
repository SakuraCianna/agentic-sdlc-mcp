import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Configuration loader — reads all settings from environment variables or global config file.
 * In smoke mode (--smoke flag or SMOKE=true) token validation is skipped.
 */

export interface Config {
  /** GitHub PAT or App token — required (except in smoke mode) */
  githubToken: string;
  /** Default GitHub owner (org or user) — optional */
  githubOwner: string | undefined;
  /** Default GitHub repo — optional */
  githubRepo: string | undefined;
  /** Default branch name */
  defaultBranch: string;
  /** Whether the process is running in smoke-test mode */
  isSmokeMode: boolean;
}

/** True when --smoke CLI flag or SMOKE=true env var is set. */
export const isSmokeMode =
  process.argv.includes("--smoke") || process.env["SMOKE"] === "true";

// Global config file path in user's home directory
const CONFIG_PATH = path.join(os.homedir(), ".agentic-sdlc-mcp.json");

/** Singleton config instance — properties will be populated on initialization */
export const config: Config = {
  githubToken: "",
  githubOwner: undefined,
  githubRepo: undefined,
  defaultBranch: "main",
  isSmokeMode: false,
};

/** Load configuration from home config file into process.env */
async function loadConfigFile(): Promise<void> {
  try {
    if (fsSync.existsSync(CONFIG_PATH)) {
      const content = await fs.readFile(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed.GITHUB_TOKEN && !process.env["GITHUB_TOKEN"]) {
        process.env["GITHUB_TOKEN"] = parsed.GITHUB_TOKEN;
      }
      if (parsed.GITHUB_OWNER && !process.env["GITHUB_OWNER"]) {
        process.env["GITHUB_OWNER"] = parsed.GITHUB_OWNER;
      }
      if (parsed.GITHUB_REPO && !process.env["GITHUB_REPO"]) {
        process.env["GITHUB_REPO"] = parsed.GITHUB_REPO;
      }
      if (parsed.SDLC_DEFAULT_BRANCH && !process.env["SDLC_DEFAULT_BRANCH"]) {
        process.env["SDLC_DEFAULT_BRANCH"] = parsed.SDLC_DEFAULT_BRANCH;
      }
    }
  } catch (error) {
    console.error(`[Warning] 读取配置文件 ${CONFIG_PATH} 失败:`, error);
  }
}

/** Write configuration to home config file */
async function saveConfigFile(token: string, owner?: string, repo?: string): Promise<void> {
  try {
    const configData: Record<string, string> = {
      GITHUB_TOKEN: token,
    };
    if (owner) configData.GITHUB_OWNER = owner;
    if (repo) configData.GITHUB_REPO = repo;

    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify(configData, null, 2), "utf-8");
    console.error(`[Success] 配置已成功保存至: ${CONFIG_PATH}`);
  } catch (error) {
    console.error(`[Error] 写入配置文件失败:`, error);
  }
}

/** Run the interactive setup flow in CLI */
async function runInteractiveConfig(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    console.error("\n=== agentic-sdlc-mcp 交互式配置引导 ===");
    console.error("检测到未设置 GITHUB_TOKEN，此参数是与 GitHub 交互的核心凭证。");
    console.error("生成地址: https://github.com/settings/tokens (需要勾选 repo, read:org 权限)\n");

    let token = "";
    while (!token) {
      token = await rl.question("请输入您的 GITHUB_TOKEN: ");
      token = token.trim();
      if (!token) {
        console.error("错误: GITHUB_TOKEN 不能为空，请重新输入。");
      }
    }

    const owner = (await rl.question("请输入默认 GitHub Owner (个人用户名或组织名，可选): ")).trim();
    const repo = (await rl.question("请输入默认 GitHub 仓库名 (可选): ")).trim();

    await saveConfigFile(token, owner || undefined, repo || undefined);

    process.env["GITHUB_TOKEN"] = token;
    if (owner) process.env["GITHUB_OWNER"] = owner;
    if (repo) process.env["GITHUB_REPO"] = repo;

    return token;
  } finally {
    rl.close();
  }
}

/** Initializes the configuration. Exits early if required keys are missing and TTY is false. */
export async function initializeConfig(): Promise<void> {
  // 1. If explicit config command, run configuration and exit
  if (process.argv.includes("configure") || process.argv.includes("--configure")) {
    await runInteractiveConfig();
    process.exit(0);
  }

  // 2. If smoke mode, skip token validation entirely
  if (isSmokeMode) {
    Object.assign(config, {
      githubToken: "__smoke_test_placeholder__",
      githubOwner: undefined,
      githubRepo: undefined,
      defaultBranch: "main",
      isSmokeMode: true,
    });
    return;
  }

  // 3. Try to load from configuration file
  await loadConfigFile();

  // 4. Validate GITHUB_TOKEN or ask for it
  if (!process.env["GITHUB_TOKEN"]) {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      await runInteractiveConfig();
    } else {
      console.error(`ERROR: Required environment variable "GITHUB_TOKEN" is not set.`);
      console.error(`  You can configure it in one of the following ways:`);
      console.error(`  1. Set GITHUB_TOKEN in your env or command line.`);
      console.error(`  2. Run 'npx agentic-sdlc-mcp configure' in a terminal to setup globally.`);
      console.error(`  3. Set it in your MCP Client (e.g. Claude Desktop) configuration.`);
      process.exit(1);
    }
  }

  // 5. Populate singleton config
  Object.assign(config, {
    githubToken: process.env["GITHUB_TOKEN"] || "",
    githubOwner: process.env["GITHUB_OWNER"] || undefined,
    githubRepo: process.env["GITHUB_REPO"] || undefined,
    defaultBranch: process.env["SDLC_DEFAULT_BRANCH"] || "main",
    isSmokeMode: false,
  });
}

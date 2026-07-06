/**
 * Configuration loader — reads all settings from environment variables.
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: Required environment variable "${name}" is not set.`);
    console.error(`  Set it in your .env file or in your shell:`);
    console.error(`    PowerShell:  $env:${name}="your-value"`);
    console.error(`    Bash/sh:     export ${name}="your-value"`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  if (isSmokeMode) {
    // Smoke mode: skip token validation — only testing module load + tool registration
    return {
      githubToken: "__smoke_test_placeholder__",
      githubOwner: undefined,
      githubRepo: undefined,
      defaultBranch: "main",
      isSmokeMode: true,
    };
  }

  return {
    githubToken: requireEnv("GITHUB_TOKEN"),
    githubOwner: process.env["GITHUB_OWNER"] || undefined,
    githubRepo: process.env["GITHUB_REPO"] || undefined,
    defaultBranch: process.env["SDLC_DEFAULT_BRANCH"] || "main",
    isSmokeMode: false,
  };
}

/** Singleton — loaded once at startup */
export const config: Config = loadConfig();

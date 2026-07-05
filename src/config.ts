/**
 * Configuration loader — reads all settings from environment variables.
 * No defaults are hardcoded except for safe, non-sensitive values.
 */

export interface Config {
  /** GitHub PAT or App token — required */
  githubToken: string;
  /** Default GitHub owner (org or user) — optional */
  githubOwner: string | undefined;
  /** Default GitHub repo — optional */
  githubRepo: string | undefined;
  /** Default branch name */
  defaultBranch: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: Required environment variable "${name}" is not set.`);
    console.error(`  Set it in your shell or in a .env file before starting the server.`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    githubToken: requireEnv("GITHUB_TOKEN"),
    githubOwner: process.env["GITHUB_OWNER"] || undefined,
    githubRepo: process.env["GITHUB_REPO"] || undefined,
    defaultBranch: process.env["SDLC_DEFAULT_BRANCH"] || "main",
  };
}

/** Singleton — loaded once at startup */
export const config: Config = loadConfig();

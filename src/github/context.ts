/**
 * Helpers for reading repository context from the GitHub API.
 */

import { getOctokit } from "./client.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

export interface RepoContextOptions extends RepoRef {
  includeReadme?: boolean;
  includePackageJson?: boolean;
  includeOpenIssues?: boolean;
  includeOpenPRs?: boolean;
  /** Include `.github/workflows/*.yml` file names (not contents/permissions -- see workflow_permissions_audit for that). */
  includeWorkflows?: boolean;
  /** Include summaries of agent instruction files (AGENTS.md, CLAUDE.md) if present. */
  includeAgentInstructions?: boolean;
  /** Include lightweight governance signals, e.g. whether a CODEOWNERS file exists. */
  includeGovernance?: boolean;
  /** Max number of open issues to fetch. Default: 20. */
  issueLimit?: number;
  /** Max number of open PRs to fetch. Default: 20. */
  prLimit?: number;
  /** Max README characters before truncation. Default: 3000. */
  maxReadmeChars?: number;
  /** Max characters per agent instruction file summary before truncation. Default: 1000. */
  maxInstructionChars?: number;
}

/** Package managers this module can positively identify. */
const KNOWN_PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;
export type PackageManager = (typeof KNOWN_PACKAGE_MANAGERS)[number] | "unknown";

export interface RepoContextResult {
  name: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  visibility: string;
  language: string | null;
  stargazersCount: number;
  openIssuesCount: number;
  topics: string[];
  pushedAt: string | null;
  readme?: string;
  packageJson?: Record<string, unknown>;
  /** Detected package manager. Only populated when includePackageJson is true. */
  packageManager?: PackageManager;
  /** Detected technologies from package.json dependencies (e.g. "TypeScript", "Vitest"). Capped, not exhaustive. */
  techStack?: string[];
  /** Common verification scripts (build/test/typecheck/lint/smoke/...) found in package.json, keyed by script name. */
  scripts?: Record<string, string>;
  /** `.github/workflows/*.yml` file names. Names only -- see workflow_permissions_audit for permission contents. */
  workflows?: string[];
  /** Lightweight governance signals. Does not duplicate branch_protection_status -- call that tool for protection details. */
  governance?: { codeownersFound: boolean };
  /** Summaries of agent instruction files found at the repo root (e.g. AGENTS.md, CLAUDE.md). */
  agentInstructions?: Array<{ path: string; summary: string }>;
  openIssues?: Array<{
    number: number;
    title: string;
    labels: string[];
    createdAt: string;
    url: string;
  }>;
  openPRs?: Array<{
    number: number;
    title: string;
    author: string;
    draft: boolean;
    createdAt: string;
    url: string;
  }>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Read a corepack-style `"packageManager"` field (e.g. `"npm@10.1.0"`) from a
 * package.json object. Returns null when the field is absent or unrecognised
 * so the caller can fall back to lock-file probing.
 */
export function identifyPackageManagerFromField(pkg: Record<string, unknown> | undefined): PackageManager | null {
  const value = pkg?.["packageManager"];
  if (typeof value !== "string") return null;
  const name = value.split("@")[0]?.trim().toLowerCase();
  if (name && (KNOWN_PACKAGE_MANAGERS as readonly string[]).includes(name)) {
    return name as PackageManager;
  }
  return null;
}

/** Dependency name -> human-readable technology label, checked across dependencies + devDependencies. */
const TECH_DEPENDENCY_MAP: Record<string, string> = {
  typescript: "TypeScript",
  vite: "Vite",
  next: "Next.js",
  vitest: "Vitest",
  jest: "Jest",
  mocha: "Mocha",
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  react: "React",
  "react-dom": "React",
  vue: "Vue",
  "@angular/core": "Angular",
  "@nestjs/core": "NestJS",
  svelte: "Svelte",
  nuxt: "Nuxt",
  tailwindcss: "Tailwind CSS",
  prisma: "Prisma",
  "@prisma/client": "Prisma",
  playwright: "Playwright",
  "@playwright/test": "Playwright",
  electron: "Electron",
  eslint: "ESLint",
  webpack: "Webpack",
  rollup: "Rollup",
  esbuild: "esbuild",
  "@modelcontextprotocol/sdk": "MCP SDK",
  zod: "Zod",
};

/** Detect technologies from a package.json's dependencies/devDependencies. Pure -- no I/O. Capped to 15 entries. */
export function detectTechStack(pkg: Record<string, unknown> | undefined): string[] {
  if (!pkg) return [];
  const names = new Set<string>();
  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[section];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      for (const depName of Object.keys(deps as object)) {
        const label = TECH_DEPENDENCY_MAP[depName];
        if (label) names.add(label);
      }
    }
  }
  return Array.from(names).slice(0, 15);
}

/** Verification-relevant script names worth surfacing to an agent before it starts work. */
const COMMON_SCRIPT_KEYS = [
  "build",
  "dev",
  "start",
  "test",
  "test:watch",
  "test:coverage",
  "typecheck",
  "lint",
  "smoke",
  "format",
];

/** Extract known, commonly-useful scripts from package.json. Pure -- no I/O. */
export function extractCommonScripts(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = pkg?.["scripts"];
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  const result: Record<string, string> = {};
  for (const key of COMMON_SCRIPT_KEYS) {
    const value = (scripts as Record<string, unknown>)[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// I/O helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Lock files checked in order; the first one found determines the package manager. */
const LOCK_FILE_CANDIDATES: Array<{ file: string; manager: PackageManager }> = [
  { file: "package-lock.json", manager: "npm" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
];

/**
 * Probe for a lock file to identify the package manager when package.json
 * did not declare a `packageManager` field. Stops at the first match --
 * at most 4 extra API calls, only incurred when includePackageJson is true
 * and the field-based check above came back empty.
 */
async function probePackageManagerByLockFile(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<PackageManager> {
  for (const { file, manager } of LOCK_FILE_CANDIDATES) {
    try {
      await octokit.repos.getContent({ owner, repo, path: file });
      return manager;
    } catch {
      // Not found at this path -- try the next candidate.
    }
  }
  return "unknown";
}

/** List `.github/workflows/*.yml`|`.yaml` file names. Names only -- no content parsing (see workflow_permissions_audit). */
async function listWorkflowFileNames(octokit: Octokit, owner: string, repo: string): Promise<string[]> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: ".github/workflows" });
    if (!Array.isArray(data)) return [];
    return data.filter((entry) => entry.type === "file" && /\.ya?ml$/i.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Conventional CODEOWNERS candidate paths, same set used by review_pr_against_standard. */
const CODEOWNERS_CANDIDATE_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** Whether a CODEOWNERS file exists at any conventional path. Existence only -- ownership routing lives in review_pr_against_standard. */
async function checkCodeownersExists(octokit: Octokit, owner: string, repo: string): Promise<boolean> {
  for (const path of CODEOWNERS_CANDIDATE_PATHS) {
    try {
      await octokit.repos.getContent({ owner, repo, path });
      return true;
    } catch {
      // Not found at this path -- try the next candidate.
    }
  }
  return false;
}

/** Agent instruction files this module looks for at the repo root, checked in order. */
const AGENT_INSTRUCTION_CANDIDATE_PATHS = ["AGENTS.md", "CLAUDE.md"];

/** Fetch and truncate any agent instruction files found at the repo root. */
async function fetchAgentInstructionSummaries(
  octokit: Octokit,
  owner: string,
  repo: string,
  maxChars: number
): Promise<Array<{ path: string; summary: string }>> {
  const results: Array<{ path: string; summary: string }> = [];
  for (const path of AGENT_INSTRUCTION_CANDIDATE_PATHS) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path,
        mediaType: { format: "raw" },
      });
      const raw = typeof data === "string" ? data : JSON.stringify(data);
      const summary = raw.length > maxChars ? raw.slice(0, maxChars) + "\n...(truncated)" : raw;
      results.push({ path, summary });
    } catch {
      // Not found at this path -- try the next candidate.
    }
  }
  return results;
}

export async function fetchRepoContext(
  opts: RepoContextOptions
): Promise<RepoContextResult> {
  const octokit = getOctokit();
  const { owner, repo } = opts;

  // Fetch repo metadata (always)
  const { data: repoData } = await octokit.repos.get({ owner, repo });

  const result: RepoContextResult = {
    name: repoData.name,
    fullName: repoData.full_name,
    description: repoData.description ?? null,
    defaultBranch: repoData.default_branch,
    visibility: repoData.visibility ?? "unknown",
    language: repoData.language ?? null,
    stargazersCount: repoData.stargazers_count,
    openIssuesCount: repoData.open_issues_count,
    topics: repoData.topics ?? [],
    pushedAt: repoData.pushed_at ?? null,
  };

  // Optional: README
  if (opts.includeReadme) {
    try {
      const { data: readmeData } = await octokit.repos.getReadme({
        owner,
        repo,
        mediaType: { format: "raw" },
      });
      const maxChars = opts.maxReadmeChars ?? 3000;
      const raw =
        typeof readmeData === "string"
          ? readmeData
          : JSON.stringify(readmeData);
      result.readme = raw.length > maxChars ? raw.slice(0, maxChars) + "\n...(truncated)" : raw;
    } catch {
      result.readme = "(README not found or inaccessible)";
    }
  }

  // Optional: package.json + derived packageManager/techStack/scripts
  if (opts.includePackageJson) {
    try {
      const { data: fileData } = await octokit.repos.getContent({
        owner,
        repo,
        path: "package.json",
        mediaType: { format: "raw" },
      });
      const raw = typeof fileData === "string" ? fileData : JSON.stringify(fileData);
      try {
        result.packageJson = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        result.packageJson = { _raw: raw };
      }
    } catch {
      result.packageJson = undefined;
    }

    result.techStack = detectTechStack(result.packageJson);
    result.scripts = extractCommonScripts(result.packageJson);

    const fieldPackageManager = identifyPackageManagerFromField(result.packageJson);
    result.packageManager = fieldPackageManager ?? (await probePackageManagerByLockFile(octokit, owner, repo));
  }

  // Optional: workflow file names
  if (opts.includeWorkflows) {
    result.workflows = await listWorkflowFileNames(octokit, owner, repo);
  }

  // Optional: lightweight governance signals
  if (opts.includeGovernance) {
    result.governance = { codeownersFound: await checkCodeownersExists(octokit, owner, repo) };
  }

  // Optional: agent instruction file summaries
  if (opts.includeAgentInstructions) {
    result.agentInstructions = await fetchAgentInstructionSummaries(
      octokit,
      owner,
      repo,
      opts.maxInstructionChars ?? 1000
    );
  }

  // Optional: open issues
  if (opts.includeOpenIssues) {
    const { data: issuesData } = await octokit.issues.listForRepo({
      owner,
      repo,
      state: "open",
      per_page: opts.issueLimit ?? 20,
      sort: "updated",
    });
    result.openIssues = issuesData
      .filter((i) => !i.pull_request) // exclude PRs from issues list
      .map((i) => ({
        number: i.number,
        title: i.title,
        labels: i.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")),
        createdAt: i.created_at,
        url: i.html_url,
      }));
  }

  // Optional: open PRs
  if (opts.includeOpenPRs) {
    const { data: prsData } = await octokit.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: opts.prLimit ?? 20,
      sort: "updated",
    });
    result.openPRs = prsData.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "unknown",
      draft: pr.draft ?? false,
      createdAt: pr.created_at,
      url: pr.html_url,
    }));
  }

  return result;
}

/** Summarise a package.json into a concise string for context. */
export function summarizePackageJson(pkg: Record<string, unknown>): string {
  const lines: string[] = [];
  if (pkg["name"]) lines.push(`name: ${pkg["name"]}`);
  if (pkg["version"]) lines.push(`version: ${pkg["version"]}`);
  if (pkg["description"]) lines.push(`description: ${pkg["description"]}`);
  if (pkg["main"]) lines.push(`main: ${pkg["main"]}`);

  const deps = pkg["dependencies"];
  if (deps && typeof deps === "object") {
    const keys = Object.keys(deps as object).slice(0, 10);
    lines.push(`dependencies (${Object.keys(deps as object).length}): ${keys.join(", ")}${Object.keys(deps as object).length > 10 ? "..." : ""}`);
  }

  const devDeps = pkg["devDependencies"];
  if (devDeps && typeof devDeps === "object") {
    const keys = Object.keys(devDeps as object).slice(0, 5);
    lines.push(`devDependencies (${Object.keys(devDeps as object).length}): ${keys.join(", ")}${Object.keys(devDeps as object).length > 5 ? "..." : ""}`);
  }
  return lines.join("\n");
}

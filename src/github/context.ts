/**
 * Helpers for reading repository context from the GitHub API.
 */

import { getOctokit } from "./client.js";
import type { RepoRef } from "../types.js";

export interface RepoContextOptions extends RepoRef {
  includeReadme?: boolean;
  includePackageJson?: boolean;
  includeOpenIssues?: boolean;
  includeOpenPRs?: boolean;
  /** Max number of open issues to fetch. Default: 20. */
  issueLimit?: number;
  /** Max number of open PRs to fetch. Default: 20. */
  prLimit?: number;
}

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
      // Truncate to first 3000 characters for context efficiency
      const raw =
        typeof readmeData === "string"
          ? readmeData
          : JSON.stringify(readmeData);
      result.readme = raw.length > 3000 ? raw.slice(0, 3000) + "\n...(truncated)" : raw;
    } catch {
      result.readme = "(README not found or inaccessible)";
    }
  }

  // Optional: package.json
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

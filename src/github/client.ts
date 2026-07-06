/**
 * GitHub Octokit client — initialised once from config, shared across tools.
 */

import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import type { RepoRef } from "../types.js";

let _octokit: Octokit | null = null;

export function getOctokit(): Octokit {
  if (!_octokit) {
    _octokit = new Octokit({ auth: config.githubToken });
  }
  return _octokit;
}

/**
 * Resolve owner/repo from tool arguments, falling back to config defaults.
 * Throws a descriptive error if neither is available.
 */
export function resolveRepo(owner?: string, repo?: string): RepoRef {
  const resolvedOwner = owner ?? config.githubOwner;
  const resolvedRepo = repo ?? config.githubRepo;

  if (!resolvedOwner) {
    throw new Error(
      "owner is required. Pass it as a tool argument or set GITHUB_OWNER in your environment."
    );
  }
  if (!resolvedRepo) {
    throw new Error(
      "repo is required. Pass it as a tool argument or set GITHUB_REPO in your environment."
    );
  }

  return { owner: resolvedOwner, repo: resolvedRepo };
}

/**
 * Simple page-based pagination helper.
 *
 * Calls `fn(page)` repeatedly (pages start at 1) until a page returns fewer
 * items than `perPage` (indicating the last page), or `maxItems` is reached.
 *
 * @param fn      - Function that takes a page number and returns a Promise<T[]>
 * @param perPage - Items per page to request (max 100 for GitHub API)
 * @param maxItems - Hard cap to avoid token-explosion on huge repos
 */
export async function paginateAll<T>(
  fn: (page: number, perPage: number) => Promise<T[]>,
  maxItems = 300,
  perPage = 100
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (all.length < maxItems) {
    const items = await fn(page, perPage);
    all.push(...items);
    // Last page is shorter than requested — stop
    if (items.length < perPage) break;
    page++;
  }
  return all.slice(0, maxItems);
}

/**
 * Centralised GitHub API error handler — translates HTTP status codes into
 * actionable error messages.
 */
export function handleGitHubError(error: unknown): string {
  if (isOctokitError(error)) {
    const status = error.status;
    const message = (error.response?.data as { message?: string })?.message ?? "";

    switch (status) {
      case 401:
        return (
          "GitHub authentication failed (401). " +
          "Check that GITHUB_TOKEN is valid and not expired."
        );
      case 403:
        return (
          `GitHub permission denied (403): ${message}. ` +
          "Your token may lack the required scope. " +
          "See README for required token permissions."
        );
      case 404:
        return (
          `GitHub resource not found (404): ${message}. ` +
          "Verify the owner, repo, and resource identifiers."
        );
      case 422:
        return `GitHub validation error (422): ${message}.`;
      case 429:
        return (
          "GitHub rate limit exceeded (429). " +
          "Wait a few minutes then retry, or use a token with higher limits."
        );
      default:
        return `GitHub API error (${status}): ${message}`;
    }
  }

  if (error instanceof Error) {
    return `Unexpected error: ${error.message}`;
  }
  return `Unexpected error: ${String(error)}`;
}

interface OctokitError {
  status: number;
  response?: { data?: unknown };
}

function isOctokitError(error: unknown): error is OctokitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as OctokitError).status === "number"
  );
}

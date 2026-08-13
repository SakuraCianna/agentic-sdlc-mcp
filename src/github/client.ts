/**
 * GitHub Octokit client — initialised once from config, shared across tools.
 */

import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import {
  AbortableCancellationError,
  AbortableTimeoutError,
} from "../evidence/timeout.js";
import type { RepoRef } from "../types.js";

let _octokit: Octokit | null = null;

/** A product-authored diagnostic that is explicitly safe for MCP output. */
export class SafeGitHubDiagnosticError extends Error {
  private constructor(public readonly publicMessage: string) {
    super(publicMessage);
    this.name = "SafeGitHubDiagnosticError";
  }

  static fromCode(
    code:
      | "base_workflow_content_unavailable"
      | "owner_required"
      | "quality_gate_target_required"
      | "repo_required"
  ): SafeGitHubDiagnosticError {
    const messages = {
      base_workflow_content_unavailable: "base workflow content is unavailable",
      owner_required:
        "owner is required. Pass it as a tool argument or set GITHUB_OWNER in your environment.",
      quality_gate_target_required: "Either pullNumber or ref is required.",
      repo_required:
        "repo is required. Pass it as a tool argument or set GITHUB_REPO in your environment.",
    } as const;
    return new SafeGitHubDiagnosticError(messages[code]);
  }
}

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
    throw SafeGitHubDiagnosticError.fromCode("owner_required");
  }
  if (!resolvedRepo) {
    throw SafeGitHubDiagnosticError.fromCode("repo_required");
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
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw new TypeError("maxItems must be a non-negative safe integer.");
  }
  if (
    !Number.isSafeInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  ) {
    throw new TypeError("perPage must be a safe integer between 1 and 100.");
  }
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
  if (error instanceof SafeGitHubDiagnosticError) return error.publicMessage;
  if (error instanceof AbortableTimeoutError) {
    return "GitHub request timed out before complete evidence was available. Retry or reduce the requested scope.";
  }
  if (
    error instanceof AbortableCancellationError ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return "GitHub request was cancelled before complete evidence was available.";
  }
  if (isOctokitError(error)) {
    const status = error.status;

    switch (status) {
      case 401:
        return (
          "GitHub authentication failed (401). " +
          "Check that GITHUB_TOKEN is valid and not expired."
        );
      case 403:
        return (
          "GitHub permission denied (403). " +
          "Your token may lack the required scope. " +
          "See README for required token permissions."
        );
      case 404:
        return (
          "GitHub resource not found (404). " +
          "Verify the owner, repo, and resource identifiers."
        );
      case 422:
        return "GitHub validation error (422). Verify the tool arguments and repository state.";
      case 429:
        return (
          "GitHub rate limit exceeded (429). " +
          "Wait a few minutes then retry, or use a token with higher limits."
        );
      default:
        return `GitHub API error (${status}). Retry the request or inspect trusted server-side logs.`;
    }
  }

  if (error instanceof Error) {
    return "Unexpected GitHub request failure. Retry the request or inspect trusted server-side logs.";
  }
  return "Unexpected GitHub request failure. Retry the request or inspect trusted server-side logs.";
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

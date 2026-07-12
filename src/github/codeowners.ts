import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "../types.js";
import { handleGitHubError } from "./client.js";

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

export interface OwnershipGap {
  owner: string;
  paths: string[];
}

/** Parse CODEOWNERS contents into ordered rules (file order matters: last match wins). */
export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Match one path segment with bounded dynamic programming. This avoids catastrophic
 * backtracking for adversarial sequences of adjacent wildcards.
 */
function segmentMatches(pattern: string, text: string): boolean {
  const m = pattern.length;
  const n = text.length;
  let prevRow = new Array<boolean>(n + 1).fill(false);
  prevRow[0] = true;

  for (let i = 1; i <= m; i++) {
    const currRow = new Array<boolean>(n + 1).fill(false);
    const c = pattern[i - 1];
    currRow[0] = c === "*" && prevRow[0];
    for (let j = 1; j <= n; j++) {
      if (c === "*") {
        currRow[j] = prevRow[j] || currRow[j - 1];
      } else if (c === "?" || c === text[j - 1]) {
        currRow[j] = prevRow[j - 1];
      }
    }
    prevRow = currRow;
  }
  return prevRow[n];
}

/** Match path segments, with `**` spanning zero or more whole segments. */
function matchSegments(
  patternSegs: string[],
  pathSegs: string[],
  pi = 0,
  si = 0,
  memo: Map<number, boolean> = new Map()
): boolean {
  const key = pi * (pathSegs.length + 1) + si;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let result: boolean;
  if (pi >= patternSegs.length) {
    result = si === pathSegs.length;
  } else if (patternSegs[pi] === "**") {
    if (pi === patternSegs.length - 1) {
      result = true;
    } else {
      result = false;
      for (let k = si; k <= pathSegs.length; k++) {
        if (matchSegments(patternSegs, pathSegs, pi + 1, k, memo)) {
          result = true;
          break;
        }
      }
    }
  } else if (si >= pathSegs.length || !segmentMatches(patternSegs[pi], pathSegs[si])) {
    result = false;
  } else {
    result = matchSegments(patternSegs, pathSegs, pi + 1, si + 1, memo);
  }

  memo.set(key, result);
  return result;
}

function matchesAnchored(patternSegs: string[], pathSegs: string[]): boolean {
  if (matchSegments(patternSegs, pathSegs)) return true;
  return (
    pathSegs.length > patternSegs.length &&
    patternSegs[patternSegs.length - 1] !== "**" &&
    matchSegments(patternSegs, pathSegs.slice(0, patternSegs.length))
  );
}

/** Match a repo-relative file path against one CODEOWNERS/gitignore-style pattern. */
export function codeownersPatternMatches(pattern: string, filePath: string): boolean {
  let p = pattern.trim();
  if (p.endsWith("/")) p = p.slice(0, -1);

  const anchored = p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);

  const patternSegs = p.split("/");
  const pathSegs = filePath.split("/");

  if (anchored) return matchesAnchored(patternSegs, pathSegs);

  for (let start = 0; start < pathSegs.length; start++) {
    if (matchesAnchored(patternSegs, pathSegs.slice(start))) return true;
  }
  return false;
}

/** Return owners from the last matching rule. */
export function ownersForFile(filePath: string, rules: CodeownersRule[]): string[] {
  let matched: string[] = [];
  for (const rule of rules) {
    if (codeownersPatternMatches(rule.pattern, filePath)) {
      matched = rule.owners;
    }
  }
  return matched;
}

/** Find owners whose changed paths are not covered by the author or any reviewer route. */
export function findOwnershipGaps(
  filePaths: string[],
  rules: CodeownersRule[],
  requestedUsers: string[],
  requestedTeams: string[],
  reviewedUsers: string[],
  prAuthor: string
): OwnershipGap[] {
  if (rules.length === 0) return [];

  const satisfied = new Set(
    [...requestedUsers, ...requestedTeams, ...reviewedUsers, prAuthor].map((name) =>
      name.toLowerCase()
    )
  );
  const missingOwnerPaths = new Map<string, string[]>();

  for (const filePath of filePaths) {
    for (const owner of ownersForFile(filePath, rules)) {
      const normalized = owner.replace(/^@/, "").toLowerCase();
      if (satisfied.has(normalized)) continue;
      const paths = missingOwnerPaths.get(owner) ?? [];
      paths.push(filePath);
      missingOwnerPaths.set(owner, paths);
    }
  }

  return [...missingOwnerPaths].map(([owner, paths]) => ({ owner, paths }));
}

/** Fetch CODEOWNERS from GitHub's conventional candidate paths in priority order. */
export async function fetchCodeownersRules(
  ref: RepoRef,
  octokit: Octokit,
  gitRef?: string
): Promise<{ rules: CodeownersRule[]; error: string | null }> {
  const candidatePaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  let lastError: string | null = null;

  for (const path of candidatePaths) {
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ...(gitRef === undefined ? {} : { ref: gitRef }),
      });
      if (!Array.isArray(data) && data.type === "file" && data.content) {
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        return { rules: parseCodeowners(content), error: null };
      }
    } catch (error) {
      const message = handleGitHubError(error);
      if (!message.toLowerCase().includes("not found")) {
        lastError = message;
      }
    }
  }

  return { rules: [], error: lastError };
}

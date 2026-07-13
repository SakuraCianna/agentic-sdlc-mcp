/**
 * Bounded GitHub evidence collection for `prepare_work_item`.
 *
 * This module owns request budgets and partial-failure semantics. The MCP tool
 * remains responsible for its public contract, risk orchestration, and output
 * rendering.
 */

import type { Octokit } from "@octokit/rest";
import { extractCommonScripts } from "../github/context.js";
import { fetchCodeownersRules, ownersForFile } from "../github/codeowners.js";
import { loadRepositoryPolicy } from "../policy/repository-policy-loader.js";
import type { RepoRef } from "../types.js";
import {
  buildDependencyGraph,
  deriveAdjacentFileCandidates,
  deriveRepositoryEntryCandidates,
  type DependencyGraph,
  type DependencyIssueInput,
} from "./work-item-context.js";

/** Bounds for optional history lookups keep API usage and output predictable. */
const RECENT_PRS_TO_SCAN = 20;
const MAX_RECENT_PR_MATCHES = 5;
const MAX_COMMENT_EVIDENCE = 5;
const MAX_DEPENDENCIES_PER_SOURCE = 20;

const REPOSITORY_FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt",
  "cs", "rb", "php", "sql", "graphql", "proto", "json", "yaml", "yml", "toml",
  "md", "mdx", "css", "scss", "vue", "svelte", "sh", "ps1",
]);

type IssueComment = Awaited<ReturnType<Octokit["issues"]["listComments"]>>["data"][number];

export interface RecentPrMatch {
  number: number;
  title: string;
  url: string;
  mergedAt: string | null;
  matchedFiles: string[];
}

export interface RelatedFileEvidence {
  path: string;
  reason: string;
  confidence: "high" | "medium" | "low";
  verified: boolean;
  owners: string[];
}

export interface MaintainerCommentEvidence {
  kind: "decision" | "action";
  author: string;
  association: "OWNER" | "MEMBER" | "COLLABORATOR";
  createdAt: string;
  url: string | null;
  excerpt: string;
}

export interface RepositoryBriefingEvidence {
  scripts: Record<string, string>;
  policy?: Awaited<ReturnType<typeof loadRepositoryPolicy>>;
  defaultBranch?: string;
  warnings: string[];
}

interface RecentPrEvidence {
  matches: RecentPrMatch[];
  incomplete: boolean;
}

interface RecentCommentEvidence {
  comments: IssueComment[];
  truncated: boolean;
  warnings: string[];
}

interface RelatedFileCollection {
  files: RelatedFileEvidence[];
  incomplete: boolean;
  warnings: string[];
}

export interface WorkItemEvidence {
  comments: IssueComment[];
  commentsTruncated: boolean;
  commentEvidence: MaintainerCommentEvidence[];
  riskFileHints: string[];
  fileHints: string[];
  repositoryEvidence: RepositoryBriefingEvidence;
  relatedFileEvidence: RelatedFileCollection;
  dependencyEvidence: DependencyGraph & { incomplete: boolean; warnings: string[] };
  recentPRs: RecentPrMatch[];
  recentPRsIncomplete: boolean;
  evidenceWarnings: string[];
}

export interface CollectWorkItemEvidenceInput {
  issueNumber: number;
  issueText: string;
  totalComments?: number;
  includeRelatedFiles: boolean;
  includeRecentPRs: boolean;
  includeDependencies: boolean;
}

/** Extract bounded repository-like paths without mistaking URLs, domains, or versions for files. */
export function extractRepositoryPathHints(value: string): string[] {
  const candidates = value.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+/g) ?? [];
  const hints: string[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
    const extension = normalized.split(".").at(-1)?.toLowerCase() ?? "";
    const firstSegment = normalized.split("/")[0] ?? "";
    if (!REPOSITORY_FILE_EXTENSIONS.has(extension)) continue;
    if (normalized.startsWith("//") || normalized.split("/").includes("..")) continue;
    if (/\.(?:com|net|org|io|dev)$/i.test(firstSegment)) continue;
    if (!hints.includes(normalized)) hints.push(normalized);
    if (hints.length >= 20) break;
  }
  return hints;
}

/** True if a changed-file path and a heuristic file hint refer to the same path boundary. */
export function fileMatchesHint(filename: string, hint: string): boolean {
  const normalizedFilename = filename.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedHint = hint.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalizedFilename === normalizedHint ||
    normalizedFilename.endsWith("/" + normalizedHint) ||
    normalizedHint.endsWith("/" + normalizedFilename)
  );
}

function githubErrorStatus(error: unknown): number | null {
  return typeof error === "object" && error !== null && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

async function fetchRecentIssueComments(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number,
  totalComments: number | undefined
): Promise<RecentCommentEvidence> {
  if (totalComments === 0) return { comments: [], truncated: false, warnings: [] };
  try {
    if (typeof totalComments !== "number") {
      const { data } = await octokit.issues.listComments({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: issueNumber,
        per_page: MAX_COMMENT_EVIDENCE + 1,
      });
      return {
        comments: data.slice(-MAX_COMMENT_EVIDENCE),
        truncated: data.length > MAX_COMMENT_EVIDENCE,
        warnings: [],
      };
    }

    const pageSize = 100;
    const lastPage = Math.max(1, Math.ceil(totalComments / pageSize));
    const requestPage = (page: number) => octokit.issues.listComments({
      owner: ref.owner,
      repo: ref.repo,
      issue_number: issueNumber,
      per_page: pageSize,
      page,
    });
    const { data: lastPageComments } = await requestPage(lastPage);
    let combined = lastPageComments;
    if (combined.length < MAX_COMMENT_EVIDENCE && lastPage > 1) {
      const { data: previousPageComments } = await requestPage(lastPage - 1);
      combined = [...previousPageComments, ...combined];
    }
    return {
      comments: combined.slice(-MAX_COMMENT_EVIDENCE),
      truncated: totalComments > MAX_COMMENT_EVIDENCE,
      warnings: [],
    };
  } catch {
    return {
      comments: [],
      truncated: true,
      warnings: ["Recent comment evidence is unavailable; decisions and action items may be incomplete."],
    };
  }
}

function collectMaintainerCommentEvidence(
  comments: readonly IssueComment[]
): MaintainerCommentEvidence[] {
  const trustedAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"] as const);
  const evidence: MaintainerCommentEvidence[] = [];
  for (const comment of comments) {
    const association = comment.author_association;
    if (!trustedAssociations.has(association as MaintainerCommentEvidence["association"])) continue;
    const body = comment.body ?? "";
    const kind = /(?:^|\n)\s*decision\s*:/i.test(body)
      ? "decision"
      : /(?:^|\n)\s*(?:action(?: item)?|todo)\s*:/i.test(body)
        ? "action"
        : null;
    if (!kind) continue;
    evidence.push({
      kind,
      author: comment.user?.login ?? "unknown",
      association: association as MaintainerCommentEvidence["association"],
      createdAt: comment.created_at,
      url: comment.html_url ?? null,
      excerpt: body.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500),
    });
  }
  return evidence;
}

async function collectRepositoryBriefingEvidence(
  octokit: Octokit,
  ref: RepoRef
): Promise<RepositoryBriefingEvidence> {
  const warnings: string[] = [];
  let defaultBranch: string;
  try {
    const { data } = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    defaultBranch = data.default_branch;
  } catch {
    return {
      scripts: {},
      warnings: ["Repository context is unavailable; policy and verification commands are unverified."],
    };
  }

  const policy = await loadRepositoryPolicy(ref, defaultBranch, octokit);
  if (policy.degraded) warnings.push(...policy.errors.map((error) => `Repository policy degraded: ${error}`));

  let scripts: Record<string, string> = {};
  try {
    const { data } = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path: "package.json",
      ref: defaultBranch,
      mediaType: { format: "raw" },
    });
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      scripts = extractCommonScripts(parsed as Record<string, unknown>);
    } else {
      warnings.push("package.json is not an object; verification commands are unavailable.");
    }
  } catch {
    warnings.push("package.json is missing, inaccessible, or invalid; verification commands are unavailable.");
  }

  return { scripts, policy, defaultBranch, warnings };
}

async function collectRelatedFileEvidence(
  octokit: Octokit,
  ref: RepoRef,
  defaultBranch: string | undefined,
  fileHints: readonly string[]
): Promise<RelatedFileCollection> {
  if (fileHints.length === 0) return { files: [], incomplete: false, warnings: [] };
  const warnings: string[] = [];
  let incomplete = defaultBranch === undefined;
  const codeowners = defaultBranch
    ? await fetchCodeownersRules(ref, octokit, defaultBranch)
    : { rules: [], error: "Default branch is unavailable." };
  if (codeowners.error) {
    incomplete = true;
    warnings.push("CODEOWNERS evidence is incomplete; related-file ownership may be missing.");
  }

  const verifyPath = async (path: string): Promise<"exists" | "missing" | "unknown"> => {
    if (!defaultBranch) return "unknown";
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ref: defaultBranch,
      });
      return !Array.isArray(data) && data.type === "file" ? "exists" : "missing";
    } catch (error) {
      if (githubErrorStatus(error) === 404) return "missing";
      incomplete = true;
      return "unknown";
    }
  };

  const files: RelatedFileEvidence[] = [];
  for (const path of fileHints.slice(0, 20)) {
    const state = await verifyPath(path);
    files.push({
      path,
      reason: "Explicitly referenced by the GitHub issue.",
      confidence: "high",
      verified: state === "exists",
      owners: ownersForFile(path, codeowners.rules),
    });
  }
  for (const candidate of deriveAdjacentFileCandidates(fileHints)) {
    const state = await verifyPath(candidate.path);
    if (state !== "exists") continue;
    files.push({
      path: candidate.path,
      reason: candidate.reason,
      confidence: "medium",
      verified: true,
      owners: ownersForFile(candidate.path, codeowners.rules),
    });
  }
  for (const path of deriveRepositoryEntryCandidates(fileHints)) {
    if (files.some((file) => file.path === path)) continue;
    const state = await verifyPath(path);
    if (state !== "exists") continue;
    files.push({
      path,
      reason: "Verified repository entry point adjacent to the requested root-scope code change.",
      confidence: "low",
      verified: true,
      owners: ownersForFile(path, codeowners.rules),
    });
  }
  if (incomplete) warnings.push("Related file evidence is incomplete because one or more repository paths could not be verified.");
  return { files, incomplete, warnings };
}

function dependencyIssue(value: unknown): DependencyIssueInput | null {
  if (!value || typeof value !== "object") return null;
  const issue = value as Record<string, unknown>;
  const number = issue["number"];
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 ||
      typeof issue["title"] !== "string" ||
      typeof issue["state"] !== "string" || typeof issue["html_url"] !== "string") return null;
  return {
    number,
    title: issue["title"],
    state: issue["state"],
    html_url: issue["html_url"],
    ...(typeof issue["repository_url"] === "string" ? { repository_url: issue["repository_url"] } : {}),
  };
}

async function collectDependencyEvidence(
  octokit: Octokit,
  ref: RepoRef,
  issueNumber: number
): Promise<DependencyGraph & { incomplete: boolean; warnings: string[] }> {
  const requests = [
    ["blocked-by", () => octokit.issues.listDependenciesBlockedBy({ owner: ref.owner, repo: ref.repo, issue_number: issueNumber, per_page: MAX_DEPENDENCIES_PER_SOURCE + 1 })],
    ["blocking", () => octokit.issues.listDependenciesBlocking({ owner: ref.owner, repo: ref.repo, issue_number: issueNumber, per_page: MAX_DEPENDENCIES_PER_SOURCE + 1 })],
    ["sub-issues", () => octokit.issues.listSubIssues({ owner: ref.owner, repo: ref.repo, issue_number: issueNumber, per_page: MAX_DEPENDENCIES_PER_SOURCE + 1 })],
    ["timeline cross-references", () => octokit.issues.listEventsForTimeline({ owner: ref.owner, repo: ref.repo, issue_number: issueNumber, per_page: MAX_DEPENDENCIES_PER_SOURCE + 1 })],
  ] as const;
  const settled = await Promise.allSettled(requests.map(([, request]) => request()));
  const warnings: string[] = [];
  let incomplete = false;
  const sourceItems: DependencyIssueInput[][] = [[], [], [], []];
  settled.forEach((result, index) => {
    const name = requests[index]?.[0] ?? "dependency";
    if (result.status === "rejected") {
      incomplete = true;
      warnings.push(`${name} dependency evidence is unavailable.`);
      return;
    }
    const raw = result.value.data;
    if (!Array.isArray(raw)) {
      incomplete = true;
      warnings.push(`${name} dependency evidence returned an unexpected response shape.`);
      return;
    }
    if (raw.length > MAX_DEPENDENCIES_PER_SOURCE) incomplete = true;
    const bounded = raw.slice(0, MAX_DEPENDENCIES_PER_SOURCE);
    let invalidRecords = false;
    sourceItems[index] = index === 3
      ? bounded.flatMap((event): DependencyIssueInput[] => {
          if (!event || typeof event !== "object") return [];
          const record = event as Record<string, unknown>;
          if (record["event"] !== "cross-referenced") return [];
          const source = record["source"];
          if (!source || typeof source !== "object") {
            invalidRecords = true;
            return [];
          }
          const issue = dependencyIssue((source as Record<string, unknown>)["issue"]);
          if (!issue) invalidRecords = true;
          return issue ? [issue] : [];
        })
      : bounded.flatMap((item): DependencyIssueInput[] => {
          const issue = dependencyIssue(item);
          if (!issue) invalidRecords = true;
          return issue ? [issue] : [];
        });
    if (invalidRecords) {
      incomplete = true;
      warnings.push(`${name} dependency evidence contained invalid records.`);
    }
  });
  if (incomplete) warnings.push("Dependency graph is incomplete because a source failed, returned malformed evidence, or exceeded its 20-item cap.");
  return {
    ...buildDependencyGraph({
      current: { ...ref, issueNumber },
      blockedBy: sourceItems[0] ?? [],
      blocking: sourceItems[1] ?? [],
      subIssues: sourceItems[2] ?? [],
      crossReferences: sourceItems[3] ?? [],
    }),
    incomplete,
    warnings,
  };
}

/** Bounded history lookup that preserves partial matches and reports evidence gaps. */
export async function findRecentPRsEvidence(
  octokit: Octokit,
  ref: RepoRef,
  fileHints: string[]
): Promise<RecentPrEvidence> {
  if (fileHints.length === 0) return { matches: [], incomplete: false };

  const { data: candidates } = await octokit.pulls.list({
    owner: ref.owner,
    repo: ref.repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: RECENT_PRS_TO_SCAN + 1,
  });

  const matches: RecentPrMatch[] = [];
  let incomplete = candidates.length > RECENT_PRS_TO_SCAN;
  const boundedCandidates = candidates.slice(0, RECENT_PRS_TO_SCAN);
  for (const [candidateIndex, pr] of boundedCandidates.entries()) {
    if (!pr.merged_at) continue;
    if (matches.length >= MAX_RECENT_PR_MATCHES) {
      if (candidateIndex < boundedCandidates.length) incomplete = true;
      break;
    }

    const files: Awaited<ReturnType<Octokit["pulls"]["listFiles"]>>["data"] = [];
    try {
      for (let page = 1; page <= 3; page += 1) {
        const perPage = 100;
        const { data } = await octokit.pulls.listFiles({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: pr.number,
          per_page: perPage,
          page,
        });
        if (page === 3) {
          if (data.length > 0) incomplete = true;
          break;
        }
        files.push(...data);
        if (data.length < perPage) break;
      }
    } catch {
      incomplete = true;
      continue;
    }

    const matchedFiles = files.flatMap((file) => {
      const currentMatches = fileHints.some((hint) => fileMatchesHint(file.filename, hint));
      const previous = "previous_filename" in file ? file.previous_filename : undefined;
      const previousMatches = typeof previous === "string" &&
        fileHints.some((hint) => fileMatchesHint(previous, hint));
      if (!currentMatches && !previousMatches) return [];
      return [previous && previous !== file.filename ? `${previous} -> ${file.filename}` : file.filename];
    });

    if (matchedFiles.length > 0) {
      matches.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        mergedAt: pr.merged_at,
        matchedFiles,
      });
    }
  }

  return { matches, incomplete };
}

/** Compatibility helper for callers interested only in matching PRs. */
export async function findRecentPRsForFileHints(
  octokit: Octokit,
  ref: RepoRef,
  fileHints: string[]
): Promise<RecentPrMatch[]> {
  return (await findRecentPRsEvidence(octokit, ref, fileHints)).matches;
}

/**
 * Collect all optional work-item evidence behind one bounded, degradable API.
 * Individual source failures are converted to explicit warnings where possible.
 */
export async function collectWorkItemEvidence(
  octokit: Octokit,
  ref: RepoRef,
  input: CollectWorkItemEvidenceInput
): Promise<WorkItemEvidence> {
  const recentComments = await fetchRecentIssueComments(
    octokit,
    ref,
    input.issueNumber,
    input.totalComments
  );
  const commentEvidence = collectMaintainerCommentEvidence(recentComments.comments);
  const riskFileHints = extractRepositoryPathHints(input.issueText);
  const fileHints = input.includeRelatedFiles ? riskFileHints : [];

  const repositoryEvidence = await collectRepositoryBriefingEvidence(octokit, ref);
  const relatedFileEvidence = input.includeRelatedFiles
    ? await collectRelatedFileEvidence(octokit, ref, repositoryEvidence.defaultBranch, riskFileHints)
    : { files: [], incomplete: false, warnings: [] };
  const dependencyEvidence = input.includeDependencies
    ? await collectDependencyEvidence(octokit, ref, input.issueNumber)
    : {
        dependencies: [],
        blockers: [],
        parallelizableWork: [],
        incomplete: false,
        warnings: [],
      };

  let recentPRs: RecentPrMatch[] = [];
  let recentPRsIncomplete = false;
  const evidenceWarnings = [
    ...recentComments.warnings,
    ...repositoryEvidence.warnings,
    ...relatedFileEvidence.warnings,
    ...dependencyEvidence.warnings,
  ];
  if (input.includeRecentPRs) {
    try {
      const history = await findRecentPRsEvidence(octokit, ref, fileHints);
      recentPRs = history.matches;
      recentPRsIncomplete = history.incomplete;
      if (history.incomplete) {
        evidenceWarnings.push("Recent PR evidence is incomplete because a scan limit or GitHub API gap was reached.");
      }
    } catch {
      recentPRsIncomplete = true;
      evidenceWarnings.push("Recent PR evidence is incomplete because GitHub history could not be read.");
    }
  }

  return {
    comments: recentComments.comments,
    commentsTruncated: recentComments.truncated,
    commentEvidence,
    riskFileHints,
    fileHints,
    repositoryEvidence,
    relatedFileEvidence,
    dependencyEvidence,
    recentPRs,
    recentPRsIncomplete,
    evidenceWarnings,
  };
}

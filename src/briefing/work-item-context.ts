import type { RepoRef } from "../types.js";

export interface AdjacentFileCandidate {
  path: string;
  reason: string;
}

export type DependencyRelation = "blocked_by" | "blocking" | "sub_issue" | "cross_reference";

export interface DependencyIssueInput {
  number: number;
  title: string;
  state: string;
  html_url: string;
  repository_url?: string;
}

export interface WorkItemDependency {
  relation: DependencyRelation;
  repository: string;
  number: number;
  title: string;
  state: string;
  url: string;
  verified: true;
}

export interface DependencyGraph {
  dependencies: WorkItemDependency[];
  blockers: WorkItemDependency[];
  parallelizableWork: WorkItemDependency[];
}

const MAX_ADJACENT_CANDIDATES = 12;
const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "cs", "rb", "php",
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sourceFromTestPath(path: string): string | null {
  const normalized = normalizePath(path);
  const withoutTestDirectory = normalized
    .replace(/^(?:__tests__|tests?)\//, "")
    .replace(/\/(?:__tests__|tests?)\//, "/");
  const source = withoutTestDirectory.replace(/\.(?:test|spec)(?=\.[^.]+$)/, "");
  return source === normalized ? null : source;
}

/** Produce bounded, unverified adjacency candidates from explicit file hints. */
export function deriveAdjacentFileCandidates(fileHints: readonly string[]): AdjacentFileCandidate[] {
  const candidates: AdjacentFileCandidate[] = [];
  const seen = new Set(fileHints.map(normalizePath));
  const add = (path: string, reason: string): void => {
    const normalized = normalizePath(path);
    if (seen.has(normalized) || candidates.some((candidate) => candidate.path === normalized)) return;
    candidates.push({ path: normalized, reason });
  };

  for (const rawHint of fileHints) {
    if (candidates.length >= MAX_ADJACENT_CANDIDATES) break;
    const hint = normalizePath(rawHint);
    const source = sourceFromTestPath(hint);
    if (source) {
      add(source, `Source counterpart inferred from test path ${hint}.`);
      continue;
    }

    const slash = hint.lastIndexOf("/");
    const directory = slash >= 0 ? hint.slice(0, slash) : "";
    const filename = slash >= 0 ? hint.slice(slash + 1) : hint;
    const dot = filename.lastIndexOf(".");
    if (dot <= 0) continue;
    const basename = filename.slice(0, dot);
    const extension = filename.slice(dot + 1).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const prefix = directory ? `${directory}/` : "";
    add(`${prefix}${basename}.test.${extension}`, `Same-directory test naming convention for ${hint}.`);
    add(`${prefix}${basename}.spec.${extension}`, `Same-directory spec naming convention for ${hint}.`);
    add(`${prefix}__tests__/${basename}.test.${extension}`, `Adjacent __tests__ convention for ${hint}.`);
  }

  return candidates.slice(0, MAX_ADJACENT_CANDIDATES);
}

/** Return a small root-entry candidate set only for root-scope source changes. */
export function deriveRepositoryEntryCandidates(fileHints: readonly string[]): string[] {
  const normalized = fileHints.map(normalizePath);
  if (normalized.length === 0 || normalized.some((path) => /^(?:packages|apps)\/[^/]+\//i.test(path))) return [];
  const hasRootSourceChange = normalized.some((path) => {
    const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
    return SOURCE_EXTENSIONS.has(extension);
  });
  return hasRootSourceChange
    ? ["src/index.ts", "src/main.ts", "src/app.ts", "index.ts", "index.js"]
    : [];
}

function repositoryFromIssue(issue: DependencyIssueInput, fallback: RepoRef): string {
  if (issue.repository_url) {
    const match = issue.repository_url.match(/\/repos\/([^/]+)\/([^/?#]+)$/i);
    if (match?.[1] && match[2]) return `${match[1]}/${match[2]}`;
  }
  return `${fallback.owner}/${fallback.repo}`;
}

/** Normalize official GitHub relationship endpoints without inventing dependency semantics. */
export function buildDependencyGraph(input: {
  current: RepoRef & { issueNumber: number };
  blockedBy: readonly DependencyIssueInput[];
  blocking: readonly DependencyIssueInput[];
  subIssues: readonly DependencyIssueInput[];
  crossReferences: readonly DependencyIssueInput[];
}): DependencyGraph {
  const dependencies: WorkItemDependency[] = [];
  const seen = new Set<string>();
  const append = (relation: DependencyRelation, items: readonly DependencyIssueInput[]): void => {
    for (const issue of items) {
      const repository = repositoryFromIssue(issue, input.current);
      if (repository.toLowerCase() === `${input.current.owner}/${input.current.repo}`.toLowerCase() &&
          issue.number === input.current.issueNumber) continue;
      const key = `${relation}\0${repository.toLowerCase()}\0${issue.number}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        relation,
        repository,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.html_url,
        verified: true,
      });
    }
  };

  append("blocked_by", input.blockedBy);
  append("blocking", input.blocking);
  append("sub_issue", input.subIssues);
  append("cross_reference", input.crossReferences);

  const blockers = dependencies.filter((item) => item.relation === "blocked_by" && item.state === "open");
  const blockerSubjects = new Set(blockers.map((item) => `${item.repository.toLowerCase()}\0${item.number}`));
  const parallelizableWork = dependencies.filter((item) =>
    item.relation === "sub_issue" &&
    item.state === "open" &&
    !blockerSubjects.has(`${item.repository.toLowerCase()}\0${item.number}`)
  );
  return { dependencies, blockers, parallelizableWork };
}

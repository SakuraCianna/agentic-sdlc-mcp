/**
 * Tool: review_pr_against_standard
 *
 * Core logic extracted as `generateFindings` and `handleReviewPr` for testing.
 * security-focused mode inspects actual patch lines for suspicious patterns.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, paginateAll, handleGitHubError } from "../github/client.js";
import type { Finding, Severity, RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const ReviewPrInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  pullNumber: z.number().int().positive().describe("The pull request number to review."),
  standard: z
    .enum(["basic", "strict", "security-focused"])
    .default("basic")
    .describe("Review standard: 'basic', 'strict', or 'security-focused'."),
  checkOwnership: z
    .boolean()
    .default(true)
    .describe(
      "Check changed files against .github/CODEOWNERS and flag owners who were neither requested nor have reviewed. Requires read access to repo contents and PR reviewers/reviews."
    ),
});

export type ReviewPrInput = z.infer<typeof ReviewPrInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const ReviewPrOutputSchema = {
  pullNumber: z.number().int(),
  title: z.string(),
  standard: z.string(),
  conclusion: z.enum(["pass", "needs_changes", "risky_but_acceptable"]),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      category: z.string(),
      description: z.string(),
      suggestion: z.string().optional(),
    })
  ),
  hasTests: z.boolean(),
  totalChangedLines: z.number().int(),
  codeownersFound: z.boolean(),
  errors: z.array(z.string()),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewPrResult {
  pullNumber: number;
  title: string;
  standard: string;
  conclusion: "pass" | "needs_changes" | "risky_but_acceptable";
  findings: Finding[];
  hasTests: boolean;
  totalChangedLines: number;
  codeownersFound: boolean;
  errors: string[];
}

/** Minimal shape from octokit pulls.listFiles we care about */
export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/** Minimal PR metadata shape */
export interface PrMeta {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
  commits: number;
  author: string;
}

/** A single CODEOWNERS rule: a gitignore-style pattern and its owners. */
export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
}

export function severityIcon(s: Severity): string {
  const icons: Record<Severity, string> = {
    critical: "\u{1F534}",
    high: "\u{1F7E0}",
    medium: "\u{1F7E1}",
    low: "\u{1F535}",
    info: "⚪",
  };
  return icons[s] ?? "⚪";
}

/**
 * Secret-like patterns to flag in added patch lines (conservative).
 * Only matches lines that look like an assignment, not just the word.
 */
const SUSPICIOUS_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "hardcoded password assignment", pattern: /password\s*[:=]\s*['"`][^'"`\s]{6,}/i },
  { name: "hardcoded API key assignment", pattern: /api[_-]?key\s*[:=]\s*['"`][^'"`\s]{6,}/i },
  { name: "hardcoded secret assignment", pattern: /secret\s*[:=]\s*['"`][^'"`\s]{6,}/i },
  { name: "hardcoded token assignment", pattern: /token\s*[:=]\s*['"`][^'"`\s]{6,}/i },
  { name: "AWS access key ID pattern", pattern: /AKIA[0-9A-Z]{16}/ },
];

/** Check added lines in a patch for suspicious secret-like patterns. */
export function scanPatchForSecrets(filename: string, patch: string | undefined): Finding[] {
  if (!patch) return [];
  const findings: Finding[] = [];
  const addedLines = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));

  for (const line of addedLines) {
    for (const { name, pattern } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          severity: "high",
          category: "Security",
          description: `Possible ${name} in \`${filename}\` -- needs manual review.`,
          suggestion:
            "If this is a real credential, rotate it immediately and use an environment variable instead.",
        });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}

/**
 * Classify PR files into categories.
 */
export function classifyFiles(files: PrFile[]) {
  const testFiles = files.filter(
    (f) =>
      f.filename.includes("/test") ||
      f.filename.includes("/spec") ||
      f.filename.includes("__tests__") ||
      /\.(test|spec)\.[jt]sx?$/.test(f.filename)
  );
  const lockFiles = files.filter((f) =>
    [
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "Cargo.lock",
      "requirements.txt",
      "poetry.lock",
      "Pipfile.lock",
      "go.sum",
    ].includes(f.filename.split("/").pop() ?? "")
  );
  const configFiles = files.filter(
    (f) =>
      f.filename.endsWith(".json") ||
      f.filename.endsWith(".yml") ||
      f.filename.endsWith(".yaml") ||
      f.filename.endsWith(".toml") ||
      /\.env(\.|$)/.test(f.filename)
  );
  const dotEnvFiles = files.filter((f) => /\.env(\.|$)/.test(f.filename));
  const docFiles = files.filter(
    (f) =>
      f.filename.endsWith(".md") ||
      f.filename.endsWith(".rst") ||
      f.filename.startsWith("docs/")
  );
  const distFiles = files.filter(
    (f) =>
      f.filename.startsWith("dist/") ||
      f.filename.startsWith("build/") ||
      f.filename.endsWith(".min.js") ||
      f.filename.endsWith(".min.css")
  );
  const snapshotOnlyTestFiles = testFiles.filter(
    (f) => f.filename.includes("__snapshots__") || f.filename.endsWith(".snap")
  );
  const srcFiles = files.filter(
    (f) => !testFiles.includes(f) && !docFiles.includes(f) && !lockFiles.includes(f)
  );

  return {
    testFiles,
    configFiles,
    docFiles,
    lockFiles,
    dotEnvFiles,
    distFiles,
    snapshotOnlyTestFiles,
    srcFiles,
  };
}

/**
 * Generate findings for a PR. Pure function -- no I/O.
 */
export function generateFindings(
  pr: PrMeta,
  files: PrFile[],
  standard: ReviewPrInput["standard"]
): Finding[] {
  const findings: Finding[] = [];
  const {
    testFiles,
    configFiles,
    docFiles,
    lockFiles,
    dotEnvFiles,
    distFiles,
    snapshotOnlyTestFiles,
    srcFiles,
  } = classifyFiles(files);

  const totalLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  const hasLogicTests =
    testFiles.length > 0 && testFiles.some((f) => !snapshotOnlyTestFiles.includes(f));
  const hasAnyTests = testFiles.length > 0;

  // --- Basic checks ---
  if (!pr.body || pr.body.trim().length < 20) {
    findings.push({
      severity: "high",
      category: "Documentation",
      description: "PR has no meaningful description.",
      suggestion: "Add a description explaining the WHY, not just WHAT changed.",
    });
  }

  if (!hasAnyTests) {
    findings.push({
      severity: "high",
      category: "Testing",
      description: "No test files detected in this PR.",
      suggestion: "Add or update unit/integration tests for the changed code.",
    });
  } else if (!hasLogicTests && snapshotOnlyTestFiles.length > 0) {
    findings.push({
      severity: "medium",
      category: "Testing",
      description: "Only snapshot test files changed -- no logic test changes detected.",
      suggestion: "Ensure snapshot updates are intentional and logic tests cover the changed behaviour.",
    });
  }

  if (pr.draft) {
    findings.push({
      severity: "info",
      category: "Status",
      description: "PR is still marked as a draft.",
      suggestion: "Mark as ready for review when implementation is complete.",
    });
  }

  if (pr.commits > 20) {
    findings.push({
      severity: "low",
      category: "Hygiene",
      description: `PR has ${pr.commits} commits -- consider squashing for cleaner history.`,
      suggestion: "Use 'git rebase -i' to squash related commits.",
    });
  }

  // --- Strict checks ---
  if (standard === "strict" || standard === "security-focused") {
    if (totalLines > 800) {
      findings.push({
        severity: "medium",
        category: "Size",
        description: `Large PR: ${totalLines} changed lines. Harder to review thoroughly.`,
        suggestion: "Consider splitting into smaller, focused PRs.",
      });
    }

    if (srcFiles.length > 5 && docFiles.length === 0) {
      findings.push({
        severity: "low",
        category: "Documentation",
        description: "No documentation files updated despite significant source changes.",
        suggestion: "Update README or docs/ if any public API or behaviour changed.",
      });
    }
  }

  // --- Security-focused checks ---
  if (standard === "security-focused") {
    if (dotEnvFiles.length > 0) {
      findings.push({
        severity: "critical",
        category: "Security",
        description: `.env file(s) modified: ${dotEnvFiles.map((f) => f.filename).join(", ")}`,
        suggestion:
          "Verify NO real credentials are committed. " +
          ".env files should be in .gitignore. If secrets are present, rotate them immediately.",
      });
    }

    if (lockFiles.length > 0) {
      findings.push({
        severity: "medium",
        category: "Security",
        description: `Dependency lockfile changed: ${lockFiles.map((f) => f.filename).join(", ")}`,
        suggestion: "Run 'npm audit' / 'pip-audit' / 'cargo audit' to check for known vulnerabilities.",
      });
    }

    const nonLockConfigFiles = configFiles.filter(
      (f) => !lockFiles.includes(f) && !dotEnvFiles.includes(f)
    );
    if (nonLockConfigFiles.length > 0) {
      findings.push({
        severity: "low",
        category: "Security",
        description: `Config files changed: ${nonLockConfigFiles.map((f) => f.filename).join(", ")}`,
        suggestion: "Verify no environment-specific values or secrets are hardcoded.",
      });
    }

    if (distFiles.length > 0) {
      findings.push({
        severity: "medium",
        category: "Security",
        description: `Compiled/generated files included: ${distFiles.map((f) => f.filename).join(", ")}`,
        suggestion:
          "Dist files in PRs are unusual -- confirm this is intentional. " +
          "Generated files can hide malicious code and should usually be gitignored.",
      });
    }

    // Scan patch content for secret-like patterns
    for (const file of files) {
      if (file.patch) {
        const secretFindings = scanPatchForSecrets(file.filename, file.patch);
        findings.push(...secretFindings);
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// CODEOWNERS parsing and ownership findings (pure, exported for testing)
// ---------------------------------------------------------------------------

/** Parse a CODEOWNERS file's contents into ordered rules (file order matters -- last match wins). */
export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue; // patterns with no owners unset ownership; not tracked here
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Match a single path segment against a pattern segment containing `*` (any run of chars)
 * and/or `?` (exactly one char). Implemented as a rolling dynamic-programming pass rather
 * than a compiled RegExp so adjacent wildcards (e.g. many `*a*a*a...` segments) can never
 * trigger catastrophic backtracking -- this is always O(pattern.length * text.length).
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

/**
 * Match a full path (split into `/`-separated segments) against pattern segments, where a
 * `**` segment matches zero or more whole path segments (including zero, per gitignore semantics).
 * Memoized on (pi, si): without this, patterns with many `**` segments against a repetitive path
 * cause the same subproblems to be recomputed exponentially -- the recursion re-derives the
 * classic ReDoS blowup in hand-rolled form even though no RegExp is involved. Memoizing keeps this
 * at O(patternSegs.length * pathSegs.length) subproblems, each doing at most O(pathSegs.length) work.
 */
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

/** A pattern matches a path either exactly, or as a directory prefix (everything nested below it). */
function matchesAnchored(patternSegs: string[], pathSegs: string[]): boolean {
  if (matchSegments(patternSegs, pathSegs)) return true;
  return (
    pathSegs.length > patternSegs.length &&
    patternSegs[patternSegs.length - 1] !== "**" &&
    matchSegments(patternSegs, pathSegs.slice(0, patternSegs.length))
  );
}

/**
 * Match a repo-relative file path against a single CODEOWNERS/gitignore-style pattern.
 * Handles rooted (`/path/`) vs unrooted patterns, `*`/`?`/`**` wildcards, and directory-prefix
 * matching (a pattern matching a directory also matches everything nested under it).
 */
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

/** Owners for a file, per CODEOWNERS semantics: rules are evaluated in order, last match wins. */
export function ownersForFile(filePath: string, rules: CodeownersRule[]): string[] {
  let matched: string[] = [];
  for (const rule of rules) {
    if (codeownersPatternMatches(rule.pattern, filePath)) {
      matched = rule.owners;
    }
  }
  return matched;
}

/**
 * Flag CODEOWNERS owners whose files changed but who were neither requested as reviewers,
 * nor have already reviewed, nor are the PR author. Pure function -- no I/O.
 */
export function generateOwnershipFindings(
  files: PrFile[],
  rules: CodeownersRule[],
  requestedUsers: string[],
  requestedTeams: string[],
  reviewedUsers: string[],
  prAuthor: string
): Finding[] {
  if (rules.length === 0) return [];

  const satisfied = new Set(
    [...requestedUsers, ...requestedTeams, ...reviewedUsers, prAuthor].map((u) => u.toLowerCase())
  );

  const missingOwnerFiles = new Map<string, string[]>();
  for (const file of files) {
    for (const owner of ownersForFile(file.filename, rules)) {
      const normalized = owner.replace(/^@/, "").toLowerCase();
      if (satisfied.has(normalized)) continue;
      const list = missingOwnerFiles.get(owner) ?? [];
      list.push(file.filename);
      missingOwnerFiles.set(owner, list);
    }
  }

  const findings: Finding[] = [];
  for (const [owner, filenames] of missingOwnerFiles) {
    findings.push({
      severity: "medium",
      category: "Ownership",
      description: `CODEOWNERS owner ${owner} was not requested as a reviewer and has not reviewed changes to: ${filenames.join(", ")}.`,
      suggestion: `Request a review from ${owner}, or confirm CODEOWNERS routing is still correct for these paths.`,
    });
  }
  return findings;
}

/**
 * Fetch and parse the repo's CODEOWNERS file, trying the conventional candidate paths in order.
 * A 404 on a candidate is normal (file lives elsewhere or doesn't exist) and tries the next path;
 * any other error (e.g. permissions) short-circuits and is reported back to the caller.
 */
export async function fetchCodeownersRules(
  ref: RepoRef,
  octokit: Octokit
): Promise<{ rules: CodeownersRule[]; error: string | null }> {
  const candidatePaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  let lastError: string | null = null;

  for (const path of candidatePaths) {
    try {
      const { data } = await octokit.repos.getContent({ owner: ref.owner, repo: ref.repo, path });
      if (!Array.isArray(data) && data.type === "file" && data.content) {
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        return { rules: parseCodeowners(content), error: null };
      }
    } catch (err) {
      const message = handleGitHubError(err);
      if (!message.toLowerCase().includes("not found")) {
        lastError = message;
      }
    }
  }
  return { rules: [], error: lastError };
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleReviewPr(
  params: ReviewPrInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: ReviewPrResult }> {
  const { data: pr } = await octokit.pulls.get({
    owner: ref.owner,
    repo: ref.repo,
    pull_number: params.pullNumber,
  });

  const rawFiles = await paginateAll(
    (page, perPage) =>
      octokit.pulls
        .listFiles({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: params.pullNumber,
          per_page: perPage,
          page,
        })
        .then((r) => r.data),
    300
  );

  const files: PrFile[] = rawFiles.map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch,
  }));

  const prMeta: PrMeta = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    draft: pr.draft ?? false,
    commits: pr.commits,
    author: pr.user?.login ?? "",
  };

  const errors: string[] = [];
  let codeownersFound = false;
  let ownershipFindings: Finding[] = [];

  if (params.checkOwnership) {
    const { rules, error: codeownersError } = await fetchCodeownersRules(ref, octokit);
    if (codeownersError) errors.push(`CODEOWNERS: ${codeownersError}`);
    codeownersFound = rules.length > 0;

    if (rules.length > 0) {
      let requestedUsers: string[] = [];
      let requestedTeams: string[] = [];
      try {
        const { data: reviewers } = await octokit.pulls.listRequestedReviewers({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: params.pullNumber,
        });
        requestedUsers = reviewers.users?.map((u) => u.login) ?? [];
        requestedTeams = reviewers.teams?.map((t) => `${ref.owner}/${t.slug}`) ?? [];
      } catch (err) {
        errors.push(`Requested reviewers: ${handleGitHubError(err)}`);
      }

      let reviewedUsers: string[] = [];
      try {
        const rawReviews = await paginateAll(
          (page, perPage) =>
            octokit.pulls
              .listReviews({
                owner: ref.owner,
                repo: ref.repo,
                pull_number: params.pullNumber,
                per_page: perPage,
                page,
              })
              .then((r) => r.data),
          300
        );
        reviewedUsers = rawReviews
          .map((r) => r.user?.login)
          .filter((login): login is string => Boolean(login));
      } catch (err) {
        errors.push(`Reviews: ${handleGitHubError(err)}`);
      }

      ownershipFindings = generateOwnershipFindings(
        files,
        rules,
        requestedUsers,
        requestedTeams,
        reviewedUsers,
        prMeta.author
      );
    }
  }

  const rawFindings = [...generateFindings(prMeta, files, params.standard), ...ownershipFindings];
  const sorted = sortFindings(rawFindings);

  const hasTests = files.some(
    (f) =>
      f.filename.includes("/test") ||
      f.filename.includes("/spec") ||
      f.filename.includes("__tests__") ||
      /\.(test|spec)\.[jt]sx?$/.test(f.filename)
  );

  const totalLines = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  const critical = sorted.filter((f) => f.severity === "critical");
  const high = sorted.filter((f) => f.severity === "high");
  const medium = sorted.filter((f) => f.severity === "medium");

  const conclusion: ReviewPrResult["conclusion"] =
    critical.length > 0 || high.length > 0
      ? "needs_changes"
      : medium.length > 0
      ? "risky_but_acceptable"
      : "pass";

  const conclusionLabel =
    conclusion === "pass"
      ? "PASS"
      : conclusion === "needs_changes"
      ? "NEEDS CHANGES"
      : "RISKY BUT ACCEPTABLE";

  const structured: ReviewPrResult = {
    pullNumber: pr.number,
    title: pr.title,
    standard: params.standard,
    conclusion,
    findings: sorted,
    hasTests,
    totalChangedLines: totalLines,
    codeownersFound,
    errors,
  };

  const lines: string[] = [
    `# PR Review: #${pr.number} -- ${pr.title}`,
    "",
    `**Standard:** ${params.standard}`,
    `**Conclusion:** ${conclusionLabel}`,
    `**Findings:** ${sorted.length} total (${critical.length} critical, ${high.length} high, ${medium.length} medium)`,
    `**CODEOWNERS:** ${params.checkOwnership ? (codeownersFound ? "found, ownership checked" : "not found -- ownership not checked") : "checkOwnership disabled"}`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("## Notes", "");
    errors.forEach((e) => lines.push(`- ${e}`));
    lines.push("");
  }

  lines.push("## Findings");

  if (sorted.length === 0) {
    lines.push("", "No findings -- looks good!");
  } else {
    for (const f of sorted) {
      lines.push(
        "",
        `### ${severityIcon(f.severity)} [${f.severity.toUpperCase()}] ${f.category}: ${f.description}`,
        f.suggestion ? `> Suggestion: ${f.suggestion}` : ""
      );
    }
  }

  lines.push(
    "",
    "## Test Coverage",
    hasTests ? "Tests included." : "No test files detected in this PR.",
    "",
    "## Release Risk",
    conclusion === "pass"
      ? "Low risk -- safe to merge after review."
      : conclusion === "risky_but_acceptable"
      ? "Moderate risk -- address medium findings before release."
      : "High risk -- must fix critical/high findings before merging.",
    "",
    "## Conclusion",
    conclusionLabel
  );

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerReviewPrTool(server: McpServer): void {
  server.registerTool(
    "review_pr_against_standard",
    {
      title: "Review PR Against SDLC Standard",
      description: `Review a pull request against Agentic SDLC standards.

Standards:
  - basic: Core checks (tests, description, draft status, commit count)
  - strict: basic + large diff detection, missing docs
  - security-focused: strict + patch scanning for secret patterns, .env files, lockfile changes, dist files

Ownership check (independent of standard, runs when checkOwnership is true and a CODEOWNERS file exists):
  Matches changed files against .github/CODEOWNERS (or CODEOWNERS / docs/CODEOWNERS), and flags any
  matched owner who is neither the PR author, a requested reviewer, nor an actual reviewer.

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number): The PR to review.
  - standard: "basic" | "strict" | "security-focused". Default: "basic".
  - checkOwnership (boolean, default: true): Enable the CODEOWNERS ownership check.

Returns: Sorted findings by severity, test coverage signal, ownership routing gaps, release risk, and conclusion.`,
      inputSchema: ReviewPrInputSchema,
      outputSchema: ReviewPrOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ReviewPrInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleReviewPr(params, ref, octokit);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: handleGitHubError(error) }],
        };
      }
    }
  );
}

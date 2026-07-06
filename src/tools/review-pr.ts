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
});

export type ReviewPrInput = z.infer<typeof ReviewPrInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const ReviewPrOutputSchema = {
  pullNumber: z.number().int(),
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
  missingTests: z.array(z.string()),
  securityConcerns: z.array(z.string()),
  docsImpact: z.string(),
  releaseRisk: z.string(),
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
  };

  const rawFindings = generateFindings(prMeta, files, params.standard);
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
  };

  const lines: string[] = [
    `# PR Review: #${pr.number} -- ${pr.title}`,
    "",
    `**Standard:** ${params.standard}`,
    `**Conclusion:** ${conclusionLabel}`,
    `**Findings:** ${sorted.length} total (${critical.length} critical, ${high.length} high, ${medium.length} medium)`,
    "",
    "## Findings",
  ];

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

Args:
  - owner, repo: Repository coordinates.
  - pullNumber (number): The PR to review.
  - standard: "basic" | "strict" | "security-focused". Default: "basic".

Returns: Sorted findings by severity, test coverage signal, release risk, and conclusion.`,
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

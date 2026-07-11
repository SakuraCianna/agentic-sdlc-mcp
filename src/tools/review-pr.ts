/**
 * Tool: review_pr_against_standard
 *
 * Core logic extracted as `generateFindings` and `handleReviewPr` for testing.
 * security-focused mode inspects actual patch lines for suspicious patterns.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, getOctokit, handleGitHubError } from "../github/client.js";
import { collectPullRequestEvidence } from "../github/pull-request-evidence.js";
import {
  fetchCodeownersRules,
  findOwnershipGaps,
  type CodeownersRule,
  type OwnershipGap,
} from "../github/codeowners.js";
import type { Finding, Severity, RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";
import {
  evaluateSecretScannerEvidence,
  isSecretScannerPolicyPath,
  type SecretScannerEvidence,
} from "../security/secret-scanner-evidence.js";
import {
  evaluatePullRequestReview,
  scanPatchForSecrets as scanSharedPatchForSecrets,
  type ReviewDimension,
  type StructuredReviewFinding,
} from "../review/pull-request-review.js";
import {
  evaluateWorkflowContents,
  MAX_WORKFLOW_FILES,
  type WorkflowContent,
} from "./workflow-permissions-audit.js";

export {
  codeownersPatternMatches,
  fetchCodeownersRules,
  ownersForFile,
  parseCodeowners,
} from "../github/codeowners.js";
export type { CodeownersRule } from "../github/codeowners.js";

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
  workType: z
    .enum(["docs", "feature", "bugfix", "refactor", "security", "release", "infra"])
    .optional()
    .describe("Optional explicit work type. When omitted, it is inferred from PR metadata and paths."),
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
      suggestion: z.string(),
      dimension: z.enum(["intent", "scope", "evidence", "ownership", "policy", "fallback", "security"]),
      paths: z.array(z.string()),
      reason: z.string(),
    })
  ),
  hasTests: z.boolean(),
  totalChangedLines: z.number().int(),
  codeownersFound: z.boolean(),
  workType: z.enum(["docs", "feature", "bugfix", "refactor", "security", "release", "infra"]),
  workTypeConfidence: z.enum(["high", "medium", "low"]),
  workTypeReasoning: z.string(),
  releaseRisk: z.enum(["low", "moderate", "high", "critical"]),
  testCoverageSignal: z.enum(["adequate", "missing", "not_required", "insufficient_evidence"]),
  ownershipRoutingGaps: z.array(z.object({ owner: z.string(), paths: z.array(z.string()) })),
  errors: z.array(z.string()),
  secretScannerEvidence: z
    .object({
      status: z.enum(["passing", "failing", "pending", "unverified"]),
      verified: z.boolean(),
      degraded: z.boolean(),
      providers: z.array(
        z.enum([
          "gitleaks",
          "trufflehog",
          "secretlint",
          "detect-secrets",
          "github-secret-scanning",
        ])
      ),
      signals: z.array(
        z.object({
          name: z.string(),
          provider: z.enum([
            "gitleaks",
            "trufflehog",
            "secretlint",
            "detect-secrets",
            "github-secret-scanning",
          ]),
          source: z.enum(["check_run", "commit_status"]),
          appId: z.number().int().nullable(),
          trusted: z.boolean(),
          state: z.enum(["passing", "failing", "pending", "skipped"]),
          url: z.string().nullable(),
        })
      ),
      reason: z.string(),
    })
    .nullable(),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewPrResult {
  pullNumber: number;
  title: string;
  standard: string;
  conclusion: "pass" | "needs_changes" | "risky_but_acceptable";
  findings: StructuredReviewFinding[];
  hasTests: boolean;
  totalChangedLines: number;
  codeownersFound: boolean;
  workType: "docs" | "feature" | "bugfix" | "refactor" | "security" | "release" | "infra";
  workTypeConfidence: "high" | "medium" | "low";
  workTypeReasoning: string;
  releaseRisk: "low" | "moderate" | "high" | "critical";
  testCoverageSignal: "adequate" | "missing" | "not_required" | "insufficient_evidence";
  ownershipRoutingGaps: OwnershipGap[];
  errors: string[];
  secretScannerEvidence: SecretScannerEvidence | null;
}

/** Minimal shape from octokit pulls.listFiles we care about */
export interface PrFile {
  filename: string;
  previousFilename?: string;
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
 * Backward-compatible wrapper around the shared heuristic scanner.
 * Mature scanner evidence is evaluated separately from CI check runs.
 */
export function scanPatchForSecrets(filename: string, patch: string | undefined): Finding[] {
  return scanSharedPatchForSecrets(filename, patch).map((item) => ({
    severity: item.severity,
    category: "Security",
    description: item.description,
    suggestion: item.suggestion,
  }));
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
// CODEOWNERS finding presentation
// ---------------------------------------------------------------------------

function ownershipGapsToFindings(gaps: OwnershipGap[]): Finding[] {
  return gaps.map(({ owner, paths }) =>
    ({
      severity: "medium",
      category: "Ownership",
      description: `CODEOWNERS owner ${owner} was not requested as a reviewer and has not reviewed changes to: ${paths.join(", ")}.`,
      suggestion: `Request a review from ${owner}, or confirm CODEOWNERS routing is still correct for these paths.`,
    })
  );
}

/**
 * @deprecated Import `findOwnershipGaps` from `../github/codeowners.js` for shared routing logic.
 */
export function generateOwnershipFindings(
  files: PrFile[],
  rules: CodeownersRule[],
  requestedUsers: string[],
  requestedTeams: string[],
  reviewedUsers: string[],
  prAuthor: string
): Finding[] {
  return ownershipGapsToFindings(
    findOwnershipGaps(
      files.map((file) => file.filename),
      rules,
      requestedUsers,
      requestedTeams,
      reviewedUsers,
      prAuthor
    )
  );
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleReviewPr(
  params: ReviewPrInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: ReviewPrResult }> {
  const evidence = await collectPullRequestEvidence(
    { pullNumber: params.pullNumber },
    ref,
    octokit
  );
  const files: PrFile[] = evidence.changedFiles;
  const errors = evidence.errors.map((error) => {
    if (error.startsWith("requested_reviewers:")) {
      return `Requested reviewers:${error.slice("requested_reviewers:".length)}`;
    }
    if (error.startsWith("reviews:")) return `Reviews:${error.slice("reviews:".length)}`;
    if (error.startsWith("codeowners:")) return `CODEOWNERS:${error.slice("codeowners:".length)}`;
    if (
      params.standard === "security-focused" &&
      (error.startsWith("check_runs:") || error.startsWith("commit_statuses:"))
    ) {
      return `Secret scanner CI: ${error}`;
    }
    return error;
  });

  const workflowContents: WorkflowContent[] = [];
  const unverifiedWorkflowPaths: string[] = [];
  const changedWorkflows = files.filter(
    (file) =>
      file.status !== "removed" &&
      /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file.filename)
  );
  if (changedWorkflows.length > MAX_WORKFLOW_FILES) {
    errors.push(
      `Workflow permissions: only the first ${MAX_WORKFLOW_FILES} of ${changedWorkflows.length} changed workflows were audited.`
    );
    unverifiedWorkflowPaths.push(
      ...changedWorkflows.slice(MAX_WORKFLOW_FILES).map((file) => file.filename)
    );
  }
  for (const file of changedWorkflows.slice(0, MAX_WORKFLOW_FILES)) {
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path: file.filename,
        ref: evidence.pullRequest.headSha,
      });
      if (Array.isArray(data) || data.type !== "file" || !data.content) {
        errors.push(`Workflow permissions: ${file.filename}: unexpected content response.`);
        unverifiedWorkflowPaths.push(file.filename);
        continue;
      }
      workflowContents.push({
        filename: file.filename,
        content: Buffer.from(data.content, "base64").toString("utf-8"),
      });
    } catch (error) {
      errors.push(`Workflow permissions: ${file.filename}: ${handleGitHubError(error)}`);
      unverifiedWorkflowPaths.push(file.filename);
    }
  }
  const workflowEvaluation = evaluateWorkflowContents(workflowContents);
  errors.push(...workflowEvaluation.errors.map((error) => `Workflow permissions: ${error}`));
  const scannedWorkflows = new Set(workflowEvaluation.workflowsScanned);
  unverifiedWorkflowPaths.push(
    ...workflowContents
      .filter((workflow) => !scannedWorkflows.has(workflow.filename))
      .map((workflow) => workflow.filename)
  );

  const ownershipRoutingGaps = params.checkOwnership ? evidence.reviews.ownershipGaps : [];
  const ownershipPolicyFindings: StructuredReviewFinding[] = ownershipRoutingGaps.map(
    ({ owner, paths }) => ({
      severity: "medium",
      category: "Ownership",
      description: `CODEOWNERS owner ${owner} was not requested as a reviewer and has not reviewed changes to: ${paths.join(", ")}.`,
      suggestion: `Request a review from ${owner}, or confirm CODEOWNERS routing is still correct for these paths.`,
      dimension: "ownership",
      paths,
      reason: "The shared PR evidence layer found an unsatisfied CODEOWNERS routing requirement.",
    })
  );
  const workflowPolicyFindings: StructuredReviewFinding[] = workflowEvaluation.findings.map(
    (finding) => {
      const workflow = workflowContents.find((item) =>
        finding.description.startsWith(`${item.filename}:`)
      );
      return {
        ...finding,
        suggestion: finding.suggestion ?? "Review and reduce the workflow token permissions.",
        dimension: "policy",
        paths: workflow ? [workflow.filename] : [],
        reason: "The finding was derived from the complete workflow content at the PR head SHA.",
      };
    }
  );
  const uniqueUnverifiedWorkflowPaths = [...new Set(unverifiedWorkflowPaths)];
  if (uniqueUnverifiedWorkflowPaths.length > 0) {
    workflowPolicyFindings.push({
      severity: "high",
      category: "WorkflowPolicyEvidenceUnavailable",
      description: "Complete workflow permission evidence could not be verified for every changed workflow.",
      suggestion: "Restore repository content access and provide parseable complete workflow files at the PR head SHA before merge.",
      dimension: "policy",
      paths: uniqueUnverifiedWorkflowPaths,
      reason: "Fetching, parsing, or the bounded workflow audit failed, so least-privilege policy cannot be confirmed.",
    });
  }
  if (evidence.unverifiedSignals.includes("changed_files")) {
    workflowPolicyFindings.push({
      severity: "high",
      category: "WorkflowPolicyEvidenceUnavailable",
      description: "The changed-file list is incomplete, so a workflow policy change may be hidden beyond the collection limit.",
      suggestion: "Reduce or split the PR so every changed file can be enumerated and all workflow content can be audited before merge.",
      dimension: "policy",
      paths: [],
      reason: "GitHub returned more than the bounded changed-file limit or the changed-file source could not be verified.",
    });
  }

  const secretScannerEvidence =
    params.standard === "security-focused"
      ? evaluateSecretScannerEvidence(evidence.ci, {
          policyFilesChanged: files.some(
            (file) =>
              isSecretScannerPolicyPath(file.filename) ||
              (file.previousFilename !== undefined &&
                isSecretScannerPolicyPath(file.previousFilename))
          ),
          incompleteReasons: evidence.unverifiedSignals.includes("changed_files")
            ? ["changed_files"]
            : [],
        })
      : null;

  const review = evaluatePullRequestReview({
    pr: {
      title: evidence.pullRequest.title,
      body: evidence.pullRequest.body,
      labels: evidence.pullRequest.labels,
      draft: evidence.pullRequest.draft,
      commits: evidence.pullRequest.commits,
    },
    files,
    workType: params.workType,
    standard: params.standard,
    secretScannerEvidence: secretScannerEvidence ?? undefined,
    policyFindings: [...ownershipPolicyFindings, ...workflowPolicyFindings],
  });
  const structured: ReviewPrResult = {
    pullNumber: evidence.pullRequest.number,
    title: evidence.pullRequest.title,
    standard: params.standard,
    conclusion: review.conclusion,
    findings: review.findings,
    hasTests: review.hasTests,
    totalChangedLines: review.totalChangedLines,
    codeownersFound: params.checkOwnership && evidence.reviews.codeownersFound === true,
    workType: review.workType,
    workTypeConfidence: review.workTypeConfidence,
    workTypeReasoning: review.workTypeReasoning,
    releaseRisk: review.releaseRisk,
    testCoverageSignal: review.testCoverageSignal,
    ownershipRoutingGaps,
    errors,
    secretScannerEvidence: review.secretScannerEvidence,
  };
  const conclusionLabel =
    structured.conclusion === "pass"
      ? "PASS"
      : structured.conclusion === "needs_changes"
        ? "NEEDS CHANGES"
        : "RISKY BUT ACCEPTABLE";
  const lines: string[] = [
    `# PR Review: #${structured.pullNumber} -- ${structured.title}`,
    "",
    `**Standard:** ${params.standard}`,
    `**Conclusion:** ${conclusionLabel}`,
    `**Findings:** ${structured.findings.length} total`,
    `**CODEOWNERS:** ${params.checkOwnership ? (structured.codeownersFound ? "found, ownership checked" : "not found -- ownership not checked") : "checkOwnership disabled"}`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("## Notes", "");
    errors.forEach((e) => lines.push(`- ${e}`));
    lines.push("");
  }

  lines.push(
    "## Work Type",
    "",
    `**${structured.workType}** (${structured.workTypeConfidence} confidence) -- ${structured.workTypeReasoning}`,
    ""
  );
  const renderSection = (title: string, dimensions: ReviewDimension[]): void => {
    lines.push(`## ${title}`, "");
    const findings = structured.findings.filter((finding) => dimensions.includes(finding.dimension));
    if (findings.length === 0) lines.push("No findings.");
    for (const finding of findings) {
      lines.push(
        `### ${severityIcon(finding.severity)} [${finding.severity.toUpperCase()}] ${finding.category}`,
        finding.description,
        `- Paths: ${finding.paths.join(", ") || "none"}`,
        `- Reason: ${finding.reason}`,
        `> Suggestion: ${finding.suggestion}`,
        ""
      );
    }
    lines.push("");
  };
  renderSection("Intent / Scope / Evidence", ["intent", "scope", "evidence"]);
  renderSection("Ownership", ["ownership"]);
  renderSection("Policy", ["policy"]);
  renderSection("Fallback", ["fallback"]);
  renderSection("Security", ["security"]);
  if (structured.secretScannerEvidence) {
    lines.push(
      "### Mature Secret Scanner Evidence",
      `- Status: **${structured.secretScannerEvidence.status}**`,
      `- Providers: ${structured.secretScannerEvidence.providers.join(", ") || "none"}`,
      `- Verified: ${structured.secretScannerEvidence.verified ? "yes" : "no"}`,
      `- Reason: ${structured.secretScannerEvidence.reason}`,
      ""
    );
  }
  lines.push(
    "## Test Coverage",
    `**${structured.testCoverageSignal}** -- ${structured.hasTests ? "test files changed" : "no test files changed"}.`,
    "",
    "## Release Risk",
    `**${structured.releaseRisk}**`,
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
  - security-focused: strict + mature secret-scanner CI evidence + supplemental patch heuristics, .env files, lockfile changes, dist files

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

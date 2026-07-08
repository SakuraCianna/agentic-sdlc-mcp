/**
 * Tool: plan_from_context
 *
 * Handler extracted as `buildPlan` and `handlePlanFromContext` for testing.
 *
 * Supports `workType` (docs/feature/bugfix/refactor/security/release/infra):
 * each type gets a distinct phase-by-phase template rather than one
 * one-size-fits-all plan -- a docs-only task should not default to requiring
 * code unit tests, while a bugfix task must always include repro + regression
 * tests. When the caller does not pass `workType` explicitly, it is inferred
 * from `goal` + `acceptanceCriteria` via a conservative keyword heuristic
 * (see `inferWorkType`), and the inference itself (confidence, reasoning,
 * whether clarification is needed) is surfaced in the output rather than
 * hidden -- callers should not have to trust a silent guess.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveRepo, handleGitHubError } from "../github/client.js";
import { fetchRepoContext } from "../github/context.js";
import type { SdlcPlanPhase, SdlcWorkType } from "../types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WORK_TYPES = ["docs", "feature", "bugfix", "refactor", "security", "release", "infra"] as const;

export const PlanFromContextInputSchema = z.object({
  goal: z.string().min(5).describe("The user goal or feature request to plan around."),
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  workType: z
    .enum(WORK_TYPES)
    .optional()
    .describe(
      "Explicit task category: docs, feature, bugfix, refactor, security, release, or infra. " +
        "If omitted, it is inferred from `goal` + `acceptanceCriteria` -- check the output's " +
        "`confidence` and `needsClarification` fields rather than assuming the guess is correct."
    ),
  constraints: z.array(z.string()).optional()
    .describe("Technical or business constraints."),
  acceptanceCriteria: z.array(z.string()).optional()
    .describe("Acceptance criteria the implementation must satisfy."),
});

export type PlanFromContextInput = z.infer<typeof PlanFromContextInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const PlanFromContextOutputSchema = {
  goal: z.string(),
  repo: z.string(),
  defaultBranch: z.string(),
  language: z.string().nullable(),
  workType: z.enum(WORK_TYPES),
  confidence: z.enum(["high", "medium", "low"]),
  reasoning: z.string(),
  needsClarification: z.boolean(),
  constraints: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  phases: z.array(
    z.object({
      phase: z.string(),
      summary: z.string(),
      tasks: z.array(z.string()),
    })
  ),
  suggestedIssues: z.array(z.string()),
  risks: z.array(z.string()),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanFromContextResult {
  goal: string;
  repo: string;
  defaultBranch: string;
  language: string | null;
  workType: SdlcWorkType;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  needsClarification: boolean;
  constraints: string[];
  acceptanceCriteria: string[];
  phases: SdlcPlanPhase[];
  suggestedIssues: string[];
  risks: string[];
}

export interface WorkTypeInference {
  workType: SdlcWorkType;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  needsClarification: boolean;
}

// ---------------------------------------------------------------------------
// workType inference (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Keyword signals per non-`feature` work type, English + Chinese (this project
 * ships bilingual docs, and goals are often phrased in either language). `feature`
 * has no keyword list -- it is the fallback when no other category matches,
 * since "add"/"implement"-style phrasing is too generic to score reliably.
 *
 * English entries are matched as whole words/phrases (see `hasWholeWordMatch`),
 * so common inflections ("fix" -> "fixes"/"fixed", "permission" -> "permissions")
 * are listed explicitly rather than relying on a bare stem match, which would
 * also match unrelated words like "prefix" or "fixed-price".
 */
const WORK_TYPE_KEYWORDS: Record<Exclude<SdlcWorkType, "feature">, string[]> = {
  docs: ["document", "documents", "documentation", "docs", "readme", "guide", "文档", "说明文档", "教程", "指南"],
  bugfix: [
    "bugfix",
    "bug",
    "bugs",
    "fix",
    "fixes",
    "broken",
    "regression",
    "crash",
    "crashes",
    "not working",
    "修复",
    "缺陷",
    "报错",
    "崩溃",
    "回归",
  ],
  refactor: ["refactor", "refactoring", "restructure", "cleanup", "simplify", "reorganize", "重构", "简化", "整理"],
  security: [
    "security",
    "secure",
    "vulnerable",
    "vulnerability",
    "vulnerabilities",
    "secret",
    "secrets",
    "permission",
    "permissions",
    "audit",
    "exploit",
    "cve",
    "安全",
    "漏洞",
    "权限",
    "密钥",
    "审计",
  ],
  release: ["release", "changelog", "rollback", "发布", "版本", "回滚", "变更日志"],
  infra: [
    "workflow",
    "workflows",
    "pipeline",
    "ci/cd",
    "infrastructure",
    "deploy",
    "deployment",
    "docker",
    "terraform",
    "github actions",
    "工作流",
    "基础设施",
    "部署",
    "流水线",
  ],
};

/** Keywords made up entirely of CJK ideographs -- matched as a plain substring (see `hasWholeWordMatch`). */
const CJK_KEYWORD_PATTERN = /^[一-鿿]+$/;

/** Tie-break priority when multiple categories score equally (first wins), matching the ROADMAP's listed order. */
const WORK_TYPE_PRIORITY: Array<Exclude<SdlcWorkType, "feature">> = [
  "docs",
  "bugfix",
  "refactor",
  "security",
  "release",
  "infra",
];

/** Characters that count as "word-ish" for the purposes of an English word-boundary check. */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /[a-z0-9]/i.test(ch);
}

/**
 * True if `keyword` occurs in `text` as a whole word/phrase -- i.e. not
 * immediately preceded or followed by another word character. Plain
 * `String.includes` would let short English keywords like "fix" or "secret"
 * match inside unrelated words ("prefix", "fixed-price", "secret santa"),
 * silently mis-categorising ordinary feature requests as bugfix/security.
 *
 * Pure-CJK keywords (e.g. "修复") are matched as a plain substring instead:
 * Chinese text has no whitespace between words, so every character adjacent
 * to a CJK match is itself a "word character" and a Latin-style boundary
 * check would never succeed. Multi-character CJK keywords are specific
 * enough on their own that substring matching does not meaningfully
 * increase the false-positive rate here.
 */
function hasWholeWordMatch(text: string, keyword: string): boolean {
  if (CJK_KEYWORD_PATTERN.test(keyword)) {
    return text.includes(keyword);
  }

  let fromIndex = 0;
  while (true) {
    const idx = text.indexOf(keyword, fromIndex);
    if (idx === -1) return false;
    const before = idx > 0 ? text[idx - 1] : undefined;
    const after = idx + keyword.length < text.length ? text[idx + keyword.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    fromIndex = idx + 1;
  }
}

function countKeywordMatches(text: string, keywords: string[]): number {
  return keywords.reduce((n, kw) => (hasWholeWordMatch(text, kw) ? n + 1 : n), 0);
}

/**
 * Infer a `workType` from free-text goal + acceptance criteria when the caller
 * did not pass one explicitly. Conservative by design: ties or zero signal
 * fall back to `feature` with `needsClarification: true` rather than guessing
 * confidently, so callers know to double-check rather than trust a silent
 * default.
 */
export function inferWorkType(
  goal: string,
  acceptanceCriteria: string[],
  explicit?: SdlcWorkType
): WorkTypeInference {
  if (explicit) {
    return {
      workType: explicit,
      confidence: "high",
      reasoning: "workType was explicitly provided by the caller.",
      needsClarification: false,
    };
  }

  const text = [goal, ...acceptanceCriteria].join(" ").toLowerCase();
  const scored = WORK_TYPE_PRIORITY.map((wt) => ({
    workType: wt,
    score: countKeywordMatches(text, WORK_TYPE_KEYWORDS[wt]),
  }));
  const maxScore = Math.max(...scored.map((s) => s.score));

  if (maxScore === 0) {
    return {
      workType: "feature",
      confidence: "low",
      reasoning:
        "No docs/bugfix/refactor/security/release/infra keyword signals were found in the goal or " +
        "acceptance criteria; defaulting to \"feature\". Pass `workType` explicitly if this is wrong.",
      needsClarification: true,
    };
  }

  const topMatches = scored.filter((s) => s.score === maxScore);
  const picked = topMatches[0]!.workType;

  if (topMatches.length > 1) {
    return {
      workType: picked,
      confidence: "low",
      reasoning:
        `Multiple work types matched with equal signal (${topMatches.map((m) => m.workType).join(", ")}); ` +
        `defaulting to "${picked}". Pass \`workType\` explicitly to disambiguate.`,
      needsClarification: true,
    };
  }

  return {
    workType: picked,
    confidence: maxScore >= 2 ? "high" : "medium",
    reasoning: `Matched ${maxScore} keyword(s) associated with "${picked}" in the goal/acceptance criteria.`,
    needsClarification: false,
  };
}

// ---------------------------------------------------------------------------
// Phase templates (pure data, one per workType)
// ---------------------------------------------------------------------------

type PhaseTaskMap = Record<
  "plan" | "create" | "test" | "review" | "optimize" | "secure",
  { tasks: string[] }
>;

const PHASE_TEMPLATES_BY_WORK_TYPE: Record<SdlcWorkType, PhaseTaskMap> = {
  feature: {
    plan: {
      tasks: [
        "Clarify requirements and acceptance criteria",
        "Identify affected components and files",
        "Define API contracts or data model changes",
        "Review existing tests and coverage",
        "List risks and unknowns",
      ],
    },
    create: {
      tasks: [
        "Create a feature branch from the default branch",
        "Implement the required changes",
        "Add unit tests for new logic",
        "Update inline documentation and comments",
      ],
    },
    test: {
      tasks: [
        "Run the full test suite locally",
        "Verify no regression in existing tests",
        "Write integration tests if applicable",
        "Test edge cases and error paths",
      ],
    },
    review: {
      tasks: [
        "Create a pull request with a clear description",
        "Self-review the diff for unintended changes",
        "Request review from at least one team member",
        "Address all review comments",
      ],
    },
    optimize: {
      tasks: [
        "Profile the affected code path if performance-sensitive",
        "Look for obvious algorithmic improvements",
        "Ensure no unnecessary dependencies were added",
      ],
    },
    secure: {
      tasks: [
        "Run Dependabot or dependency audit",
        "Check for secret leakage in diffs",
        "Verify input validation and error handling",
        "Review access control changes if any",
      ],
    },
  },

  docs: {
    plan: {
      tasks: [
        "Read existing README/docs and identify gaps",
        "Clarify terminology and target audience",
        "List acceptance criteria for the documentation change",
      ],
    },
    create: {
      tasks: [
        "Write or update the documentation",
        "Add or update examples",
        "Check terminology consistency across docs",
      ],
    },
    test: {
      tasks: [
        "Verify all code snippets and commands in the docs are runnable",
        "Check for broken links and outdated references",
        "Run a diff/lint check for formatting issues (e.g. `git diff --check`)",
      ],
    },
    review: {
      tasks: [
        "Open a PR describing what changed and why",
        "Self-review rendered markdown for formatting issues",
        "Confirm no unrelated content changes were bundled in",
      ],
    },
    optimize: {
      tasks: ["Trim redundant sections", "Ensure consistent heading structure"],
    },
    secure: {
      tasks: [
        "Confirm no secrets, tokens, or credentials appear in the docs",
        "Verify no internal-only URLs or private information are exposed",
      ],
    },
  },

  bugfix: {
    plan: {
      tasks: [
        "Reproduce the bug reliably and document exact repro steps",
        "Identify the root cause, not just the symptom",
        "Determine blast radius: what else might be affected",
      ],
    },
    create: {
      tasks: [
        "Implement the minimal fix for the root cause",
        "Avoid unrelated refactors in the same change",
        "Add a regression test that fails before the fix and passes after",
      ],
    },
    test: {
      tasks: [
        "Run the new regression test plus the full existing suite",
        "Verify the original repro steps no longer reproduce the bug",
        "Check related edge cases the same root cause might affect",
      ],
    },
    review: {
      tasks: [
        "Explain the root cause and fix approach in the PR description",
        "Link the bug report / issue",
        "Confirm the regression test is included in the diff",
      ],
    },
    optimize: {
      tasks: ["Confirm the fix does not introduce a performance regression"],
    },
    secure: {
      tasks: [
        "Confirm the bug was not itself a security issue (escalate if it was)",
        "Check whether the same root cause exists elsewhere in the codebase",
      ],
    },
  },

  refactor: {
    plan: {
      tasks: [
        "Confirm current behaviour is fully covered by existing tests before changing anything",
        "Define the target structure and why it is better",
        "Confirm no public API / contract changes are intended",
      ],
    },
    create: {
      tasks: [
        "Make the change in small, reviewable, incremental commits",
        "Keep behaviour identical -- no functional changes bundled in",
      ],
    },
    test: {
      tasks: [
        "Run the full existing test suite after every incremental commit",
        "Add characterization tests first if coverage is insufficient",
        "Confirm no observable behaviour changed",
      ],
    },
    review: {
      tasks: [
        "Explain in the PR why the refactor is worth the risk",
        "Highlight any public API surface touched, even if unchanged in behaviour",
        "Call out anything intentionally left out of scope",
      ],
    },
    optimize: {
      tasks: ["Check whether the refactor incidentally improves or regresses performance"],
    },
    secure: {
      tasks: ["Confirm no access-control or validation logic was silently altered"],
    },
  },

  security: {
    plan: {
      tasks: [
        "Define the threat model: what is being protected, from whom",
        "Identify affected permissions, secrets, and trust boundaries",
        "List the specific attack scenarios this change should close",
      ],
    },
    create: {
      tasks: [
        "Implement the fix with least-privilege as the default",
        "Avoid introducing new secrets or credentials in code or config",
        "Add input validation at trust boundaries",
      ],
    },
    test: {
      tasks: [
        "Add tests for the specific attack scenarios identified in Plan",
        "Test both the vulnerable-input and legitimate-input paths",
        "Run a dependency audit (npm audit or equivalent) for related packages",
      ],
    },
    review: {
      tasks: [
        "Request a security-focused review, not just a functional one",
        "Confirm no secrets or credentials appear in the diff",
        "Document the before/after risk in the PR description",
      ],
    },
    optimize: {
      tasks: ["Confirm the fix does not degrade performance in a way that invites a new DoS vector"],
    },
    secure: {
      tasks: [
        "Re-run security_triage / workflow_permissions_audit as applicable",
        "Confirm the fix is deployed with least-privilege permissions",
        "Verify no other code path shares the same vulnerable pattern",
      ],
    },
  },

  release: {
    plan: {
      tasks: [
        "Confirm scope: what is included in this release and what is deferred",
        "Identify breaking changes and required migration notes",
        "Draft the version bump (semver) and rationale",
      ],
    },
    create: {
      tasks: [
        "Update CHANGELOG.md with all notable changes",
        "Bump the version in package.json / relevant manifests",
        "Prepare a release notes draft",
      ],
    },
    test: {
      tasks: [
        "Confirm CI is green on the release commit (quality_gate_status)",
        "Run the full test suite and smoke test on the release artifact",
        "Verify no open release-blocking issues remain",
      ],
    },
    review: {
      tasks: [
        "Get release approval from the designated release manager",
        "Confirm the rollback plan is documented and understood",
        "Verify tag naming matches the project convention",
      ],
    },
    optimize: {
      tasks: ["Confirm no debug/dev-only code paths are enabled in the release build"],
    },
    secure: {
      tasks: [
        "Run security_triage for open critical/high alerts before tagging",
        "Confirm no secrets are embedded in the release artifact",
        "Document the rollback plan (release_readiness_check template)",
      ],
    },
  },

  infra: {
    plan: {
      tasks: [
        "Identify affected workflows, environments, and permissions",
        "Define least-privilege target permissions for any token/credential involved",
        "Plan a rollback path before making the change",
      ],
    },
    create: {
      tasks: [
        "Implement the infra/workflow change with least-privilege permissions",
        "Avoid `write-all` or overly broad scopes",
        "Document any new environment variables or secrets required",
      ],
    },
    test: {
      tasks: [
        "Test the workflow change on a branch/PR before merging to the default branch",
        "Verify the change behaves correctly under both success and failure paths",
        "Confirm no secrets are printed to logs",
      ],
    },
    review: {
      tasks: [
        "Run workflow_permissions_audit on the changed workflow files",
        "Explain the blast radius if this workflow is compromised or misconfigured",
        "Confirm the rollback plan in the PR description",
      ],
    },
    optimize: {
      tasks: ["Confirm the change does not needlessly increase CI runtime or cost"],
    },
    secure: {
      tasks: [
        "Re-run workflow_permissions_audit after the change",
        "Confirm `pull_request_target` is not combined with write permissions",
        "Verify branch protection still enforces required checks after the change",
      ],
    },
  },
};

/** Per-workType suggested issue titles. The `feature` case matches the pre-workType default wording. */
function buildSuggestedIssues(goal: string, workType: SdlcWorkType): string[] {
  switch (workType) {
    case "docs":
      return [
        `[Plan] Identify documentation gaps and audience for: ${goal}`,
        `[Create] Write/update documentation for: ${goal}`,
        `[Test] Verify examples and links for: ${goal}`,
        `[Review] Proofread and confirm no sensitive info leaked for: ${goal}`,
      ];
    case "bugfix":
      return [
        `[Plan] Reproduce and identify root cause for: ${goal}`,
        `[Create] Implement minimal fix for: ${goal}`,
        `[Test] Add regression test for: ${goal}`,
        `[Review] Explain root cause and fix in the PR for: ${goal}`,
      ];
    case "refactor":
      return [
        `[Plan] Confirm existing test coverage before refactor: ${goal}`,
        `[Create] Refactor incrementally with no behaviour change: ${goal}`,
        `[Test] Confirm full suite passes after each commit: ${goal}`,
        `[Review] Explain refactor rationale and API impact: ${goal}`,
      ];
    case "security":
      return [
        `[Plan] Define threat model for: ${goal}`,
        `[Create] Implement least-privilege fix for: ${goal}`,
        `[Test] Add attack-scenario tests for: ${goal}`,
        `[Secure] Security review and re-audit for: ${goal}`,
      ];
    case "release":
      return [
        `[Plan] Confirm release scope and breaking changes for: ${goal}`,
        `[Create] Update CHANGELOG and bump version for: ${goal}`,
        `[Test] Confirm CI green and smoke test for: ${goal}`,
        `[Secure] Run security triage before tagging: ${goal}`,
      ];
    case "infra":
      return [
        `[Plan] Identify affected workflows/permissions for: ${goal}`,
        `[Create] Implement least-privilege infra change for: ${goal}`,
        `[Test] Test workflow on a branch before merge for: ${goal}`,
        `[Review] Run workflow_permissions_audit for: ${goal}`,
      ];
    case "feature":
    default:
      return [
        `[Plan] Define acceptance criteria and technical approach for: ${goal}`,
        `[Create] Implement: ${goal}`,
        `[Test] Add tests for: ${goal}`,
        `[Secure] Security review for: ${goal}`,
      ];
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Build the phase-by-phase plan for a given workType (defaults to "feature" for backward compatibility). Pure -- no I/O. */
export function buildPlan(
  goal: string,
  repoName: string,
  workType: SdlcWorkType = "feature"
): SdlcPlanPhase[] {
  const template = PHASE_TEMPLATES_BY_WORK_TYPE[workType] ?? PHASE_TEMPLATES_BY_WORK_TYPE.feature;
  return (Object.keys(template) as Array<keyof PhaseTaskMap>).map((phase) => ({
    phase,
    summary: `${phase.charAt(0).toUpperCase() + phase.slice(1)} phase for: ${goal} (${repoName})`,
    tasks: template[phase].tasks,
  }));
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handlePlanFromContext(
  params: PlanFromContextInput,
  fetchContext: typeof fetchRepoContext
): Promise<{ text: string; structured: PlanFromContextResult }> {
  const constraints = params.constraints ?? [];
  const acceptance = params.acceptanceCriteria ?? [];

  const ref = resolveRepo(params.owner, params.repo);
  const ctx = await fetchContext({ ...ref });

  const inference = inferWorkType(params.goal, acceptance, params.workType);
  const plan = buildPlan(params.goal, ctx.fullName, inference.workType);
  const suggestedIssues = buildSuggestedIssues(params.goal, inference.workType);

  const risks = [
    "Unknown scope may expand during implementation",
    "Existing tests may need updating",
    "Review latency may block the cycle",
  ];

  const structured: PlanFromContextResult = {
    goal: params.goal,
    repo: ctx.fullName,
    defaultBranch: ctx.defaultBranch,
    language: ctx.language ?? null,
    workType: inference.workType,
    confidence: inference.confidence,
    reasoning: inference.reasoning,
    needsClarification: inference.needsClarification,
    constraints,
    acceptanceCriteria: acceptance,
    phases: plan,
    suggestedIssues,
    risks,
  };

  const lines: string[] = [
    `# SDLC Plan: ${params.goal}`,
    "",
    `**Repository:** ${ctx.fullName}`,
    `**Default branch:** \`${ctx.defaultBranch}\``,
    `**Language:** ${ctx.language ?? "unknown"}`,
    `**Work type:** ${inference.workType} (confidence: ${inference.confidence})`,
    `**Reasoning:** ${inference.reasoning}`,
  ];

  if (inference.needsClarification) {
    lines.push(
      "",
      `> [NEEDS CLARIFICATION] Low confidence in the inferred work type ("${inference.workType}"). ` +
        "Consider passing `workType` explicitly, or confirm this categorisation before proceeding."
    );
  }

  lines.push("", "## Background", `Goal: **${params.goal}**`);

  if (constraints.length > 0) {
    lines.push("", "### Constraints");
    constraints.forEach((c) => lines.push(`- ${c}`));
  }

  if (acceptance.length > 0) {
    lines.push("", "### Acceptance Criteria");
    acceptance.forEach((a) => lines.push(`- ${a}`));
  }

  lines.push("", "## Phase-by-Phase Plan");
  for (const phase of plan) {
    lines.push(
      "",
      `### ${phase.phase.charAt(0).toUpperCase() + phase.phase.slice(1)}`,
      `*${phase.summary}*`,
      ""
    );
    phase.tasks.forEach((t) => lines.push(`- [ ] ${t}`));
  }

  lines.push(
    "",
    "## Suggested Issues to Create",
    "",
    "Use `create_issue_set` with these suggested issues:",
    ...suggestedIssues.map((s) => `- ${s}`),
    "",
    "## Risks",
    ...risks.map((r) => `- ${r}`),
    "",
    "## Human Approval Gates",
    "- PR review must be approved before merge",
    "- Security review required for auth/data-handling changes",
    "- Release checklist must pass before deployment"
  );

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPlanFromContextTool(server: McpServer): void {
  server.registerTool(
    "plan_from_context",
    {
      title: "Generate SDLC Plan from Context",
      description: `Generate a structured Agentic SDLC plan (Plan->Create->Test->Review->Optimize->Secure) from a goal and repo context. The plan is tailored to a \`workType\` (docs/feature/bugfix/refactor/security/release/infra) -- e.g. docs tasks do not default to requiring code unit tests, while bugfix tasks always include repro + regression tests.

Template-based -- no LLM call needed. Reads basic repo metadata to enrich the plan.

Args:
  - goal (string): The user's goal or feature description (required).
  - owner, repo: Repo coordinates (fall back to env vars).
  - workType (string?): Explicit task category. If omitted, inferred from goal + acceptanceCriteria -- check the output's \`confidence\`/\`needsClarification\` rather than assuming the guess is correct.
  - constraints (string[]?): Technical or business constraints.
  - acceptanceCriteria (string[]?): Explicit acceptance criteria.

Returns: Phase-by-phase SDLC plan tailored to the (inferred or explicit) work type, plus structured output including workType/confidence/reasoning/needsClarification.`,
      inputSchema: PlanFromContextInputSchema,
      outputSchema: PlanFromContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PlanFromContextInput) => {
      try {
        const { text, structured } = await handlePlanFromContext(params, fetchRepoContext);
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

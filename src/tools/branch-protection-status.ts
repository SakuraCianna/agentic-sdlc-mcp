/**
 * Tool: branch_protection_status
 *
 * Reads classic branch protection AND repository rulesets for a branch,
 * independently (mirrors security-triage.ts's per-source try/catch pattern
 * so a missing scope on one API doesn't blank out the other's findings).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  STRUCTURED_CONTENT_TRUST_META,
  StructuredContentTrustBoundarySchema,
  withStructuredContentTrustBoundary,
} from "../security/trust-boundary.js";
import { resolveRepo, getOctokit, paginateAll, handleGitHubError } from "../github/client.js";
import type { Finding, RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";
import { safeMarkdownInline } from "../rendering/markdown.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const BranchProtectionStatusInputSchema = z.object({
  owner: z.string().optional().describe("GitHub owner. Falls back to GITHUB_OWNER."),
  repo: z.string().optional().describe("GitHub repo. Falls back to GITHUB_REPO."),
  branch: z.string().optional().describe("Branch to inspect. Falls back to the repository's default branch."),
});

export type BranchProtectionStatusInput = z.infer<typeof BranchProtectionStatusInputSchema>;

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const BranchProtectionStatusOutputSchema = {
  trustBoundary: StructuredContentTrustBoundarySchema.optional(),
  repo: z.string(),
  branch: z.string(),
  classicProtectionEnabled: z.boolean(),
  requiredApprovingReviewCount: z.number().int().nullable(),
  requireCodeOwnerReviews: z.boolean().nullable(),
  requiredStatusCheckContexts: z.array(z.string()),
  enforceAdmins: z.boolean().nullable(),
  allowForcePushes: z.boolean().nullable(),
  allowDeletions: z.boolean().nullable(),
  requiredConversationResolution: z.boolean().nullable(),
  rulesetRuleTypes: z.array(z.string()),
  classicProtectionVerified: z.boolean(),
  rulesetsVerified: z.boolean(),
  verificationGaps: z.array(z.string()),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      category: z.string(),
      description: z.string(),
      suggestion: z.string().optional(),
    })
  ),
  errors: z.array(z.string()),
  conclusion: z.enum(["protected", "partially_protected", "unprotected", "unknown"]),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BranchProtectionStatusResult {
  repo: string;
  branch: string;
  classicProtectionEnabled: boolean;
  requiredApprovingReviewCount: number | null;
  requireCodeOwnerReviews: boolean | null;
  requiredStatusCheckContexts: string[];
  enforceAdmins: boolean | null;
  allowForcePushes: boolean | null;
  allowDeletions: boolean | null;
  requiredConversationResolution: boolean | null;
  rulesetRuleTypes: string[];
  classicProtectionVerified: boolean;
  rulesetsVerified: boolean;
  verificationGaps: string[];
  findings: Finding[];
  errors: string[];
  conclusion: "protected" | "partially_protected" | "unprotected" | "unknown";
}

// ---------------------------------------------------------------------------
// Pure helper (exported for testing)
// ---------------------------------------------------------------------------

export function computeConclusion(
  classicProtectionEnabled: boolean,
  rulesetRuleTypes: string[],
  findings: Finding[],
  absenceVerified = true
): BranchProtectionStatusResult["conclusion"] {
  if (!absenceVerified) return "unknown";
  if (!classicProtectionEnabled && rulesetRuleTypes.length === 0) {
    return "unprotected";
  }
  const hasCriticalOrHigh = findings.some((f) => f.severity === "critical" || f.severity === "high");
  return hasCriticalOrHigh ? "partially_protected" : "protected";
}

// ---------------------------------------------------------------------------
// Core handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleBranchProtectionStatus(
  params: BranchProtectionStatusInput,
  ref: RepoRef,
  octokit: Octokit
): Promise<{ text: string; structured: BranchProtectionStatusResult }> {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const verificationGaps: string[] = [];

  let branch = params.branch;
  if (!branch) {
    const { data: repoData } = await octokit.repos.get({ owner: ref.owner, repo: ref.repo });
    branch = repoData.default_branch;
  }

  let classicProtectionEnabled = false;
  let requiredApprovingReviewCount: number | null = null;
  let requireCodeOwnerReviews: boolean | null = null;
  let requiredStatusCheckContexts: string[] = [];
  let enforceAdmins: boolean | null = null;
  let allowForcePushes: boolean | null = null;
  let allowDeletions: boolean | null = null;
  let requiredConversationResolution: boolean | null = null;
  let classicProtectionVerified = false;

  try {
    const { data: protection } = await octokit.repos.getBranchProtection({
      owner: ref.owner,
      repo: ref.repo,
      branch,
    });
    classicProtectionVerified = true;
    classicProtectionEnabled = true;
    requiredApprovingReviewCount =
      protection.required_pull_request_reviews?.required_approving_review_count ?? null;
    requireCodeOwnerReviews = protection.required_pull_request_reviews?.require_code_owner_reviews ?? null;
    requiredStatusCheckContexts = protection.required_status_checks?.contexts ?? [];
    enforceAdmins = protection.enforce_admins?.enabled ?? null;
    allowForcePushes = protection.allow_force_pushes?.enabled ?? null;
    allowDeletions = protection.allow_deletions?.enabled ?? null;
    requiredConversationResolution = protection.required_conversation_resolution?.enabled ?? null;
  } catch (err) {
    const message = handleGitHubError(err);
    const status = (err as { status?: unknown }).status;
    const notConfigured = status === 404 || message.toLowerCase().includes("not found");
    classicProtectionVerified = notConfigured;
    if (!notConfigured) {
      verificationGaps.push("Classic branch protection could not be verified.");
    }
    errors.push(
      notConfigured
        ? `Classic branch protection: not configured for \`${branch}\`.`
        : `Classic branch protection: ${message}`
    );
  }

  let rulesetRuleTypes: string[] = [];
  let rulesetsVerified = false;
  try {
    const rules = await paginateAll(
      (page, perPage) =>
        octokit.repos
          .getBranchRules({ owner: ref.owner, repo: ref.repo, branch, per_page: perPage, page })
          .then((r) => r.data),
      200
    );
    rulesetRuleTypes = rules.map((r) => r.type);
    rulesetsVerified = true;
  } catch (err) {
    errors.push(`Rulesets: ${handleGitHubError(err)}`);
    verificationGaps.push("Repository rulesets could not be verified.");
  }

  const absenceVerified = classicProtectionVerified && rulesetsVerified;
  if (absenceVerified && !classicProtectionEnabled && rulesetRuleTypes.length === 0) {
    findings.push({
      severity: "critical",
      category: "Branch Protection",
      description: `Branch \`${branch}\` has no classic protection rules and no active rulesets.`,
      suggestion: "Configure required reviews and required status checks before allowing merges to this branch.",
    });
  }

  const hasRequiredReviews =
    (requiredApprovingReviewCount ?? 0) > 0 || rulesetRuleTypes.includes("pull_request");
  if (absenceVerified && !hasRequiredReviews) {
    findings.push({
      severity: "high",
      category: "Branch Protection",
      description: "No required pull request reviews are enforced before merging.",
      suggestion: "Require at least 1 approving review via classic protection or a ruleset `pull_request` rule.",
    });
  }

  const hasRequiredStatusChecks =
    requiredStatusCheckContexts.length > 0 || rulesetRuleTypes.includes("required_status_checks");
  if (absenceVerified && !hasRequiredStatusChecks) {
    findings.push({
      severity: "high",
      category: "Branch Protection",
      description: "No required status checks are enforced before merging.",
      suggestion: "Require CI to pass (classic `required_status_checks` or a ruleset rule) before merge.",
    });
  }

  const hasProtectionOfAnyKind = classicProtectionEnabled || rulesetRuleTypes.length > 0;
  const forcePushBlocked =
    (classicProtectionEnabled && allowForcePushes === false) || rulesetRuleTypes.includes("non_fast_forward");
  if (absenceVerified && hasProtectionOfAnyKind && !forcePushBlocked) {
    findings.push({
      severity: "high",
      category: "Branch Protection",
      description:
        "Force pushes are allowed on this branch (not blocked by classic protection or a ruleset `non_fast_forward` rule).",
      suggestion:
        "Disable `allow_force_pushes` in classic protection, or add a ruleset `non_fast_forward` rule, to protect commit history integrity.",
    });
  }

  const deletionBlocked =
    (classicProtectionEnabled && allowDeletions === false) || rulesetRuleTypes.includes("deletion");
  if (absenceVerified && hasProtectionOfAnyKind && !deletionBlocked) {
    findings.push({
      severity: "high",
      category: "Branch Protection",
      description:
        "Branch deletion is allowed (not blocked by classic protection or a ruleset `deletion` rule).",
      suggestion:
        "Disable `allow_deletions` in classic protection, or add a ruleset `deletion` rule, to prevent accidental or malicious removal.",
    });
  }

  if (classicProtectionEnabled && requireCodeOwnerReviews === false) {
    findings.push({
      severity: "medium",
      category: "Branch Protection",
      description: "CODEOWNERS reviews are not required even if a CODEOWNERS file exists.",
      suggestion: "Enable `require_code_owner_reviews` so ownership routing (CODEOWNERS) is actually enforced.",
    });
  }

  if (classicProtectionEnabled && requiredConversationResolution === false) {
    findings.push({
      severity: "low",
      category: "Branch Protection",
      description: "Unresolved review conversations do not block merging.",
      suggestion: "Enable `required_conversation_resolution` so review feedback must be addressed before merge.",
    });
  }

  const conclusion = computeConclusion(
    classicProtectionEnabled,
    rulesetRuleTypes,
    findings,
    absenceVerified
  );

  const structured: BranchProtectionStatusResult = {
    repo: `${ref.owner}/${ref.repo}`,
    branch,
    classicProtectionEnabled,
    requiredApprovingReviewCount,
    requireCodeOwnerReviews,
    requiredStatusCheckContexts,
    enforceAdmins,
    allowForcePushes,
    allowDeletions,
    requiredConversationResolution,
    rulesetRuleTypes,
    classicProtectionVerified,
    rulesetsVerified,
    verificationGaps,
    findings,
    errors,
    conclusion,
  };

  const conclusionLabel =
    conclusion === "protected"
      ? "PROTECTED"
      : conclusion === "partially_protected"
      ? "PARTIALLY PROTECTED"
      : conclusion === "unprotected"
      ? "UNPROTECTED"
      : "UNKNOWN";
  const inline = (value: string, maxLength = 500): string =>
    safeMarkdownInline(value, { maxLength });

  const lines: string[] = [
    `# Branch Protection Status: ${inline(`${ref.owner}/${ref.repo}@${branch}`, 300)}`,
    "",
    `**Conclusion:** ${conclusionLabel}`,
    `**Classic protection enabled:** ${classicProtectionEnabled ? "yes" : "no"}`,
    `**Active ruleset rule types:** ${rulesetRuleTypes.length > 0 ? rulesetRuleTypes.map((rule) => inline(rule, 100)).join(", ") : "none"}`,
    `**Evidence complete:** ${absenceVerified ? "yes" : "no"}`,
    "",
  ];

  if (errors.length > 0) {
    lines.push("## Notes", "");
    errors.forEach((error) => lines.push(`- ${inline(error)}`));
    lines.push("");
  }

  lines.push(
    "## Configuration",
    "",
    "| Setting | Value |",
    "|---|---|",
    `| Required approving reviews | ${requiredApprovingReviewCount ?? "not set"} |`,
    `| Require code owner reviews | ${requireCodeOwnerReviews ?? "not set"} |`,
    `| Required status check contexts | ${requiredStatusCheckContexts.length > 0 ? requiredStatusCheckContexts.map((context) => inline(context, 200)).join(", ") : "none"} |`,
    `| Enforce admins | ${enforceAdmins ?? "not set"} |`,
    `| Allow force pushes | ${allowForcePushes ?? "not set"} |`,
    `| Allow deletions | ${allowDeletions ?? "not set"} |`,
    `| Required conversation resolution | ${requiredConversationResolution ?? "not set"} |`,
    ""
  );

  lines.push("## Findings", "");
  if (findings.length === 0) {
    lines.push("No findings -- branch protection looks solid.");
  } else {
    for (const f of findings) {
      lines.push(
        `- **[${f.severity.toUpperCase()}]** ${inline(f.category, 100)}: ${inline(f.description)}` +
          (f.suggestion ? `\n  > Suggestion: ${inline(f.suggestion)}` : "")
      );
    }
  }

  return { text: lines.join("\n"), structured };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBranchProtectionStatusTool(server: McpServer): void {
  server.registerTool(
    "branch_protection_status",
    {
      title: "Branch Protection Status",
      description: `Read classic branch protection AND repository rulesets for a branch (defaults to the repo's default branch).

Required token scope: \`repo\` (or \`public_repo\` for public-only repos) with admin/read access to branch protection.

Args:
  - owner, repo: Repository coordinates.
  - branch: Optional. Falls back to the repository's default branch.

Returns: Required reviews / status checks / force-push / deletion settings from both classic protection and rulesets, findings by severity, verification gaps, and a protected/partially_protected/unprotected/unknown conclusion.`,
      inputSchema: BranchProtectionStatusInputSchema,
      outputSchema: BranchProtectionStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BranchProtectionStatusInput) => {
      try {
        const ref = resolveRepo(params.owner, params.repo);
        const octokit = getOctokit();
        const { text, structured } = await handleBranchProtectionStatus(params, ref, octokit);
        return {
          content: [{ type: "text", text }],
          structuredContent: withStructuredContentTrustBoundary(structured),
          _meta: STRUCTURED_CONTENT_TRUST_META,
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

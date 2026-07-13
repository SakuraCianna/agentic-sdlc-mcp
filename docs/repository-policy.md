# Repository policy (`.agentic-sdlc.yml`)

v1.7 adds a repository-owned, read-only policy layer for planning, pull-request gates, review, release readiness, and agent handoff. Policy can strengthen built-in safety rules; it cannot enable auto-merge, force-push, branch deletion, approval bypasses, or suppress verified failures.

## Minimal policy

```yaml
schemaVersion: 1
```

When the file is absent, v1.6-compatible defaults remain active. A `404` is not degraded. An unreadable or invalid file is reported as degraded and safe defaults are used; unknown keys are rejected instead of silently ignored.

## Complete example

```yaml
schemaVersion: 1
defaultWorkType: feature
requiredChecks:
  - { name: test, source: check_run, appId: 15368 }
  - { name: typecheck, source: check_run, appId: 15368 }
protectedPaths: [.github/**, src/auth/**]
riskRules:
  - id: risk.authorization
    paths: [src/auth/**, src/permissions/**]
    workTypes: [feature, bugfix, security]
    level: high
    domains: [authorization, cross-tenant]
labels:
  releaseBlocking: [blocked, release-blocker, security-blocker]
review:
  requireIssueLink: true
  requireCodeOwnersForProtectedPaths: true
  requiredReviewers:
    - id: review.security
      riskRuleIds: [risk.authorization]
      paths: [.github/workflows/**]
      reviewers: ["@example-org/security"]
release:
  requireChangelog: true
  requireRollbackPlan: true
```

Stable rule IDs must contain a separator, such as `risk.authorization`. Reviewers use `@user` or `@org/team`. Repository-relative globs support `/`, `*`, `**`, and `?`. Absolute/traversal paths, control characters, duplicate IDs/values or YAML keys, unknown risk references/fields, excessive aliases, and invalid types reject the complete repository policy.

Each required check is bound to a concrete GitHub App ID and `check_run` source. For example, `15368` is the GitHub Actions App ID. A same-name commit status, a check run from another App, and a skipped/neutral check do not satisfy the rule. Find the App ID from verified check-run evidence before adding it; v1.7 intentionally does not accept an unbound string name.

## Precedence and provenance

Precedence is: non-reducible MCP safety floor, built-in defaults, repository policy enhancements, then caller-supplied enhancements. Callers cannot remove repository-required labels or checks.

Policy-aware outputs expose canonical SHA-256 `policyDigest`, stable `appliedPolicyRules`, `policySources`, source ref/blob SHA, and degraded/errors. The digest covers validated canonical data, not YAML formatting.

PR gate and review tools load policy from the PR base SHA. A PR editing `.agentic-sdlc.yml` cannot use its proposed policy to approve itself. Renames evaluate current and previous paths; incomplete changed-file evidence produces a policy gap when path rules exist.

GitHub review evidence does not map an approving user back to organization team membership. A required `@org/team` can be shown as requested/pending but is not claimed satisfied from an unrelated approval; use individual reviewers when the decision must be independently enforceable with the available token permissions.

Release readiness loads policy from the target commit. When rollback evidence is required, provide:

```json
{
  "pullNumber": 42,
  "rollbackPlanEvidence": {
    "reference": "runbook://release-42",
    "tested": true
  }
}
```

It is returned as `source: "caller"`: the MCP verifies presence and the `tested` flag, but does not claim to have executed the runbook.

## Invalid example

```yaml
schemaVersion: 1
autoMerge: true
review:
  requiredReviewers:
    - id: review.security
      reviewers: []
```

The whole file is rejected: `autoMerge` is not a capability and the reviewer rule is invalid. No partial rule is silently applied.

## Tool behavior and limits

- `repo_context`: `includePolicy: true` spends one additional contents API call and returns the summary.
- `plan_from_context`: loads policy automatically; explicit `workType` wins.
- `quality_gate_status` / `review_pr_against_standard`: apply base-SHA checks, labels, paths, issue, reviewer, and CODEOWNERS rules.
- `release_readiness_check`: applies target-SHA checks, PR labels, changelog, and rollback requirements.
- `agent_handoff_packet`: carries provenance and required verification steps; `currentStatus` remains caller-authored.

Policy input is capped at 64 KiB, nesting at 20 levels, and parsed values at 2,000 nodes. v1.7 has no persistent cross-request cache or organization policy inheritance.

## Migration from v1.6

No policy file is required. Add the minimal file, call `repo_context` with `includePolicy: true`, inspect its digest/source, then add rules incrementally. Exercise planning and read-only gate/review/release tools before relying on policy in a release workflow.

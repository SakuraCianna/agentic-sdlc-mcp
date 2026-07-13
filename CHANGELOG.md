# Changelog

All notable changes to this project are documented here. Release history is also available on the [GitHub Releases page](https://github.com/SakuraCianna/agentic-sdlc-mcp/releases).

## [1.7.1] - 2026-07-13

### Fixed

- Corrected the case-sensitive MCP Registry namespace to `io.github.SakuraCianna/agentic-sdlc-mcp`, matching the GitHub login authorized by Registry OIDC.
- Advanced npm, server, package metadata, runtime, and tests together because published npm/Registry versions are immutable; v1.7.0 is not overwritten or republished.

### Compatibility

- No tool or policy behavior changes from v1.7.0. The patch only corrects Registry identity and version metadata.

## [1.7.0] - 2026-07-12

### Added

- Official MCP Registry metadata and a release-triggered, checksum-verified GitHub OIDC publication workflow.
- Strict `.agentic-sdlc.yml` schema, bounded YAML parsing, canonical digest, ref/blob provenance, safe defaults, and shared path/reviewer decisions.
- Required checks are bound to a concrete check-run App ID; same-name commit statuses, other Apps, and skipped checks cannot satisfy policy.
- Policy consumers for `repo_context`, `plan_from_context`, `quality_gate_status`, `review_pr_against_standard`, `release_readiness_check`, and `agent_handoff_packet`.
- Explicit caller-sourced rollback-plan evidence for policies requiring a tested rollback plan.

### Changed

- Plans inherit repository defaults and add required checks, protected-path, review, and release constraints without removing built-in safety tasks.
- PR gates/reviews evaluate base-SHA policy and previous names for renames; release readiness evaluates the target SHA.
- Policy-aware outputs expose rule IDs, digest, sources, blob SHA, and degraded state.

### Security

- Invalid, oversized, deeply nested, aliased, duplicate-key, unknown-field, traversal, or inconsistent policy files are rejected as a whole.
- Registry publishing uses pinned Actions, an exact publisher/checksum, minimal permissions, and no long-lived Registry token.

### Compatibility

- Repositories without `.agentic-sdlc.yml` retain v1.6-compatible defaults; all six integrations remain read-only and additive.
- The MCP Registry is preview infrastructure; `npx -y agentic-sdlc-mcp` remains the primary compatibility path.

## [1.6.0] - 2026-07-12

### Added

- Evidence-backed pull request gates that combine check runs, commit statuses, reviews, CODEOWNERS routing, branch protection/rulesets, blocking labels, linked issues, draft state, and mergeability ([#26](https://github.com/SakuraCianna/agentic-sdlc-mcp/issues/26)).
- Work-type-aware structured PR review with intent, scope, evidence, ownership, policy, fallback, and security dimensions ([#27](https://github.com/SakuraCianna/agentic-sdlc-mcp/issues/27)).
- A pinned, least-privilege Gitleaks workflow and trusted mature-scanner evidence in security-focused review.
- Repository CODEOWNERS coverage for governance-sensitive paths.

### Changed

- `quality_gate_status` now reports `passing`, `failing`, `pending`, `needs_review`, `policy_gap`, or `no_evidence`, with verified blockers, warnings, next actions, and degraded evidence details.
- `review_pr_against_standard` accepts an optional `workType` and returns work-type confidence/reasoning, structured findings, test coverage signal, ownership routing gaps, and release risk.
- Workflow changes are reviewed from complete files at the PR head SHA and share the workflow-permission evaluator.
- `release_readiness_check` uses the shared check-run and commit-status evidence model and requires explicit passing CI.

### Fixed

- Zero, entirely skipped/neutral, pending, or unverifiable CI signals can no longer be reported as release-ready.
- Truncated changed-file evidence fails closed for workflow policy and secret-scanner policy review.
- Draft and commit-count hygiene findings remain compatible with the earlier basic review behavior.
- CI summaries no longer echo externally controlled names or raw GitHub errors.

### Security

- Replaced the legacy five-pattern secret check as primary evidence with layered Gitleaks CI evidence; the bounded patch heuristic remains supplemental only.
- Added bounded, statement/hunk-aware detection for dynamically constructed credential-like values and authentication-header API sinks (concatenation/formatting, common multi-language interpolation/builders, joins, decoding, multiline and patch-local computed-field aliases) under every review standard, with finding aggregation, explicit false-positive exclusions, and documented whole-program limits.
- Passing scanner evidence requires a trusted app-backed check bound to its concrete Actions job, run, reviewed head, and unique immutable base-workflow scanner job. Same-name/duplicate jobs or statuses, unknown Apps, incomplete evidence, and scanner-policy changes cannot prove a clean scan.
- Secret scanning, workflow fetching, and external diagnostics are bounded and fail closed on incomplete critical evidence.

### Compatibility

- Existing quality-gate ref mode and legacy review output fields remain available; v1.6 additions are additive.
- The MCP remains a reviewer aid: gate, review, workflow-audit, and release-readiness tools do not approve or merge PRs or modify repository policy.

[1.6.0]: https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.6.0
[1.7.0]: https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.7.0
[1.7.1]: https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.7.1

# Changelog

All notable changes to this project are documented here. Release history is also available on the [GitHub Releases page](https://github.com/SakuraCianna/agentic-sdlc-mcp/releases).

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

- Zero CI signals and pending CI can no longer be reported as release-ready.
- Truncated changed-file evidence fails closed for workflow policy and secret-scanner policy review.
- Draft and commit-count hygiene findings remain compatible with the earlier basic review behavior.
- CI summaries no longer echo externally controlled names or raw GitHub errors.

### Security

- Replaced the legacy five-pattern secret check as primary evidence with layered Gitleaks CI evidence; the bounded patch heuristic remains supplemental only.
- Added bounded, statement/hunk-aware detection for dynamically constructed credential-like values (concatenation/formatting, interpolation, joins, decoding, multiline and computed-field forms) under every review standard, with finding aggregation, explicit false-positive exclusions, and documented whole-program limits.
- Passing scanner evidence requires a trusted app-backed check run. Same-name commit statuses, unknown Apps, incomplete evidence, and scanner-policy changes cannot prove a clean scan.
- Secret scanning, workflow fetching, and external diagnostics are bounded and fail closed on incomplete critical evidence.

### Compatibility

- Existing quality-gate ref mode and legacy review output fields remain available; v1.6 additions are additive.
- The MCP remains a reviewer aid: gate, review, workflow-audit, and release-readiness tools do not approve or merge PRs or modify repository policy.

[1.6.0]: https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.6.0

# Changelog

All notable changes to this project are documented here. Release history is also available on the [GitHub Releases page](https://github.com/SakuraCianna/agentic-sdlc-mcp/releases).

## [Unreleased]

### Added

- Added the provider-neutral T7 evaluation foundation: bounded scenario/trace schemas, explicit scripted/recorded-agent/live-model provenance, a deterministic machine-readable scorer for tool selection/order/write/gate violations, versioned SHA-256 digests, and a checked-in JSON Schema drift gate exposed through `npm run eval:score`.
- Added the T8 deterministic selection suite: six sanitized recorded-agent traces from real Agentic SDLC MCP use with auditable evidence, fixed recording/argument digests, replay through the real MCP 2.0.0 client with plan-output composition and structured assertions, explicit gate/review and repo/brief disambiguation, zero-write issue preview enforcement, a minimal-environment offline runner, and 100% full-scorer scenario accuracy.
- Added an immutable v1.9.0 MCP discovery manifest, generated from its pinned release commit through real `tools/list` and `resources/list` calls in an isolated detached worktree.
- Added a semantic compatibility gate for tool/resource removal, input narrowing or default drift, output guarantee loss, annotation or MIME drift, with explicit-only baseline updates and Node 22/24 CI coverage.
- Added a separate Node 24 read-only replay that rebuilds the pinned v1.9.0 checkout and byte-compares fresh discovery with the tracked baseline, while the Node 22/24 matrix keeps the faster current-contract comparison.
- Added boundary coverage for JSON Schema unions, object enums, boolean schemas, `integer`/`number` subtyping, composition/constraint drift, prototype-named keys, future boolean annotations, CLI path/provenance rejection, real deadlines, cancellation races, evidence-state degradation, bounded pagination, and temporary worktree cleanup.
- Added explicit MCP 2025/2026 era suites for the production stdio wrapper, direct-fetch HTTP, real loopback HTTP, and a built stdio child process. They cover pinned version negotiation, 13-tool/5-resource parity, modern wire metadata, unknown methods, mismatches, cancellation, and shutdown.
- Added a full 13-tool protocol-call matrix across legacy stdio routing and pinned modern production direct-fetch. It validates registered output schemas, Markdown/structured parity, trust boundaries, error-versus-degradation semantics, modern wire headers, external-network isolation, and the default dry-run live-write boundary.
- Added an Inspector 2.0.0 stdio black-box gate with an isolated lockfile. It launches the real built entry through an explicit ad-hoc target, verifies legacy initialization, 13 tools, five resource reads, a zero-write issue preview, and machine-readable invalid-schema/unknown-resource failures without inheriting credentials or allowing external network access.
- Added an Inspector 2.0.0 loopback HTTP gate against the production adapter, including complete stdio/HTTP discovery JSON parity, an empty-store 401 `stored-auth-only`/no-browser proof, canonical-target validation, exact loopback network isolation, reliable child/listener cleanup, and machine-readable invalid-schema, unknown-tool, and closed-listener failures.
- Added a pinned Conformance 0.1.16 legacy pilot with a sanitized `checks.json` artifact. Its 25 expected gaps each carry a reason, owner, and removal condition; five scenarios currently pass directly, while new failures and stale baseline entries fail the run.
- Raised the global coverage regression floors to 94% statements, 89% branches, 94% functions, and 95% lines; after adding the full tool matrix, Inspector/Conformance runner boundaries, bounded secret-scanner regressions, the T7/T8 evaluation suites, and self-hosted reviewer feedback regressions, the current 1364-test baseline is 96.48% statements, 91.29% branches, 97.17% functions, and 97.25% lines.

### Changed

- Pinned every CI, release, registry-publish, and secret-scan use of `actions/checkout` to the signed v7.0.1 commit and `actions/setup-node` to the immutable v7.0.0 commit, with matching workflow regression assertions.
- Locked `@modelcontextprotocol/sdk` 1.30.0 as the v1.x rollback bridge before the v2 migration, bringing its stdio buffer, Content-Type, SSE keep-alive, and timer lifecycle fixes without enabling the 2026 wire protocol. The resolved `@hono/node-server` remains 1.19.15 and its unused `serve-static` advisory remains tracked as one moderate audit finding.
- Migrated the runtime to the stable MCP TypeScript SDK 2.0.0 split packages: `server`, `node`, and `express` remain production dependencies while the real integration client is development-only. The package migration first preserved the 2025-era initialize flow, and the separately reviewable transport slice now adds explicit `2026-07-28` negotiation without removing legacy fallback.
- Routed production stdio through `serveStdio(factory)` and loopback HTTP through the official strict modern handler plus the existing bounded legacy JSON profile. Modern response metadata remains SDK-generated; no OAuth, multi-tenant state, shared session store, or non-loopback default was added.
- Made every registered tool use complete Standard Schema objects at the v2 boundary and kept the public 13-tool/5-resource contract compatible. The only reviewed schema drift is the official root dialect upgrade from draft-07 to JSON Schema 2020-12; any other `$schema`, reference, or composition change remains fail-closed.
- Kept immutable contract replay compatible with both the historical v1 package layout and the current v2 split layout without passing nominal SDK objects across dependency roots.

### Fixed

- Corrected three false conclusions observed while using Agentic SDLC MCP on its own v1.10 work: dependency-bot documentation URLs no longer classify a lockfile-only update as security work, strict required-status-check policy is considered modeled when required contexts and GitHub mergeability evidence are both available, and non-closing `Part of #...` references are described as traceability rather than incorrectly reported as no Issue association.
- Stopped `prepare_work_item` from treating LLM character/token budgets or benign phrases such as Secret Santa and "secret sauce" as credential evidence and incorrectly escalating ordinary feature work to critical risk.
- Stopped the pull-request secret heuristic from treating operators and quantifiers inside credential-detection regex literals, scanner provenance helpers, or secret-scanner workflow fixture paths as runtime credential construction. Nested template-expression state now resumes correctly before following statements, so real dynamically built credentials still fail high, and typed TypeScript assignments are no longer counted twice at both `:` and `=`.
- Stopped the supplemental pull-request secret heuristic from treating an entire multi-line JSON manifest or lockfile as one unterminated code statement. Ordinary JSON/JSONC members are scanned independently, while credential members retain bounded grouping across split keys, separators, scalar values, arrays, and objects; escaped member keys are decoded before classification, scalar and container string leaves retain the existing placeholder rules, and oversized added statements or credential-relevant context propagate incomplete evidence within the changed hunk. Per-statement operator-count and work budgets stop adversarial deep JSON from turning the supplemental review into quadratic work, while a precomputed next-token index keeps long JSONC comment runs linear; every relevant exhausted budget fails closed instead of silently skipping analysis. Assignment parsing now tracks nested ternary operators by bracket depth, distinguishes Ruby/Rust/Swift/PHP/Dart/Elixir question-mark syntax, and preserves C/C++ comma expressions and decimal literals, so multiline conditional branches are not misread as credential assignments while real credential construction inside them remains fail-high.
- Prevented historical MCP discovery from retaining Windows checkout handles by running it in a bounded child process whose cwd stays outside the checkout, passing only an OS-runtime environment allowlist, and applying bounded cleanup retries before removing the detached worktree.
- Prevented evidence collection from silently exiting before its deadline, from starting after an immediate parent cancellation, or from accepting non-finite timeout values.
- Prevented invalid GitHub pagination sizes such as `perPage=0` from causing an unbounded request loop.
- Prevented security-focused PR review from invalidating verified scanner evidence when an unrelated Actions workflow changes. Internal immutable-base provenance now binds each Gitleaks/TruffleHog signal to its exact workflow and static configuration dependencies, invalidates only affected signals, and remains fail-closed when a dependency is missing, dynamic, ambiguous, absolute, or outside the repository. The internal paths are not added to the public MCP output schema.

### Security

- Kept credential-context secrets, credentials, private/API keys, qualified compact/camelCase tokens, credential-qualified uppercase token identifiers, and explicit key/secret/password environment suffixes in the high-signal secrets domain, with paired positive and negative regression coverage.
- Kept exact structured `secret(s)` and `credential(s)` Issue labels as high-confidence risk signals without treating the same bare words anywhere in free text as equivalent evidence.
- Clarified that `riskProfile` is an explainable implementation-planning estimate, not proof of a vulnerability, leaked credential, or exploitable finding.
- Reconfirmed that MCP SDK v2's Node adapter reaches `@hono/node-server@1.19.15` and `hono@4.12.27` only through `getRequestListener`; the project exposes no static-file route and does not import Hono's CORS, JSX `memo`, proxy, or language middleware. The current production audit therefore retains three package-level moderate findings without a destructive transport replacement or false all-clear claim; reachability must be reassessed if any affected middleware is introduced or the stable SDK lock changes.
- Reordered loopback HTTP middleware so Host and Origin guards reject untrusted requests before any body parsing, while preserving the prior 100 KiB JSON limit as an explicit bound.
- Made loopback shutdown settle and abort in-flight legacy HTTP exchanges instead of waiting indefinitely on the SDK transport's unresolved response map. The documented 2025 stateless HTTP cancellation limitation remains unchanged because correlating request IDs across unidentified clients would permit cross-client cancellation.
- Closed HTTP factory races in both protocol eras: abort or handler shutdown now settles with 499 even if an asynchronous factory never returns, and a server returned after closure is immediately torn down. A guarded modern handoff also prevents the SDK from connecting a factory product after shutdown wins the adjacent microtask race. Factory/serving failures return a bounded JSON-RPC 500 without exposing internal details, and conflicting 2025/2026 header/body claims are explicitly rejected instead of changing eras.
- Built stdio process tests now launch the real `dist/index.js` package entry from an isolated temporary home/storage directory, reject credential and `NODE_OPTIONS` inheritance, use an empty dotenv source, and block non-loopback fetch/socket access. Watch mode excludes this build-artifact test so it cannot silently exercise stale `dist` output.
- Restricted acceptance of Inspector's Windows-only libuv closing abort to one exact status, JSON error code, and two-line stderr signature, while preserving the raw exit classification and keeping Linux or any variant fail-closed.

## [1.9.0] - 2026-07-28

### Added

- Added the read-only `sdlc_evidence_packet` tool for versioned Issue, pull request, and release-ref evidence with state, freshness, completeness, provenance, limitations, recommended actions, and a stable content digest.
- Added PR head pinning and stale detection, plus independently degraded release-target, release-readiness, and security-triage collection.
- Added item-level evidence subjects, source-content digests, explicit GitHub-request/source-text/file/item/Markdown/timeout budgets, AbortSignal propagation, omitted-evidence records, and bounded security-alert rendering.
- Made prompt-injection evidence fail closed when Issue/PR text or PR changed-file names exceed collection budgets, and applied one abortable 30-second collection budget across each handoff.
- Expanded handoffs with system-derived status, release subjects, goals, non-goals, completed actions, decisions, and deep PR/release evidence.
- Added a shared public tool catalog and real MCP contract checks that keep all 13 tools and handoff resources aligned.
- Added first-class unified evidence to `create_pr_summary`, including pinned PR head provenance and explicit partial semantics when changed-file evidence is truncated.
- Added complete [v1.9.0 release notes](docs/releases/v1.9.0.md) and future-only [remote deployment re-entry criteria](docs/remote-deployment-considerations.md).

### Changed

- Expanded the declared runtime floor from Node.js 24-only to Node.js 22+, with GitHub Actions coverage on Node 22 and 24. Node 20 is not supported.
- Made branch-protection permission gaps return `unknown` rather than incorrectly reporting an unprotected branch.
- Added an explicit structured-content trust boundary to every tool response and output schema.
- Updated static standards to follow repository-specific traceability and review policies, including sole-maintainer repositories.
- Kept stdio and loopback HTTP as the supported local profiles; remote OAuth and multi-tenant hosting are no longer scheduled roadmap work.
- Hardened the npm and MCP Registry OIDC release workflows with immutable action revisions plus tag, `main` ancestry, lockfile, server, package, and registry metadata validation before publication.

### Security

- Added shared prompt-injection detection for instruction overrides, role impersonation, tool coercion, secret/data exfiltration, encoded instructions, and Unicode zero-width/bidirectional obfuscation.
- Omitted every detected injection signal from agent-facing Markdown and handoff prompts while preserving raw structured evidence for untrusted-data inspection.
- Applied repository-text protection to metadata, README and agent instructions, package scripts, workflows, policy fields, Issue/PR fields, plans, issue previews, release evidence, and branch findings.
- Restricted the local credential configuration file to owner read/write permissions on platforms that implement POSIX file modes, including tightening existing files before use.
- Added a safe initialization error boundary to `security_triage`.
- Prevented skipped-only or incomplete CI and unavailable review decisions from being promoted to verified evidence.
- Refreshed the lockfile to patched `fast-uri`, `brace-expansion`, and `postcss` releases without force-upgrading or downgrading direct dependencies.

### Compatibility

- Tool and output changes are additive; stdio startup and the preview-first `create_issue_set` write boundary remain unchanged.
- Node 22 validation runs only in GitHub Actions because the maintainer workstation does not have Node 22 installed.
- `contentDigest` detects stable packet-content changes but is not a signature or compliance attestation.
- The MCP SDK resolves `@hono/node-server@1.19.15`, which the upstream maintainer lists as patched for GHSA-frvp-7c67-39w9. npm audit still applies its broader `<2.0.5` range and reports two moderate entries (Hono and the SDK), but this server imports only `getRequestListener` through the SDK and does not provide Hono static-file serving. Reassess the advisory if the dependency is downgraded or a URL-to-filesystem/static-file route is introduced.

## [1.8.0] - 2026-07-13

### Added

- Risk-aware `prepare_work_item` briefs with deterministic work-type/risk classification, policy floors, source provenance, Issue-authored versus derived acceptance criteria, defensive requirements, negative scenarios, clarification questions, verified commands, rollback, and observability guidance.
- Bounded maintainer-comment and recent-PR evidence, default-branch path verification, adjacent tests and root entry points, CODEOWNERS routing, milestone context, and official blocked-by/blocking/sub-issue/cross-reference relationships with explicit incomplete semantics.
- A local Streamable HTTP profile that binds to `127.0.0.1`, validates Host and supplied Origin headers, isolates each stateless request, returns protocol-safe method/errors, validates ports, and performs graceful shutdown.
- LF repository governance through `.gitattributes`, `.editorconfig`, a zero-dependency checker, CI enforcement, and adversarial CRLF/mixed-EOL fixtures.

### Changed

- Moved all bounded GitHub work-item evidence collection into the cohesive `work-item-evidence` module while preserving existing helper exports and MCP schemas.
- Hardened `create_pr_summary` around docs-only and changed-file truncation, and made `agent_handoff_packet` surface evidence gaps while treating caller/GitHub text as untrusted evidence.
- Expanded the release-readiness test strategy around real MCP protocol/runtime behavior, network isolation, boundary values, partial failures, malicious text, and maintainable fixtures.
- Updated English and Chinese documentation, ROADMAP, and maintainer guidance with the v1.8 behavior and local-versus-remote HTTP boundary.

### Security

- Repository policy and explicit higher risk remain floors; protected paths cannot be downgraded by caller-provided low risk or sparse Issue text.
- Issue, comment, PR, dependency, path, and caller text is bounded and safely rendered; prompt-injection content is evidence rather than authority to reveal secrets, bypass policy, or expand permissions.
- Local HTTP rejects untrusted Host/Origin values and avoids leaking internal errors. It is intentionally not a remote deployment profile; OAuth, request-scoped credentials, tenant isolation, and remote timeout/cancellation budgets require a separate condition-triggered re-entry decision.

### Compatibility

- Stdio remains the default transport and all v1.8 tool-schema changes are additive. Repositories without `.agentic-sdlc.yml` keep the prior safe defaults.
- The declared `@modelcontextprotocol/sdk` minimum is now `^1.29.0`, matching the tested release that provides the local HTTP Express factory used by v1.8.
- The MCP Registry continues to publish immutable stdio package metadata after the exact npm version becomes available; no remote HTTP transport is advertised.

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
[1.8.0]: https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.8.0
[1.9.0]: https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.9.0

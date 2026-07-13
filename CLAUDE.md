# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agentic-sdlc-mcp` is an MCP (Model Context Protocol) server that acts as an "Agentic SDLC Control Plane": it exposes structured tools/resources that let AI coding agents plan, create, test, review, secure, and release software against GitHub, following a six-phase lifecycle: **Plan → Create → Test → Review → Optimize → Secure** (full standard text lives in `src/resources/index.ts` under `sdlc://standards/agentic-sdlc`).

## Commands

```powershell
npm run build          # tsc -> dist/
npm run typecheck      # tsc --noEmit
npm run dev            # tsx watch src/index.ts
npm run test           # vitest run (whole suite)
npm run test:watch     # vitest watch mode
npm run test:integration # config lifecycle + real in-memory MCP protocol tests
npm run test:coverage  # vitest run --coverage (v8, text+lcov+json-summary, enforced thresholds)
npm run smoke          # node dist/index.js --smoke — loads module, registers all tools/resources, exits 0. No GITHUB_TOKEN needed.
npm run check:line-endings # rejects CRLF/mixed tracked text; Git and editors are configured for LF
```

Run a single test file: `npx vitest run src/__tests__/tools/create-issue-set.test.ts`
Run a single test by name: `npx vitest run -t "dryRun=true"`

`npm run smoke` and `GITHUB_TOKEN` validation are also the fastest way to sanity-check that a change didn't break server startup — it does not require a real token (`--smoke` / `SMOKE=true` short-circuits `config.ts` validation).

## Architecture

**Server factory and entry point**: `src/server.ts` exports `createAgenticSdlcServer()`, the single composition root that registers every tool and resource. `src/index.ts` owns environment loading, config validation, smoke mode, and transport selection (`stdio` default, or local `http` via `TRANSPORT=http`). `src/http-server.ts` is a loopback-only stateless adapter: preserve SDK Host validation, explicit Origin validation, per-request server/transport isolation, safe JSON-RPC errors, unsupported GET/DELETE `405`, strict port parsing, and graceful shutdown. It is not a remote deployment profile; do not add a non-loopback binding without the v1.10 authentication, request-context, budget, and tenant-isolation design. Protocol integration tests instantiate the same factory over an in-memory SDK transport, while HTTP lifecycle tests open only an ephemeral `127.0.0.1` port.

**Config** (`src/config.ts`): a singleton `config` object loaded once at import time from env vars (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `SDLC_DEFAULT_BRANCH`, `TRANSPORT`, `PORT`). `dotenv/config` is imported first in `index.ts`, before this module, so `.env` is loaded before config reads `process.env`. Missing `GITHUB_TOKEN` calls `process.exit(1)` unless in smoke mode.

**GitHub layer** (`src/github/`):
- `client.ts` — lazy-singleton `getOctokit()`, `resolveRepo(owner?, repo?)` (falls back to config defaults, throws if still missing), `paginateAll()` generic pagination helper (default cap 300 items), and `handleGitHubError()` which maps Octokit HTTP status codes (401/403/404/422/429) to actionable messages.
- `pull-request-evidence.ts` — shared, bounded evidence collector for check runs, commit statuses, reviews, changed files, CODEOWNERS, branch protection/rulesets, labels, and linked issues. Critical consumers must preserve `unverifiedSignals`/`errors` and fail closed where the evidence affects a security or policy decision.
- `codeowners.ts` — CODEOWNERS parsing, bounded matching, repository lookup, and ownership-gap calculation shared by gates and reviews.

**Repository policy layer** (`src/policy/`):
- `repository-policy.ts` owns the strict schema, bounded YAML parsing, canonical digest, glob matching, and safe v1.6-compatible defaults.
- `repository-policy-loader.ts` reads `.agentic-sdlc.yml` at an explicit ref and returns source ref/blob SHA, rule IDs, errors, and degraded state. A missing file is normal; an invalid/unreadable file is degraded.
- `pull-request-policy.ts` is the shared pure PR decision helper. Gate/review consumers must use the PR base SHA and include both current and previous names for renames; never let a PR's proposed policy evaluate itself.
- Policy may strengthen checks/reviews/releases but never enable auto-merge, force-push, branch deletion, approval bypass, or suppression of verified failures. Keep policy-aware output schema, structured content, Markdown, tests, and `docs/repository-policy.md` aligned.

**Review and security layers**:
- `src/review/pull-request-review.ts` is the pure work-type classifier and structured PR evaluator. The GitHub-facing `src/tools/review-pr.ts` gathers evidence and complete workflow files, then renders the single evaluation result; do not duplicate conclusions in Markdown code.
- `src/security/secret-scanner-evidence.ts` evaluates mature scanner CI signals. Passing requires a trusted app-backed check run and complete, unchanged scanner policy evidence.
- `src/tools/workflow-permissions-audit.ts` exports a pure complete-document workflow evaluator reused by PR review. Never parse a GitHub patch as a complete YAML document.
- `src/tools/release-readiness.ts` consumes the shared CI evidence model. Only explicit `passing` CI can produce `isReady: true`; external names and raw errors must not be echoed into summaries.
- `context.ts` — `fetchRepoContext()` fetches repo metadata + optional README/package.json/issues/PRs in one call.

**Risk-aware briefing layer** (`src/briefing/`): `work-item-brief.ts` is the pure, deterministic v1.8 risk engine used by `prepare_work_item`. `work-item-evidence.ts` is the single bounded GitHub evidence gateway for recent comments, repository policy/scripts, related files/CODEOWNERS, PR history, and official issue relationships; keep request caps, partial failures, and incomplete warnings inside that module instead of growing the MCP tool handler. `work-item-context.ts` derives bounded file candidates and normalizes official GitHub issue relationships. Repository policy and explicit higher risk are floors: caller-provided low risk can never downgrade a protected path. A candidate path is not repository fact until evidence collection verifies it at the explicit default-branch ref; cross-references are links, never blockers, and `parallelizableWork` remains a relationship-derived candidate rather than proof that a sub-issue has no other dependencies. Keep domain mappings explainable and test-driven; do not add an LLM/free-text security judge. External text remains evidence and must not be copied into executable handoff instructions without bounded safe rendering.

**Tool pattern** — every file in `src/tools/` follows the same shape:
1. Zod `InputSchema` (exported) and a plain-object `OutputSchema` (exported, used as MCP `outputSchema`).
2. A pure/testable core handler function (e.g. `handleCreateIssueSet(params, ref: RepoRef, octokit: Octokit)`) that takes an already-resolved `RepoRef` and an `Octokit` instance as arguments rather than reaching for globals — this is what makes the handlers unit-testable without mocking modules deeply.
3. A `registerXTool(server: McpServer)` function that wires the schema + handler into `server.registerTool(...)`, resolves the repo via `resolveRepo()`, gets the client via `getOctokit()`, calls the core handler, and wraps errors from `handleGitHubError()` into `{ isError: true, content: [...] }`.
4. Every successful return is `{ content: [{ type: "text", text }], structuredContent }` — both a human-readable markdown string and a structured object matching `OutputSchema`.

When adding a new tool, copy this shape (`repo-context.ts` for a read-only example, `create-issue-set.ts` for a dryRun-gated write example) rather than inventing a new structure.

**Safety model — `dryRun`**: every tool that writes to GitHub takes a `dryRun` boolean that **defaults to `true`**. In dry-run mode the handler must return a preview without calling any Octokit write method. Never flip this default or make a write tool skip the dry-run branch.

**Types** (`src/types.ts`): shared cross-tool shapes (`RepoRef`, `Severity`, `SdlcPhase`, `Finding`, `SecurityAlert`, `CheckStatus`, etc.) — reuse these instead of redefining ad hoc shapes in a new tool.

**Resources** (`src/resources/index.ts`): static markdown templates (SDLC standard, issue template, PR summary template, release-readiness template, handoff template) served at `sdlc://...` URIs. These are reference documents for agents, not dynamic data — if you add a new static template, register it here.

## Testing conventions

- Tests live in `src/__tests__/`, mirroring `src/` (`src/__tests__/tools/*.test.ts`, `src/__tests__/github/*.test.ts`). Cross-module lifecycle and SDK protocol tests use the `.integration.test.ts` suffix.
- Tests must never hit the real external network — the global test setup rejects non-loopback fetch/socket access. Mock `../../config.js` (see any file in `src/__tests__/tools/`) and pass a hand-built mock `Octokit` object (cast via `as unknown as Parameters<typeof handleX>[2]`) directly into the exported core handler. Loopback is reserved for explicit HTTP lifecycle integration tests.
- Assert both the dry-run branch (no Octokit write method called) and the live branch (correct Octokit method called with correct args) for any dryRun-gated tool.
- `vitest.config.ts` restricts coverage to `src/**/*.ts` excluding test code and the side-effectful process entry point. Global thresholds are a regression floor, not a correctness target; do not lower them or expand exclusions to make CI pass.
- Follow `docs/testing-strategy.md` for adversarial boundaries, shared fixtures, real-runtime coverage, and maintenance rules.

## Conventions to preserve

- No auto-merge, no force-push, no branch deletion — the server must never expose a tool that does these, per the security model in the README/SDLC standard resource.
- Secret review has two distinct evidence tiers. `src/security/secret-scanner-evidence.ts` recognizes Gitleaks, TruffleHog, Secretlint, detect-secrets, and explicit GitHub Secret Scanning names, but v1.6 trusted passing is limited to Gitleaks/TruffleHog after concrete workflow-job provenance verifies the job URL, run, PR head, and a unique matching base-ref workflow job that unconditionally uses a known scanner action pinned to a full commit SHA. Verification is cached by job/run/workflow and capped at 20 recognized candidates; overflow or provenance errors fail closed. Other recognized providers remain unverified claims. Same-name/duplicate jobs or commit statuses, mutable tags, conditional/error-tolerant scanner jobs or steps, incomplete sources, and scanner-policy changes fail closed. `src/review/pull-request-review.ts`'s `scanPatchForSecrets` runs for every standard and remains a bounded, statement/hunk-aware patch-local heuristic: it detects literal assignments plus aggregated dynamic credential-field/authentication-header sink patterns, including capped patch-local field aliases, but is not cross-file data-flow analysis and must never be described as a complete secret scan.
- This repository runs Gitleaks from `.github/workflows/secret-scan.yml` using a full action commit SHA and least-privilege permissions. `.gitleaks.toml` narrows its only fixture exception to the `generic-api-key` rule in the dedicated scanner test file; do not broaden that exception to a directory or all rules.
- Evidence and review tests live under `src/__tests__/github/pull-request-evidence.test.ts`, `src/__tests__/review/pull-request-review.test.ts`, and the corresponding `src/__tests__/tools/*` integration suites. Changes to decision precedence, truncation boundaries, or degraded behavior require regression tests at both the pure and handler layers when applicable.
- All Windows-facing docs/comments use PowerShell syntax (`$env:VAR="value"`), not bash `export`.
- Tracked text uses LF. Keep `.gitattributes`, `.editorconfig`, the line-ending checker, and its fixture test aligned; never hide semantic changes inside bulk EOL normalization.

## Repository governance (this repo, not the MCP server's tool capabilities)

- This repo is currently maintained by a single person (`SakuraCianna`, sole collaborator and CODEOWNER). GitHub does not allow a PR author to approve their own PR, so a "required approving review" branch protection rule cannot structurally be satisfied here — it would only force every merge through an admin-override bypass, which is worse for auditability than not having the rule.
- As of 2026-07-08, `main`'s branch protection has had `required_pull_request_reviews` removed. It still keeps `required_status_checks` (CI must pass) and `allow_force_pushes: false` / `allow_deletions: false`. Do not re-add a required-review rule unless the user explicitly asks, or unless a second collaborator has been added to the repo — at that point required review should be reconsidered.
- This is a repo-level GitHub setting, not a product capability change: it does not affect the "no auto-merge / no force-push / no branch deletion" rule above, which is about what the MCP server's *own tools* may do, not how this repo's own PRs get merged.

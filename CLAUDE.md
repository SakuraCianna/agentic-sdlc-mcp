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
npm run test:coverage  # vitest run --coverage (v8, lcov+text)
npm run smoke          # node dist/index.js --smoke — loads module, registers all tools/resources, exits 0. No GITHUB_TOKEN needed.
```

Run a single test file: `npx vitest run src/__tests__/tools/create-issue-set.test.ts`
Run a single test by name: `npx vitest run -t "dryRun=true"`

`npm run smoke` and `GITHUB_TOKEN` validation are also the fastest way to sanity-check that a change didn't break server startup — it does not require a real token (`--smoke` / `SMOKE=true` short-circuits `config.ts` validation).

## Architecture

**Entry point** (`src/index.ts`): builds an `McpServer`, calls one `registerXTool(server)` per tool and `registerResources(server)`, then picks a transport (`stdio` default, or `http` via `TRANSPORT=http` using Express + `StreamableHTTPServerTransport`). Smoke mode exits right after registration, before transport connect.

**Config** (`src/config.ts`): a singleton `config` object loaded once at import time from env vars (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `SDLC_DEFAULT_BRANCH`, `TRANSPORT`, `PORT`). `dotenv/config` is imported first in `index.ts`, before this module, so `.env` is loaded before config reads `process.env`. Missing `GITHUB_TOKEN` calls `process.exit(1)` unless in smoke mode.

**GitHub layer** (`src/github/`):
- `client.ts` — lazy-singleton `getOctokit()`, `resolveRepo(owner?, repo?)` (falls back to config defaults, throws if still missing), `paginateAll()` generic pagination helper (default cap 300 items), and `handleGitHubError()` which maps Octokit HTTP status codes (401/403/404/422/429) to actionable messages.
- `pull-request-evidence.ts` — shared, bounded evidence collector for check runs, commit statuses, reviews, changed files, CODEOWNERS, branch protection/rulesets, labels, and linked issues. Critical consumers must preserve `unverifiedSignals`/`errors` and fail closed where the evidence affects a security or policy decision.
- `codeowners.ts` — CODEOWNERS parsing, bounded matching, repository lookup, and ownership-gap calculation shared by gates and reviews.

**Review and security layers**:
- `src/review/pull-request-review.ts` is the pure work-type classifier and structured PR evaluator. The GitHub-facing `src/tools/review-pr.ts` gathers evidence and complete workflow files, then renders the single evaluation result; do not duplicate conclusions in Markdown code.
- `src/security/secret-scanner-evidence.ts` evaluates mature scanner CI signals. Passing requires a trusted app-backed check run and complete, unchanged scanner policy evidence.
- `src/tools/workflow-permissions-audit.ts` exports a pure complete-document workflow evaluator reused by PR review. Never parse a GitHub patch as a complete YAML document.
- `src/tools/release-readiness.ts` consumes the shared CI evidence model. Only explicit `passing` CI can produce `isReady: true`; external names and raw errors must not be echoed into summaries.
- `context.ts` — `fetchRepoContext()` fetches repo metadata + optional README/package.json/issues/PRs in one call.

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

- Tests live in `src/__tests__/`, mirroring `src/` (`src/__tests__/tools/*.test.ts`, `src/__tests__/github/*.test.ts`), plus `src/__tests__/smoke.test.ts`.
- Tests must never hit the real network — mock `../../config.js` (see any file in `src/__tests__/tools/`) and pass a hand-built mock `Octokit` object (cast via `as unknown as Parameters<typeof handleX>[2]`) directly into the exported core handler. This is *why* handlers take `octokit`/`ref` as explicit params instead of importing `getOctokit()` themselves.
- Assert both the dry-run branch (no Octokit write method called) and the live branch (correct Octokit method called with correct args) for any dryRun-gated tool.
- `vitest.config.ts` restricts coverage to `src/**/*.ts` excluding `__tests__` and `index.ts`.

## Conventions to preserve

- No auto-merge, no force-push, no branch deletion — the server must never expose a tool that does these, per the security model in the README/SDLC standard resource.
- Secret review has two distinct evidence tiers. `src/security/secret-scanner-evidence.ts` recognizes mature CI scanners (Gitleaks, TruffleHog, Secretlint, detect-secrets, or an explicit GitHub Secret Scanning check), but passing is trusted only for app-backed check runs from an allowed GitHub App (GitHub Actions App ID `15368` by default). Same-name commit statuses, incomplete CI sources, and PR changes to workflows/Gitleaks policy fail closed. `src/review/pull-request-review.ts`'s `scanPatchForSecrets` remains a conservative added-line heuristic only and must never be described as a complete secret scan.
- This repository runs Gitleaks from `.github/workflows/secret-scan.yml` using a full action commit SHA and least-privilege permissions. `.gitleaks.toml` narrows its only fixture exception to the `generic-api-key` rule in the dedicated scanner test file; do not broaden that exception to a directory or all rules.
- Evidence and review tests live under `src/__tests__/github/pull-request-evidence.test.ts`, `src/__tests__/review/pull-request-review.test.ts`, and the corresponding `src/__tests__/tools/*` integration suites. Changes to decision precedence, truncation boundaries, or degraded behavior require regression tests at both the pure and handler layers when applicable.
- All Windows-facing docs/comments use PowerShell syntax (`$env:VAR="value"`), not bash `export`.

## Repository governance (this repo, not the MCP server's tool capabilities)

- This repo is currently maintained by a single person (`SakuraCianna`, sole collaborator and CODEOWNER). GitHub does not allow a PR author to approve their own PR, so a "required approving review" branch protection rule cannot structurally be satisfied here — it would only force every merge through an admin-override bypass, which is worse for auditability than not having the rule.
- As of 2026-07-08, `main`'s branch protection has had `required_pull_request_reviews` removed. It still keeps `required_status_checks` (CI must pass) and `allow_force_pushes: false` / `allow_deletions: false`. Do not re-add a required-review rule unless the user explicitly asks, or unless a second collaborator has been added to the repo — at that point required review should be reconsidered.
- This is a repo-level GitHub setting, not a product capability change: it does not affect the "no auto-merge / no force-push / no branch deletion" rule above, which is about what the MCP server's *own tools* may do, not how this repo's own PRs get merged.

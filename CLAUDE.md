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
- Secret-pattern scanning (`review-pr.ts`'s `scanPatchForSecrets`) only matches added (`+`) patch lines with assignment-like patterns (`key\s*[:=]\s*['"...]`), not just keyword mentions — keep new secret patterns similarly conservative to avoid noisy false positives.
- All Windows-facing docs/comments use PowerShell syntax (`$env:VAR="value"`), not bash `export`.

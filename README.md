# agentic-sdlc-mcp

[![CI](https://github.com/SakuraCianna/agentic-sdlc-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SakuraCianna/agentic-sdlc-mcp/actions/workflows/ci.yml)

An MCP (Model Context Protocol) Server that acts as an **Agentic SDLC Control Plane** — helping AI coding agents plan, create, test, review, secure, and release software following GitHub Agentic AI best practices.

- GitHub: [SakuraCianna/agentic-sdlc-mcp](https://github.com/SakuraCianna/agentic-sdlc-mcp)
- Issues: [github.com/SakuraCianna/agentic-sdlc-mcp/issues](https://github.com/SakuraCianna/agentic-sdlc-mcp/issues)

---

## What Is This?

`agentic-sdlc-mcp` is not a simple GitHub API wrapper. It is a **SDLC orchestration layer** that exposes structured, agent-friendly tools aligned to the full software development lifecycle:

```
Plan -> Create -> Test -> Review -> Optimize -> Secure
```

**Safety first:** All write operations default to `dryRun: true`. Destructive or irreversible operations are never silently executed.

---

## Installation

**Requirements:** Node.js >= 24 (see `engines` in `package.json`; CI runs on Node 24).

```powershell
# Clone the repository
git clone https://github.com/SakuraCianna/agentic-sdlc-mcp.git
cd agentic-sdlc-mcp

# Install dependencies
npm install

# Build
npm run build
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` — it is loaded automatically by `dotenv` when the server starts.

Alternatively, set variables inline in PowerShell:

```powershell
$env:GITHUB_TOKEN = "ghp_your_token_here"
$env:GITHUB_OWNER = "your-org"
$env:GITHUB_REPO  = "your-repo"
```

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | GitHub PAT or App token |
| `GITHUB_OWNER` | Optional | Default owner (org or user) |
| `GITHUB_REPO` | Optional | Default repository name |
| `SDLC_DEFAULT_BRANCH` | Optional | Default branch (default: `main`) |
| `TRANSPORT` | Optional | `stdio` (default) or `http` |
| `PORT` | Optional | HTTP port (default: `3000`) |

### Required GitHub Token Scopes

| Scope | Purpose |
|---|---|
| `repo` | Read/write issues, PRs, file contents, checks (or `public_repo` for public-only repos) |
| `security_events` | Code Scanning and Dependabot alerts (or `public_repo` for public-only repos) |
| `repo` or `security_events` | Secret Scanning alerts |

> Verified against GitHub's REST API reference (Dependabot alerts, Code Scanning alerts, Secret Scanning alerts, Checks endpoints) as of this writing. GitHub's scope requirements can change — see the [REST API docs](https://docs.github.com/en/rest) if a tool reports a permission error that doesn't match this table.

---

## MCP Client Configuration

### Claude Desktop / Kiro / Cursor

Add to your MCP client config (`claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "command": "node",
      "args": ["E:/CodeHome/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token",
        "GITHUB_OWNER": "your-org",
        "GITHUB_REPO": "your-repo"
      }
    }
  }
}
```

Use forward slashes or escaped backslashes for Windows paths.

---

## Running the Server

### stdio mode (default — for MCP clients)

```powershell
$env:GITHUB_TOKEN = "ghp_your_token"
node dist/index.js
```

### HTTP mode (for remote / multi-client use)

```powershell
$env:TRANSPORT = "http"
$env:PORT      = "3000"
$env:GITHUB_TOKEN = "ghp_your_token"
node dist/index.js
# Server listens at http://localhost:3000/mcp
```

### Smoke test (no real token required)

Verifies the module loads cleanly and all tools register without error:

```powershell
npm run smoke
# Output: [agentic-sdlc-mcp] SMOKE OK — all tools and resources registered successfully.
```

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm run test` | Run the Vitest test suite |
| `npm run test:watch` | Watch mode for TDD |
| `npm run test:coverage` | Coverage report (lcov + text) |
| `npm run smoke` | Smoke-test: load + register, no real token needed |
| `npm run dev` | Watch mode with tsx (development) |
| `npm start` | Run the compiled server |

---

## MCP Inspector (smoke test / exploration)

```powershell
$env:GITHUB_TOKEN = "ghp_your_token"
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Tools Reference

### `repo_context`
Read repository metadata, README, package.json, open issues, and open PRs.
Use at the start of every workflow.
- `issueLimit` / `prLimit` (number, default: `20`, max: `100`): cap how many open issues/PRs are fetched, to avoid token-heavy responses on large repos.

### `plan_from_context`
Generate a phase-by-phase SDLC plan (Plan→Create→Test→Review→Optimize→Secure).
Template-based — no LLM call needed.

### `create_issue_set`
Batch-create GitHub issues from a plan.
⚠️ `dryRun` defaults to `true` — pass `dryRun: false` to write to GitHub.

### `prepare_work_item`
Generate an agent-ready brief for a specific issue: goals, non-goals, acceptance criteria, risks, and a handoff prompt.
- `includeRelatedFiles` (boolean, default: `false`): heuristically extract file paths mentioned in the issue body.
- `includeRecentPRs` (boolean, default: `false`): scan up to 20 recently-updated closed PRs and return up to 5 merged ones that touched the related file hints (requires `includeRelatedFiles` to have found hints — returns an empty list otherwise). Output field: `recentPRs`.

### `quality_gate_status`
Read check-run results for a PR or git ref.
Use to verify CI before merging or releasing.

### `create_pr_summary`
Generate a structured PR summary: change overview, file categories, test coverage signals, risks, review checklist, and release notes draft.

### `review_pr_against_standard`
Review a PR against SDLC standards (`basic` / `strict` / `security-focused`).
`security-focused` mode scans actual patch lines for secret patterns, `.env` files, lockfile changes, and dist files.

### `security_triage`
Read Code Scanning, Dependabot, and Secret Scanning alerts, triage by severity, recommend fix order.

### `release_readiness_check`
Pre-release assessment: CI status, open bugs, CHANGELOG, release checklist, rollback template.

### `agent_handoff_packet`
Generate a compact handoff packet so another agent can continue work without losing context.

---

## Resources

| URI | Description |
|---|---|
| `sdlc://standards/agentic-sdlc` | Full Agentic SDLC standard with phases and human gates |
| `sdlc://templates/issue` | Standard issue template |
| `sdlc://templates/pr-summary` | Standard PR summary template |
| `sdlc://templates/release-readiness` | Pre-release checklist template |
| `sdlc://templates/handoff` | Agent handoff template |

---

## dryRun Safety Model

All write tools implement `dryRun`:

| `dryRun` | Effect |
|---|---|
| `true` (default) | Preview mode — no GitHub API writes |
| `false` | Live mode — actually writes to GitHub |

The default is always `dryRun: true`. Agents must explicitly pass `dryRun: false`.

---

## Workflow Examples

### 1. Start a new feature

```
1. repo_context                  # understand the codebase
2. plan_from_context (goal=...)  # generate SDLC plan
3. create_issue_set (dryRun:true) # preview issues
4. create_issue_set (dryRun:false) # create issues
5. prepare_work_item (issueNumber=N) # get agent brief
```

### 2. Review a pull request

```
1. create_pr_summary (pullNumber=N)             # diff overview
2. quality_gate_status (pullNumber=N)            # CI check
3. review_pr_against_standard (standard:strict)  # findings
```

### 3. Pre-release check

```
1. security_triage                # check alerts
2. release_readiness_check        # full readiness
3. (fix blocking issues)
4. Human approval before tagging release
```

---

## Security

- Never commit your `GITHUB_TOKEN` — use `.env` or PowerShell `$env:` variables
- `dryRun: true` by default prevents accidental writes
- No auto-merge, no force-push, no branch deletion
- Secret scanning alerts are always rated `critical`
- The server does not make outbound requests beyond the GitHub API

---

## Development

```powershell
# Type check
npm run typecheck

# Watch mode
npm run dev

# Build
npm run build

# Test
npm run test

# Smoke test (no token needed)
npm run smoke
```

---

## Publishing (Maintainers)

This package is published to npm using **Trusted Publishing (OIDC)** — no long-lived `NPM_TOKEN` secret is stored in the repo. Publishing is handled by `.github/workflows/publish.yml`.

### One-time setup on npmjs.com

1. Sign in to [npmjs.com](https://www.npmjs.com) and open the package's **Settings -> Publishing access**.
2. Add a **Trusted Publisher** with:
   - Provider: `GitHub Actions`
   - Repository: `SakuraCianna/agentic-sdlc-mcp`
   - Workflow filename: `publish.yml`
3. Save. From then on, `publish.yml` publishes without any npm token — GitHub issues a short-lived OIDC token that npm exchanges for a publish credential, and provenance is generated automatically.

> First publish only: if the package name doesn't exist on npm yet, Trusted Publisher can't be linked until the package exists. In that case, do one manual `npm publish` from your machine with a classic token first, then configure Trusted Publishing for all subsequent releases. The `publish.yml` workflow itself always uses OIDC — it never falls back to a token.

### Triggering a publish

- **Preferred:** create a GitHub Release (tag it, then "Publish release") — this fires `release: published` and runs `publish.yml` automatically.
- **Manual:** go to **Actions -> Publish to npm -> Run workflow** (`workflow_dispatch`).

### Pre-publish checklist (run locally before tagging a release)

```powershell
npm run typecheck
npm run build
npm run test
npm run smoke
npm run test:coverage
npm pack --dry-run
```

`npm pack --dry-run` prints exactly which files would ship in the published tarball, without creating one. Confirm only `dist/`, `README.md`, and `.env.example` are included — test files and `package-lock.json` must NOT appear (enforced by `tsconfig.build.json`, which excludes `src/__tests__/**` from the compiled `dist/` output used for publishing).

### GitHub Actions workflows

| Workflow | Trigger | Purpose |
|---|---|---|
| `.github/workflows/ci.yml` | `pull_request`, `push` to `main` | Runs typecheck, build, test, smoke, and coverage on Node 24 |
| `.github/workflows/publish.yml` | GitHub Release published, or manual dispatch | Publishes to npm via OIDC Trusted Publishing |
| `.github/dependabot.yml` | Weekly schedule | Opens PRs for npm and GitHub Actions dependency updates (labelled `dependencies`) |

---

## License

MIT

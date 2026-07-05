# agentic-sdlc-mcp

An MCP (Model Context Protocol) Server that acts as an **Agentic SDLC Control Plane** — helping AI coding agents plan, create, test, review, secure, and release software following GitHub Agentic AI best practices.

---

## What Is This?

`agentic-sdlc-mcp` is not a simple GitHub API wrapper. It is a **SDLC orchestration layer** that exposes structured, agent-friendly tools aligned to the full software development lifecycle:

```
Plan → Create → Test → Review → Optimize → Secure
```

It is designed to be used by AI coding agents (Claude, GPT-4, Codex, etc.) to:

- Read repository context before starting work
- Generate structured SDLC plans
- Create tracked issue sets
- Prepare agent-ready work briefs
- Monitor CI/quality gate status
- Summarise and review pull requests
- Triage security alerts
- Run pre-release readiness checks
- Generate handoff packets between agents

**Safety first:** All write operations default to `dryRun: true`. Destructive or irreversible operations are never silently executed.

---

## Installation

```bash
# Clone or copy the project
cd agentic-sdlc-mcp

# Install dependencies
npm install

# Build
npm run build
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | ✅ Yes | GitHub PAT or App token |
| `GITHUB_OWNER` | Optional | Default owner (org or user) |
| `GITHUB_REPO` | Optional | Default repository name |
| `SDLC_DEFAULT_BRANCH` | Optional | Default branch (default: `main`) |
| `TRANSPORT` | Optional | `stdio` (default) or `http` |
| `PORT` | Optional | HTTP port when `TRANSPORT=http` (default: `3000`) |

### Required GitHub Token Scopes

| Scope | Purpose |
|---|---|
| `repo` | Read/write issues, PRs, file contents |
| `read:org` | Read org membership (optional) |
| `security_events` | Code Scanning alerts |
| `vulnerability_alerts` | Dependabot alerts |
| `secret_scanning_alerts` | Secret Scanning alerts |

For read-only workflows, `repo:read` is sufficient for most tools.

---

## MCP Client Configuration

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "command": "node",
      "args": ["/absolute/path/to/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token",
        "GITHUB_OWNER": "your-org",
        "GITHUB_REPO": "your-repo"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "command": "node",
      "args": ["/absolute/path/to/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token",
        "GITHUB_OWNER": "your-org",
        "GITHUB_REPO": "your-repo"
      }
    }
  }
}
```

### Kiro CLI / Other MCP Clients

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/absolute/path/to/agentic-sdlc-mcp",
      "env": {
        "GITHUB_TOKEN": "ghp_your_token"
      }
    }
  }
}
```

---

## Tools Reference

### `repo_context`
Read repository metadata, README, package.json, open issues, and open PRs.  
**Use at the start of every workflow.**

### `plan_from_context`
Generate a phase-by-phase SDLC plan (Plan→Create→Test→Review→Optimize→Secure) from a goal and repo context. Template-based — no LLM call needed.

### `create_issue_set`
Batch-create GitHub issues from a plan.  
⚠️ **dryRun defaults to `true`** — pass `dryRun: false` to actually create issues.

### `prepare_work_item`
Generate an agent-ready brief for a specific issue: goals, non-goals, acceptance criteria, risks, recommended commands, and a handoff prompt.

### `quality_gate_status`
Read check run and commit status results for a PR or git ref.  
Use to verify CI before merging or releasing.

### `create_pr_summary`
Generate a structured PR summary: change overview, affected files, test coverage signals, risks, review checklist, and release notes draft.

### `review_pr_against_standard`
Review a PR against SDLC standards (`basic` / `strict` / `security-focused`).  
Returns sorted findings, missing tests, security concerns, and a conclusion.

### `security_triage`
Read Code Scanning, Dependabot, and Secret Scanning alerts, triage them by severity, and recommend fix order.

### `release_readiness_check`
Pre-release assessment: CI status, open bugs, CHANGELOG, and a release checklist + rollback template.

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

All tools that write to GitHub implement a `dryRun` parameter:

| dryRun | Effect |
|---|---|
| `true` (default) | **Preview mode** — returns what would be created/changed, makes no GitHub API writes |
| `false` | **Live mode** — actually writes to GitHub |

**The default is always `dryRun: true`.** Agents must explicitly pass `dryRun: false` to trigger writes. This prevents accidental mutations during exploration or planning phases.

---

## Usage Examples

### 1. Start a new feature

```
1. Call repo_context to understand the codebase
2. Call plan_from_context with your feature goal
3. Call create_issue_set (dryRun: true) to preview issues
4. Review the preview, then call create_issue_set (dryRun: false)
5. Call prepare_work_item for each issue before implementation
```

### 2. Review a pull request

```
1. Call create_pr_summary to get a diff overview
2. Call quality_gate_status to check CI
3. Call review_pr_against_standard with standard: "strict"
4. Address findings, then re-check quality_gate_status
```

### 3. Pre-release check

```
1. Call security_triage to check for open alerts
2. Call release_readiness_check on the release branch
3. Fix blocking issues
4. Get human approval before tagging the release
```

---

## Security Considerations

- **Never commit your `GITHUB_TOKEN`** — use environment variables only
- All tokens are read at startup; the server never logs them
- dryRun defaults protect against accidental writes
- No auto-merge, no force-push, no branch deletion — ever
- Secret scanning alerts are always rated `critical` severity
- The server does not make outbound requests beyond the GitHub API

---

## Development

```bash
# Type check
npm run typecheck

# Watch mode
npm run dev

# Build
npm run build
```

### Smoke Test with MCP Inspector

```bash
GITHUB_TOKEN=ghp_xxx npx @modelcontextprotocol/inspector node dist/index.js
```

---

## License

MIT

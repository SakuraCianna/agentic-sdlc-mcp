# Generic AI Coding Agent Smoke Test Guide

This guide shows how any MCP-capable AI coding agent can verify that `agentic-sdlc-mcp` is configured correctly. It is intentionally client-neutral: use the same validation path whether the caller is a command-line agent, IDE agent, desktop MCP client, or another MCP-compatible tool.

The smoke test should take about five minutes and verifies three things:

1. The MCP server can be loaded by the client.
2. The server can resolve and read the target GitHub repository.
3. GitHub write-style workflows can be previewed safely with `dryRun: true` without creating real issues.

## Safety Rules

- Do not paste real tokens into prompts, chat transcripts, README files, pull request descriptions, release notes, or logs.
- Use placeholders such as `REPLACE_WITH_GITHUB_TOKEN` in shared examples.
- Keep write tools in preview mode unless a human explicitly approves a real write.
- `create_issue_set` defaults to `dryRun: true`, and this smoke test also passes `dryRun: true` explicitly.
- A dry-run preview must not create GitHub issues.

## Minimum Configuration

The server needs a GitHub token and repository coordinates. Repository coordinates can be supplied in either of two ways:

1. Configure `GITHUB_OWNER` and `GITHUB_REPO` as defaults.
2. Pass `owner` and `repo` directly in each MCP tool call.

If `owner` and `repo` are omitted from a tool call, the server falls back to `GITHUB_OWNER` and `GITHUB_REPO`. If neither source is available, repository-scoped tools should return a clear configuration error instead of guessing.

### Environment Variables

| Variable | Required | Purpose | Safety note |
|---|---:|---|---|
| `GITHUB_TOKEN` | Yes | Authenticates GitHub API reads and approved writes. | Treat as a secret. Do not commit or paste into shared text. |
| `GITHUB_OWNER` | Recommended | Default GitHub user or organization. | Not secret, but still verify before live writes. |
| `GITHUB_REPO` | Recommended | Default repository name. | Not secret, but still verify before live writes. |

For this smoke test, use a token that has access to the target repository and no broader access than your organization requires.

## MCP Client JSON Example

Use this as a generic shape for any MCP client that accepts JSON server configuration. Adjust the file location and wrapper format to match your client, but keep the command, arguments, and environment values equivalent.

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "command": "npx",
      "args": ["-y", "agentic-sdlc-mcp"],
      "env": {
        "GITHUB_TOKEN": "REPLACE_WITH_GITHUB_TOKEN",
        "GITHUB_OWNER": "your-github-owner",
        "GITHUB_REPO": "your-repository-name"
      }
    }
  }
}
```

## Windows PowerShell Local Check

If you are testing from a local checkout of this repository, you can verify that the server registers tools and resources without needing a real GitHub token:

```powershell
npm run smoke
```

Expected result: the command exits successfully after registering the MCP tools and resources. This local check does not prove your MCP client loaded the server; it only proves the package can start in smoke mode.

To test a real MCP client session, configure the client with environment variables instead of hardcoding secrets in prompts:

```powershell
$env:GITHUB_TOKEN = "REPLACE_WITH_GITHUB_TOKEN"
$env:GITHUB_OWNER = "your-github-owner"
$env:GITHUB_REPO = "your-repository-name"
```

## Step 1: Read-Only Repository Context

Ask the AI coding agent:

```text
Use agentic-sdlc-mcp to read repo_context for the currently configured default repository. Do not modify files, create issues, open pull requests, or call any write tool.
```

Expected agent behavior:

- Calls `repo_context`.
- Omits `owner` and `repo` only if `GITHUB_OWNER` and `GITHUB_REPO` are configured.
- Does not call `create_issue_set` or any other write-style tool.

Example direct tool input:

```json
{
  "issueLimit": 5,
  "prLimit": 5
}
```

Expected response evidence:

- Repository full name.
- Default branch.
- Primary language, when GitHub reports it.
- Open issue and pull request counts or recent summaries.
- Whether README and package metadata were available.
- A clear remediation message if the token or repository coordinates are missing.

### Optional: Deeper Briefing Context

`repo_context` can also report the package manager, detected tech stack, common
verification commands (build/typecheck/test/smoke), workflow file names,
governance signals (e.g. whether a CODEOWNERS file exists), and any agent
instruction files it can find (e.g. `AGENTS.md`, `CLAUDE.md`). Ask:

```text
Use agentic-sdlc-mcp repo_context to tell me how this repo is built, tested, and which agent rules apply, without modifying anything.
```

Expected agent behavior:

- Calls `repo_context` with `includePackageJson`, `includeWorkflows`,
  `includeGovernance`, and `includeAgentInstructions` enabled.
- Still does not call any write tool.

Expected response evidence:

- Detected package manager (npm/pnpm/yarn) or `unknown` if it cannot be determined.
- A short list of detected technologies (e.g. TypeScript, Vitest, Express).
- Key npm scripts (build/typecheck/test/smoke) if present in `package.json`.
- Workflow file names under `.github/workflows`, if any.
- Whether a CODEOWNERS file was found.
- Summaries of any agent instruction files found, truncated to a safe length.

## Step 2: Safe Dry-Run Issue Preview

Ask the AI coding agent:

```text
Use agentic-sdlc-mcp to preview three smoke-test GitHub issues with create_issue_set. This must be dry-run only. Do not create real GitHub issues.
```

Expected agent behavior:

- Calls `create_issue_set`.
- Explicitly passes `dryRun: true`.
- Uses harmless smoke-test issue drafts.
- Reports that no real issue was created.

Example direct tool input:

```json
{
  "dryRun": true,
  "issues": [
    {
      "title": "[Smoke Test] Verify repo_context access",
      "body": "Preview only. Confirms the agent can read repository context before planning work.",
      "labels": ["documentation"]
    },
    {
      "title": "[Smoke Test] Verify dry-run issue preview",
      "body": "Preview only. Confirms create_issue_set can show planned issues without calling the live GitHub create path.",
      "labels": ["documentation"]
    },
    {
      "title": "[Smoke Test] Verify SDLC next-step guidance",
      "body": "Preview only. Confirms the agent can explain the next safe step after context gathering.",
      "labels": ["documentation"]
    }
  ]
}
```

Expected response evidence:

- `dryRun: true` is visible in the response.
- The preview includes issue titles, labels, and body summaries.
- Created issue identifiers or URLs are absent, empty, or clearly marked as not created.
- The agent states that no GitHub issues were created.

## Step 3: Repository Readiness Prompt

Ask the AI coding agent:

```text
Check whether the currently connected GitHub repository is ready for later Agentic SDLC workflows. Start with context only. Do not create issues, open pull requests, or modify repository settings.
```

Expected agent behavior:

- Starts with `repo_context`.
- Does not call `plan_from_context` unless the user asks for a plan.
- Does not call any write-style tool.

Expected response evidence:

- The connected repository is identified clearly, or missing coordinates are explained.
- MCP tool availability is confirmed from observed tool results, not assumed.
- Suggested next steps are safe, such as reading deeper context, generating a plan, or previewing issue creation with `dryRun: true`.

## Common Failures and Fixes

| Failure | Likely cause | Fix |
|---|---|---|
| Token missing | `GITHUB_TOKEN` is not configured in the MCP server environment. | Add `GITHUB_TOKEN` to the MCP client server config or set it in the launching shell. |
| Repository coordinates missing | The tool call omitted `owner` and `repo`, and `GITHUB_OWNER` / `GITHUB_REPO` are not configured. | Configure defaults or pass `owner` and `repo` explicitly. |
| Permission denied | The token cannot access the repository or required GitHub API. | Use a token approved for the target repository and organization policy. |
| MCP server not found | The client did not load the server command. | Check the MCP client configuration path, restart the client, and inspect client logs. |
| Dry-run preview looks like a real write | The agent did not pass or report `dryRun: true` clearly. | Stop before approving any live write and rerun the preview with explicit `dryRun: true`. |
| No README or package metadata | The target repository does not have those files, or the token cannot read them. | Treat the context as degraded and ask for explicit project instructions before planning work. |

## Five-Minute Acceptance Checklist

- [ ] The MCP client loads `agentic-sdlc-mcp` without startup errors.
- [ ] `repo_context` returns the expected target repository or a clear configuration fix.
- [ ] The read-only test does not call any write-style tool.
- [ ] `create_issue_set` is called with `dryRun: true`.
- [ ] The dry-run response previews issues but does not create GitHub issue numbers or URLs.
- [ ] No real token, cookie, private key, or certificate appears in prompts, logs, docs, PR text, or release notes.

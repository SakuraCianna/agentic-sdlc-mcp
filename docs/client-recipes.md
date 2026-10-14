# Client recipes for PR evidence review

These are thin client configurations for the **1.11.0 source candidate**, checked against official documentation on **2026-10-15**. They do not establish that this version is published, that a client was exercised end to end, or that any client has certified the server. No external users were contacted.

## Shared setup and boundary

Use Node.js 22 or newer and a reviewed build (`npm ci`, then `npm run build`). Replace `E:/tools/agentic-sdlc-mcp/dist/index.js` below with the absolute path to that build. Using `node` directly avoids client-specific Windows `npx` wrappers and a mutable package selection. For a released package, separately verify its exact version and restart the client's server connection after an upgrade.

Inject a GitHub token restricted to the repositories and read permissions needed for this review. Never put its value into a committed configuration, chat, or command argument. The examples select `SDLC_CONFIG_MODE=envonly` and `SDLC_READ_ONLY=true`:

- `envonly` makes the MCP entry point skip `.env`, home configuration reads, persisted credential updates, and interactive setup. Unset or `default` retains the compatible configuration behavior; any other value fails. Select this mode in the parent environment or client configuration, not in a `.env` file that you intend to skip.
- `SDLC_READ_ONLY=true` blocks live `create_issue_set` requests; explicit previews remain available. It does not restrict another server, shell, agent, or token outside this process.
- The separate `agentic-sdlc` CLI always reads environment variables only. It needs no mode switch. `agentic-sdlc-mcp` remains the server command.

The minimal PR review tool allowlist is:

```text
repo_context
create_pr_summary
quality_gate_status
review_pr_against_standard
sdlc_evidence_packet
```

Keep `create_issue_set` outside this review profile and retain normal per-call client confirmation. Add other read-only tools only for an explicit task. This tool list is a client selection policy; the server still discovers 13 tools. A prompt or portable skill is not an access-control mechanism.

## Claude Code

Place this entry under `mcpServers` in a reviewed project `.mcp.json`. Start Claude Code from an environment where `GITHUB_TOKEN` is already injected. Claude Code documents `.mcp.json`, environment-variable expansion, and the `/mcp` connection view. [Official MCP instructions](https://code.claude.com/docs/en/mcp).

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "type": "stdio",
      "command": "node",
      "args": ["E:/tools/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "SDLC_CONFIG_MODE": "envonly",
        "SDLC_READ_ONLY": "true"
      }
    }
  }
}
```

For this review profile, a `.claude/settings.json` deny rule removes the Issue creation tool while leaving ordinary confirmations in place. This is a deny rule, not an auto-approval allowlist. [Official permission rules](https://code.claude.com/docs/en/permissions).

```json
{
  "permissions": {
    "deny": ["mcp__agentic-sdlc__create_issue_set"]
  }
}
```

Use only the five review tools above. An installation scope or a successful configuration write does not prove the server connected; inspect `/mcp`, then run the read-only verification below.

## Codex CLI or IDE extension

The local `codex mcp --help` and `codex mcp add --help` commands were inspected without modifying settings. The official documentation describes TOML server entries, `env_vars` forwarding, and `enabled_tools`. Add the following to a reviewed `~/.codex/config.toml` or project `.codex/config.toml`; inject the token into the parent environment. [Official OpenAI MCP documentation](https://developers.openai.com/codex/mcp).

```toml
[mcp_servers.agentic-sdlc]
command = "node"
args = ["E:/tools/agentic-sdlc-mcp/dist/index.js"]
env_vars = ["GITHUB_TOKEN"]
env = { SDLC_CONFIG_MODE = "envonly", SDLC_READ_ONLY = "true" }
enabled_tools = ["repo_context", "create_pr_summary", "quality_gate_status", "review_pr_against_standard", "sdlc_evidence_packet"]
```

Restart the connection and inspect `/mcp` in the CLI or the IDE's MCP server view. Keep the client's existing approval policy. No `approval_mode` override is needed.

## Cursor

Use project `.cursor/mcp.json` or your personal `~/.cursor/mcp.json`. Cursor documents `mcpServers`, stdio fields, and `${env:NAME}` interpolation. Launch Cursor with the token already available in its environment. [Official Cursor MCP documentation](https://cursor.com/docs/mcp).

```json
{
  "mcpServers": {
    "agentic-sdlc": {
      "type": "stdio",
      "command": "node",
      "args": ["E:/tools/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}",
        "SDLC_CONFIG_MODE": "envonly",
        "SDLC_READ_ONLY": "true"
      }
    }
  }
}
```

Use the five-tool review policy and inspect each tool call's arguments. Keep default tool confirmation enabled. Cursor's enterprise MCP policy can restrict approved servers and tools; availability depends on the organization's settings. No per-tool JSON allowlist field is assumed in this recipe.

## GitHub Copilot in VS Code

This recipe targets Copilot Chat in VS Code; it does not configure Copilot cloud agents or GitHub-hosted code review. Organization policy can affect MCP availability. Use the chat tool picker to keep only the five review tools selected. [Official GitHub IDE integration instructions](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/extend-copilot-chat-with-mcp?tool=vscode).

VS Code uses a `servers` object in `.vscode/mcp.json`, with masked `promptString` inputs for secrets. [Official VS Code configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "sdlc-github-token",
      "description": "GitHub read token for the authorized repositories",
      "password": true
    }
  ],
  "servers": {
    "agentic-sdlc": {
      "type": "stdio",
      "command": "node",
      "args": ["E:/tools/agentic-sdlc-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${input:sdlc-github-token}",
        "SDLC_CONFIG_MODE": "envonly",
        "SDLC_READ_ONLY": "true"
      }
    }
  }
}
```

Start the configured server from VS Code and inspect the discovered tools. Retain normal tool approvals; do not enable a general auto-approve setting to make setup easier.

## Portable review skill

The instruction-only [pr-evidence-review skill](../skills/pr-evidence-review/SKILL.md) uses existing tools or the CLI. It grants no permissions and has no hooks, executable downloads, or merge/approval actions. Its source folder is included in the candidate package; the project does not install it into a client's personal settings.

For local Codex discovery, copy the skill folder into the target repository's `.agents/skills/`, keeping `pr-evidence-review/SKILL.md`. [Official OpenAI skill locations](https://developers.openai.com/codex/skills). Claude Code documents project `.claude/skills/<name>/SKILL.md`; copy the same folder there if that is the chosen host. [Official Claude Code skill locations](https://code.claude.com/docs/en/skills). Do not overwrite an existing skill. For other clients, explicitly attach/read the file as task instructions unless their current documentation establishes native skill discovery; this recipe does not assume it.

Example request:

```text
Use pr-evidence-review for acme/widget PR #42. Keep this session read-only. Report the head/base SHAs, policy digest, blockers, evidence gaps, and next human action. Do not approve, merge, post comments, or create Issues. Checked acceptance boxes and green CI alone do not prove business acceptance.
```

## Verify and record what actually ran

Run offline `agentic-sdlc doctor --repo acme/widget` first, then opt into `--online` read probes for an authorized repository. Run `repo_context` with explicit owner/repo, inspect the actual server name/version from MCP discovery, and assess one explicit PR. The CLI's installed version can differ from a long-running MCP process; restart and rediscover after upgrading. A missing endpoint or permission is a gap, not proof that the underlying control is absent.

| Evidence class | What is established here |
|---|---|
| Client documentation | The four recipes were checked against the linked official sources on 2026-10-15. |
| Local client help | Codex MCP command syntax was inspected; no account or client settings were changed. |
| Actual client sessions | Not executed for this candidate by this documentation task; record client/version, server/version, transport, commands, and sanitized results when performed. |
| SDK/Inspector/package smoke | Separate repository tests and packaging checks; their results must be reported separately and do not certify these four clients. |
| User pilot | Planned only in [user-pilot.md](user-pilot.md); no users, repositories, or outcomes are enrolled by these recipes. |

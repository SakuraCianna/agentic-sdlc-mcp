# README redesign for production GitHub agent governance

## Status

Approved direction, ready for implementation planning after user review.

## Content plan

- **Content type**: Landing page with embedded quickstart and concise reference
- **Primary audience**: Engineering leaders and platform/DevOps teams that already let Claude Code, Cursor, or similar agents change production repositories
- **Reader knowledge**: They understand GitHub, pull requests, CI, personal access tokens (PATs), and AI coding agents; they do not need an MCP primer
- **Reader concern**: They need evidence that an autonomous agent cannot silently bypass repository policy, quality gates, security checks, or human approval
- **Goal**: Help a team evaluate the control model, connect the published npm package, choose least-privilege permissions, and identify the correct MCP tool for each SDLC decision
- **Open questions**: None

## Product message

The README must lead with this promise:

> Let AI coding agents work in real GitHub repositories without giving up traceability, review gates, or human control.

The project is a governance and evidence layer, not a code-generation agent and not a generic GitHub API wrapper. The README must avoid absolute safety claims. It should say that the server collects and evaluates evidence, exposes gaps, and keeps high-impact decisions reviewable.

The four product outcomes remain visible but concise:

- Let AI agents use SDLC controls without guessing which GitHub API to call
- Reduce repeated human supervision through structured briefs, gates, and handoffs
- Give agents repository context, policy, risk, and provenance before they act
- Give organizations explicit permissions, bounded evidence, safe defaults, and human approval points

## Chosen approach

Use a governance-first product README. It combines the low-friction opening of high-star product repositories with enough technical evidence for a platform team to evaluate trust boundaries.

Rejected alternatives:

- **Landing-page only**: Lower reading cost, but insufficient for teams evaluating PAT scope and governance behavior
- **Full reference manual**: Exhaustive, but repeats the current problem of hiding the product story inside parameter-level detail

## Information architecture

Both `README.md` and `README_zh.md` use the same section order and equivalent claims:

1. Hero, badges, language switch, one-sentence value proposition
2. What changes when you add this MCP
3. Where it fits in a production agent workflow
4. Use cases
5. Install from npm and connect an MCP client
6. Verify the connection with a read-only first call
7. Tool catalog
8. Common workflows
9. GitHub permission matrix
10. Safety model and trust boundaries
11. Repository policy and static resources
12. Local HTTP profile
13. Development, roadmap, releases, and license

Do not use horizontal rules between sections. Use sentence-case headings, short paragraphs, and no more than a small set of functional Emoji. English is the default README; both files link to each other near the hero.

## Hero and first screen

The first screen must answer three questions without scrolling through architecture:

- What is it: an MCP control plane for GitHub-based agentic SDLC
- Who is it for: teams running coding agents against real repositories
- Why use it: to make agent work traceable, policy-aware, evidence-driven, and subject to human gates

Keep npm version, CI, downloads, Node version, MCP Registry, and license badges. Avoid generic marketing language such as “professional,” “seamless,” or “safe by design” unless the following section names the concrete control.

## Before and after comparison

Add a compact table titled “Without this MCP / With this MCP.” It must compare observable workflow behavior rather than promise perfect safety:

| Concern | Without the control plane | With `agentic-sdlc-mcp` |
|---|---|---|
| Repository context | Agent starts from the prompt and guesses project conventions | Agent reads bounded repository context, scripts, policy, issues, and PRs |
| High-risk work | Authentication, payment, migration, and workflow changes use generic plans | Risk-aware briefs add defensive requirements, negative scenarios, rollback, and observability |
| Issue planning | Plans require manual conversion into GitHub work items | Structured issue drafts flow into preview-first issue creation |
| Pull requests | A green CI badge may be treated as sufficient evidence | Gate output separates checks, reviews, CODEOWNERS routing, protection, labels, and missing evidence |
| Secret risk | Scanner names or keyword matches may be trusted without provenance | Reviews distinguish trusted scanner evidence, bounded patch heuristics, and unverified gaps |
| Release and handoff | Status depends on free-form summaries | Release and handoff tools preserve blockers, evidence warnings, policy obligations, and human approval points |

## Production workflow diagram

Use one Mermaid flowchart in the workflow section. It should show:

```text
Human policy and repository rules
                |
AI coding agent -> agentic-sdlc-mcp -> GitHub evidence
                |                       |
                +-> brief / plan / gate / review / release report
                                        |
                                  Human decision
```

The diagram must not show the MCP creating releases, merging pull requests, pushing code, or deploying software. It may show the agent or human performing those actions outside this server after review.

## Use cases

Add eight scannable scenarios. Each scenario names the risk, the recommended tool sequence, and the expected decision artifact:

1. Onboard an agent into an unfamiliar production repository
2. Turn a feature, bug, or security goal into reviewable GitHub work items
3. Prepare authentication, authorization, payment, migration, or infrastructure work
4. Detect patch-local dynamic secret and authentication-header construction risk
5. Check whether a pull request has enough evidence for human review
6. Audit branch rules, CODEOWNERS routing, and GitHub Actions permissions
7. Assess release readiness without treating missing CI as passing
8. Hand work to another agent without presenting caller assertions as verified facts

The README should also state when not to use the server: it does not execute arbitrary repository code, merge pull requests, force-push, deploy, or replace human security review.

## npm-first quickstart

The published npm package is the primary path:

```powershell
npx -y agentic-sdlc-mcp
```

Use `npm install -g agentic-sdlc-mcp` as the secondary CLI path. Source installation belongs in the development section, not the main onboarding path.

The MCP client example must use descriptive placeholders such as `your_github_token_here`, `your_organization`, and `your_repository`. Add a Windows note for clients that require `cmd /c npx` wrapping. Do not show a real token prefix.

The first verification call is read-only:

```text
Use agentic-sdlc-mcp to run repo_context for the configured repository. Do not create issues or modify GitHub.
```

Follow with a `create_issue_set` dry-run example so teams can validate the write boundary without granting or exercising write access.

## Tool catalog

List all 12 registered tools. The first table must fit on one screen and contain:

- Tool name
- When to use it
- Main result
- Access mode: read-only or preview-first write

Group tools by workflow:

- Context and planning: `repo_context`, `plan_from_context`, `prepare_work_item`
- Work tracking: `create_issue_set`
- Pull request evidence: `create_pr_summary`, `quality_gate_status`, `review_pr_against_standard`
- Governance and security: `branch_protection_status`, `workflow_permissions_audit`, `security_triage`, `release_readiness_check`
- Continuity: `agent_handoff_packet`

After the table, use grouped `<details>` sections for key inputs, important outputs, budgets, and limitations. Preserve the implementation details that affect decisions, including:

- Work type inference and confidence
- Repository policy provenance and base-SHA behavior
- Related-file, dependency, and recent-PR evidence budgets
- Gate conclusions and degraded evidence
- Trusted scanner provenance versus patch-local dynamic construction heuristics
- Release readiness fail-closed behavior
- Caller assertions in handoff packets

Do not duplicate every Zod field. MCP clients already receive the runtime schema. The README explains how to choose and interpret a tool.

## Common workflows

Present copyable tool sequences for:

- Start work: `repo_context` -> `plan_from_context` -> `create_issue_set` dry-run -> `prepare_work_item`
- Review a PR: `create_pr_summary` -> `quality_gate_status` -> `review_pr_against_standard`
- Review governance: `branch_protection_status` -> `workflow_permissions_audit` -> `security_triage`
- Prepare a release: `security_triage` -> `release_readiness_check` -> human approval
- Transfer work: relevant evidence tools -> `agent_handoff_packet`

Each workflow states what the human still decides.

## Permission matrix

Replace the single broad PAT list with capability-based least privilege. The table must distinguish:

- Baseline repository metadata and contents
- Issues and pull requests read
- Checks and commit statuses read
- Administration read for classic branch protection
- Code scanning, Dependabot, and secret scanning alert read
- Organization/team metadata read when ownership resolution needs it
- Issues write only for `create_issue_set` with `dryRun: false`

State that teams should grant only the permissions required by the tools they enable. Missing optional permissions should produce degraded or unverified evidence where the implementation supports it, not justify granting every permission by default.

## Safety and trust boundaries

The README must be explicit:

- Eleven tools are read-only; `create_issue_set` is the only GitHub write tool
- `create_issue_set` defaults to `dryRun: true`; live writes require `dryRun: false`
- The server has no merge, approval, force-push, branch deletion, branch-rule mutation, release creation, or deployment tool
- CODEOWNERS and repository rules are evidence sources; the MCP reports gaps but does not enforce GitHub settings itself
- Security heuristics are bounded patch analysis, not whole-program data flow or proof that a repository is secret-free
- Missing, stale, truncated, or permission-limited evidence must remain visible
- The local HTTP profile is loopback-only and must not be exposed or reverse-proxied as a remote service
- Interactive `configure` currently stores the token in a local JSON file; production-focused guidance should prefer client secret injection or environment variables and label persisted local configuration as a single-user compatibility path

## Bilingual consistency

The two README files must have:

- Identical section order, tool count, commands, tables, links, safety claims, and limitations
- Natural English and Chinese phrasing rather than sentence-by-sentence literal translation
- The same placeholders and code blocks, except explanatory comments may be localized
- No duplicate headings or missing tool sections
- No outdated version-specific claims when a stable capability description is sufficient

## Known inaccuracies to remove

The rewrite must fix these current issues:

- Duplicate “快速入门” heading in `README_zh.md`
- Chinese `workflow_permissions_audit` section incorrectly contains the generic dry-run table and omits its actual behavior
- Chinese tool reference omits the complete `agent_handoff_packet` section
- English and Chinese `prepare_work_item` descriptions differ materially
- The sequence diagram implies that the MCP creates GitHub releases and publishes packages
- “CODEOWNERS Enforced Review” overstates the server's authority; the server reads and evaluates evidence
- “All write tools” is misleading because only `create_issue_set` writes to GitHub
- Broad PAT permissions appear mandatory even when a team enables only a subset of tools
- Production readers are encouraged toward plaintext persistent token configuration without a prominent compatibility warning

## Validation

After implementation:

- Confirm both READMEs mention exactly 12 registered tools and every tool name matches `src/server.ts`
- Confirm all commands and scripts match `package.json`
- Confirm package name, Node requirement, Registry identity, transport, and version claims match `package.json` and `server.json`
- Validate internal links, relative file links, fenced-code languages, Mermaid syntax, duplicate headings, placeholders, and line endings
- Compare section and tool parity between English and Chinese files
- Run `npm run check:line-endings`, `npm run typecheck`, `npm run test`, and `npm run build`
- Run a writing-guidelines review and an independent reviewer focused on accuracy, security wording, cognitive load, and bilingual consistency

## Files in scope

- `README.md`
- `README_zh.md`
- This design specification

No source code, environment files, credentials, package metadata, workflows, or the user's untracked `src.zip` are in scope.

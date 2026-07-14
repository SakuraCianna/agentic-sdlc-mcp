# Production-focused README redesign implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the English and Chinese READMEs so engineering leaders can evaluate, install, and govern AI coding agents with lower reading cost and accurate safety boundaries.

**Architecture:** Treat each README as a product landing page with npm-first onboarding, a production workflow, tool catalog, permission matrix, and trust-boundary reference. Keep both languages structurally equivalent and derive every capability claim from `src/server.ts`, tool registrations, `package.json`, `server.json`, and the approved design specification.

**Tech stack:** GitHub-flavored Markdown, Mermaid, HTML badges/details, npm, PowerShell validation, Git

---

### Task 1: Rewrite the English README

**Files:**

- Modify: `README.md`
- Reference: `docs/superpowers/specs/2026-07-14-readme-redesign.md`
- Reference: `src/server.ts`
- Reference: `package.json`
- Reference: `server.json`

- [ ] **Step 1: Replace the current information architecture**

Use this exact section order:

```text
Hero and language switch
What changes with this MCP
How it fits into a production agent workflow
Use cases
Install from npm
Connect an MCP client
Verify the connection
Tools
Common workflows
GitHub permissions
Safety and trust boundaries
Repository policy and resources
Local HTTP profile
Development and project links
License
```

- [ ] **Step 2: Add the approved comparison, scenarios, and workflow diagram**

Include the six-row “Without this MCP / With this MCP” comparison, eight production scenarios, and one Mermaid flowchart. Keep merge, release creation, deployment, and code-writing actions outside the MCP boundary.

- [ ] **Step 3: Make the published npm package the primary install path**

Use `npx -y agentic-sdlc-mcp` first, `npm install -g agentic-sdlc-mcp` second, and source installation only in the development section. Use `your_github_token_here`, `your_organization`, and `your_repository` placeholders.

- [ ] **Step 4: Document all registered tools without reproducing runtime schemas**

Add one scannable table for all 12 tool names, use cases, results, and access modes. Add grouped `<details>` sections for decision-relevant inputs, outputs, budgets, provenance, degraded evidence, dynamic secret construction limits, and caller assertions.

- [ ] **Step 5: Replace broad permission guidance with a least-privilege matrix**

Separate baseline contents/metadata, Issues and pull requests, checks/statuses, Administration read, security alert permissions, optional organization metadata, and Issues write for live `create_issue_set` calls.

### Task 2: Rewrite the Chinese README with structural parity

**Files:**

- Modify: `README_zh.md`
- Reference: `README.md`
- Reference: `docs/superpowers/specs/2026-07-14-readme-redesign.md`

- [ ] **Step 1: Recreate the approved section order in natural Chinese**

Keep headings, tables, tool count, commands, links, Mermaid nodes, and safety claims equivalent to the English README. Translate for meaning rather than sentence order.

- [ ] **Step 2: Correct the existing Chinese documentation defects**

Remove the duplicate “快速入门” heading, restore the real `workflow_permissions_audit` behavior, add the complete `agent_handoff_packet` explanation, and align `prepare_work_item` with v1.8 implementation.

- [ ] **Step 3: Preserve production-focused security wording**

State that eleven tools are read-only, `create_issue_set` is preview-first, persisted interactive configuration is a local single-user compatibility path, local HTTP is loopback-only, and heuristic scanning is not whole-program proof.

### Task 3: Validate accuracy, readability, and bilingual consistency

**Files:**

- Verify: `README.md`
- Verify: `README_zh.md`
- Verify: `docs/superpowers/plans/2026-07-14-readme-redesign.md`

- [ ] **Step 1: Verify repository state and scope**

Run:

```powershell
git status --short --branch
git diff -- README.md README_zh.md
```

Expected: only the two README files and this plan are new or modified; unrelated user files and changes remain untouched.

- [ ] **Step 2: Verify tool names and bilingual parity**

Run a PowerShell check that asserts every registered tool name appears in both READMEs, both files contain 12 unique tool identifiers, and required section concepts appear in both languages.

Expected: all assertions pass with no missing or extra tool names.

- [ ] **Step 3: Verify Markdown mechanics**

Check duplicate headings, untagged fenced code blocks, unsafe token placeholders, internal relative links, Mermaid fence balance, trailing whitespace, and LF line endings.

Expected: no duplicate headings, untagged fences, real-token-shaped placeholders, broken local links, unbalanced fences, trailing whitespace, CRLF, or mixed line endings.

- [ ] **Step 4: Run repository checks**

Run:

```powershell
npm run check:line-endings
npm run typecheck
npm run test
npm run build
```

Expected: all commands exit with code 0.

- [ ] **Step 5: Run prose review and independent repository review**

Apply the fetched writing guidelines to both READMEs. Then ask an independent reviewer to check requirement coverage, security wording, tool accuracy, user comprehension, bilingual parity, and missing validation/documentation.

Expected: reviewer conclusion is “通过”, or all actionable findings are fixed and re-reviewed.

### Task 4: Commit, push, and merge through the protected workflow

**Files:**

- Commit: `README.md`
- Commit: `README_zh.md`
- Commit: `docs/superpowers/plans/2026-07-14-readme-redesign.md`

- [ ] **Step 1: Stage only task files**

Run:

```powershell
git add -- README.md README_zh.md docs/superpowers/plans/2026-07-14-readme-redesign.md
git diff --cached --check
git status --short
```

Expected: only task files are staged; unrelated user files and changes remain untouched.

- [ ] **Step 2: Commit in Chinese**

Run:

```powershell
git commit -m "重写中英文 README 并完善工具指南"
```

Expected: one documentation commit is created on `sakuracianna`.

- [ ] **Step 3: Push the allowed branch and merge through a PR**

Run:

```powershell
git push origin sakuracianna
gh pr create --base main --head sakuracianna --title "重写中英文 README 并完善生产治理指南" --body-file .codex-readme-pr.md
$prNumber = gh pr list --head sakuracianna --state open --json number --jq '.[0].number'
gh pr checks $prNumber --watch --interval 10
gh pr merge $prNumber --merge
```

Create `.codex-readme-pr.md` with the verified change summary before this step and delete it after PR creation. Expected: CI passes, the PR merges into `main`, and no branch is deleted or force-pushed.

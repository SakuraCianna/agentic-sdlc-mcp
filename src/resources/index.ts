/**
 * MCP Resources for the Agentic SDLC Server.
 *
 * These are static reference documents exposed as resources so agents can
 * read standards and templates without calling a tool.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const AGENTIC_SDLC_STANDARD = `# Agentic SDLC Standard

## Overview

The Agentic SDLC is a six-phase software development lifecycle designed for AI coding agents
working within GitHub. It ensures traceability, human oversight at key gates, and auditability
of every change.

## Phases

### 1. Plan
- Clarify requirements, acceptance criteria, and constraints
- Identify affected components and interfaces
- Define risks and unknowns
- Get human approval on scope before proceeding
- Output: issue set, SDLC plan document

### 2. Create
- Work from a feature branch, never directly on main
- Implement changes incrementally with commits
- Write or update tests alongside implementation
- Reference the issue number in every commit message
- Output: branch with commits, passing local tests

### 3. Test
- Run the full test suite
- Verify no regressions
- Test edge cases and error paths
- Achieve or maintain coverage thresholds
- Output: test results, coverage report

### 4. Review
- Open a PR with a clear description and linked issues
- Run automated checks (CI, lint, type-check)
- Request human review — do NOT auto-merge
- Address all review comments
- ✋ **Human approval gate: PR must be approved by a human before merge**
- Output: approved PR

### 5. Optimize
- Profile if performance-sensitive changes were made
- Review for unnecessary dependencies
- Consolidate related commits if requested
- Output: clean, efficient implementation

### 6. Secure
- Run Dependabot / dependency audit
- Check for secret leakage
- Review input validation and error handling
- Verify access control changes
- ✋ **Human approval gate: security review required for auth/data changes**
- Output: security sign-off

## Traceability Requirements

- Every commit must reference an issue number
- Every PR must be linked to one or more issues
- All human decisions must be recorded in issue/PR comments
- Release tags must reference the PR that introduced the change

## Human Approval Gates

| Gate | When | Who |
|------|------|-----|
| Scope approval | After Plan phase | Product owner or tech lead |
| PR review | Before merge | At least one human reviewer |
| Security review | Before release (for auth/data changes) | Security-designated reviewer |
| Release approval | Before production deployment | On-call or release manager |

## Safety Defaults

- All write operations default to dryRun: true
- Agents must not auto-merge PRs
- Agents must not force-push to protected branches
- Agents must not delete branches without confirmation
- All destructive operations require explicit human confirmation
`;

const ISSUE_TEMPLATE = `# Issue Template

## Title
[Category] Short imperative description of the work

## Body

### Background
_What context does the reader need to understand this issue?_

### Goal
_What should be true after this issue is resolved?_

### Non-Goals
_What is explicitly OUT of scope for this issue?_

### Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] All tests pass
- [ ] No regressions

### Technical Notes
_Any implementation hints, links to relevant code, or constraints._

### Risks
- Risk 1: mitigation approach
- Risk 2: mitigation approach

### Definition of Done
- [ ] Implementation complete
- [ ] Tests added or updated
- [ ] PR reviewed and approved
- [ ] CI passing
- [ ] Documentation updated if applicable
`;

const PR_SUMMARY_TEMPLATE = `# PR Summary Template

## Summary
_One paragraph describing WHAT changed and WHY._

## Changes
_Bullet list of the main changes._

- Changed X to fix Y
- Added Z to support W
- Removed deprecated V

## Testing
_How was this tested?_

- [ ] Unit tests added/updated
- [ ] Integration tests run
- [ ] Manual testing performed (describe steps)
- [ ] Edge cases verified

## Risks
_What could go wrong after merging?_

- Risk 1
- Risk 2

## Review Checklist
- [ ] Code logic is correct
- [ ] Edge cases handled
- [ ] No secrets in the diff
- [ ] Documentation updated
- [ ] CI checks pass

## Release Notes Draft
\`\`\`markdown
### <Feature/Fix Title>
<One-sentence description for the changelog>
\`\`\`

## Related Issues
Closes #<issue_number>
`;

const RELEASE_READINESS_TEMPLATE = `# Release Readiness Checklist Template

## Pre-Release Gate

**Release version:** <version>
**Date:** <date>
**Repo:** <owner>/<repo>
**Release engineer:** <name>

## CI & Quality
- [ ] All CI checks pass on the release branch/tag
- [ ] No type errors (tsc --noEmit)
- [ ] No lint errors
- [ ] Test coverage is at or above threshold

## Security
- [ ] No open critical/high Dependabot alerts
- [ ] No open code scanning critical/high alerts
- [ ] No exposed secrets (secret scanning clean)
- [ ] Dependencies audited (npm audit / pip-audit / cargo audit)

## Documentation
- [ ] CHANGELOG.md updated
- [ ] README reflects current behaviour
- [ ] API docs updated if public API changed
- [ ] Migration guide written if breaking changes

## Deployment
- [ ] Environment config reviewed
- [ ] Feature flags set correctly
- [ ] Database migrations tested (if applicable)
- [ ] Rollback plan documented

## Sign-off
- [ ] Product owner sign-off
- [ ] Tech lead sign-off
- [ ] Security review sign-off (if auth/data changes)

## Rollback Plan
1. Identify last known-good version: <previous_tag>
2. Trigger rollback deployment
3. Verify health checks
4. Open incident issue
5. Notify stakeholders
`;

const HANDOFF_TEMPLATE = `# Agent Handoff Template

## Handoff Prompt (copy this to the next agent)
\`\`\`
You are taking over work on <owner>/<repo>.

Current status: <what has been done>

Repository: <full_name> (default branch: <default_branch>)
Active issue: #<number> — <title> (<url>)
Active PR: #<number> — <title> (<url>)

Your next steps (in order):
1. <step 1>
2. <step 2>
3. <step 3>

Tools available: repo_context, quality_gate_status, review_pr_against_standard,
security_triage, release_readiness_check, create_issue_set, agent_handoff_packet

Start by calling \`repo_context\` to orient yourself, then proceed with next steps.
\`\`\`

## Current State
_Describe what the previous agent did._

## Decisions Made
- Decision 1 and rationale
- Decision 2 and rationale

## Remaining Tasks
- [ ] Task 1
- [ ] Task 2
- [ ] Task 3

## Verification Needed
- [ ] Run quality_gate_status to confirm CI
- [ ] Run review_pr_against_standard if PR is open
- [ ] Confirm acceptance criteria from original issue are met
- [ ] Human review and approval before merge
`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    "agentic-sdlc-standard",
    "sdlc://standards/agentic-sdlc",
    {
      title: "Agentic SDLC Standard",
      description:
        "The Agentic SDLC standard: six phases (Plan→Create→Test→Review→Optimize→Secure), traceability requirements, and human approval gates.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "sdlc://standards/agentic-sdlc",
          mimeType: "text/markdown",
          text: AGENTIC_SDLC_STANDARD,
        },
      ],
    })
  );

  server.registerResource(
    "issue-template",
    "sdlc://templates/issue",
    {
      title: "Issue Template",
      description: "Standard GitHub issue template for Agentic SDLC work items.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "sdlc://templates/issue",
          mimeType: "text/markdown",
          text: ISSUE_TEMPLATE,
        },
      ],
    })
  );

  server.registerResource(
    "pr-summary-template",
    "sdlc://templates/pr-summary",
    {
      title: "PR Summary Template",
      description: "Standard pull request summary template.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "sdlc://templates/pr-summary",
          mimeType: "text/markdown",
          text: PR_SUMMARY_TEMPLATE,
        },
      ],
    })
  );

  server.registerResource(
    "release-readiness-template",
    "sdlc://templates/release-readiness",
    {
      title: "Release Readiness Template",
      description: "Pre-release checklist template.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "sdlc://templates/release-readiness",
          mimeType: "text/markdown",
          text: RELEASE_READINESS_TEMPLATE,
        },
      ],
    })
  );

  server.registerResource(
    "handoff-template",
    "sdlc://templates/handoff",
    {
      title: "Agent Handoff Template",
      description: "Template for generating an agent-to-agent handoff packet.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "sdlc://templates/handoff",
          mimeType: "text/markdown",
          text: HANDOFF_TEMPLATE,
        },
      ],
    })
  );
}

# User workflow delivery implementation plan

**Goal:** Deliver trustworthy PR decisions, safe Issue recovery, practical diagnostics, evidence continuity and release-ready distribution while preserving the 13-tool MCP interface.

**Architecture:** Reuse existing GitHub evidence and policy evaluators behind a read-only CLI and optional Actions job. Keep evidence comparison and acceptance mapping pure and bounded. Additive MCP fields preserve old clients; explicit GitHub identities and immutable SHAs bind decisions. Existing coding agents continue to execute code.

**Tech stack:** TypeScript, Zod, MCP SDK 2.0.0, Octokit, Vitest, GitHub Actions, npm OIDC.

The user confirmed this scope on 2026-10-14. Work occurs directly in E:/CodeHome/agentic-sdlc-mcp on feature/sdlc-delivery. The user requires normal feature branches without a codex prefix and no isolated worktrees. The two pre-existing uncommitted documents stay untouched and are excluded from commits.

## 1. Correctness
- [x] Prefer Code Scanning security_severity_level; valid SARIF severity remains fallback. Invalid fields produce incomplete evidence.
- [x] Reuse review's work-type classification for PR policy in quality_gate_status, including renamed paths.
- [x] Add and run targeted regression tests in src/__tests__/tools/security-triage.test.ts and quality-gate-status.test.ts; cover triage→evidence and gate/review consistency. Full final validation remains in section 6.

## 2. Safe write recovery
- [x] Add optional idempotencyKey/previewDigest through request-level params._meta["io.github.SakuraCianna/agentic-sdlc-mcp/issue-recovery"] and additive per-item recovery output. Keep the existing tool argument schema unchanged; same-named extra arguments cannot enable recovery.
- [x] Propagate request cancellation to GitHub; stop starting new items after cancellation or unknown commit outcome.
- [x] Verify existing marker/payload before reuse. Bounded or unavailable remote evidence prevents new uncertain writes.
- [x] Support SDLC_READ_ONLY=true for preview-only use. No credential or persistent home-state changes.
- [x] Add targeted tests for partial success, unknown response, cancellation, conflicting previews/keys, concurrent retries and bounded lookup.
- [x] Document the JSON-RPC metadata position and strict recovery option validation. Clients unable to attach metadata use default preview/basic reporting, without automatic idempotency claims.

## 3. Read-only PR delivery
Files: src/assessment/pr-assessment.ts, github-session.ts; src/cli.ts; src/cli/arguments.ts and doctor.ts; matching tests.
- [x] Add a second bin, agentic-sdlc, without changing the MCP command entry point.
- [x] Implement doctor, assess-pr, evidence, diff and trace commands. Validate all CLI arguments and local JSON sizes before use.
- [x] Default assess-pr to advisory; --enforce returns nonzero for blocked or incomplete decisions.
- [x] Bind assessment to repository, PR, complete immutable head/base SHAs, policy digest and generator version. Detect drift in all observed PR reads and perform an independent final check.
- [x] Emit bounded JSON, safe Markdown and optional GitHub step summary; never print credentials or raw upstream errors.
- [x] Provide request count, duration, timeout and degraded metrics locally; no remote telemetry.
- [x] Exclude only the verified current Actions check ID from self-dependency; same-name unrelated checks remain required. Report modeled self-dependency separately without rewriting the original gate conclusion.
- [x] Add targeted tests for read-only boundaries, target changes, pending/failed checks, missing permissions, exact self identity and cancellation.
- [x] Add explicit MCP SDLC_CONFIG_MODE=envonly with no dotenv/home reads or interactive configuration; preserve compatible defaults and cover isolated home/dotenv canaries.

CLI contract:
```powershell
agentic-sdlc doctor --json
agentic-sdlc doctor --repo owner/repo --online --json
agentic-sdlc assess-pr --repo owner/repo --pr 12 --json --output assessment.json
agentic-sdlc assess-pr --repo owner/repo --pr 12 --enforce
agentic-sdlc evidence --repo owner/repo --subject pr --number 12 --output evidence.json
agentic-sdlc diff --previous previous.json --current current.json --json
agentic-sdlc trace --packet evidence.json --acceptance acceptance.md --json
```

## 4. Evidence continuity and acceptance
Files: src/assessment/continuity.ts, acceptance.ts, docs/evidence-continuity.md and tests.
- [x] Compare stable evidence IDs and report added/removed/changed/unchanged without inheriting verification.
- [x] Reject cross-repository/subject comparison; invalidate SHA, policy, tool/schema and expired evidence changes.
- [x] Extract bounded criteria from explicit Markdown, Spec Kit or OpenSpec text with stable content-derived IDs.
- [x] Distinguish association, human judgement, missing evidence and trusted acceptance verification. Checked tasks or ordinary CI pass never self-prove business acceptance.
- [x] Require complete 40/64-hex packet/item/mapping/provenance SHAs and valid Issue/PR numbers for positive acceptance. Preserve mutable-ref/abbreviated-SHA and missing-number regressions.
- [x] Connect these pure functions to CLI files, not a database or a new universal MCP tool.

## 5. Integration, supply chain and documentation
- [x] Add an opt-in reusable PR Actions workflow using an exact published reviewer package, no PR checkout or execution, read-only permissions and explicit advisory/enforce mode.
- [x] Add a Windows configuration/stdio/CLI smoke job. A configured job is distinct from evidence of a remote successful run.
- [x] Implement local prepare-only tarball, lockfile-derived production CycloneDX SBOM and SHA-256 manifest generation; inspect actual package files and bind versions/source digests/HEAD/dirty state without publishing or signing.
- [ ] Independently verify final release tag/source/public-package consistency through the existing npm/Registry OIDC publication workflows; signed attestations and publication of prepared SBOM/manifest remain separate work.
- [x] Provide Claude Code, Codex, Cursor and Copilot recipes plus a portable review Skill. Distinguish documented configurations, SDK/package smoke and actual client sessions.
- [x] Update README/README_zh, ROADMAP, CHANGELOG and a new release note. Record v1.10's public-distribution gap without fabricating a historical release.
- [x] Include a privacy-preserving external pilot checklist and aggregate scorecard; do not claim pilot outcomes without participants.

## 6. Final verification and handoff
```powershell
npm run check:line-endings
npm run typecheck
npm run test:coverage
npm run smoke
npm run contracts:check
npm run eval:ci
npm run contracts:verify-baseline
npm run contracts:inspector:stdio
npm run contracts:inspector:http
npm run contracts:conformance:pilot
```
- [x] Verify the actual tarball CLI/MCP in an ignored artifact-validation directory under the original project, without creating a development worktree or checkout. Both bins and legacy/modern stdio metadata previews passed; the package has 252 files and the lockfile-only production SBOM has 89 components.
- [x] Independently review spec compliance and code quality, repair findings and repeat relevant checks. Final local coverage is 79 files / 1,940 tests; contract, Inspector, Conformance baseline and deterministic evaluation checks passed. Historical-source replay runs in existing remote CI because its local implementation creates a worktree.
- [ ] Commit only task files, push feature branch and create a reviewable PR when credentials permit; no AI attribution.
- [ ] Public release follows completed PR/required checks and the user's existing authorization; never bypass branch protection or fabricate remote results. Report any concrete remaining approval/access requirement.

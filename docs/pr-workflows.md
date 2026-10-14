# PR evidence workflows

The `agentic-sdlc` CLI is read-only. It uses the same gate and rule-review handlers as the MCP server. The existing `agentic-sdlc-mcp` command remains the MCP entry point.

## Run from a checkout

```powershell
npm ci
npm run build
node dist/cli.js doctor --json
node dist/cli.js doctor --repo owner/repository --online --json
node dist/cli.js assess-pr --repo owner/repository --pr 12 --json --output assessment-new.json --summary assessment-new.md
```

Inject `GITHUB_TOKEN` through the process or client's secret configuration. The CLI does not read home configuration or `.env`. Its effective `readOnly` value is always `true`; diagnostic `mcpReadOnlyConfigured` only reports whether the separate MCP live-write guard is configured. Offline diagnostics work without a token and return exit 2 when configuration is missing. The diagnostic version identifies the installed CLI; restart a long-running MCP connection and inspect discovery to verify that server's actual version.

After an exact version is publicly available, both binaries are included in the npm package. Until then use the reviewed checkout or a locally prepared tarball.

## Decisions and exit codes

| Result | Meaning | Advisory exit | With --enforce |
|---|---|---:|---:|
| ready_for_review | Collected evidence supports human review within the declared scope | 0 | 0 |
| blocked | An observed gate or rule-review requirement is unmet | 0 | 1 |
| needs_evidence | A source, policy, target or decision remains incomplete | 0 | 2 |
| Invalid input / unavailable collection | A report could not be established | 2 | 2 |
| Caller cancellation | Collection was cancelled | 130 | 130 |

A successful decision never approves a PR, proves business acceptance, merges code or authorizes deployment. `--acceptance` adds traceability; its human-judgement rows do not silently become proof of business acceptance or a new repository rule.

Successful reports identify complete 40- or 64-character hexadecimal PR head/base SHAs, repository policy digest, generator version, blockers, suggested actions, local metrics and a digested decision packet. All observed PR metadata reads are compared to the initial target, followed by an independent final read. A changed target invalidates the snapshot even if it changed back before the final read. With `--json`, collection failures return a safe error envelope and bounded timeout/cancellation/degraded metrics instead of a successful assessment packet.

`--timeout-ms` is bounded at 120000; `--max-requests` at 500. A final target check is reserved within the request budget. No remote telemetry is sent. Errors use fixed safe messages; the CLI disables SDK request logging to keep upstream bodies and endpoint paths out of incidental logs.

## Opt-in GitHub Actions

The reusable workflow at [.github/workflows/pr-evidence.yml](../.github/workflows/pr-evidence.yml) is repository source, not an npm-bundled workflow, and only runs when called. It installs an exact published package without lifecycle scripts, uses read-only permissions and never checks out or executes PR code.

This template requires the referenced workflow and npm version to exist publicly. Replace the explicit SHA placeholder below with the reviewed full commit containing that workflow before adopting it; the candidate does not establish that the example npm version is published:

```yaml
name: PR evidence
on:
  pull_request:
permissions:
  contents: read
  checks: read
  pull-requests: read
  actions: read
jobs:
  evidence:
    uses: SakuraCianna/agentic-sdlc-mcp/.github/workflows/pr-evidence.yml@REPLACE_WITH_REVIEWED_FULL_COMMIT_SHA
    with:
      pull_number: ${{ github.event.pull_request.number }}
      package_version: "1.11.0"
      enforce: false
```

Start in advisory mode. After observing acceptable noise and permission coverage, select `enforce: true` and explicitly add the check in your own repository settings if desired. This project does not change your branch protection automatically. Fork PR tokens may lack protection or security feature access; unavailable evidence remains a gap rather than a clean result. Installation or workflow infrastructure failures can still fail the job in advisory mode.

### Current check dependency

The workflow passes the official `job.check_run_id`. The CLI verifies that ID against the GitHub Actions App, exact workflow run, PR head association and job URL before excluding only that active check. Other checks, including the same name from another App, remain evidence.

App-bound branch/ruleset requirements can identify the current check precisely. Unscoped name-only requirements are retained. A verified current check that is the only remaining modeled dependency may produce `selfDependency: other_requirements_satisfied` when independent CI passes and every other modeled obligation is satisfied. The original `gateConclusion` and gate packet remain unverified/policy-gap; GitHub's merge block stays in force until the current check completes.

Strict status policies, unsupported merge/review requirements, missing evidence, different Apps, unknown identity or absence of independent passing CI remain unresolved. The CLI does not override these rules. Do not add this assessment check as a self-requirement in `.agentic-sdlc.yml`; explicit policy requirements are preserved, not rewritten. On hosts without `job.check_run_id`, use advisory output and retain unresolved identity.

The workflow uploads only the JSON report and Markdown summary, with a 14-day retention. If collection cannot create these files, the assessment step creates a fixed `workflow-unavailable-1` / `needs_evidence` fallback instead of uploading raw CLI error output. Review the reports' repository metadata before sharing outside the repository.

Official context reference: [job.check_run_id](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#job-context).

## Compare and trace

```powershell
node dist/cli.js assess-pr --repo owner/repository --pr 12 --previous assessment-old.json --acceptance acceptance.md --json --output assessment-next.json
node dist/cli.js evidence --repo owner/repository --subject pr --number 12 --json --output packet-new.json
node dist/cli.js diff --previous packet-old.json --current packet-new.json --json
node dist/cli.js trace --packet packet-new.json --acceptance acceptance.md --source openspec --json
```

Use a new output path for each run. Existing files are never overwritten, and input/output aliases are rejected. Explicit `--summary` files are also new files, except that the trusted runner's own `GITHUB_STEP_SUMMARY` path may be appended.

Local files are bounded at 1 MiB. A previous report is input data, not a signature or an authorization token. See [evidence continuity and acceptance](evidence-continuity.md) for strict target identities, mappings and default producer trust.

## Issue preview and recovery through MCP

`create_issue_set` keeps `dryRun: true` by default. Advanced recovery options belong only in the request-level `params._meta["io.github.SakuraCianna/agentic-sdlc-mcp/issue-recovery"]` object. Its optional fields are `idempotencyKey` (1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`) and `previewDigest` (64 lowercase hexadecimal characters). The metadata object is strict: invalid types, unknown fields, or invalid values return a fixed MCP error before GitHub calls. These are not tool arguments; the existing tool argument schema is unchanged and same-named extra argument fields are ignored rather than enabling recovery.

This JSON-RPC example requests a zero-write preview. `_meta`, `name`, and `arguments` are siblings inside `params`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_issue_set",
    "arguments": {
      "owner": "acme",
      "repo": "widget",
      "issues": [{ "title": "Review export behavior", "body": "Confirm the agreed report export conditions." }],
      "dryRun": true
    },
    "_meta": {
      "io.github.SakuraCianna/agentic-sdlc-mcp/issue-recovery": {
        "idempotencyKey": "reviewed-batch-01"
      }
    }
  }
}
```

A successful preview returns `previewDigest` in structured content. After an explicitly authorized review, a capable caller can retain the complete unchanged payload and same metadata key, add that returned digest as metadata `previewDigest`, and explicitly select `dryRun: false`. A preview without a key can also use metadata `previewDigest` alone for live content matching. Metadata and digests are optional for compatible callers; neither proves human approval. Clients that cannot attach request metadata should use default previews and basic reports, without claiming automatic idempotent retry or metadata recovery support.

The live batch has a 30-second deadline. Cancellation stops new submissions and reaches upstream requests, but an already submitted write may have committed. Read per-item `created/reused/failed/unknown/pending` and `recovery.retrySafe`. Retain the full batch and key; do not reconstruct unknown items as a fresh batch.

Recovery inspects at most 300 issue/PR entries including closed items. Incomplete lookup preserves confirmed references and prevents uncertain missing-item creation. Process-local unknown/confirmed state survives cancelled recovery requests. GitHub canonical account/label casing does not invalidate the same original batch; changing the original payload still changes its digest.

Markers correlate work; they do not authorize it. Separate processes, restarts, marker editing and bounded-record eviction cannot provide exactly-once guarantees. Preview digests prove matching content, not human approval. For agent hosts that may invoke tools autonomously, set `SDLC_READ_ONLY=true` to allow previews while refusing live Issue writes.

## Prepare a release

```powershell
npm.cmd run release:prepare -- --output-name candidate-review-1
```

On Windows PowerShell, use `npm.cmd` for npm scripts with forwarded arguments to preserve the `--` separator; some `npm.ps1`/npm combinations consume it before the script receives the options. The project's npm script itself remains platform-neutral.

This first builds the reviewed checkout, then packs with npm lifecycle scripts disabled, inspects the actual tarball without extracting it, creates a CycloneDX SBOM from the lockfile with development dependencies omitted, and writes a SHA-256 manifest under `artifacts/release/candidate-review-1`. The SBOM describes that lockfile inventory, not an independently observed deployment. The manifest binds actual source files, package files, version metadata and Git HEAD, and explicitly records a dirty tree. Existing output directories are refused.

Preparation does not publish or sign anything. A dirty-tree candidate is useful for review; its HEAD alone does not identify its package. Final publication continues through the repository's Release-triggered npm/Registry OIDC workflows and exact-version checks. Signed artifact attestations and publication of prepared SBOM/manifest are separate from the local preparation capability.

## Validate a client and a user workflow

[Client recipes](client-recipes.md) distinguish documented configuration, package smoke tests and real client sessions. [The user pilot](user-pilot.md) is an unexecuted protocol for recording reviewer time, repeated questions, false blocks and extra cost on authorized samples. No real-client or external-user outcome is inferred from offline tests.

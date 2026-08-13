# Agent Review Issue Tracker

## Review baseline

- Change set: v1.10.0 release candidate
- Fixed comparison point: immutable `v1.9.0` commit `3e1cdbb2d591ba482903f53579f1f76cc95ff1c4`
- Working branch: `sakuracianna`
- Review date: 2026-08-13

## External risk status

| ID | Severity | Status | Description | Disposition |
|---|---|---|---|---|
| EXT-001 | Moderate | Resolved for current lock | GHSA-frvp-7c67-39w9 affects Hono `serve-static` on Windows in versions before 1.19.15 and from 2.0.0 through 2.0.4 | The lockfile remains on upstream-patched `@hono/node-server@1.19.15`; production imports only `getRequestListener` and exposes no static-file route. Reopen if node-server is downgraded or static-file serving is introduced. |
| EXT-002 | Moderate | Resolved in v1.10 candidate | Hono 4.12.27 was covered by CORS ReDoS, JSX `memo` disclosure, proxy-header and language-middleware complexity advisories | An in-range lock update resolves Hono 4.13.1 without changing MCP SDK 2.0.0. Full and production audits report zero known vulnerabilities; reopen if affected middleware becomes reachable or the SDK dependency tree changes. |

## Reviewer findings

Independent standards and specification reviews are required before commit. Findings are added here only when they remain open or are accepted with explicit risk.

| ID | Severity | Status | Description | Resolution |
|---|---|---|---|---|
| REV-001 | High | Resolved | npm OIDC publish job used mutable third-party Action tags, and the Registry job lacked equivalent target ancestry checks | Pinned checkout/setup-node to full commit SHAs and applied release-tag, `main` ancestry and metadata checks to both OIDC publication jobs |
| REV-002 | Medium | Resolved | Medium-severity prompt-injection signals could remain in agent-facing Markdown | Omit every detected signal from Markdown; preserve raw structured evidence as untrusted data |
| REV-003 | Medium | Resolved | Local PAT config inherited default file permissions | Create and tighten the config file to `0600` where POSIX modes are supported |

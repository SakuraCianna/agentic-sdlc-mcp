# Agent Review Issue Tracker

## Review baseline

- Change set: v1.9.0 release candidate
- Fixed comparison point: `04f57f1094fdec674ea575b71a3f707cbc45b3b2`
- Working branch: `sakuracianna`
- Review date: 2026-07-28

## External risk status

| ID | Severity | Status | Description | Disposition |
|---|---|---|---|---|
| EXT-001 | Moderate | Not actionable | GHSA-frvp-7c67-39w9 affects Hono `serve-static` on Windows in versions before 1.19.15 and from 2.0.0 through 2.0.4; npm audit currently flattens the range to `<2.0.5` and reports Hono plus the SDK | The lockfile resolves the upstream-patched 1.19.15 release. Production code imports only `getRequestListener` through the MCP SDK and exposes no static-file route. Accept the two moderate audit entries; reopen if Hono is downgraded or static-file serving is introduced |
| EXT-002 | Moderate | Not actionable | Hono 4.12.27 is in the stable MCP 2.0.0 Node adapter tree and npm audit now groups the CORS ReDoS, JSX `memo` disclosure, proxy header, and language-middleware complexity advisories into the current three package-level moderate findings | Production imports only `toNodeHandler`; it does not import Hono CORS, JSX/SSR, proxy, language, or static middleware. Keep the stable MCP 2.0.0 lock, do not claim audit green, and reopen immediately if an affected middleware becomes reachable or the SDK publishes a compatible patched dependency tree |

## Reviewer findings

Independent standards and specification reviews are required before commit. Findings are added here only when they remain open or are accepted with explicit risk.

| ID | Severity | Status | Description | Resolution |
|---|---|---|---|---|
| REV-001 | High | Resolved | npm OIDC publish job used mutable third-party Action tags, and the Registry job lacked equivalent target ancestry checks | Pinned checkout/setup-node to full commit SHAs and applied release-tag, `main` ancestry and metadata checks to both OIDC publication jobs |
| REV-002 | Medium | Resolved | Medium-severity prompt-injection signals could remain in agent-facing Markdown | Omit every detected signal from Markdown; preserve raw structured evidence as untrusted data |
| REV-003 | Medium | Resolved | Local PAT config inherited default file permissions | Create and tighten the config file to `0600` where POSIX modes are supported |

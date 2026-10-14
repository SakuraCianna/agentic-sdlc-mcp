import type { Octokit } from "@octokit/rest";
import { SERVER_INFO } from "../version.js";
import { TOOL_NAMES } from "../catalog.js";
import { withAbortableTimeout } from "../evidence/timeout.js";
import { createReadOnlyGithubSession } from "../assessment/github-session.js";
import type { RepoRef } from "../types.js";

export interface DoctorCheck { id: string; state: "available" | "missing" | "unverified" | "not_configured"; action: string }
export interface DoctorReport {
  schemaVersion: "1.0"; server: typeof SERVER_INFO; nodeVersion: string;
  repository: string | null; credentialPresent: boolean; readOnly: boolean; mcpReadOnlyConfigured: boolean;
  status: "ready" | "needs_configuration" | "degraded";
  checks: DoctorCheck[]; limitations: string[];
}

export async function diagnose(input: { env: NodeJS.ProcessEnv; ref?: RepoRef; online: boolean; timeoutMs?: number; signal?: AbortSignal }, octokit?: Octokit): Promise<DoctorReport> {
  const credentialPresent = Boolean(input.env["GITHUB_TOKEN"]?.trim());
  const major = Number(process.versions.node.split(".")[0]);
  const checks: DoctorCheck[] = [
    { id: "node", state: major >= 22 ? "available" : "missing", action: major >= 22 ? "Node runtime meets the package requirement." : "Install Node.js 22 or newer." },
    { id: "credential", state: credentialPresent ? "available" : "missing", action: credentialPresent ? "A process credential is present; its value is never reported." : "Inject GITHUB_TOKEN through your client or process environment." },
    { id: "repository", state: input.ref ? "available" : "not_configured", action: input.ref ? "Repository coordinates were validated." : "Pass --repo owner/repo or configure GITHUB_OWNER and GITHUB_REPO." },
    { id: "tool_catalog", state: TOOL_NAMES.length === 13 ? "available" : "unverified", action: `${TOOL_NAMES.length} workflow tools are bundled with this package.` },
  ];
  if (input.online && input.ref && octokit) {
    const ref = input.ref;
    await withAbortableTimeout("Repository diagnostics", input.timeoutMs ?? 10_000, async (signal) => {
      const { client } = createReadOnlyGithubSession(octokit, { signal, maxRequests: 12 });
      const probe = async (id: string, operation: () => Promise<unknown>, optionalMissing = false) => {
        try { await operation(); checks.push({ id, state: "available", action: "Read access verified for this endpoint." }); }
        catch (error) {
          const status = error && typeof error === "object" && "status" in error ? (error as { status: unknown }).status : undefined;
          checks.push({ id, state: optionalMissing && status === 404 ? "not_configured" : "unverified", action: optionalMissing && status === 404 ? "No repository policy was found at the probed default branch." : "Check repository access, feature availability and token permissions; absence and permission denial may share a 404 response." });
        }
      };
      let defaultBranch: string | undefined;
      await probe("repository_api", async () => { const { data } = await client.repos.get({ ...ref }); defaultBranch = data.default_branch; });
      if (defaultBranch) {
        const branch = defaultBranch;
        await probe("repository_policy", () => client.repos.getContent({ ...ref, path: ".agentic-sdlc.yml", ref: branch }), true);
        await probe("checks", () => client.checks.listForRef({ ...ref, ref: branch, per_page: 1 }));
        await probe("branch_protection", () => client.repos.getBranchProtection({ ...ref, branch }));
      }
      await probe("pull_requests", () => client.pulls.list({ ...ref, state: "open", per_page: 1 }));
      await probe("code_scanning", () => client.codeScanning.listAlertsForRepo({ ...ref, state: "open", per_page: 1 }));
      await probe("dependabot", () => client.dependabot.listAlertsForRepo({ ...ref, state: "open", per_page: 1 }));
      await probe("secret_scanning", () => client.secretScanning.listAlertsForRepo({ ...ref, state: "open", per_page: 1 }));
    }, input.signal);
  }
  return {
    schemaVersion: "1.0", server: SERVER_INFO, nodeVersion: process.versions.node,
    repository: input.ref ? `${input.ref.owner}/${input.ref.repo}` : null, credentialPresent,
    readOnly: true,
    mcpReadOnlyConfigured: input.env["SDLC_READ_ONLY"] === "true",
    status: !credentialPresent || !input.ref || major < 22 ? "needs_configuration" : checks.some((check) => check.state === "unverified") ? "degraded" : "ready",
    checks,
    limitations: [
      "This reports the installed CLI package. A connected MCP client may still run an older server; restart its connection and inspect discovery metadata.",
      "No home configuration, .env file, credential value or private response body is read into this report.",
      input.online ? "Endpoint availability does not prove every operation or security feature is authorized." : "Offline diagnostics do not verify GitHub permissions. Use --online for read-only endpoint probes.",
    ],
  };
}

import { describe, it, expect, vi } from "vitest";
import { diagnose } from "../../cli/doctor.js";
import { createGithubContractFixture } from "../fixtures/github-contract-fixtures.js";

const ref = { owner: "example", repo: "project" };
describe("read-only diagnostics", () => {
  it("works offline without secrets or a repository and never constructs GitHub work", async () => {
    const result = await diagnose({ env: {}, online: false });
    expect(result.status).toBe("needs_configuration"); expect(result.repository).toBeNull(); expect(result.credentialPresent).toBe(false);
    expect(result.readOnly).toBe(true); expect(result.mcpReadOnlyConfigured).toBe(false);
    expect(result.limitations.join(" ")).toContain("older server");
  });
  it("reports presence only and identifies the configured read-only profile", async () => {
    const env = { GITHUB_TOKEN: "diagnostic-secret-canary", SDLC_READ_ONLY: "true" };
    const result = await diagnose({ env, ref, online: false });
    expect(result.status).toBe("ready"); expect(result.readOnly).toBe(true);
    expect(result.mcpReadOnlyConfigured).toBe(true);
    expect(JSON.stringify(result)).not.toContain("diagnostic-secret-canary");
  });
  it("probes actual endpoint availability without requesting a write", async () => {
    const fixture = createGithubContractFixture();
    const result = await diagnose({ env: { GITHUB_TOKEN: "placeholder" }, ref, online: true }, fixture.octokit);
    expect(result.status).toBe("degraded");
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "repository_policy", state: "not_configured" }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "code_scanning", state: "available" }));
    expect(fixture.liveIssueCreate).not.toHaveBeenCalled();
  });
  it("explains permission gaps without echoing upstream error bodies", async () => {
    const fixture = createGithubContractFixture();
    fixture.denySecurityReads();
    const result = await diagnose({ env: { GITHUB_TOKEN: "placeholder" }, ref, online: true }, fixture.octokit);
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "code_scanning", state: "unverified" }));
    expect(JSON.stringify(result)).not.toContain("fixture permission denial");
  });
  it("does not probe branch endpoints when repository metadata was unavailable", async () => {
    const fixture = createGithubContractFixture();
    vi.spyOn(fixture.octokit.repos, "get").mockRejectedValue(new Error("private upstream body"));
    const result = await diagnose({ env: {}, ref, online: true }, fixture.octokit);
    expect(result.checks.find((check) => check.id === "repository_api")?.state).toBe("unverified");
    expect(result.checks.find((check) => check.id === "checks")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("private upstream body");
  });
});

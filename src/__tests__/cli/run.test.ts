import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { runCli } from "../../cli/run.js";
import { createReadyPrFixture, TEST_PR_HEAD, TEST_PR_BASE } from "../fixtures/pr-assessment-fixture.js";
import { buildEvidencePacket, type EvidencePacket } from "../../evidence/model.js";
import { SERVER_INFO } from "../../version.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "sdlc-cli-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function packet(): EvidencePacket {
  return buildEvidencePacket({ generatorVersion: SERVER_INFO.version, subject: { type: "issue", repo: "example/project", number: 42 }, evidence: [], collectedAt: "2026-10-15T00:00:00.000Z" });
}
async function invoke(args: string[], options: { client?: Octokit; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  let out = ""; let err = "";
  const code = await runCli(args, { env: {}, ...options, stdout: (text) => { out += text; }, stderr: (text) => { err += text; } });
  return { code, out, err };
}
async function input(name: string, value: unknown) { const path = join(directory, name); await writeFile(path, JSON.stringify(value)); return path; }

describe("read-only CLI commands", () => {
  it.each([[], ["--help"], ["doctor", "--help"]].map((args) => ({ args })))("provides help without a token: $args", async ({ args }) => {
    const result = await invoke(args); expect(result.code).toBe(0); expect(result.out).toContain("assess-pr");
  });
  it("reports the installed version", async () => expect((await invoke(["--version"])).out).toBe(`${SERVER_INFO.version}\n`));
  it("returns machine-readable offline configuration gaps", async () => {
    const result = await invoke(["doctor", "--json"]);
    expect(result.code).toBe(2); expect(JSON.parse(result.out).status).toBe("needs_configuration"); expect(result.err).toBe("");
  });
  it("uses environment coordinates without disclosing credentials", async () => {
    const result = await invoke(["doctor", "--json"], { env: { GITHUB_OWNER: "example", GITHUB_REPO: "project", GITHUB_TOKEN: "private-token-canary" } });
    expect(result.code).toBe(0); expect(JSON.parse(result.out).repository).toBe("example/project"); expect(result.out).not.toContain("private-token-canary");
  });
  it("renders diagnostics for terminal users", async () => expect((await invoke(["doctor"])).out).toContain("Diagnostics:"));
  it.each([
    ["bogus", "--json"], ["assess-pr", "--json"], ["assess-pr", "--repo", "example/project", "--pr", "7", "--json"],
    ["assess-pr", "--repo", "example/project", "--pr", "0", "--json"], ["assess-pr", "--repo", "example/project", "--pr", "7", "--standard", "invented", "--json"],
    ["doctor", "--timeout-ms", "120001", "--json"], ["assess-pr", "--repo", "example/project", "--pr", "7", "--max-requests", "1", "--json"],
  ].map((args) => ({ args })))("rejects invalid input safely: $args", async ({ args }) => {
    const result = await invoke(args); expect(result.code).toBe(2); expect(JSON.parse(result.out).error.code).toBe("invalid_or_unavailable");
  });
  it("reports an unknown command as concise stderr for non-JSON use", async () => { const result = await invoke(["invented"]); expect(result.code).toBe(2); expect(result.err).toContain("Unknown command"); });
  it("uses production handlers and produces an installed-workflow decision", async () => {
    const fixture = createReadyPrFixture();
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--json", "--enforce"], { client: fixture.octokit });
    expect(result.code).toBe(0); expect(JSON.parse(result.out).decision).toBe("ready_for_review"); expect(fixture.liveIssueCreate).not.toHaveBeenCalled();
  });
  it("defaults to advisory while explicit enforcement rejects known blocked work", async () => {
    const fixture = createReadyPrFixture();
    fixture.pullsGet.mockImplementation(async () => ({ data: { number: 7, title: "Docs", body: "Details", user: { login: "alice" }, state: "open", html_url: "https://github.com/example/project/pull/7", created_at: "2026-10-15T00:00:00Z", draft: true, head: { ref: "docs", sha: TEST_PR_HEAD }, base: { ref: "main", sha: TEST_PR_BASE }, commits: 1, mergeable: true, mergeable_state: "clean", labels: [] } }));
    const args = ["assess-pr", "--repo", "example/project", "--pr", "7", "--json"];
    expect((await invoke(args, { client: fixture.octokit })).code).toBe(0);
    const enforced = await invoke([...args, "--enforce"], { client: fixture.octokit });
    expect(enforced.code).toBe(1); expect(JSON.parse(enforced.out).decision).toBe("blocked");
  });
  it("returns a distinct enforced evidence-gap code", async () => {
    const fixture = createReadyPrFixture(); fixture.denySecurityReads();
    vi.spyOn(fixture.octokit.repos, "getBranchProtection").mockRejectedValue({ status: 403 });
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--json", "--enforce"], { client: fixture.octokit });
    expect(result.code).toBe(2); expect(JSON.parse(result.out).decision).toBe("needs_evidence");
  });
  it("collects Issue evidence using the production packet collector", async () => {
    const fixture = createReadyPrFixture();
    const result = await invoke(["evidence", "--repo", "example/project", "--subject", "issue", "--number", "42", "--json"], { client: fixture.octokit });
    expect(result.code).toBe(0); expect(JSON.parse(result.out).subject.type).toBe("issue"); expect(fixture.liveIssueCreate).not.toHaveBeenCalled();
  });
  it.each([
    ["--subject", "bad"], ["--subject", "release"], ["--subject", "release", "--ref", "v1", "--number", "1"], ["--subject", "issue", "--number", "1", "--ref", "main"],
  ].map((args) => ({ args })))("rejects contradictory subjects: $args", async ({ args }) => {
    const result = await invoke(["evidence", "--repo", "example/project", ...args, "--json"], { client: createReadyPrFixture().octokit }); expect(result.code).toBe(2);
  });
  it("compares local snapshots without GitHub or a token", async () => {
    const previous = await input("previous.json", packet()); const current = await input("current.json", packet());
    const result = await invoke(["diff", "--previous", previous, "--current", current, "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.out).verificationInherited).toBe(false);
  });
  it("rejects comparison across repositories", async () => {
    const previous = await input("previous.json", packet()); const other = packet(); other.subject.repo = "different/project";
    const current = await input("current.json", other);
    expect((await invoke(["diff", "--previous", previous, "--current", current, "--json"])).code).toBe(2);
  });
  it("extracts acceptance conditions while leaving checkboxes unverified", async () => {
    const packetPath = await input("packet.json", packet()); const criteria = join(directory, "acceptance.md"); await writeFile(criteria, "- [x] Login rejects invalid credentials.\n");
    const result = await invoke(["trace", "--packet", packetPath, "--acceptance", criteria, "--source", "openspec", "--json"]);
    const parsed = JSON.parse(result.out); expect(result.code).toBe(0); expect(parsed.summary.verified).toBe(0); expect(parsed.summary.missing).toBe(1);
  });
  it("accepts an explicit empty mapping file and writes a new JSON report", async () => {
    const packetPath = await input("packet.json", packet()); const criteria = join(directory, "criteria.md"); await writeFile(criteria, "1. Response format remains compatible.");
    const mappings = await input("mappings.json", []); const output = join(directory, "report.json");
    const result = await invoke(["trace", "--packet", packetPath, "--acceptance", criteria, "--mappings", mappings, "--output", output]);
    expect(result.code).toBe(0); expect(JSON.parse(await readFile(output, "utf8")).summary.verified).toBe(0);
  });
  it("attaches continuity and acceptance to PR decisions", async () => {
    const fixture = createReadyPrFixture();
    const first = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--json"], { client: fixture.octokit });
    const previous = await input("assessment.json", JSON.parse(first.out)); const criteria = join(directory, "criteria.md"); await writeFile(criteria, "- [ ] Setup instructions remain usable.");
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--previous", previous, "--acceptance", criteria, "--json"], { client: fixture.octokit });
    const parsed = JSON.parse(result.out); expect(result.code).toBe(0); expect(parsed.continuity.comparison).toBe("valid"); expect(parsed.acceptance.summary.verified).toBe(0);
  });
  it("attaches local continuity to a new evidence envelope", async () => {
    const fixture = createReadyPrFixture(); const previous = await input("previous.json", { packet: packet() });
    const result = await invoke(["evidence", "--repo", "example/project", "--subject", "issue", "--number", "42", "--previous", previous, "--json"], { client: fixture.octokit });
    expect(result.code).toBe(0); expect(JSON.parse(result.out).packet.subject.number).toBe(42); expect(JSON.parse(result.out).continuity.comparison).toBe("valid");
  });
  it("refuses to overwrite inputs or existing output files", async () => {
    const path = await input("packet.json", packet());
    const result = await invoke(["diff", "--previous", path, "--current", path, "--output", path, "--json"]);
    expect(result.code).toBe(2); expect(JSON.parse(await readFile(path, "utf8")).contentDigest).toBe(packet().contentDigest);
    const existing = await input("existing.json", { preserve: true });
    expect((await invoke(["diff", "--previous", path, "--current", path, "--output", existing, "--json"])).code).toBe(2);
    expect(await readFile(existing, "utf8")).toBe('{"preserve":true}');
  });
  it("writes explicit Markdown and JSON to different new paths", async () => {
    const fixture = createReadyPrFixture(); const output = join(directory, "new", "report.json"); const summary = join(directory, "summary.md");
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--output", output, "--summary", summary], { client: fixture.octokit });
    expect(result.code).toBe(0); expect(await readFile(summary, "utf8")).toContain("PR evidence:"); expect(JSON.parse(await readFile(output, "utf8")).schemaVersion).toBe("1.0");
  });
  it("appends only the runner-designated GitHub summary path", async () => {
    const fixture = createReadyPrFixture(); const summary = join(directory, "job-summary.md"); await writeFile(summary, "Existing summary\n");
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--summary", summary], { client: fixture.octokit, env: { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary } });
    expect(result.code).toBe(0); expect(await readFile(summary, "utf8")).toMatch(/^Existing summary\n/);
  });
  it("rejects identical JSON and Markdown output destinations", async () => {
    const path = join(directory, "same"); const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--output", path, "--summary", path, "--json"], { client: createReadyPrFixture().octokit }); expect(result.code).toBe(2);
  });
  it.each(["missing", "invalid", "large"].map((kind) => ({ kind })))("bounds and validates local $kind inputs", async ({ kind }) => {
    const path = join(directory, "input.json");
    if (kind === "invalid") await writeFile(path, "not-json-private-canary");
    if (kind === "large") await writeFile(path, "x".repeat(1_048_577));
    const result = await invoke(["diff", "--previous", path, "--current", path, "--json"]); expect(result.code).toBe(2); expect(result.out).not.toContain("private-canary");
  });
  it("rejects forged self-check environment outside a matching Actions repository", async () => {
    const fixture = createReadyPrFixture(); const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--json"], { client: fixture.octokit, env: { SDLC_CURRENT_CHECK_RUN_ID: "12", GITHUB_RUN_ID: "5", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "other/project" } });
    expect(result.code).toBe(2); expect(fixture.pullsGet).not.toHaveBeenCalled();
  });
  it("returns cancellation without leaking its caller-provided reason", async () => {
    const controller = new AbortController(); controller.abort("private-cancel-reason");
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--json"], { client: createReadyPrFixture().octokit, signal: controller.signal });
    expect(result.code).toBe(130); expect(JSON.parse(result.out).error.code).toBe("cancelled"); expect(result.out).not.toContain("private-cancel-reason");
  });

  it("reports a bounded local timeout classification and metric", async () => {
    const fixture = createReadyPrFixture(); fixture.pullsGet.mockImplementation(() => new Promise(() => {}));
    const result = await invoke(["assess-pr", "--repo", "example/project", "--pr", "7", "--timeout-ms", "5", "--json"], { client: fixture.octokit });
    expect(result.code).toBe(2); expect(JSON.parse(result.out)).toMatchObject({ error: { code: "timeout" }, metrics: { timedOut: true, cancelled: false, degraded: true } });
  });
});

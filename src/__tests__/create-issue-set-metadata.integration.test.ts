import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { connectStdioMcp, type McpProtocolEra } from "./fixtures/mcp-client.js";
import { compareMcpContracts, createMcpContractManifest, type McpContractManifest } from "../contracts/mcp-manifest.js";

vi.mock("../config.js", () => ({ config: { githubToken: "test-token", githubOwner: "owner", githubRepo: "repo" } }));

const github = await import("../github/client.js");
const { registerCreateIssueSetTool, ISSUE_RECOVERY_META_KEY } = await import("../tools/create-issue-set.js");
const baseline = JSON.parse(await fs.readFile(new URL("../../contracts/mcp/v1.9.0.json", import.meta.url), "utf8")) as McpContractManifest;
const closeCallbacks: (() => Promise<void>)[] = [];
let sequence = 0;
const args = { owner: "owner", repo: "repo", issues: [{ title: "Metadata issue", body: "A complete issue description.", labels: ["bug"] }] };
type Payload = { title: string; body: string; labels?: string[]; request?: { signal: AbortSignal } };
type Issue = { number: number; title: string; body: string; html_url: string; labels: string[]; assignees: [] };

function digestFrom(result: { structuredContent?: unknown }): string {
  const digest = (result.structuredContent as Record<string, unknown> | undefined)?.previewDigest;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  return digest as string;
}

async function fixture(era: McpProtocolEra) {
  const remote: Issue[] = [];
  const create = vi.fn(async (payload: Payload) => {
    const issue = { number: remote.length + 1, title: payload.title, body: payload.body, html_url: `https://github.com/owner/repo/issues/${remote.length + 1}`, labels: payload.labels ?? [], assignees: [] as [] };
    remote.push(issue); return { data: issue };
  });
  const listForRepo = vi.fn(async () => ({ data: [...remote] }));
  vi.spyOn(github, "getOctokit").mockReturnValue({ issues: { create, listForRepo } } as unknown as Octokit);
  const connection = await connectStdioMcp(() => {
    const server = new McpServer({ name: "issue-recovery-protocol", version: "1.0.0" });
    registerCreateIssueSetTool(server); return server;
  }, era);
  closeCallbacks.push(connection.close);
  return { ...connection, create, listForRepo, remote, key: `protocol-${era}-${++sequence}` };
}

afterEach(async () => {
  for (const close of closeCallbacks.splice(0)) await close();
  vi.restoreAllMocks();
});

describe.each(["legacy", "modern"] as const)("%s issue recovery metadata over real SDK stdio routing", (era) => {
  it("preserves the old public input contract and ignores same-name arbitrary legacy arguments", async () => {
    const f = await fixture(era);
    const discovered = (await f.client.listTools()).tools.find((tool) => tool.name === "create_issue_set")!;
    const historical = { ...baseline, tools: baseline.tools.filter((tool) => tool.name === "create_issue_set"), resources: [] };
    const current = createMcpContractManifest({ server: baseline.server, tools: [{ ...discovered, annotations: Object.fromEntries(Object.entries(discovered.annotations ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")) }], resources: [] }, baseline.source);
    expect(compareMcpContracts(historical, current).breaking).toEqual([]);
    expect(discovered.inputSchema.properties).not.toHaveProperty("idempotencyKey");
    expect(discovered.inputSchema.properties).not.toHaveProperty("previewDigest");
    const legacy = await f.client.callTool({ name: "create_issue_set", arguments: { ...args, idempotencyKey: 42, previewDigest: { ignored: "legacy-extra" } } });
    const plain = await f.client.callTool({ name: "create_issue_set", arguments: args });
    expect(legacy.isError).not.toBe(true);
    expect(legacy.structuredContent).toMatchObject({ dryRun: true, count: 1, issues: [], previewDigest: digestFrom(plain) });
    expect(f.create).not.toHaveBeenCalled(); expect(f.listForRepo).not.toHaveBeenCalled();
  });

  it("keeps legacy live writes compatible without treating extra arguments as recovery controls", async () => {
    const f = await fixture(era);
    const result = await f.client.callTool({ name: "create_issue_set", arguments: { ...args, dryRun: false, idempotencyKey: 42, previewDigest: { ignored: "legacy-extra" } } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ count: 1, recovery: { status: "completed" } });
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.listForRepo).not.toHaveBeenCalled();
    expect(f.create.mock.calls[0][0].body).toBe(args.issues[0].body);
  });

  it("passes strict metadata through preview, live creation and idempotent recovery", async () => {
    const f = await fixture(era);
    const preview = await f.client.callTool({ name: "create_issue_set", arguments: args, _meta: { [ISSUE_RECOVERY_META_KEY]: { idempotencyKey: f.key } } });
    expect(preview.isError).not.toBe(true);
    const previewDigest = digestFrom(preview);
    expect(previewDigest).toMatch(/^[a-f0-9]{64}$/);
    const request = { name: "create_issue_set", arguments: { ...args, dryRun: false }, _meta: { [ISSUE_RECOVERY_META_KEY]: { idempotencyKey: f.key, previewDigest } } };
    const live = await f.client.callTool(request);
    expect(live.isError).not.toBe(true);
    expect(live.structuredContent).toMatchObject({ count: 1, items: [{ status: "created" }] });
    expect(f.create.mock.calls[0][0].body).toContain("<!-- agentic-sdlc:create-issue-set:v1");
    expect(f.create.mock.calls[0][0].body).not.toContain(f.key);
    const resumed = await f.client.callTool(request);
    expect(resumed.structuredContent).toMatchObject({ count: 1, items: [{ status: "reused" }] });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.listForRepo).toHaveBeenCalledTimes(2);
  });

  it.each([null, 42, [], { idempotencyKey: 42 }, { idempotencyKey: "" }, { idempotencyKey: "x".repeat(129) }, { previewDigest: "invalid-private-value" }, { extra: "private-metadata" }])("rejects invalid metadata %j before GitHub access", async (metadata) => {
    const f = await fixture(era);
    const client = vi.mocked(github.getOctokit); client.mockClear();
    const result = await f.client.callTool({ name: "create_issue_set", arguments: { ...args, dryRun: false }, _meta: { [ISSUE_RECOVERY_META_KEY]: metadata } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "Invalid issue recovery metadata. Provide only a valid idempotencyKey and/or previewDigest in the documented request metadata namespace." }]);
    expect(client).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(f.listForRepo).not.toHaveBeenCalled();
  });

  it("rejects a metadata digest mismatch before any recovery read or write", async () => {
    const f = await fixture(era);
    const preview = await f.client.callTool({ name: "create_issue_set", arguments: args, _meta: { [ISSUE_RECOVERY_META_KEY]: { idempotencyKey: f.key } } });
    const result = await f.client.callTool({ name: "create_issue_set", arguments: { ...args, dryRun: false, issues: [{ ...args.issues[0], body: "Changed after reviewing preview." }] }, _meta: { [ISSUE_RECOVERY_META_KEY]: { idempotencyKey: f.key, previewDigest: digestFrom(preview) } } });
    expect(result.structuredContent).toMatchObject({ count: 0, recovery: { status: "blocked", retrySafe: false }, items: [{ status: "pending" }] });
    expect(f.create).not.toHaveBeenCalled(); expect(f.listForRepo).not.toHaveBeenCalled();
  });

  it("preserves cancellation propagation and uncertain-write recovery with metadata", async () => {
    const f = await fixture(era);
    await f.client.listTools();
    let start!: () => void; const started = new Promise<void>((resolve) => { start = resolve; });
    let cancel!: () => void; const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    let observedSignal: AbortSignal | undefined;
    f.create.mockImplementationOnce((payload) => new Promise((_, reject) => {
      observedSignal = payload.request?.signal;
      observedSignal?.addEventListener("abort", () => { cancel(); reject(new Error("private abort detail")); }, { once: true });
      start();
    }));
    const controller = new AbortController();
    const request = { name: "create_issue_set", arguments: { ...args, dryRun: false }, _meta: { [ISSUE_RECOVERY_META_KEY]: { idempotencyKey: f.key } } };
    const running = f.client.callTool(request, { signal: controller.signal });
    await started; controller.abort();
    await expect(running).rejects.toThrow();
    await cancelled;
    expect(observedSignal?.aborted).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retry = await f.client.callTool(request);
    expect(retry.structuredContent).toMatchObject({ items: [{ status: "unknown" }], recovery: { status: "unknown", retrySafe: false } });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(retry)).not.toContain("private abort detail");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateIssueSetInput } from "../../tools/create-issue-set.js";

vi.mock("../../config.js", () => ({
  config: { githubToken: "test-token", githubOwner: "owner", githubRepo: "repo", defaultBranch: "main" },
}));

const {
  handleCreateIssueSet,
  CreateIssueSetOperationInputSchema,
  CreateIssueSetOutputSchema,
  registerCreateIssueSetTool,
} = await import("../../tools/create-issue-set.js");
const github = await import("../../github/client.js");
const { z } = await import("zod");
const ref = { owner: "owner", repo: "repo" };
let sequence = 0;

type Payload = { title: string; body: string; labels?: string[]; assignees?: string[]; request?: { signal: AbortSignal } };
type RemoteIssue = { number: number; title: string; body: string; html_url: string; labels: string[]; assignees: { login: string }[]; pull_request?: object };

function fixture() {
  const remote: RemoteIssue[] = [];
  const create = vi.fn(async (payload: Payload) => {
    const issue = {
      number: remote.length + 1, title: payload.title, body: payload.body,
      html_url: `https://github.com/owner/repo/issues/${remote.length + 1}`,
      labels: payload.labels ?? [], assignees: (payload.assignees ?? []).map((login) => ({ login })),
    };
    remote.push(issue);
    return { data: issue };
  });
  const listForRepo = vi.fn(async () => ({ data: [...remote] }));
  const octokit = { issues: { create, listForRepo } } as unknown as Parameters<typeof handleCreateIssueSet>[2];
  const params: CreateIssueSetInput = {
    dryRun: false, idempotencyKey: `recovery-${++sequence}`,
    issues: [
      { title: "First", body: "First complete issue description.", labels: ["bug"], assignees: ["alice"] },
      { title: "Second", body: "Second complete issue description." },
    ],
  };
  return { remote, create, listForRepo, octokit, params };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("reviewed issue previews", () => {
  it.each(["", "x".repeat(129), "with spaces", "line\nfeed"])("rejects invalid operation key %j", (idempotencyKey) => {
    expect(CreateIssueSetOperationInputSchema.safeParse({ issues: [{ title: "A", body: "body" }], idempotencyKey }).success).toBe(false);
  });

  it("validates the optional digest and keeps legacy calls valid", () => {
    expect(CreateIssueSetOperationInputSchema.safeParse({ issues: [{ title: "A", body: "body" }], previewDigest: "wrong" }).success).toBe(false);
    expect(CreateIssueSetOperationInputSchema.parse({ issues: [{ title: "A", body: "body" }] }).dryRun).toBe(true);
    expect(CreateIssueSetOperationInputSchema.safeParse({ issues: [{ title: "A", body: "body" }], idempotencyKey: "a".repeat(128) }).success).toBe(true);
  });

  it("previews without even a recovery read and accepts its digest for the exact live batch", async () => {
    const f = fixture();
    const preview = await handleCreateIssueSet({ ...f.params, dryRun: true }, ref, f.octokit);
    expect(preview.structured.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.listForRepo).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    const live = await handleCreateIssueSet({ ...f.params, previewDigest: preview.structured.previewDigest }, ref, f.octokit);
    expect(live.structured.items?.map((item) => item.status)).toEqual(["created", "created"]);
    expect(z.object(CreateIssueSetOutputSchema).safeParse(live.structured).success).toBe(true);
  });

  it.each(["repo", "body", "assignee", "prefix", "order", "metadata", "key"])("rejects a changed %s before recovery reads or writes", async (change) => {
    const f = fixture();
    const preview = await handleCreateIssueSet({ ...f.params, dryRun: true }, ref, f.octokit);
    const params = structuredClone(f.params);
    let target = ref;
    if (change === "repo") target = { ...ref, repo: "another" };
    if (change === "body") params.issues[0].body += " hidden after preview " + "x".repeat(300);
    if (change === "assignee") params.issues[0].assignees = ["mallory"];
    if (change === "prefix") params.titlePrefix = "[Other]";
    if (change === "order") params.issues.reverse();
    if (change === "metadata") params.issues[0].riskLevel = "high";
    if (change === "key") params.idempotencyKey += "changed";
    const result = await handleCreateIssueSet({ ...params, previewDigest: preview.structured.previewDigest }, target, f.octokit);
    expect(result.structured.recovery?.status).toBe("blocked");
    expect(result.structured.items?.every((item) => item.status === "pending")).toBe(true);
    expect(f.listForRepo).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("snapshots caller arrays before an asynchronous recovery read", async () => {
    const f = fixture();
    f.listForRepo.mockImplementationOnce(async () => {
      f.params.issues[0].body = "Changed during lookup";
      f.params.issues[0].labels!.push("unexpected");
      return { data: [] };
    });
    await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(f.create.mock.calls[0][0].body).toContain("First complete issue description.");
    expect(f.create.mock.calls[0][0].labels).toEqual(["bug"]);
  });
});

describe("bounded issue idempotency recovery", () => {
  it.each(["assignee case", "label case", "duplicate names"])("reuses canonical GitHub %s without weakening payload identity", async (normalization) => {
    const f = fixture();
    if (normalization === "duplicate names") {
      f.params.issues[0].labels = ["bug", "BUG", "bug"];
      f.params.issues[0].assignees = ["alice", "ALICE"];
    }
    const initial = await handleCreateIssueSet(f.params, ref, f.octokit);
    if (normalization !== "label case") f.remote[0].assignees = [{ login: "Alice" }];
    if (normalization !== "assignee case") f.remote[0].labels = ["Bug"];
    const retry = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(retry.structured.recovery?.status).toBe("completed");
    expect(retry.structured.items?.map((item) => item.status)).toEqual(["reused", "reused"]);
    expect(retry.structured.previewDigest).toBe(initial.structured.previewDigest);
    expect(f.create).toHaveBeenCalledTimes(2);
    const changed = structuredClone(f.params);
    changed.issues[0].labels = ["Bug"];
    const changedPreview = await handleCreateIssueSet({ ...changed, dryRun: true }, ref, f.octokit);
    expect(changedPreview.structured.previewDigest).not.toBe(initial.structured.previewDigest);
    const conflict = await handleCreateIssueSet(changed, ref, f.octokit);
    expect(conflict.structured.recovery?.status).toBe("blocked");
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("reuses matching closed issues, including duplicate titles, instead of creating another batch", async () => {
    const f = fixture();
    f.params.issues[1].title = "First";
    await handleCreateIssueSet(f.params, ref, f.octokit);
    const retried = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(retried.structured.items?.map((item) => item.status)).toEqual(["reused", "reused"]);
    expect(retried.structured.issues.map((issue) => issue.number)).toEqual([1, 2]);
    expect(f.listForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: "all", page: 1, per_page: 100, sort: "created", request: { signal: expect.any(AbortSignal) } }));
    expect(f.remote[0].body).toContain("<!-- agentic-sdlc:create-issue-set:v1");
    expect(f.remote[0].body).not.toContain(f.params.idempotencyKey);
    expect(retried.text).toContain("exactly-once");
  });

  it("does not mistake an unrelated same-title issue or pull request for a receipt", async () => {
    const f = fixture();
    f.remote.push({ number: 99, title: "First", body: "First complete issue description.", labels: ["bug"], assignees: [{ login: "alice" }], html_url: "https://github.com/owner/repo/issues/99" });
    const initial = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(initial.structured.items?.every((item) => item.status === "created")).toBe(true);
    f.remote[1].pull_request = {};
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "reused"]);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("rejects reuse of a key with a different complete payload", async () => {
    const f = fixture();
    await handleCreateIssueSet(f.params, ref, f.octokit);
    f.params.issues[1].title = "Changed";
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.recovery?.status).toBe("blocked");
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("does not recreate a locally confirmed issue after its remote marker is removed", async () => {
    const f = fixture();
    await handleCreateIssueSet(f.params, ref, f.octokit);
    f.remote[0].body = "The marker was removed during editing.";
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.recovery?.status).toBe("unknown");
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "reused"]);
    expect(result.structured.items?.[0].issue?.number).toBe(1);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it.each(["body", "title", "labels", "assignees", "digest", "index", "duplicate"])("fails closed on a conflicting remote %s", async (change) => {
    const f = fixture();
    await handleCreateIssueSet(f.params, ref, f.octokit);
    if (change === "body") f.remote[0].body = "tampered\n" + f.remote[0].body;
    if (change === "title") f.remote[0].title = "Changed";
    if (change === "labels") f.remote[0].labels = ["unexpected"];
    if (change === "assignees") f.remote[0].assignees = [{ login: "mallory" }];
    if (change === "digest") f.remote[0].body = f.remote[0].body.replace(/digest=[a-f0-9]+/, "digest=" + "0".repeat(64));
    if (change === "index") f.remote[0].body = f.remote[0].body.replace("index=0", "index=99");
    if (change === "duplicate") f.remote.push({ ...f.remote[0], number: 77 });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.recovery?.status).toBe("blocked");
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(result.structured.issues.some((issue) => issue.number === 2)).toBe(true);
  });

  it("uses the next page before deciding an input is missing", async () => {
    const f = fixture();
    await handleCreateIssueSet(f.params, ref, f.octokit);
    const filler = { ...f.remote[0], body: "unrelated", number: 900 };
    f.listForRepo.mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => filler) }).mockResolvedValueOnce({ data: f.remote });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.items?.every((item) => item.status === "reused")).toBe(true);
    expect(f.listForRepo).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it.each(["cap", "failure"])("preserves confirmed matches but forbids missing writes when recovery reaches %s", async (stop) => {
    const f = fixture();
    f.create.mockRejectedValueOnce({ status: 422 });
    await handleCreateIssueSet(f.params, ref, f.octokit);
    const filler = { ...f.remote[0], body: "unrelated", number: 900 };
    const page = [f.remote[0], ...Array.from({ length: 99 }, () => filler)];
    f.listForRepo.mockResolvedValueOnce({ data: page });
    if (stop === "cap") f.listForRepo.mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => filler) }).mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => filler) });
    else f.listForRepo.mockRejectedValueOnce(new Error("private-lookup-failure"));
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.recovery?.status).toBe("blocked");
    expect(result.structured.items?.map((item) => item.status)).toEqual(["pending", "reused"]);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.listForRepo).toHaveBeenCalledTimes(stop === "cap" ? 4 : 3);
    expect(result.text).not.toContain("private-lookup-failure");
  });

  it("makes no write after a failed initial lookup", async () => {
    const f = fixture();
    f.listForRepo.mockRejectedValueOnce({ status: 403, message: "sensitive" });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.recovery?.status).toBe("blocked");
    expect(f.create).not.toHaveBeenCalled();
    expect(result.text).not.toContain("sensitive");
  });

  it("returns all verified matches when the history cap leaves no input to create", async () => {
    const f = fixture();
    await handleCreateIssueSet(f.params, ref, f.octokit);
    const filler = { ...f.remote[0], body: "unrelated", number: 900 };
    f.listForRepo.mockResolvedValueOnce({ data: [...f.remote, ...Array.from({ length: 98 }, () => filler)] })
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => filler) })
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, () => filler) });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.recovery?.status).toBe("completed");
    expect(result.structured.items?.every((item) => item.status === "reused")).toBe(true);
    expect(result.text).toContain("incomplete");
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("can resume a definitively rejected input while retaining successful inputs", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce({ status: 422 });
    const partial = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(partial.structured.recovery?.status).toBe("partial");
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.items?.map((item) => item.status)).toEqual(["created", "reused"]);
    expect(f.create).toHaveBeenCalledTimes(3);
  });
});

describe("write cancellation and uncertain commit state", () => {
  it.each(["pre-cancelled", "lookup-cancelled", "lookup-failed", "lookup-timeout"])("preserves prior unknown writes on a %s retry", async (interruption) => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("response lost"));
    const first = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(first.structured.items?.map((item) => item.status)).toEqual(["unknown", "pending"]);
    const controller = new AbortController();
    if (interruption === "pre-cancelled") controller.abort();
    else if (interruption === "lookup-failed") f.listForRepo.mockRejectedValueOnce(new Error("lookup unavailable"));
    else f.listForRepo.mockImplementationOnce(() => new Promise(() => {}));
    if (interruption === "lookup-timeout") vi.useFakeTimers();
    const retry = handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal, timeoutMs: interruption === "lookup-timeout" ? 20 : undefined });
    if (interruption === "lookup-cancelled") { await vi.waitFor(() => expect(f.listForRepo).toHaveBeenCalledTimes(2)); controller.abort(); }
    if (interruption === "lookup-timeout") await vi.advanceTimersByTimeAsync(21);
    const result = await retry;
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "pending"]);
    expect(result.structured.recovery?.retrySafe).toBe(false);
    expect(result.structured.recovery?.status).toBe(interruption === "lookup-failed" ? "unknown" : interruption === "lookup-timeout" ? "timed_out" : "cancelled");
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.listForRepo).toHaveBeenCalledTimes(interruption === "pre-cancelled" ? 1 : 2);
  });

  it.each(["pre-cancelled", "lookup-cancelled", "lookup-failed"])("retains prior successful references and uncertain indices on a %s retry", async (interruption) => {
    const f = fixture();
    f.params.issues.push({ title: "Third", body: "Third pending issue." });
    f.create.mockImplementationOnce(async (payload) => {
      const issue = { number: 1, title: payload.title, body: payload.body, html_url: "https://github.com/owner/repo/issues/1", labels: payload.labels ?? [], assignees: [{ login: "alice" }] };
      f.remote.push(issue); return { data: issue };
    }).mockRejectedValueOnce(new Error("second response lost"));
    const initial = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(initial.structured.items?.map((item) => item.status)).toEqual(["created", "unknown", "pending"]);
    const controller = new AbortController();
    if (interruption === "pre-cancelled") controller.abort();
    else if (interruption === "lookup-failed") f.listForRepo.mockRejectedValueOnce(new Error("private lookup error"));
    else f.listForRepo.mockImplementationOnce(() => new Promise(() => {}));
    const retry = handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal });
    if (interruption === "lookup-cancelled") { await vi.waitFor(() => expect(f.listForRepo).toHaveBeenCalledTimes(2)); controller.abort(); }
    const result = await retry;
    expect(result.structured.items?.[0].status).not.toBe("pending");
    expect(result.structured.items?.[0].issue?.number).toBe(1);
    expect(result.structured.issues.map((issue) => issue.number)).toContain(1);
    expect(result.structured.items?.[1].status).toBe("unknown");
    expect(result.structured.items?.[2].status).toBe("pending");
    expect(result.structured.recovery?.retrySafe).toBe(false);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(result.text).not.toContain("private lookup error");
  });

  it.each([400, 401, 404, 429])("preserves a definitive HTTP %s rejection and can continue to later inputs", async (status) => {
    const f = fixture(); f.create.mockRejectedValueOnce({ status, message: "private-response" });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.items?.map((item) => item.status)).toEqual(["failed", "created"]);
    expect(result.structured.failures[0].reason).toContain(String(status));
    expect(result.text).not.toContain("private-response");
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it("does no recovery read or write for pre-cancelled requests", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort("private-reason");
    const result = await handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal });
    expect(result.structured.recovery?.status).toBe("cancelled");
    expect(result.structured.items?.map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(f.create).not.toHaveBeenCalled(); expect(f.listForRepo).not.toHaveBeenCalled();
    expect(result.text).not.toContain("private-reason");
  });

  it("propagates cancellation and blocks retries while an uncooperative write is unsettled", async () => {
    const f = fixture();
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    let resolveWrite!: (value: { data: RemoteIssue }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    f.create.mockImplementationOnce((payload) => {
      observed = payload.request?.signal; started();
      return new Promise((resolve) => { resolveWrite = resolve; });
    });
    const running = handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal });
    await ready; controller.abort(new Error("private abort detail"));
    const result = await running;
    expect(observed?.aborted).toBe(true);
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "pending"]);
    expect(result.structured.recovery).toEqual(expect.objectContaining({ status: "cancelled", retrySafe: false }));
    expect(result.text).not.toContain("private abort detail");
    const retry = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(retry.structured.recovery?.status).toBe("blocked");
    expect(f.create).toHaveBeenCalledTimes(1);
    resolveWrite({ data: { number: 1, title: "First", body: "late", html_url: "https://github.com/owner/repo/issues/1", labels: [], assignees: [] } });
  });

  it("preserves a completed first issue when cancellation occurs during the next write", async () => {
    const f = fixture(); const controller = new AbortController();
    f.params.issues.push({ title: "Third", body: "Pending third issue." });
    f.create.mockImplementationOnce(async (payload) => {
      const issue = { number: 1, title: payload.title, body: payload.body, html_url: "https://github.com/owner/repo/issues/1", labels: ["bug"], assignees: [{ login: "alice" }] };
      f.remote.push(issue); return { data: issue };
    }).mockImplementationOnce(async () => { controller.abort(); throw new Error("aborted"); });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal });
    expect(result.structured.items?.map((item) => item.status)).toEqual(["created", "unknown", "pending"]);
    expect(result.structured.issues.map((issue) => issue.number)).toEqual([1]);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("does not start another issue after a successful response whose renderer observes cancellation", async () => {
    const f = fixture(); const controller = new AbortController();
    f.params.idempotencyKey = undefined;
    f.create.mockResolvedValueOnce({ data: {
      number: 1, get title() { controller.abort(); return "First"; }, body: "body",
      html_url: "https://github.com/owner/repo/issues/1", labels: [], assignees: [],
    } });
    const result = await handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal });
    expect(result.structured.items?.map((item) => item.status)).toEqual(["created", "pending"]);
    expect(result.structured.recovery?.status).toBe("cancelled");
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 408, 500, 502])("stops after an unknown network or HTTP %s write outcome", async (status) => {
    const f = fixture(); f.create.mockRejectedValueOnce(status ? { status, message: "private-error" } : new Error("private-error"));
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "pending"]);
    expect(result.structured.recovery?.status).toBe("unknown");
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(result.text).not.toContain("private-error");
    const retry = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(retry.structured.recovery?.status).toBe("unknown");
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("recovers a committed write whose response was lost before creating pending inputs", async () => {
    const f = fixture();
    f.create.mockImplementationOnce(async (payload) => {
      f.remote.push({ number: 1, title: payload.title, body: payload.body, html_url: "https://github.com/owner/repo/issues/1", labels: payload.labels ?? [], assignees: (payload.assignees ?? []).map((login) => ({ login })) });
      throw new Error("response lost");
    });
    const first = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(first.structured.recovery?.status).toBe("unknown");
    const recovered = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(recovered.structured.items?.map((item) => item.status)).toEqual(["reused", "created"]);
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("preserves an incomplete successful write response as unknown and stops the batch", async () => {
    const f = fixture();
    f.create.mockResolvedValueOnce({ data: { title: "First" } } as never);
    const result = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "pending"]);
    expect(result.structured.recovery?.status).toBe("unknown");
    expect(z.object(CreateIssueSetOutputSchema).safeParse(result.structured).success).toBe(true);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("enforces the batch deadline and aborts the in-flight write without retrying", async () => {
    vi.useFakeTimers(); const f = fixture();
    let observed: AbortSignal | undefined;
    f.create.mockImplementationOnce((payload) => { observed = payload.request?.signal; return new Promise(() => {}); });
    const running = handleCreateIssueSet(f.params, ref, f.octokit, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(21);
    const result = await running;
    expect(observed?.aborted).toBe(true);
    expect(result.structured.recovery?.status).toBe("timed_out");
    expect(result.structured.items?.map((item) => item.status)).toEqual(["unknown", "pending"]);
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("cancels an uncooperative recovery lookup before any write starts", async () => {
    const f = fixture(); const controller = new AbortController();
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    f.listForRepo.mockImplementationOnce(() => { started(); return new Promise(() => {}); });
    const running = handleCreateIssueSet(f.params, ref, f.octokit, { signal: controller.signal });
    await ready; controller.abort();
    const result = await running;
    expect(result.structured.recovery?.status).toBe("cancelled");
    expect(result.structured.items?.every((item) => item.status === "pending")).toBe(true);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("rejects concurrent same-key batches before their first writes", async () => {
    const f = fixture();
    let release!: (value: { data: RemoteIssue[] }) => void;
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    f.listForRepo.mockImplementationOnce(() => { started(); return new Promise((resolve) => { release = resolve; }); });
    const first = handleCreateIssueSet(f.params, ref, f.octokit);
    await ready;
    const second = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(second.structured.recovery?.status).toBe("blocked");
    expect(f.listForRepo).toHaveBeenCalledTimes(1); expect(f.create).not.toHaveBeenCalled();
    release({ data: [] }); await first;
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid deadline %s before writing", async (timeoutMs) => {
    const f = fixture();
    await expect(handleCreateIssueSet(f.params, ref, f.octokit, { timeoutMs })).rejects.toThrow(/positive finite/);
    expect(f.create).not.toHaveBeenCalled();
  });
});

describe("read-only mode and MCP registration", () => {
  it("permits previews but blocks direct live calls in read-only mode", async () => {
    vi.stubEnv("SDLC_READ_ONLY", "true"); const f = fixture();
    const preview = await handleCreateIssueSet({ ...f.params, dryRun: true }, ref, f.octokit);
    expect(preview.structured.dryRun).toBe(true);
    const live = await handleCreateIssueSet(f.params, ref, f.octokit);
    expect(live.structured.recovery?.status).toBe("blocked");
    expect(f.create).not.toHaveBeenCalled(); expect(f.listForRepo).not.toHaveBeenCalled();
    const bypass = await handleCreateIssueSet(f.params, ref, f.octokit, { readOnly: false });
    expect(bypass.structured.recovery?.status).toBe("blocked");
  });

  it("rejects registered live writes before obtaining a GitHub client", async () => {
    vi.stubEnv("SDLC_READ_ONLY", "true"); const f = fixture();
    const client = vi.spyOn(github, "getOctokit").mockReturnValue(f.octokit);
    const registerTool = vi.fn(); registerCreateIssueSetTool({ registerTool } as unknown as Parameters<typeof registerCreateIssueSetTool>[0]);
    const callback = registerTool.mock.calls[0][2];
    const result = await callback(f.params, { mcpReq: { signal: new AbortController().signal } });
    expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined();
    expect(client).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });

  it("forwards the registered MCP cancellation signal to GitHub writes", async () => {
    const f = fixture(); const controller = new AbortController();
    vi.spyOn(github, "getOctokit").mockReturnValue(f.octokit);
    const registerTool = vi.fn(); registerCreateIssueSetTool({ registerTool } as unknown as Parameters<typeof registerCreateIssueSetTool>[0]);
    const callback = registerTool.mock.calls[0][2];
    f.create.mockImplementationOnce(async (payload) => { controller.abort(); expect(payload.request?.signal.aborted).toBe(true); throw new Error("cancelled"); });
    const result = await callback(f.params, { mcpReq: { signal: controller.signal } });
    expect(result.structuredContent.items[0].status).toBe("unknown");
    expect(result.structuredContent.recovery.status).toBe("cancelled");
    expect(result._meta).toBeDefined(); expect(f.create).toHaveBeenCalledTimes(1);
  });
});

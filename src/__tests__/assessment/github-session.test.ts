import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";

import { createReadOnlyGithubSession } from "../../assessment/github-session.js";
import { AbortableCancellationError } from "../../evidence/timeout.js";

const asClient = (value: unknown): Octokit => value as Octokit;

describe("read-only GitHub evidence session", () => {
  it("preserves endpoint binding, caller options, and actual request counts", async () => {
    const controller = new AbortController();
    const repos = {
      get: vi.fn(function (this: unknown, params: unknown) { return Promise.resolve({ receiver: this, params }); }),
    };
    const input = { owner: "org", repo: "repo", request: { timeout: 42 } };
    const session = createReadOnlyGithubSession(asClient({ repos }), { signal: controller.signal });

    const result = await session.client.repos.get(input) as unknown as { receiver: unknown; params: unknown };

    expect(result.receiver).toBe(repos);
    expect(result.params).toEqual({ ...input, request: { timeout: 42, signal: controller.signal } });
    expect(input.request).toEqual({ timeout: 42 });
    expect(session.usedRequests()).toBe(1);
  });

  it("counts rejected upstream attempts and refuses additional concurrent calls at the budget", async () => {
    const get = vi.fn().mockRejectedValue(new Error("private upstream message"));
    const session = createReadOnlyGithubSession(asClient({ repos: { get } }), { maxRequests: 1 });

    await expect(session.client.repos.get({ owner: "org", repo: "repo" })).rejects.toThrow("private upstream message");
    expect(() => session.client.repos.get({ owner: "org", repo: "repo" })).toThrow("request budget");
    expect(session.usedRequests()).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refuses an exhausted zero budget without invoking an endpoint", () => {
    const get = vi.fn();
    const session = createReadOnlyGithubSession(asClient({ repos: { get } }), { maxRequests: 0 });

    expect(() => session.client.repos.get({ owner: "private-org", repo: "private-repo" })).toThrow("request budget");
    expect(get).not.toHaveBeenCalled();
    expect(session.usedRequests()).toBe(0);
  });

  it.each([-1, NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid request budget %s", (maxRequests) => {
    expect(() => createReadOnlyGithubSession(asClient({}), { maxRequests })).toThrow("non-negative safe integer");
  });

  it("normalizes pre-cancellation without exposing an arbitrary abort reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("private-secret"));
    const get = vi.fn();
    const session = createReadOnlyGithubSession(asClient({ repos: { get } }), { signal: controller.signal });

    expect(() => session.client.repos.get({ owner: "org", repo: "repo" })).toThrow(AbortableCancellationError);
    expect(() => session.client.repos.get({ owner: "org", repo: "repo" })).not.toThrow("private-secret");
    expect(get).not.toHaveBeenCalled();
    expect(session.usedRequests()).toBe(0);
  });

  it("combines caller cancellation with session cancellation", async () => {
    const caller = new AbortController();
    const sessionController = new AbortController();
    const get = vi.fn().mockResolvedValue({ data: {} });
    const session = createReadOnlyGithubSession(asClient({ repos: { get } }), { signal: sessionController.signal });

    await session.client.repos.get({ owner: "org", repo: "repo", request: { signal: caller.signal } });
    const signal = get.mock.calls[0][0].request.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("rejects writes and client reconfiguration without spending requests", () => {
    const create = vi.fn();
    const auth = vi.fn();
    const session = createReadOnlyGithubSession(asClient({ issues: { create }, auth }));

    expect(() => session.client.issues.create({ owner: "org", repo: "repo", title: "private" })).toThrow("read-only");
    expect(() => session.client.auth()).toThrow("read-only");
    expect(create).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
    expect(session.usedRequests()).toBe(0);
  });

  it("keeps the client view immutable and hides raw configuration values", () => {
    const get = vi.fn();
    const source = { repos: { get }, privateConfiguration: "private-secret" };
    const { client } = createReadOnlyGithubSession(asClient(source));

    expect(Reflect.set(client.repos, "get", vi.fn())).toBe(false);
    expect(() => Object.defineProperty(client.repos, "get", { value: vi.fn() })).toThrow(TypeError);
    expect(() => Reflect.deleteProperty(client.repos, "get")).not.toThrow();
    expect(Reflect.deleteProperty(client.repos, "get")).toBe(false);
    expect(Reflect.get(client, "privateConfiguration")).toBeUndefined();
    expect(Reflect.get(client, "constructor")).toBeUndefined();
    expect(source.repos.get).toBe(get);
  });

  it.each(["POST /repos/org/repo/issues", "post /repos/org/repo/issues"])("rejects raw write route %s", (route) => {
    const request = vi.fn();
    const session = createReadOnlyGithubSession(asClient({ request }));

    expect(() => session.client.request(route)).toThrow("read-only");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects HTTP method overrides and attaches signals to raw reads", async () => {
    const request = vi.fn().mockResolvedValue({ data: {} });
    const get = vi.fn().mockResolvedValue({ data: {} });
    const session = createReadOnlyGithubSession(asClient({ request, repos: { get } }));

    expect(() => session.client.request("GET /repos/org/repo", { method: "DELETE" })).toThrow("read-only");
    expect(() => session.client.repos.get({ owner: "org", repo: "repo", method: "POST" })).toThrow("read-only");
    await session.client.request({ method: "GET", url: "/repos/org/repo" });
    expect(request.mock.calls[0][0].request.signal).toBeInstanceOf(AbortSignal);
    expect(session.usedRequests()).toBe(1);
    expect(get).not.toHaveBeenCalled();
  });

  it("allows GraphQL query operations and preserves variable values and binding", async () => {
    const source = {
      graphql: vi.fn(function (this: unknown, ...args: unknown[]) { return Promise.resolve({ receiver: this, args }); }),
    };
    const session = createReadOnlyGithubSession(asClient(source));
    const variables = { owner: "org", text: "mutation is data" };

    const result = await session.client.graphql("# mutation comment\nquery Q { viewer { login } }", variables) as { receiver: unknown; args: unknown[] };
    await session.client.graphql({ query: 'query Q { node(id: "mutation") { id } }', owner: "org" });

    expect(result.receiver).toBe(source);
    expect(result.args[1]).toMatchObject(variables);
    expect((result.args[1] as { request: { signal: unknown } }).request.signal).toBeInstanceOf(AbortSignal);
    expect(variables).toEqual({ owner: "org", text: "mutation is data" });
    expect(session.usedRequests()).toBe(2);
  });

  it("rejects GraphQL transport overrides and mutation attempts through a raw GET", () => {
    const graphql = vi.fn();
    const request = vi.fn();
    const session = createReadOnlyGithubSession(asClient({ graphql, request }));

    expect(() => session.client.graphql("query { viewer { login } }", {
      url: "/repos/org/repo/issues", method: "POST", title: "private",
    })).toThrow("read-only");
    expect(() => session.client.graphql("query { viewer { login } }", { query: "mutation { updateIssue(input: {}) { clientMutationId } }" })).toThrow("read-only");
    expect(() => session.client.request("GET /graphql", { query: "mutation { deleteIssue(input: {}) { clientMutationId } }" })).toThrow("read-only");
    expect(graphql).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(session.usedRequests()).toBe(0);
  });

  it("does not let escaped block strings conceal a selected mutation", async () => {
    const graphql = vi.fn().mockResolvedValue({});
    const session = createReadOnlyGithubSession(asClient({ graphql }));
    const query = 'query Q { node(id: """x \\""" y """) { id } }';
    await session.client.graphql(query);

    expect(() => session.client.graphql(
      query + ' mutation M { updateIssue(input: { body: """z""" }) { clientMutationId } }',
      { operationName: "M" }
    )).toThrow("read-only");
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(session.usedRequests()).toBe(1);
  });

  it.each([
    "mutation { updateIssue(input: {}) { clientMutationId } }",
    "# safe comment\nmutation X { updateIssue(input: {}) { clientMutationId } }",
    "query Q { viewer { login } } mutation M { updateIssue(input: {}) { clientMutationId } }",
    "subscription { viewer { login } }",
    "fragment F on User { login }",
    'query { node(id: "unterminated) { id } }',
    'query { node(id: "raw\nnewline") { id } }',
    "",
  ])("rejects unsupported GraphQL operations without a network request", (query) => {
    const graphql = vi.fn();
    const session = createReadOnlyGithubSession(asClient({ graphql }));
    expect(() => session.client.graphql(query)).toThrow("read-only");
    expect(graphql).not.toHaveBeenCalled();
    expect(session.usedRequests()).toBe(0);
  });

  it("works with real Octokit REST aliases and its fetch transport", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const octokit = new Octokit({ request: { fetch } });
    const controller = new AbortController();
    const session = createReadOnlyGithubSession(octokit, { signal: controller.signal });

    const result = await session.client.rest.repos.get({ owner: "org", repo: "repo" });
    expect(result.data.id).toBe(1);
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(session.usedRequests()).toBe(1);
    expect(() => session.client.rest.issues.create({ owner: "org", repo: "repo", title: "private" })).toThrow("read-only");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation through the real Octokit GraphQL transport", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { viewer: { login: "reader" } } }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const octokit = new Octokit({ request: { fetch } });
    const controller = new AbortController();
    const session = createReadOnlyGithubSession(octokit, { signal: controller.signal });

    await expect(session.client.graphql("query { viewer { login } }")).resolves.toEqual({ viewer: { login: "reader" } });
    expect(fetch.mock.calls[0][1].method).toBe("POST");
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(session.usedRequests()).toBe(1);
  });
});

import { SdkErrorCode } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES } from "../catalog.js";
import { createMcpHttpHandler } from "../http-server.js";
import { createAgenticSdlcServer } from "../server.js";
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  connectDirectFetchMcp,
  connectStdioMcp,
  type HttpWireObservation,
  type McpProtocolEra,
} from "./fixtures/mcp-client.js";

const RESOURCE_URIS = [
  "sdlc://standards/agentic-sdlc",
  "sdlc://templates/handoff",
  "sdlc://templates/issue",
  "sdlc://templates/pr-summary",
  "sdlc://templates/release-readiness",
] as const;

const ERAS: McpProtocolEra[] = ["legacy", "modern"];

function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Promise did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createRawEraRequest(
  era: McpProtocolEra,
  id: number,
  signal?: AbortSignal
): Request {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const params: Record<string, unknown> = {};
  if (era === "modern") {
    headers["mcp-method"] = "tools/list";
    headers["mcp-protocol-version"] = MODERN_PROTOCOL_VERSION;
    params["_meta"] = {
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        name: "pending-factory-test",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    };
  }
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params,
    }),
    ...(signal ? { signal } : {}),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function observationFor(
  observations: HttpWireObservation[],
  method: string
): HttpWireObservation {
  const observation = observations.find((entry) => entry.requestMethod === method);
  expect(observation, `missing ${method} wire observation`).toBeDefined();
  return observation!;
}

describe("MCP 2025/2026 era routing", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });

  it.each(ERAS)("serves identical discovery over the %s stdio entry", async (era) => {
    const fixture = await connectStdioMcp(createAgenticSdlcServer, era);
    closeCallbacks.push(fixture.close);

    expect(fixture.client.getProtocolEra()).toBe(era);
    expect(fixture.client.getNegotiatedProtocolVersion()).toBe(
      era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION
    );
    const [tools, resources] = await Promise.all([
      fixture.client.listTools(),
      fixture.client.listResources(),
    ]);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(
      [...RESOURCE_URIS].sort()
    );
  });

  it.each(ERAS)("serves identical discovery through %s direct-fetch HTTP", async (era) => {
    const fixture = await connectDirectFetchMcp(createMcpHttpHandler(), era);
    closeCallbacks.push(fixture.close);

    const [tools, resources] = await Promise.all([
      fixture.client.listTools(),
      fixture.client.listResources(),
    ]);
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(resources.resources.map((resource) => resource.uri).sort()).toEqual(
      [...RESOURCE_URIS].sort()
    );

    if (era === "legacy") {
      expect(fixture.observations.map((entry) => entry.requestMethod)).toContain("initialize");
      expect(fixture.observations.map((entry) => entry.requestMethod)).not.toContain("server/discover");
      const initialize = observationFor(fixture.observations, "initialize");
      expect(initialize.protocolVersionHeader).toBeNull();
      expect(initialize.mcpMethodHeader).toBeNull();
      return;
    }

    expect(fixture.observations.map((entry) => entry.requestMethod)).not.toContain("initialize");
    const discover = observationFor(fixture.observations, "server/discover");
    const listTools = observationFor(fixture.observations, "tools/list");
    for (const observation of [discover, listTools]) {
      expect(observation.protocolVersionHeader).toBe(MODERN_PROTOCOL_VERSION);
      expect(observation.mcpMethodHeader).toBe(observation.requestMethod);
      const request = asRecord(observation.requestBody);
      const params = asRecord(request["params"]);
      const metadata = asRecord(params["_meta"]);
      expect(metadata["io.modelcontextprotocol/protocolVersion"]).toBe(
        MODERN_PROTOCOL_VERSION
      );

      const response = asRecord(observation.responseBody);
      const result = asRecord(response["result"]);
      expect(result).toEqual(expect.objectContaining({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
      }));
      expect(asRecord(result["_meta"])).toEqual(expect.objectContaining({
        "io.modelcontextprotocol/serverInfo": {
          name: "agentic-sdlc-mcp",
          version: "1.9.0",
        },
      }));
    }
  });

  it("rejects an unsupported modern pin instead of falling back to legacy", async () => {
    await expect(connectStdioMcp(
      createAgenticSdlcServer,
      "modern",
      "2099-01-01"
    )).rejects.toThrow(/protocol|version/i);
    await expect(connectDirectFetchMcp(
      createMcpHttpHandler(),
      "modern",
      "2099-01-01"
    )).rejects.toThrow(/protocol|version/i);
  });

  it.each([
    {
      name: "a modern body with a legacy version header",
      expectedCode: -32020,
      buildParams: (modernParams: Record<string, unknown>) => modernParams,
      protocolVersion: LEGACY_PROTOCOL_VERSION,
    },
    {
      name: "a legacy body with a modern version header",
      expectedCode: -32602,
      buildParams: () => ({}),
      protocolVersion: MODERN_PROTOCOL_VERSION,
    },
  ])("rejects $name instead of silently changing eras", async ({
    expectedCode,
    buildParams,
    protocolVersion,
  }) => {
    const handler = createMcpHttpHandler();
    const fixture = await connectDirectFetchMcp(handler, "modern");
    closeCallbacks.push(fixture.close);
    await fixture.client.listTools();
    const reference = observationFor(fixture.observations, "tools/list");
    const referenceRequest = asRecord(reference.requestBody);
    const modernParams = asRecord(referenceRequest["params"]);

    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8001,
        method: "tools/list",
        params: buildParams(modernParams),
      }),
    }));
    const payload = asRecord(await response.json());

    expect(response.status).toBe(400);
    expect(asRecord(payload["error"])).toEqual(expect.objectContaining({
      code: expectedCode,
    }));
    expect(payload["result"]).toBeUndefined();
  });

  it.each(ERAS)("returns a method-not-found error for unknown %s requests", async (era) => {
    const handler = createMcpHttpHandler();
    const fixture = await connectDirectFetchMcp(handler, era);
    closeCallbacks.push(fixture.close);
    const reference = observationFor(
      fixture.observations,
      era === "modern" ? "server/discover" : "initialize"
    );
    const params: Record<string, unknown> = {};
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (era === "modern") {
      const referenceRequest = asRecord(reference.requestBody);
      params["_meta"] = asRecord(asRecord(referenceRequest["params"])["_meta"]);
      headers["mcp-protocol-version"] = MODERN_PROTOCOL_VERSION;
      headers["mcp-method"] = "unknown/method";
    }

    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9001,
        method: "unknown/method",
        params,
      }),
    }));
    const payload = asRecord(await response.json());
    expect(asRecord(payload["error"])).toEqual(expect.objectContaining({
      code: -32601,
    }));
    expect(payload["result"]).toBeUndefined();
  });

  it.each(
    ERAS.flatMap((era) => (["stdio", "http"] as const).map((transport) => ({
      era,
      transport,
      forwardsCancellation: era !== "legacy" || transport !== "http",
    })))
  )("preserves $era cancellation semantics over $transport", async ({
    era,
    transport,
    forwardsCancellation,
  }) => {
    let resolveStarted: (() => void) | undefined;
    let resolveCancelled: (() => void) | undefined;
    let resolveWait: (() => void) | undefined;
    let resolveCompleted: (() => void) | undefined;
    let activeSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });
    const createServer = () => {
      const server = new McpServer({ name: "cancellation-test", version: "1.0.0" });
      server.registerTool("wait_for_cancel", {
        inputSchema: z.object({}),
        outputSchema: z.object({ cancelled: z.boolean() }),
      }, async (_args, context) => {
        activeSignal = context.mcpReq.signal;
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          resolveWait = resolve;
          if (context.mcpReq.signal.aborted) {
            resolveCancelled?.();
            resolve();
            return;
          }
          context.mcpReq.signal.addEventListener("abort", () => {
            resolveCancelled?.();
            resolve();
          }, { once: true });
        });
        resolveCompleted?.();
        return {
          content: [{ type: "text", text: "cancelled" }],
          structuredContent: { cancelled: true },
        };
      });
      return server;
    };
    const fixture = transport === "stdio"
      ? await connectStdioMcp(createServer, era)
      : await connectDirectFetchMcp(createMcpHttpHandler(createServer), era);
    const observations = "observations" in fixture
      ? fixture.observations as HttpWireObservation[]
      : undefined;
    closeCallbacks.push(fixture.close);
    await fixture.client.listTools();

    const controller = new AbortController();
    const call = fixture.client.callTool({
      name: "wait_for_cancel",
      arguments: {},
    }, { signal: controller.signal });
    await started;
    controller.abort();

    await expect(call).rejects.toMatchObject({
      name: "SdkError",
      code: SdkErrorCode.RequestTimeout,
      message: expect.stringContaining("AbortError"),
    });
    if (forwardsCancellation) {
      await cancelled;
    } else {
      expect(observations).toBeDefined();
      await expect.poll(() =>
        observations?.some(
          (observation) => observation.requestMethod === "notifications/cancelled"
        ) ?? false
      ).toBe(true);
      expect(activeSignal?.aborted).toBe(false);
      resolveWait?.();
      await completed;
    }
    await expect(fixture.client.listTools()).resolves.toMatchObject({
      tools: expect.any(Array),
    });
  });

  it("aborts an in-flight legacy HTTP request when its handler closes", async () => {
    let resolveStarted: (() => void) | undefined;
    let resolveCancelled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const handler = createMcpHttpHandler(() => {
      const server = new McpServer({ name: "shutdown-test", version: "1.0.0" });
      server.registerTool("wait_for_shutdown", {
        inputSchema: z.object({}),
        outputSchema: z.object({ cancelled: z.boolean() }),
      }, async (_args, context) => {
        resolveStarted?.();
        await new Promise<void>((resolve) => {
          if (context.mcpReq.signal.aborted) {
            resolveCancelled?.();
            resolve();
            return;
          }
          context.mcpReq.signal.addEventListener("abort", () => {
            resolveCancelled?.();
            resolve();
          }, { once: true });
        });
        return {
          content: [{ type: "text", text: "cancelled" }],
          structuredContent: { cancelled: true },
        };
      });
      return server;
    });
    const fixture = await connectDirectFetchMcp(handler, "legacy");
    closeCallbacks.push(fixture.close);

    const call = fixture.client.callTool({
      name: "wait_for_shutdown",
      arguments: {},
    });
    const rejection = expect(call).rejects.toBeDefined();
    await started;
    const close = handler.close();

    await cancelled;
    await close;
    await rejection;
  });

  it.each(ERAS)("settles a %s HTTP request aborted while its async factory is pending", async (era) => {
    let resolveFactoryStarted: (() => void) | undefined;
    let resolveFactory: (() => void) | undefined;
    const factoryStarted = new Promise<void>((resolve) => {
      resolveFactoryStarted = resolve;
    });
    const factoryRelease = new Promise<void>((resolve) => {
      resolveFactory = resolve;
    });
    const lateServer = new McpServer({ name: "pre-cancel-test", version: "1.0.0" });
    const closeLateServer = vi.spyOn(lateServer, "close");
    const handler = createMcpHttpHandler(async () => {
      resolveFactoryStarted?.();
      await factoryRelease;
      return lateServer;
    });
    closeCallbacks.push(handler.close);
    const controller = new AbortController();
    const response = handler.fetch(createRawEraRequest(era, 7001, controller.signal));

    await factoryStarted;
    controller.abort();
    try {
      await expect(settleWithin(response)).resolves.toMatchObject({ status: 499 });
    } finally {
      resolveFactory?.();
    }
    await expect.poll(() => closeLateServer.mock.calls.length).toBe(1);
  });

  it.each(ERAS)("settles handler close while a %s HTTP factory remains pending", async (era) => {
    let resolveFactoryStarted: (() => void) | undefined;
    let resolveFactory: (() => void) | undefined;
    const factoryStarted = new Promise<void>((resolve) => {
      resolveFactoryStarted = resolve;
    });
    const factoryRelease = new Promise<void>((resolve) => {
      resolveFactory = resolve;
    });
    const lateServer = new McpServer({ name: "factory-close-test", version: "1.0.0" });
    const closeLateServer = vi.spyOn(lateServer, "close");
    const handler = createMcpHttpHandler(async () => {
      resolveFactoryStarted?.();
      await factoryRelease;
      return lateServer;
    });
    const response = handler.fetch(createRawEraRequest(era, 7003));

    await factoryStarted;
    const close = handler.close();
    let closedResponse: Response | undefined;
    try {
      [closedResponse] = await settleWithin(Promise.all([response, close]));
    } finally {
      resolveFactory?.();
      await Promise.allSettled([response, close]);
    }

    expect(closedResponse).toMatchObject({ status: 499 });
    await expect.poll(() => closeLateServer.mock.calls.length).toBe(1);
  });

  it("does not connect a modern factory product handed off in the same tick as close", async () => {
    let resolveFactoryStarted: (() => void) | undefined;
    let resolveFactory: (() => void) | undefined;
    let resolveConnect: (() => void) | undefined;
    const factoryStarted = new Promise<void>((resolve) => {
      resolveFactoryStarted = resolve;
    });
    const connectRelease = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const lateServer = new McpServer({ name: "factory-handoff-test", version: "1.0.0" });
    const factoryProduct = new Promise<McpServer>((resolve) => {
      resolveFactory = () => resolve(lateServer);
    });
    const connectLateServer = vi.spyOn(lateServer, "connect").mockImplementation(async () => {
      await connectRelease;
    });
    const closeLateServer = vi.spyOn(lateServer, "close").mockResolvedValue();
    const handler = createMcpHttpHandler(() => {
      resolveFactoryStarted?.();
      return factoryProduct;
    });
    const response = handler.fetch(createRawEraRequest("modern", 7004));

    await factoryStarted;
    resolveFactory?.();
    let close: Promise<void> | undefined;
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        close = handler.close();
        resolve();
      });
    });

    try {
      const [closedResponse] = await settleWithin(Promise.all([response, close!]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closedResponse).toMatchObject({ status: 499 });
      expect(connectLateServer).not.toHaveBeenCalled();
      expect(closeLateServer).toHaveBeenCalledTimes(1);
    } finally {
      resolveConnect?.();
      await Promise.allSettled([response, close ?? handler.close()]);
    }
  });

  it("bounds legacy HTTP factory failures without exposing internal details", async () => {
    const handler = createMcpHttpHandler(() => {
      throw new Error("secret-factory-detail");
    });
    closeCallbacks.push(handler.close);

    const response = await handler.fetch(new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7002,
        method: "tools/list",
        params: {},
      }),
    }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32603, message: "Internal server error" },
      id: null,
    });
    expect(body).not.toContain("secret-factory-detail");
  });
});

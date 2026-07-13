import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import type { Express } from "express";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  closeMcpHttp,
  createMcpHttpApp,
  listenMcpHttp,
  parseMcpHttpPort,
} from "../http-server.js";
import { createAgenticSdlcServer } from "../server.js";

describe("real MCP HTTP request lifecycle", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });

  const startApp = async (
    app: Express
  ): Promise<{ baseUrl: string; address: AddressInfo; listener: Server }> => {
    const listener = listenMcpHttp(app, 0);
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });
    closeCallbacks.push(
      () => closeMcpHttp(listener)
    );
    const address = listener.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${address.port}`, address, listener };
  };

  const initialize = (baseUrl: string, id: number, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: `http-test-${id}`, version: "1.0.0" },
        },
      }),
    });

  const requestWithHost = (baseUrl: string, host: string): Promise<number> => {
    const url = new URL("/mcp", baseUrl);
    return new Promise((resolve, reject) => {
      const req = request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: { host },
      }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
  };

  it("isolates concurrent stateless requests with one server per request", async () => {
    const serverFactory = vi.fn(createAgenticSdlcServer);
    const app = createMcpHttpApp(serverFactory);
    const { baseUrl, address } = await startApp(app);

    expect(address.address).toBe("127.0.0.1");
    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => initialize(baseUrl, index + 1)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const payloads = await Promise.all(responses.map((response) => response.json()));
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: expect.objectContaining({ serverInfo: expect.any(Object) }) }),
      ])
    );
    expect(serverFactory).toHaveBeenCalledTimes(5);
  });

  it("rejects untrusted Host and Origin headers while allowing non-browser and localhost clients", async () => {
    const { baseUrl } = await startApp(createMcpHttpApp());

    expect(await requestWithHost(baseUrl, "attacker.example")).toBe(403);

    const untrustedOrigin = await initialize(baseUrl, 2, { origin: "https://attacker.example" });
    expect(untrustedOrigin.status).toBe(403);
    expect(await untrustedOrigin.json()).toEqual(expect.objectContaining({
      error: expect.objectContaining({ message: "Forbidden origin" }),
    }));

    const malformedOrigin = await initialize(baseUrl, 3, { origin: "not-a-valid-origin" });
    expect(malformedOrigin.status).toBe(403);
    const nonHttpOrigin = await initialize(baseUrl, 4, { origin: "ftp://localhost" });
    expect(nonHttpOrigin.status).toBe(403);

    const localhostOrigin = await initialize(baseUrl, 5, { origin: "http://localhost:5173" });
    expect(localhostOrigin.status).toBe(200);
    const ipv6LoopbackOrigin = await initialize(baseUrl, 6, { origin: "https://[::1]:8443" });
    expect(ipv6LoopbackOrigin.status).toBe(200);
    const noOrigin = await initialize(baseUrl, 7);
    expect(noOrigin.status).toBe(200);
  });

  it.each(["GET", "DELETE"])("returns a JSON-RPC 405 response for unsupported %s requests", async (method) => {
    const { baseUrl } = await startApp(createMcpHttpApp());

    const response = await fetch(`${baseUrl}/mcp`, { method });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  it("returns bounded protocol errors without leaking internal failures or malformed bodies", async () => {
    const failingApp = createMcpHttpApp(() => {
      throw new Error("secret-internal-detail");
    });
    const { baseUrl: failingBaseUrl } = await startApp(failingApp);
    const internalError = await initialize(failingBaseUrl, 1);
    expect(internalError.status).toBe(500);
    const internalText = await internalError.text();
    expect(internalText).toContain("Internal server error");
    expect(internalText).not.toContain("secret-internal-detail");

    const { baseUrl } = await startApp(createMcpHttpApp());
    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    const malformedText = await malformed.text();
    expect(malformedText).toContain("Invalid JSON request body");
    expect(malformedText).not.toContain("SyntaxError");
  });

  it("rejects an oversized JSON body before constructing an MCP server", async () => {
    const serverFactory = vi.fn(createAgenticSdlcServer);
    const { baseUrl } = await startApp(createMcpHttpApp(serverFactory));
    const oversized = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "sensitive-payload".repeat(8_000) }),
    });

    expect(oversized.status).toBe(413);
    const text = await oversized.text();
    expect(text).toContain("Request body too large");
    expect(text).not.toContain("sensitive-payload");
    expect(serverFactory).not.toHaveBeenCalled();
  });

  it("shares one idempotent listener shutdown across repeated callers", async () => {
    const { listener } = await startApp(createMcpHttpApp());

    const firstClose = closeMcpHttp(listener);
    const repeatedClose = closeMcpHttp(listener);

    expect(repeatedClose).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
    expect(listener.listening).toBe(false);
    await expect(closeMcpHttp(listener)).resolves.toBeUndefined();
  });

  it("accepts only bounded integer ports from runtime configuration", () => {
    expect(parseMcpHttpPort(undefined)).toBe(3000);
    expect(parseMcpHttpPort("4312")).toBe(4312);
    for (const value of ["", "0", "65536", "3000abc", "1.5", "NaN"]) {
      expect(() => parseMcpHttpPort(value)).toThrow("PORT must be an integer between 1 and 65535");
    }
  });
});

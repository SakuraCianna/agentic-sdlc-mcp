import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpHttpApp } from "../http-server.js";
import { createAgenticSdlcServer } from "../server.js";

describe("real MCP HTTP request lifecycle", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });

  it("isolates concurrent stateless requests with one server per request", async () => {
    const serverFactory = vi.fn(createAgenticSdlcServer);
    const app = createMcpHttpApp(serverFactory);
    const listener = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });
    closeCallbacks.push(
      () => new Promise<void>((resolve, reject) => {
        listener.close((error) => error ? reject(error) : resolve());
      })
    );

    const { port } = listener.address() as AddressInfo;
    const initialize = (id: number) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: `http-test-${id}`, version: "1.0.0" },
        },
      }),
    });

    const responses = await Promise.all(Array.from({ length: 5 }, (_, index) => initialize(index + 1)));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    const payloads = await Promise.all(responses.map((response) => response.json()));
    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ result: expect.objectContaining({ serverInfo: expect.any(Object) }) }),
      ])
    );
    expect(serverFactory).toHaveBeenCalledTimes(5);
  });
});

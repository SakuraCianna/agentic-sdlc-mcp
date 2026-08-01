import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type FetchLike,
} from "@modelcontextprotocol/client";
import type {
  McpHttpHandler,
  McpServer,
  McpServerFactory,
} from "@modelcontextprotocol/server";

import { serveMcpStdio } from "../../stdio-server.js";

export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

export type McpProtocolEra = "legacy" | "modern";

export interface ConnectedMcpFixture {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
}

export interface ConnectedMcpEntryFixture {
  client: Client;
  close(): Promise<void>;
}

export interface HttpWireObservation {
  requestMethod: string | null;
  protocolVersionHeader: string | null;
  mcpMethodHeader: string | null;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
}

export interface ConnectedDirectFetchFixture extends ConnectedMcpEntryFixture {
  observations: HttpWireObservation[];
}

export function createEraClient(
  era: McpProtocolEra,
  pinnedVersion: string = MODERN_PROTOCOL_VERSION
): Client {
  return new Client(
    { name: `integration-test-${era}-client`, version: "1.0.0" },
    era === "modern"
      ? { versionNegotiation: { mode: { pin: pinnedVersion } } }
      : undefined
  );
}

function jsonRpcMethod(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("method" in value)) {
    return null;
  }
  return typeof value.method === "string" ? value.method : null;
}

async function readJsonBody(message: Request | Response): Promise<unknown> {
  const text = await message.clone().text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Connect a real SDK client and server without sockets or external I/O. */
export async function connectInMemoryMcp(
  createServer: () => McpServer
): Promise<ConnectedMcpFixture> {
  const server = createServer();
  const client = new Client({ name: "integration-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    server,
    async close() {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

/** Exercise the SDK's stdio era router over a real linked transport pair. */
export async function connectStdioMcp(
  createServer: McpServerFactory,
  era: McpProtocolEra,
  pinnedVersion?: string
): Promise<ConnectedMcpEntryFixture> {
  const client = createEraClient(era, pinnedVersion);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveMcpStdio(createServer, { transport: serverTransport });

  try {
    await client.connect(clientTransport);
  } catch (error) {
    await Promise.allSettled([client.close(), handle.close()]);
    throw error;
  }

  return {
    client,
    async close() {
      await Promise.allSettled([client.close(), handle.close()]);
    },
  };
}

/** Connect through a real Streamable HTTP client transport. */
export async function connectHttpMcp(
  url: URL,
  era: McpProtocolEra,
  fetch?: FetchLike,
  pinnedVersion?: string
): Promise<ConnectedMcpEntryFixture> {
  const client = createEraClient(era, pinnedVersion);
  const transport = new StreamableHTTPClientTransport(
    url,
    fetch ? { fetch } : undefined
  );

  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    throw error;
  }

  return {
    client,
    async close() {
      await client.close();
    },
  };
}

/** Route an HTTP client through the production web-standard handler without sockets. */
export async function connectDirectFetchMcp(
  handler: McpHttpHandler,
  era: McpProtocolEra,
  pinnedVersion?: string
): Promise<ConnectedDirectFetchFixture> {
  const observations: HttpWireObservation[] = [];
  const directFetch: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const requestBody = await readJsonBody(request);
    const response = await handler.fetch(request);
    observations.push({
      requestMethod: jsonRpcMethod(requestBody),
      protocolVersionHeader: request.headers.get("mcp-protocol-version"),
      mcpMethodHeader: request.headers.get("mcp-method"),
      requestBody,
      responseStatus: response.status,
      responseBody: await readJsonBody(response),
    });
    return response;
  };
  let connection: ConnectedMcpEntryFixture;
  try {
    connection = await connectHttpMcp(
      new URL("http://localhost/mcp"),
      era,
      directFetch,
      pinnedVersion
    );
  } catch (error) {
    await handler.close();
    throw error;
  }

  return {
    client: connection.client,
    observations,
    async close() {
      await Promise.allSettled([connection.close(), handler.close()]);
    },
  };
}

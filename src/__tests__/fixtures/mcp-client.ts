import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ConnectedMcpFixture {
  client: Client;
  server: McpServer;
  close(): Promise<void>;
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

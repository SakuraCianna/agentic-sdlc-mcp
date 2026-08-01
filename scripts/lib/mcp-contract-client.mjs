import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONTRACT_TIMEOUT_MS = 15_000;
const MAX_CONTRACT_TIMEOUT_MS = 120_000;

function moduleUrl(projectRoot, ...segments) {
  return pathToFileURL(path.join(projectRoot, ...segments)).href;
}

function assertContractTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_CONTRACT_TIMEOUT_MS
  ) {
    throw new Error(
      `MCP contract timeout must be a positive integer no greater than ${MAX_CONTRACT_TIMEOUT_MS}.`
    );
  }
}

export function resolveContractTimeout(timeoutMs) {
  const resolvedTimeoutMs = timeoutMs ?? DEFAULT_CONTRACT_TIMEOUT_MS;
  assertContractTimeout(resolvedTimeoutMs);
  return resolvedTimeoutMs;
}

export async function withContractTimeout(operation, timeoutMs, label) {
  assertContractTimeout(timeoutMs);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function listAll(client, method) {
  const items = [];
  let cursor;
  do {
    const result = await client[method](cursor ? { cursor } : undefined);
    items.push(...result[method === "listTools" ? "tools" : "resources"]);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

/**
 * Collect the public MCP contract from one already-built checkout.
 *
 * SDK client, in-memory transport, and server are all loaded from that same
 * checkout so nominal SDK objects never cross dependency roots.
 */
export async function collectRawMcpContract(projectRoot, options = {}) {
  const timeoutMs = resolveContractTimeout(options.timeoutMs);
  const normalizedRoot = path.resolve(projectRoot);
  const [{ Client }, { InMemoryTransport }, { createAgenticSdlcServer }] =
    await Promise.all([
      import(
        moduleUrl(
          normalizedRoot,
          "node_modules",
          "@modelcontextprotocol",
          "sdk",
          "dist",
          "esm",
          "client",
          "index.js"
        )
      ),
      import(
        moduleUrl(
          normalizedRoot,
          "node_modules",
          "@modelcontextprotocol",
          "sdk",
          "dist",
          "esm",
          "inMemory.js"
        )
      ),
      import(moduleUrl(normalizedRoot, "dist", "server.js")),
    ]);

  const server = createAgenticSdlcServer();
  const client = new Client({
    name: "mcp-contract-collector",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    return await withContractTimeout(
      (async () => {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const [tools, resources] = await Promise.all([
          listAll(client, "listTools"),
          listAll(client, "listResources"),
        ]);
        const serverVersion = client.getServerVersion();
        if (!serverVersion) {
          throw new Error(
            "MCP server did not expose version information after initialize."
          );
        }

        return {
          server: {
            name: serverVersion.name,
            version: serverVersion.version,
          },
          tools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.title === undefined ? {} : { title: tool.title }),
            ...(tool.description === undefined
              ? {}
              : { description: tool.description }),
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema === undefined
              ? {}
              : { outputSchema: tool.outputSchema }),
            ...(tool.annotations === undefined
              ? {}
              : { annotations: tool.annotations }),
          })),
          resources: resources.map((resource) => ({
            uri: resource.uri,
            name: resource.name,
            ...(resource.title === undefined ? {} : { title: resource.title }),
            ...(resource.description === undefined
              ? {}
              : { description: resource.description }),
            ...(resource.mimeType === undefined
              ? {}
              : { mimeType: resource.mimeType }),
          })),
        };
      })(),
      timeoutMs,
      "MCP contract discovery"
    );
  } finally {
    await withContractTimeout(
      Promise.allSettled([
        Promise.resolve().then(() => client.close()),
        Promise.resolve().then(() => server.close()),
      ]),
      Math.min(timeoutMs, 1_000),
      "MCP contract cleanup"
    ).catch(() => undefined);
  }
}

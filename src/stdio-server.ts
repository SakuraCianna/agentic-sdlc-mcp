import type { McpServerFactory } from "@modelcontextprotocol/server";
import {
  serveStdio,
  type ServeStdioOptions,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import { createAgenticSdlcServer } from "./server.js";

/** Serve one local stdio connection with official 2025/2026 era negotiation. */
export function serveMcpStdio(
  createServer: McpServerFactory = createAgenticSdlcServer,
  options?: ServeStdioOptions
): StdioServerHandle {
  return serveStdio(createServer, options);
}

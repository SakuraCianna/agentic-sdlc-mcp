#!/usr/bin/env node
/**
 * agentic-sdlc-mcp — Agentic SDLC Control Plane MCP Server
 *
 * Load .env FIRST (via dotenv/config), before any config import.
 * Windows PowerShell inline alternative:
 *   $env:GITHUB_TOKEN="ghp_..."; node dist/index.js
 *
 * Smoke-test mode (no real token required):
 *   node dist/index.js --smoke
 */
import "dotenv/config";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgenticSdlcServer } from "./server.js";

// Config (exits early if GITHUB_TOKEN missing — skipped in smoke mode)
import { config, initializeConfig } from "./config.js";

// Initialize config (loads global file or asks interactively)
await initializeConfig();

// ---------------------------------------------------------------------------
// Smoke mode: verify registration succeeded then exit cleanly
// ---------------------------------------------------------------------------

if (config.isSmokeMode) {
  createAgenticSdlcServer();
  console.error("[agentic-sdlc-mcp] SMOKE OK — all tools and resources registered successfully.");
  console.error("[agentic-sdlc-mcp] Module load, tool registration, and resource registration: PASSED");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

const transport = process.env["TRANSPORT"] ?? "stdio";

if (transport === "http") {
  /**
   * HTTP transport — requires `express` runtime dependency.
   * Windows PowerShell:
   *   $env:TRANSPORT="http"; $env:PORT="3000"; node dist/index.js
   */
  const {
    closeMcpHttp,
    createMcpHttpApp,
    DEFAULT_MCP_HTTP_HOST,
    listenMcpHttp,
    parseMcpHttpPort,
  } = await import("./http-server.js");
  const app = createMcpHttpApp();

  const port = parseMcpHttpPort(process.env["PORT"]);
  const listener = listenMcpHttp(app, port);
  listener.once("listening", () => {
    console.error(`[agentic-sdlc-mcp] HTTP server listening on http://${DEFAULT_MCP_HTTP_HOST}:${port}/mcp`);
  });
  listener.once("error", () => {
    console.error("[agentic-sdlc-mcp] HTTP server failed to listen");
    process.exitCode = 1;
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await closeMcpHttp(listener);
      process.exit(0);
    } catch {
      console.error("[agentic-sdlc-mcp] HTTP server shutdown failed");
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} else {
  // Default: stdio
  const server = createAgenticSdlcServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error("[agentic-sdlc-mcp] Server running via stdio transport");
}

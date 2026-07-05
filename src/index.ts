#!/usr/bin/env node
/**
 * agentic-sdlc-mcp — Agentic SDLC Control Plane MCP Server
 *
 * Exposes GitHub-backed SDLC tools to AI coding agents via the
 * Model Context Protocol (stdio or streamable HTTP transport).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// Tools
import { registerRepoContextTool } from "./tools/repo-context.js";
import { registerPlanFromContextTool } from "./tools/plan-from-context.js";
import { registerCreateIssueSetTool } from "./tools/create-issue-set.js";
import { registerPrepareWorkItemTool } from "./tools/prepare-work-item.js";
import { registerQualityGateStatusTool } from "./tools/quality-gate-status.js";
import { registerCreatePrSummaryTool } from "./tools/create-pr-summary.js";
import { registerReviewPrTool } from "./tools/review-pr.js";
import { registerSecurityTriageTool } from "./tools/security-triage.js";
import { registerReleaseReadinessTool } from "./tools/release-readiness.js";
import { registerAgentHandoffTool } from "./tools/agent-handoff.js";

// Resources
import { registerResources } from "./resources/index.js";

// Config validation happens at import time — exits early with a clear message
// if GITHUB_TOKEN is missing.
import "./config.js";

// ---------------------------------------------------------------------------
// Server initialisation
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "agentic-sdlc-mcp",
  version: "1.0.0",
});

// Register all tools
registerRepoContextTool(server);
registerPlanFromContextTool(server);
registerCreateIssueSetTool(server);
registerPrepareWorkItemTool(server);
registerQualityGateStatusTool(server);
registerCreatePrSummaryTool(server);
registerReviewPrTool(server);
registerSecurityTriageTool(server);
registerReleaseReadinessTool(server);
registerAgentHandoffTool(server);

// Register all resources
registerResources(server);

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

const transport = process.env["TRANSPORT"] ?? "stdio";

if (transport === "http") {
  // Dynamically import express only when HTTP transport is requested
  // to avoid a hard dependency for stdio-only users.
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => httpTransport.close());
    await server.connect(httpTransport);
    await httpTransport.handleRequest(req, res, req.body);
  });

  const port = parseInt(process.env["PORT"] ?? "3000", 10);
  app.listen(port, () => {
    console.error(`[agentic-sdlc-mcp] HTTP server listening on http://localhost:${port}/mcp`);
  });
} else {
  // Default: stdio
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error("[agentic-sdlc-mcp] Server running via stdio transport");
}

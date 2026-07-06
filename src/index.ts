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
import { registerBranchProtectionStatusTool } from "./tools/branch-protection-status.js";

// Resources
import { registerResources } from "./resources/index.js";

// Config (exits early if GITHUB_TOKEN missing — skipped in smoke mode)
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Server initialisation
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "agentic-sdlc-mcp",
  version: "1.2.0",
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
registerBranchProtectionStatusTool(server);

// Register all resources
registerResources(server);

// ---------------------------------------------------------------------------
// Smoke mode: verify registration succeeded then exit cleanly
// ---------------------------------------------------------------------------

if (config.isSmokeMode) {
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

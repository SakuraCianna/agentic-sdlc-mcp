import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerResources } from "./resources/index.js";
import { registerAgentHandoffTool } from "./tools/agent-handoff.js";
import { registerBranchProtectionStatusTool } from "./tools/branch-protection-status.js";
import { registerCreateIssueSetTool } from "./tools/create-issue-set.js";
import { registerCreatePrSummaryTool } from "./tools/create-pr-summary.js";
import { registerPlanFromContextTool } from "./tools/plan-from-context.js";
import { registerPrepareWorkItemTool } from "./tools/prepare-work-item.js";
import { registerQualityGateStatusTool } from "./tools/quality-gate-status.js";
import { registerReleaseReadinessTool } from "./tools/release-readiness.js";
import { registerRepoContextTool } from "./tools/repo-context.js";
import { registerReviewPrTool } from "./tools/review-pr.js";
import { registerSecurityTriageTool } from "./tools/security-triage.js";
import { registerWorkflowPermissionsAuditTool } from "./tools/workflow-permissions-audit.js";
import { SERVER_INFO } from "./version.js";

/** Build a fully registered server without selecting or opening a transport. */
export function createAgenticSdlcServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

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
  registerWorkflowPermissionsAuditTool(server);
  registerResources(server);

  return server;
}

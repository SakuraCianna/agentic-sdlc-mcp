/** Public MCP tool names, kept in protocol discovery order. */
export const TOOL_NAMES = [
  "repo_context",
  "plan_from_context",
  "create_issue_set",
  "prepare_work_item",
  "quality_gate_status",
  "create_pr_summary",
  "review_pr_against_standard",
  "security_triage",
  "release_readiness_check",
  "agent_handoff_packet",
  "branch_protection_status",
  "workflow_permissions_audit",
  "sdlc_evidence_packet",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

import { z } from "zod";

export const GithubFaultCaseSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  kind: z.enum([
    "http",
    "graphql-partial",
    "timeout",
    "truncation",
    "missing-field",
    "duplicate-response",
  ]),
  endpoint: z.enum([
    "issues.get",
    "pulls.get",
    "pulls.listFiles",
    "checks.listForRef",
    "repos.getCombinedStatusForRef",
    "codeScanning.listAlertsForRepo",
    "graphql",
  ]),
  status: z.union([
    z.literal(401),
    z.literal(403),
    z.literal(404),
    z.literal(422),
    z.literal(429),
    z.literal(500),
  ]).optional(),
  affectedTool: z.string().min(1),
  aggregateTool: z.string().min(1),
  expectedSignal: z.string().min(1),
  preservesSignal: z.string().min(1),
}).strict();

type GithubFaultCaseContract = z.infer<typeof GithubFaultCaseSchema>;

/** Exact v1.0 matrix. Changing a case requires an explicit schema-version review. */
export const GITHUB_FAULT_CONTRACT = [
  { id: "security-401", kind: "http", endpoint: "codeScanning.listAlertsForRepo", status: 401, affectedTool: "security_triage", aggregateTool: "sdlc_evidence_packet", expectedSignal: "Code Scanning", preservesSignal: "Dependabot" },
  { id: "issue-403", kind: "http", endpoint: "issues.get", status: 403, affectedTool: "prepare_work_item", aggregateTool: "agent_handoff_packet", expectedSignal: "unverified", preservesSignal: "repository" },
  { id: "pull-404", kind: "http", endpoint: "pulls.get", status: 404, affectedTool: "create_pr_summary", aggregateTool: "agent_handoff_packet", expectedSignal: "failed", preservesSignal: "repository" },
  { id: "files-422", kind: "http", endpoint: "pulls.listFiles", status: 422, affectedTool: "create_pr_summary", aggregateTool: "sdlc_evidence_packet", expectedSignal: "changed_files", preservesSignal: "pull_request" },
  { id: "checks-429", kind: "http", endpoint: "checks.listForRef", status: 429, affectedTool: "quality_gate_status", aggregateTool: "release_readiness_check", expectedSignal: "check_runs", preservesSignal: "commit_statuses" },
  { id: "status-500", kind: "http", endpoint: "repos.getCombinedStatusForRef", status: 500, affectedTool: "quality_gate_status", aggregateTool: "release_readiness_check", expectedSignal: "commit_statuses", preservesSignal: "check_runs" },
  { id: "graphql-partial", kind: "graphql-partial", endpoint: "graphql", affectedTool: "quality_gate_status", aggregateTool: "sdlc_evidence_packet", expectedSignal: "graphql", preservesSignal: "check_runs" },
  { id: "pull-timeout", kind: "timeout", endpoint: "pulls.get", affectedTool: "create_pr_summary", aggregateTool: "sdlc_evidence_packet", expectedSignal: "timeout", preservesSignal: "policy" },
  { id: "files-truncated", kind: "truncation", endpoint: "pulls.listFiles", affectedTool: "create_pr_summary", aggregateTool: "sdlc_evidence_packet", expectedSignal: "changed_files", preservesSignal: "pull_request" },
  { id: "pull-missing-field", kind: "missing-field", endpoint: "pulls.get", affectedTool: "create_pr_summary", aggregateTool: "agent_handoff_packet", expectedSignal: "failed", preservesSignal: "repository" },
  { id: "duplicate-check-response", kind: "duplicate-response", endpoint: "checks.listForRef", affectedTool: "quality_gate_status", aggregateTool: "release_readiness_check", expectedSignal: "deduplicated", preservesSignal: "check_runs" },
] as const satisfies readonly GithubFaultCaseContract[];

export const GithubFaultConfigSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    cases: z.array(GithubFaultCaseSchema).min(1),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, fault] of config.cases.entries()) {
      if (ids.has(fault.id)) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "id"],
          message: `Duplicate fault id: ${fault.id}`,
        });
      }
      ids.add(fault.id);
      if (fault.kind === "http" && fault.status === undefined) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "status"],
          message: "HTTP faults require an explicit status.",
        });
      }
      if (fault.kind !== "http" && fault.status !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "status"],
          message: "Only HTTP faults may declare a status.",
        });
      }
      if (fault.affectedTool === fault.aggregateTool) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "aggregateTool"],
          message: "Aggregate coverage must use a different public tool.",
        });
      }
    }
    if (JSON.stringify(config.cases) !== JSON.stringify(GITHUB_FAULT_CONTRACT)) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "Fault cases must exactly match the versioned v1.0 contract.",
      });
    }
  });

export type GithubFaultConfig = z.infer<typeof GithubFaultConfigSchema>;
export type GithubFaultCase = GithubFaultConfig["cases"][number];

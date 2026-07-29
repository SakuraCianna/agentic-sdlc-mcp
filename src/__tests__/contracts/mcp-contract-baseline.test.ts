import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { McpContractManifest } from "../../contracts/mcp-manifest.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BASELINE_URL = new URL(
  "../../../contracts/mcp/v1.9.0.json",
  import.meta.url
);
const SOURCE = {
  tag: "v1.9.0",
  commit: "3e1cdbb2d591ba482903f53579f1f76cc95ff1c4",
  releaseUrl:
    "https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.9.0",
} as const;
const V1_9_0_TOOL_NAMES = [
  "agent_handoff_packet",
  "branch_protection_status",
  "create_issue_set",
  "create_pr_summary",
  "plan_from_context",
  "prepare_work_item",
  "quality_gate_status",
  "release_readiness_check",
  "repo_context",
  "review_pr_against_standard",
  "sdlc_evidence_packet",
  "security_triage",
  "workflow_permissions_audit",
] as const;
const V1_9_0_RESOURCE_URIS = [
  "sdlc://standards/agentic-sdlc",
  "sdlc://templates/handoff",
  "sdlc://templates/issue",
  "sdlc://templates/pr-summary",
  "sdlc://templates/release-readiness",
] as const;
const VALID_GENERATOR_ARGS = [
  "--tag",
  SOURCE.tag,
  "--expected-commit",
  SOURCE.commit,
  "--release-url",
  SOURCE.releaseUrl,
  "--output",
  "contracts/mcp/v1.9.0.json",
] as const;

function readBaselineText(): string {
  return readFileSync(BASELINE_URL, "utf8");
}

function readBaseline(): McpContractManifest {
  return JSON.parse(readBaselineText()) as McpContractManifest;
}

function runGenerator(args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/generate-mcp-contract.mjs", ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
    }
  );
}

describe("immutable v1.9.0 MCP contract baseline", () => {
  it("records complete public discovery metadata from the pinned release", () => {
    const baseline = readBaseline();

    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.source).toEqual(SOURCE);
    expect(baseline.server).toEqual({
      name: "agentic-sdlc-mcp",
      version: "1.9.0",
    });
    expect(baseline.tools).toHaveLength(13);
    expect(baseline.resources).toHaveLength(5);
    expect(baseline.tools.map((tool) => tool.name)).toEqual(V1_9_0_TOOL_NAMES);
    expect(baseline.resources.map((resource) => resource.uri)).toEqual(
      V1_9_0_RESOURCE_URIS
    );

    for (const tool of baseline.tools) {
      expect(tool.description?.trim(), `${tool.name} description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} input schema`).toMatchObject({
        type: "object",
      });
      expect(tool.outputSchema, `${tool.name} output schema`).toMatchObject({
        type: "object",
      });
      expect(tool.annotations, `${tool.name} annotations`).toEqual({
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
        readOnlyHint: expect.any(Boolean),
      });
    }

    for (const resource of baseline.resources) {
      expect(resource.name.trim(), `${resource.uri} name`).toBeTruthy();
      expect(
        resource.description?.trim(),
        `${resource.uri} description`
      ).toBeTruthy();
      expect(resource.mimeType, `${resource.uri} MIME type`).toBe("text/markdown");
    }
  });

  it("refuses to rewrite the baseline without the explicit update flag", () => {
    const before = readBaselineText();
    const result = runGenerator([...VALID_GENERATOR_ARGS]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("explicit --update flag");
    expect(readBaselineText()).toBe(before);
  });

  it.each([
    {
      name: "unknown option",
      args: ["--unknown", "value", "--update"],
      message: "Unknown argument",
    },
    {
      name: "missing option value",
      args: ["--tag", "--update"],
      message: "Missing value",
    },
    {
      name: "output path escape",
      args: [
        ...VALID_GENERATOR_ARGS.slice(0, -2),
        "--output",
        "outside-contract.json",
        "--update",
      ],
      message: "inside contracts/mcp",
    },
    {
      name: "tag and commit mismatch",
      args: [
        "--tag",
        SOURCE.tag,
        "--expected-commit",
        "0000000000000000000000000000000000000000",
        "--release-url",
        SOURCE.releaseUrl,
        "--output",
        "contracts/mcp/v1.9.0.json",
        "--update",
      ],
      message: `Tag ${SOURCE.tag} resolves to`,
    },
  ])("rejects $name without changing the baseline", ({ args, message }) => {
    const before = readBaselineText();
    const result = runGenerator(args);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(readBaselineText()).toBe(before);
  });
});

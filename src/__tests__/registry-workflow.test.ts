import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface RegistryWorkflow {
  on?: { release?: { types?: string[] } };
  permissions?: Record<string, string>;
  jobs?: {
    publish?: {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    };
  };
}

describe("MCP Registry publish workflow", () => {
  it("uses release-gated least-privilege OIDC and immutable dependencies", async () => {
    const workflowPath = new URL(
      "../../.github/workflows/publish-registry.yml",
      import.meta.url
    );
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as RegistryWorkflow;
    const job = workflow.jobs?.publish;
    const steps = job?.steps ?? [];

    expect(workflow.on?.release?.types).toEqual(["published"]);
    expect(job?.permissions ?? workflow.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(steps.some((step) => step.uses === "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0")).toBe(true);
    expect(steps.some((step) => step.uses === "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e")).toBe(true);
    expect(source).not.toContain("MCP_GITHUB_TOKEN");
    expect(source).not.toContain("releases/latest");
  });

  it("verifies npm first, pins and checksums the publisher, then verifies Registry discovery", async () => {
    const workflowPath = new URL(
      "../../.github/workflows/publish-registry.yml",
      import.meta.url
    );
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as RegistryWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];

    const versionIndex = steps.findIndex((step) => step.name === "Verify release metadata");
    const npmIndex = steps.findIndex((step) => step.name === "Wait for exact npm package version");
    const installIndex = steps.findIndex((step) => step.name === "Install verified mcp-publisher v1.7.9");
    const loginIndex = steps.findIndex((step) => step.run === "./mcp-publisher login github-oidc");
    const publishIndex = steps.findIndex((step) => step.run === "./mcp-publisher publish");
    const verifyIndex = steps.findIndex((step) => step.name === "Verify Registry publication");

    expect(versionIndex).toBeGreaterThan(-1);
    expect(npmIndex).toBeGreaterThan(versionIndex);
    expect(installIndex).toBeGreaterThan(npmIndex);
    expect(loginIndex).toBeGreaterThan(installIndex);
    expect(publishIndex).toBeGreaterThan(loginIndex);
    expect(verifyIndex).toBeGreaterThan(publishIndex);
    expect(steps[installIndex]?.run).toContain(
      "ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac"
    );
    expect(steps[installIndex]?.run).toContain("sha256sum --check");
    expect(steps[verifyIndex]?.run).toContain(
      "io.github.SakuraCianna/agentic-sdlc-mcp"
    );
    expect(steps[verifyIndex]?.run).toContain('pkg.registryType === "npm"');
    expect(steps[verifyIndex]?.run).toContain('pkg.identifier === "agentic-sdlc-mcp"');
    expect(steps[verifyIndex]?.run).toContain('npmPackage?.transport?.type === "stdio"');
  });
});

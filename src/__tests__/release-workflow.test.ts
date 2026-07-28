import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface PublishWorkflow {
  on?: {
    release?: { types?: string[] };
    workflow_dispatch?: unknown;
  };
  jobs?: {
    publish?: {
      steps?: WorkflowStep[];
    };
  };
}

describe("npm publish workflow", () => {
  it("publishes only a validated release target with immutable OIDC dependencies", async () => {
    const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as PublishWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];

    const setupNode = steps.find(
      (step) =>
        step.uses ===
        "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"
    );
    const checkout = steps.find(
      (step) =>
        step.uses ===
        "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
    );
    const verifyIndex = steps.findIndex(
      (step) => step.name === "Verify release target and metadata"
    );
    const installIndex = steps.findIndex((step) => step.run === "npm ci");
    const upgradeIndex = steps.findIndex((step) => step.run === "npm install -g npm@11.11.0");
    const publishIndex = steps.findIndex((step) => step.run === "npm publish --access public");

    expect(workflow.on?.release?.types).toEqual(["published"]);
    expect(workflow.on).not.toHaveProperty("workflow_dispatch");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(setupNode?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(steps[verifyIndex]?.run).toContain("git merge-base --is-ancestor HEAD origin/main");
    expect(steps[verifyIndex]?.run).toContain("release tag ${process.env.RELEASE_TAG}");
    expect(steps[verifyIndex]?.run).toContain("package-lock root version != npm version");
    expect(installIndex).toBeGreaterThan(verifyIndex);
    expect(upgradeIndex).toBeGreaterThan(installIndex);
    expect(publishIndex).toBeGreaterThan(upgradeIndex);
    expect(source).not.toContain("run: npm run prepublishOnly");
  });

  it("applies the same immutable target checks before MCP Registry publication", async () => {
    const workflowPath = new URL(
      "../../.github/workflows/publish-registry.yml",
      import.meta.url
    );
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as PublishWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];
    const checkout = steps.find(
      (step) =>
        step.uses ===
        "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
    );
    const verifyIndex = steps.findIndex(
      (step) => step.name === "Verify release target and metadata"
    );
    const loginIndex = steps.findIndex(
      (step) => step.run === "./mcp-publisher login github-oidc"
    );
    const publishIndex = steps.findIndex(
      (step) => step.run === "./mcp-publisher publish"
    );

    expect(workflow.on?.release?.types).toEqual(["published"]);
    expect(workflow.on).not.toHaveProperty("workflow_dispatch");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(steps[verifyIndex]?.run).toContain(
      "git merge-base --is-ancestor HEAD origin/main"
    );
    expect(steps[verifyIndex]?.run).toContain(
      "package-lock root version != npm version"
    );
    expect(loginIndex).toBeGreaterThan(verifyIndex);
    expect(publishIndex).toBeGreaterThan(loginIndex);
  });

  it("does not pin dependency tarballs to a third-party npm mirror", async () => {
    const lockfilePath = new URL("../../package-lock.json", import.meta.url);
    const lockfile = await readFile(lockfilePath, "utf8");

    expect(lockfile).not.toContain("registry.npmmirror.com");
    expect(lockfile).toContain("https://registry.npmjs.org/");
  });
});

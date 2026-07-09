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
  jobs?: {
    publish?: {
      steps?: WorkflowStep[];
    };
  };
}

describe("npm publish workflow", () => {
  it("installs from the official registry before upgrading npm for OIDC publishing", async () => {
    const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);
    const workflow = parse(await readFile(workflowPath, "utf8")) as PublishWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];

    const setupNode = steps.find((step) => step.uses === "actions/setup-node@v6");
    const installIndex = steps.findIndex((step) => step.run === "npm ci");
    const checksIndex = steps.findIndex((step) => step.run === "npm run prepublishOnly");
    const upgradeIndex = steps.findIndex((step) => step.run === "npm install -g npm@11.11.0");
    const publishIndex = steps.findIndex((step) => step.run === "npm publish --access public");

    expect(setupNode?.with?.["registry-url"]).toBe("https://registry.npmjs.org");
    expect(installIndex).toBeGreaterThan(-1);
    expect(checksIndex).toBeGreaterThan(installIndex);
    expect(upgradeIndex).toBeGreaterThan(checksIndex);
    expect(publishIndex).toBeGreaterThan(upgradeIndex);
  });

  it("does not pin dependency tarballs to a third-party npm mirror", async () => {
    const lockfilePath = new URL("../../package-lock.json", import.meta.url);
    const lockfile = await readFile(lockfilePath, "utf8");

    expect(lockfile).not.toContain("registry.npmmirror.com");
    expect(lockfile).toContain("https://registry.npmjs.org/");
  });
});

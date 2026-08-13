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

interface CiWorkflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

describe("CI workflow action pins", () => {
  it("uses the same immutable checkout and setup-node commits in every job", async () => {
    const workflowPath = new URL("../../.github/workflows/ci.yml", import.meta.url);
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as CiWorkflow;
    const uses = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter((value): value is string => value !== undefined);

    expect(uses.filter((value) => value.startsWith("actions/checkout@"))).toEqual(
      Array(3).fill(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
      )
    );
    expect(uses.filter((value) => value.startsWith("actions/setup-node@"))).toEqual(
      Array(3).fill(
        "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
      )
    );
    expect(uses.filter((value) => value.startsWith("actions/upload-artifact@"))).toEqual(
      Array(2).fill(
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
      )
    );
    expect(source).not.toMatch(
      /uses:\s+actions\/(?:checkout|setup-node|upload-artifact)@v/iu
    );
  });

  it("runs the Node 24 contract/evaluation release gate and uploads only sanitized files", async () => {
    const workflowPath = new URL("../../.github/workflows/ci.yml", import.meta.url);
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as CiWorkflow;
    const job = workflow.jobs?.["inspector-stdio-contract"];
    const steps = job?.steps ?? [];

    const checkout = steps.find((step) => step.name === "Checkout with release tags");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(steps.some((step) => step.run === "npm run contracts:check")).toBe(true);
    expect(steps.some((step) => step.run === "node scripts/check-mcp-contract.mjs")).toBe(false);
    expect(steps.some((step) => step.run === "npm run eval:ci")).toBe(true);
    const upload = steps.find(
      (step) => step.uses === "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    );
    expect(upload?.with?.["if-no-files-found"]).toBe("error");
    const artifactPaths = String(upload?.with?.path).trim().split(/\r?\n/u);
    expect(artifactPaths).toEqual([
      "artifacts/contracts/manifest-diff.json",
      "artifacts/conformance/v0.1.16/checks.json",
      "artifacts/evaluation/scenario-score.json",
      "artifacts/evaluation/budgets.json",
      "artifacts/evaluation/faults.json",
    ]);
    expect(artifactPaths).not.toContain("artifacts/");
    expect(artifactPaths.every((artifactPath) => !artifactPath.includes("*"))).toBe(true);
  });
});

describe("npm publish workflow", () => {
  it("publishes only a validated release target with immutable OIDC dependencies", async () => {
    const workflowPath = new URL("../../.github/workflows/publish.yml", import.meta.url);
    const source = await readFile(workflowPath, "utf8");
    const workflow = parse(source) as PublishWorkflow;
    const steps = workflow.jobs?.publish?.steps ?? [];

    const setupNode = steps.find(
      (step) =>
        step.uses ===
        "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"
    );
    const checkout = steps.find(
      (step) =>
        step.uses ===
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
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
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
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

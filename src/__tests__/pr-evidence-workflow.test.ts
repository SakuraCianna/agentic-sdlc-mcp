import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createContractCollectorEnvironment } from "../../scripts/lib/pinned-mcp-contract.mjs";

interface Step { name: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Workflow { on: Record<string, { inputs: Record<string, { type: string; default?: unknown }> }>; permissions: Record<string, string>; jobs: Record<string, { "runs-on": string; steps: Step[] }> }
const source = await fs.readFile(new URL("../../.github/workflows/pr-evidence.yml", import.meta.url), "utf8");
const workflow = parse(source) as Workflow;
const steps = workflow.jobs.assess.steps;

describe("reusable PR evidence trust boundary", () => {
  it("requires explicit workflow reuse, read-only permissions and an immutable published package version", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_call"]);
    expect(workflow.on.workflow_call.inputs.pull_number.type).toBe("number");
    expect(workflow.on.workflow_call.inputs.enforce).toEqual(expect.objectContaining({ type: "boolean", default: false }));
    expect(workflow.on.workflow_call.inputs.package_version.default).toBe("1.11.0");
    expect(workflow.permissions).toEqual({ contents: "read", checks: "read", "pull-requests": "read", actions: "read" });
    expect(steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(source).not.toMatch(/pull_request_target|secrets: inherit|npm (?:ci|run)/);
    const install = steps.find((step) => step.name.startsWith("Install exact"))!;
    expect(install.run).toContain('"agentic-sdlc-mcp@$env:SDLC_PACKAGE_VERSION" --ignore-scripts');
    expect(install.run).toContain("--registry=https://registry.npmjs.org");
    expect(install.run).toContain("must be an exact release version");
    expect(install.env).not.toHaveProperty("GITHUB_TOKEN");
    for (const step of steps.filter((step) => step.uses)) expect(step.uses).toMatch(/^actions\/[a-z-]+@[a-f0-9]{40}$/);
  });

  it("passes exact current-job identity only to the reviewer and uploads explicit evidence paths", () => {
    const assess = steps.find((step) => step.name.startsWith("Assess PR"))!;
    expect(assess.env).toEqual(expect.objectContaining({ SDLC_CURRENT_CHECK_RUN_ID: "${{ job.check_run_id }}", SDLC_READ_ONLY: "true", GITHUB_TOKEN: "${{ github.token }}" }));
    expect(source).not.toMatch(/GITHUB_RUN_ID:|GITHUB_REPOSITORY:/);
    expect(assess.run).toContain('if ($env:SDLC_ENFORCE -eq "true") { $arguments += "--enforce" }');
    expect(assess.run).toContain("needs_evidence");
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(String(upload.with?.path).trim().split("\n")).toEqual(["${{ runner.temp }}/sdlc-pr-evidence/assessment.json", "${{ runner.temp }}/sdlc-pr-evidence/assessment.md"]);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });

  it("keeps Windows checks limited to CLI, configuration and real stdio lifecycle", async () => {
    const ci = parse(await fs.readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8")) as Workflow;
    const job = ci.jobs["windows-smoke"];
    expect(job["runs-on"]).toBe("windows-latest");
    const commands = job.steps.flatMap((step) => step.run ? [step.run] : []).join("\n");
    expect(commands).toContain("npm run build"); expect(commands).toContain("node dist/cli.js --version");
    expect(commands).toContain("doctor --json"); expect(commands).not.toContain("--online");
    expect(commands).toContain("src/__tests__/config.integration.test.ts src/__tests__/mcp-stdio-process.integration.test.ts");
    expect(commands).not.toMatch(/test:coverage|npm run test(?:\s|$)/);
  });
});

describe("PR evidence workflow advisory and enforcement behavior", () => {
  it.each([
    { enforce: false, available: true, decision: "blocked", expectedExit: 0 },
    { enforce: true, available: true, decision: "blocked", expectedExit: 1 },
    { enforce: true, available: true, decision: "needs_evidence", expectedExit: 2 },
    { enforce: false, available: false, decision: "needs_evidence", expectedExit: 0 },
    { enforce: true, available: false, decision: "needs_evidence", expectedExit: 2 },
    { enforce: false, available: false, decision: "needs_evidence", cliExit: 0, expectedExit: 0 },
    { enforce: true, available: false, decision: "needs_evidence", cliExit: 0, expectedExit: 2 },
  ])("preserves $decision with enforce=$enforce, available=$available, CLI exit=$cliExit", async (scenario) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdlc-workflow-"));
    const cliDirectory = path.join(root, "agentic-sdlc-runtime/node_modules/agentic-sdlc-mcp/dist");
    try {
      await fs.mkdir(cliDirectory, { recursive: true });
      await fs.writeFile(path.join(cliDirectory, "cli.js"), `
        const fs = require("node:fs");
        const args = process.argv.slice(2);
        const enforced = args.includes("--enforce");
        if (process.env.SDLC_READ_ONLY !== "true" || process.env.SDLC_CURRENT_CHECK_RUN_ID !== "123") process.exit(99);
        if (process.env.FIXTURE_CLI_EXIT !== "") process.exit(Number(process.env.FIXTURE_CLI_EXIT));
        if (process.env.FIXTURE_AVAILABLE === "true") {
          fs.writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({decision:process.env.FIXTURE_DECISION,enforced}));
          fs.writeFileSync(args[args.indexOf("--summary") + 1], "# Fixture evidence\\nDecision: " + process.env.FIXTURE_DECISION);
        }
        process.exit(process.env.FIXTURE_AVAILABLE !== "true" ? 2 : enforced ? process.env.FIXTURE_DECISION === "blocked" ? 1 : 2 : 0);
      `);
      const scriptPath = path.join(root, "review.ps1");
      await fs.writeFile(scriptPath, steps.find((step) => step.name.startsWith("Assess PR"))!.run!);
      const child = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
        encoding: "utf8", timeout: 20_000, windowsHide: true,
        env: { ...createContractCollectorEnvironment(), RUNNER_TEMP: root, GITHUB_REPOSITORY: "owner/repo", SDLC_PULL_NUMBER: "7", SDLC_ENFORCE: String(scenario.enforce), SDLC_READ_ONLY: "true", SDLC_CURRENT_CHECK_RUN_ID: "123", GITHUB_STEP_SUMMARY: path.join(root, "summary.md"), FIXTURE_AVAILABLE: String(scenario.available), FIXTURE_DECISION: scenario.decision, FIXTURE_CLI_EXIT: "cliExit" in scenario ? String(scenario.cliExit) : "" },
      });
      expect(child.error).toBeUndefined(); expect(child.stderr).toBe(""); expect(child.status).toBe(scenario.expectedExit);
      const report = JSON.parse(await fs.readFile(path.join(root, "sdlc-pr-evidence/assessment.json"), "utf8"));
      expect(report.decision).toBe(scenario.decision);
      if (scenario.available) expect(report.enforced).toBe(scenario.enforce);
      else expect(report).toEqual(expect.objectContaining({ schemaVersion: "workflow-unavailable-1", cliExitCode: "cliExit" in scenario ? scenario.cliExit : 2, reasonCode: "reviewer_unavailable" }));
      expect(await fs.readFile(path.join(root, "summary.md"), "utf8")).toContain(scenario.decision);
    } finally {
      if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Workflow fixture escaped temp directory.");
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

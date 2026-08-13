import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const VITEST_ENTRY = path.join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs");
const GROUP_TESTS = new Map([
  [
    "budgets",
    [
      "src/__tests__/evaluation/deterministic-runner.test.ts",
      "src/__tests__/evaluation/budgets.test.ts",
      "src/__tests__/evaluation/budget-mcp.test.ts",
      "src/__tests__/evidence/timeout.test.ts",
    ],
  ],
  [
    "selection",
    [
      "src/__tests__/evaluation/deterministic-runner.test.ts",
      "src/__tests__/evaluation/selection.test.ts",
    ],
  ],
  [
    "critical",
    [
      "src/__tests__/evaluation/critical.test.ts",
      "src/__tests__/evaluation/channel-parity.test.ts",
      "src/__tests__/evaluation/injection-mcp.test.ts",
    ],
  ],
]);
const ALLOWED_ENVIRONMENT_NAMES = [
  "CI",
  "COMSPEC",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TZ",
  "WINDIR",
];
const ALLOWED_ENVIRONMENT_NAME_SET = new Set(ALLOWED_ENVIRONMENT_NAMES);

export function parseDeterministicEvaluationArgs(args) {
  if (args.length !== 2 || args[0] !== "--group") {
    throw new Error(
      `Usage: npm run eval:deterministic -- --group <${[...GROUP_TESTS.keys()].join("|")}>`
    );
  }
  const group = args[1];
  if (!GROUP_TESTS.has(group)) {
    throw new Error(`Unsupported evaluation group. Expected: ${[...GROUP_TESTS.keys()].join(", ")}.`);
  }
  return group;
}

export function createDeterministicEvaluationEnvironment(source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (ALLOWED_ENVIRONMENT_NAME_SET.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  environment.AGENTIC_EVALUATION_OFFLINE = "1";
  return environment;
}

export function assertCompleteBudgetArtifact(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Budget artifact must be an object.");
  }
  const artifact = value;
  if (
    artifact.complete !== true ||
    artifact.expectedReports !== 13 ||
    artifact.completedReports !== 13 ||
    !Array.isArray(artifact.reports) ||
    artifact.reports.length !== 13 ||
    artifact.reports.some((report) => !report || report.passed !== true)
  ) {
    throw new Error("Budget artifact is incomplete or contains failed reports.");
  }
  const scenarioIds = new Set(artifact.reports.map((report) => report.scenarioId));
  if (scenarioIds.size !== 13) {
    throw new Error("Budget artifact scenario ids must be unique.");
  }
}

function removePendingArtifact(pendingArtifactPath) {
  if (!pendingArtifactPath) return;
  try {
    unlinkSync(pendingArtifactPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function main() {
  let group;
  try {
    group = parseDeterministicEvaluationArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid evaluation arguments.");
    process.exitCode = 2;
    return;
  }

  const testPaths = GROUP_TESTS.get(group);
  const environment = createDeterministicEvaluationEnvironment();
  let pendingArtifactPath;
  let finalArtifactPath;
  if (group === "budgets") {
    finalArtifactPath = path.join(
      PROJECT_ROOT,
      "artifacts",
      "evaluation",
      "budgets.json"
    );
    pendingArtifactPath = `${finalArtifactPath}.pending-${process.pid}`;
    environment.AGENTIC_EVALUATION_ARTIFACT = pendingArtifactPath;
  }
  const result = spawnSync(process.execPath, [VITEST_ENTRY, "run", ...testPaths], {
    cwd: PROJECT_ROOT,
    env: environment,
    stdio: "inherit",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) {
    removePendingArtifact(pendingArtifactPath);
    console.error("Deterministic evaluation runner failed to start safely.");
    process.exitCode = 1;
    return;
  }
  if (result.status !== 0) {
    removePendingArtifact(pendingArtifactPath);
    process.exitCode = result.status ?? 1;
    return;
  }
  if (group === "budgets") {
    try {
      const artifact = JSON.parse(readFileSync(pendingArtifactPath, "utf8"));
      assertCompleteBudgetArtifact(artifact);
      renameSync(pendingArtifactPath, finalArtifactPath);
    } catch (error) {
      removePendingArtifact(pendingArtifactPath);
      console.error(
        error instanceof Error
          ? `Budget artifact publication failed: ${error.message}`
          : "Budget artifact publication failed."
      );
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  main();
}

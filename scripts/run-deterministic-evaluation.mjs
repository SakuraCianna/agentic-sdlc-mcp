import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const VITEST_ENTRY = path.join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs");
const GROUP_TESTS = new Map([
  [
    "selection",
    [
      "src/__tests__/evaluation/deterministic-runner.test.ts",
      "src/__tests__/evaluation/selection.test.ts",
    ],
  ],
  ["critical", ["src/__tests__/evaluation/critical.test.ts"]],
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
  const result = spawnSync(process.execPath, [VITEST_ENTRY, "run", ...testPaths], {
    cwd: PROJECT_ROOT,
    env: createDeterministicEvaluationEnvironment(),
    stdio: "inherit",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) {
    console.error("Deterministic evaluation runner failed to start safely.");
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  main();
}

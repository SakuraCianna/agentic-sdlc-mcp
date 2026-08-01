import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertInspectorOutputIsSafe,
  createInspectorEnvironment,
  startInspectorHttpServer,
} from "./run-inspector-contracts.mjs";

export const CONFORMANCE_TOOL_VERSION = "0.1.16";
export const CONFORMANCE_PROTOCOL_VERSION = "2025-11-25";
export const CONFORMANCE_SUITE = "active";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const EXPECTED_SCENARIO_COUNT = 30;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120_000;
const BASELINE_RELATIVE_PATH = path.join(
  "contracts",
  "conformance",
  `v${CONFORMANCE_TOOL_VERSION}-expected-failures.json`
);
const ARTIFACT_RELATIVE_PATH = path.join(
  "artifacts",
  "conformance",
  `v${CONFORMANCE_TOOL_VERSION}`,
  "checks.json"
);
const HARNESS_PATH = path.join(SCRIPT_DIRECTORY, "fixtures", "deny-external-fetch.mjs");
const SAFE_SCENARIO_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CHECK_STATUSES = new Set(["FAILURE", "INFO", "SUCCESS", "WARNING"]);
const FAILURE_STATUSES = new Set(["FAILURE", "WARNING"]);
const SENSITIVE_ENVIRONMENT_NAMES = [
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`Conformance baseline ${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function requireScenario(value) {
  const scenario = requireNonEmptyString(value, "scenario");
  if (!SAFE_SCENARIO_PATTERN.test(scenario)) {
    throw new Error(`Conformance scenario is not safe: ${JSON.stringify(scenario)}.`);
  }
  return scenario;
}

function compareStrings(left, right) {
  return left.localeCompare(right, "en");
}

export function createConformanceExitError(exitCode) {
  return new Error(
    `Conformance process exited with ${String(exitCode)}; ` +
    "isolated raw output was withheld from logs."
  );
}

export async function closeConformanceServerForSuccess(server) {
  await server.close();
}

export function validateConformanceBaseline(value) {
  if (!isRecord(value)) {
    throw new Error("Conformance baseline must be an object.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Conformance baseline schemaVersion must be 1.");
  }
  if (value.toolVersion !== CONFORMANCE_TOOL_VERSION) {
    throw new Error(
      `Conformance baseline toolVersion must be ${CONFORMANCE_TOOL_VERSION}.`
    );
  }
  if (value.protocolVersion !== CONFORMANCE_PROTOCOL_VERSION) {
    throw new Error(
      `Conformance baseline protocolVersion must be ${CONFORMANCE_PROTOCOL_VERSION}.`
    );
  }
  if (value.suite !== CONFORMANCE_SUITE) {
    throw new Error(`Conformance baseline suite must be ${CONFORMANCE_SUITE}.`);
  }
  if (!Array.isArray(value.expectedFailures) || value.expectedFailures.length === 0) {
    throw new Error("Conformance baseline expectedFailures must be a non-empty array.");
  }

  const expectedFailures = value.expectedFailures.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Conformance baseline expectedFailures[${index}] must be an object.`);
    }
    return {
      scenario: requireScenario(entry.scenario),
      reason: requireNonEmptyString(entry.reason, `expectedFailures[${index}].reason`),
      owner: requireNonEmptyString(entry.owner, `expectedFailures[${index}].owner`),
      removeWhen: requireNonEmptyString(
        entry.removeWhen,
        `expectedFailures[${index}].removeWhen`
      ),
    };
  });
  const scenarios = expectedFailures.map((entry) => entry.scenario);
  const sortedScenarios = [...scenarios].sort(compareStrings);
  if (new Set(scenarios).size !== scenarios.length) {
    throw new Error("Conformance baseline scenarios must be unique.");
  }
  if (JSON.stringify(scenarios) !== JSON.stringify(sortedScenarios)) {
    throw new Error("Conformance baseline scenarios must be sorted.");
  }

  return {
    schemaVersion: 1,
    toolVersion: CONFORMANCE_TOOL_VERSION,
    protocolVersion: CONFORMANCE_PROTOCOL_VERSION,
    suite: CONFORMANCE_SUITE,
    expectedFailures,
  };
}

export function renderExpectedFailuresYaml(expectedFailures) {
  if (!Array.isArray(expectedFailures) || expectedFailures.length === 0) {
    throw new Error("Conformance baseline expectedFailures must be a non-empty array.");
  }
  return `server:\n${expectedFailures
    .map((entry) => `  - ${requireScenario(entry?.scenario)}`)
    .join("\n")}\n`;
}

function validateResult(result, index) {
  if (!isRecord(result)) {
    throw new Error(`Conformance result ${index} must be an object.`);
  }
  const scenario = requireScenario(result.scenario);
  if (!Array.isArray(result.checks) || result.checks.length === 0) {
    throw new Error(`Conformance result ${scenario} must contain checks.`);
  }
  const checks = result.checks.map((check, checkIndex) => {
    if (!isRecord(check) || typeof check.id !== "string" || check.id.length === 0) {
      throw new Error(`Conformance check ${scenario}[${checkIndex}] must have an id.`);
    }
    if (typeof check.status !== "string" || !CHECK_STATUSES.has(check.status)) {
      throw new Error(
        `Conformance check ${scenario}[${checkIndex}] has an unsupported status.`
      );
    }
    return check;
  });
  return { scenario, checks };
}

export function assertConformanceBaselineMatches(expectedFailures, results) {
  if (!Array.isArray(expectedFailures) || !Array.isArray(results)) {
    throw new Error("Conformance baseline comparison requires arrays.");
  }
  const expectedScenarios = expectedFailures.map((entry) => requireScenario(entry?.scenario));
  const normalizedResults = results.map(validateResult);
  const resultScenarios = normalizedResults.map((result) => result.scenario);
  if (new Set(resultScenarios).size !== resultScenarios.length) {
    throw new Error("Conformance results contain duplicate scenarios.");
  }

  const observedFailures = normalizedResults
    .filter((result) => result.checks.some((check) => FAILURE_STATUSES.has(check.status)))
    .map((result) => result.scenario)
    .sort(compareStrings);
  const observedFailureSet = new Set(observedFailures);
  const expectedSet = new Set(expectedScenarios);
  const unexpectedFailures = observedFailures.filter((scenario) => !expectedSet.has(scenario));
  const staleExpectedFailures = expectedScenarios
    .filter((scenario) => !observedFailureSet.has(scenario))
    .sort(compareStrings);
  if (unexpectedFailures.length > 0 || staleExpectedFailures.length > 0) {
    const problems = [];
    if (unexpectedFailures.length > 0) {
      problems.push(`unexpected failures: ${unexpectedFailures.join(", ")}`);
    }
    if (staleExpectedFailures.length > 0) {
      problems.push(`stale expected failures: ${staleExpectedFailures.join(", ")}`);
    }
    throw new Error(`Conformance baseline mismatch (${problems.join("; ")}).`);
  }

  return {
    passedScenarios: normalizedResults
      .filter((result) => !observedFailureSet.has(result.scenario))
      .map((result) => result.scenario)
      .sort(compareStrings),
    expectedFailureScenarios: observedFailures,
  };
}

function copyOptionalString(check, target, property) {
  if (check[property] !== undefined) {
    if (typeof check[property] !== "string") {
      throw new Error(`Conformance check ${property} must be a string.`);
    }
    target[property] = check[property];
  }
}

export function sanitizeConformanceChecks(scenario, checks) {
  const normalized = validateResult({ scenario, checks }, 0);
  return {
    scenario: normalized.scenario,
    checks: normalized.checks.map((check) => {
      const sanitized = {
        id: check.id,
        status: check.status,
      };
      copyOptionalString(check, sanitized, "name");
      copyOptionalString(check, sanitized, "description");
      copyOptionalString(check, sanitized, "errorMessage");
      if (check.specReferences !== undefined) {
        if (!Array.isArray(check.specReferences)) {
          throw new Error("Conformance check specReferences must be an array.");
        }
        sanitized.specReferences = check.specReferences.map((reference) => {
          if (!isRecord(reference)) {
            throw new Error("Conformance check specReferences entries must be objects.");
          }
          return {
            id: requireNonEmptyString(reference.id, "check spec reference id"),
            url: requireNonEmptyString(reference.url, "check spec reference url"),
          };
        });
      }
      return sanitized;
    }),
  };
}

function scenarioFromDirectoryName(directoryName) {
  const match = /^server-(.+)-\d{4}-\d{2}-\d{2}T[\d-]+Z$/u.exec(directoryName);
  if (!match) {
    throw new Error(`Conformance output directory is not recognized: ${directoryName}.`);
  }
  return requireScenario(match[1]);
}

async function readConformanceResults(outputDirectory) {
  const entries = await fs.readdir(outputDirectory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scenario = scenarioFromDirectoryName(entry.name);
    const checksPath = path.join(outputDirectory, entry.name, "checks.json");
    const checks = JSON.parse(await fs.readFile(checksPath, "utf8"));
    results.push(validateResult({ scenario, checks }, results.length));
  }
  return results.sort((left, right) => compareStrings(left.scenario, right.scenario));
}

function captureInheritedSensitiveValues(environment) {
  return SENSITIVE_ENVIRONMENT_NAMES
    .map((name) => environment[name])
    .filter((value) => typeof value === "string" && value.length > 0);
}

async function verifyConformanceInstallation(projectRoot) {
  const packagePath = path.join(
    projectRoot,
    "tools",
    "conformance",
    "node_modules",
    "@modelcontextprotocol",
    "conformance",
    "package.json"
  );
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  if (packageJson.version !== CONFORMANCE_TOOL_VERSION) {
    throw new Error(
      `Expected @modelcontextprotocol/conformance ${CONFORMANCE_TOOL_VERSION}; ` +
      `found ${String(packageJson.version)}.`
    );
  }
  return path.join(path.dirname(packagePath), "dist", "index.js");
}

function assertTemporaryRoot(tempRoot) {
  const resolvedTempRoot = path.resolve(tempRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedSystemTemp, resolvedTempRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error("Conformance temporary directory escaped the system temp directory.");
  }
}

export async function runConformancePilot(projectRoot = DEFAULT_PROJECT_ROOT) {
  const conformanceCliPath = await verifyConformanceInstallation(projectRoot);
  const baselinePath = path.join(projectRoot, BASELINE_RELATIVE_PATH);
  const baseline = validateConformanceBaseline(
    JSON.parse(await fs.readFile(baselinePath, "utf8"))
  );
  const inheritedSensitiveValues = captureInheritedSensitiveValues(process.env);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-conformance-"));
  assertTemporaryRoot(tempRoot);
  const storageDirectory = path.join(tempRoot, "storage");
  const outputDirectory = path.join(tempRoot, "results");
  const expectedFailuresPath = path.join(tempRoot, "expected-failures.yml");
  let server;

  try {
    await fs.mkdir(storageDirectory, { recursive: true });
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(storageDirectory, "empty.env"), "", "utf8");
    await fs.writeFile(
      expectedFailuresPath,
      renderExpectedFailuresYaml(baseline.expectedFailures),
      "utf8"
    );
    const environment = createInspectorEnvironment({
      parentEnvironment: process.env,
      storageDirectory,
      harnessPath: HARNESS_PATH,
      networkMode: "loopback",
    });
    server = await startInspectorHttpServer({ projectRoot, environment });

    const child = spawnSync(process.execPath, [
      conformanceCliPath,
      "server",
      "--url",
      server.serverUrl,
      "--suite",
      CONFORMANCE_SUITE,
      "--spec-version",
      CONFORMANCE_PROTOCOL_VERSION,
      "--expected-failures",
      expectedFailuresPath,
      "--output-dir",
      outputDirectory,
      "--verbose",
    ], {
      cwd: tempRoot,
      encoding: "utf8",
      env: environment,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: RUN_TIMEOUT_MS,
      windowsHide: true,
    });
    const stdout = child.stdout ?? "";
    const stderr = child.stderr ?? "";
    assertInspectorOutputIsSafe(stdout, stderr, inheritedSensitiveValues);
    if (child.error !== undefined) {
      throw new Error(`Conformance process failed to start: ${child.error.message}`);
    }
    if (child.signal !== null) {
      throw new Error(`Conformance process ended with signal ${child.signal}.`);
    }
    if (child.status !== 0) {
      throw createConformanceExitError(child.status);
    }

    const results = await readConformanceResults(outputDirectory);
    if (results.length !== EXPECTED_SCENARIO_COUNT) {
      throw new Error(
        `Conformance active suite produced ${results.length} scenarios; ` +
        `expected ${EXPECTED_SCENARIO_COUNT}.`
      );
    }
    const classification = assertConformanceBaselineMatches(
      baseline.expectedFailures,
      results
    );
    await closeConformanceServerForSuccess(server);
    server = undefined;
    const artifact = {
      schemaVersion: 1,
      tool: {
        name: "@modelcontextprotocol/conformance",
        version: CONFORMANCE_TOOL_VERSION,
      },
      protocolVersion: CONFORMANCE_PROTOCOL_VERSION,
      suite: CONFORMANCE_SUITE,
      evidenceClass: "non_blocking_legacy_pilot",
      modernRequiredEvidence: "T3/T4 explicit @modelcontextprotocol/client 2.0.0",
      generatedAt: new Date().toISOString(),
      scenarioCount: results.length,
      passedScenarios: classification.passedScenarios,
      expectedFailures: baseline.expectedFailures,
      scenarios: results.map((result) =>
        sanitizeConformanceChecks(result.scenario, result.checks)
      ),
    };
    const artifactJson = `${JSON.stringify(artifact, null, 2)}\n`;
    assertInspectorOutputIsSafe(artifactJson, "", inheritedSensitiveValues);
    const artifactPath = path.join(projectRoot, ARTIFACT_RELATIVE_PATH);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, artifactJson, "utf8");

    return {
      toolVersion: CONFORMANCE_TOOL_VERSION,
      protocolVersion: CONFORMANCE_PROTOCOL_VERSION,
      suite: CONFORMANCE_SUITE,
      scenarioCount: results.length,
      passed: classification.passedScenarios.length,
      expectedFailures: classification.expectedFailureScenarios.length,
      artifact: path.relative(projectRoot, artifactPath).replaceAll(path.sep, "/"),
    };
  } finally {
    await server?.close().catch(() => undefined);
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function main() {
  const summary = await runConformancePilot();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({ error: { code: "conformance_pilot_failed", message } })}\n`
    );
    process.exitCode = 1;
  });
}

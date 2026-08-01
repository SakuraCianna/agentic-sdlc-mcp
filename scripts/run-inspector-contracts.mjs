import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createContractCollectorEnvironment } from "./lib/pinned-mcp-contract.mjs";

export const INSPECTOR_VERSION = "2.0.0";
export const INSPECTOR_PLACEHOLDER_TOKEN = "test-only-not-a-github-credential";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const INSPECTOR_PACKAGE_ROOT = path.join(
  DEFAULT_PROJECT_ROOT,
  "tools",
  "inspector",
  "node_modules",
  "@modelcontextprotocol",
  "inspector"
);
const INSPECTOR_PACKAGE_PATH = path.join(INSPECTOR_PACKAGE_ROOT, "package.json");
const INSPECTOR_LAUNCHER_PATH = path.join(
  INSPECTOR_PACKAGE_ROOT,
  "clients",
  "launcher",
  "build",
  "index.js"
);
const HARNESS_PATH = path.join(SCRIPT_DIRECTORY, "fixtures", "deny-external-fetch.mjs");
const INVOCATION_TIMEOUT_MS = 20_000;
const INVOCATION_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const REQUIRED_TOOL_NAMES = [
  "repo_context",
  "plan_from_context",
  "create_issue_set",
  "prepare_work_item",
  "quality_gate_status",
  "create_pr_summary",
  "review_pr_against_standard",
  "security_triage",
  "release_readiness_check",
  "agent_handoff_packet",
  "branch_protection_status",
  "workflow_permissions_audit",
  "sdlc_evidence_packet",
];
const REQUIRED_RESOURCE_URIS = [
  "sdlc://standards/agentic-sdlc",
  "sdlc://templates/issue",
  "sdlc://templates/pr-summary",
  "sdlc://templates/release-readiness",
  "sdlc://templates/handoff",
];
const CREDENTIAL_ENVIRONMENT_NAMES = [
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
];
const HOME_ENVIRONMENT_NAMES = [
  "APPDATA",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "USERPROFILE",
];
const SERVER_ENVIRONMENT_NAMES = [
  "CI",
  "DOTENV_CONFIG_PATH",
  "DOTENV_CONFIG_QUIET",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_TOKEN",
  "MCP_AUTO_OPEN_ENABLED",
  "MCP_CLIENT_CONFIG_PATH",
  "MCP_INSPECTOR_HARNESS_MARKER_PATH",
  "MCP_INSPECTOR_OAUTH_STATE_PATH",
  "MCP_STORAGE_DIR",
  "NODE_OPTIONS",
  "NO_COLOR",
];

function record(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Inspector JSON envelope must be an object.");
  }
  return value;
}

function nestedRecord(value, key) {
  return record(record(value)[key]);
}

function sortedStrings(values) {
  return [...values].sort((left, right) => left.localeCompare(right, "en"));
}

function assertEqualJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match the pinned contract.`);
  }
}

function captureCredentialCanaries(environment) {
  return CREDENTIAL_ENVIRONMENT_NAMES
    .map((name) => environment[name])
    .filter((value) => typeof value === "string" && value.length > 0);
}

export function createInspectorEnvironment({
  parentEnvironment = process.env,
  storageDirectory,
  harnessPath,
}) {
  const environment = createContractCollectorEnvironment(parentEnvironment);
  for (const name of HOME_ENVIRONMENT_NAMES) {
    const value = parentEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of CREDENTIAL_ENVIRONMENT_NAMES) delete environment[name];

  return {
    ...environment,
    CI: "true",
    DOTENV_CONFIG_PATH: path.join(storageDirectory, "empty.env"),
    DOTENV_CONFIG_QUIET: "true",
    GITHUB_OWNER: "inspector-fixture-owner",
    GITHUB_REPO: "inspector-fixture-repo",
    GITHUB_TOKEN: INSPECTOR_PLACEHOLDER_TOKEN,
    MCP_AUTO_OPEN_ENABLED: "false",
    MCP_CLIENT_CONFIG_PATH: path.join(storageDirectory, "client.json"),
    MCP_INSPECTOR_HARNESS_MARKER_PATH: path.join(
      storageDirectory,
      "server-harness.marker"
    ),
    MCP_INSPECTOR_OAUTH_STATE_PATH: path.join(storageDirectory, "oauth.json"),
    MCP_STORAGE_DIR: storageDirectory,
    NODE_OPTIONS: `--import=${pathToFileURL(harnessPath).href}`,
    NO_COLOR: "1",
  };
}

export function createInspectorStdioArguments({
  projectRoot,
  method,
  serverEnvironment,
  toolName,
  toolArguments,
  uri,
}) {
  const argumentsList = [
    "--cli",
    process.execPath,
    path.join(projectRoot, "dist", "index.js"),
    "--method",
    method,
    "--format",
    "json",
    "--cwd",
    projectRoot,
  ];
  for (const name of SERVER_ENVIRONMENT_NAMES) {
    const value = serverEnvironment[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`Inspector server environment is missing ${name}.`);
    }
    argumentsList.push("-e", `${name}=${value}`);
  }
  if (toolName !== undefined) argumentsList.push("--tool-name", toolName);
  if (toolArguments !== undefined) {
    argumentsList.push("--tool-args-json", JSON.stringify(toolArguments));
  }
  if (uri !== undefined) argumentsList.push("--uri", uri);
  return argumentsList;
}

export function parseInspectorJsonOutput(output) {
  if (output.trim().length === 0) throw new Error("Inspector emitted empty stdout.");
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Inspector must emit exactly one JSON object on stdout.");
  }
  return record(parsed);
}

export function assertInspectorOutputIsSafe(stdout, stderr, credentialCanaries = []) {
  const combined = `${stdout}\n${stderr}`;
  const canaries = [INSPECTOR_PLACEHOLDER_TOKEN, ...credentialCanaries]
    .filter((value) => value.length > 0);
  if (canaries.some((value) => combined.includes(value))) {
    throw new Error("Inspector output contained a credential canary.");
  }
}

function parseInspectorError(stderr) {
  for (const line of stderr.trim().split(/\r?\n/u).reverse()) {
    try {
      const parsed = record(JSON.parse(line));
      if ("error" in parsed) return nestedRecord(parsed, "error");
    } catch {
      // Server stderr is not a contract signal; only the JSON error envelope is.
    }
  }
  throw new Error("Inspector failure did not emit a JSON error envelope.");
}

function invokeInspector({
  environment,
  projectRoot,
  method,
  toolName,
  toolArguments,
  uri,
  credentialCanaries,
}) {
  const child = spawnSync(
    process.execPath,
    [INSPECTOR_LAUNCHER_PATH, ...createInspectorStdioArguments({
      projectRoot,
      method,
      serverEnvironment: environment,
      toolName,
      toolArguments,
      uri,
    })],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
      input: "",
      maxBuffer: INVOCATION_MAX_BUFFER_BYTES,
      timeout: INVOCATION_TIMEOUT_MS,
      windowsHide: true,
    }
  );
  const stdout = child.stdout ?? "";
  const stderr = child.stderr ?? "";
  assertInspectorOutputIsSafe(stdout, stderr, credentialCanaries);
  if (child.error) {
    throw new Error(`Inspector process failed before an exit code: ${child.error.message}`);
  }
  if (child.signal !== null) {
    throw new Error(`Inspector process ended by signal ${child.signal}.`);
  }
  return { exitCode: child.status ?? -1, stdout, stderr };
}

function requireSuccess(invocation, method) {
  if (invocation.exitCode !== 0) {
    const error = parseInspectorError(invocation.stderr);
    throw new Error(
      `Inspector ${method} exited ${invocation.exitCode} (${String(error.code ?? "unknown")}).`
    );
  }
  return nestedRecord(parseInspectorJsonOutput(invocation.stdout), "result");
}

function requireFailure(invocation, expectedExitCode, label, expectedToolError = false) {
  if (invocation.exitCode !== expectedExitCode) {
    throw new Error(`${label} exited ${invocation.exitCode}; expected ${expectedExitCode}.`);
  }
  if (expectedToolError) {
    const result = nestedRecord(parseInspectorJsonOutput(invocation.stdout), "result");
    if (result.isError !== true || "structuredContent" in result) {
      throw new Error(`${label} did not preserve the bounded MCP tool-error shape.`);
    }
  }
  const error = parseInspectorError(invocation.stderr);
  if (typeof error.code !== "string" || error.code.length === 0) {
    throw new Error(`${label} did not provide a stable machine-readable error code.`);
  }
  return error.code;
}

async function verifyInspectorInstallation() {
  const packageDocument = record(JSON.parse(await fs.readFile(INSPECTOR_PACKAGE_PATH, "utf8")));
  if (packageDocument.version !== INSPECTOR_VERSION) {
    throw new Error(
      `Inspector installation is ${String(packageDocument.version)}; expected ${INSPECTOR_VERSION}.`
    );
  }
}

export async function runInspectorStdioContracts(projectRoot = DEFAULT_PROJECT_ROOT) {
  await verifyInspectorInstallation();
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-inspector-"));
  const storageDirectory = path.join(fixtureRoot, "storage");
  const credentialCanaries = captureCredentialCanaries(process.env);
  try {
    await fs.mkdir(storageDirectory, { recursive: true });
    await fs.writeFile(path.join(storageDirectory, "empty.env"), "", "utf8");
    const environment = createInspectorEnvironment({
      parentEnvironment: process.env,
      storageDirectory,
      harnessPath: HARNESS_PATH,
    });
    const invoke = (options) => invokeInspector({
      environment,
      projectRoot,
      credentialCanaries,
      ...options,
    });

    const initialize = requireSuccess(invoke({ method: "initialize" }), "initialize");
    const harnessMarker = await fs.readFile(
      path.join(storageDirectory, "server-harness.marker"),
      "utf8"
    );
    if (harnessMarker !== "server-harness-loaded\n") {
      throw new Error("Inspector target did not load the fail-closed server harness.");
    }
    const serverInfo = nestedRecord(initialize, "serverInfo");
    const packageDocument = record(
      JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"))
    );
    if (serverInfo.name !== "agentic-sdlc-mcp" || serverInfo.version !== packageDocument.version) {
      throw new Error("Inspector initialize returned unexpected server identity or version.");
    }
    if (initialize.protocolVersion !== "2025-11-25") {
      throw new Error("Inspector initialize did not negotiate the pinned legacy protocol version.");
    }

    const toolResult = requireSuccess(invoke({ method: "tools/list" }), "tools/list");
    if (!Array.isArray(toolResult.tools)) throw new Error("Inspector tools/list omitted tools.");
    const toolNames = sortedStrings(toolResult.tools.map((tool) => String(record(tool).name)));
    assertEqualJson(toolNames, sortedStrings(REQUIRED_TOOL_NAMES), "Inspector tool names");

    const resourceResult = requireSuccess(
      invoke({ method: "resources/list" }),
      "resources/list"
    );
    if (!Array.isArray(resourceResult.resources)) {
      throw new Error("Inspector resources/list omitted resources.");
    }
    const resourceUris = sortedStrings(
      resourceResult.resources.map((resource) => String(record(resource).uri))
    );
    assertEqualJson(
      resourceUris,
      sortedStrings(REQUIRED_RESOURCE_URIS),
      "Inspector resource URIs"
    );

    for (const uri of REQUIRED_RESOURCE_URIS) {
      const readResult = requireSuccess(
        invoke({ method: "resources/read", uri }),
        `resources/read ${uri}`
      );
      if (!Array.isArray(readResult.contents) || readResult.contents.length === 0) {
        throw new Error(`Inspector resources/read returned no content for ${uri}.`);
      }
      const firstContent = record(readResult.contents[0]);
      if (
        firstContent.uri !== uri ||
        firstContent.mimeType !== "text/markdown" ||
        typeof firstContent.text !== "string" ||
        firstContent.text.length === 0
      ) {
        throw new Error(`Inspector resources/read returned an invalid payload for ${uri}.`);
      }
    }

    const preview = requireSuccess(
      invoke({
        method: "tools/call",
        toolName: "create_issue_set",
        toolArguments: {
          owner: "inspector-fixture-owner",
          repo: "inspector-fixture-repo",
          dryRun: true,
          issues: [{
            title: "Inspector contract preview",
            body: "Verify a deterministic preview without any GitHub write request.",
            labels: ["testing"],
          }],
        },
      }),
      "tools/call create_issue_set"
    );
    const structuredPreview = nestedRecord(preview, "structuredContent");
    if (
      structuredPreview.dryRun !== true ||
      structuredPreview.targetRepo !== "inspector-fixture-owner/inspector-fixture-repo" ||
      !Array.isArray(structuredPreview.preview) ||
      structuredPreview.preview.length !== 1 ||
      !Array.isArray(structuredPreview.issues) ||
      structuredPreview.issues.length !== 0
    ) {
      throw new Error("Inspector create_issue_set did not remain a zero-write dry-run preview.");
    }

    const invalidSchemaCode = requireFailure(
      invoke({
        method: "tools/call",
        toolName: "create_issue_set",
        toolArguments: { dryRun: true, issues: "not-an-array" },
      }),
      5,
      "Inspector invalid-schema call",
      true
    );
    const unknownResourceCode = requireFailure(
      invoke({ method: "resources/read", uri: "sdlc://missing/inspector-contract" }),
      1,
      "Inspector unknown-resource read"
    );
    if (invalidSchemaCode !== "tool_is_error" || unknownResourceCode !== "error") {
      throw new Error("Inspector negative cases changed their machine-readable error codes.");
    }

    return {
      inspectorVersion: INSPECTOR_VERSION,
      serverVersion: String(serverInfo.version),
      protocolVersion: String(initialize.protocolVersion),
      transport: "stdio",
      tools: toolNames.length,
      resources: resourceUris.length,
      resourcesRead: REQUIRED_RESOURCE_URIS.length,
      dryRun: true,
      createdIssues: structuredPreview.issues.length,
      failureExitCodes: {
        invalidSchema: 5,
        unknownResource: 1,
      },
      failureCodes: {
        invalidSchema: invalidSchemaCode,
        unknownResource: unknownResourceCode,
      },
    };
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function main() {
  const summary = await runInspectorStdioContracts();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

const isMain = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: { code: "inspector_contract_failed", message } })}\n`);
    process.exitCode = 1;
  });
}

import { fork, spawnSync } from "node:child_process";
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
const HTTP_SERVER_FIXTURE_PATH = path.join(
  SCRIPT_DIRECTORY,
  "fixtures",
  "run-inspector-http-server.mjs"
);
const AUTH_CHALLENGE_FIXTURE_PATH = path.join(
  SCRIPT_DIRECTORY,
  "fixtures",
  "run-inspector-auth-challenge-server.mjs"
);
const INVOCATION_TIMEOUT_MS = 20_000;
const INVOCATION_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const HTTP_SERVER_START_TIMEOUT_MS = 5_000;
const HTTP_SERVER_CLOSE_TIMEOUT_MS = 5_000;
const HTTP_SERVER_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const WINDOWS_INSPECTOR_ABORT_EXIT_CODE = 0xc0000409;
const WINDOWS_INSPECTOR_CLOSING_ASSERTION =
  "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94";
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
const SENSITIVE_ENVIRONMENT_NAMES = [
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
  "MCP_INSPECTOR_NETWORK_MODE",
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

function captureInheritedSensitiveValues(environment) {
  return SENSITIVE_ENVIRONMENT_NAMES
    .map((name) => environment[name])
    .filter((value) => typeof value === "string" && value.length > 0);
}

export function createInspectorEnvironment({
  parentEnvironment = process.env,
  storageDirectory,
  harnessPath,
  networkMode = "deny",
}) {
  if (networkMode !== "deny" && networkMode !== "loopback") {
    throw new Error("Inspector network mode must be deny or loopback.");
  }
  const environment = createContractCollectorEnvironment(parentEnvironment);
  for (const name of HOME_ENVIRONMENT_NAMES) {
    const value = parentEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of SENSITIVE_ENVIRONMENT_NAMES) delete environment[name];

  return {
    ...environment,
    CI: "true",
    DOTENV_CONFIG_PATH: path.join(storageDirectory, "empty.env"),
    DOTENV_CONFIG_QUIET: "true",
    GITHUB_OWNER: "inspector-fixture-owner",
    GITHUB_REPO: "inspector-fixture-repo",
    GITHUB_TOKEN: "test-only-not-a-github-credential",
    MCP_AUTO_OPEN_ENABLED: "false",
    MCP_CLIENT_CONFIG_PATH: path.join(storageDirectory, "client.json"),
    MCP_INSPECTOR_HARNESS_MARKER_PATH: path.join(
      storageDirectory,
      "server-harness.marker"
    ),
    MCP_INSPECTOR_NETWORK_MODE: networkMode,
    MCP_INSPECTOR_OAUTH_STATE_PATH: path.join(storageDirectory, "oauth.json"),
    MCP_STORAGE_DIR: storageDirectory,
    NODE_OPTIONS: `--import=${pathToFileURL(harnessPath).href}`,
    NO_COLOR: "1",
  };
}

function appendInspectorOperationArguments(
  argumentsList,
  { method, toolName, toolArguments, uri }
) {
  argumentsList.push("--method", method, "--format", "json");
  if (toolName !== undefined) argumentsList.push("--tool-name", toolName);
  if (toolArguments !== undefined) {
    argumentsList.push("--tool-args-json", JSON.stringify(toolArguments));
  }
  if (uri !== undefined) argumentsList.push("--uri", uri);
  return argumentsList;
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
  return appendInspectorOperationArguments(argumentsList, {
    method,
    toolName,
    toolArguments,
    uri,
  });
}

export function createInspectorHttpArguments({
  serverUrl,
  method,
  toolName,
  toolArguments,
  uri,
}) {
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error("Inspector HTTP target must be a canonical loopback MCP URL.");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port.length === 0 ||
    parsed.pathname !== "/mcp" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.href !== `http://127.0.0.1:${parsed.port}/mcp`
  ) {
    throw new Error("Inspector HTTP target must be a canonical loopback MCP URL.");
  }

  return appendInspectorOperationArguments(
    ["--cli", parsed.href, "--transport", "http", "--stored-auth-only"],
    { method, toolName, toolArguments, uri }
  );
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

export function assertInspectorOutputIsSafe(stdout, stderr, inheritedSensitiveValues = []) {
  const combined = `${stdout}\n${stderr}`;
  const canaries = [INSPECTOR_PLACEHOLDER_TOKEN, ...inheritedSensitiveValues]
    .filter((value) => value.length > 0);
  if (canaries.some((value) => combined.includes(value))) {
    throw new Error("Inspector output contained a credential canary.");
  }
}

export function createInspectorDeadline(milliseconds, message) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error("Inspector deadline must be a positive integer.");
  }
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return {
    promise,
    cancel() {
      clearTimeout(timer);
    },
  };
}

async function startInspectorLoopbackFixture({
  projectRoot,
  environment,
  fixturePath,
}) {
  const inheritedSensitiveValues = captureInheritedSensitiveValues(process.env);
  const child = fork(fixturePath, [], {
    cwd: projectRoot,
    env: environment,
    execArgv: [],
    execPath: process.execPath,
    silent: true,
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let outputError;
  const appendOutput = (current, chunk, label) => {
    const next = current + String(chunk);
    if (Buffer.byteLength(next, "utf8") > HTTP_SERVER_OUTPUT_LIMIT_BYTES) {
      outputError ??= new Error(`Inspector HTTP ${label} exceeded its output limit.`);
      child.kill();
    }
    return next;
  };
  child.stdout?.on("data", (chunk) => {
    stdout = appendOutput(stdout, chunk, "stdout");
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendOutput(stderr, chunk, "stderr");
  });
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let ready;
  const startupDeadline = createInspectorDeadline(
    HTTP_SERVER_START_TIMEOUT_MS,
    "Inspector HTTP fixture timed out before listening."
  );
  try {
    ready = await Promise.race([
      new Promise((resolve, reject) => {
        const onMessage = (message) => {
          if (
            typeof message === "object" &&
            message !== null &&
            message.type === "ready" &&
            message.host === "127.0.0.1" &&
            Number.isSafeInteger(message.port) &&
            message.port > 0 &&
            message.port <= 65_535
          ) {
            cleanup();
            resolve(message);
            return;
          }
          if (typeof message === "object" && message !== null && message.type === "error") {
            cleanup();
            reject(new Error("Inspector HTTP fixture reported a bounded startup error."));
          }
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(
            `Inspector HTTP fixture exited before ready (${String(code)}, ${String(signal)}).`
          ));
        };
        const cleanup = () => {
          child.off("message", onMessage);
          child.off("error", onError);
          child.off("exit", onExit);
        };
        child.on("message", onMessage);
        child.once("error", onError);
        child.once("exit", onExit);
      }),
      startupDeadline.promise,
    ]);
  } catch (error) {
    child.kill();
    await exit;
    assertInspectorOutputIsSafe(stdout, stderr, inheritedSensitiveValues);
    throw outputError ?? error;
  } finally {
    startupDeadline.cancel();
  }
  assertInspectorOutputIsSafe(stdout, stderr, inheritedSensitiveValues);
  if (outputError) throw outputError;

  let closePromise;
  const close = () => {
    closePromise ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.send({ type: "close" });
        } catch {
          child.kill();
        }
      }
      let result;
      const closeDeadline = createInspectorDeadline(
        HTTP_SERVER_CLOSE_TIMEOUT_MS,
        "Inspector HTTP fixture timed out while closing."
      );
      try {
        result = await Promise.race([
          exit,
          closeDeadline.promise,
        ]);
      } catch (error) {
        child.kill();
        await exit;
        throw error;
      } finally {
        closeDeadline.cancel();
        assertInspectorOutputIsSafe(stdout, stderr, inheritedSensitiveValues);
      }
      if (outputError) throw outputError;
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(
          `Inspector HTTP fixture closed unexpectedly (${String(result.code)}, ${String(result.signal)}).`
        );
      }
    })();
    return closePromise;
  };

  return {
    serverUrl: `http://127.0.0.1:${ready.port}/mcp`,
    close,
  };
}

export function startInspectorHttpServer(options) {
  return startInspectorLoopbackFixture({
    ...options,
    fixturePath: HTTP_SERVER_FIXTURE_PATH,
  });
}

export function startInspectorAuthChallengeServer(options) {
  return startInspectorLoopbackFixture({
    ...options,
    fixturePath: AUTH_CHALLENGE_FIXTURE_PATH,
  });
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

export function classifyInspectorFailure({
  exitCode,
  stderr,
  expectedExitCode,
  expectedErrorCode,
  platform = process.platform,
  label,
}) {
  const error = parseInspectorError(stderr);
  if (error.code !== expectedErrorCode) {
    throw new Error(
      `${label} returned ${String(error.code ?? "unknown")}; expected ${expectedErrorCode}.`
    );
  }
  if (exitCode === expectedExitCode) {
    return { code: expectedErrorCode, exitClass: "expected", rawExitCode: exitCode };
  }

  const lines = stderr.trim().split(/\r?\n/u);
  let exactWindowsEnvelope = false;
  if (lines.length === 2 && lines[1] === WINDOWS_INSPECTOR_CLOSING_ASSERTION) {
    try {
      const envelope = record(JSON.parse(lines[0]));
      const envelopeKeys = Object.keys(envelope);
      const envelopeError = nestedRecord(envelope, "error");
      const errorKeys = Object.keys(envelopeError);
      exactWindowsEnvelope =
        envelopeKeys.length === 1 &&
        envelopeKeys[0] === "error" &&
        envelopeError.code === expectedErrorCode &&
        typeof envelopeError.message === "string" &&
        envelopeError.message.length > 0 &&
        errorKeys.every((key) => ["cause", "code", "message"].includes(key)) &&
        (envelopeError.cause === undefined || typeof envelopeError.cause === "string");
    } catch {
      exactWindowsEnvelope = false;
    }
  }
  if (
    platform === "win32" &&
    exitCode === WINDOWS_INSPECTOR_ABORT_EXIT_CODE &&
    exactWindowsEnvelope
  ) {
    return {
      code: expectedErrorCode,
      exitClass: "known_windows_inspector_abort",
      rawExitCode: exitCode,
    };
  }
  throw new Error(`${label} exited ${exitCode}; expected ${expectedExitCode}.`);
}

function invokeInspector({
  environment,
  projectRoot,
  transport = "stdio",
  serverUrl,
  method,
  toolName,
  toolArguments,
  uri,
  inheritedSensitiveValues,
}) {
  const inspectorArguments = transport === "http"
    ? createInspectorHttpArguments({
        serverUrl,
        method,
        toolName,
        toolArguments,
        uri,
      })
    : createInspectorStdioArguments({
        projectRoot,
        method,
        serverEnvironment: environment,
        toolName,
        toolArguments,
        uri,
      });
  const child = spawnSync(
    process.execPath,
    [INSPECTOR_LAUNCHER_PATH, ...inspectorArguments],
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
  assertInspectorOutputIsSafe(stdout, stderr, inheritedSensitiveValues);
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

function requireFailure(
  invocation,
  expectedExitCode,
  expectedErrorCode,
  label,
  expectedToolError = false
) {
  if (expectedToolError) {
    const result = nestedRecord(parseInspectorJsonOutput(invocation.stdout), "result");
    if (result.isError !== true || "structuredContent" in result) {
      throw new Error(`${label} did not preserve the bounded MCP tool-error shape.`);
    }
  }
  return classifyInspectorFailure({
    exitCode: invocation.exitCode,
    stderr: invocation.stderr,
    expectedExitCode,
    expectedErrorCode,
    label,
  });
}

function normalizeInspectorJson(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeInspectorJson(item, `${label}[${index}]`));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareInspectorKeys(left, right))
        .map(([key, item]) => [key, normalizeInspectorJson(item, `${label}.${key}`)])
    );
  }
  throw new Error(`${label} contained a non-JSON value.`);
}

function compareInspectorKeys(left, right) {
  return left.localeCompare(right, "en");
}

export function normalizeInspectorDiscovery(toolResult, resourceResult) {
  const toolsEnvelope = record(toolResult);
  const resourcesEnvelope = record(resourceResult);
  if (!Array.isArray(toolsEnvelope.tools)) {
    throw new Error("Inspector tools/list omitted tools.");
  }
  if (!Array.isArray(resourcesEnvelope.resources)) {
    throw new Error("Inspector resources/list omitted resources.");
  }
  const tools = toolsEnvelope.tools
    .map((tool, index) => normalizeInspectorJson(record(tool), `tools[${index}]`))
    .sort((left, right) => compareInspectorKeys(String(left.name), String(right.name)));
  const resources = resourcesEnvelope.resources
    .map((resource, index) =>
      normalizeInspectorJson(record(resource), `resources[${index}]`)
    )
    .sort((left, right) => compareInspectorKeys(String(left.uri), String(right.uri)));
  return { tools, resources };
}

export function assertInspectorDiscoveryMatches(actual, expected) {
  assertEqualJson(actual, expected, "Inspector complete tools/resources JSON");
}

function collectInspectorDiscovery(invoke) {
  return normalizeInspectorDiscovery(
    requireSuccess(invoke({ method: "tools/list" }), "tools/list"),
    requireSuccess(invoke({ method: "resources/list" }), "resources/list")
  );
}

async function verifyInspectorInstallation() {
  const packageDocument = record(JSON.parse(await fs.readFile(INSPECTOR_PACKAGE_PATH, "utf8")));
  if (packageDocument.version !== INSPECTOR_VERSION) {
    throw new Error(
      `Inspector installation is ${String(packageDocument.version)}; expected ${INSPECTOR_VERSION}.`
    );
  }
}

async function runInspectorContractOperations({
  projectRoot,
  transport,
  markerPath,
  invoke,
}) {
  const initialize = requireSuccess(invoke({ method: "initialize" }), "initialize");
  const harnessMarker = await fs.readFile(markerPath, "utf8");
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

  const discovery = collectInspectorDiscovery(invoke);
  const toolNames = sortedStrings(discovery.tools.map((tool) => String(record(tool).name)));
  assertEqualJson(toolNames, sortedStrings(REQUIRED_TOOL_NAMES), "Inspector tool names");

  const resourceUris = sortedStrings(
    discovery.resources.map((resource) => String(record(resource).uri))
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

  const invalidSchemaFailure = requireFailure(
    invoke({
      method: "tools/call",
      toolName: "create_issue_set",
      toolArguments: { dryRun: true, issues: "not-an-array" },
    }),
    5,
    "tool_is_error",
    "Inspector invalid-schema call",
    true
  );

  return {
    discovery,
    summary: {
      inspectorVersion: INSPECTOR_VERSION,
      serverVersion: String(serverInfo.version),
      protocolVersion: String(initialize.protocolVersion),
      transport,
      tools: toolNames.length,
      resources: resourceUris.length,
      resourcesRead: REQUIRED_RESOURCE_URIS.length,
      dryRun: true,
      createdIssues: structuredPreview.issues.length,
      failureExitCodes: {
        invalidSchema: 5,
      },
      failureCodes: {
        invalidSchema: invalidSchemaFailure.code,
      },
      failureRawExitCodes: {
        invalidSchema: invalidSchemaFailure.rawExitCode,
      },
      failureExitClasses: {
        invalidSchema: invalidSchemaFailure.exitClass,
      },
    },
  };
}

export function parseInspectorRunnerArguments(argumentsList) {
  let transport = "stdio";
  let repeat = 1;
  let sawTransport = false;
  let sawRepeat = false;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--transport" && !sawTransport) {
      transport = argumentsList[index + 1];
      sawTransport = true;
      index += 1;
      continue;
    }
    if (argument === "--repeat" && !sawRepeat) {
      repeat = Number(argumentsList[index + 1]);
      sawRepeat = true;
      index += 1;
      continue;
    }
    throw new Error("Inspector runner arguments are invalid.");
  }
  if (
    (transport !== "stdio" && transport !== "http") ||
    !Number.isSafeInteger(repeat) ||
    repeat < 1 ||
    repeat > 10
  ) {
    throw new Error("Inspector runner arguments are invalid.");
  }
  return { transport, repeat };
}

async function createInspectorFixtureEnvironment(networkMode) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-inspector-"));
  const storageDirectory = path.join(fixtureRoot, "storage");
  await fs.mkdir(storageDirectory, { recursive: true });
  await fs.writeFile(path.join(storageDirectory, "empty.env"), "", "utf8");
  return {
    fixtureRoot,
    storageDirectory,
    markerPath: path.join(storageDirectory, "server-harness.marker"),
    environment: createInspectorEnvironment({
      parentEnvironment: process.env,
      storageDirectory,
      harnessPath: HARNESS_PATH,
      networkMode,
    }),
  };
}

async function collectIndependentInspectorStdioDiscovery(projectRoot) {
  const fixture = await createInspectorFixtureEnvironment("deny");
  const inheritedSensitiveValues = captureInheritedSensitiveValues(process.env);
  try {
    const invoke = (options) => invokeInspector({
      environment: fixture.environment,
      projectRoot,
      inheritedSensitiveValues,
      ...options,
    });
    const discovery = collectInspectorDiscovery(invoke);
    const marker = await fs.readFile(fixture.markerPath, "utf8");
    if (marker !== "server-harness-loaded\nserver-harness-loaded\n") {
      throw new Error("Inspector stdio parity targets did not load the server harness.");
    }
    return discovery;
  } finally {
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function verifyInspectorStoredAuthOnly(projectRoot) {
  const fixture = await createInspectorFixtureEnvironment("loopback");
  const inheritedSensitiveValues = captureInheritedSensitiveValues(process.env);
  const requestMarkerPath = path.join(fixture.storageDirectory, "auth-request.marker");
  const browserMarkerPath = path.join(fixture.storageDirectory, "browser-attempt.marker");
  const environment = {
    ...fixture.environment,
    MCP_AUTO_OPEN_ENABLED: "true",
    MCP_INSPECTOR_AUTH_CHALLENGE_MARKER_PATH: requestMarkerPath,
    MCP_INSPECTOR_BROWSER_ATTEMPT_MARKER_PATH: browserMarkerPath,
  };
  let server;
  try {
    server = await startInspectorAuthChallengeServer({ projectRoot, environment });
    const invocation = invokeInspector({
      environment,
      projectRoot,
      transport: "http",
      serverUrl: server.serverUrl,
      method: "initialize",
      inheritedSensitiveValues,
    });
    const failure = requireFailure(
      invocation,
      3,
      "auth_required",
      "Inspector stored-auth-only challenge"
    );
    const requestMarker = await fs.readFile(requestMarkerPath, "utf8");
    if (!requestMarker.includes("auth-required")) {
      throw new Error("Inspector auth fixture did not observe the challenge request.");
    }
    try {
      await fs.access(browserMarkerPath);
      throw new Error("Inspector stored-auth-only attempted to launch a browser process.");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await server.close();
    server = undefined;
    return failure;
  } finally {
    await server?.close().catch(() => undefined);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function runInspectorStdioContracts(projectRoot = DEFAULT_PROJECT_ROOT) {
  await verifyInspectorInstallation();
  const fixture = await createInspectorFixtureEnvironment("deny");
  const inheritedSensitiveValues = captureInheritedSensitiveValues(process.env);
  try {
    const invoke = (options) => invokeInspector({
      environment: fixture.environment,
      projectRoot,
      inheritedSensitiveValues,
      ...options,
    });
    const { summary } = await runInspectorContractOperations({
      projectRoot,
      transport: "stdio",
      markerPath: fixture.markerPath,
      invoke,
    });
    const unknownResourceFailure = requireFailure(
      invoke({ method: "resources/read", uri: "sdlc://missing/inspector-contract" }),
      1,
      "error",
      "Inspector unknown-resource read"
    );
    return {
      ...summary,
      failureExitCodes: {
        ...summary.failureExitCodes,
        unknownResource: 1,
      },
      failureCodes: {
        ...summary.failureCodes,
        unknownResource: unknownResourceFailure.code,
      },
      failureRawExitCodes: {
        ...summary.failureRawExitCodes,
        unknownResource: unknownResourceFailure.rawExitCode,
      },
      failureExitClasses: {
        ...summary.failureExitClasses,
        unknownResource: unknownResourceFailure.exitClass,
      },
    };
  } finally {
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

export async function runInspectorHttpContracts(projectRoot = DEFAULT_PROJECT_ROOT) {
  await verifyInspectorInstallation();
  const fixture = await createInspectorFixtureEnvironment("loopback");
  const inheritedSensitiveValues = captureInheritedSensitiveValues(process.env);
  let server;
  try {
    server = await startInspectorHttpServer({
      projectRoot,
      environment: fixture.environment,
    });
    const invoke = (options) => invokeInspector({
      environment: fixture.environment,
      projectRoot,
      transport: "http",
      serverUrl: server.serverUrl,
      inheritedSensitiveValues,
      ...options,
    });
    const { discovery, summary } = await runInspectorContractOperations({
      projectRoot,
      transport: "http",
      markerPath: fixture.markerPath,
      invoke,
    });
    const stdioDiscovery = await collectIndependentInspectorStdioDiscovery(projectRoot);
    assertInspectorDiscoveryMatches(discovery, stdioDiscovery);
    const unknownToolFailure = requireFailure(
      invoke({
        method: "tools/call",
        toolName: "missing_contract_tool",
        toolArguments: {},
      }),
      5,
      "tool_not_found",
      "Inspector unknown-tool call"
    );
    await server.close();
    const connectionFailure = requireFailure(
      invoke({ method: "initialize" }),
      4,
      "unreachable",
      "Inspector closed-listener connection"
    );
    const authRequiredFailure = await verifyInspectorStoredAuthOnly(projectRoot);
    return {
      ...summary,
      discoveryParity: "complete_tools_resources_json",
      failureExitCodes: {
        ...summary.failureExitCodes,
        unknownTool: 5,
        connectionFailure: 4,
        authRequired: 3,
      },
      failureCodes: {
        ...summary.failureCodes,
        unknownTool: unknownToolFailure.code,
        connectionFailure: connectionFailure.code,
        authRequired: authRequiredFailure.code,
      },
      failureRawExitCodes: {
        ...summary.failureRawExitCodes,
        unknownTool: unknownToolFailure.rawExitCode,
        connectionFailure: connectionFailure.rawExitCode,
        authRequired: authRequiredFailure.rawExitCode,
      },
      failureExitClasses: {
        ...summary.failureExitClasses,
        unknownTool: unknownToolFailure.exitClass,
        connectionFailure: connectionFailure.exitClass,
        authRequired: authRequiredFailure.exitClass,
      },
    };
  } finally {
    await server?.close().catch(() => undefined);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function main() {
  const options = parseInspectorRunnerArguments(process.argv.slice(2));
  const run = options.transport === "http"
    ? runInspectorHttpContracts
    : runInspectorStdioContracts;
  let summary;
  for (let index = 0; index < options.repeat; index += 1) {
    summary = await run();
  }
  process.stdout.write(`${JSON.stringify({ ...summary, runs: options.repeat })}\n`);
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

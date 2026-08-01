import childProcess from "node:child_process";
import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net, { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_CREDENTIAL_NAMES = [
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
];

for (const name of GITHUB_CREDENTIAL_NAMES) delete process.env[name];
process.env.GITHUB_TOKEN = "test-only-not-a-github-credential";
process.env.GITHUB_OWNER = "inspector-fixture-owner";
process.env.GITHUB_REPO = "inspector-fixture-repo";
process.env.DOTENV_CONFIG_QUIET = "true";

const markerPath = process.env.MCP_INSPECTOR_HARNESS_MARKER_PATH;
const entryPath = process.argv[1];
const isProductStdioEntry = entryPath &&
  path.basename(entryPath) === "index.js" &&
  path.basename(path.dirname(path.resolve(entryPath))) === "dist";
const isHttpFixtureEntry = entryPath &&
  path.basename(entryPath) === "run-inspector-http-server.mjs";
if (markerPath && (isProductStdioEntry || isHttpFixtureEntry)) {
  fsSync.appendFileSync(markerPath, "server-harness-loaded\n", "utf8");
}

function comparablePath(value) {
  try {
    const asPath = value instanceof URL ? fileURLToPath(value) : String(value);
    const resolved = path.resolve(asPath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return "";
  }
}

// The production config loader may probe this file even when explicit
// environment values are present. Contract runs must not read or chmod it.
const blockedConfigPath = comparablePath(
  path.join(os.homedir(), ".agentic-sdlc-mcp.json")
);
const originalExistsSync = fsSync.existsSync.bind(fsSync);
fsSync.existsSync = (candidate) => {
  if (comparablePath(candidate) === blockedConfigPath) return false;
  return originalExistsSync(candidate);
};

function normalizeConnectionArguments(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

function isIpcConnection(args) {
  const normalized = normalizeConnectionArguments(args);
  const first = normalized[0];
  if (typeof first === "object" && first !== null) {
    return "path" in first && first.path !== undefined;
  }
  return typeof first === "string";
}

const networkMode = process.env.MCP_INSPECTOR_NETWORK_MODE === "loopback"
  ? "loopback"
  : "deny";

function isExactLoopbackConnection(args) {
  const normalized = normalizeConnectionArguments(args);
  const first = normalized[0];
  if (typeof first === "object" && first !== null) {
    const host = "host" in first ? first.host : first.hostname;
    return host === "127.0.0.1";
  }
  return typeof first === "number" && normalized[1] === "127.0.0.1";
}

function assertAllowedConnection(args) {
  if (isIpcConnection(args)) return;
  if (networkMode === "loopback" && isExactLoopbackConnection(args)) return;
  if (networkMode === "deny") {
    throw new Error("Network access is disabled in Inspector stdio contracts.");
  }
  throw new Error(
    "Only exact 127.0.0.1 loopback network access is allowed in Inspector HTTP contracts."
  );
}

function isExactLoopbackFetch(input) {
  try {
    const candidate = input instanceof Request ? input.url : input;
    const target = new URL(candidate);
    return target.protocol === "http:" && target.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  if (networkMode === "loopback" && isExactLoopbackFetch(input)) {
    return originalFetch(input, init);
  }
  const message = networkMode === "deny"
    ? "Network access is disabled in Inspector stdio contracts."
    : "Only exact 127.0.0.1 loopback network access is allowed in Inspector HTTP contracts.";
  return Promise.reject(new Error(message));
};

const originalSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function guardedSocketConnect(...args) {
  assertAllowedConnection(args);
  return Reflect.apply(originalSocketConnect, this, args);
};

const originalCreateConnection = net.createConnection.bind(net);
net.createConnection = (...args) => {
  assertAllowedConnection(args);
  return originalCreateConnection(...args);
};
net.connect = net.createConnection;

const browserAttemptMarkerPath = process.env.MCP_INSPECTOR_BROWSER_ATTEMPT_MARKER_PATH;
if (browserAttemptMarkerPath) {
  childProcess.spawn = () => {
    fsSync.appendFileSync(browserAttemptMarkerPath, "spawn-blocked\n", "utf8");
    throw new Error("Browser processes are disabled in Inspector auth contracts.");
  };
}
syncBuiltinESMExports();

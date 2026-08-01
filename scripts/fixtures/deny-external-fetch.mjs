import fsSync from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net, { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLACEHOLDER_TOKEN = "test-only-not-a-github-credential";
const GITHUB_CREDENTIAL_NAMES = [
  "GH_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
];

for (const name of GITHUB_CREDENTIAL_NAMES) delete process.env[name];
process.env.GITHUB_TOKEN = PLACEHOLDER_TOKEN;
process.env.GITHUB_OWNER = "inspector-fixture-owner";
process.env.GITHUB_REPO = "inspector-fixture-repo";
process.env.DOTENV_CONFIG_QUIET = "true";

const markerPath = process.env.MCP_INSPECTOR_HARNESS_MARKER_PATH;
const entryPath = process.argv[1];
if (
  markerPath &&
  entryPath &&
  path.basename(entryPath) === "index.js" &&
  path.basename(path.dirname(path.resolve(entryPath))) === "dist"
) {
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

function isIpcConnection(args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    return "path" in first && first.path !== undefined;
  }
  return typeof first === "string";
}

function assertNoTcpConnection(args) {
  if (!isIpcConnection(args)) {
    throw new Error("Network access is disabled in Inspector stdio contracts.");
  }
}

globalThis.fetch = () =>
  Promise.reject(new Error("Network access is disabled in Inspector stdio contracts."));

const originalSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function guardedSocketConnect(...args) {
  assertNoTcpConnection(args);
  return Reflect.apply(originalSocketConnect, this, args);
};

const originalCreateConnection = net.createConnection.bind(net);
net.createConnection = (...args) => {
  assertNoTcpConnection(args);
  return originalCreateConnection(...args);
};
net.connect = net.createConnection;
syncBuiltinESMExports();

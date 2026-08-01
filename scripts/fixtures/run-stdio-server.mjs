import os from "node:os";
import path from "node:path";
import { Socket } from "node:net";

const expectedHome = process.env.MCP_TEST_HOME;
if (!expectedHome || path.resolve(os.homedir()) !== path.resolve(expectedHome)) {
  throw new Error("stdio fixture did not start with its isolated test home");
}

const forbiddenEnvironmentNames = [
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NODE_OPTIONS",
  "DOTENV_CONFIG_PATH",
].filter((name) => process.env[name] !== undefined);
if (forbiddenEnvironmentNames.length > 0) {
  throw new Error(
    `stdio fixture inherited forbidden environment names: ${forbiddenEnvironmentNames.join(", ")}`
  );
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!isLoopback(url.hostname)) {
    return Promise.reject(new Error(`External network access is disabled: ${url.hostname}`));
  }
  return originalFetch(input, init);
};

const originalSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  const hostname =
    typeof first === "object" && first !== null && "host" in first
      ? String(first.host ?? "localhost")
      : typeof first === "number" && typeof args[1] === "string"
        ? args[1]
        : "localhost";
  if (!isLoopback(hostname)) {
    throw new Error(`External socket access is disabled: ${hostname}`);
  }
  return Reflect.apply(originalSocketConnect, this, args);
};

process.env.GITHUB_TOKEN = "placeholder-stdio-github-token";
process.env.DOTENV_CONFIG_PATH = path.join(expectedHome, "empty.env");
process.env.DOTENV_CONFIG_QUIET = "true";

await import("../../dist/index.js");

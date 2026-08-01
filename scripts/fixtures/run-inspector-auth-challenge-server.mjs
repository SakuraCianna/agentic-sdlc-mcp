import { once } from "node:events";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";

const LOOPBACK_HOST = "127.0.0.1";

let listener;
let closePromise;

function requireContainedMarkerPath() {
  const storageDirectory = path.resolve(process.env.MCP_STORAGE_DIR ?? "");
  const markerPath = path.resolve(
    process.env.MCP_INSPECTOR_AUTH_CHALLENGE_MARKER_PATH ?? ""
  );
  const relative = path.relative(storageDirectory, markerPath);
  if (
    storageDirectory.length === 0 ||
    markerPath.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.length === 0
  ) {
    throw new Error("Auth challenge marker must stay inside isolated storage.");
  }
  return markerPath;
}

async function closeFixture() {
  closePromise ??= (async () => {
    if (listener) {
      listener.closeAllConnections?.();
      await new Promise((resolve, reject) => {
        listener.close((error) => error ? reject(error) : resolve());
      });
    }
    if (process.connected) process.disconnect();
  })();
  return await closePromise;
}

async function main() {
  const markerPath = requireContainedMarkerPath();
  listener = http.createServer((request, response) => {
    request.resume();
    fsSync.appendFileSync(markerPath, "auth-required\n", "utf8");
    response.writeHead(401, {
      "Connection": "close",
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer realm=\"agentic-sdlc-contract\"",
    });
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Authentication required" },
    }));
  });
  listener.listen(0, LOOPBACK_HOST);
  if (!listener.listening) {
    await Promise.race([
      once(listener, "listening"),
      once(listener, "error").then(([error]) => Promise.reject(error)),
    ]);
  }
  const address = listener.address();
  if (
    typeof address !== "object" ||
    address === null ||
    address.address !== LOOPBACK_HOST ||
    !Number.isSafeInteger(address.port) ||
    address.port <= 0
  ) {
    throw new Error("Auth fixture did not bind the required random loopback endpoint.");
  }
  process.send?.({ type: "ready", host: LOOPBACK_HOST, port: address.port });
}

process.on("message", (message) => {
  if (typeof message === "object" && message !== null && message.type === "close") {
    void closeFixture().catch(() => {
      process.exitCode = 1;
    });
  }
});
process.once("SIGINT", () => void closeFixture());
process.once("SIGTERM", () => void closeFixture());

main().catch(async () => {
  process.send?.({ type: "error", code: "auth_fixture_start_failed" });
  await closeFixture().catch(() => undefined);
  process.exitCode = 1;
});

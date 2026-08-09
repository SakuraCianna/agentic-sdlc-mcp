import { once } from "node:events";

import {
  closeMcpHttp,
  createMcpHttpApp,
  listenMcpHttp,
} from "../../dist/http-server.js";

const LOOPBACK_HOST = "127.0.0.1";

let listener;
let closePromise;

async function closeFixture() {
  closePromise ??= (async () => {
    if (listener) await closeMcpHttp(listener);
    if (process.connected) process.disconnect();
  })();
  return await closePromise;
}

async function main() {
  const app = createMcpHttpApp();
  listener = listenMcpHttp(app, 0, LOOPBACK_HOST);
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
    throw new Error("HTTP fixture did not bind the required random loopback endpoint.");
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
  process.send?.({ type: "error", code: "http_fixture_start_failed" });
  await closeFixture().catch(() => undefined);
  process.exitCode = 1;
});

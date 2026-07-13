import { Socket } from "node:net";

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (!isLoopback(url.hostname)) {
    return Promise.reject(new Error(`External network access is disabled in tests: ${url.hostname}`));
  }
  return originalFetch(input, init);
}) as typeof globalThis.fetch;

const originalSocketConnect = Socket.prototype.connect;
Socket.prototype.connect = function guardedConnect(
  this: Socket,
  ...args: Parameters<typeof originalSocketConnect>
): Socket {
  const first = args[0] as unknown;
  // String-only connect targets are local IPC paths. TCP overloads expose a
  // host either in the options object or as the argument after the port.
  const hostname =
    typeof first === "object" && first !== null && "host" in first
      ? String((first as { host?: unknown }).host ?? "localhost")
      : typeof first === "number" && typeof args[1] === "string"
        ? args[1]
        : "localhost";
  if (!isLoopback(hostname)) {
    throw new Error(`External socket access is disabled in tests: ${hostname}`);
  }
  return Reflect.apply(originalSocketConnect, this, args) as Socket;
} as typeof originalSocketConnect;

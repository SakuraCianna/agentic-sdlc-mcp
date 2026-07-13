import type { Server } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Express, NextFunction, Request, Response } from "express";

import { createAgenticSdlcServer } from "./server.js";

export type McpServerFactory = () => McpServer;

export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 3000;

const LOCAL_ORIGIN_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const closingServers = new WeakMap<Server, Promise<void>>();

interface StatusError {
  status?: unknown;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function validateLocalOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get("origin");
  if (!origin) {
    next();
    return;
  }

  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
        LOCAL_ORIGIN_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      next();
      return;
    }
  } catch {
    // A malformed external header is rejected with the same bounded response.
  }

  sendJsonRpcError(res, 403, -32000, "Forbidden origin");
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.set("Allow", "POST");
  sendJsonRpcError(res, 405, -32000, "Method not allowed.");
}

function safeHttpError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as StatusError).status
    : undefined;
  if (status === 400 && error instanceof SyntaxError) {
    sendJsonRpcError(res, 400, -32700, "Invalid JSON request body");
    return;
  }
  if (status === 413) {
    sendJsonRpcError(res, 413, -32000, "Request body too large");
    return;
  }
  sendJsonRpcError(res, 500, -32603, "Internal server error");
}

/** Build the stateless HTTP adapter. Each request owns its MCP server and transport. */
export function createMcpHttpApp(
  createServer: McpServerFactory = createAgenticSdlcServer
): Express {
  // SDK factory applies localhost Host-header validation for DNS rebinding protection.
  const app = createMcpExpressApp({ host: DEFAULT_MCP_HTTP_HOST });
  app.use(validateLocalOrigin);

  app.post("/mcp", async (req: Request, res: Response, next: NextFunction) => {
    let requestServer: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    let closed = false;
    const closeRequest = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([
        ...(transport ? [transport.close()] : []),
        ...(requestServer ? [requestServer.close()] : []),
      ]);
    };

    try {
      requestServer = createServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once("close", () => void closeRequest());
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await closeRequest();
      next(error);
    }
  });

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.use(safeHttpError);

  return app;
}

/** Listen on loopback by default; callers must opt into any wider network exposure. */
export function listenMcpHttp(
  app: Express,
  port: number,
  host: string = DEFAULT_MCP_HTTP_HOST
): Server {
  return app.listen(port, host);
}

export function parseMcpHttpPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MCP_HTTP_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

/** Stop accepting connections and wait for active request responses to finish. */
export function closeMcpHttp(server: Server): Promise<void> {
  const activeClose = closingServers.get(server);
  if (activeClose) return activeClose;
  if (!server.listening) return Promise.resolve();

  const close = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  closingServers.set(server, close);
  return close;
}

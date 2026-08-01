import type { Server } from "node:http";

import { localhostHostValidation } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler as createSdkMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpServerFactory as SdkMcpServerFactory,
  type Transport,
} from "@modelcontextprotocol/server";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { createAgenticSdlcServer } from "./server.js";

export type McpServerFactory = SdkMcpServerFactory;
type McpFactoryProduct = Awaited<ReturnType<McpServerFactory>>;

export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 3000;
const MAX_MCP_HTTP_JSON_BYTES = 100 * 1024;

const LOCAL_ORIGIN_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const closingServers = new WeakMap<Server, Promise<void>>();
const handlersByApp = new WeakMap<Express, McpHttpHandler>();
const handlersByListener = new WeakMap<Server, McpHttpHandler>();

interface StatusError {
  status?: unknown;
}

type ExchangeCloser = () => Promise<void>;

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

function internalHandlerErrorResponse(parsedBody: unknown): globalThis.Response {
  let id: string | number | null = null;
  if (typeof parsedBody === "object" && parsedBody !== null && "id" in parsedBody) {
    const candidate = (parsedBody as { id?: unknown }).id;
    if (typeof candidate === "string" || typeof candidate === "number" || candidate === null) {
      id = candidate;
    }
  }
  return globalThis.Response.json({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id,
  }, { status: 500 });
}

async function serveLegacyJsonRequest(
  createServer: McpServerFactory,
  request: globalThis.Request,
  options: McpHandlerRequestOptions | undefined,
  registerExchange: (close: ExchangeCloser) => boolean,
  unregisterExchange: (close: ExchangeCloser) => void
): Promise<globalThis.Response> {
  let requestServer: Awaited<ReturnType<McpServerFactory>> | undefined;
  let transport: WebStandardStreamableHTTPServerTransport | undefined;
  let resolveClosed: ((response: globalThis.Response) => void) | undefined;
  const closedResponse = new Promise<globalThis.Response>((resolve) => {
    resolveClosed = resolve;
  });
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closed = true;
      resolveClosed?.(new globalThis.Response(null, { status: 499 }));
      const activeTransport = transport;
      const activeServer = requestServer;
      await Promise.allSettled([
        ...(activeTransport
          ? [Promise.resolve().then(() => activeTransport.close())]
          : []),
        ...(activeServer
          ? [Promise.resolve().then(() => activeServer.close())]
          : []),
      ]);
    })();
    return closePromise;
  };
  const abortExchange = (): void => {
    void close();
  };

  if (!registerExchange(close)) {
    await close();
    return await closedResponse;
  }
  request.signal.addEventListener("abort", abortExchange, { once: true });

  try {
    if (request.signal.aborted) {
      await close();
      return await closedResponse;
    }
    const operation = (async (): Promise<globalThis.Response> => {
      const server = await createServer({
        era: "legacy",
        authInfo: options?.authInfo,
        requestInfo: request,
      });
      requestServer = server;
      if (closed) {
        await server.close();
        return await closedResponse;
      }

      const requestTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transport = requestTransport;
      await server.connect(requestTransport);
      if (closed) return await closedResponse;
      return await requestTransport.handleRequest(request, options);
    })();
    // The close response may win while an uncooperative factory stays pending.
    // Keep a rejection observer attached so a later factory failure is contained.
    void operation.catch(() => undefined);
    return await Promise.race([
      operation,
      closedResponse,
    ]);
  } finally {
    request.signal.removeEventListener("abort", abortExchange);
    unregisterExchange(close);
    await close();
  }
}

async function serveModernRequest(
  modernHandler: McpHttpHandler,
  request: globalThis.Request,
  options: McpHandlerRequestOptions | undefined,
  registerExchange: (close: ExchangeCloser) => boolean,
  unregisterExchange: (close: ExchangeCloser) => void
): Promise<globalThis.Response> {
  let resolveClosed: ((response: globalThis.Response) => void) | undefined;
  const closedResponse = new Promise<globalThis.Response>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      resolveClosed?.(new globalThis.Response(null, { status: 499 }));
    })();
    return closePromise;
  };
  const abortExchange = (): void => {
    void close();
  };

  if (!registerExchange(close)) {
    await close();
    return await closedResponse;
  }
  request.signal.addEventListener("abort", abortExchange, { once: true });

  try {
    if (request.signal.aborted) {
      await close();
      return await closedResponse;
    }
    const operation = modernHandler.fetch(request, options);
    void operation.catch(() => undefined);
    return await Promise.race([operation, closedResponse]);
  } finally {
    request.signal.removeEventListener("abort", abortExchange);
    unregisterExchange(close);
    await close();
  }
}

/** Build the official dual-era stateless handler used by every HTTP adapter. */
export function createMcpHttpHandler(
  createServer: McpServerFactory = createAgenticSdlcServer
): McpHttpHandler {
  const activeExchanges = new Set<ExchangeCloser>();
  const inFlightRequests = new Set<Promise<globalThis.Response>>();
  const pendingModernProducts = new Set<McpFactoryProduct>();
  const closingModernProducts = new WeakMap<object, Promise<void>>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const closeModernProduct = (product: McpFactoryProduct): Promise<void> => {
    const existing = closingModernProducts.get(product);
    if (existing) return existing;
    const closing = Promise.resolve().then(() => product.close());
    closingModernProducts.set(product, closing);
    return closing;
  };
  const guardModernProduct = (
    product: McpFactoryProduct,
    requestSignal: AbortSignal | undefined
  ): McpFactoryProduct => new Proxy(product, {
    get(target, property) {
      if (property === "connect") {
        return async (transport: Transport): Promise<void> => {
          pendingModernProducts.delete(product);
          if (closed || requestSignal?.aborted === true) {
            await closeModernProduct(product).catch(() => undefined);
            throw new Error("MCP request closed before the server connected");
          }
          await product.connect(transport);
        };
      }
      if (property === "close") {
        return async (): Promise<void> => {
          pendingModernProducts.delete(product);
          await closeModernProduct(product);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as McpFactoryProduct;
  const guardedModernFactory: McpServerFactory = async (context) => {
    const product = await createServer(context);
    pendingModernProducts.add(product);
    if (closed || context.requestInfo?.signal.aborted === true) {
      pendingModernProducts.delete(product);
      await closeModernProduct(product).catch(() => undefined);
      throw new Error("MCP request closed before the server factory completed");
    }
    return guardModernProduct(product, context.requestInfo?.signal);
  };
  const modernHandler = createSdkMcpHandler(guardedModernFactory, {
    legacy: "reject",
  });

  const registerExchange = (close: ExchangeCloser): boolean => {
    if (closed) return false;
    activeExchanges.add(close);
    return true;
  };
  const unregisterExchange = (close: ExchangeCloser): void => {
    activeExchanges.delete(close);
  };

  return {
    fetch: (request, options) => {
      if (closed) return Promise.reject(new Error("This MCP handler has been closed"));
      const response = (async () => {
        try {
          return (await isLegacyRequest(request, options?.parsedBody))
            ? await serveLegacyJsonRequest(
                createServer,
                request,
                options,
                registerExchange,
                unregisterExchange
              )
            : await serveModernRequest(
                modernHandler,
                request,
                options,
                registerExchange,
                unregisterExchange
              );
        } catch {
          return internalHandlerErrorResponse(options?.parsedBody);
        }
      })();
      inFlightRequests.add(response);
      void response.then(
        () => inFlightRequests.delete(response),
        () => inFlightRequests.delete(response)
      );
      return response;
    },
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        const pendingProducts = [...pendingModernProducts];
        pendingModernProducts.clear();
        await Promise.allSettled([
          modernHandler.close(),
          ...[...activeExchanges].map((close) => close()),
          ...pendingProducts.map((product) => closeModernProduct(product)),
        ]);
        await Promise.allSettled([...inFlightRequests]);
      })();
      return closePromise;
    },
    notify: modernHandler.notify,
    bus: modernHandler.bus,
  };
}

/** Build the stateless HTTP adapter. Each request owns its MCP server and transport. */
export function createMcpHttpApp(
  createServer: McpServerFactory = createAgenticSdlcServer
): Express {
  // Reject untrusted network headers before reading request bodies, then retain
  // the bounded JSON contract used by the legacy adapter.
  const app = express();
  app.use(localhostHostValidation());
  app.use(validateLocalOrigin);
  app.use(express.json({ limit: MAX_MCP_HTTP_JSON_BYTES }));
  const handler = createMcpHttpHandler(createServer);
  const nodeHandler = toNodeHandler(handler);
  handlersByApp.set(app, handler);

  app.post("/mcp", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await nodeHandler(req, res, req.body);
    } catch (error) {
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
  const listener = app.listen(port, host);
  const handler = handlersByApp.get(app);
  if (handler) handlersByListener.set(listener, handler);
  return listener;
}

export function parseMcpHttpPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MCP_HTTP_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

/** Stop accepting connections, close MCP exchanges, then await active responses. */
export function closeMcpHttp(server: Server): Promise<void> {
  const activeClose = closingServers.get(server);
  if (activeClose) return activeClose;

  const close = (async () => {
    const listenerClose = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        })
      : Promise.resolve();
    const handlerClose = handlersByListener.get(server)?.close() ?? Promise.resolve();
    await Promise.all([handlerClose, listenerClose]);
  })();
  closingServers.set(server, close);
  return close;
}

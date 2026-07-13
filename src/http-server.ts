import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createAgenticSdlcServer } from "./server.js";

export type McpServerFactory = () => McpServer;

/** Build the stateless HTTP adapter. Each request owns its MCP server and transport. */
export function createMcpHttpApp(
  createServer: McpServerFactory = createAgenticSdlcServer
): Express {
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req: Request, res: Response, next: NextFunction) => {
    const requestServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    let closed = false;
    const closeRequest = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([transport.close(), requestServer.close()]);
    };

    res.once("close", () => void closeRequest());
    try {
      await requestServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      await closeRequest();
      next(error);
    }
  });

  return app;
}

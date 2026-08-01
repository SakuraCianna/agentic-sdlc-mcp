import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../catalog.js";
import {
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  createEraClient,
  type McpProtocolEra,
} from "./fixtures/mcp-client.js";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVER_SCRIPT = path.join(
  PROJECT_ROOT,
  "scripts",
  "fixtures",
  "run-stdio-server.mjs"
);
const SECRET_CANARIES = {
  GITHUB_TOKEN: "must-not-reach-stdio-child",
  OPENAI_API_KEY: "must-not-reach-stdio-child",
  NODE_OPTIONS: "--must-not-reach-stdio-child",
} as const;

function setParentSecretCanaries(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(SECRET_CANARIES)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function isolatedChildEnvironment(root: string): Record<string, string> {
  const home = path.join(root, "home");
  const drive = path.parse(home).root.replace(/[\\/]$/, "");
  const homePath = drive && home.toLowerCase().startsWith(drive.toLowerCase())
    ? home.slice(drive.length)
    : home;
  return {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: homePath,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TEMP: path.join(root, "temp"),
    TMP: path.join(root, "temp"),
    TMPDIR: path.join(root, "temp"),
    MCP_STORAGE_DIR: path.join(root, "storage"),
    MCP_TEST_HOME: home,
  };
}

describe("built stdio process era negotiation", () => {
  it.each(["legacy", "modern"] satisfies McpProtocolEra[])(
    "discovers the public contract through a %s child process",
    async (era) => {
      const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-stdio-"));
      const childEnvironment = isolatedChildEnvironment(fixtureRoot);
      await Promise.all([
        fs.mkdir(childEnvironment["HOME"], { recursive: true }),
        fs.mkdir(childEnvironment["TEMP"], { recursive: true }),
        fs.mkdir(childEnvironment["MCP_STORAGE_DIR"], { recursive: true }),
      ]);
      await fs.writeFile(path.join(childEnvironment["HOME"], "empty.env"), "", "utf8");
      const restoreParentEnvironment = setParentSecretCanaries();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_SCRIPT],
        cwd: PROJECT_ROOT,
        env: childEnvironment,
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const client = createEraClient(era);

      try {
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe(era);
        expect(client.getNegotiatedProtocolVersion()).toBe(
          era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION
        );
        const [tools, resources] = await Promise.all([
          client.listTools(),
          client.listResources(),
        ]);
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
        expect(resources.resources).toHaveLength(5);
      } finally {
        await Promise.allSettled([client.close()]);
        restoreParentEnvironment();
        await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
      }

      expect(stderr.trim()).toBe(
        "[agentic-sdlc-mcp] Server running via stdio transport"
      );
    }
  );
});

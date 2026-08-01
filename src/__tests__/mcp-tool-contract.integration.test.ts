import net from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOL_NAMES } from "../catalog.js";
import { createMcpHttpHandler } from "../http-server.js";
import { STRUCTURED_CONTENT_TRUST_BOUNDARY } from "../security/trust-boundary.js";
import {
  connectDirectFetchMcp,
  connectStdioMcp,
  MODERN_PROTOCOL_VERSION,
  type ConnectedDirectFetchFixture,
  type ConnectedMcpEntryFixture,
  type McpProtocolEra,
} from "./fixtures/mcp-client.js";
import { MCP_TOOL_CONTRACT_CASES } from "./fixtures/mcp-contract-cases.js";
import {
  createGithubContractFixture,
  type GithubContractFixture,
} from "./fixtures/github-contract-fixtures.js";

const github = vi.hoisted(() => ({
  fixture: null as GithubContractFixture | null,
}));

vi.mock("../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      if (!github.fixture) throw new Error("GitHub contract fixture is not initialized");
      return github.fixture.octokit;
    },
  };
});

const { createAgenticSdlcServer } = await import("../server.js");

function markdownText(result: Awaited<ReturnType<ConnectedMcpEntryFixture["client"]["callTool"]>>): string {
  return result.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function structuredObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

async function connectEra(era: McpProtocolEra): Promise<ConnectedMcpEntryFixture> {
  if (era === "legacy") return connectStdioMcp(createAgenticSdlcServer, era);
  return connectDirectFetchMcp(createMcpHttpHandler(createAgenticSdlcServer), era);
}

describe.each(["legacy", "modern"] as const)("%s full tool contract matrix", (era) => {
  let connection: ConnectedMcpEntryFixture;
  let externalFetch: ReturnType<typeof vi.fn>;
  let socketConnect: ReturnType<typeof vi.spyOn>;
  let socketCreateConnection: ReturnType<typeof vi.spyOn>;
  let socketPrototypeConnect: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    github.fixture = createGithubContractFixture();
    externalFetch = vi.fn(async () => {
      throw new Error("external fetch is forbidden in the MCP contract matrix");
    });
    vi.stubGlobal("fetch", externalFetch);
    socketConnect = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in the MCP contract matrix");
    });
    socketCreateConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("external socket is forbidden in the MCP contract matrix");
    });
    socketPrototypeConnect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in the MCP contract matrix");
    });
    connection = await connectEra(era);
  });

  afterEach(async () => {
    await connection?.close();
    github.fixture = null;
    socketConnect?.mockRestore();
    socketCreateConnection?.mockRestore();
    socketPrototypeConnect?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("calls all 13 tools through Client.callTool with validated structured output", async () => {
    expect(MCP_TOOL_CONTRACT_CASES.map((testCase) => testCase.name)).toEqual(TOOL_NAMES);

    for (const testCase of MCP_TOOL_CONTRACT_CASES) {
      const result = await connection.client.callTool({
        name: testCase.name,
        arguments: testCase.arguments,
      });

      // McpServer validates the registered Standard Schema output before the
      // SDK client receives a successful CallToolResult.
      expect(
        result.isError,
        `${testCase.name} returned an MCP error: ${markdownText(result)}`
      ).not.toBe(true);
      expect(markdownText(result), `${testCase.name} Markdown`).toContain(
        testCase.markdownHeading
      );
      expect(result._meta, `${testCase.name} trust metadata`).toMatchObject({
        "agentic-sdlc/untrustedContent": true,
        "agentic-sdlc/trustNotice": expect.stringContaining("untrusted data"),
      });
      const structured = structuredObject(result.structuredContent);
      expect(structured.trustBoundary, `${testCase.name} trust boundary`).toEqual(
        STRUCTURED_CONTENT_TRUST_BOUNDARY
      );
      for (const key of testCase.structuredKeys) {
        expect(structured, `${testCase.name} structured key`).toHaveProperty(key);
      }
      expect(structured, `${testCase.name} structured semantic evidence`).toHaveProperty(
        testCase.semanticParity.structuredPath,
        testCase.semanticParity.structuredValue
      );
      expect(markdownText(result), `${testCase.name} Markdown semantic evidence`).toContain(
        testCase.semanticParity.markdownValue
      );
      if (testCase.name === "create_issue_set") {
        expect(structured.dryRun).toBe(true);
      }
    }

    expect(github.fixture?.liveIssueCreate).not.toHaveBeenCalled();
    expect(externalFetch).not.toHaveBeenCalled();
    expect(socketConnect).not.toHaveBeenCalled();
    expect(socketCreateConnection).not.toHaveBeenCalled();
    expect(socketPrototypeConnect).not.toHaveBeenCalled();

    if (era === "modern") {
      const calls = (connection as ConnectedDirectFetchFixture).observations.filter(
        (observation) => observation.requestMethod === "tools/call"
      );
      expect(calls).toHaveLength(TOOL_NAMES.length);
      expect(calls.every((observation) =>
        observation.protocolVersionHeader === MODERN_PROTOCOL_VERSION
      )).toBe(true);
      expect(calls.every((observation) =>
        observation.mcpMethodHeader === "tools/call"
      )).toBe(true);
    }
  });

  it("keeps schema and GitHub errors free of success structuredContent", async () => {
    const invalid = await connection.client.callTool({
      name: "prepare_work_item",
      arguments: { owner: "example", repo: "project", issueNumber: 0 },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect(markdownText(invalid)).toContain("issueNumber");

    github.fixture?.denyIssueReads();
    const denied = await connection.client.callTool({
      name: "prepare_work_item",
      arguments: { owner: "example", repo: "project", issueNumber: 42 },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toBeUndefined();
    expect(markdownText(denied)).toMatch(/permission denied/i);
    expect(markdownText(denied)).not.toContain("fixture permission denial");
  });

  it("returns bounded structured degradation when optional security sources are denied", async () => {
    github.fixture?.denySecurityReads();
    const degraded = await connection.client.callTool({
      name: "security_triage",
      arguments: {
        owner: "example",
        repo: "project",
        includeCodeScanning: true,
        includeDependabot: true,
        includeSecretScanning: true,
      },
    });

    expect(degraded.isError).not.toBe(true);
    const structured = structuredObject(degraded.structuredContent);
    expect(structured.trustBoundary).toEqual(STRUCTURED_CONTENT_TRUST_BOUNDARY);
    expect(structured.errors).toEqual([
      expect.stringMatching(/^Code Scanning: GitHub permission denied/),
      expect.stringMatching(/^Dependabot: GitHub permission denied/),
      expect.stringMatching(/^Secret Scanning: GitHub permission denied/),
    ]);
    expect(markdownText(degraded)).not.toContain("fixture permission denial");
    expect(externalFetch).not.toHaveBeenCalled();
    expect(socketConnect).not.toHaveBeenCalled();
    expect(socketCreateConnection).not.toHaveBeenCalled();
    expect(socketPrototypeConnect).not.toHaveBeenCalled();
  });
});

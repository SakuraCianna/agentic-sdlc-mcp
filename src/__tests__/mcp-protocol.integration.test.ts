import { afterEach, describe, expect, it } from "vitest";

import { connectInMemoryMcp } from "./fixtures/mcp-client.js";
import { createAgenticSdlcServer } from "../server.js";

describe("real MCP protocol contract", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closeCallbacks.splice(0).map((close) => close()));
  });

  async function connectRealClient() {
    const fixture = await connectInMemoryMcp(createAgenticSdlcServer);
    closeCallbacks.push(fixture.close);
    return fixture;
  }

  it("initializes and discovers every tool through the SDK transport", async () => {
    const { client } = await connectRealClient();

    expect(client.getServerVersion()).toEqual({
      name: "agentic-sdlc-mcp",
      version: "1.7.1",
    });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "agent_handoff_packet",
      "branch_protection_status",
      "create_issue_set",
      "create_pr_summary",
      "plan_from_context",
      "prepare_work_item",
      "quality_gate_status",
      "release_readiness_check",
      "repo_context",
      "review_pr_against_standard",
      "security_triage",
      "workflow_permissions_audit",
    ]);
    expect(tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });

  it("lists and reads every static resource through real MCP requests", async () => {
    const { client } = await connectRealClient();

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      "sdlc://standards/agentic-sdlc",
      "sdlc://templates/handoff",
      "sdlc://templates/issue",
      "sdlc://templates/pr-summary",
      "sdlc://templates/release-readiness",
    ]);

    for (const resource of resources) {
      const result = await client.readResource({ uri: resource.uri });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]).toMatchObject({
        uri: resource.uri,
        mimeType: "text/markdown",
      });
      expect("text" in result.contents[0] ? result.contents[0].text.length : 0).toBeGreaterThan(100);
    }
  });

  it("returns a protocol error for an unknown resource without destabilizing the session", async () => {
    const { client } = await connectRealClient();

    await expect(
      client.readResource({ uri: "sdlc://templates/does-not-exist" })
    ).rejects.toThrow();
    await expect(client.ping()).resolves.toEqual({});
  });
});

import { describe, expect, it } from "vitest";

import {
  compareMcpContracts,
  createMcpContractManifest,
  type McpContractManifest,
  type RawMcpContractSnapshot,
} from "../../contracts/mcp-manifest.js";

const SOURCE = {
  tag: "v1.9.0",
  commit: "3e1cdbb2d591ba482903f53579f1f76cc95ff1c4",
  releaseUrl:
    "https://github.com/SakuraCianna/agentic-sdlc-mcp/releases/tag/v1.9.0",
} as const;

function rawSnapshot(): RawMcpContractSnapshot {
  return {
    server: {
      name: "agentic-sdlc-mcp",
      version: "1.9.0",
    },
    tools: [
      {
        name: "repo_context",
        title: "Repository Context",
        description: "Read bounded repository context.",
        inputSchema: {
          type: "object",
          properties: {
            owner: { type: "string" },
            mode: { type: "string", enum: ["summary", "full"] },
          },
          required: ["owner"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            warnings: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["summary", "warnings"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ],
    resources: [
      {
        uri: "sdlc://templates/handoff",
        name: "Handoff Template",
        description: "Template for bounded agent handoff.",
        mimeType: "text/markdown",
      },
    ],
  };
}

function manifest(raw: RawMcpContractSnapshot = rawSnapshot()): McpContractManifest {
  return createMcpContractManifest(raw, SOURCE);
}

function cloneRaw(): RawMcpContractSnapshot {
  return structuredClone(rawSnapshot());
}

describe("MCP contract manifest normalization", () => {
  it("records immutable source provenance and stable tool/resource ordering", () => {
    const raw = cloneRaw();
    raw.tools.unshift({
      ...structuredClone(raw.tools[0]!),
      name: "agent_handoff_packet",
    });
    raw.resources.unshift({
      ...structuredClone(raw.resources[0]!),
      uri: "sdlc://standards/agentic-sdlc",
    });
    raw.tools[1]!.inputSchema = {
      type: "object",
      properties: {
        zeta: { type: "boolean" },
        alpha: { type: "string" },
      },
    };

    const normalized = manifest(raw);

    expect(normalized.source).toEqual(SOURCE);
    expect(normalized.tools.map((tool) => tool.name)).toEqual([
      "agent_handoff_packet",
      "repo_context",
    ]);
    expect(normalized.resources.map((resource) => resource.uri)).toEqual([
      "sdlc://standards/agentic-sdlc",
      "sdlc://templates/handoff",
    ]);
    expect(
      Object.keys(
        normalized.tools[1]!.inputSchema.properties as Record<string, unknown>
      )
    ).toEqual(["alpha", "zeta"]);
  });
});

describe("MCP contract compatibility", () => {
  it("accepts additive optional input/output fields and new tools/resources", () => {
    const currentRaw = cloneRaw();
    const tool = currentRaw.tools[0]!;
    const inputProperties = tool.inputSchema.properties as Record<string, unknown>;
    inputProperties.repo = { type: "string" };
    const outputProperties = tool.outputSchema!.properties as Record<string, unknown>;
    outputProperties.details = { type: "string" };
    currentRaw.tools.push({
      ...structuredClone(tool),
      name: "new_read_only_tool",
    });
    currentRaw.resources.push({
      ...structuredClone(currentRaw.resources[0]!),
      uri: "sdlc://templates/new",
    });

    const result = compareMcpContracts(manifest(), manifest(currentRaw));

    expect(result.breaking).toEqual([]);
    expect(result.nonBreaking.map((change) => change.code)).toEqual(
      expect.arrayContaining([
        "input_optional_property_added",
        "output_optional_property_added",
        "tool_added",
        "resource_added",
      ])
    );
  });

  it.each([
    {
      name: "tool removal",
      mutate(raw: RawMcpContractSnapshot) {
        raw.tools = [];
      },
      code: "tool_removed",
    },
    {
      name: "resource removal",
      mutate(raw: RawMcpContractSnapshot) {
        raw.resources = [];
      },
      code: "resource_removed",
    },
    {
      name: "input property removal",
      mutate(raw: RawMcpContractSnapshot) {
        delete (raw.tools[0]!.inputSchema.properties as Record<string, unknown>).mode;
      },
      code: "input_property_removed",
    },
    {
      name: "optional input becoming required",
      mutate(raw: RawMcpContractSnapshot) {
        raw.tools[0]!.inputSchema.required = ["owner", "mode"];
      },
      code: "input_required_added",
    },
    {
      name: "input enum narrowing",
      mutate(raw: RawMcpContractSnapshot) {
        const properties = raw.tools[0]!.inputSchema.properties as Record<
          string,
          { enum?: string[] }
        >;
        properties.mode!.enum = ["summary"];
      },
      code: "input_enum_narrowed",
    },
    {
      name: "input maximum tightening",
      mutate(raw: RawMcpContractSnapshot) {
        const properties = raw.tools[0]!.inputSchema.properties as Record<
          string,
          Record<string, unknown>
        >;
        properties.owner!.maxLength = 50;
      },
      code: "input_constraint_tightened",
    },
    {
      name: "required output guarantee removal",
      mutate(raw: RawMcpContractSnapshot) {
        raw.tools[0]!.outputSchema!.required = ["summary"];
      },
      code: "output_required_removed",
    },
    {
      name: "read-only annotation weakening",
      mutate(raw: RawMcpContractSnapshot) {
        raw.tools[0]!.annotations!.readOnlyHint = false;
      },
      code: "tool_annotation_changed",
    },
    {
      name: "destructive warning weakening",
      mutate(raw: RawMcpContractSnapshot) {
        raw.tools[0]!.annotations!.destructiveHint = true;
      },
      code: "tool_annotation_changed",
    },
    {
      name: "resource MIME type drift",
      mutate(raw: RawMcpContractSnapshot) {
        raw.resources[0]!.mimeType = "application/json";
      },
      code: "resource_mime_type_changed",
    },
  ])("rejects $name", ({ mutate, code }) => {
    const currentRaw = cloneRaw();
    mutate(currentRaw);

    const result = compareMcpContracts(manifest(), manifest(currentRaw));

    expect(result.breaking.map((change) => change.code)).toContain(code);
  });

  it("surfaces description changes without treating them as breaking", () => {
    const currentRaw = cloneRaw();
    currentRaw.tools[0]!.description = "Updated discoverability wording.";

    const result = compareMcpContracts(manifest(), manifest(currentRaw));

    expect(result.breaking).toEqual([]);
    expect(result.nonBreaking).toContainEqual(
      expect.objectContaining({
        code: "tool_description_changed",
        path: "tools.repo_context.description",
      })
    );
  });

  it("accepts removal of an input array item restriction", () => {
    const baselineRaw = cloneRaw();
    const baselineProperties = baselineRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    baselineProperties.tags = {
      type: "array",
      items: { type: "string" },
    };
    const currentRaw = structuredClone(baselineRaw);
    const currentProperties = currentRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    delete currentProperties.tags!.items;

    const result = compareMcpContracts(
      manifest(baselineRaw),
      manifest(currentRaw)
    );

    expect(result.breaking).toEqual([]);
    expect(result.nonBreaking).toContainEqual(
      expect.objectContaining({
        code: "input_items_schema_removed",
      })
    );
  });

  it("rejects a newly added input array item restriction", () => {
    const baselineRaw = cloneRaw();
    const baselineProperties = baselineRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    baselineProperties.tags = { type: "array" };
    const currentRaw = structuredClone(baselineRaw);
    const currentProperties = currentRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    currentProperties.tags!.items = { type: "string" };

    const result = compareMcpContracts(
      manifest(baselineRaw),
      manifest(currentRaw)
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "input_items_schema_added",
      })
    );
  });

  it("accepts widening a false input item schema to a typed schema", () => {
    const baselineRaw = cloneRaw();
    const baselineProperties = baselineRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    baselineProperties.tags = {
      type: "array",
      items: false,
    };
    const currentRaw = structuredClone(baselineRaw);
    const currentProperties = currentRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    currentProperties.tags!.items = { type: "string" };

    const result = compareMcpContracts(
      manifest(baselineRaw),
      manifest(currentRaw)
    );

    expect(result.breaking).toEqual([]);
    expect(result.nonBreaking).toContainEqual(
      expect.objectContaining({
        code: "input_items_schema_widened",
      })
    );
  });

  it("rejects a schema restriction on previously unrestricted extra input fields", () => {
    const baselineRaw = cloneRaw();
    const baselineProperties = baselineRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    baselineProperties.metadata = {
      type: "object",
      additionalProperties: true,
    };
    const currentRaw = structuredClone(baselineRaw);
    const currentProperties = currentRaw.tools[0]!.inputSchema
      .properties as Record<string, Record<string, unknown>>;
    currentProperties.metadata!.additionalProperties = { type: "string" };

    const result = compareMcpContracts(
      manifest(baselineRaw),
      manifest(currentRaw)
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "input_additional_properties_narrowed",
      })
    );
  });
});

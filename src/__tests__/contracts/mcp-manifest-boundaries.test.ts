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
        name: "contract_probe",
        title: "Contract Probe",
        description: "Exercise schema compatibility boundaries.",
        inputSchema: {
          type: "object",
          properties: {
            value: { type: ["string", "null"] },
          },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            result: { type: ["string", "null"] },
          },
          required: ["result"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
    resources: [
      {
        uri: "sdlc://contract/probe",
        name: "Contract Probe",
        title: "Contract Probe Resource",
        description: "Exercise resource contract boundaries.",
        mimeType: "text/markdown",
      },
    ],
  };
}

function manifest(raw: RawMcpContractSnapshot): McpContractManifest {
  return createMcpContractManifest(raw, SOURCE);
}

function compare(
  mutateBaseline: (raw: RawMcpContractSnapshot) => void,
  mutateCurrent: (raw: RawMcpContractSnapshot) => void
) {
  const baselineRaw = rawSnapshot();
  const currentRaw = rawSnapshot();
  mutateBaseline(baselineRaw);
  mutateCurrent(currentRaw);
  return compareMcpContracts(manifest(baselineRaw), manifest(currentRaw));
}

function inputProperty(
  raw: RawMcpContractSnapshot,
  name = "value"
): Record<string, unknown> {
  return (
    raw.tools[0]!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >
  )[name]!;
}

function outputProperty(
  raw: RawMcpContractSnapshot,
  name = "result"
): Record<string, unknown> {
  return (
    raw.tools[0]!.outputSchema!.properties as Record<
      string,
      Record<string, unknown>
    >
  )[name]!;
}

describe("MCP contract manifest validation boundaries", () => {
  it.each([
    {
      name: "short commit",
      source: { ...SOURCE, commit: "3e1cdbb" },
      message: "full 40-character SHA",
    },
    {
      name: "blank tag",
      source: { ...SOURCE, tag: "   " },
      message: "source tag is required",
    },
    {
      name: "non-GitHub release URL",
      source: { ...SOURCE, releaseUrl: "https://example.com/releases/v1.9.0" },
      message: "HTTPS GitHub release URL",
    },
  ])("rejects $name provenance", ({ source, message }) => {
    expect(() => createMcpContractManifest(rawSnapshot(), source)).toThrow(
      message
    );
  });

  it.each([
    { name: "NaN", value: Number.NaN, message: "finite number" },
    { name: "Infinity", value: Number.POSITIVE_INFINITY, message: "finite number" },
    { name: "function", value: () => "not JSON", message: "not JSON-serializable" },
    { name: "symbol", value: Symbol("not JSON"), message: "not JSON-serializable" },
  ])("rejects $name in a schema", ({ value, message }) => {
    const raw = rawSnapshot();
    inputProperty(raw).invalid = value;

    expect(() => manifest(raw)).toThrow(message);
  });

  it("omits undefined metadata and non-boolean annotations", () => {
    const raw = rawSnapshot();
    const tool = raw.tools[0]!;
    delete tool.title;
    delete tool.description;
    delete tool.outputSchema;
    tool.annotations = {
      readOnlyHint: undefined,
      invalidHint: "yes" as unknown as boolean,
    };
    const resource = raw.resources[0]!;
    delete resource.title;
    delete resource.description;
    delete resource.mimeType;

    const normalized = manifest(raw);

    expect(normalized.tools[0]).toEqual({
      name: "contract_probe",
      inputSchema: expect.any(Object),
    });
    expect(normalized.resources[0]).toEqual({
      uri: "sdlc://contract/probe",
      name: "Contract Probe",
    });
  });

  it("omits annotations when the server does not expose them", () => {
    const raw = rawSnapshot();
    delete raw.tools[0]!.annotations;

    expect(manifest(raw).tools[0]).not.toHaveProperty("annotations");
  });

  it("preserves schema keys that overlap JavaScript prototype names", () => {
    const raw = rawSnapshot();
    const properties = raw.tools[0]!.inputSchema.properties as Record<
      string,
      unknown
    >;
    Object.defineProperty(properties, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { type: "string" },
      writable: true,
    });

    const normalizedProperties = manifest(raw).tools[0]!.inputSchema
      .properties as Record<string, unknown>;

    expect(Object.hasOwn(normalizedProperties, "__proto__")).toBe(true);
    expect(normalizedProperties.__proto__).toEqual({ type: "string" });
  });

  it("uses locale-independent code-point ordering for schema keys", () => {
    const raw = rawSnapshot();
    raw.tools[0]!.inputSchema.Zeta = true;
    raw.tools[0]!.inputSchema.alpha = true;

    const keys = Object.keys(manifest(raw).tools[0]!.inputSchema);

    expect(keys.indexOf("Zeta")).toBeLessThan(keys.indexOf("alpha"));
  });

  it.each([
    {
      name: "tool name",
      mutate(raw: RawMcpContractSnapshot) {
        raw.tools.push(structuredClone(raw.tools[0]!));
      },
      message: "Duplicate MCP tool name",
    },
    {
      name: "resource URI",
      mutate(raw: RawMcpContractSnapshot) {
        raw.resources.push(structuredClone(raw.resources[0]!));
      },
      message: "Duplicate MCP resource URI",
    },
  ])("rejects a duplicate $name", ({ mutate, message }) => {
    const raw = rawSnapshot();
    mutate(raw);

    expect(() => manifest(raw)).toThrow(message);
  });
});

describe("input schema compatibility boundaries", () => {
  it("rejects type narrowing and accepts type widening", () => {
    const narrowed = compare(
      () => undefined,
      (raw) => {
        inputProperty(raw).type = "string";
      }
    );
    const widened = compare(
      (raw) => {
        inputProperty(raw).type = "string";
      },
      () => undefined
    );

    expect(narrowed.breaking).toContainEqual(
      expect.objectContaining({ code: "input_type_narrowed" })
    );
    expect(widened.breaking).toEqual([]);
  });

  it("rejects adding a type constraint to previously unrestricted input", () => {
    const result = compare(
      (raw) => {
        delete inputProperty(raw).type;
      },
      (raw) => {
        inputProperty(raw).type = "string";
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_type_narrowed" })
    );
  });

  it("understands integer as a subtype of number for input compatibility", () => {
    const widened = compare(
      (raw) => {
        inputProperty(raw).type = "integer";
      },
      (raw) => {
        inputProperty(raw).type = "number";
      }
    );
    const narrowed = compare(
      (raw) => {
        inputProperty(raw).type = "number";
      },
      (raw) => {
        inputProperty(raw).type = "integer";
      }
    );

    expect(widened.breaking).toEqual([]);
    expect(narrowed.breaking).toContainEqual(
      expect.objectContaining({ code: "input_type_narrowed" })
    );
  });

  it("compares enum values containing JSON objects", () => {
    const narrowed = compare(
      (raw) => {
        inputProperty(raw).enum = [{ kind: "a" }, { kind: "b" }];
      },
      (raw) => {
        inputProperty(raw).enum = [{ kind: "a" }];
      }
    );

    expect(narrowed.breaking).toContainEqual(
      expect.objectContaining({ code: "input_enum_narrowed" })
    );
  });

  it.each([
    {
      name: "minimum",
      baseline: 1,
      current: 2,
    },
    {
      name: "maximum",
      baseline: 10,
      current: 9,
    },
    {
      name: "pattern",
      baseline: undefined,
      current: "^safe$",
    },
    {
      name: "format",
      baseline: undefined,
      current: "uri",
    },
    {
      name: "const",
      baseline: undefined,
      current: "fixed",
    },
    {
      name: "multipleOf",
      baseline: undefined,
      current: 2,
    },
    {
      name: "uniqueItems",
      baseline: false,
      current: true,
    },
  ])("rejects a tightened $name input constraint", ({ name, baseline, current }) => {
    const result = compare(
      (raw) => {
        inputProperty(raw)[name] = baseline;
      },
      (raw) => {
        inputProperty(raw)[name] = current;
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_constraint_tightened" })
    );
  });

  it("accepts numeric input constraint loosening", () => {
    const result = compare(
      (raw) => {
        inputProperty(raw).minLength = 2;
        inputProperty(raw).maxLength = 10;
      },
      (raw) => {
        inputProperty(raw).minLength = 1;
        inputProperty(raw).maxLength = 20;
      }
    );

    expect(result.breaking).toEqual([]);
  });

  it("recursively detects narrowing of additional input properties", () => {
    const result = compare(
      (raw) => {
        raw.tools[0]!.inputSchema.additionalProperties = { type: "string" };
      },
      (raw) => {
        raw.tools[0]!.inputSchema.additionalProperties = {
          type: "string",
          maxLength: 10,
        };
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_constraint_tightened" })
    );
  });

  it("rejects disabling previously accepted additional input properties", () => {
    const result = compare(
      (raw) => {
        raw.tools[0]!.inputSchema.additionalProperties = true;
      },
      (raw) => {
        raw.tools[0]!.inputSchema.additionalProperties = false;
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "input_additional_properties_narrowed",
      })
    );
  });

  it("rejects an optional property that narrows a previously unrestricted value", () => {
    const result = compare(
      (raw) => {
        raw.tools[0]!.inputSchema.additionalProperties = true;
      },
      (raw) => {
        raw.tools[0]!.inputSchema.additionalProperties = true;
        (
          raw.tools[0]!.inputSchema.properties as Record<string, unknown>
        ).metadata = { type: "string" };
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_schema_changed" })
    );
  });

  it("does not confuse an inherited object name with an existing input property", () => {
    const result = compare(
      () => undefined,
      (raw) => {
        Object.defineProperty(raw.tools[0]!.inputSchema.properties, "toString", {
          configurable: true,
          enumerable: true,
          value: { type: "string" },
          writable: true,
        });
      }
    );

    expect(result.breaking).toEqual([]);
    expect(result.nonBreaking).toContainEqual(
      expect.objectContaining({
        code: "input_optional_property_added",
        path: "tools.contract_probe.inputSchema.properties.toString",
      })
    );
  });

  it.each([
    {
      name: "false to object",
      baseline: false,
      current: { type: "string" },
    },
    {
      name: "object to true",
      baseline: { type: "string" },
      current: true,
    },
  ])("accepts boolean-schema input widening: $name", ({ baseline, current }) => {
    const result = compare(
      (raw) => {
        (
          raw.tools[0]!.inputSchema.properties as Record<string, unknown>
        ).value = baseline;
      },
      (raw) => {
        (
          raw.tools[0]!.inputSchema.properties as Record<string, unknown>
        ).value = current;
      }
    );

    expect(result.breaking).toEqual([]);
  });

  it("rejects complex input schema composition drift", () => {
    const result = compare(
      () => undefined,
      (raw) => {
        inputProperty(raw).anyOf = [{ type: "string" }, { type: "number" }];
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_schema_composition_changed" })
    );
  });

  it("recursively detects input array item narrowing", () => {
    const result = compare(
      (raw) => {
        inputProperty(raw).type = "array";
        inputProperty(raw).items = { type: "string" };
      },
      (raw) => {
        inputProperty(raw).type = "array";
        inputProperty(raw).items = { type: "string", maxLength: 5 };
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_constraint_tightened" })
    );
  });

  it("fails closed on tuple-style input item drift", () => {
    const result = compare(
      (raw) => {
        inputProperty(raw).type = "array";
        inputProperty(raw).items = [{ type: "string" }];
      },
      (raw) => {
        inputProperty(raw).type = "array";
        inputProperty(raw).items = [{ type: "number" }];
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_items_schema_changed" })
    );
  });

  it("fails closed on an unmodeled validation-keyword change", () => {
    const result = compare(
      () => undefined,
      (raw) => {
        raw.tools[0]!.inputSchema.dependentRequired = {
          value: ["metadata"],
        };
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_schema_composition_changed" })
    );
  });

  it("rejects a changed input default such as dry-run true to false", () => {
    const result = compare(
      (raw) => {
        inputProperty(raw).default = true;
      },
      (raw) => {
        inputProperty(raw).default = false;
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_default_changed" })
    );
  });

  it("accepts the SDK v2 root dialect upgrade from draft-07 to 2020-12", () => {
    const result = compare(
      (raw) => {
        raw.tools[0]!.inputSchema.$schema =
          "http://json-schema.org/draft-07/schema#";
        raw.tools[0]!.outputSchema!.$schema =
          "http://json-schema.org/draft-07/schema#";
      },
      (raw) => {
        raw.tools[0]!.inputSchema.$schema =
          "https://json-schema.org/draft/2020-12/schema";
        raw.tools[0]!.outputSchema!.$schema =
          "https://json-schema.org/draft/2020-12/schema";
      }
    );

    expect(result.breaking).toEqual([]);
    expect(result.nonBreaking).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "input_schema_dialect_declared",
          path: "tools.contract_probe.inputSchema.$schema",
        }),
        expect.objectContaining({
          code: "output_schema_dialect_declared",
          path: "tools.contract_probe.outputSchema.$schema",
        }),
      ])
    );
  });

  it.each([
    {
      name: "declaration without a baseline dialect",
      baseline: undefined,
      current: "https://json-schema.org/draft/2020-12/schema",
    },
    {
      name: "draft-07 removal",
      baseline: "http://json-schema.org/draft-07/schema#",
      current: undefined,
    },
    {
      name: "2020-12 downgrade",
      baseline: "https://json-schema.org/draft/2020-12/schema",
      current: "http://json-schema.org/draft-07/schema#",
    },
    {
      name: "unrecognised target dialect",
      baseline: "http://json-schema.org/draft-07/schema#",
      current: "https://example.test/schema",
    },
  ])("requires review for $name", ({ baseline, current }) => {
    const result = compare(
      (raw) => {
        raw.tools[0]!.inputSchema.$schema = baseline;
      },
      (raw) => {
        raw.tools[0]!.inputSchema.$schema = current;
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "input_schema_composition_changed" })
    );
  });

  it.each(["$schema", "$recursiveRef", "$dynamicRef"])(
    "requires review when %s changes",
    (keyword) => {
      const result = compare(
        () => undefined,
        (raw) => {
          raw.tools[0]!.inputSchema[keyword] = "https://example.test/schema";
        }
      );

      expect(result.breaking).toContainEqual(
        expect.objectContaining({ code: "input_schema_composition_changed" })
      );
    }
  );
});

describe("output guarantee compatibility boundaries", () => {
  it("rejects output type and object-enum widening", () => {
    const typeResult = compare(
      () => undefined,
      (raw) => {
        outputProperty(raw).type = ["string", "null", "number"];
      }
    );
    const enumResult = compare(
      (raw) => {
        outputProperty(raw).enum = [{ state: "ready" }];
      },
      (raw) => {
        outputProperty(raw).enum = [{ state: "ready" }, { state: "unknown" }];
      }
    );

    expect(typeResult.breaking).toContainEqual(
      expect.objectContaining({ code: "output_type_weakened" })
    );
    expect(enumResult.breaking).toContainEqual(
      expect.objectContaining({ code: "output_enum_weakened" })
    );
  });

  it("understands integer as a stronger number output guarantee", () => {
    const strengthened = compare(
      (raw) => {
        outputProperty(raw).type = "number";
      },
      (raw) => {
        outputProperty(raw).type = "integer";
      }
    );
    const weakened = compare(
      (raw) => {
        outputProperty(raw).type = "integer";
      },
      (raw) => {
        outputProperty(raw).type = "number";
      }
    );

    expect(strengthened.breaking).toEqual([]);
    expect(weakened.breaking).toContainEqual(
      expect.objectContaining({ code: "output_type_weakened" })
    );
  });

  it.each([
    {
      name: "minimum removal",
      baseline: { minimum: 1 },
      current: {},
    },
    {
      name: "maximum loosening",
      baseline: { maximum: 10 },
      current: { maximum: 20 },
    },
    {
      name: "pattern removal",
      baseline: { pattern: "^safe$" },
      current: {},
    },
    {
      name: "const change",
      baseline: { const: "ready" },
      current: { const: "unknown" },
    },
    {
      name: "multipleOf change",
      baseline: { multipleOf: 2 },
      current: { multipleOf: 3 },
    },
    {
      name: "uniqueItems removal",
      baseline: { uniqueItems: true },
      current: { uniqueItems: false },
    },
  ])("rejects weakened output constraint: $name", ({ baseline, current }) => {
    const result = compare(
      (raw) => Object.assign(outputProperty(raw), baseline),
      (raw) => Object.assign(outputProperty(raw), current)
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "output_constraint_weakened" })
    );
  });

  it("accepts stronger numeric output guarantees", () => {
    const result = compare(
      (raw) => {
        outputProperty(raw).minLength = 1;
        outputProperty(raw).maxLength = 20;
      },
      (raw) => {
        outputProperty(raw).minLength = 2;
        outputProperty(raw).maxLength = 10;
      }
    );

    expect(result.breaking).toEqual([]);
  });

  it.each([
    {
      name: "object to true",
      baseline: { type: "string" },
      current: true,
      breaking: true,
    },
    {
      name: "false to object",
      baseline: false,
      current: { type: "string" },
      breaking: true,
    },
    {
      name: "true to object",
      baseline: true,
      current: { type: "string" },
      breaking: false,
    },
    {
      name: "object to false",
      baseline: { type: "string" },
      current: false,
      breaking: false,
    },
  ])(
    "classifies boolean-schema output change: $name",
    ({ baseline, current, breaking }) => {
      const result = compare(
        (raw) => {
          (
            raw.tools[0]!.outputSchema!.properties as Record<string, unknown>
          ).result = baseline;
        },
        (raw) => {
          (
            raw.tools[0]!.outputSchema!.properties as Record<string, unknown>
          ).result = current;
        }
      );

      expect(result.breaking.length > 0).toBe(breaking);
    }
  );

  it.each([
    {
      name: "false to true",
      baseline: false,
      current: true,
      breaking: true,
    },
    {
      name: "true to typed schema",
      baseline: true,
      current: { type: "string" },
      breaking: false,
    },
    {
      name: "typed schema to true",
      baseline: { type: "string" },
      current: true,
      breaking: true,
    },
  ])(
    "classifies additional output properties: $name",
    ({ baseline, current, breaking }) => {
      const result = compare(
        (raw) => {
          raw.tools[0]!.outputSchema!.additionalProperties = baseline;
        },
        (raw) => {
          raw.tools[0]!.outputSchema!.additionalProperties = current;
        }
      );

      expect(result.breaking.length > 0).toBe(breaking);
    }
  );

  it.each([
    {
      name: "typed items removed",
      baseline: { type: "string" },
      current: true,
      breaking: true,
    },
    {
      name: "unrestricted items constrained",
      baseline: true,
      current: { type: "string" },
      breaking: false,
    },
    {
      name: "typed items forbidden",
      baseline: { type: "string" },
      current: false,
      breaking: false,
    },
  ])("classifies output items: $name", ({ baseline, current, breaking }) => {
    const result = compare(
      (raw) => {
        outputProperty(raw).type = "array";
        outputProperty(raw).items = baseline;
      },
      (raw) => {
        outputProperty(raw).type = "array";
        outputProperty(raw).items = current;
      }
    );

    expect(result.breaking.length > 0).toBe(breaking);
  });

  it("rejects output composition drift", () => {
    const result = compare(
      (raw) => {
        outputProperty(raw).anyOf = [{ type: "string" }, { type: "null" }];
      },
      (raw) => {
        outputProperty(raw).anyOf = [{ type: "integer" }, { type: "null" }];
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "output_schema_composition_changed" })
    );
  });

  it("keeps an optional property inside a closed nullable anyOf behind manual review", () => {
    const nullableObject = () => ({
      anyOf: [
        {
          type: "object",
          properties: {
            status: { type: "string" },
          },
          required: ["status"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });
    const result = compare(
      (raw) => {
        Object.assign(outputProperty(raw), nullableObject());
      },
      (raw) => {
        const current = nullableObject();
        const objectBranch = current.anyOf[0] as {
          properties: Record<string, unknown>;
        };
        objectBranch.properties["provenanceWorkflowPath"] = {
          type: "string",
        };
        Object.assign(outputProperty(raw), current);
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "output_schema_composition_changed",
        path: expect.stringContaining("anyOf"),
      })
    );
  });

  it("keeps oneOf drift behind manual review because exclusivity can change", () => {
    const result = compare(
      (raw) => {
        outputProperty(raw).oneOf = [
          { type: "string" },
          { type: "number" },
        ];
      },
      (raw) => {
        outputProperty(raw).oneOf = [
          { type: "number" },
          { type: "string" },
        ];
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "output_schema_composition_changed",
        path: expect.stringContaining("oneOf"),
      })
    );
  });

  it("keeps a newly introduced anyOf behind manual review without a baseline union", () => {
    const result = compare(
      () => undefined,
      (raw) => {
        outputProperty(raw).anyOf = [
          { type: "string" },
          { type: "null" },
        ];
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "output_schema_composition_changed",
        path: expect.stringContaining("anyOf"),
      })
    );
  });

  it("rejects removal of a documented output property", () => {
    const result = compare(
      () => undefined,
      (raw) => {
        delete (
          raw.tools[0]!.outputSchema!.properties as Record<string, unknown>
        ).result;
        raw.tools[0]!.outputSchema!.required = [];
      }
    );

    expect(result.breaking.map((change) => change.code)).toEqual(
      expect.arrayContaining(["output_required_removed", "output_property_removed"])
    );
  });
});

describe("tool, server, and resource compatibility boundaries", () => {
  it("reports output schema removal/addition and annotation addition/removal", () => {
    const removed = compare(
      () => undefined,
      (raw) => {
        delete raw.tools[0]!.outputSchema;
        delete raw.tools[0]!.annotations!.readOnlyHint;
      }
    );
    const added = compare(
      (raw) => {
        delete raw.tools[0]!.outputSchema;
        delete raw.tools[0]!.annotations!.readOnlyHint;
      },
      () => undefined
    );

    expect(removed.breaking.map((change) => change.code)).toEqual(
      expect.arrayContaining([
        "tool_output_schema_removed",
        "tool_annotation_changed",
      ])
    );
    expect(added.nonBreaking.map((change) => change.code)).toEqual(
      expect.arrayContaining([
        "tool_output_schema_added",
        "tool_annotation_added",
      ])
    );
  });

  it("reports server identity/version and resource metadata drift", () => {
    const result = compare(
      () => undefined,
      (raw) => {
        raw.server.name = "renamed-server";
        raw.server.version = "2.0.0";
        raw.resources[0]!.name = "Renamed Resource";
        raw.resources[0]!.title = "Renamed Title";
        raw.resources[0]!.description = "Changed description.";
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({ code: "server_name_changed" })
    );
    expect(result.nonBreaking.map((change) => change.code)).toEqual(
      expect.arrayContaining([
        "server_version_changed",
        "resource_name_changed",
        "resource_title_changed",
        "resource_description_changed",
      ])
    );
  });

  it("does not ignore a changed future boolean tool annotation", () => {
    const result = compare(
      (raw) => {
        raw.tools[0]!.annotations!.futureSafetyHint = true;
      },
      (raw) => {
        raw.tools[0]!.annotations!.futureSafetyHint = false;
      }
    );

    expect(result.breaking).toContainEqual(
      expect.objectContaining({
        code: "tool_annotation_changed",
        path: "tools.contract_probe.annotations.futureSafetyHint",
      })
    );
  });
});

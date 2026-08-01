export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface RawMcpToolContract {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, boolean | undefined>;
}

export interface RawMcpResourceContract {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface RawMcpContractSnapshot {
  server: {
    name: string;
    version: string;
  };
  tools: RawMcpToolContract[];
  resources: RawMcpResourceContract[];
}

export interface McpContractSource {
  tag: string;
  commit: string;
  releaseUrl: string;
}

export interface McpToolContract {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: Record<string, boolean>;
}

export interface McpResourceContract {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpContractManifest {
  schemaVersion: 1;
  source: McpContractSource;
  server: {
    name: string;
    version: string;
  };
  tools: McpToolContract[];
  resources: McpResourceContract[];
}

export interface McpContractChange {
  code: string;
  path: string;
  message: string;
}

export interface McpContractComparison {
  breaking: McpContractChange[];
  nonBreaking: McpContractChange[];
}

const CONTRACT_ANNOTATIONS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

const MANUAL_REVIEW_SCHEMA_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "$schema",
  "$vocabulary",
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$id",
  "$defs",
  "definitions",
  "patternProperties",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
  "contains",
  "propertyNames",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "prefixItems",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
] as const;

const JSON_SCHEMA_2020_12_DIALECT =
  "https://json-schema.org/draft/2020-12/schema";
const JSON_SCHEMA_DRAFT_07_DIALECT =
  "http://json-schema.org/draft-07/schema#";

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeJson(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Contract value at ${path} must be a finite number.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const normalized: Array<[string, JsonValue]> = [];
    for (const [key, item] of Object.entries(value).sort(([left], [right]) =>
      compareStableStrings(left, right)
    )) {
      if (item === undefined) continue;
      normalized.push([key, normalizeJson(item, `${path}.${key}`)]);
    }
    return Object.fromEntries(normalized);
  }
  throw new Error(`Contract value at ${path} is not JSON-serializable.`);
}

function normalizeSchema(value: Record<string, unknown>, path: string): JsonObject {
  return normalizeJson(value, path) as JsonObject;
}

function normalizeAnnotations(
  value: Record<string, boolean | undefined> | undefined
): Record<string, boolean> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value)
    .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
    .sort(([left], [right]) => compareStableStrings(left, right));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compareText(
  baseline: string | undefined,
  current: string | undefined,
  code: string,
  path: string,
  nonBreaking: McpContractChange[]
): void {
  if (baseline === current) return;
  nonBreaking.push({
    code,
    path,
    message: `Public descriptive metadata changed at ${path}.`,
  });
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

export function createMcpContractManifest(
  snapshot: RawMcpContractSnapshot,
  source: McpContractSource
): McpContractManifest {
  if (!/^[0-9a-f]{40}$/i.test(source.commit)) {
    throw new Error("MCP contract source commit must be a full 40-character SHA.");
  }
  if (!source.tag.trim()) throw new Error("MCP contract source tag is required.");
  if (!/^https:\/\/github\.com\//i.test(source.releaseUrl)) {
    throw new Error("MCP contract releaseUrl must be an HTTPS GitHub release URL.");
  }
  assertUnique(
    snapshot.tools.map((tool) => tool.name),
    "MCP tool name"
  );
  assertUnique(
    snapshot.resources.map((resource) => resource.uri),
    "MCP resource URI"
  );

  return {
    schemaVersion: 1,
    source: { ...source },
    server: { ...snapshot.server },
    tools: snapshot.tools
      .map((tool) => {
        const annotations = normalizeAnnotations(tool.annotations);
        return {
          name: tool.name,
          ...(tool.title === undefined ? {} : { title: tool.title }),
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          inputSchema: normalizeSchema(
            tool.inputSchema,
            `tools.${tool.name}.inputSchema`
          ),
          ...(tool.outputSchema === undefined
            ? {}
            : {
                outputSchema: normalizeSchema(
                  tool.outputSchema,
                  `tools.${tool.name}.outputSchema`
                ),
              }),
          ...(annotations === undefined ? {} : { annotations }),
        };
      })
      .sort((left, right) => compareStableStrings(left.name, right.name)),
    resources: snapshot.resources
      .map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        ...(resource.title === undefined ? {} : { title: resource.title }),
        ...(resource.description === undefined
          ? {}
          : { description: resource.description }),
        ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
      }))
      .sort((left, right) => compareStableStrings(left.uri, right.uri)),
  };
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function stringValues(value: JsonValue | undefined): string[] | undefined {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

function isJsonTypeSubset(candidate: string, accepted: string): boolean {
  return candidate === accepted || (candidate === "integer" && accepted === "number");
}

function enumValues(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function requiredValues(schema: JsonObject): Set<string> {
  return new Set(stringValues(schema.required) ?? []);
}

function canonical(value: JsonValue | undefined): string {
  return JSON.stringify(value);
}

function addBreaking(
  changes: McpContractChange[],
  code: string,
  path: string,
  message: string
): void {
  changes.push({ code, path, message });
}

function acceptRootDialectUpgrade(
  baseline: JsonValue | undefined,
  current: JsonValue | undefined,
  path: string,
  direction: "input" | "output",
  comparison: McpContractComparison
): boolean {
  if (
    baseline !== JSON_SCHEMA_DRAFT_07_DIALECT ||
    current !== JSON_SCHEMA_2020_12_DIALECT ||
    !/^tools\.[^.]+\.(inputSchema|outputSchema)$/.test(path)
  ) {
    return false;
  }

  comparison.nonBreaking.push({
    code: `${direction}_schema_dialect_declared`,
    path: `${path}.$schema`,
    message: `The ${direction} schema dialect was upgraded from draft-07 to 2020-12.`,
  });
  return true;
}

function compareInputConstraints(
  baseline: JsonObject,
  current: JsonObject,
  path: string,
  breaking: McpContractChange[]
): void {
  for (const key of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
    "minProperties",
    "minContains",
  ]) {
    const oldValue = baseline[key];
    const newValue = current[key];
    if (
      typeof newValue === "number" &&
      (typeof oldValue !== "number" || newValue > oldValue)
    ) {
      addBreaking(
        breaking,
        "input_constraint_tightened",
        `${path}.${key}`,
        `Input constraint ${key} became stricter.`
      );
    }
  }
  for (const key of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
    "maxProperties",
    "maxContains",
  ]) {
    const oldValue = baseline[key];
    const newValue = current[key];
    if (
      typeof newValue === "number" &&
      (typeof oldValue !== "number" || newValue < oldValue)
    ) {
      addBreaking(
        breaking,
        "input_constraint_tightened",
        `${path}.${key}`,
        `Input constraint ${key} became stricter.`
      );
    }
  }
  for (const key of ["pattern", "format", "const", "multipleOf"]) {
    const oldValue = baseline[key];
    const newValue = current[key];
    if (newValue !== undefined && canonical(oldValue) !== canonical(newValue)) {
      addBreaking(
        breaking,
        "input_constraint_tightened",
        `${path}.${key}`,
        `Input constraint ${key} was added or changed.`
      );
    }
  }
  if (baseline.additionalProperties !== false && current.additionalProperties === false) {
    addBreaking(
      breaking,
      "input_additional_properties_narrowed",
      `${path}.additionalProperties`,
      "Input schema stopped accepting additional properties."
    );
  }
  if (baseline.uniqueItems !== true && current.uniqueItems === true) {
    addBreaking(
      breaking,
      "input_constraint_tightened",
      `${path}.uniqueItems`,
      "Input array items must now be unique."
    );
  }
}

function compareInputSubschema(
  baseline: JsonValue,
  current: JsonValue,
  path: string,
  comparison: McpContractComparison
): void {
  if (canonical(baseline) === canonical(current)) return;
  const baselineObject = objectValue(baseline);
  const currentObject = objectValue(current);
  if (baselineObject && currentObject) {
    compareInputSchema(baselineObject, currentObject, path, comparison);
    return;
  }
  if (baseline === false || current === true) {
    comparison.nonBreaking.push({
      code: "input_schema_widened",
      path,
      message: "Input schema was widened.",
    });
    return;
  }
  addBreaking(
    comparison.breaking,
    "input_schema_changed",
    path,
    "Input schema changed incompatibly."
  );
}

function compareInputSchema(
  baseline: JsonObject,
  current: JsonObject,
  path: string,
  comparison: McpContractComparison
): void {
  const baselineTypes = stringValues(baseline.type);
  const currentTypes = stringValues(current.type);
  if (
    (baselineTypes === undefined && currentTypes !== undefined) ||
    (baselineTypes !== undefined &&
      currentTypes !== undefined &&
      baselineTypes.some(
        (type) =>
          !currentTypes.some((currentType) =>
            isJsonTypeSubset(type, currentType)
          )
      ))
  ) {
    addBreaking(
      comparison.breaking,
      "input_type_narrowed",
      `${path}.type`,
      "Input schema no longer accepts every baseline type."
    );
  }

  const baselineEnum = enumValues(baseline.enum);
  const currentEnum = enumValues(current.enum);
  if (
    (baselineEnum === undefined && currentEnum !== undefined) ||
    (baselineEnum !== undefined &&
      currentEnum !== undefined &&
      baselineEnum.some(
        (value) => !currentEnum.some((candidate) => canonical(candidate) === canonical(value))
      ))
  ) {
    addBreaking(
      comparison.breaking,
      "input_enum_narrowed",
      `${path}.enum`,
      "Input enum no longer accepts every baseline value."
    );
  }

  if (canonical(baseline.default) !== canonical(current.default)) {
    addBreaking(
      comparison.breaking,
      "input_default_changed",
      `${path}.default`,
      "Input default changed and may alter calls that omit this value."
    );
  }

  compareInputConstraints(baseline, current, path, comparison.breaking);

  const baselineAdditionalProperties = objectValue(
    baseline.additionalProperties
  );
  const currentAdditionalProperties = objectValue(current.additionalProperties);
  if (baselineAdditionalProperties && currentAdditionalProperties) {
    compareInputSchema(
      baselineAdditionalProperties,
      currentAdditionalProperties,
      `${path}.additionalProperties`,
      comparison
    );
  } else if (
    (baseline.additionalProperties === undefined ||
      baseline.additionalProperties === true) &&
    currentAdditionalProperties
  ) {
    addBreaking(
      comparison.breaking,
      "input_additional_properties_narrowed",
      `${path}.additionalProperties`,
      "Previously unrestricted extra input fields must now match a schema."
    );
  }

  const baselineRequired = requiredValues(baseline);
  const currentRequired = requiredValues(current);
  for (const property of currentRequired) {
    if (!baselineRequired.has(property)) {
      addBreaking(
        comparison.breaking,
        "input_required_added",
        `${path}.required.${property}`,
        `Previously optional input property ${property} became required.`
      );
    }
  }

  const baselineProperties = objectValue(baseline.properties) ?? {};
  const currentProperties = objectValue(current.properties) ?? {};
  for (const [property, schema] of Object.entries(baselineProperties)) {
    const currentSchema = currentProperties[property];
    if (!Object.hasOwn(currentProperties, property)) {
      addBreaking(
        comparison.breaking,
        "input_property_removed",
        `${path}.properties.${property}`,
        `Accepted input property ${property} was removed.`
      );
      continue;
    }
    compareInputSubschema(
      schema,
      currentSchema,
      `${path}.properties.${property}`,
      comparison
    );
  }
  for (const property of Object.keys(currentProperties)) {
    if (
      Object.hasOwn(baselineProperties, property) ||
      currentRequired.has(property)
    ) {
      continue;
    }
    const breakingCount = comparison.breaking.length;
    compareInputSubschema(
      baseline.additionalProperties ?? true,
      currentProperties[property]!,
      `${path}.properties.${property}`,
      comparison
    );
    if (comparison.breaking.length === breakingCount) {
      comparison.nonBreaking.push({
        code: "input_optional_property_added",
        path: `${path}.properties.${property}`,
        message: `Optional input property ${property} was added.`,
      });
    }
  }

  const baselineItems = objectValue(baseline.items);
  const currentItems = objectValue(current.items);
  if (baselineItems && currentItems) {
    compareInputSchema(baselineItems, currentItems, `${path}.items`, comparison);
  } else if (
    (baseline.items === undefined || baseline.items === true) &&
    current.items !== undefined &&
    current.items !== true
  ) {
    addBreaking(
      comparison.breaking,
      "input_items_schema_added",
      `${path}.items`,
      "Previously unrestricted input array items must now match a schema."
    );
  } else if (
    baseline.items !== undefined &&
    baseline.items !== true &&
    (current.items === undefined || current.items === true)
  ) {
    comparison.nonBreaking.push({
      code: "input_items_schema_removed",
      path: `${path}.items`,
      message: "Input array item restrictions were removed.",
    });
  } else if (baseline.items === false && current.items !== false) {
    comparison.nonBreaking.push({
      code: "input_items_schema_widened",
      path: `${path}.items`,
      message: "Input array items changed from forbidden to conditionally accepted.",
    });
  } else if (canonical(baseline.items) !== canonical(current.items)) {
    addBreaking(
      comparison.breaking,
      "input_items_schema_changed",
      `${path}.items`,
      "Input array item constraints changed and require manual review."
    );
  }

  for (const key of MANUAL_REVIEW_SCHEMA_KEYWORDS) {
    if (
      key === "$schema" &&
      acceptRootDialectUpgrade(
        baseline[key],
        current[key],
        path,
        "input",
        comparison
      )
    ) {
      continue;
    }
    if (canonical(baseline[key]) !== canonical(current[key])) {
      addBreaking(
        comparison.breaking,
        "input_schema_composition_changed",
        `${path}.${key}`,
        `Input schema composition ${key} changed and requires manual review.`
      );
    }
  }
}

function compareOutputConstraints(
  baseline: JsonObject,
  current: JsonObject,
  path: string,
  breaking: McpContractChange[]
): void {
  for (const key of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
    "minProperties",
    "minContains",
  ]) {
    const oldValue = baseline[key];
    const newValue = current[key];
    if (
      typeof oldValue === "number" &&
      (typeof newValue !== "number" || newValue < oldValue)
    ) {
      addBreaking(
        breaking,
        "output_constraint_weakened",
        `${path}.${key}`,
        `Output constraint ${key} became weaker.`
      );
    }
  }
  for (const key of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
    "maxProperties",
    "maxContains",
  ]) {
    const oldValue = baseline[key];
    const newValue = current[key];
    if (
      typeof oldValue === "number" &&
      (typeof newValue !== "number" || newValue > oldValue)
    ) {
      addBreaking(
        breaking,
        "output_constraint_weakened",
        `${path}.${key}`,
        `Output constraint ${key} became weaker.`
      );
    }
  }
  for (const key of ["pattern", "format", "const", "multipleOf"]) {
    const oldValue = baseline[key];
    const newValue = current[key];
    if (oldValue !== undefined && canonical(oldValue) !== canonical(newValue)) {
      addBreaking(
        breaking,
        "output_constraint_weakened",
        `${path}.${key}`,
        `Output constraint ${key} was removed or changed.`
      );
    }
  }
  if (baseline.uniqueItems === true && current.uniqueItems !== true) {
    addBreaking(
      breaking,
      "output_constraint_weakened",
      `${path}.uniqueItems`,
      "Output array items are no longer guaranteed to be unique."
    );
  }
}

function compareOutputSubschema(
  baseline: JsonValue,
  current: JsonValue,
  path: string,
  comparison: McpContractComparison,
  weakeningCode = "output_schema_weakened"
): void {
  if (canonical(baseline) === canonical(current)) return;
  const baselineObject = objectValue(baseline);
  const currentObject = objectValue(current);
  if (baselineObject && currentObject) {
    compareOutputSchema(baselineObject, currentObject, path, comparison);
    return;
  }
  if (baseline === true || current === false) {
    comparison.nonBreaking.push({
      code: "output_schema_strengthened",
      path,
      message: "Output schema guarantee was strengthened.",
    });
    return;
  }
  addBreaking(
    comparison.breaking,
    weakeningCode,
    path,
    "Output schema guarantee was weakened or changed incompatibly."
  );
}

function compareOutputSchema(
  baseline: JsonObject,
  current: JsonObject,
  path: string,
  comparison: McpContractComparison
): void {
  const baselineTypes = stringValues(baseline.type);
  const currentTypes = stringValues(current.type);
  if (
    baselineTypes !== undefined &&
    (currentTypes === undefined ||
      currentTypes.some(
        (type) =>
          !baselineTypes.some((baselineType) =>
            isJsonTypeSubset(type, baselineType)
          )
      ))
  ) {
    addBreaking(
      comparison.breaking,
      "output_type_weakened",
      `${path}.type`,
      "Output schema no longer guarantees only baseline types."
    );
  }

  const baselineEnum = enumValues(baseline.enum);
  const currentEnum = enumValues(current.enum);
  if (
    baselineEnum !== undefined &&
    (currentEnum === undefined ||
      currentEnum.some(
        (value) => !baselineEnum.some((candidate) => canonical(candidate) === canonical(value))
      ))
  ) {
    addBreaking(
      comparison.breaking,
      "output_enum_weakened",
      `${path}.enum`,
      "Output enum no longer guarantees only baseline values."
    );
  }

  compareOutputConstraints(baseline, current, path, comparison.breaking);

  compareOutputSubschema(
    baseline.additionalProperties ?? true,
    current.additionalProperties ?? true,
    `${path}.additionalProperties`,
    comparison,
    "output_additional_properties_weakened"
  );

  const baselineRequired = requiredValues(baseline);
  const currentRequired = requiredValues(current);
  for (const property of baselineRequired) {
    if (!currentRequired.has(property)) {
      addBreaking(
        comparison.breaking,
        "output_required_removed",
        `${path}.required.${property}`,
        `Required output guarantee ${property} was removed.`
      );
    }
  }

  const baselineProperties = objectValue(baseline.properties) ?? {};
  const currentProperties = objectValue(current.properties) ?? {};
  for (const [property, schema] of Object.entries(baselineProperties)) {
    const currentSchema = currentProperties[property];
    if (!Object.hasOwn(currentProperties, property)) {
      addBreaking(
        comparison.breaking,
        "output_property_removed",
        `${path}.properties.${property}`,
        `Documented output property ${property} was removed.`
      );
      continue;
    }
    compareOutputSubschema(
      schema,
      currentSchema,
      `${path}.properties.${property}`,
      comparison
    );
  }
  for (const property of Object.keys(currentProperties)) {
    if (
      Object.hasOwn(baselineProperties, property) ||
      currentRequired.has(property)
    ) {
      continue;
    }
    comparison.nonBreaking.push({
      code: "output_optional_property_added",
      path: `${path}.properties.${property}`,
      message: `Optional output property ${property} was added.`,
    });
  }

  compareOutputSubschema(
    baseline.items ?? true,
    current.items ?? true,
    `${path}.items`,
    comparison,
    "output_items_schema_weakened"
  );

  for (const key of MANUAL_REVIEW_SCHEMA_KEYWORDS) {
    if (
      key === "$schema" &&
      acceptRootDialectUpgrade(
        baseline[key],
        current[key],
        path,
        "output",
        comparison
      )
    ) {
      continue;
    }
    if (canonical(baseline[key]) !== canonical(current[key])) {
      addBreaking(
        comparison.breaking,
        "output_schema_composition_changed",
        `${path}.${key}`,
        `Output schema composition ${key} changed and requires manual review.`
      );
    }
  }
}

function compareTool(
  baseline: McpToolContract,
  current: McpToolContract,
  comparison: McpContractComparison
): void {
  const path = `tools.${baseline.name}`;
  compareText(
    baseline.title,
    current.title,
    "tool_title_changed",
    `${path}.title`,
    comparison.nonBreaking
  );
  compareText(
    baseline.description,
    current.description,
    "tool_description_changed",
    `${path}.description`,
    comparison.nonBreaking
  );
  compareInputSchema(
    baseline.inputSchema,
    current.inputSchema,
    `${path}.inputSchema`,
    comparison
  );

  if (baseline.outputSchema && !current.outputSchema) {
    addBreaking(
      comparison.breaking,
      "tool_output_schema_removed",
      `${path}.outputSchema`,
      "Tool output schema was removed."
    );
  } else if (baseline.outputSchema && current.outputSchema) {
    compareOutputSchema(
      baseline.outputSchema,
      current.outputSchema,
      `${path}.outputSchema`,
      comparison
    );
  } else if (!baseline.outputSchema && current.outputSchema) {
    comparison.nonBreaking.push({
      code: "tool_output_schema_added",
      path: `${path}.outputSchema`,
      message: "Tool output schema was added.",
    });
  }

  const annotations = [
    ...new Set([
      ...CONTRACT_ANNOTATIONS,
      ...Object.keys(baseline.annotations ?? {}),
      ...Object.keys(current.annotations ?? {}),
    ]),
  ].sort(compareStableStrings);
  for (const annotation of annotations) {
    const oldValue = baseline.annotations?.[annotation];
    const newValue = current.annotations?.[annotation];
    if (oldValue === newValue) continue;
    if (oldValue === undefined) {
      comparison.nonBreaking.push({
        code: "tool_annotation_added",
        path: `${path}.annotations.${annotation}`,
        message: `Tool annotation ${annotation} was added.`,
      });
    } else {
      addBreaking(
        comparison.breaking,
        "tool_annotation_changed",
        `${path}.annotations.${annotation}`,
        `Tool annotation ${annotation} changed from ${oldValue} to ${String(newValue)}.`
      );
    }
  }
}

export function compareMcpContracts(
  baseline: McpContractManifest,
  current: McpContractManifest
): McpContractComparison {
  const comparison: McpContractComparison = {
    breaking: [],
    nonBreaking: [],
  };

  if (baseline.server.name !== current.server.name) {
    addBreaking(
      comparison.breaking,
      "server_name_changed",
      "server.name",
      "MCP server name changed."
    );
  }
  if (baseline.server.version !== current.server.version) {
    comparison.nonBreaking.push({
      code: "server_version_changed",
      path: "server.version",
      message: `Server version changed from ${baseline.server.version} to ${current.server.version}.`,
    });
  }

  const currentTools = new Map(current.tools.map((tool) => [tool.name, tool]));
  for (const tool of baseline.tools) {
    const currentTool = currentTools.get(tool.name);
    if (!currentTool) {
      addBreaking(
        comparison.breaking,
        "tool_removed",
        `tools.${tool.name}`,
        `Public tool ${tool.name} was removed.`
      );
      continue;
    }
    compareTool(tool, currentTool, comparison);
  }
  const baselineToolNames = new Set(baseline.tools.map((tool) => tool.name));
  for (const tool of current.tools) {
    if (baselineToolNames.has(tool.name)) continue;
    comparison.nonBreaking.push({
      code: "tool_added",
      path: `tools.${tool.name}`,
      message: `Public tool ${tool.name} was added.`,
    });
  }

  const currentResources = new Map(
    current.resources.map((resource) => [resource.uri, resource])
  );
  for (const resource of baseline.resources) {
    const currentResource = currentResources.get(resource.uri);
    if (!currentResource) {
      addBreaking(
        comparison.breaking,
        "resource_removed",
        `resources.${resource.uri}`,
        `Public resource ${resource.uri} was removed.`
      );
      continue;
    }
    if (resource.mimeType !== currentResource.mimeType) {
      addBreaking(
        comparison.breaking,
        "resource_mime_type_changed",
        `resources.${resource.uri}.mimeType`,
        `Resource MIME type changed from ${String(resource.mimeType)} to ${String(
          currentResource.mimeType
        )}.`
      );
    }
    compareText(
      resource.name,
      currentResource.name,
      "resource_name_changed",
      `resources.${resource.uri}.name`,
      comparison.nonBreaking
    );
    compareText(
      resource.title,
      currentResource.title,
      "resource_title_changed",
      `resources.${resource.uri}.title`,
      comparison.nonBreaking
    );
    compareText(
      resource.description,
      currentResource.description,
      "resource_description_changed",
      `resources.${resource.uri}.description`,
      comparison.nonBreaking
    );
  }
  const baselineResourceUris = new Set(
    baseline.resources.map((resource) => resource.uri)
  );
  for (const resource of current.resources) {
    if (baselineResourceUris.has(resource.uri)) continue;
    comparison.nonBreaking.push({
      code: "resource_added",
      path: `resources.${resource.uri}`,
      message: `Public resource ${resource.uri} was added.`,
    });
  }

  return comparison;
}

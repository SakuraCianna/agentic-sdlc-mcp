import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
  name: string;
  version: string;
  mcpName?: string;
}

interface RegistryEnvironmentVariable {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: string;
  default?: string;
}

interface RegistryServerMetadata {
  $schema: string;
  name: string;
  title?: string;
  description: string;
  version: string;
  repository?: {
    url: string;
    source: string;
    id?: string;
  };
  packages?: Array<{
    registryType: string;
    identifier: string;
    version?: string;
    transport: { type: string };
    environmentVariables?: RegistryEnvironmentVariable[];
  }>;
}

async function readJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8")
  ) as T;
}

describe("MCP Registry metadata", () => {
  it("keeps the Registry identity and all published versions aligned", async () => {
    const pkg = await readJson<PackageMetadata>("package.json");
    const server = await readJson<RegistryServerMetadata>("server.json");
    const registryPackage = server.packages?.[0];

    expect(pkg.mcpName).toBe("io.github.SakuraCianna/agentic-sdlc-mcp");
    expect(server.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"
    );
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe("1.8.0");
    expect(server.version).toBe(pkg.version);
    expect(registryPackage).toMatchObject({
      registryType: "npm",
      identifier: "agentic-sdlc-mcp",
      version: pkg.version,
      transport: { type: "stdio" },
    });
  });

  it("publishes transparent repository provenance and bounded configuration metadata", async () => {
    const server = await readJson<RegistryServerMetadata>("server.json");
    const environmentVariables = server.packages?.[0]?.environmentVariables ?? [];

    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.repository).toEqual({
      url: "https://github.com/SakuraCianna/agentic-sdlc-mcp",
      source: "github",
      id: "1290091977",
    });

    expect(environmentVariables.map((item) => item.name)).toEqual([
      "GITHUB_TOKEN",
      "GITHUB_OWNER",
      "GITHUB_REPO",
      "SDLC_DEFAULT_BRANCH",
    ]);
    expect(environmentVariables.find((item) => item.name === "GITHUB_TOKEN")).toMatchObject({
      isRequired: true,
      isSecret: true,
      format: "string",
    });
    expect(
      environmentVariables
        .filter((item) => item.name !== "GITHUB_TOKEN")
        .every((item) => item.isRequired !== true && item.isSecret !== true)
    ).toBe(true);
  });
});

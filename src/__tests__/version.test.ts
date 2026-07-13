import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { SERVER_INFO } from "../version.js";

describe("SERVER_INFO", () => {
  it("keeps the MCP runtime version aligned with package.json", async () => {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      name: string;
      version: string;
    };

    expect(SERVER_INFO.name).toBe(packageJson.name);
    expect(SERVER_INFO.version).toBe("1.7.0");
    expect(SERVER_INFO.version).toBe(packageJson.version);
  });
});

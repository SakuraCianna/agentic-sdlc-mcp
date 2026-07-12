import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("secret scan workflow", () => {
  it("runs pinned Gitleaks v3 with least privilege and no write-side features", async () => {
    const workflowUrl = new URL("../../../.github/workflows/secret-scan.yml", import.meta.url);
    const content = await readFile(workflowUrl, "utf8");
    const workflow = parse(content) as {
      permissions?: Record<string, string>;
      jobs?: Record<
        string,
        { name?: string; steps?: Array<{ uses?: string; env?: Record<string, string> }> }
      >;
    };
    const job = workflow.jobs?.gitleaks;
    const uses = job?.steps?.map((step) => step.uses).filter(Boolean) ?? [];
    const scannerStep = job?.steps?.find((step) => step.uses?.startsWith("gitleaks/gitleaks-action@"));

    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job?.name).toBe("gitleaks");
    expect(uses).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
    expect(uses).toContain("gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e");
    expect(scannerStep?.env).toMatchObject({
      GITLEAKS_CONFIG: ".gitleaks.toml",
      GITLEAKS_ENABLE_COMMENTS: "false",
      GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false",
    });
  });

  it("narrows the fixture allowlist to one rule and one test file", async () => {
    const configUrl = new URL("../../../.gitleaks.toml", import.meta.url);
    const config = await readFile(configUrl, "utf8");

    expect(config).toContain('id = "generic-api-key"');
    expect(config).toContain(
      "src/__tests__/review/pull-request-review\\.test\\.ts$"
    );
    expect(config).not.toMatch(/\[\[allowlists\]\]/);
  });
});

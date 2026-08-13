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
    expect(uses).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(uses).toContain("gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e");
    expect(scannerStep?.env).toMatchObject({
      GITLEAKS_CONFIG: ".gitleaks.toml",
      GITLEAKS_ENABLE_COMMENTS: "false",
      GITLEAKS_ENABLE_UPLOAD_ARTIFACT: "false",
    });
  });

  it("keeps secret-scanner fixture allowlists rule-scoped and narrowly bound", async () => {
    const configUrl = new URL("../../../.gitleaks.toml", import.meta.url);
    const config = await readFile(configUrl, "utf8");
    const syntheticAwsFixture = ["AKIA", "1234567890ABCDEF"].join("");

    expect(config).toContain('id = "generic-api-key"');
    const awsRuleSection = config
      .split('[[rules]]\nid = "aws-access-token"')[1]
      ?.split("\n[[rules]]")[0];
    expect(awsRuleSection).toBeDefined();

    const awsAllowlists = awsRuleSection
      ?.split("[[rules.allowlists]]")
      .slice(1)
      .map((block) =>
        block
          .trim()
          .split("\n")
          .map((line) => line.trim())
          .join("\n")
      );
    expect(awsAllowlists).toEqual([
      [
        'description = "Ignore one synthetic AWS-format fixture in its immutable historical commit only"',
        'condition = "AND"',
        'regexTarget = "line"',
        'commits = ["fd9e5d5d3b6a4294d13302e669486c948bfa0800"]',
        "paths = ['''src/__tests__/review/pull-request-review\\.test\\.ts$''']",
        `regexes = ['''^\\s*\"${syntheticAwsFixture}\",\\s*$''']`,
      ].join("\n"),
      [
        'description = "Ignore the historical contract assertion for the same synthetic fixture only"',
        'condition = "AND"',
        'regexTarget = "line"',
        'commits = ["b96e4626c5ffa2fbd7bafb71bdf7205e726521d9"]',
        "paths = ['''src/__tests__/workflows/secret-scan-workflow\\.test\\.ts$''']",
        `regexes = ['''^\\s*\"regexes = .*${syntheticAwsFixture}.*\"\\s*$''']`,
      ].join("\n"),
    ]);
    expect(config).not.toMatch(/\[\[allowlists\]\]/);
    expect(config).not.toMatch(/disabledRules/u);
  });
});

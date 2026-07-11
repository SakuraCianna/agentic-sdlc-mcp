/**
 * Tests for src/tools/workflow-permissions-audit.ts
 * Covers: YAML parsing, permissions normalization, findings generation, and handler execution loops.
 */

import { describe, it, expect, vi } from "vitest";

// Mock the config module to isolate GitHub credentials and settings
vi.mock("../../config.js", () => ({
  config: {
    githubToken: "test-token",
    githubOwner: "default-owner",
    githubRepo: "default-repo",
    defaultBranch: "main",
    isSmokeMode: false,
  },
  isSmokeMode: false,
}));

// Dynamically import the target functions to ensure vi.mock has hoisted correctly
const {
  parseWorkflowYaml,
  normalizePermissions,
  generatePermissionsFindings,
  evaluateWorkflowContents,
  handleWorkflowPermissionsAudit,
} = await import("../../tools/workflow-permissions-audit.js");

import type { WorkflowPermissionsAuditInput } from "../../tools/workflow-permissions-audit.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

describe("parseWorkflowYaml", () => {
  it("parses valid YAML actions workflow structure correctly", () => {
    const yaml = `
name: CI
on: [push, pull_request]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - run: echo
`;
    const parsed = parseWorkflowYaml(yaml);
    expect(parsed).not.toBeNull();
    expect(parsed!.permissions).toEqual({ contents: "read" });
    expect(parsed!.triggers).toEqual(["push", "pull_request"]);
    expect(parsed!.jobs).toEqual({
      build: { permissions: { issues: "write" } },
    });
  });

  it("gracefully returns null for empty or invalid YAML mappings", () => {
    expect(parseWorkflowYaml("")).toBeNull();
    expect(parseWorkflowYaml("not a yaml mapping")).toBeNull();
    expect(parseWorkflowYaml("- list item 1\n- list item 2")).toBeNull();
  });

  it("extracts different trigger format types (scalar, sequence, mapping)", () => {
    // Scalar format
    const yamlScalar = `
on: push
jobs:
  job1:
    steps: []
`;
    expect(parseWorkflowYaml(yamlScalar)!.triggers).toEqual(["push"]);

    // Mapping format
    const yamlMap = `
on:
  push:
    branches: [main]
  pull_request:
jobs:
  job1:
    steps: []
`;
    expect(parseWorkflowYaml(yamlMap)!.triggers).toEqual(["push", "pull_request"]);
  });
});

describe("normalizePermissions", () => {
  it("returns null when permissions attribute is not declared", () => {
    expect(normalizePermissions(undefined)).toBeNull();
  });

  it("handles write-all string setting", () => {
    const result = normalizePermissions("write-all");
    expect(result).toEqual({ writeAll: true, scopes: {} });
  });

  it("parses mapping of permissions into normal objects", () => {
    const value = {
      contents: "read",
      issues: "write",
      actions: "none",
      invalidScopeValue: "super-admin", // invalid permission levels should be omitted
    };
    const result = normalizePermissions(value);
    expect(result).toEqual({
      writeAll: false,
      scopes: {
        contents: "read",
        issues: "write",
        actions: "none",
      },
    });
  });

  it("falls back gracefully for invalid types", () => {
    expect(normalizePermissions(["contents", "read"])).toEqual({ writeAll: false, scopes: {} });
    expect(normalizePermissions(123)).toEqual({ writeAll: false, scopes: {} });
  });
});

describe("generatePermissionsFindings", () => {
  it("emits a medium vulnerability finding if permissions is omitted at all levels", () => {
    const parsed = {
      permissions: undefined,
      jobs: {
        build: { permissions: undefined },
      },
      triggers: ["push"],
    };
    const findings = generatePermissionsFindings("ci.yml", parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("medium");
    expect(findings[0].description).toContain("no `permissions` block is declared");
  });

  it("does not report issues for explicit empty permissions mappings", () => {
    const parsed = {
      permissions: {},
      jobs: {},
      triggers: ["push"],
    };
    const findings = generatePermissionsFindings("ci.yml", parsed);
    expect(findings).toHaveLength(0);
  });

  it("flags write-all permissions declarations as critical", () => {
    const parsed = {
      permissions: "write-all",
      jobs: {},
      triggers: ["push"],
    };
    const findings = generatePermissionsFindings("ci.yml", parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].description).toContain("grants `write-all`");
  });

  it("flags pull_request_target trigger combined with write permissions as critical", () => {
    const parsed = {
      permissions: undefined,
      jobs: {
        deploy: {
          permissions: {
            contents: "write",
          },
        },
      },
      triggers: ["pull_request_target"],
    };
    const findings = generatePermissionsFindings("target-deploy.yml", parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].description).toContain("triggered by `pull_request_target` while job `deploy`'s `permissions` grants write access");
  });

  it("keeps clean of warnings on pull_request_target if it strictly requests read-only scopes", () => {
    const parsed = {
      permissions: {
        contents: "read",
      },
      jobs: {},
      triggers: ["pull_request_target"],
    };
    const findings = generatePermissionsFindings("safe.yml", parsed);
    expect(findings).toHaveLength(0);
  });
});

describe("handleWorkflowPermissionsAudit", () => {
  function makeMockOctokit(opts: {
    files?: Array<{ name: string; path: string; content?: string }>;
    defaultBranch?: string;
  } = {}) {
    const defaultBranch = opts.defaultBranch ?? "main";
    const files = opts.files ?? [];

    return {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { default_branch: defaultBranch },
        }),
        getContent: vi.fn().mockImplementation((params) => {
          if (params.path === ".github/workflows") {
            return Promise.resolve({
              data: files.map((f) => ({
                type: "file",
                name: f.name,
                path: f.path,
              })),
            });
          }
          const matched = files.find((f) => f.path === params.path);
          if (matched) {
            return Promise.resolve({
              data: {
                type: "file",
                path: matched.path,
                content: Buffer.from(matched.content ?? "").toString("base64"),
              },
            });
          }
          const err = new Error("Not Found");
          (err as any).status = 404;
          return Promise.reject(err);
        }),
      },
    } as any;
  }

  it("yields least_privilege conclusion if all workflows declare explicit minimal permissions", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          name: "ci.yml",
          path: ".github/workflows/ci.yml",
          content: "permissions:\n  contents: read\njobs:\n  b:\n    steps: []",
        },
      ],
    });

    const params: WorkflowPermissionsAuditInput = {};
    const { structured } = await handleWorkflowPermissionsAudit(params, REF, octokit);

    expect(structured.conclusion).toBe("least_privilege");
    expect(structured.workflowsScanned).toEqual([".github/workflows/ci.yml"]);
    expect(structured.findings).toHaveLength(0);
  });

  it("yields needs_review conclusion when a scanned workflow fails to specify permissions", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          name: "build.yml",
          path: ".github/workflows/build.yml",
          content: "name: Build\njobs:\n  b:\n    steps: []",
        },
      ],
    });

    const params: WorkflowPermissionsAuditInput = {};
    const { structured } = await handleWorkflowPermissionsAudit(params, REF, octokit);

    expect(structured.conclusion).toBe("needs_review");
    expect(structured.findings).toHaveLength(1);
    expect(structured.findings[0].severity).toBe("medium");
  });

  it("yields over_permissioned conclusion when a workflow uses write-all", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          name: "release.yml",
          path: ".github/workflows/release.yml",
          content: "permissions: write-all\njobs:\n  b:\n    steps: []",
        },
      ],
    });

    const params: WorkflowPermissionsAuditInput = {};
    const { structured } = await handleWorkflowPermissionsAudit(params, REF, octokit);

    expect(structured.conclusion).toBe("over_permissioned");
    expect(structured.findings).toHaveLength(1);
    expect(structured.findings[0].severity).toBe("critical");
  });

  it("collects and logs API Errors gracefully without failing completely", async () => {
    const octokit = {
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { default_branch: "main" },
        }),
        getContent: vi.fn().mockRejectedValue({
          status: 500,
          response: { data: { message: "Internal server error" } },
        }),
      },
    } as any;

    const params: WorkflowPermissionsAuditInput = {};
    const { structured } = await handleWorkflowPermissionsAudit(params, REF, octokit);

    expect(structured.errors).toHaveLength(1);
    expect(structured.errors[0]).toContain("Internal server error");
  });

  it("logs errors when encountering invalid YAML format", async () => {
    const octokit = makeMockOctokit({
      files: [
        {
          name: "invalid.yml",
          path: ".github/workflows/invalid.yml",
          content: "this is invalid [yaml format",
        },
      ],
    });

    const params: WorkflowPermissionsAuditInput = {};
    const { structured } = await handleWorkflowPermissionsAudit(params, REF, octokit);

    expect(structured.errors).toHaveLength(1);
    expect(structured.errors[0]).toContain("unable to parse");
    expect(structured.workflowsScanned).toHaveLength(0);
  });
});

describe("evaluateWorkflowContents", () => {
  it("evaluates supplied complete workflow content and reports parse errors", () => {
    const result = evaluateWorkflowContents([
      {
        filename: ".github/workflows/safe.yml",
        content: "permissions:\n  contents: read\njobs:\n  test:\n    steps: []",
      },
      {
        filename: ".github/workflows/unsafe.yml",
        content: "on: pull_request_target\npermissions: write-all\njobs: {}",
      },
      { filename: ".github/workflows/invalid.yml", content: "not: [valid" },
    ]);

    expect(result.workflowsScanned).toEqual([
      ".github/workflows/safe.yml",
      ".github/workflows/unsafe.yml",
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "critical", category: "Workflow Permissions" })
    );
    expect(result.errors).toEqual([
      ".github/workflows/invalid.yml: unable to parse as a GitHub Actions workflow (expected a YAML mapping at the document root).",
    ]);
  });
});

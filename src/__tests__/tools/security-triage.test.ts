/**
 * Tests for src/tools/security-triage.ts
 * Covers: normalizeSeverity, computeSeverityCounts, handleSecurityTriage errors
 */

import { describe, it, expect, vi } from "vitest";

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

vi.mock("../../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      throw new Error("client initialization failed");
    },
  };
});

const {
  normalizeSeverity,
  computeSeverityCounts,
  severityIcon,
  handleSecurityTriage,
  registerSecurityTriageTool,
} = await import("../../tools/security-triage.js");

import type { SecurityTriageInput } from "../../tools/security-triage.js";
import type { RepoRef } from "../../types.js";
import { adaptSecurityTriageEvidence } from "../../evidence/adapters.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };
type CodeScanningRule = Awaited<ReturnType<
  Parameters<typeof handleSecurityTriage>[2]["codeScanning"]["listAlertsForRepo"]
>>["data"][number]["rule"];

// ---------------------------------------------------------------------------
// normalizeSeverity
// ---------------------------------------------------------------------------

describe("normalizeSeverity", () => {
  it.each([
    ["critical", "critical"],
    ["high", "high"],
    ["medium", "medium"],
    ["low", "low"],
    ["error", "high"],
    ["warning", "medium"],
    ["note", "low"],
    ["unknown_value", "info"],
    [null, "info"],
    [undefined, "info"],
    ["CRITICAL", "critical"], // case-insensitive
  ])("normalizes %s -> %s", (input, expected) => {
    expect(normalizeSeverity(input as string | null | undefined)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// computeSeverityCounts
// ---------------------------------------------------------------------------

describe("computeSeverityCounts", () => {
  it("counts alerts by severity", () => {
    const alerts = [
      { id: 1, severity: "critical" as const, summary: "S", state: "open", url: null },
      { id: 2, severity: "critical" as const, summary: "S", state: "open", url: null },
      { id: 3, severity: "high" as const, summary: "S", state: "open", url: null },
      { id: 4, severity: "low" as const, summary: "S", state: "open", url: null },
    ];
    const counts = computeSeverityCounts(alerts);
    expect(counts.critical).toBe(2);
    expect(counts.high).toBe(1);
    expect(counts.medium).toBe(0);
    expect(counts.low).toBe(1);
    expect(counts.info).toBe(0);
  });

  it("returns all zeros for empty input", () => {
    const counts = computeSeverityCounts([]);
    expect(counts.critical).toBe(0);
    expect(counts.high).toBe(0);
    expect(counts.medium).toBe(0);
    expect(counts.low).toBe(0);
    expect(counts.info).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// severityIcon
// ---------------------------------------------------------------------------

describe("severityIcon", () => {
  it("returns a non-empty string for all known severities", () => {
    for (const s of ["critical", "high", "medium", "low", "info"]) {
      expect(severityIcon(s)).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// handleSecurityTriage — permission errors
// ---------------------------------------------------------------------------

describe("handleSecurityTriage — permission errors", () => {
  it("prioritizes GitHub security severity and preserves blocking downstream evidence", async () => {
    const rules: CodeScanningRule[] = [
      { id: "critical-rule", severity: "warning", security_severity_level: "critical" },
      { id: "high-rule", severity: "note", security_severity_level: "high" },
      { id: "medium-rule", severity: "error", security_severity_level: "medium" },
      { id: "low-rule", severity: "error", security_severity_level: "low" },
    ];
    const octokit = {
      codeScanning: {
        listAlertsForRepo: vi.fn().mockResolvedValue({
          data: rules.map((rule, index) => ({ number: index + 1, state: "open", rule })),
        }),
      },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured, text } = await handleSecurityTriage(
      { includeCodeScanning: true, includeDependabot: false, includeSecretScanning: false },
      REF,
      octokit
    );
    const evidence = adaptSecurityTriageEvidence(
      structured, "2026-10-14T00:00:00.000Z", "test-org/test-repo", "1.10.0"
    );

    expect(structured.alerts.map((alert) => alert.severity)).toEqual([
      "critical", "high", "medium", "low",
    ]);
    expect(structured.severityCounts).toEqual({ critical: 1, high: 1, medium: 1, low: 1, info: 0 });
    expect(structured.errors).toEqual([]);
    expect(text).toContain("[SECURITY CRITICAL] Fix 1 critical alert(s)");
    expect(evidence).toMatchObject({ state: "failed", completeness: "complete" });
    expect(evidence.reason).toContain("2 open critical or high");
  });

  it.each(["critical", "high"] as const)("keeps a warning-level %s security alert release-blocking", async (securitySeverity) => {
    const rule: CodeScanningRule = { severity: "warning", security_severity_level: securitySeverity };
    const octokit = {
      codeScanning: { listAlertsForRepo: vi.fn().mockResolvedValue({ data: [{ number: 1, rule }] }) },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured } = await handleSecurityTriage(
      { includeCodeScanning: true, includeDependabot: false, includeSecretScanning: false },
      REF,
      octokit
    );
    const evidence = adaptSecurityTriageEvidence(
      structured, "2026-10-14T00:00:00.000Z", "test-org/test-repo", "1.10.0"
    );

    expect(structured.alerts[0].severity).toBe(securitySeverity);
    expect(evidence.state).toBe("failed");
    expect(evidence.reason).toContain("1 open critical or high");
    expect(evidence.reason).not.toContain("No open");
  });

  it.each([
    { rule: { severity: "error" } satisfies CodeScanningRule, expected: "high" },
    { rule: { severity: "warning", security_severity_level: null } satisfies CodeScanningRule, expected: "medium" },
    { rule: { severity: "note" } satisfies CodeScanningRule, expected: "low" },
    { rule: { severity: "none" } satisfies CodeScanningRule, expected: "info" },
  ])("uses ordinary severity when security severity is absent: $expected", async ({ rule, expected }) => {
    const octokit = {
      codeScanning: { listAlertsForRepo: vi.fn().mockResolvedValue({ data: [{ number: 1, rule }] }) },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured } = await handleSecurityTriage(
      { includeCodeScanning: true, includeDependabot: false, includeSecretScanning: false },
      REF,
      octokit
    );

    expect(structured.alerts[0].severity).toBe(expected);
    expect(structured.errors).toEqual([]);
  });

  it.each([
    { severity: "warning", security_severity_level: "unrecognized" },
    { severity: "note", security_severity_level: 7 },
    { severity: "unrecognized" },
    { severity: null, security_severity_level: null },
    {},
  ])("keeps unsupported severity evidence unverified: %j", async (rule) => {
    const octokit = {
      codeScanning: { listAlertsForRepo: vi.fn().mockResolvedValue({ data: [{ number: 1, rule }] }) },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured } = await handleSecurityTriage(
      { includeCodeScanning: true, includeDependabot: false, includeSecretScanning: false },
      REF,
      octokit
    );
    const evidence = adaptSecurityTriageEvidence(
      structured, "2026-10-14T00:00:00.000Z", "test-org/test-repo", "1.10.0"
    );

    expect(structured.alerts).toHaveLength(1);
    expect(structured.errors.join(" ")).toContain("Code Scanning");
    expect(structured.errors.join(" ")).toContain("severity");
    expect(evidence).toMatchObject({ state: "unverified", completeness: "partial" });
    expect(evidence.reason).toContain("incomplete security evidence");
  });

  it("includes error message when code scanning permission is denied", async () => {
    const mockOctokit = {
      codeScanning: {
        listAlertsForRepo: vi.fn().mockRejectedValue({ status: 403, response: { data: { message: "Resource not accessible" } } }),
      },
      dependabot: {
        listAlertsForRepo: vi.fn().mockResolvedValue({ data: [] }),
      },
      secretScanning: {
        listAlertsForRepo: vi.fn().mockResolvedValue({ data: [] }),
      },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const params: SecurityTriageInput = {
      includeCodeScanning: true,
      includeDependabot: false,
      includeSecretScanning: false,
    };

    const { structured, text } = await handleSecurityTriage(params, REF, mockOctokit);

    expect(structured.errors.length).toBeGreaterThan(0);
    expect(structured.errors[0]).toContain("Code Scanning");
    expect(text).toContain("Evidence Errors");
  });

  it("collects alerts from all three sources when all succeed", async () => {
    const mockOctokit = {
      codeScanning: {
        listAlertsForRepo: vi.fn().mockResolvedValue({
          data: [{
            number: 1,
            state: "open",
            html_url: "https://github.com/a/b/1",
            rule: { severity: "high", description: "SQL injection", id: "sql" },
          }],
        }),
      },
      dependabot: {
        listAlertsForRepo: vi.fn().mockResolvedValue({
          data: [{
            number: 2,
            state: "open",
            html_url: "https://github.com/a/b/2",
            security_advisory: { severity: "medium", summary: "CVE-2025-1234" },
            dependency: { package: { name: "lodash" } },
            fixed_at: null,
            dismissed_at: null,
          }],
        }),
      },
      secretScanning: {
        listAlertsForRepo: vi.fn().mockResolvedValue({
          data: [{
            number: 3,
            state: "open",
            html_url: "https://github.com/a/b/3",
            secret_type: "github_token",
            secret_type_display_name: "GitHub Token",
          }],
        }),
      },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const params: SecurityTriageInput = {
      includeCodeScanning: true,
      includeDependabot: true,
      includeSecretScanning: true,
    };

    const { structured } = await handleSecurityTriage(params, REF, mockOctokit);

    expect(structured.errors).toHaveLength(0);
    expect(structured.alerts).toHaveLength(3);
    // Secret scanning alert should be "critical"
    const secretAlert = structured.alerts.find((a) => a.summary.includes("GitHub Token"));
    expect(secretAlert?.severity).toBe("critical");
    // Sorted by severity: critical first
    expect(structured.alerts[0].severity).toBe("critical");
  });

  it("returns empty alerts and no errors when all categories are disabled", async () => {
    const mockOctokit = {
      codeScanning: { listAlertsForRepo: vi.fn() },
      dependabot: { listAlertsForRepo: vi.fn() },
      secretScanning: { listAlertsForRepo: vi.fn() },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const params: SecurityTriageInput = {
      includeCodeScanning: false,
      includeDependabot: false,
      includeSecretScanning: false,
    };

    const { structured } = await handleSecurityTriage(params, REF, mockOctokit);

    expect(structured.alerts).toHaveLength(0);
    expect(structured.errors).toHaveLength(0);
    expect(structured.truncatedSources).toEqual([]);
    expect(mockOctokit.codeScanning.listAlertsForRepo).not.toHaveBeenCalled();
  });

  it("marks alert evidence as truncated when a source exceeds its collection budget", async () => {
    const listAlertsForRepo = vi.fn().mockImplementation(
      ({ page }: { page: number }) => Promise.resolve({
        data:
          page <= 2
            ? Array.from({ length: 100 }, (_, index) => ({
                number: (page - 1) * 100 + index + 1,
                state: "open",
                html_url: null,
                rule: { severity: "low", description: "bounded alert" },
              }))
            : [{
                number: 201,
                state: "open",
                html_url: null,
                rule: { severity: "critical", description: "beyond budget" },
              }],
      })
    );
    const mockOctokit = {
      codeScanning: { listAlertsForRepo },
      dependabot: { listAlertsForRepo: vi.fn() },
      secretScanning: { listAlertsForRepo: vi.fn() },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured, text } = await handleSecurityTriage(
      {
        includeCodeScanning: true,
        includeDependabot: false,
        includeSecretScanning: false,
      },
      REF,
      mockOctokit
    );

    expect(structured.alerts).toHaveLength(200);
    expect(structured.truncatedSources).toEqual(["code_scanning"]);
    expect(structured.markdownOmittedAlertCount).toBe(150);
    expect(text).toContain("Collection Limits");
    expect(text).toContain("not verified");
    expect(text).toContain("150 additional alert(s) omitted");
    expect(text.length).toBeLessThan(30_000);
  });

  it("keeps successful sources when one source fails and uses stable missing-field fallbacks", async () => {
    const mockOctokit = {
      codeScanning: {
        listAlertsForRepo: vi.fn().mockRejectedValue({
          status: 403,
          response: { data: { message: "denied" } },
        }),
      },
      dependabot: {
        listAlertsForRepo: vi.fn().mockResolvedValue({
          data: [{
            number: 7,
            security_advisory: null,
            dependency: null,
            fixed_at: "2026-07-01T00:00:00Z",
            dismissed_at: "2026-07-02T00:00:00Z",
          }],
        }),
      },
      secretScanning: {
        listAlertsForRepo: vi.fn().mockResolvedValue({ data: [{}] }),
      },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured, text } = await handleSecurityTriage(
      {
        includeCodeScanning: true,
        includeDependabot: true,
        includeSecretScanning: true,
      },
      REF,
      mockOctokit
    );

    expect(structured.errors).toHaveLength(1);
    expect(structured.alerts).toEqual([
      expect.objectContaining({
        id: 0,
        severity: "critical",
        summary: "[Secret Scanning] Unknown secret type",
      }),
      expect.objectContaining({
        id: 7,
        severity: "info",
        summary: "[Dependabot] Dependency vulnerability in unknown",
        state: "open",
        url: null,
        fixedAt: "2026-07-01T00:00:00Z",
        dismissedAt: "2026-07-02T00:00:00Z",
      }),
    ]);
    expect(text).toContain("Evidence Errors");
    expect(text).toContain("2");
  });

  it("bounds and escapes untrusted alert values in Markdown while preserving structured evidence", async () => {
    const description = "Finding\n## forged [click](javascript:alert(1)) " + "x".repeat(500);
    const maliciousUrl = "javascript:alert(1)\n## forged-url";
    const mockOctokit = {
      codeScanning: {
        listAlertsForRepo: vi.fn().mockResolvedValue({
          data: [{
            number: 9,
            state: "open",
            html_url: maliciousUrl,
            rule: { severity: "high", description, id: "fallback-id" },
          }],
        }),
      },
      dependabot: { listAlertsForRepo: vi.fn() },
      secretScanning: { listAlertsForRepo: vi.fn() },
    } as unknown as Parameters<typeof handleSecurityTriage>[2];

    const { structured, text } = await handleSecurityTriage(
      {
        includeCodeScanning: true,
        includeDependabot: false,
        includeSecretScanning: false,
      },
      REF,
      mockOctokit
    );

    expect(structured.alerts[0]).toMatchObject({
      summary: `[Code Scanning] ${description}`,
      url: maliciousUrl,
    });
    expect(text).not.toContain("\n## forged");
    expect(text).not.toContain("[click](javascript:");
    expect(text).not.toContain("](" + maliciousUrl);
    expect(text).toContain("\\#\\# forged \\[click\\]\\(javascript:alert\\(1\\)\\)");
    expect(text.length).toBeLessThan(2_000);
  });
});

describe("registerSecurityTriageTool", () => {
  it("returns a safe MCP error when tool initialization fails", async () => {
    let handler: ((params: SecurityTriageInput) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (
        _name: string,
        _definition: unknown,
        registeredHandler: (params: SecurityTriageInput) => Promise<unknown>
      ) => {
        handler = registeredHandler;
      },
    };

    registerSecurityTriageTool(
      server as unknown as Parameters<typeof registerSecurityTriageTool>[0]
    );
    const result = await handler?.({
      owner: "test-org",
      repo: "test-repo",
      includeCodeScanning: true,
      includeDependabot: true,
      includeSecretScanning: true,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text" }],
    });
    expect(JSON.stringify(result)).not.toContain("client initialization failed");
  });
});

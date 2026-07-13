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

const {
  normalizeSeverity,
  computeSeverityCounts,
  severityIcon,
  handleSecurityTriage,
} = await import("../../tools/security-triage.js");

import type { SecurityTriageInput } from "../../tools/security-triage.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };

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
    expect(text).toContain("Permission Errors");
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
    expect(mockOctokit.codeScanning.listAlertsForRepo).not.toHaveBeenCalled();
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
    expect(text).toContain("Permission Errors");
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

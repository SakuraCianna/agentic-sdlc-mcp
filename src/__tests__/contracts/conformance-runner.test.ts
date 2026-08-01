import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_PROTOCOL_VERSION,
  CONFORMANCE_SUITE,
  CONFORMANCE_TOOL_VERSION,
  assertConformanceBaselineMatches,
  closeConformanceServerForSuccess,
  createConformanceExitError,
  renderExpectedFailuresYaml,
  sanitizeConformanceChecks,
  validateConformanceBaseline,
} from "../../../scripts/run-conformance-pilot.mjs";

const createBaseline = () => ({
  schemaVersion: 1,
  toolVersion: CONFORMANCE_TOOL_VERSION,
  protocolVersion: CONFORMANCE_PROTOCOL_VERSION,
  suite: CONFORMANCE_SUITE,
  expectedFailures: [
    {
      scenario: "prompts-list",
      reason: "The local product does not advertise MCP prompts.",
      owner: "SakuraCianna",
      removeWhen: "Prompt support is intentionally added to the public contract.",
    },
    {
      scenario: "tools-call-simple-text",
      reason: "The upstream scenario targets an everything-server fixture tool.",
      owner: "SakuraCianna",
      removeWhen: "The runner supports product-specific tool mappings.",
    },
  ],
});

describe("MCP Conformance pilot runner", () => {
  it("propagates a successful-run cleanup failure", async () => {
    await expect(closeConformanceServerForSuccess({
      serverUrl: "http://127.0.0.1:43123/mcp",
      close: async () => {
        throw new Error("close failed");
      },
    })).rejects.toThrow("close failed");
  });

  it("reports a bounded process failure without accepting raw output", () => {
    const error = createConformanceExitError(1);

    expect(error.message).toBe(
      "Conformance process exited with 1; isolated raw output was withheld from logs."
    );
    expect(error.message).not.toContain("stdout");
    expect(error.message).not.toContain("stderr");
  });

  it("accepts only versioned, sorted, unique expected failures with governance metadata", () => {
    expect(validateConformanceBaseline(createBaseline())).toEqual(createBaseline());

    const invalidBaselines = [
      { ...createBaseline(), toolVersion: "latest" },
      { ...createBaseline(), protocolVersion: "2026-07-28" },
      { ...createBaseline(), suite: "all" },
      {
        ...createBaseline(),
        expectedFailures: createBaseline().expectedFailures.map((entry, index) =>
          index === 0 ? { ...entry, reason: "" } : entry
        ),
      },
      {
        ...createBaseline(),
        expectedFailures: [
          createBaseline().expectedFailures[1],
          createBaseline().expectedFailures[0],
        ],
      },
      {
        ...createBaseline(),
        expectedFailures: [
          ...createBaseline().expectedFailures,
          createBaseline().expectedFailures[1],
        ],
      },
    ];

    for (const baseline of invalidBaselines) {
      expect(() => validateConformanceBaseline(baseline)).toThrow("Conformance baseline");
    }
  });

  it("renders only safe scenario names into the official expected-failures YAML", () => {
    expect(renderExpectedFailuresYaml(createBaseline().expectedFailures)).toBe(
      "server:\n  - prompts-list\n  - tools-call-simple-text\n"
    );

    expect(() => renderExpectedFailuresYaml([
      {
        ...createBaseline().expectedFailures[0],
        scenario: "prompts-list\nclient:\n  - injected",
      },
    ])).toThrow("Conformance scenario");
  });

  it("fails on new regressions and stale expected failures, including warnings", () => {
    const exactResults = [
      { scenario: "ping", checks: [{ id: "ping", status: "SUCCESS" }] },
      { scenario: "prompts-list", checks: [{ id: "prompt", status: "FAILURE" }] },
      {
        scenario: "tools-call-simple-text",
        checks: [{ id: "tool", status: "WARNING" }, { id: "request", status: "INFO" }],
      },
    ] as const;

    expect(assertConformanceBaselineMatches(
      createBaseline().expectedFailures,
      exactResults
    )).toEqual({
      passedScenarios: ["ping"],
      expectedFailureScenarios: ["prompts-list", "tools-call-simple-text"],
    });

    expect(() => assertConformanceBaselineMatches(
      createBaseline().expectedFailures,
      [...exactResults, { scenario: "new-regression", checks: [{ id: "new", status: "FAILURE" }] }]
    )).toThrow("unexpected failures: new-regression");

    expect(() => assertConformanceBaselineMatches(
      createBaseline().expectedFailures,
      exactResults.filter((result) => result.scenario !== "prompts-list")
    )).toThrow("stale expected failures: prompts-list");
  });

  it("keeps auditable check fields while excluding raw response details and timestamps", () => {
    expect(sanitizeConformanceChecks("server-initialize", [
      {
        id: "initialize",
        name: "Initialize",
        description: "Negotiates the protocol",
        status: "SUCCESS",
        timestamp: "2026-08-01T00:00:00.000Z",
        details: { privateRepository: "must-not-enter-artifact" },
        specReferences: [{ id: "MCP-Lifecycle", url: "https://modelcontextprotocol.io" }],
      },
    ])).toEqual({
      scenario: "server-initialize",
      checks: [
        {
          id: "initialize",
          name: "Initialize",
          description: "Negotiates the protocol",
          status: "SUCCESS",
          specReferences: [{ id: "MCP-Lifecycle", url: "https://modelcontextprotocol.io" }],
        },
      ],
    });

    expect(() => sanitizeConformanceChecks("server-initialize", [
      { id: "initialize", status: "UNKNOWN" as never },
    ])).toThrow("Conformance check");
  });
});

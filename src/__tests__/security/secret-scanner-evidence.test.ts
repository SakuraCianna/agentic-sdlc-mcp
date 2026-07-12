import { describe, expect, it } from "vitest";

import {
  evaluateSecretScannerEvidence,
  secretScannerPolicyFinding,
  type SecretScannerEvidence,
} from "../../security/secret-scanner-evidence.js";
import type {
  CiEvidence,
  GateSignal,
  GateSignalState,
} from "../../github/pull-request-evidence.js";

function signal(
  name: string,
  state: GateSignalState,
  source: GateSignal["source"] = "check_run",
  appId: number | null = source === "check_run" ? 15368 : null,
  provenanceVerified = false
): GateSignal {
  return {
    name,
    source,
    appId,
    state,
    rawStatus: state === "pending" ? "in_progress" : "completed",
    rawConclusion: state === "passing" ? "success" : state === "failing" ? "failure" : null,
    rawState: source === "commit_status" ? state : null,
    url: null,
    provenanceVerified,
  };
}

function ci(signals: GateSignal[], unverifiedSignals: string[] = []): CiEvidence {
  const buckets = (source: GateSignal["source"]) => {
    const selected = signals.filter((item) => item.source === source);
    return {
      passing: selected.filter((item) => item.state === "passing"),
      failing: selected.filter((item) => item.state === "failing"),
      pending: selected.filter((item) => item.state === "pending"),
      skipped: selected.filter((item) => item.state === "skipped"),
      total: selected.length,
    };
  };
  return {
    checkRuns: buckets("check_run"),
    commitStatuses: buckets("commit_status"),
    totalSignals: signals.length,
    hasFailing: signals.some((item) => item.state === "failing"),
    hasPending: signals.some((item) => item.state === "pending"),
    unverifiedSignals,
    errors: [],
  };
}

function expectStatus(evidence: SecretScannerEvidence, status: SecretScannerEvidence["status"]): void {
  expect(evidence.status).toBe(status);
  expect(evidence.verified).toBe(status !== "unverified");
}

describe("evaluateSecretScannerEvidence", () => {
  it.each([
    ["gitleaks", "gitleaks"],
    ["TruffleHog Secrets Scan", "trufflehog"],
  ] as const)("trusts a provenance-supported mature scanner check: %s", (name, provider) => {
    const evidence = evaluateSecretScannerEvidence(ci([signal(name, "passing", "check_run", 15368, true)]));

    expectStatus(evidence, "passing");
    expect(evidence.providers).toContain(provider);
  });

  it.each([
    ["secretlint", "secretlint"],
    ["detect-secrets", "detect-secrets"],
    ["GitHub Secret Scanning", "github-secret-scanning"],
  ] as const)("keeps unsupported provenance provider claims unverified: %s", (name, provider) => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal(name, "passing", "check_run", 15368, true)])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.providers).toContain(provider);
  });

  it("makes a failing mature scanner outrank a passing scanner", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([
        signal("gitleaks", "passing", "check_run", 15368, true),
        signal("TruffleHog", "failing", "check_run", 15368, true),
      ])
    );

    expectStatus(evidence, "failing");
    expect(evidence.signals).toHaveLength(2);
  });

  it("reports pending while a recognized scanner is incomplete", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "pending", "check_run", 15368, true)])
    );

    expectStatus(evidence, "pending");
  });

  it("does not treat skipped or unrelated green checks as verified secret scanning", () => {
    const skipped = evaluateSecretScannerEvidence(ci([signal("gitleaks", "skipped")]));
    const unrelated = evaluateSecretScannerEvidence(ci([signal("unit tests", "passing")]));

    expectStatus(skipped, "unverified");
    expectStatus(unrelated, "unverified");
    expect(unrelated.reason).toMatch(/no recognized secret scanner/i);
  });

  it("retains a recognized commit-status claim but does not treat it as verified clean", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("detect-secrets", "passing", "commit_status")])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.signals[0]?.source).toBe("commit_status");
    expect(evidence.signals[0]?.trusted).toBe(false);
  });

  it("rejects a same-name passing check from an untrusted GitHub App", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 999999)])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.signals[0]).toMatchObject({ appId: 999999, trusted: false });
    expect(evidence.reason).toMatch(/untrusted/i);
  });

  it("does not trust a same-name Actions check without explicit workflow provenance", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368)])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.signals[0]).toMatchObject({
      appId: 15368,
      trusted: false,
      provenanceVerified: false,
    });
    expect(evidence.reason).toMatch(/provenance|untrusted/i);
  });

  it("fails closed when any CI source is unavailable or truncated", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)], ["commit_statuses"])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.degraded).toBe(true);
    expect(evidence.reason).toMatch(/incomplete/i);
  });

  it("does not trust a passing check while scanner policy files are modified", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)]), {
      policyFilesChanged: true,
      }
    );

    expectStatus(evidence, "unverified");
    expect(evidence.reason).toMatch(/policy/i);
  });

  it("keeps a recognized failure highest priority even from an untrusted source", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([
        signal("gitleaks", "passing", "check_run", 15368, true),
        signal("TruffleHog", "failing", "commit_status"),
      ])
    );

    expect(evidence.status).toBe("failing");
    expect(evidence.verified).toBe(false);
    expect(evidence.degraded).toBe(true);
  });

  it("does not allow an inconsistent degraded passing object through the policy boundary", () => {
    const issue = secretScannerPolicyFinding({
      status: "passing",
      verified: false,
      degraded: true,
      providers: ["gitleaks"],
      signals: [],
      reason: "Caller supplied contradictory evidence.",
    });

    expect(issue).toMatchObject({
      category: "MissingMatureSecretScannerEvidence",
      severity: "high",
    });
  });
});

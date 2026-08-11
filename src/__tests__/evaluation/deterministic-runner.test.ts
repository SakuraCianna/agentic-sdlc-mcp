import { describe, expect, it } from "vitest";

import {
  createDeterministicEvaluationEnvironment,
  parseDeterministicEvaluationArgs,
} from "../../../scripts/run-deterministic-evaluation.mjs";

describe("deterministic evaluation runner", () => {
  it("accepts only the explicit selection group", () => {
    expect(parseDeterministicEvaluationArgs(["--group", "selection"])).toBe(
      "selection"
    );
    expect(() => parseDeterministicEvaluationArgs([])).toThrow(/Usage/u);
    expect(() =>
      parseDeterministicEvaluationArgs(["--group", "selection", "extra"])
    ).toThrow(/Usage/u);
    expect(() =>
      parseDeterministicEvaluationArgs(["--group", "unknown"])
    ).toThrow(/Unsupported/u);
  });

  it("passes only the minimal environment allowlist to the child", () => {
    const environment = createDeterministicEvaluationEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
      ACTIONS_RUNTIME_TOKEN: "actions-secret",
      BUSINESS_FLAG: "must-not-cross-offline-boundary",
      FUTURE_PROVIDER_API_KEY: "unknown-provider-secret",
      GH_TOKEN: "gh-secret",
      GITHUB_ID_TOKEN: "github-oidc-secret",
      GITHUB_TOKEN: "github-secret",
      github_token: "lowercase-github-secret",
      MODEL_ACCESS_TOKEN: "model-secret",
      PATH: "fixture-path",
      PRIVATE_SIGNING_KEY: "signing-secret",
      CI: "true",
      LANG: "en_US.UTF-8",
    });

    expect(environment).toEqual({
      AGENTIC_EVALUATION_OFFLINE: "1",
      CI: "true",
      LANG: "en_US.UTF-8",
      PATH: "fixture-path",
    });
  });
});

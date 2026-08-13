import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  countStructuredItems,
  evaluateBudget,
  EvaluationBudgetConfigSchema,
  measureEvaluationOutput,
  nearestRankP95,
  runBudgetedEvaluation,
} from "../../evaluation/budgets.js";

const config = EvaluationBudgetConfigSchema.parse(
  JSON.parse(
    await readFile(new URL("../../../evaluation/budgets.json", import.meta.url), "utf8")
  ) as unknown
);
const scenario = config.scenarios[0]!;

describe("T10 deterministic evaluation budgets", () => {
  it("locks the versioned measurement algorithms and unique scenarios", () => {
    expect(config.algorithms.tokenEstimate).toContain("observational only");
    expect(config.scenarios).toHaveLength(13);
  });

  it("counts nested structured items without counting the root container", () => {
    expect(countStructuredItems(null)).toBe(0);
    expect(countStructuredItems([])).toBe(0);
    expect(countStructuredItems([{}])).toBe(1);
    expect(countStructuredItems({ a: 1, b: [2, 3] })).toBe(4);
  });

  it("counts deep structures iteratively and rejects circular references", () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 10_000; index += 1) deep = { next: deep };
    expect(countStructuredItems(deep)).toBe(10_000);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => countStructuredItems(circular)).toThrow(/circular/u);

    const shared = { leaf: true };
    expect(countStructuredItems({ first: shared, second: shared })).toBe(4);
  });

  it("measures UTF-16 Markdown, UTF-8 JSON bytes, and observational token estimates", () => {
    const measurement = measureEvaluationOutput({
      markdown: "😀",
      structuredContent: { value: "密钥" },
      githubApiCalls: 1,
      durationMs: 5,
    });
    const report = evaluateBudget(scenario, measurement);

    expect(measurement.markdownCharacters).toBe(2);
    expect(measurement.structuredJsonBytes).toBe(
      Buffer.byteLength(JSON.stringify({ value: "密钥" }), "utf8")
    );
    expect(report.measurement.tokenEstimate).toBeGreaterThan(0);
  });

  it.each([
    "githubApiCalls",
    "structuredItems",
    "markdownCharacters",
    "structuredJsonBytes",
  ] as const)("accepts 0, 1, and exact %s limits but identifies limit+1 by source", (metric) => {
    const base = {
      githubApiCalls: 0,
      structuredItems: 0,
      markdownCharacters: 0,
      markdownUtf8Bytes: 0,
      structuredJsonBytes: 0,
      durationMs: 0,
      timedOut: false,
      cancelled: false,
    };
    for (const value of [0, 1, scenario.hardLimits[metric]]) {
      const report = evaluateBudget(scenario, { ...base, [metric]: value });
      expect(report.violations.some((item) => item.metric === metric)).toBe(false);
    }
    const over = evaluateBudget(scenario, {
      ...base,
      [metric]: scenario.hardLimits[metric] + 1,
    });
    expect(over).toMatchObject({
      passed: false,
      violations: [
        expect.objectContaining({
          metric,
          source: `${scenario.id}:${scenario.tool}:${metric}`,
        }),
      ],
    });
  });

  it("reports timeout and cancellation without treating fixed mock P95 as live latency", () => {
    const report = evaluateBudget(scenario, {
      githubApiCalls: 0,
      structuredItems: 0,
      markdownCharacters: 0,
      markdownUtf8Bytes: 0,
      structuredJsonBytes: 0,
      durationMs: scenario.timeoutMs,
      timedOut: true,
      cancelled: true,
    });

    expect(nearestRankP95([1, 2, 3, 4, 100])).toBe(100);
    expect(report.fixedDurationP95Ms).toBe(112);
    expect(report.durationHeadroomMs).toBe(38);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "timeout" }),
        expect.objectContaining({ metric: "cancellation" }),
      ])
    );
  });

  it("enforces a scenario deadline and aborts the in-flight operation", async () => {
    let childSignal: AbortSignal | undefined;
    const timeoutScenario = { ...scenario, timeoutMs: 5 };
    const report = await runBudgetedEvaluation(timeoutScenario, (signal) => {
      childSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });

    expect(childSignal?.aborted).toBe(true);
    expect(report).toMatchObject({
      passed: false,
      measurement: { timedOut: true, cancelled: false },
      violations: [expect.objectContaining({ metric: "timeout" })],
    });
  });

  it("reports caller cancellation separately and preserves ordinary failures", async () => {
    const parent = new AbortController();
    const pending = runBudgetedEvaluation(
      scenario,
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      { parentSignal: parent.signal }
    );
    parent.abort(new Error("evaluation cancelled by caller"));

    await expect(pending).resolves.toMatchObject({
      passed: false,
      measurement: { timedOut: false, cancelled: true },
      violations: [expect.objectContaining({ metric: "cancellation" })],
    });
    await expect(
      runBudgetedEvaluation(scenario, async () => {
        throw new Error("tool failed");
      })
    ).rejects.toThrow("tool failed");

  });

  it("rejects invalid counts, empty P95 input, and duplicate scenario ids", () => {
    expect(() =>
      measureEvaluationOutput({
        markdown: "ok",
        structuredContent: {},
        githubApiCalls: -1,
        durationMs: 0,
      })
    ).toThrow(/non-negative/u);
    expect(() =>
      measureEvaluationOutput({
        markdown: "ok",
        structuredContent: undefined,
        githubApiCalls: 0,
        durationMs: 0,
      })
    ).toThrow(/JSON-serializable/u);
    expect(() => nearestRankP95([])).toThrow(/at least one/u);
    expect(() =>
      EvaluationBudgetConfigSchema.parse({
        ...config,
        scenarios: [config.scenarios[0], config.scenarios[0]],
      })
    ).toThrow(/Duplicate budget scenario/u);
    expect(() =>
      EvaluationBudgetConfigSchema.parse({
        ...config,
        scenarios: [
          {
            ...config.scenarios[0],
            durationP95BudgetMs: nearestRankP95(
              config.scenarios[0]!.fixedDurationSamplesMs
            ),
          },
        ],
      })
    ).toThrow(/headroom/u);
  });

  it("fails when the fixed mock P95 loses its configured headroom", () => {
    const report = evaluateBudget(
      {
        ...scenario,
        durationP95BudgetMs: 10,
        fixedDurationSamplesMs: [8, 9, 11],
      },
      {
        githubApiCalls: 0,
        structuredItems: 0,
        markdownCharacters: 0,
        markdownUtf8Bytes: 0,
        structuredJsonBytes: 0,
        durationMs: 0,
        timedOut: false,
        cancelled: false,
      }
    );

    expect(report).toMatchObject({
      passed: false,
      fixedDurationP95Ms: 11,
      durationHeadroomMs: -1,
      violations: [
        expect.objectContaining({
          metric: "durationP95",
          source: `${scenario.id}:${scenario.tool}:fixed-duration-p95`,
        }),
      ],
    });
  });
});

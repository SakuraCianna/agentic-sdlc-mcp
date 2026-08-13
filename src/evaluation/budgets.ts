import { z } from "zod";

import {
  AbortableCancellationError,
  AbortableTimeoutError,
  withAbortableTimeout,
} from "../evidence/timeout.js";

export const BudgetMetricSchema = z.enum([
  "githubApiCalls",
  "structuredItems",
  "markdownCharacters",
  "structuredJsonBytes",
]);
export type BudgetMetric = z.infer<typeof BudgetMetricSchema>;

const HardLimitsSchema = z
  .object({
    githubApiCalls: z.number().int().nonnegative(),
    structuredItems: z.number().int().nonnegative(),
    markdownCharacters: z.number().int().nonnegative(),
    structuredJsonBytes: z.number().int().nonnegative(),
  })
  .strict();

export const EvaluationBudgetConfigSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    algorithms: z
      .object({
        markdownCharacters: z.literal("UTF-16 code units (JavaScript String.length)"),
        structuredJsonBytes: z.literal("UTF-8 bytes of JSON.stringify(structuredContent)"),
        structuredItems: z.literal("recursive count of array elements and object property values"),
        tokenEstimate: z.literal("ceil(UTF-8 bytes / 4); observational only, never a hard gate"),
        durationP95: z.literal("nearest-rank p95 over fixed mock duration samples"),
      })
      .strict(),
    scenarios: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
            tool: z.string().min(1),
            hardLimits: HardLimitsSchema,
            timeoutMs: z.number().int().positive(),
            durationP95BudgetMs: z.number().int().positive(),
            fixedDurationSamplesMs: z.array(z.number().int().nonnegative()).min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, scenario] of config.scenarios.entries()) {
      if (ids.has(scenario.id)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "id"],
          message: `Duplicate budget scenario id: ${scenario.id}`,
        });
      }
      ids.add(scenario.id);
      const p95 = nearestRankP95(scenario.fixedDurationSamplesMs);
      const requiredHeadroom = Math.max(10, Math.ceil(p95 * 0.1));
      if (scenario.durationP95BudgetMs - p95 < requiredHeadroom) {
        context.addIssue({
          code: "custom",
          path: ["scenarios", index, "durationP95BudgetMs"],
          message:
            `Fixed duration P95 requires at least ${requiredHeadroom}ms headroom ` +
            `above ${p95}ms.`,
        });
      }
    }
  });

export type EvaluationBudgetConfig = z.infer<typeof EvaluationBudgetConfigSchema>;
export type EvaluationBudgetScenario = EvaluationBudgetConfig["scenarios"][number];

export interface EvaluationMeasurement {
  githubApiCalls: number;
  structuredItems: number;
  markdownCharacters: number;
  markdownUtf8Bytes: number;
  structuredJsonBytes: number;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
}

export interface BudgetViolation {
  metric: BudgetMetric | "timeout" | "cancellation" | "durationP95";
  source: string;
  actual: number | boolean;
  limit: number | boolean;
  message: string;
}

export interface EvaluationBudgetReport {
  schemaVersion: "1.0";
  scenarioId: string;
  tool: string;
  passed: boolean;
  measurement: EvaluationMeasurement & { tokenEstimate: number };
  fixedDurationP95Ms: number;
  durationHeadroomMs: number;
  violations: BudgetViolation[];
}

export interface BudgetedEvaluationOutput {
  markdown: string;
  structuredContent: unknown;
}

export interface BudgetedEvaluationOptions {
  githubApiCalls?: () => number;
  parentSignal?: AbortSignal;
  now?: () => number;
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

export function countStructuredItems(value: unknown): number {
  let count = 0;
  const pending: Array<{ value: unknown; exiting: boolean }> = [
    { value, exiting: false },
  ];
  const active = new WeakSet<object>();
  while (pending.length > 0) {
    const frame = pending.pop();
    const current = frame?.value;
    if (!current || typeof current !== "object") continue;
    if (frame.exiting) {
      active.delete(current);
      continue;
    }
    if (active.has(current)) {
      throw new TypeError("structuredContent must not contain circular references.");
    }
    active.add(current);
    const values = Array.isArray(current)
      ? current
      : Object.values(current as Record<string, unknown>);
    count += values.length;
    if (!Number.isSafeInteger(count)) {
      throw new RangeError("structuredContent item count exceeded the safe integer range.");
    }
    pending.push({ value: current, exiting: true });
    for (let index = values.length - 1; index >= 0; index -= 1) {
      pending.push({ value: values[index], exiting: false });
    }
  }
  return count;
}

export function measureEvaluationOutput(input: {
  markdown: string;
  structuredContent: unknown;
  githubApiCalls: number;
  durationMs: number;
  timedOut?: boolean;
  cancelled?: boolean;
}): EvaluationMeasurement {
  assertCount("githubApiCalls", input.githubApiCalls);
  assertCount("durationMs", input.durationMs);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input.structuredContent);
  } catch {
    throw new TypeError("structuredContent must be JSON-serializable.");
  }
  if (serialized === undefined) {
    throw new TypeError("structuredContent must be JSON-serializable.");
  }
  return {
    githubApiCalls: input.githubApiCalls,
    structuredItems: countStructuredItems(input.structuredContent),
    markdownCharacters: input.markdown.length,
    markdownUtf8Bytes: Buffer.byteLength(input.markdown, "utf8"),
    structuredJsonBytes: Buffer.byteLength(serialized, "utf8"),
    durationMs: input.durationMs,
    timedOut: input.timedOut ?? false,
    cancelled: input.cancelled ?? false,
  };
}

/**
 * Execute one evaluation scenario under its real deadline. Only a local
 * deadline or caller cancellation is converted into a fail-closed report;
 * ordinary tool and protocol errors remain visible to the test runner.
 */
export async function runBudgetedEvaluation(
  scenario: EvaluationBudgetScenario,
  operation: (signal: AbortSignal) => Promise<BudgetedEvaluationOutput>,
  options: BudgetedEvaluationOptions = {}
): Promise<EvaluationBudgetReport> {
  const label = `${scenario.tool} budget evaluation`;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const githubApiCalls = (): number => options.githubApiCalls?.() ?? 0;

  try {
    const output = await withAbortableTimeout(
      label,
      scenario.timeoutMs,
      operation,
      options.parentSignal
    );
    return evaluateBudget(
      scenario,
      measureEvaluationOutput({
        ...output,
        githubApiCalls: githubApiCalls(),
        durationMs: Math.max(0, Math.ceil(now() - startedAt)),
      })
    );
  } catch (error) {
    const parentReason = options.parentSignal?.reason;
    const cancelled =
      options.parentSignal?.aborted === true &&
      (parentReason instanceof Error
        ? error === parentReason
        : error instanceof AbortableCancellationError && error.label === label);
    const timedOut =
      !cancelled &&
      error instanceof AbortableTimeoutError &&
      error.label === label;
    if (!timedOut && !cancelled) throw error;

    return evaluateBudget(scenario, {
      githubApiCalls: githubApiCalls(),
      structuredItems: 0,
      markdownCharacters: 0,
      markdownUtf8Bytes: 0,
      structuredJsonBytes: 0,
      durationMs: Math.max(0, Math.ceil(now() - startedAt)),
      timedOut,
      cancelled,
    });
  }
}

export function nearestRankP95(samples: readonly number[]): number {
  if (samples.length === 0) throw new TypeError("P95 requires at least one sample.");
  for (const sample of samples) assertCount("duration sample", sample);
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

export function evaluateBudget(
  scenario: EvaluationBudgetScenario,
  measurement: EvaluationMeasurement
): EvaluationBudgetReport {
  const violations: BudgetViolation[] = [];
  for (const metric of BudgetMetricSchema.options) {
    const actual = measurement[metric];
    const limit = scenario.hardLimits[metric];
    if (actual <= limit) continue;
    violations.push({
      metric,
      source: `${scenario.id}:${scenario.tool}:${metric}`,
      actual,
      limit,
      message: `${scenario.tool} exceeded ${metric}: ${actual} > ${limit}.`,
    });
  }
  if (measurement.timedOut || measurement.durationMs > scenario.timeoutMs) {
    violations.push({
      metric: "timeout",
      source: `${scenario.id}:${scenario.tool}:timeout`,
      actual: measurement.durationMs,
      limit: scenario.timeoutMs,
      message: `${scenario.tool} exceeded or reached the timeout boundary.`,
    });
  }
  if (measurement.cancelled) {
    violations.push({
      metric: "cancellation",
      source: `${scenario.id}:${scenario.tool}:cancellation`,
      actual: true,
      limit: false,
      message: `${scenario.tool} was cancelled before producing a complete result.`,
    });
  }
  const fixedDurationP95Ms = nearestRankP95(scenario.fixedDurationSamplesMs);
  if (fixedDurationP95Ms > scenario.durationP95BudgetMs) {
    violations.push({
      metric: "durationP95",
      source: `${scenario.id}:${scenario.tool}:fixed-duration-p95`,
      actual: fixedDurationP95Ms,
      limit: scenario.durationP95BudgetMs,
      message: `${scenario.tool} fixed mock P95 exceeded its observational budget.`,
    });
  }
  return {
    schemaVersion: "1.0",
    scenarioId: scenario.id,
    tool: scenario.tool,
    passed: violations.length === 0,
    measurement: {
      ...measurement,
      tokenEstimate: Math.ceil(
        (measurement.structuredJsonBytes + measurement.markdownUtf8Bytes) / 4
      ),
    },
    fixedDurationP95Ms,
    durationHeadroomMs: scenario.durationP95BudgetMs - fixedDurationP95Ms,
    violations,
  };
}

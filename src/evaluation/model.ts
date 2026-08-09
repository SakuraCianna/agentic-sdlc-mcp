import { createHash } from "node:crypto";
import { z } from "zod";

export const EVALUATION_SCENARIO_SCHEMA_VERSION = "1.0" as const;
export const EVALUATION_TRACE_SCHEMA_VERSION = "1.0" as const;

const ToolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*$/u);

const ScenarioIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

// Keep the runtime and published JSON Schema aligned for Unicode text. Zod's
// string max counts UTF-16 code units, while JSON Schema counts code points.
const DescriptionSchema = z
  .string()
  .regex(/^(?![\s\S]{2001})(?=[\s\S]*\S)[\s\S]+/u);

const ToolListSchema = z.array(ToolNameSchema).max(64);

const OrderConstraintSchema = z
  .object({
    before: ToolNameSchema,
    after: ToolNameSchema,
  })
  .strict();

const RequiredGateSchema = z
  .object({
    gateTool: ToolNameSchema,
    beforeTools: ToolListSchema.min(1),
  })
  .strict();

export const EvaluationScenarioSchema = z
  .object({
    schemaVersion: z.literal(EVALUATION_SCENARIO_SCHEMA_VERSION),
    id: ScenarioIdSchema,
    description: DescriptionSchema,
    requiredTools: ToolListSchema,
    allowedTools: ToolListSchema,
    forbiddenTools: ToolListSchema,
    orderConstraints: z.array(OrderConstraintSchema).max(64),
    maxToolCalls: z.number().int().min(1).max(256),
    minimumScore: z.number().int().min(0).max(100),
    safety: z
      .object({
        forbidLiveWrites: z.boolean(),
        requiredGates: z.array(RequiredGateSchema).max(32),
      })
      .strict(),
  })
  .strict()
  .superRefine((scenario, context) => {
    const lists = [
      ["requiredTools", scenario.requiredTools],
      ["allowedTools", scenario.allowedTools],
      ["forbiddenTools", scenario.forbiddenTools],
    ] as const;
    for (const [field, tools] of lists) {
      if (new Set(tools).size !== tools.length) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} must not contain duplicate tools.`,
        });
      }
    }

    const required = new Set(scenario.requiredTools);
    const allowed = new Set(scenario.allowedTools);
    const forbidden = new Set(scenario.forbiddenTools);
    for (const tool of required) {
      if (allowed.has(tool) || forbidden.has(tool)) {
        context.addIssue({
          code: "custom",
          path: ["requiredTools"],
          message: `Tool ${tool} appears in overlapping tool sets.`,
        });
      }
    }
    for (const tool of allowed) {
      if (forbidden.has(tool)) {
        context.addIssue({
          code: "custom",
          path: ["allowedTools"],
          message: `Tool ${tool} appears in overlapping tool sets.`,
        });
      }
    }

    const selectable = new Set([...required, ...allowed]);
    scenario.orderConstraints.forEach((constraint, index) => {
      if (!selectable.has(constraint.before) || !selectable.has(constraint.after)) {
        context.addIssue({
          code: "custom",
          path: ["orderConstraints", index],
          message: "Order constraints must reference required or allowed tools.",
        });
      }
      if (constraint.before === constraint.after) {
        context.addIssue({
          code: "custom",
          path: ["orderConstraints", index],
          message: "Order constraints must reference two different tools.",
        });
      }
    });
    scenario.safety.requiredGates.forEach((gate, gateIndex) => {
      if (!selectable.has(gate.gateTool)) {
        context.addIssue({
          code: "custom",
          path: ["safety", "requiredGates", gateIndex, "gateTool"],
          message: "A gate tool must be required or allowed.",
        });
      }
      if (new Set(gate.beforeTools).size !== gate.beforeTools.length) {
        context.addIssue({
          code: "custom",
          path: ["safety", "requiredGates", gateIndex, "beforeTools"],
          message: "Gate protected tools must not contain duplicates.",
        });
      }
      gate.beforeTools.forEach((tool, toolIndex) => {
        if (!selectable.has(tool) || tool === gate.gateTool) {
          context.addIssue({
            code: "custom",
            path: [
              "safety",
              "requiredGates",
              gateIndex,
              "beforeTools",
              toolIndex,
            ],
            message: "Protected tools must be selectable and different from the gate.",
          });
        }
      });
    });

    const mandatory = new Set(required);
    let closureChanged = true;
    while (closureChanged) {
      closureChanged = false;
      for (const gate of scenario.safety.requiredGates) {
        if (
          selectable.has(gate.gateTool) &&
          gate.beforeTools.some((tool) => mandatory.has(tool)) &&
          !mandatory.has(gate.gateTool)
        ) {
          mandatory.add(gate.gateTool);
          closureChanged = true;
        }
      }
    }

    if (scenario.maxToolCalls < mandatory.size) {
      context.addIssue({
        code: "custom",
        path: ["maxToolCalls"],
        message:
          "maxToolCalls cannot be lower than the required tool and gate closure.",
      });
    }

    const edges = new Map<string, string[]>();
    const indegree = new Map([...mandatory].map((tool) => [tool, 0]));
    const addMandatoryEdge = (before: string, after: string): void => {
      if (!mandatory.has(before) || !mandatory.has(after) || before === after) return;
      const outgoing = edges.get(before) ?? [];
      if (outgoing.includes(after)) return;
      outgoing.push(after);
      edges.set(before, outgoing);
      indegree.set(after, (indegree.get(after) ?? 0) + 1);
    };
    for (const constraint of scenario.orderConstraints) {
      addMandatoryEdge(constraint.before, constraint.after);
    }
    for (const gate of scenario.safety.requiredGates) {
      for (const protectedTool of gate.beforeTools) {
        addMandatoryEdge(gate.gateTool, protectedTool);
      }
    }

    const ready = [...indegree.entries()]
      .filter(([, degree]) => degree === 0)
      .map(([tool]) => tool);
    let visited = 0;
    for (let cursor = 0; cursor < ready.length; cursor += 1) {
      const tool = ready[cursor];
      if (tool === undefined) continue;
      visited += 1;
      for (const after of edges.get(tool) ?? []) {
        const nextDegree = (indegree.get(after) ?? 0) - 1;
        indegree.set(after, nextDegree);
        if (nextDegree === 0) ready.push(after);
      }
    }
    if (visited !== mandatory.size) {
      context.addIssue({
        code: "custom",
        path: ["orderConstraints"],
        message: "Mandatory tool and gate ordering must be acyclic.",
      });
    }
  });

export const EvaluationTraceProvenanceSchema = z.enum([
  "scripted",
  "recorded-agent",
  "live-model",
]);

export const EvaluationToolCallSchema = z
  .object({
    tool: ToolNameSchema,
    effect: z.enum(["read", "dry-run", "live-write"]),
    outcome: z.enum(["success", "error"]),
    argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  })
  .strict();

export const EvaluationTraceSchema = z
  .object({
    schemaVersion: z.literal(EVALUATION_TRACE_SCHEMA_VERSION),
    scenarioId: ScenarioIdSchema,
    provenance: EvaluationTraceProvenanceSchema,
    calls: z.array(EvaluationToolCallSchema).max(512),
  })
  .strict();

export const EvaluationInputBundleSchema = z
  .object({
    scenario: EvaluationScenarioSchema,
    trace: EvaluationTraceSchema,
  })
  .strict();

export type EvaluationScenario = z.infer<typeof EvaluationScenarioSchema>;
export type EvaluationTrace = z.infer<typeof EvaluationTraceSchema>;
export type EvaluationTraceProvenance = z.infer<
  typeof EvaluationTraceProvenanceSchema
>;
export type EvaluationToolCall = z.infer<typeof EvaluationToolCallSchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

export function digestEvaluationValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

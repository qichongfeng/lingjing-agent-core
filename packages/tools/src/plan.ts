// update_plan tool — the agent's shared task list (Codex-style).
//
// Multi-step work needs a plan the user can SEE, not one buried in prose:
// the model publishes its full step list here and re-publishes it as steps
// move to in_progress/completed. Each call carries the COMPLETE plan (full
// replacement, no diffs) — stateless and idempotent, so a retry after a
// failed call can never corrupt the plan.
//
// Not a web tool: standalone factory, zero deps, instant execute (nothing
// to wait for). The result is a compact rendering of the canonical plan so
// the model sees exactly what was registered. Hosts that want a persistent
// plan card (surviving core's context compaction, which may drop old tool
// calls) pass onUpdate — fired synchronously on every accepted update,
// errors swallowed (it must never break the run).
//
// Family discipline: never throws (Refused: on bad input), no network,
// tags ["plan"].

import { type Tool, type ToolResultValue } from "@lingjing-agent/core";

const MAX_STEPS = 20;
const STEP_CAP = 500;

export type PlanStatus = "pending" | "in_progress" | "completed";

/** One sanitized step; the last accepted update is the current plan. */
export interface PlanStep {
  step: string;
  status: PlanStatus;
}

/** Everything the host needs to render/persist the current plan. */
export interface PlanUpdateInfo {
  /** The full replacement plan, sanitized and ordered as sent. */
  plan: PlanStep[];
  conversationId: string;
  toolCallId: string;
}

export interface PlanToolOptions {
  /** Host callback on every accepted update (fire-and-forget, sync). Persist
   *  the latest plan per conversationId — old tool calls may be compacted out
   *  of the model context, this is the durable copy. Optional. */
  onUpdate?: (info: PlanUpdateInfo) => void;
}

const STATUSES: readonly PlanStatus[] = ["pending", "in_progress", "completed"];

/** "2/5" progress summary for the model-facing result. */
const doneCount = (plan: PlanStep[]) => plan.filter((s) => s.status === "completed").length;

const renderPlan = (plan: PlanStep[]) =>
  plan.map((s, i) => `${i + 1}. [${s.status}] ${s.step}`).join("\n");

export function createPlanTool(opts: PlanToolOptions = {}): Tool {
  const onUpdate = opts.onUpdate;

  return {
    name: "update_plan",
    description:
      "Publish or update your task list for a multi-step job. Send the COMPLETE plan every " +
      "call (full replacement — include every step with its current status, not just the " +
      "changes). Call it once when you start non-trivial multi-step work (3+ steps), and " +
      "again whenever a step starts or completes. Mark a step in_progress only while you " +
      "are actively working on it; mark it completed when done. Skip it for single-step " +
      "answers — a plan there is noise.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          plan: {
            type: "array",
            description: `The full step list (max ${MAX_STEPS} steps). Each call replaces the previous plan entirely.`,
            items: {
              type: "object",
              properties: {
                step: {
                  type: "string",
                  description: `One concrete, verifiable step (max ${STEP_CAP} chars).`,
                },
                status: {
                  type: "string",
                  enum: [...STATUSES],
                  description: "pending = not started, in_progress = actively working on it, completed = done. Defaults to pending.",
                },
              },
              required: ["step"],
              additionalProperties: false,
            },
          },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };

      const rawPlan = (raw as { plan?: unknown }).plan;
      if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
        return { content: "Refused: input.plan must be a non-empty array of steps", isError: true };
      }
      if (rawPlan.length > MAX_STEPS) {
        return { content: `Refused: input.plan has ${rawPlan.length} steps (max ${MAX_STEPS}) — consolidate or drop finished steps`, isError: true };
      }

      const plan: PlanStep[] = [];
      for (let i = 0; i < rawPlan.length; i++) {
        const entry = rawPlan[i] as { step?: unknown; status?: unknown };
        const step = typeof entry?.step === "string" ? entry.step.trim() : "";
        if (step === "") {
          return { content: `Refused: input.plan[${i}].step must be a non-empty string`, isError: true };
        }
        const status = entry?.status === undefined ? "pending" : entry.status;
        if (!STATUSES.includes(status as PlanStatus)) {
          return {
            content: `Refused: input.plan[${i}].status must be one of ${STATUSES.join(" | ")} (got ${JSON.stringify(status)})`,
            isError: true,
          };
        }
        // Step text is a label, not prose — clamp silently (a truncation
        // marker inside a checklist reads worse than a clamped label)
        plan.push({ step: step.slice(0, STEP_CAP), status: status as PlanStatus });
      }

      if (onUpdate) {
        try {
          onUpdate({ plan, conversationId: ctx.conversationId, toolCallId: ctx.toolCallId });
        } catch {
          // Host callback must never break the run — the plan is already
          // registered, a dead card is the host's problem to surface.
        }
      }

      return { content: `Plan updated (${doneCount(plan)}/${plan.length} done):\n${renderPlan(plan)}` };
    },
  };
}

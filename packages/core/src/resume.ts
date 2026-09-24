// Run-level resume: re-drive a conversation whose last run was cut off
// (process death, page reload, disconnect) WITHOUT new user input. Pure
// classification over persisted history — the actual re-drive lives in
// agent.ts (agent.resume), serialized on the conversation queue like send.
//
// Host control is the contract: core never auto-resumes. Hosts inspect
// (inspectRunTail / the resume attempt's nothing_to_resume error) and decide
// WHEN to continue — reload recovery, a "continue" button, or never.
//
// Prerequisite: AgentConfig.persistRuns — per-message durable appends during
// the run. Without it the run-end batch append means a killed run persisted
// nothing of its turns; resume then still works but only from the last state
// that DID persist (e.g. the previous run's tail), which is graceful, just
// coarser.

import { randomId, type Message, type ToolCall } from "./types.js";

/** What the tail of a persisted conversation says about its last run. */
export type RunTail =
  /** Last run finished on a terminal stop — nothing to resume. */
  | { kind: "at-rest" }
  /** Tail is a user message (fresh input never answered, or a tool_result
   *  carrier whose follow-up turn never happened): drive the next turn. */
  | { kind: "continue" }
  /** Tail is an assistant turn with tool_call blocks that never received
   *  their tool_result — protocol repair (synthetic isError carriers) is
   *  required before the conversation can continue. */
  | { kind: "answer-tools"; calls: ToolCall[]; message: Message }
  /** Tail is a non-terminal assistant turn (aborted partial, max_tokens,
   *  pause_turn, unknown): re-send as prefill and let the model continue. */
  | { kind: "continue-partial" };

/** Classify the last run's state from persisted history. Pure; exported so
 *  hosts can decide whether/how to offer resume ("未完成的回复，继续？").
 *  Feed it the same view the loop would send — for stored history that is
 *  materializeCompactedView(load(id)). */
export function inspectRunTail(messages: readonly Message[]): RunTail {
  const last = messages[messages.length - 1];
  if (!last) return { kind: "at-rest" };
  if (last.role === "user") return { kind: "continue" };
  if (last.role === "assistant") {
    const calls =
      typeof last.content === "string"
        ? []
        : last.content.filter((b): b is ToolCall => b.type === "tool_call");
    if (calls.length > 0) return { kind: "answer-tools", calls, message: last };
    const stop = (last.metadata as { stopReason?: unknown } | undefined)?.stopReason;
    // A finished run ends on a terminal stop; anything else (or unstamped) is cut off.
    if (stop === "end_turn" || stop === "stop_sequence") return { kind: "at-rest" };
    return { kind: "continue-partial" };
  }
  return { kind: "continue" }; // system tail (unusual) — just drive
}

/** The synthetic tool_result content for calls whose round was interrupted.
 *  Deliberately honest: the call may or may not have actually run — only its
 *  RESULT was lost — so the model must verify effects instead of blindly
 *  re-executing side-effecting tools. */
const INTERRUPTED_RESULT =
  "The previous run ended before this call's result was recorded — the tool MAY or MAY NOT have " +
  "actually run. Do not blindly repeat side-effecting calls; verify the effect first (e.g. read the file) " +
  "if you need certainty, then decide.";

/** Build the missing tool_result carrier for a dangling tool round: one user
 *  message answering EVERY unanswered call (the same single-carrier shape
 *  executeTools produces). Stamped with the dangling assistant's runId so the
 *  exchange stays grouped in history views. */
export function interruptedToolCarrier(
  assistant: Message,
  calls: ToolCall[],
  now: () => number,
): Message {
  const runId = (assistant.metadata as { runId?: unknown } | undefined)?.runId;
  return {
    id: randomId(),
    role: "user",
    content: calls.map((c) => ({
      type: "tool_result" as const,
      toolCallId: c.id,
      content: INTERRUPTED_RESULT,
      isError: true,
    })),
    createdAt: now(),
    ...(typeof runId === "string" ? { metadata: { runId } } : {}),
  };
}

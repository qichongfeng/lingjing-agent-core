import type { StopReason } from "@lingjing/agent-core";

/**
 * Map an OpenAI `finish_reason` to the core's neutral StopReason.
 *
 * Mapping (per DESIGN §附): tool_calls/function_call → tool_use, length →
 * max_tokens, stop → stop_sequence, content_filter → refusal. Note OpenAI's
 * `"stop"` fires for BOTH natural completion and an explicit stop sequence hit
 * (no signal distinguishes them); DESIGN mandates `stop → stop_sequence`. In
 * the loop, `stop_sequence` and `end_turn` are treated identically (both
 * terminal → done), so behavior is unchanged — only the surfaced stopReason
 * differs. `null`/undefined (streaming, ongoing) or unknown → `end_turn`.
 */
export function mapStop(finishReason?: string | null): StopReason {
  switch (finishReason) {
    case "stop":
      return "stop_sequence";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

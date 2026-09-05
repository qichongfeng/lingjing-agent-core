import type { StopReason } from "@lingjing/agent-core";

/**
 * Map an Anthropic `stop_reason` to core's neutral StopReason. Anthropic's stop
 * reasons map 1:1 to core's (core modeled them after Anthropic), including
 * `pause_turn` and `context_window_exceeded` — the latter means overflow is a
 * stop reason here (unlike OpenAI's HTTP 400), so core compacts directly without
 * the code-based translation the OpenAI adapter needs.
 */
export function mapStop(stopReason?: string | null): StopReason {
  switch (stopReason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "pause_turn":
      return "pause_turn";
    case "refusal":
      return "refusal";
    case "context_window_exceeded":
      return "context_window_exceeded";
    default:
      return "end_turn";
  }
}

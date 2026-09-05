// Serializable agent events. Every event is JSON.stringify-safe (no functions,
// no AbortSignal) so hosts can forward them verbatim over IPC / SSE / WebSocket.

import type { Content } from "./types.js";
import type { StopReason, TokenUsage } from "./provider.js";

export interface EventBase {
  conversationId: string;
  turn: number;
  ts: number;
}

export type AgentEvent =
  | (EventBase & { type: "start"; model: string })
  | (EventBase & { type: "text_delta"; text: string })
  | (EventBase & { type: "thinking_delta"; text: string })
  | (EventBase & {
      type: "tool_call";
      toolCallId: string;
      name: string;
      input: unknown;
    })
  | (EventBase & {
      type: "tool_result";
      toolCallId: string;
      content: Content[];
      isError: boolean;
      ms: number;
    })
  | (EventBase & { type: "turn_end"; stopReason: StopReason; usage: TokenUsage })
  | (EventBase & {
      type: "permission_request";
      toolCallId: string;
      name: string;
      input: unknown;
      destructive: boolean;
    })
  | (EventBase & {
      type: "error";
      message: string;
      code: string;
      recoverable: boolean;
    })
  | (EventBase & {
      type: "done";
      finalText: string;
      totalUsage: TokenUsage;
      turns: number;
    });

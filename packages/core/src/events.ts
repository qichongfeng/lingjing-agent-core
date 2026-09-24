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
  | (EventBase & {
      type: "turn_end";
      stopReason: StopReason;
      usage: TokenUsage;
      /** Anchored total-context estimate after this turn: real input tokens
       *  from the response + estimated increment for what was appended since
       *  (assistant reply etc.). Hosts render usage meters from this instead
       *  of re-estimating history themselves. */
      contextTokens?: number;
    })
  | (EventBase & {
      /** Tier fallback fired for the current turn: the model named in `from`
       *  failed with an availability error and the turn is retried on `to`.
       *  Never silent — hosts surface it so users know a cheaper model answered. */
      type: "model_fallback";
      from: string;
      to: string;
      status?: number;
      code?: string;
    })
  | (EventBase & {
      /** Early conversation history was compacted into a summary note.
       *  `reason` is "soft" (crossed the trigger ratio at fit time) or
       *  "overflow" (the provider rejected the request for size). Originals
       *  stay in the memory store — only this request's view shrank. */
      type: "context_compacted";
      reason: "soft" | "overflow";
      tokensSaved?: number;
    })
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

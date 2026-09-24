// Provider-agnostic LLM interface. The chunk type is a union of what any
// provider can stream; vendor-specific event names never appear in core.
// Each adapter (e.g. provider-anthropic) owns its SDK and translates to/from
// these neutral types.

import type { Message, TextContent } from "./types.js";
import type { Tool } from "./tool.js";

export type StopReason =
  | "end_turn" // model finished naturally → terminate
  | "tool_use" // model wants tools → execute, feed back, continue
  | "max_tokens" // hit output cap → continue
  | "stop_sequence" // hit a stop sequence → terminate
  | "pause_turn" // server-side tool iteration cap → re-send to resume
  | "refusal" // safety refusal → terminate, surface stop_details via providerOptions
  | "context_window_exceeded" // history too long → compact + retry once
  | "aborted"; // loop-produced only: the run was interrupted mid-stream (providers never emit this)

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderConfig {
  maxTokens: number;
  temperature?: number; // some providers/models reject (Anthropic 4.7+ rejects)
  topP?: number;
  stopSequences?: string[];
  thinking?: {
    type: "adaptive" | "disabled";
    display?: "summarized" | "omitted";
  };
  effort?: "low" | "medium" | "high" | "xhigh" | "max"; // maps to vendor output_config.effort
  toolChoice?:
    | { type: "auto" }
    | { type: "any" } // force at least one tool
    | { type: "tool"; name: string } // force a specific tool
    | { type: "none" };
  /** Beta flags / extra headers / cache_control passthrough — vendor-specific, opaque to core. */
  providerOptions?: Record<string, unknown>;
}

export interface ProviderRequest {
  model: string;
  system?: string | TextContent[];
  messages: Message[];
  tools?: Tool[];
  config: ProviderConfig;
  signal: AbortSignal;
  /** Prompt-cache stickiness where supported. */
  conversationId?: string;
}

/** Neutral streaming chunk — discriminated union, JSON-serializable (no functions). */
export type ProviderChunk =
  | { type: "message_start"; messageId: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end"; signature?: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_delta"; toolCallId: string; inputJsonDelta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "message_delta"; stopReason?: StopReason; usage?: Partial<TokenUsage> }
  | { type: "message_end"; stopReason: StopReason; usage: TokenUsage };

export interface ProviderResponse {
  message: Message;
  stopReason: StopReason;
  usage: TokenUsage;
}

/** Error thrown by adapters; `retryable`/`status`/`retryAfterMs` let core classify and
 * back off without HTTP knowledge. `retryAfterMs` carries a server-suggested delay
 * (parsed from a `retry-after` header by the adapter); core caps it at `maxDelayMs`. */
export interface ProviderError extends Error {
  retryable?: boolean;
  status?: number;
  retryAfterMs?: number;
  /** Adapter-set machine code for special errors (e.g. `"context_length_exceeded"`),
   *  letting core classify without parsing messages. */
  code?: string;
}

export interface LLMProvider {
  readonly id: string; // "anthropic" | "openai" | "fake"
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
  /** Default impl: drain the stream. Adapters may override for a non-streaming endpoint. */
  complete?(req: ProviderRequest): Promise<ProviderResponse>;
  /** Optional; core falls back to a heuristic estimate when absent. */
  countTokens?(messages: Message[], model: string): Promise<number>;
  /** Informational capability report. The loop does not consult it today
   *  (adapters self-gate request mapping); hosts may read it to decide
   *  features (e.g. offer a thinking toggle only when `thinking` is true). */
  readonly capabilities: {
    stopReasons: readonly StopReason[];
    streaming: boolean;
    thinking?: boolean;
    promptCaching?: boolean;
  };
}

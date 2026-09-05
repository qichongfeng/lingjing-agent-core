// Middleware hooks. Use cases: RAG injection (beforeRequest), guardrails /
// redaction, logging/metrics, audit, human approval (beforeToolCall veto).

import type { StopReason, TokenUsage } from "./provider.js";
import type { Message } from "./types.js";
import type { Tool, ToolResultValue } from "./tool.js";

export interface HookContext {
  conversationId: string;
  turn: number;
  messages: Message[];
  tools: Tool[];
  signal: AbortSignal;
}

export interface BeforeToolCallCall {
  toolCallId: string;
  name: string;
  input: unknown;
  ctx: HookContext;
}

export interface AfterToolCallCall {
  toolCallId: string;
  name: string;
  result: ToolResultValue;
  isError: boolean;
  ctx: HookContext;
}

export interface Hooks {
  /** Before sending to provider. Can inject context (RAG: recall → extra user
   * turn), mutate messages, or abort the run. `inject` is appended to history
   * as new message(s) right before the request is built (the hook receives a
   * snapshot and cannot mutate the live array directly). */
  beforeRequest?(
    ctx: HookContext,
  ): Promise<
    | void
    | { abort: true; reason: string }
    | { inject: string | Message[] }
  >;
  /** After provider response, before tool execution. */
  afterResponse?(
    ctx: HookContext & {
      response: Message;
      stopReason: StopReason;
      usage: TokenUsage;
    },
  ): Promise<void>;
  /** Before a tool executes. Can validate further, mutate input, or veto. */
  beforeToolCall?(
    call: BeforeToolCallCall,
  ): Promise<void | { abort: true; reason: string } | { modifiedInput: unknown }>;
  /** After a tool executes. */
  afterToolCall?(call: AfterToolCallCall): Promise<void>;
}

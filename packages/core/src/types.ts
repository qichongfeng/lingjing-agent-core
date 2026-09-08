// Multi-modal, provider-neutral message model.
// Deliberately avoids vendor field names (no `tool_use_id`, `input_schema`, `cache_control`).
// Adapters translate between this and vendor shapes.

export type Role = "system" | "user" | "assistant";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  mediaType: string;
  data: string; // base64
}

export interface ThinkingContent {
  type: "thinking";
  text: string;
  /** Opaque signature some providers require for multi-turn replay. */
  signature?: string;
}

/**
 * A tool call the assistant emitted. Streaming accumulates `inputJson` deltas;
 * `input` is parsed (via JSON.parse) only after the block completes.
 */
export interface ToolCall {
  type: "tool_call";
  id: string; // provider-assigned; echoed back in ToolResult
  name: string;
  inputJson: string; // raw JSON accumulated from streaming deltas
  input?: unknown; // parsed input (undefined until block completes & parses)
}

/** A tool result returned by the host/tool executor, fed back to the model. */
export interface ToolResult {
  type: "tool_result";
  toolCallId: string; // matches ToolCall.id
  content: string | Content[];
  isError?: boolean; // tool execution failed (still fed back to model)
}

export type Content =
  | TextContent
  | ImageContent
  | ThinkingContent
  | ToolCall
  | ToolResult;

export interface Message {
  /** Stable, host-assigned id; UI keying + dedup. */
  id: string;
  role: Role;
  content: Content[] | string; // string shorthand for plain text
  createdAt: number; // epoch ms
  metadata?: Record<string, unknown>;
}

/** Convenience: build a user message from a string or pre-made content. */
export function userMessage(
  content: string | Content[],
  now: () => number,
  id?: string,
): Message {
  return {
    id: id ?? randomId(),
    role: "user",
    content,
    createdAt: now(),
  };
}

/**
 * Return a copy of `m` tagged with a run id (`metadata.runId`). core stamps
 * every message it appends during one `agent.stream()` run; `groupExchanges`
 * groups by it. Copy-on-write so caller-owned message objects are never mutated.
 */
export function withRunId(m: Message, runId: string): Message {
  return { ...m, metadata: { ...m.metadata, runId } };
}

export function randomId(): string {
  // crypto.randomUUID is available on Node 20+, modern browsers, and Edge.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Extract concatenated text from a message's content. */
export function extractText(message: Message): string {
  const c = message.content;
  if (typeof c === "string") return c;
  return c
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}

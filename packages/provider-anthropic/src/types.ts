// Anthropic Messages API wire types (POST /v1/messages). These are
// Anthropic-specific shapes; the provider-neutral types live in @lingjing-agent/core.
// Field names mirror the Anthropic API (snake_case, content_block_*, etc.) — the
// map/* helpers translate to/from core's neutral shapes.

export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: object;
  cache_control?: AnthropicCacheControl;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

export interface AnthropicThinkingConfig {
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: AnthropicThinkingConfig;
  "anthropic-beta"?: string;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessageResponse {
  id: string;
  model: string;
  role: "assistant";
  type: "message";
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** A single Anthropic SSE event (the `data:` JSON payload). The `type` field
 *  discriminates message_start / content_block_start / content_block_delta /
 *  content_block_stop / message_delta / message_stop / ping / error. */
export interface AnthropicStreamEvent {
  type: string;
  [key: string]: unknown;
}

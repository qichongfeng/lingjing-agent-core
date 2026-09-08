// OpenAI Chat Completions REST shapes (subset we use). Defined locally rather
// than importing the `openai` SDK, so this adapter stays dependency-free and
// runtime-agnostic (works in Node, browser, Edge via global fetch).

// --- streaming response (ChatCompletionChunk) ---
export interface OpenAIFunctionCall {
  name?: string;
  arguments?: string;
}
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: OpenAIFunctionCall;
}
export interface OpenAIChoiceDelta {
  role?: string;
  content?: string | null;
  /** Safety-refusal text channel (may accompany finish_reason content_filter). */
  refusal?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
  /** Model thinking, streamed by OpenAI-COMPATIBLE endpoints. OpenRouter uses
   * `reasoning`; DeepSeek R1 / Kimi / 智谱 GLM / Qwen / 豆包 use `reasoning_content`.
   * OpenAI proper never emits reasoning in Chat Completions (server-side only). */
  reasoning?: string | null;
  reasoning_content?: string | null;
}
export interface OpenAIChoice {
  delta?: OpenAIChoiceDelta;
  message?: {
    role?: string;
    content?: string | null;
    refusal?: string | null;
    reasoning?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{ id?: string; type?: string; function?: OpenAIFunctionCall }>;
  };
  finish_reason?: string | null;
}
export interface OpenAIUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
}
export interface ChatCompletionChunk {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage | null;
}

// --- request body (ChatCompletionCreateParams streaming) ---
export interface OpenAIMessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | OpenAIMessageContentPart[];
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}
export interface OpenAIToolDef {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}
export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface OpenAIChatParams {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAIToolDef[];
  tool_choice?: OpenAIToolChoice;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  reasoning_effort?: string;
}

// --- non-streaming response (ChatCompletion) ---
export interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      refusal?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: OpenAIFunctionCall }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
}

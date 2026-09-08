import {
  type Content,
  type Message,
  type ProviderConfig,
  type ProviderRequest,
  type TextContent,
  type Tool,
} from "@lingjing-agent/core";
import type {
  OpenAIChatParams,
  OpenAIMessage,
  OpenAIMessageContentPart,
  OpenAIToolChoice,
  OpenAIToolDef,
} from "./types.js";

/**
 * Map a core ProviderRequest to OpenAI Chat Completions streaming params.
 *
 * Key structural differences from Anthropic:
 *  - `system` becomes a leading `{role:"system"}` message (OpenAI allows system
 *    role in `messages`).
 *  - `ThinkingContent` is dropped on the way IN. OpenAI-compatible reasoning
 *    (`reasoning_content`/`reasoning`) is display-only — DeepSeek 400s if it is
 *    replayed in `messages`, and no compatible endpoint accepts it as input.
 *  - One core `assistant` message with multiple `tool_call` blocks → a single
 *    OpenAI assistant message carrying a `tool_calls[]` array.
 *  - One core `user` message holding multiple `tool_result` blocks → multiple
 *    OpenAI `{role:"tool", tool_call_id}` messages (OpenAI requires one tool
 *    message per prior assistant tool_call id; it does NOT pack results into a
 *    single user message the way Anthropic does).
 *  - `effort` maps to `reasoning_effort` for o-series / gpt-5 models only;
 *    omitted otherwise (unlike Anthropic's `output_config.effort`).
 */

const O_SERIES_PREFIXES = ["o1", "o3", "o4", "gpt-5"];

function isOpenAISeries(model: string): boolean {
  const m = model.toLowerCase();
  return O_SERIES_PREFIXES.some((p) => m === p || m.startsWith(p + "-") || m.startsWith(p + ".") || m.startsWith(p + "_"));
}

export function mapRequest(req: ProviderRequest): OpenAIChatParams {
  const { model, system, messages, tools, config } = req;

  const out: OpenAIChatParams = {
    model,
    messages: [],
    stream: true,
    // Ask OpenAI to emit usage in the final chunk(s) so core can capture it.
    stream_options: { include_usage: true },
  };

  // max_tokens vs max_completion_tokens: o-series / gpt-5 require the latter and
  // REJECT `max_tokens`; legacy models use `max_tokens`.
  if (isOpenAISeries(model)) {
    out.max_completion_tokens = config.maxTokens;
  } else {
    out.max_tokens = config.maxTokens;
  }

  if (system) {
    out.messages.push({
      role: "system",
      content: typeof system === "string" ? system : system.map((b) => b.text).join("\n"),
    });
  }

  for (const m of messages) {
    appendMessage(out.messages, m);
  }

  if (tools && tools.length > 0) {
    out.tools = tools.map(mapTool);
  }
  if (config.toolChoice) {
    out.tool_choice = mapToolChoice(config.toolChoice);
  }

  if (config.temperature !== undefined) out.temperature = config.temperature;
  if (config.topP !== undefined) out.top_p = config.topP;
  if (config.stopSequences && config.stopSequences.length > 0) out.stop = config.stopSequences;

  // o-series reasoning effort. OpenAI accepts low|medium|high|none only —
  // clamp core's extended scale (xhigh/max come from other providers).
  if (config.effort && isOpenAISeries(model)) {
    out.reasoning_effort = config.effort === "xhigh" || config.effort === "max" ? "high" : config.effort;
  }
  // Explicit thinking disable on o-series/gpt-5 → reasoning_effort "none"
  // (gpt-5.1+). "adaptive" is the endpoint default — send nothing.
  if (isOpenAISeries(model) && config.thinking?.type === "disabled") {
    out.reasoning_effort = "none";
  }

  // Vendor escape hatch, merged LAST (per-field override): hosts targeting
  // OpenAI-compatible endpoints can pass any endpoint-specific param without
  // waiting for adapter support — GLM `thinking:{type}`, Qwen `enable_thinking`,
  // gpt-5 `verbosity`, `response_format` structured outputs, …
  // (`providerOptions.headers` is reserved for per-request headers; `model`/
  // `messages` overrides are unsupported and discouraged.)
  const extra = (config.providerOptions as { body?: Record<string, unknown> } | undefined)?.body;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === "headers") continue;
      (out as unknown as Record<string, unknown>)[k] = v;
    }
  }

  return out;
}

function appendMessage(messages: OpenAIMessage[], m: Message): void {
  if (m.role === "system") {
    // Core keeps system out of messages[]; if a stray system arrives, OpenAI permits it.
    messages.push({ role: "system", content: typeof m.content === "string" ? m.content : extractTextBlocks(m.content) });
    return;
  }

  if (m.role === "assistant") {
    if (typeof m.content === "string") {
      messages.push({ role: "assistant", content: m.content });
      return;
    }
    const text = m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
    const toolCalls = m.content.filter((b): b is Extract<Content, { type: "tool_call" }> => b.type === "tool_call");
    const assistantMsg: OpenAIMessage = { role: "assistant", content: text || null };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
      }));
    }
    messages.push(assistantMsg);
    return;
  }

  // user role: may carry tool_result blocks → expand to multiple {role:"tool"} msgs.
  if (m.role === "user") {
    if (typeof m.content === "string") {
      messages.push({ role: "user", content: m.content });
      return;
    }
    const toolResults = m.content.filter((b): b is Extract<Content, { type: "tool_result" }> => b.type === "tool_result");
    const others = m.content.filter((b) => b.type !== "tool_result");

    // Non-tool content (text/image) becomes a single user message, first.
    if (others.length > 0) {
      messages.push({ role: "user", content: mapUserContent(m.content) });
    }
    // Each tool_result → its own {role:"tool", tool_call_id} message, in order.
    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: typeof tr.content === "string" ? tr.content : extractTextBlocks(tr.content),
      });
    }
  }
}

/** Map non-tool_result content blocks in a user message to an OpenAI user parts array. */
function mapUserContent(full: Content[]): OpenAIMessageContentPart[] {
  const parts: OpenAIMessageContentPart[] = [];
  for (const b of full) {
    if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
    }
    // thinking / tool_call / tool_result not valid as user content parts here.
  }
  if (parts.length === 0) return [{ type: "text", text: "" }];
  return parts;
}

function extractTextBlocks(content: Content[]): string {
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function mapTool(t: Tool): OpenAIToolDef {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema.jsonSchema,
    },
  };
}

function mapToolChoice(tc: NonNullable<ProviderConfig["toolChoice"]>): OpenAIToolChoice {
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: tc.name } };
  }
}

// Exported for tests.
export { isOpenAISeries };

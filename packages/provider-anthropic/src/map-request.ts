import type {
  Content,
  Message,
  ProviderConfig,
  ProviderRequest,
  Tool,
} from "@lingjing-agent/core";
import type {
  AnthropicCacheControl,
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageRequest,
  AnthropicTextBlock,
  AnthropicThinkingConfig,
  AnthropicTool,
  AnthropicToolChoice,
} from "./types.js";

/**
 * Map a core ProviderRequest to an Anthropic Messages API request.
 *
 * Key structural differences from OpenAI:
 *  - `system` is a TOP-LEVEL field (not a message in `messages[]`).
 *  - `messages` carry only `user`/`assistant` roles (NO `tool` role).
 *  - `tool_result` blocks live INSIDE a `user` message's content (one user
 *    message can carry many tool_result blocks), not as standalone messages.
 *  - assistant tool calls are `{type:"tool_use",id,name,input}` content blocks.
 *  - tools are `{name,input_schema}` (no `function` wrapper).
 *  - `thinking` is first-class: core `{type:"adaptive"}` → Anthropic
 *    `{type:"enabled",budget_tokens}`.
 */
export function mapRequest(req: ProviderRequest): AnthropicMessageRequest {
  const { model, system, messages, tools, config } = req;

  const out: AnthropicMessageRequest = {
    model,
    max_tokens: config.maxTokens,
    messages: messages
      .map(mapMessage)
      .filter((m): m is AnthropicMessage => m !== undefined),
    stream: true,
  };

  if (system !== undefined) {
    out.system =
      typeof system === "string"
        ? system
        : system.map((b): AnthropicTextBlock => ({ type: "text", text: b.text }));
  }
  if (tools && tools.length > 0) out.tools = tools.map(mapTool);
  if (config.toolChoice) out.tool_choice = mapToolChoice(config.toolChoice);
  if (config.temperature !== undefined) out.temperature = config.temperature;
  if (config.topP !== undefined) out.top_p = config.topP;
  if (config.stopSequences && config.stopSequences.length > 0) out.stop_sequences = config.stopSequences;
  if (config.thinking) out.thinking = mapThinking(config);

  applyCacheControl(out, config);
  return out;
}

function mapMessage(m: Message): AnthropicMessage | undefined {
  if (m.role === "system") return undefined; // system → top-level `system`, not messages[]
  const role = m.role as "user" | "assistant";
  if (typeof m.content === "string") return { role, content: m.content };
  const blocks = m.content
    .map(mapBlock)
    .filter((b): b is AnthropicContentBlock => b !== undefined);
  return { role, content: blocks };
}

function mapBlock(b: Content): AnthropicContentBlock | undefined {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
    case "thinking":
      return {
        type: "thinking",
        thinking: b.text,
        ...(b.signature !== undefined ? { signature: b.signature } : {}),
      };
    case "tool_call":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.toolCallId,
        content:
          typeof b.content === "string"
            ? b.content
            : b.content
                .map(mapBlock)
                .filter((x): x is AnthropicContentBlock => x !== undefined),
      };
    default:
      return undefined;
  }
}

function mapTool(t: Tool): AnthropicTool {
  return { name: t.name, description: t.description, input_schema: t.inputSchema.jsonSchema };
}

function mapToolChoice(tc: NonNullable<ProviderConfig["toolChoice"]>): AnthropicToolChoice {
  switch (tc.type) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: tc.name };
  }
}

function mapThinking(config: ProviderConfig): AnthropicThinkingConfig {
  const t = config.thinking;
  if (!t || t.type === "disabled") return { type: "disabled" };
  // adaptive → enabled with a budget. Anthropic requires budget_tokens < max_tokens;
  // default to max_tokens-1000 (leave room for the answer), floor 1024. Override via
  // providerOptions.thinkingBudget.
  const po = config.providerOptions as { thinkingBudget?: number } | undefined;
  const budget = po?.thinkingBudget ?? Math.max(1024, config.maxTokens - 1000);
  return { type: "enabled", budget_tokens: Math.min(budget, config.maxTokens - 1) };
}

/** Apply prompt-caching breakpoints from `providerOptions.cacheControl`:
 *  `{ targets: ["system","last_user"], ttl?: "5m"|"1h" }` — marks the system
 *  block and/or the last user message's final block with `cache_control`. */
function applyCacheControl(out: AnthropicMessageRequest, config: ProviderConfig): void {
  const cc = (
    config.providerOptions as { cacheControl?: { targets?: string[]; ttl?: "5m" | "1h" } } | undefined
  )?.cacheControl;
  if (!cc || !cc.targets || cc.targets.length === 0) return;
  const marker: AnthropicCacheControl = { type: "ephemeral", ...(cc.ttl ? { ttl: cc.ttl } : {}) };
  if (cc.targets.includes("system") && out.system !== undefined) {
    if (typeof out.system === "string") {
      out.system = [{ type: "text", text: out.system, cache_control: marker }];
    } else {
      const last = out.system[out.system.length - 1];
      if (last) last.cache_control = marker;
    }
  }
  if (cc.targets.includes("last_user") && out.messages.length > 0) {
    const lastMsg = out.messages[out.messages.length - 1];
    if (lastMsg && lastMsg.role === "user" && Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastBlock = lastMsg.content[lastMsg.content.length - 1];
      if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "tool_result")) {
        (lastBlock as { cache_control?: AnthropicCacheControl }).cache_control = marker;
      }
    }
  }
}

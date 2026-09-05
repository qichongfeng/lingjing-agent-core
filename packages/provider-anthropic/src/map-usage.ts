import type { TokenUsage } from "@lingjing/agent-core";
import type { AnthropicUsage } from "./types.js";

/** Map Anthropic usage (input/output + prompt-cache tokens) to core TokenUsage. */
export function mapUsage(u: AnthropicUsage | null | undefined): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
  };
  const cacheRead = u?.cache_read_input_tokens;
  if (typeof cacheRead === "number" && cacheRead > 0) usage.cacheReadTokens = cacheRead;
  const cacheCreation = u?.cache_creation_input_tokens;
  if (typeof cacheCreation === "number" && cacheCreation > 0) usage.cacheWriteTokens = cacheCreation;
  return usage;
}

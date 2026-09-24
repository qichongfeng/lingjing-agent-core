import type { TokenUsage } from "@lingjing-agent/core";
import type { AnthropicUsage } from "./types.js";

/**
 * Map Anthropic usage to core TokenUsage. `inputTokens` is the TOTAL input
 * context the request consumed — `input_tokens` + cache read + cache
 * creation — matching OpenAI's prompt_tokens semantics (cached tokens are a
 * subset there): cached tokens still occupy the context window, they just
 * cost less. The cache fields remain as subsets, so cost math is
 * (inputTokens − cacheRead − cacheWrite)·base + cacheWrite·1.25× + cacheRead·0.1×.
 */
export function mapUsage(u: AnthropicUsage | null | undefined): TokenUsage {
  const cacheRead = u?.cache_read_input_tokens;
  const cacheCreation = u?.cache_creation_input_tokens;
  const usage: TokenUsage = {
    inputTokens:
      (u?.input_tokens ?? 0) +
      (typeof cacheRead === "number" ? cacheRead : 0) +
      (typeof cacheCreation === "number" ? cacheCreation : 0),
    outputTokens: u?.output_tokens ?? 0,
  };
  if (typeof cacheRead === "number" && cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (typeof cacheCreation === "number" && cacheCreation > 0) usage.cacheWriteTokens = cacheCreation;
  return usage;
}

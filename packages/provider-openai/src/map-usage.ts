import type { TokenUsage } from "@lingjing/agent-core";
import type { OpenAIUsage } from "./types.js";

export function mapUsage(u: OpenAIUsage | null | undefined): TokenUsage {
  const usage: TokenUsage = {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
  };
  const reasoning = u?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number" && reasoning > 0) usage.reasoningTokens = reasoning;
  return usage;
}

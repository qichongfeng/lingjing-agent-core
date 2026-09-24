// Optional utility: conversation-title generation on a cheap (fast-tier) model.
// Deliberately NOT wired into the agent loop — a title is host/product
// metadata (it lives in the host's conversation index, not agent memory), so
// the WHEN/WHERE stays with the host; core only ships the reusable mechanism
// (one-shot call + normalization), same positioning as ragInjectHook.

import type { LLMProvider, ProviderChunk, ProviderRequest } from "./provider.js";
import { randomId } from "./types.js";

/** Default instruction: language-agnostic — the model matches the user's
 *  language, so hosts don't need per-locale prompt tables. */
const DEFAULT_TITLE_SYSTEM =
  "Generate a short title for the conversation below (4-12 characters for CJK, " +
  "3-8 words otherwise), capturing the user's main intent. Write it in the " +
  "user's language. Output the title only — no quotes, no trailing punctuation, " +
  "no explanation.";

const DEFAULT_MAX_CHARS = 24;
const DEFAULT_MAX_TOKENS = 128;
const EXCERPT_CHARS = 500;

export interface TitleGeneratorOptions {
  provider: LLMProvider;
  /** Model for the one-shot call — pass your fast tier. */
  model: string;
  /** Override the built-in instruction (e.g. per-locale prompts). */
  system?: string;
  /** Cap for the returned title, in characters. Default 24. */
  maxChars?: number;
  /** Max tokens for the call. Default 128. */
  maxTokens?: number;
  /** Vendor escape hatch forwarded into the request (e.g. DashScope/Qwen
   *  `body.enable_thinking: false` — thinking-default models otherwise burn
   *  the whole tiny budget on reasoning and never emit text). */
  providerOptions?: Record<string, unknown>;
  /** Diagnostics: called when generation fails (provider error OR empty
   *  output). The generator still resolves to null — this only surfaces the
   *  otherwise-silent cause. */
  onError?: (err: unknown) => void;
}

export interface TitleInput {
  /** The conversation's first user message. */
  userText: string;
  /** The first assistant reply (helps when the user message is vague). */
  replyText?: string;
  /** Abort the one-shot call (fire-and-forget callers may omit it). */
  signal?: AbortSignal;
}

/** Never throws: any failure (provider error, empty output) resolves to null —
 *  title generation must not break or block the conversation. Callers keep
 *  their own fallback title. */
export type TitleGenerator = (input: TitleInput) => Promise<string | null>;

/**
 * Create a title generator bound to a provider + model (typically the fast
 * tier). One-shot `provider.stream()` drain — no tools, no retry — mirroring
 * CompactContextManager's summarize call shape, so it works with any provider
 * (including ones without `complete()`).
 */
export function createTitleGenerator(opts: TitleGeneratorOptions): TitleGenerator {
  return async ({ userText, replyText, signal }) => {
    try {
      const excerpt =
        `用户/User: ${userText.slice(0, EXCERPT_CHARS)}` +
        (replyText ? `\n\n助手/Assistant: ${replyText.slice(0, EXCERPT_CHARS)}` : "");
      const req: ProviderRequest = {
        model: opts.model,
        system: opts.system ?? DEFAULT_TITLE_SYSTEM,
        messages: [{ id: randomId(), role: "user" as const, content: excerpt, createdAt: Date.now() }],
        // A title needs zero reasoning: disable where the provider maps it
        // (OpenAI series → reasoning_effort "none"). Thinking-default models
        // on OpenAI-compatible endpoints also need the vendor switch — pass
        // providerOptions.body.enable_thinking:false for those.
        config: {
          maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
          thinking: { type: "disabled" },
          ...(opts.providerOptions !== undefined ? { providerOptions: opts.providerOptions } : {}),
        },
        signal: signal ?? new AbortController().signal,
      };
      let text = "";
      for await (const chunk of opts.provider.stream(req) as AsyncIterable<ProviderChunk>) {
        if (chunk.type === "text_delta") text += chunk.text;
      }
      // Models occasionally disobey: take the first line, strip wrapping
      // quotes (ASCII + CJK), cap the length.
      const title = text
        .split("\n")[0]!
        .trim()
        .replace(/^["'「『《]+|["'」』》]+$/g, "")
        .slice(0, opts.maxChars ?? DEFAULT_MAX_CHARS)
        .trim();
      if (!title) {
        // 200-but-empty (e.g. a thinking model burned the budget before any
        // text) is the classic silent failure — surface it via onError.
        opts.onError?.(new Error("title generation produced no text"));
        return null;
      }
      return title;
    } catch (err) {
      opts.onError?.(err);
      return null; // never throw — callers fire-and-forget
    }
  };
}

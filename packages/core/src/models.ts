// Tiered model config: three tiers (fast/main/max), the fallback chain
// derived from them, and availability-error classification. Pure types and
// functions only — no imports from agent/loop (they import this), so the
// helpers stay unit-testable without spinning up a loop.

import type { ProviderError } from "./provider.js";
import type { Message } from "./types.js";

/**
 * Three-tier model config. `main` is the default the loop starts each turn
 * from; `fast` is the cheap tier used for auto-compact summarization (and is
 * the last fallback); `max` is the optional heavy tier. Providing `models`
 * (via AgentConfig) also enables per-turn tier fallback.
 */
export interface ModelTiers {
  fast?: string;
  main: string;
  max?: string;
  /** Context window (tokens) per tier, used to resolve the loop's token
   *  budget when `contextTokenBudget` is unset — the budget then follows the
   *  turn's model instead of the global default. Setting `contextWindow` at
   *  all requires `main`. */
  contextWindow?: { fast?: number; main: number; max?: number };
}

/** Input to the host policy hook consulted once per turn. */
export interface ModelForInput {
  conversationId: string;
  /** 1-based loop turn. */
  turn: number;
  /** Snapshot copy of the conversation so far (never mutated by the hook). */
  messages: Message[];
  /** Resolved default for this run (`models.main` ?? `model`; a per-send
   *  override replaces it — and suppresses the hook entirely). */
  defaultModel: string;
}

/** Host policy hook: pick the model for a turn. May be async (awaited once
 *  per turn, before context.fit so token counting uses the chosen model).
 *  Consulted only for the turn's STARTING model — tier fallback after an
 *  availability error is mechanical and never re-consults the hook. */
export type ModelForHook = (input: ModelForInput) => string | Promise<string>;

/**
 * Models to try for one turn, starting at `start`: `start` followed by the
 * tiers strictly below it in rank (max > main > fast), deduped. A start model
 * not in the tiers — or no tiers configured — yields a chain of one (no
 * fallback). Derived fresh per turn so a fallback never sticks.
 */
export function fallbackChain(start: string, tiers?: ModelTiers): string[] {
  if (!tiers) return [start];
  const ranked = [tiers.max, tiers.main, tiers.fast].filter(
    (m): m is string => typeof m === "string" && m !== "",
  );
  const idx = ranked.indexOf(start);
  if (idx < 0) return [start];
  const out: string[] = [];
  for (let i = idx; i < ranked.length; i++) {
    if (!out.includes(ranked[i]!)) out.push(ranked[i]!);
  }
  return out;
}

/**
 * The context window declared for `model` in `tiers`, if any. Matches the
 * tier slot by exact model id, checking in rank order (max → main → fast) —
 * hosts shouldn't list one model under two tiers.
 */
export function contextWindowFor(model: string, tiers?: ModelTiers): number | undefined {
  const w = tiers?.contextWindow;
  if (!w) return undefined;
  if (tiers.max === model) return w.max;
  if (tiers.main === model) return w.main;
  if (tiers.fast === model) return w.fast;
  return undefined;
}

/**
 * True when an error qualifies for tier fallback: an availability failure of
 * the model itself (529/overloaded, 5xx, or the model being gone). Deliberately
 * ignores the `retryable` flag — a 503 an adapter marked non-retryable is still
 * a capacity signal, and a cheaper sibling model may serve the turn. Deliberately
 * excludes 429: rate limits are account-level, so switching models buys nothing.
 */
export function isFallbackEligible(err: unknown): boolean {
  const e = err as ProviderError;
  if (e.code === "overloaded" || e.code === "model_not_found") return true;
  return typeof e.status === "number" && (e.status === 529 || e.status >= 500);
}

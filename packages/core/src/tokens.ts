// Token estimation for context management — the "estimate" half of a
// two-signal design (the same one Claude Code / Codex CLI use). The other
// half is the real-usage anchor: every provider response reports the exact
// input size the server just processed, and consumers re-anchor on it. No
// tokenizer dependency here — a CJK-aware character heuristic fills the gaps
// (plain char/4 undercounts Chinese ~4-8×, and Chinese-first hosts would
// blow past the soft trigger long before it fired).

import type { TokenUsage } from "./provider.js";
import type { Message, TextContent } from "./types.js";

/** Default context token budget when nothing else declares one (1M — the
 *  current mainstream window size; with real-usage anchoring the trigger
 *  tracks actual context, so the default can match the window instead of
 *  pre-shrinking for estimator error). Hosts on models whose window differs
 *  should set `contextTokenBudget` or `models.contextWindow`. Re-exported
 *  from agent.ts for hosts. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 1_000_000;

/** UTF-16 code-unit ranges that tokenize at roughly one token per character:
 *  CJK ideographs (incl. extensions A + compatibility), kana, hangul, CJK
 *  punctuation and fullwidth forms; surrogate halves cover the astral CJK
 *  extensions — and emoji, which also cost ≥1 token each. Everything else
 *  (Latin, digits, ASCII punctuation, whitespace) averages ~4 chars/token
 *  across current tokenizers. */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x303f], // CJK radicals + symbols/punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3130, 0x318f], // Hangul compatibility jamo
  [0x31f0, 0x31ff], // Katakana phonetic extensions
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul jamo extension A
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xffef], // fullwidth forms
  [0xd800, 0xdfff], // surrogate halves (astral CJK ext / emoji)
];

/** "Does this code unit cost about a token?" — an ESTIMATION predicate, not a
 *  word-character test. It deliberately sweeps in CJK punctuation, fullwidth
 *  forms and surrogate halves because those all cost ≥1 token each. Do not
 *  reuse it to decide where words begin and end (recall.ts has its own
 *  classifier for exactly that reason — punctuation is not a word). */
function isCjkUnit(c: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (c >= lo && c <= hi) return true;
  }
  return false;
}

/** Heuristic token count for one string: ~1 token per CJK character, ~4
 *  chars/token otherwise. Approximate by design — good enough to estimate
 *  *increments* between anchors; absolute accuracy comes from the usage
 *  anchor (estimateContextTokens), not from this function. */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkUnit(text.charCodeAt(i))) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** Heuristic token count for a message array — what provider `countTokens`
 *  implementations and the loop's fallback both delegate to. Counts the text
 *  actually carried in history: message strings, text blocks, thinking text
 *  (providers replay thinking blocks, so they occupy the window too),
 *  tool_call input JSON, and tool_result text (string or text blocks).
 *  Images are skipped (per-model cost) — the usage anchor corrects for them. */
export function estimateMessagesTokens(msgs: readonly Message[]): number {
  let total = 0;
  for (const m of msgs) {
    if (typeof m.content === "string") {
      total += estimateTextTokens(m.content);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text" || b.type === "thinking") total += estimateTextTokens(b.text);
      else if (b.type === "tool_call") total += estimateTextTokens(b.inputJson);
      else if (b.type === "tool_result") {
        total +=
          typeof b.content === "string"
            ? estimateTextTokens(b.content)
            : b.content
                .filter((x): x is TextContent => x.type === "text")
                .reduce((n, x) => n + estimateTextTokens(x.text), 0);
      }
    }
  }
  return total;
}

/** The newest usage-bearing assistant message and how many messages preceded
 *  it: that message's provider-reported `inputTokens` covered exactly
 *  messages[0..msgCount-1] (the request that produced it), so everything
 *  after `msgCount` is the only part needing a heuristic estimate. */
export interface UsageAnchor {
  inputTokens: number;
  msgCount: number;
}

/** Find the newest real-usage anchor in a message array (assistant messages
 *  carry `metadata.usage` — the loop stamps every reply with withTurnMeta).
 *  Undefined when nothing reports a positive input size yet. */
export function usageAnchor(messages: readonly Message[]): UsageAnchor | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const u = (m.metadata as { usage?: TokenUsage } | undefined)?.usage;
    if (u === null || typeof u !== "object" || typeof u.inputTokens !== "number" || u.inputTokens <= 0) continue;
    return { inputTokens: u.inputTokens, msgCount: i };
  }
  return undefined;
}

/** Best-available total-context estimate over a message array: real usage
 *  from the newest anchored response plus a heuristic increment for what was
 *  appended after it. Falls back to a pure heuristic when no usage is
 *  stamped. Exact up to the estimator on append-only stores; on a host-side
 *  compacted view (originals dropped) it can overestimate — which errs
 *  toward earlier compaction, never later. */
export function estimateContextTokens(messages: readonly Message[]): number {
  const a = usageAnchor(messages);
  if (a === undefined) return estimateMessagesTokens(messages);
  return a.inputTokens + estimateMessagesTokens(messages.slice(a.msgCount));
}

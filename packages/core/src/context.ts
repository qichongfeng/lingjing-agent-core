// Context window management. Trim = drop oldest tool_call+tool_result pairs
// (cheapest, works everywhere). Compact = summarize dropped turns (Phase 2,
// provider-backed; on Anthropic may delegate to server-side compaction beta).

import { randomId } from "./types.js";
import type { Content, Message, TextContent } from "./types.js";
import type { LLMProvider, ProviderRequest } from "./provider.js";
import type { Tool } from "./tool.js";

export interface ContextFitInput {
  messages: Message[];
  tools: Tool[];
  system: string | TextContent[] | undefined;
  tokenBudget: number;
  /** Token counter over message arrays. Contract: CHEAP and local (the loop
   *  passes the provider's countTokens ?? heuristic estimate — both sync-ish).
   *  Trimming loops call it once per dropped pair, so a network-backed
   *  implementation would turn one trim into N API calls; keep remote counting
   *  out of this seam. */
  countTokens: (msgs: Message[]) => Promise<number>;
  /** Best-available estimate of THIS array's total context tokens — the loop
   *  anchors on provider-reported real usage and heuristically estimates only
   *  the increment since (see loop.ts / tokens.ts). When present, managers use
   *  it for trigger decisions (absolute units, includes system+tools+cache);
   *  countTokens() stays the yardstick for trimming progress and tokensSaved
   *  (relative units — heuristic drift cancels out in deltas). */
  currentTokens?: number;
  /** The run triggering fit/compact. Managers stamp it onto messages they
   * CREATE (the summary note) so groupExchanges keeps the note inside that
   * run's exchange instead of rendering a phantom unstamped user turn. */
  runId?: string;
  /** Run abort signal; a context manager that calls the provider (e.g. to summarize)
   * should thread it into its provider request so a cancelled run halts compaction. */
  signal?: AbortSignal;
}

export interface ContextFitResult {
  messages: Message[];
  compacted: boolean;
  tokensSaved?: number;
}

export interface ContextManager {
  fit(input: ContextFitInput): Promise<ContextFitResult>;
  /** Force summarization beyond the soft trigger (for context_window_exceeded). */
  compact(input: ContextFitInput): Promise<ContextFitResult>;
}

/**
 * Phase 1 default: drop the oldest tool_call+tool_result pair repeatedly until
 * under budget. Preserves system prompt (caller passes it separately) and the
 * most recent turns. Never trims the last user message.
 */
export class TrimContextManager implements ContextManager {
  constructor(private opts: { triggerRatio?: number; keepLastN?: number } = {}) {}

  async fit(input: ContextFitInput): Promise<ContextFitResult> {
    const { messages, tokenBudget, countTokens } = input;
    const trigger = (this.opts.triggerRatio ?? 0.8) * tokenBudget;
    let current = messages;
    const heuristicBefore = await countTokens(current);
    // Real-usage anchor (preferred) over the heuristic: the fixed overhead
    // (system + tools + cache tokens the heuristic can't see) rides along as
    // an additive constant, so trimming progress stays in heuristic units.
    const overhead = (input.currentTokens ?? heuristicBefore) - heuristicBefore;
    if (heuristicBefore + overhead <= trigger) {
      return { messages: current, compacted: false };
    }
    const keepLastN = this.opts.keepLastN ?? 4;
    let trimmed = 0;
    // Drop oldest tool_call/tool_result pairs from the middle, keeping last N messages.
    while (current.length > keepLastN) {
      const idx = findOldestToolPair(current, current.length - keepLastN);
      if (idx < 0) {
        // No tool_call/tool_result pairs left to drop as a unit — drop the single
        // oldest message instead, so a huge no-tool history can still be trimmed
        // (otherwise compact would no-op and the loop would give up misleadingly).
        current = current.slice(1);
      } else {
        current = [...current.slice(0, idx), ...current.slice(idx + 2)];
      }
      trimmed++;
      if ((await countTokens(current)) + overhead <= trigger) break;
    }
    return {
      messages: current,
      compacted: trimmed > 0,
      tokensSaved: Math.max(0, heuristicBefore - (await countTokens(current))),
    };
  }

  async compact(input: ContextFitInput): Promise<ContextFitResult> {
    // TrimContextManager has no summarization; fall back to aggressive trim.
    return this.fit(input);
  }
}

/** Find the index of the oldest assistant(tool_call) immediately followed by user(tool_result). */
function findOldestToolPair(messages: Message[], upTo: number): number {
  for (let i = 0; i < upTo - 1; i++) {
    const a = messages[i];
    const b = messages[i + 1];
    if (!a || !b) continue;
    if (a.role !== "assistant" || b.role !== "user") continue;
    if (typeof a.content !== "string" && hasToolCall(a.content) && typeof b.content !== "string" && hasToolResult(b.content)) {
      return i;
    }
  }
  return -1;
}

function hasToolCall(content: unknown[]): boolean {
  return content.some((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_call");
}
function hasToolResult(content: unknown[]): boolean {
  return content.some((b) => typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_result");
}

// ---------------------------------------------------------------------------
// CompactContextManager — summarize the oldest turns into one note (Phase 2).
// ---------------------------------------------------------------------------

/** Matching key for recognizing notes (old and new label forms share it —
 *  notes created before the self-describing label must still be detected). */
const SUMMARY_PREFIX = "[Earlier conversation summary";
/** The note's first line: self-describing, so the model treats it as
 *  system-side context rather than something the user said. */
const SUMMARY_LABEL =
  "[Earlier conversation summary — auto-generated recap of earlier turns, not a user message]";
// Structured per context-compaction best practice (Claude Code / Codex style):
// an explicit preserve-list beats a generic "summarize" — the recap is the only
// memory of the head, so it must keep decisions, entities, actions and open
// work, not just a vague gist.
const DEFAULT_SUMMARIZE_SYSTEM =
  "Summarize the earlier conversation below into a concise recap that preserves, " +
  "in order of importance: (1) the user's requests and goals (keep original " +
  "wording where it matters); (2) decisions made and their reasons; (3) files, " +
  "URLs, and entities involved; (4) actions taken and their outcomes (tool " +
  "calls, whether they succeeded); (5) open tasks and unresolved questions with " +
  "next steps; (6) user preferences or constraints. Drop pleasantries and " +
  "duplication. Match the conversation's language. Plain prose or a compact " +
  "list, no headings.";
const MAX_SUMMARY_INPUT_CHARS = 24_000;
/** Marker replacing an old tool_result's content in the microcompact phase. */
const CLEARED_TOOL_RESULT = "[cleared for context: old tool result]";

export interface CompactContextManagerOptions {
  provider: LLMProvider;
  model: string;
  /** Summarize once token usage crosses this fraction of the budget. Default 0.75. */
  triggerRatio?: number;
  /** Keep this many most-recent messages verbatim. Default 6. */
  keepLastN?: number;
  /** Max tokens for the summarize turn. Default 1024. */
  summarizeMaxTokens?: number;
  /** Override the neutral summarize system prompt. */
  summarizeSystemPrompt?: string;
  /** Vendor escape hatch forwarded into the summarize request (e.g.
   *  DashScope/Qwen `body.enable_thinking: false` — the summary is mechanical
   *  compression, and a thinking-default model can burn the whole
   *  summarizeMaxTokens budget on reasoning, yielding an empty summary that
   *  silently degrades to trim). */
  providerOptions?: Record<string, unknown>;
}

/**
 * Compact by summarizing the oldest turns into a single `[Earlier conversation
 * summary]` note, keeping the most recent `keepLastN` messages verbatim. The
 * summary is produced by a one-shot, tool-free `provider.stream()` call with a
 * neutral prompt — no vendor compaction API, so it is provider-agnostic.
 *
 * The summary note is a `role:"user"` message (not "system"): Anthropic's adapter
 * rejects `role:"system"` inside `messages[]` (a `system` must be passed via
 * `ProviderRequest.system`), and `ContextFitResult` carries no separate `system`
 * field. A bracketed-labeled user note is the portable choice across providers.
 *
 * Failures are swallowed and degrade to trim: summarization must never break the
 * loop. Falls back to `TrimContextManager.fit` when the provider errors or yields
 * an empty summary. (Server-side compaction e.g. Anthropic's `compact` beta is an
 * adapter-level concern — not used here; see DESIGN §3.6.)
 */
export class CompactContextManager implements ContextManager {
  constructor(private opts: CompactContextManagerOptions) {}

  async fit(input: ContextFitInput): Promise<ContextFitResult> {
    const heuristicBefore = await input.countTokens(input.messages);
    const overhead = (input.currentTokens ?? heuristicBefore) - heuristicBefore;
    const trigger = (this.opts.triggerRatio ?? 0.75) * input.tokenBudget;
    if (heuristicBefore + overhead <= trigger) return { messages: input.messages, compacted: false };
    // Microcompact first: stub old tool_results / drop old thinking in the head
    // region — zero model calls, and strictly higher fidelity than a summary
    // (the calls stay; only their bulky outputs go). If that brings the view
    // back under the trigger, summarization is unnecessary this turn. Same
    // ladder as Claude Code's clear-old-tool-results / Anthropic context
    // editing; the summary is the second rung, not the first.
    const stubbed = this.stubHead(input.messages, this.splitIndex(input.messages));
    if (stubbed !== input.messages) {
      const heuristicStubbed = await input.countTokens(stubbed);
      if (heuristicStubbed + overhead <= trigger) {
        return {
          messages: stubbed,
          compacted: true,
          ...(heuristicBefore - heuristicStubbed > 0 ? { tokensSaved: heuristicBefore - heuristicStubbed } : {}),
        };
      }
    }
    return this.summarize(input);
  }

  async compact(input: ContextFitInput): Promise<ContextFitResult> {
    return this.summarize(input);
  }

  private async summarize(input: ContextFitInput): Promise<ContextFitResult> {
    const splitAt = this.splitIndex(input.messages);
    const headRegion = input.messages.slice(0, splitAt);
    const tail = input.messages.slice(splitAt);
    const lastHeadId = headRegion.length > 0 ? headRegion[headRegion.length - 1]!.id : undefined;

    // Incremental path: the newest summary note ANYWHERE in the array carries
    // `coveredUntil` — the id of the last message its recap stands for.
    // Everything up to that id is already represented, so:
    //  - no new material fell out of the verbatim window since → reuse the
    //    note verbatim, ZERO model calls;
    //  - new material did fall out → fold ONLY that increment plus the prior
    //    recap into one fresh rolling note.
    // Without this, an append-only store means every run over the trigger
    // re-summarizes the entire head (O(full head) per user message, forever).
    // Store order puts a note AFTER the messages it covers (append-only), so
    // the note often sits in the TAIL while its coveredUntil resolves in the
    // head — hence the array-wide search. A note whose coveredUntil no longer
    // resolves (the materialized view dropped the covered originals) takes
    // the full path below — not incremental, but coverage-preserving: the
    // prior recap is folded into the new summary input. When a prior note
    // leads the view, older notes are dropped from the tail: the leading note
    // subsumes them (its recap folded theirs, or reuses them verbatim).
    let priorIdx = -1;
    for (let i = input.messages.length - 1; i >= 0; i--) {
      if (isSummaryNote(input.messages[i]!)) {
        priorIdx = i;
        break;
      }
    }
    const prior = priorIdx >= 0 ? input.messages[priorIdx] : undefined;
    const coveredUntilId = summaryCoverage(prior);
    const coveredArr =
      typeof coveredUntilId === "string" ? input.messages.findIndex((m) => m.id === coveredUntilId) : -1;

    if (prior && coveredArr >= 0) {
      const increment = input.messages.slice(coveredArr + 1, splitAt).filter((m) => !isSummaryNote(m));
      const tailLive = tail.filter((m) => !isSummaryNote(m));
      if (increment.length === 0) {
        return this.assemble(prior, tailLive, input);
      }
      try {
        const summary = await this.requestSummaryText(
          `${SUMMARY_LABEL}\n${summaryTextOf(prior)}\n\n${renderForSummary(increment)}`,
          input.signal,
        );
        if (summary) return this.assemble(this.makeNote(summary, input, lastHeadId), tailLive, input);
      } catch {
        // fall through to trim
      }
      return this.trimFallback(input);
    }

    // Full path: first compaction, a legacy note without coverage info, or a
    // prior note whose coveredUntil no longer resolves — the materialized
    // view (materializeCompactedView) drops the covered originals at load, so
    // EVERY cross-run re-compaction lands here. The prior note is then the
    // ONLY record of the history it covers: fold its recap into the summary
    // input, or that history is silently lost (the note itself is dropped
    // from the view when the new one rides).
    const head = headRegion.filter((m) => !isSummaryNote(m));
    if (head.length < 2) return this.trimFallback(input);
    try {
      const priorText = prior === undefined ? "" : `${SUMMARY_LABEL}\n${summaryTextOf(prior)}\n\n`;
      const summary = await this.requestSummaryText(priorText + renderForSummary(head), input.signal);
      if (summary) return this.assemble(this.makeNote(summary, input, lastHeadId), tail, input);
    } catch {
      // fall through to trim
    }
    return this.trimFallback(input);
  }

  /** Boundary index between the head (compaction candidates) and the verbatim
   *  tail: the last `keepLastN` NON-NOTE messages are kept verbatim — notes
   *  are model-facing context, not conversation, so they never consume a
   *  window slot (an appended note must not push the boundary and expose one
   *  more original every run). Pair-aware: never strand a tool_result in the
   *  tail without its tool_use (an orphan `{role:"tool"}` message gets strict
   *  OpenAI-compatible endpoints a 400); the pair is adjacent by construction
   *  (executeTools pushes the result carrier right after the assistant), so
   *  checking the immediately preceding message and pulling one back is
   *  enough. */
  private splitIndex(messages: Message[]): number {
    const keepLastN = this.opts.keepLastN ?? 6;
    let kept = 0;
    let splitAt = messages.length;
    while (splitAt > 0 && kept < keepLastN) {
      splitAt--;
      if (!isSummaryNote(messages[splitAt]!)) kept++;
    }
    if (splitAt > 0 && carriesToolResult(messages[splitAt]!) && hasToolCalls(messages[splitAt - 1]!)) {
      splitAt--;
    }
    return splitAt;
  }

  /** Microcompact the head region: replace each old tool_result's content with
   *  a short marker (the call itself stays — the model can re-run the tool if
   *  it truly needs the output) and drop old thinking blocks (single-turn
   *  scoped, bulky, and dead weight once the turn is past). Idempotent; tail
   *  messages and message ids are untouched (ids stay stable for persistence
   *  filtering and the summary-note coverage stamps). Returns the SAME array
   *  reference when there is nothing to stub. */
  private stubHead(messages: Message[], splitAt: number): Message[] {
    let changed = false;
    const out = messages.map((m, i) => {
      if (i >= splitAt || !Array.isArray(m.content)) return m;
      let touched = false;
      const blocks: Content[] = [];
      for (const b of m.content) {
        if (b.type === "thinking") {
          touched = true; // dropped entirely
          continue;
        }
        if (b.type === "tool_result" && b.content !== CLEARED_TOOL_RESULT) {
          touched = true;
          blocks.push({ ...b, content: CLEARED_TOOL_RESULT });
          continue;
        }
        blocks.push(b);
      }
      if (!touched) return m;
      changed = true;
      return { ...m, content: blocks };
    });
    return changed ? out : messages;
  }

  /** Build the summary note; `coveredUntil` stamps what the recap stands for
   *  (the last head message at split time) so the next fit can go incremental. */
  private makeNote(summary: string, input: ContextFitInput, coveredUntil: string | undefined): Message {
    return {
      id: randomId(),
      role: "user",
      content: `${SUMMARY_LABEL}\n${summary}`,
      createdAt: Date.now(),
      // runId groups the note into the triggering run's exchange (see
      // ContextFitInput.runId); coveredUntil drives incremental summarization.
      ...(input.runId !== undefined || coveredUntil !== undefined
        ? {
            metadata: {
              ...(input.runId !== undefined ? { runId: input.runId } : {}),
              ...(coveredUntil !== undefined ? { coveredUntil } : {}),
            },
          }
        : {}),
    };
  }

  private async assemble(note: Message, tail: Message[], input: ContextFitInput): Promise<ContextFitResult> {
    const out = [note, ...tail];
    const before = await input.countTokens(input.messages);
    const after = await input.countTokens(out);
    return {
      messages: out,
      compacted: true,
      ...(before - after > 0 ? { tokensSaved: before - after } : {}),
    };
  }

  private async requestSummaryText(rendered: string, signal: AbortSignal | undefined): Promise<string> {
    const req: ProviderRequest = {
      model: this.opts.model,
      system: this.opts.summarizeSystemPrompt ?? DEFAULT_SUMMARIZE_SYSTEM,
      messages: [{ id: randomId(), role: "user" as const, content: rendered, createdAt: Date.now() }],
      // Summarization is mechanical compression — no reasoning wanted. The
      // neutral disable maps where the provider supports it (OpenAI series →
      // reasoning_effort "none"); thinking-default OpenAI-compatible models
      // additionally need the vendor switch via providerOptions.
      config: {
        maxTokens: this.opts.summarizeMaxTokens ?? 1024,
        thinking: { type: "disabled" },
        ...(this.opts.providerOptions !== undefined ? { providerOptions: this.opts.providerOptions } : {}),
      },
      signal: signal ?? new AbortController().signal,
    };
    let text = "";
    for await (const chunk of this.opts.provider.stream(req)) {
      if (chunk.type === "text_delta") text += chunk.text;
    }
    return text.trim();
  }

  private async trimFallback(input: ContextFitInput): Promise<ContextFitResult> {
    return new TrimContextManager().fit(input);
  }
}

/** A `role:"user"` message whose text begins with the summary label. Exported
 *  so hosts can recognize compaction notes in loaded history (e.g. hide them
 *  from the chat UI — the note is model-facing context, not conversation). */
export function isSummaryNote(m: Message): boolean {
  if (m.role !== "user") return false;
  const t =
    typeof m.content === "string"
      ? m.content
      : m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
  return t.startsWith(SUMMARY_PREFIX);
}

/** Derive the effective request view from PERSISTED history — the inverse of an
 *  in-run compaction. Store order is append-only: `[...originals, note,
 *  post-compaction turns]`. When the newest note's `coveredUntil` resolves in
 *  the array, everything up to and including that message is represented by
 *  the note's recap: drop those originals and lead the view with the note
 *  (older notes in the remainder are subsumed by the newest one's rolling
 *  recap). Without this, a reloaded conversation would re-send the full
 *  un-compacted history once — the seeded usage anchor reflects the compacted
 *  view the last request actually carried, so fit's trigger check
 *  under-estimates and misses — before the next response re-anchors.
 *
 *  Conservative by design: no note, or a stamp that doesn't resolve (host
 *  pruned history, legacy note without coverage) → the array is returned
 *  unchanged (full view, exactly the pre-materialization behavior). Hosts
 *  rendering the full transcript keep reading the store directly; this only
 *  shapes what the loop SENDS. */
export function materializeCompactedView(messages: Message[]): Message[] {
  let noteIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isSummaryNote(messages[i]!)) {
      noteIdx = i;
      break;
    }
  }
  if (noteIdx < 0) return messages;
  const coveredUntil = summaryCoverage(messages[noteIdx]);
  if (typeof coveredUntil !== "string") return messages;
  const coveredIdx = messages.findIndex((m) => m.id === coveredUntil);
  if (coveredIdx < 0 || coveredIdx >= noteIdx) return messages; // unresolvable / odd ordering → full view
  const tail = messages.slice(coveredIdx + 1).filter((m) => !isSummaryNote(m));
  return [messages[noteIdx]!, ...tail];
}

/** A note's `coveredUntil` stamp (the last message id its recap stands for). */
function summaryCoverage(note: Message | undefined): unknown {
  return (note?.metadata as { coveredUntil?: unknown } | undefined)?.coveredUntil;
}

/** A note's recap text with its label line stripped (works for both the old
 *  short label and the current self-describing one — strip through the first
 *  newline rather than a fixed-length prefix). */
function summaryTextOf(note: Message): string {
  const t =
    typeof note.content === "string"
      ? note.content
      : note.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
  if (!t.startsWith(SUMMARY_PREFIX)) return t;
  const nl = t.indexOf("\n");
  return nl >= 0 ? t.slice(nl + 1) : "";
}

/** True if the message carries one or more tool_result blocks. */
function carriesToolResult(m: Message): boolean {
  return (
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.some((b) => b.type === "tool_result")
  );
}

/** True if the message carries one or more tool_call blocks. */
function hasToolCalls(m: Message): boolean {
  return (
    m.role === "assistant" &&
    Array.isArray(m.content) &&
    m.content.some((b) => b.type === "tool_call")
  );
}

/**
 * Render messages to a compact transcript for summarization. Strips
 * `ThinkingContent` (provider-proprietary, signature-leaky) and collapses
 * tool_call/tool_result blocks to brief tagged lines; images are omitted.
 * Truncates to `MAX_SUMMARY_INPUT_CHARS` to bound the summarize input.
 */
function renderForSummary(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      lines.push(`${m.role}: ${m.content}`);
      continue;
    }
    for (const block of m.content as Content[]) {
      switch (block.type) {
        case "thinking":
          break; // strip — provider-proprietary, may carry an opaque signature
        case "text":
          lines.push(`${m.role}: ${block.text}`);
          break;
        case "tool_call":
          lines.push(`${m.role}: called ${block.name}(${block.inputJson})`);
          break;
        case "tool_result": {
          const t =
            typeof block.content === "string"
              ? block.content
              : block.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
          lines.push(`tool ${block.toolCallId}: ${t}`);
          break;
        }
        case "image":
          break; // not representable in a text summary
      }
    }
  }
  const joined = lines.join("\n");
  return joined.length > MAX_SUMMARY_INPUT_CHARS ? joined.slice(0, MAX_SUMMARY_INPUT_CHARS) : joined;
}

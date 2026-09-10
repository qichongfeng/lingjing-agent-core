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
  countTokens: (msgs: Message[]) => Promise<number>;
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
    const before = await countTokens(current);
    if (before <= trigger) {
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
      const after = await countTokens(current);
      if (after <= trigger) break;
    }
    return {
      messages: current,
      compacted: trimmed > 0,
      tokensSaved: Math.max(0, before - (await countTokens(current))),
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

const SUMMARY_LABEL = "[Earlier conversation summary]";
const DEFAULT_SUMMARIZE_SYSTEM =
  "Summarize the earlier conversation below into a concise recap that preserves " +
  "key facts, decisions, tool results, and any open tasks. Use plain prose, no headings.";
const MAX_SUMMARY_INPUT_CHARS = 24_000;

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
    const before = await input.countTokens(input.messages);
    const trigger = (this.opts.triggerRatio ?? 0.75) * input.tokenBudget;
    if (before <= trigger) return { messages: input.messages, compacted: false };
    return this.summarize(input);
  }

  async compact(input: ContextFitInput): Promise<ContextFitResult> {
    return this.summarize(input);
  }

  private async summarize(input: ContextFitInput): Promise<ContextFitResult> {
    const keepLastN = this.opts.keepLastN ?? 6;
    const splitAt = Math.max(0, input.messages.length - keepLastN);
    const head = input.messages.slice(0, splitAt).filter((m) => !isSummaryNote(m));
    const tail = input.messages.slice(splitAt);
    if (head.length < 2) return this.trimFallback(input);

    try {
      const summary = await this.requestSummary(head, input.signal);
      if (!summary) return this.trimFallback(input);
      const note: Message = {
        id: randomId(),
        role: "user",
        content: `${SUMMARY_LABEL}\n${summary}`,
        createdAt: Date.now(),
        // Group into the triggering run's exchange (see ContextFitInput.runId).
        ...(input.runId !== undefined && { metadata: { runId: input.runId } }),
      };
      const out = [note, ...tail];
      const before = await input.countTokens(input.messages);
      const after = await input.countTokens(out);
      return {
        messages: out,
        compacted: true,
        ...(before - after > 0 ? { tokensSaved: before - after } : {}),
      };
    } catch {
      try {
        return await this.trimFallback(input);
      } catch {
        return { messages: input.messages, compacted: false };
      }
    }
  }

  private async requestSummary(head: Message[], signal: AbortSignal | undefined): Promise<string> {
    const rendered = renderForSummary(head);
    const req: ProviderRequest = {
      model: this.opts.model,
      system: this.opts.summarizeSystemPrompt ?? DEFAULT_SUMMARIZE_SYSTEM,
      messages: [{ id: randomId(), role: "user" as const, content: rendered, createdAt: Date.now() }],
      config: { maxTokens: this.opts.summarizeMaxTokens ?? 1024 },
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

/** A `role:"user"` message whose text begins with the summary label. */
function isSummaryNote(m: Message): boolean {
  if (m.role !== "user") return false;
  const t =
    typeof m.content === "string"
      ? m.content
      : m.content.filter((b): b is TextContent => b.type === "text").map((b) => b.text).join("");
  return t.startsWith(SUMMARY_LABEL);
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

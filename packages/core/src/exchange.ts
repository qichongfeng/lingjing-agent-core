// Read-side projection over stored history. Storage keeps the replay shape
// (exactly what the next request re-sends); this module groups that flat
// Message[] into exchanges for hosts that render or export conversations.
// Pure functions only — no state, no storage, no I/O.
//
// Grouping uses EXPLICIT marks first: everything agent.stream() appends during
// one run carries the same metadata.runId, so one run == one exchange
// regardless of message roles (hook-injected context stays inside the run).
// Structural inference (roles + the carrier shape runLoop persists) is the
// fallback for host-authored history that carries no run stamp.

import type { Message, ToolCall, ToolResult } from "./types.js";

/**
 * One exchange: an opening message (typically the user's input) plus everything
 * the loop produced in response, in occurrence order. One agent.stream() run
 * (with its tool loop) is exactly one exchange.
 */
export interface Exchange {
  /**
   * The message that opened this exchange. Usually role "user"; absent when
   * history starts mid-conversation (seeded openers, compacted history, or a
   * leading tool-result carrier). The message is kept verbatim — extract text
   * with `extractText` if needed.
   */
  user?: Message;
  /** Assistant turns, injected context, and tool activity, in the order they occurred. */
  steps: ExchangeStep[];
}

export type ExchangeStep =
  /** One assistant turn as persisted (one Message per turn). */
  | { kind: "assistant"; message: Message }
  /**
   * A user-role message that is NOT the exchange opener — hook-injected context
   * (RAG, guardrails) or an extra input message within the same run.
   */
  | { kind: "user"; message: Message }
  /**
   * A tool call surfaced as its own step, paired with its result once known.
   * `result` is undefined while the call is pending or was interrupted.
   * `call` references the same object held inside the preceding assistant
   * step's message content.
   */
  | { kind: "tool_pair"; call: ToolCall; result?: ToolResult }
  /** A tool result whose call is not in this exchange (e.g. trimmed away by
   *  compaction). Kept rather than dropped — hosts decide how to render it. */
  | { kind: "tool_result"; result: ToolResult };

/** The `tool_pair` member of {@link ExchangeStep}. */
export type ToolPairStep = Extract<ExchangeStep, { kind: "tool_pair" }>;

/**
 * Group stored history into exchanges.
 *
 * Primary path — explicit run stamps: every message this library appends
 * during one `agent.stream()` run carries `metadata.runId` (tool-result
 * carriers additionally carry `metadata.sourceMessageId` pointing at the
 * assistant message whose calls they answer). All messages sharing a runId
 * form ONE exchange, in occurrence order.
 *
 * Fallback path — structural, for host-authored history with no run stamp: a
 * non-carrier user message opens a new exchange; each turn is one assistant
 * Message; a user Message whose content is purely ToolResult blocks is the
 * loop's results carrier. This is the exact shape `runLoop` persists, but it
 * makes no claim about authorship — an injected user message without a run
 * stamp opens its own exchange just like human input.
 *
 * Conservation: every input message appears exactly once — as `exchange.user`,
 * as an `assistant` or `user` step, or (for pure tool-result carriers)
 * deconstructed into tool results that each appear exactly once. Every
 * tool_call block also surfaces as a `tool_pair` step. User messages with
 * mixed content (host-built, never loop-produced) are kept verbatim and never
 * deconstructed.
 */
export function groupExchanges(messages: Message[]): Exchange[] {
  const exchanges: Exchange[] = [];
  const byRun = new Map<string, Exchange>();
  let cur: Exchange | null = null; // most recent exchange (structural fallback target)

  const open = (user?: Message): Exchange => {
    const e: Exchange = user !== undefined ? { user, steps: [] } : { steps: [] };
    exchanges.push(e);
    return e;
  };

  for (const m of messages) {
    const runId = runIdOf(m);

    if (runId !== undefined) {
      // Explicit path: one run == one exchange, whatever the message roles.
      let ex = byRun.get(runId);
      if (!ex) {
        ex = open();
        byRun.set(runId, ex);
      }
      cur = ex;
      if (m.role === "assistant") {
        addAssistant(ex, m);
      } else if (isToolResultCarrier(m)) {
        backfill(ex, m.content);
      } else if (ex.user === undefined) {
        ex.user = m; // the run's opening message (typically the input)
      } else {
        ex.steps.push({ kind: "user", message: m }); // injected context / extra input
      }
      continue;
    }

    // Structural fallback (host-authored history without run stamps).
    if (m.role === "assistant") {
      const ex = (cur ??= open());
      addAssistant(ex, m);
      continue;
    }
    if (isToolResultCarrier(m)) {
      const ex = (cur ??= open());
      backfill(ex, m.content);
      continue;
    }
    // Opening message: starts a new exchange (closes the previous one).
    cur = open(m);
  }

  return exchanges;
}

/** Append an assistant step plus a pending tool_pair step per tool_call block. */
function addAssistant(ex: Exchange, m: Message): void {
  ex.steps.push({ kind: "assistant", message: m });
  const blocks = typeof m.content === "string" ? [] : m.content;
  for (const b of blocks) {
    if (b.type === "tool_call") ex.steps.push({ kind: "tool_pair", call: b });
  }
}

/** Pair results into pending tool_pair steps; keep unmatched ones as orphans. */
function backfill(ex: Exchange, results: ToolResult[]): void {
  for (const r of results) {
    // Backfill the most recent pending pair with a matching id, searching
    // backwards so duplicate ids pair with the nearest call.
    let pair: ToolPairStep | undefined;
    for (let i = ex.steps.length - 1; i >= 0; i--) {
      const s = ex.steps[i];
      if (s && s.kind === "tool_pair" && s.call.id === r.toolCallId && s.result === undefined) {
        pair = s;
        break;
      }
    }
    if (pair) pair.result = r;
    else ex.steps.push({ kind: "tool_result", result: r });
  }
}

function runIdOf(m: Message): string | undefined {
  const r = m.metadata?.runId;
  return typeof r === "string" ? r : undefined;
}

/** The carrier shape runLoop persists: a user message of only tool_result blocks. */
function isToolResultCarrier(m: Message): m is Message & { content: ToolResult[] } {
  return (
    m.role === "user" &&
    Array.isArray(m.content) &&
    m.content.length > 0 &&
    m.content.every((b) => b.type === "tool_result")
  );
}

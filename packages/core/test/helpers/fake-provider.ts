// FakeProvider: deterministic, no-network LLM for unit-testing the agentic loop.
// `scriptedProvider` plays back one chunk-array per turn; `loopTrapProvider`
// always returns tool_use — used to prove the maxTurns termination guarantee.

import type {
  LLMProvider,
  ProviderChunk,
  ProviderRequest,
  StopReason,
} from "../../src/provider.js";

export type FakeScript = (
  req: ProviderRequest,
  turn: number,
) => ProviderChunk[] | Promise<ProviderChunk[]>;

export class FakeProvider implements LLMProvider {
  readonly id = "fake";
  readonly capabilities = {
    stopReasons: [
      "end_turn", "tool_use", "max_tokens", "stop_sequence",
      "pause_turn", "refusal", "context_window_exceeded",
    ] as readonly StopReason[],
    streaming: true,
  };
  private turn = 0;
  constructor(private script: FakeScript) {}
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    return this.iter(req);
  }
  private async *iter(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const chunks = await this.script(req, this.turn);
    this.turn++;
    for (const c of chunks) yield c;
  }
}

/** Play back one chunk-array per turn; after the script runs out, emit end_turn. */
export function scriptedProvider(turns: ProviderChunk[][]): FakeProvider {
  return new FakeProvider((_req, turn) => {
    const t = turns[turn];
    if (!t) return textTurn("(script ended)");
    return t;
  });
}

/** Always request a tool call — never ends. Used to prove maxTurns termination. */
export function loopTrapProvider(toolName: string, input: unknown = {}): FakeProvider {
  let n = 0;
  return new FakeProvider(() => toolCallTurn(toolName, input, n++));
}

let textCounter = 0;
/** Chunks for a turn that streams `text` and ends with `stopReason` (default end_turn). */
export function textTurn(text: string, stopReason: StopReason = "end_turn"): ProviderChunk[] {
  const id = `msg_t${textCounter++}`;
  return [
    { type: "message_start", messageId: id, model: "fake" },
    { type: "text_delta", text },
    { type: "message_end", stopReason, usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

let tcCounter = 0;
/** Chunks for a turn that requests one tool call with `stopReason: tool_use`. */
export function toolCallTurn(toolName: string, input: unknown, id?: number): ProviderChunk[] {
  const n = id ?? tcCounter++;
  const tcId = `tc_${n}`;
  return [
    { type: "message_start", messageId: `msg_${n}`, model: "fake" },
    { type: "tool_call_start", toolCallId: tcId, name: toolName },
    { type: "tool_call_delta", toolCallId: tcId, inputJsonDelta: JSON.stringify(input) },
    { type: "tool_call_end", toolCallId: tcId },
    { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

/** Chunks for a turn that requests several tool calls in parallel. */
export function multiToolCallTurn(
  calls: Array<{ name: string; input: unknown; id: string }>,
): ProviderChunk[] {
  const chunks: ProviderChunk[] = [
    { type: "message_start", messageId: `msg_multi_${Date.now()}`, model: "fake" },
  ];
  for (const c of calls) {
    chunks.push({ type: "tool_call_start", toolCallId: c.id, name: c.name });
    chunks.push({ type: "tool_call_delta", toolCallId: c.id, inputJsonDelta: JSON.stringify(c.input) });
    chunks.push({ type: "tool_call_end", toolCallId: c.id });
  }
  chunks.push({ type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 3 } });
  return chunks;
}

/** Chunks for a turn that streams text AND requests a tool call. */
export function textAndToolTurn(text: string, toolName: string, input: unknown, id: string): ProviderChunk[] {
  return [
    { type: "message_start", messageId: `msg_${id}`, model: "fake" },
    { type: "text_delta", text },
    { type: "tool_call_start", toolCallId: id, name: toolName },
    { type: "tool_call_delta", toolCallId: id, inputJsonDelta: JSON.stringify(input) },
    { type: "tool_call_end", toolCallId: id },
    { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
  ];
}

/** Chunks for a turn that pauses (stop_reason pause_turn) — server resumes on re-send. */
export function pauseTurn(text = ""): ProviderChunk[] {
  // Reuse the text-turn shape but with pause_turn; reuse counter to keep ids stable.
  return textTurn(text, "pause_turn");
}

/** Chunks for a turn whose stop_reason is context_window_exceeded (history too long). */
export function cweTurn(text = ""): ProviderChunk[] {
  return textTurn(text, "context_window_exceeded");
}

/**
 * Script helper: turn N rejects with a ProviderError (transient provider failure),
 * then continues with `recoverTurns`. Returns a per-turn FakeScript. The loop's
 * `streamTurn` retries within the SAME turn, so a rejection on script-turn 0 is
 * retried and the next script-turn (1) is what the retry consumes — meaning index 0
 * is the failing attempt and index 1+ are the success path. For "fail then recover"
 * pass `failingTurns: 1` and provide the recovery script as `recoverTurns[0]`.
 */
export function failingThenRecover(
  error: Error & { retryable?: boolean; status?: number; retryAfterMs?: number },
  recoverTurns: ProviderChunk[][],
): FakeScript {
  let turn = 0;
  return () => {
    if (turn === 0) {
      turn++;
      return Promise.reject(error);
    }
    const idx = turn - 1;
    turn++;
    return recoverTurns[idx] ?? textTurn("(script ended)");
  };
}

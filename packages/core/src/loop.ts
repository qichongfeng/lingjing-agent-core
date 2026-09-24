// The agentic loop: stream → accumulate assistant message → (on tool_use)
// execute tools in parallel → feed results back → repeat → terminate.
// Termination is a hard guarantee: maxTurns caps the loop even if the provider
// always returns tool_use. This is the heart of the library.

import type { ContextManager } from "./context.js";
import type { AgentEvent } from "./events.js";
import { HookAbortError, HookError, normalizeInjected } from "./hooks.js";
import type { BeforeRequestResult, Hooks } from "./hooks.js";
import { contextWindowFor, fallbackChain, isFallbackEligible } from "./models.js";
import type { ModelForHook, ModelTiers } from "./models.js";
import type { AgentConfirmMode, PermissionGate } from "./permission.js";
import type {
  LLMProvider,
  ProviderConfig,
  ProviderError,
  ProviderRequest,
  ProviderChunk,
  StopReason,
  TokenUsage,
} from "./provider.js";
import { DEFAULT_CONTEXT_TOKEN_BUDGET, estimateMessagesTokens, usageAnchor } from "./tokens.js";
import { validateJsonSchema } from "./schema.js";
import type { Tool, ToolCallContext } from "./tool.js";
import type { Content, Message, TextContent, ToolCall, ToolResult } from "./types.js";
import { extractText, randomId, withRunId, withTurnMeta } from "./types.js";
import { AbortError, anySignal, detectRuntime, sleep, TimeoutError } from "./abort.js";

export interface LoopOptions {
  provider: LLMProvider;
  /** Run default model (per-send override already applied by agent.ts). */
  model: string;
  /** Tier table enabling per-turn availability fallback (max→main→fast).
   *  Absent → every turn is a chain of one (today's fixed-model behavior). */
  models?: ModelTiers;
  /** Host policy hook consulted once per turn for the starting model. */
  modelFor?: ModelForHook;
  system?: string | TextContent[];
  tools: Tool[];
  messages: Message[]; // mutated in place (append assistant + tool_result turns)
  /** Stamped onto every message this run appends (metadata.runId); groups the
   *  run into one exchange for groupExchanges(). */
  runId: string;
  config: ProviderConfig;
  maxTurns: number;
  toolTimeoutMs: number;
  /** Explicit token budget override (AgentConfig.contextTokenBudget). When
   *  unset, the per-turn budget resolves as models.contextWindow for the
   *  turn's model, falling back to DEFAULT_CONTEXT_TOKEN_BUDGET. */
  tokenBudget?: number;
  maxContinuations: number;
  maxStalledTurns: number;
  permissionGate?: PermissionGate;
  /** Agent-level confirmation override (AgentConfig.confirm). Default "tool":
   *  the tool's own requiresConfirmation decides. "never" skips the gate for
   *  every tool (host takes responsibility); "always" sends every tool to the
   *  gate, declared or not. */
  confirm?: AgentConfirmMode;
  hooks?: Hooks;
  context?: ContextManager;
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  signal: AbortSignal;
  conversationId: string;
  now: () => number;
  emit: (e: AgentEvent) => void;
  /** Append-only guarantee: called with the messages an in-run compaction is
   *  about to drop from the view, right before the rewrite — the host persists
   *  them so the store always holds the verbatim history (the summary note
   *  rides later; the next load re-derives the compacted view from it via
   *  materializeCompactedView). Best-effort: failures must not break the run. */
  persistDropped?: (msgs: Message[]) => void | Promise<void>;
  /** Incremental persistence (AgentConfig.persistRuns): invoked with each
   *  message the run appends, DURABLY before the run proceeds — the
   *  crash-safety foundation for agent.resume(). Best-effort: a failure
   *  degrades to the run-end batch append (which retries the same messages). */
  persist?: (msgs: Message[]) => void | Promise<void>;
  /** Diagnostic sink handed to tools as ctx.log (default: silent). */
  logger?: ToolCallContext["log"];
}

const RUNTIME = detectRuntime();

export async function runLoop(opts: LoopOptions): Promise<Message> {
  const {
    provider, model, models, modelFor, system, tools, messages, config, maxTurns, toolTimeoutMs,
    tokenBudget, maxContinuations, maxStalledTurns,
    permissionGate, hooks, context, retry, signal, conversationId, runId, now, emit,
  } = opts;
  // Swallowed observe-hook failures go here. Same sink tools get as ctx.log —
  // silent unless the host set AgentConfig.logger.
  const log: ToolCallContext["log"] = opts.logger ?? (() => {});

  let turn = 0;
  let lastAssistant: Message | undefined;
  let totalUsage: TokenUsage = emptyUsage();
  let consecutiveMaxTokens = 0;
  let continuations = 0;
  let overflowRetries = 0;
  /** Set when a compaction happened; the next beforeRequest carries it (as
   *  ctx.compacted) so hooks can re-inject durable state, then it resets. */
  let compactedSinceHook = false;
  // Real-usage anchor (Claude Code / Codex-style): the input size the
  // provider reported for the last successful request, how many messages
  // that request covered, and the history version it saw. fit()'s trigger
  // check uses anchor + heuristic increment; an in-place history rewrite
  // (compaction) bumps `historyVersion` and invalidates the anchor until the
  // next response re-anchors. Seeded from persisted history so a resumed
  // conversation is anchored from its very first turn.
  let historyVersion = 0;
  const seed = usageAnchor(messages);
  let anchor: { inputTokens: number; msgCount: number; version: number } | undefined =
    seed === undefined ? undefined : { ...seed, version: historyVersion };

  /** Anchor-based total-context estimate for the live view: the real input
   *  size the provider last reported plus a heuristic increment for what was
   *  appended since that request. Undefined when no anchor exists yet or the
   *  history was rewritten in place — managers then fall back to the pure
   *  heuristic (and the next response re-anchors). */
  function anchoredContextTokens(): number | undefined {
    if (anchor === undefined || anchor.version !== historyVersion) return undefined;
    if (messages.length < anchor.msgCount) return undefined;
    return anchor.inputTokens + estimateMessagesTokens(messages.slice(anchor.msgCount));
  }

  try {
    for (;;) {
      if (signal.aborted) throw new AbortError();
      turn++;
      if (turn > maxTurns) {
        const finalText = lastAssistant ? extractText(lastAssistant) : "";
        emit({
          type: "error",
          conversationId, turn: turn - 1, ts: now(),
          message: `Exceeded maxTurns (${maxTurns})`,
          code: "max_turns_exceeded",
          recoverable: true,
        });
        emit({
          type: "done",
          conversationId, turn: turn - 1, ts: now(),
          finalText, totalUsage, turns: turn - 1,
        });
        return lastAssistant ?? emptyAssistant(now);
      }

      // Resolve the turn's starting model BEFORE context.fit — the fit closure
      // counts tokens with it. The hook is consulted once per turn and never
      // re-consulted after an in-turn tier fallback (fallback is mechanical).
      const turnModel = modelFor
        ? await modelFor({ conversationId, turn, messages: [...messages], defaultModel: model })
        : model;
      // Lazy start event: emitted only once the first turn's model is known,
      // so it always reports the model actually serving turn 1 (a run aborted
      // before resolution emits error without start).
      if (turn === 1) {
        emit({ type: "start", conversationId, turn: 0, ts: now(), model: turnModel });
      }

      // Context window management (optional). Trims in place.
      if (context) {
        const currentTokens = anchoredContextTokens();
        const fit = await context.fit({
          messages, tools, system,
          tokenBudget: tokenBudget ?? contextWindowFor(turnModel, models) ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
          runId,
          countTokens: (msgs) =>
            provider.countTokens?.(msgs, turnModel) ?? Promise.resolve(estimateMessagesTokens(msgs)),
          ...(currentTokens !== undefined ? { currentTokens } : {}),
          signal,
        });
        if (fit.compacted) {
          compactedSinceHook = true;
          emit({
            type: "context_compacted", conversationId, turn, ts: now(), reason: "soft",
            ...(fit.tokensSaved !== undefined ? { tokensSaved: fit.tokensSaved } : {}),
          });
          const preRewriteIds = new Set(messages.map((m) => m.id));
          await persistDropped(messages, fit.messages, opts);
          messages.length = 0;
          messages.push(...fit.messages);
          historyVersion++;
          await persistAppend(opts, fit.messages.filter((m) => !preRewriteIds.has(m.id)));
        }
      }

      // beforeRequest hook (RAG inject, guardrails, or abort). ctx.compacted
      // is true only on the first request after a compaction — hooks use it to
      // re-inject durable state (plans, key files) the recap may have folded.
      if (hooks?.beforeRequest) {
        let r: BeforeRequestResult;
        try {
          r = await hooks.beforeRequest({
            conversationId, turn, messages: [...messages], tools, signal,
            ...(compactedSinceHook ? { compacted: true } : {}),
          });
        } catch (err) {
          // INTERCEPT, run scope → FAIL CLOSED. Checked before wrapping so a
          // hook that observes ctx.signal still surfaces as an abort rather
          // than a hook failure.
          if (signal.aborted || err instanceof AbortError) throw err;
          throw new HookError("beforeRequest", err);
        }
        compactedSinceHook = false;
        // `abortRun` is the current spelling; `abort` is the deprecated
        // 0.1.0-beta one, read the same way (fail closed).
        if (r && ("abortRun" in r || (r as { abort?: boolean }).abort === true)) {
          throw new HookAbortError(
            (r as { reason?: string }).reason ?? "beforeRequest aborted the run",
          );
        }
        if (r && "inject" in r) {
          // Inject context as new message(s) right before the request is built.
          // The hook receives a snapshot and returns `inject` rather than
          // mutating — history is append-only, so this can add but never rewrite.
          const injected = normalizeInjected(r.inject, now, runId);
          if (injected.length > 0) {
            messages.push(...injected);
            await persistAppend(opts, injected);
          }
        }
      }

      const req: ProviderRequest = {
        model: turnModel,
        messages: [...messages],
        tools,
        config,
        signal,
        conversationId,
        ...(system !== undefined ? { system } : {}),
      };

      // Stream one turn (with retry on transient provider errors, then tier
      // fallback on availability errors). The chain is derived fresh per turn
      // from this turn's starting model — a fallback never sticks.
      let { message, stopReason, usage } = await streamTurn(
        provider, req, fallbackChain(turnModel, models), retry, signal, emit, conversationId, turn, now,
      );
      // Stamp once, up front: the SAME object is pushed into history, returned
      // to the caller, resolved by handle.done, and handed to afterTurn —
      // identity between them is load-bearing (hosts locate the turn via
      // indexOf/===), so never push a copy while returning the original.
      // usage/stopReason ride along so per-turn stats survive persistence.
      message = withRunId(withTurnMeta(message, usage, stopReason), runId);
      // context_window_exceeded is a compaction signal, not a real reply — don't
      // push the (empty) assistant into history, else memory.append would persist it.
      // An aborted turn's partial is pushed only when it actually streamed
      // content (consumeStream never salvages an empty buffer) — Claude-parity:
      // an interrupted reply that already said something stays in history.
      if (stopReason !== "context_window_exceeded") {
        messages.push(message);
        await persistAppend(opts, [message]);
      }
      lastAssistant = message;
      totalUsage = addUsage(totalUsage, usage);
      consecutiveMaxTokens = stopReason === "max_tokens" ? consecutiveMaxTokens + 1 : 0;
      // Re-anchor on real usage: `inputTokens` is the exact input size the
      // server just processed for `req.messages` (cache tokens included —
      // they occupy the window too, they just cost less). The stamped
      // assistant message rides at req.messages.length, so the increment for
      // the next fit starts there.
      if (usage.inputTokens > 0 && stopReason !== "context_window_exceeded") {
        anchor = { inputTokens: usage.inputTokens, msgCount: req.messages.length, version: historyVersion };
      }

      const contextTokens = anchoredContextTokens();
      emit({
        type: "turn_end", conversationId, turn, ts: now(), stopReason, usage,
        ...(contextTokens !== undefined ? { contextTokens } : {}),
      });

      // `afterResponse` is the deprecated 0.1.0-beta spelling of afterTurn —
      // same compat read the abort→veto renames got, so JS hosts (no compile
      // types) upgrading from beta.9 don't silently lose their observer.
      const afterTurn: Hooks["afterTurn"] =
        hooks?.afterTurn ?? (hooks as { afterResponse?: Hooks["afterTurn"] } | undefined)?.afterResponse;
      if (afterTurn) {
        try {
          await afterTurn({
            conversationId, turn, messages: [...messages], tools, signal,
            response: message, stopReason, usage,
          });
        } catch (e) {
          // OBSERVE → FAIL SOFT. The response is already committed, so a
          // broken metrics/audit hook must not fail an otherwise good run.
          log("warn", `afterTurn hook error (turn ${turn})`, e);
        }
      }

      // Reset overflow retry budget on any non-overflow turn (compact succeeded).
      if (stopReason !== "context_window_exceeded") overflowRetries = 0;

      switch (stopReason) {
        case "end_turn":
        case "stop_sequence": {
          emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
          return message;
        }
        case "refusal": {
          emit({
            type: "error", conversationId, turn, ts: now(),
            message: "Model refused the request", code: "refusal", recoverable: false,
          });
          emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
          return message;
        }
        case "aborted": {
          // Salvaged partial turn (see consumeStream). It is already pushed into
          // history above; terminate exactly like a hard abort — error event +
          // throw — so the abort contract is unchanged for consumers. What's new
          // is that streamInto still persists everything the run really produced.
          throw new AbortError();
        }
        case "tool_use": {
          await executeTools(message, opts, turn);
          continue;
        }
        case "max_tokens": {
          if (consecutiveMaxTokens > maxStalledTurns) {
            emit({
              type: "error", conversationId, turn, ts: now(),
              message: "Stalled: max_tokens hit repeatedly without progress",
              code: "max_tokens_stalled", recoverable: true,
            });
            emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
            return message;
          }
          continue; // feed the partial back (text/thinking only — its tool_calls
                    // were stripped in consumeStream), let the model continue
        }
        case "pause_turn": {
          continuations++;
          if (continuations > maxContinuations) {
            emit({
              type: "error", conversationId, turn, ts: now(),
              message: `Exceeded max continuations (${maxContinuations})`,
              code: "max_continuations_exceeded", recoverable: true,
            });
            emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
            return message;
          }
          continue; // re-send as-is; server resumes
        }
        case "context_window_exceeded": {
          if (context) {
            if (overflowRetries >= 1) {
              // Already compacted once and still overflowing → give up (avoid infinite loop).
              emit({
                type: "error", conversationId, turn, ts: now(),
                message: "Context window exceeded after compaction",
                code: "context_overflow", recoverable: false,
              });
              emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
              return message;
            }
            overflowRetries++;
            const c = await context.compact({
              messages, tools, system, runId,
              tokenBudget: tokenBudget ?? contextWindowFor(turnModel, models) ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
              countTokens: (msgs) =>
                provider.countTokens?.(msgs, turnModel) ?? Promise.resolve(estimateMessagesTokens(msgs)),
              signal,
            });
            emit({
              type: "context_compacted", conversationId, turn, ts: now(), reason: "overflow",
              ...(c.tokensSaved !== undefined ? { tokensSaved: c.tokensSaved } : {}),
            });
            compactedSinceHook = true;
            const preRewriteIds = new Set(messages.map((m) => m.id));
            await persistDropped(messages, c.messages, opts);
            messages.length = 0;
            messages.push(...c.messages);
            historyVersion++;
            await persistAppend(opts, c.messages.filter((m) => !preRewriteIds.has(m.id)));
            continue; // retry with compacted history
          }
          emit({
            type: "error", conversationId, turn, ts: now(),
            message: "Context window exceeded and no context manager configured",
            code: "context_overflow", recoverable: false,
          });
          emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
          return message;
        }
        default: {
          // Unknown stop reason — treat as terminal to be safe.
          emit({ type: "done", conversationId, turn, ts: now(), finalText: extractText(message), totalUsage, turns: turn });
          return message;
        }
      }
    }
  } catch (err) {
    // Hard failure path (abort, unrecoverable provider error, hook abort).
    const aborted = signal.aborted || err instanceof AbortError;
    const code = aborted
      ? "aborted"
      : err instanceof HookAbortError
        ? "hook_abort"
        : err instanceof HookError
          ? "hook_error"
          : "provider_error";
    emit({
      type: "error",
      conversationId, turn, ts: now(),
      message: err instanceof Error ? err.message : String(err),
      code,
      recoverable: false,
    });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Stream one provider turn, accumulating an assistant Message + tool calls.
 *  Recovery ladder, all BEFORE the stream delivers its first chunk (matching
 *  OpenAI / Anthropic SDK behavior): once streaming starts, a mid-stream failure
 *  is terminal and the partial output already emitted stays with the consumer
 *  (no rollback, no replay).
 *
 *  1. Same-model retry with backoff for retryable errors (transient, 429…).
 *  2. Tier fallback for availability errors (529/overloaded/model_not_found/
 *     5xx — NOT 429, which is account-level and shared by every tier): step to
 *     the next model in `chain` (max→main→fast), reset the retry budget, emit
 *     `model_fallback`, retry immediately (different endpoint — the failed
 *     model's retry-after is irrelevant). Chain exhausted → original error. */
/** Stream one provider turn with the retry/tier-fallback ladder. Exported
 *  for structured.ts (respond) — same recovery semantics as the main loop. */
export async function streamTurn(
  provider: LLMProvider,
  req: ProviderRequest,
  chain: string[],
  retry: LoopOptions["retry"],
  signal: AbortSignal,
  emit: (e: AgentEvent) => void,
  conversationId: string,
  turn: number,
  now: () => number,
): Promise<{ message: Message; stopReason: StopReason; usage: TokenUsage }> {
  req.model = chain[0]!;
  let tier = 0; // index into chain
  let attempt = 0; // same-model retry budget; reset on tier switch
  for (;;) {
    let started = false;
    try {
      return await consumeStream(
        provider.stream(req), emit, () => { started = true; }, conversationId, turn, now, signal,
      );
    } catch (err) {
      if (signal.aborted) throw new AbortError();
      // OpenAI-style overflow (HTTP 400 context_length_exceeded) → surface as a
      // context_window_exceeded stop signal so the loop compacts instead of dying.
      if ((err as ProviderError).code === "context_length_exceeded") {
        return {
          message: emptyAssistant(now),
          stopReason: "context_window_exceeded",
          usage: emptyUsage(),
        };
      }
      // `started` guard is absolute: after the first chunk there is no retry
      // and no fallback — partial output stays with the consumer.
      const canRetrySame = !started && isRetryable(err) && attempt < retry.maxRetries;
      // Fallback eligibility is judged independently of `retryable`: a 404
      // model_not_found is non-retryable on the SAME model but is exactly the
      // case a sibling tier fixes — it switches immediately, zero same-model
      // retries.
      const canSwitch = !started && tier + 1 < chain.length && isFallbackEligible(err);
      if (canRetrySame) {
        const delay = computeBackoff(err, attempt, retry);
        await sleep(delay, signal);
        attempt++;
        continue;
      }
      if (canSwitch) {
        const e = err as ProviderError;
        const from = chain[tier]!;
        tier++;
        attempt = 0;
        req.model = chain[tier]!;
        emit({
          type: "model_fallback", conversationId, turn, ts: now(),
          from, to: chain[tier]!,
          ...(typeof e.status === "number" ? { status: e.status } : {}),
          ...(typeof e.code === "string" ? { code: e.code } : {}),
        });
        continue;
      }
      throw err; // mid-stream, non-eligible (e.g. 429), or chain exhausted
    }
  }
}

/** Accumulate a provider stream into { message, stopReason, usage }. Exported
 *  for structured.ts (respond) — single implementation of chunk folding. */
export async function consumeStream(
  iter: AsyncIterable<ProviderChunk>,
  emit: (e: AgentEvent) => void,
  markStarted: () => void,
  conversationId: string,
  turn: number,
  now: () => number,
  signal: AbortSignal,
): Promise<{ message: Message; stopReason: StopReason; usage: TokenUsage }> {
  let messageId = "";
  let textBuf = "";
  let thinkingBuf = "";
  let thinkingSignature: string | undefined;
  let thinkingStart: number | undefined;
  let thinkingMs: number | undefined;
  const toolCalls: ToolCall[] = [];
  let stopReason: StopReason = "end_turn";
  let usage: TokenUsage = emptyUsage();
  let firstChunkSeen = false;

  try {
    for await (const chunk of iter) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        markStarted();
      }
      // Process an already-delivered chunk BEFORE honoring abort — a chunk the
      // provider already sent is real data (a trailing usage-bearing
      // message_delta matters to the salvaged partial), and dropping it makes
      // the salvage content depend on microtask ordering.
      switch (chunk.type) {
        case "message_start":
          messageId = chunk.messageId;
          break;
        case "text_delta":
          textBuf += chunk.text;
          emit({ type: "text_delta", conversationId, turn, ts: now(), text: chunk.text });
          break;
        case "thinking_delta":
          if (thinkingStart === undefined) thinkingStart = now();
          thinkingBuf += chunk.text;
          emit({ type: "thinking_delta", conversationId, turn, ts: now(), text: chunk.text });
          break;
        case "thinking_end":
          if (chunk.signature) thinkingSignature = chunk.signature;
          if (thinkingStart !== undefined) thinkingMs = now() - thinkingStart;
          break;
        case "tool_call_start":
          toolCalls.push({ type: "tool_call", id: chunk.toolCallId, name: chunk.name, inputJson: "" });
          break;
        case "tool_call_delta": {
          const tc = toolCalls.find((t) => t.id === chunk.toolCallId);
          if (tc) tc.inputJson += chunk.inputJsonDelta;
          break;
        }
        case "tool_call_end":
          break;
        case "message_delta":
          if (chunk.stopReason) stopReason = chunk.stopReason;
          if (chunk.usage) usage = mergeUsage(usage, chunk.usage);
          break;
        case "message_end":
          stopReason = chunk.stopReason;
          usage = chunk.usage;
          break;
      }
      if (signal.aborted) throw new AbortError();
    }
  } catch (err) {
    // Claude-parity salvage on abort: content that already reached the consumer
    // is REAL — keep it as a partial assistant turn instead of dropping it.
    // Text/thinking only: a partially-streamed tool_call must NOT survive,
    // because replaying a tool_use without its tool_result is a protocol
    // violation on Anthropic-class APIs (and its input JSON may not even parse).
    // Usage keeps whatever message_delta reported before the interruption.
    // Nothing streamed → nothing to salvage → propagate unchanged.
    if (signal.aborted && (textBuf !== "" || thinkingBuf !== "")) {
      const content: Content[] = [];
      if (thinkingBuf) {
        content.push({
          type: "thinking",
          text: thinkingBuf,
          ...(thinkingSignature ? { signature: thinkingSignature } : {}),
          ...(thinkingMs !== undefined ? { ms: thinkingMs } : {}),
        });
      }
      if (textBuf) content.push({ type: "text", text: textBuf });
      return {
        message: {
          id: messageId || randomId(),
          role: "assistant",
          content,
          createdAt: now(),
        },
        stopReason: "aborted",
        usage,
      };
    }
    throw err;
  }

  // Parse tool call inputs (JSON.parse; never string-match).
  for (const tc of toolCalls) {
    if (tc.inputJson) {
      try {
        tc.input = JSON.parse(tc.inputJson);
      } catch {
        tc.input = undefined; // schema validation will reject downstream
      }
    } else {
      tc.input = {};
    }
  }

  // A max_tokens partial carries NO tool_call blocks into history. The loop's
  // continue path re-sends the partial as prefill WITHOUT executing its calls,
  // and a tool_use that never receives a tool_result is a protocol violation
  // on Anthropic-class APIs (and OpenAI's tool_calls contract) on the request
  // after the continuation — regardless of whether the call's JSON parsed.
  // Same rule the abort salvage already applies: text/thinking survive, calls
  // don't — the model re-decides them when it continues. pause_turn KEEPS its
  // calls: server-side tools expect them re-sent to resume.
  const keptCalls = stopReason === "max_tokens" ? [] : toolCalls;

  const content: Content[] = [];
  if (thinkingBuf)
    content.push({
      type: "thinking",
      text: thinkingBuf,
      ...(thinkingSignature ? { signature: thinkingSignature } : {}),
      ...(thinkingMs !== undefined ? { ms: thinkingMs } : {}),
    });
  if (textBuf) content.push({ type: "text", text: textBuf });
  for (const tc of keptCalls) content.push(tc);

  const message: Message = {
    id: messageId || randomId(),
    role: "assistant",
    content: content.length > 0 ? content : "",
    createdAt: now(),
  };
  return { message, stopReason, usage };
}

/** Best-effort incremental persistence (persistRuns): each appended message
 *  becomes durable before the run proceeds; failures degrade to the run-end
 *  batch append, never break the turn. */
async function persistAppend(opts: LoopOptions, msgs: Message[]): Promise<void> {
  if (!opts.persist || msgs.length === 0) return;
  try {
    await opts.persist(msgs);
  } catch {
    /* run-end append still covers these ids */
  }
}

/** Before an in-run compaction rewrites `messages` in place, hand the messages
 *  the compacted view drops to opts.persistDropped — the store must keep the
 *  verbatim originals for the append-only contract (the note alone is NOT the
 *  archive: hosts render full transcripts from the store, and the next load
 *  re-derives the compacted view from the note's coveredUntil stamp). Dropped
 *  messages already in the store are the host callback's job to skip (it knows
 *  loadedIds); here we only guarantee best-effort — a persistence failure must
 *  not break the run, the degraded outcome is today's behavior (originals
 *  absent from the store), not a crash. */
async function persistDropped(
  before: Message[],
  after: Message[],
  opts: LoopOptions,
): Promise<void> {
  if (!opts.persistDropped) return;
  const kept = new Set(after.map((m) => m.id));
  const dropped = before.filter((m) => !kept.has(m.id));
  if (dropped.length === 0) return;
  try {
    await opts.persistDropped(dropped);
  } catch {
    /* degraded: run continues without the originals in the store */
  }
}

/** Execute all tool_calls in one assistant message in parallel; append one user(tool_result[]) turn. */
async function executeTools(
  assistant: Message,
  opts: LoopOptions,
  turn: number,
): Promise<void> {
  const calls: ToolCall[] =
    typeof assistant.content === "string"
      ? []
      : assistant.content.filter((b): b is ToolCall => b.type === "tool_call");

  const settled = await Promise.allSettled(
    calls.map((call) =>
      executeOne(call, opts, turn).then(
        (result): { call: ToolCall; result: ToolResult } => ({ call, result }),
        (err): { call: ToolCall; result: ToolResult } => ({
          call,
          result: toolResult(call.id, `Tool threw: ${err instanceof Error ? err.message : String(err)}`, true),
        }),
      ),
    ),
  );

  const results: ToolResult[] = settled.map((s) => (s.status === "fulfilled" ? s.value.result : toolResult("?", "unreachable: executeOne should not reject", true)));
  // Push ONE user message with all tool_results (never split across messages).
  // sourceMessageId back-points to the assistant message whose calls these
  // results answer (explicit pairing; groupExchanges pairs by toolCallId within
  // the run, hosts/debuggers can use the pointer directly).
  const carrier: Message = {
    id: randomId(),
    role: "user",
    content: results,
    createdAt: opts.now(),
    metadata: { runId: opts.runId, sourceMessageId: assistant.id },
  };
  opts.messages.push(carrier);
  await persistAppend(opts, [carrier]);
}

async function executeOne(
  call: ToolCall,
  opts: LoopOptions,
  turn: number,
): Promise<ToolResult> {
  const { tools, toolTimeoutMs, permissionGate, confirm, hooks, signal, conversationId, now, emit } = opts;
  const startMs = now();

  // Emit the tool_call event (with parsed input) before execution.
  emit({ type: "tool_call", conversationId, turn, ts: now(), toolCallId: call.id, name: call.name, input: call.input });

  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return finish(call.id, `Unknown tool: ${call.name}`, true, startMs, now, emit, conversationId, turn);
  }

  // Unparseable arguments: input === undefined is ONLY ever set by the
  // JSON.parse failure upstream (empty arguments become {}). Diagnose it for
  // the model instead of letting the validator say "$: expected object, got
  // undefined" — a frequent shape is a huge call (whole-file write) whose
  // JSON got cut mid-stream, so point at the output limit too.
  if (call.input === undefined) {
    return finish(
      call.id,
      "Invalid input: the tool call's arguments were empty or not valid JSON. If the call was very large " +
        "(e.g. writing a whole file), the output token limit likely cut it mid-JSON — the host must raise " +
        "maxTokens for calls that size; do not retry the identical call unchanged.",
      true,
      startMs,
      now,
      emit,
      conversationId,
      turn,
    );
  }

  // Schema validation BEFORE execute (no side effects on invalid input).
  const v = validateJsonSchema(call.input, tool.inputSchema.jsonSchema);
  if (!v.ok) {
    return finish(call.id, `Invalid input: ${v.error}`, true, startMs, now, emit, conversationId, turn);
  }

  let input: unknown = call.input;

  // beforeToolCall hook (veto / mutate input).
  if (hooks?.beforeToolCall) {
    try {
      const r = await hooks.beforeToolCall({
        toolCallId: call.id, name: call.name, input, ctx: {
          conversationId, turn, messages: [...opts.messages], tools, signal,
        },
      });
      // `veto` is the current spelling; `abort` is the deprecated 0.1.0-beta
      // one — at tool scope it always meant veto (the run continues), never a
      // run abort, so it is NOT read as abortRun here.
      if (r && ("veto" in r || (r as { abort?: boolean }).abort === true)) {
        return finish(
          call.id,
          `Vetoed by beforeToolCall: ${(r as { reason?: string }).reason ?? "no reason given"}`,
          true, startMs, now, emit, conversationId, turn,
        );
      }
      if (r && "modifiedInput" in r) {
        input = (r as { modifiedInput: unknown }).modifiedInput;
        // Re-validate after a hook rewrites input — a misbehaving hook must not
        // bypass the schema contract (matters for non-zod tools without safeParse).
        const rv = validateJsonSchema(input, tool.inputSchema.jsonSchema);
        if (!rv.ok) {
          return finish(call.id, `Invalid modified input: ${rv.error}`, true, startMs, now, emit, conversationId, turn);
        }
      }
    } catch (err) {
      return finish(call.id, `beforeToolCall threw: ${err instanceof Error ? err.message : String(err)}`, true, startMs, now, emit, conversationId, turn);
    }
  }

  // Permission gate (human-in-the-loop). Whether a call is confirmed comes
  // from the layer ladder (DESIGN §7): the tool's declaration (default "tool"
  // mode), or the agent-level `confirm` override, which wins over
  // declarations in BOTH directions — "always" sends read-class tools through
  // the gate too, "never" skips it for declared ones (the host explicitly
  // took responsibility for that tool surface). Declared or not, needing
  // confirmation with no gate configured is refused in every mode.
  const confirmMode = confirm ?? "tool";
  let need: boolean;
  if (confirmMode === "always") {
    need = true;
  } else if (confirmMode === "never") {
    need = false;
  } else {
    const declared =
      typeof tool.requiresConfirmation === "function"
        ? tool.requiresConfirmation(input)
        : tool.requiresConfirmation;
    need = declared === true;
  }
  if (need) {
    if (!permissionGate) {
      const why = confirmMode === "always" ? ' (AgentConfig.confirm = "always")' : "";
      return finish(
        call.id,
        `Tool '${call.name}' requires confirmation${why} but no permissionGate is configured`,
        true, startMs, now, emit, conversationId, turn,
      );
    }
    emit({
      type: "permission_request", conversationId, turn, ts: now(),
      toolCallId: call.id, name: call.name, input,
      destructive: tool.permissions?.destructive ?? false,
    });
    try {
      const decision = await permissionGate.request(
        {
          toolCallId: call.id, name: call.name, input,
          destructive: tool.permissions?.destructive ?? false,
          ...(tool.permissions?.tags !== undefined ? { tags: tool.permissions.tags } : {}),
        },
        signal,
      );
      if (!decision.allow) {
        return finish(call.id, `Denied: ${(decision as { reason: string }).reason}`, true, startMs, now, emit, conversationId, turn);
      }
      if ("modifiedInput" in decision) {
        input = (decision as { modifiedInput: unknown }).modifiedInput;
        // Re-validate after the gate rewrites input — same contract as
        // beforeToolCall's modifiedInput: a gate must not bypass the schema.
        const gv = validateJsonSchema(input, tool.inputSchema.jsonSchema);
        if (!gv.ok) {
          return finish(call.id, `Invalid modified input: ${gv.error}`, true, startMs, now, emit, conversationId, turn);
        }
      }
    } catch (err) {
      if (signal.aborted) throw new AbortError();
      return finish(call.id, `Permission gate threw: ${err instanceof Error ? err.message : String(err)}`, true, startMs, now, emit, conversationId, turn);
    }
  }

  // Execute with per-tool timeout + linked abort signal.
  const timeoutMs = tool.timeoutMs ?? toolTimeoutMs;
  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutController.abort(); // abort the linked signal so well-behaved tools stop
      reject(new TimeoutError(`Tool '${call.name}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const toolSignal = anySignal([signal, timeoutController.signal]);
  const ctx: ToolCallContext = {
    signal: toolSignal, toolCallId: call.id, conversationId, runtime: RUNTIME,
    log: opts.logger ?? (() => {}),
  };

  /** Every terminal outcome of a tool call that reached execution funnels
   *  through here — resolution, rejection, timeout. An observing hook that
   *  missed the failures would be the odd one out: the `tool_result` event
   *  fires for all three. Fail-soft: the hook cannot change the outcome. */
  const settle = async (
    out: { content: string | Content[]; isError?: boolean },
  ): Promise<ToolResult> => {
    const isError = out.isError ?? false;
    if (hooks?.afterToolCall) {
      try {
        await hooks.afterToolCall({
          toolCallId: call.id, name: call.name, result: out, isError,
          ctx: { conversationId, turn, messages: [...opts.messages], tools, signal },
        });
      } catch (e) {
        ctx.log("warn", `afterToolCall('${call.name}') hook error`, e);
      }
    }
    return finish(call.id, out.content, isError, startMs, now, emit, conversationId, turn);
  };

  try {
    const out = await Promise.race([tool.execute(input, ctx), timeoutP]);
    return await settle(out);
  } catch (err) {
    // A run abort is not a tool outcome — the observer stays out of it.
    if (signal.aborted) throw new AbortError();
    return await settle({
      content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function finish(
  toolCallId: string,
  content: string | Content[],
  isError: boolean,
  startMs: number,
  now: () => number,
  emit: (e: AgentEvent) => void,
  conversationId: string,
  turn: number,
): ToolResult {
  const ms = now() - startMs;
  const result: ToolResult = {
    type: "tool_result",
    toolCallId,
    content,
    ms, // persisted alongside the block → survives reload
    ...(isError ? { isError } : {}),
  };
  const contentArr: Content[] = typeof content === "string" ? [{ type: "text", text: content }] : content;
  emit({
    type: "tool_result", conversationId, turn, ts: now(),
    toolCallId, content: contentArr, isError, ms,
  });
  return result;
}

function toolResult(toolCallId: string, content: string, isError: boolean): ToolResult {
  return { type: "tool_result", toolCallId, content, ...(isError ? { isError } : {}) };
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) }
      : {}),
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
  };
}

function mergeUsage(base: TokenUsage, partial: Partial<TokenUsage>): TokenUsage {
  const out: TokenUsage = { ...base };
  if (partial.inputTokens !== undefined) out.inputTokens = partial.inputTokens;
  if (partial.outputTokens !== undefined) out.outputTokens = partial.outputTokens;
  if (partial.cacheReadTokens !== undefined) out.cacheReadTokens = partial.cacheReadTokens;
  if (partial.cacheWriteTokens !== undefined) out.cacheWriteTokens = partial.cacheWriteTokens;
  if (partial.reasoningTokens !== undefined) out.reasoningTokens = partial.reasoningTokens;
  return out;
}

/**
 * Sum the per-turn usage the loop stamps onto assistant messages
 * (`metadata.usage`). Hosts get the conversation's token total from persisted
 * history — after a reload, or across many sessions — without having watched
 * the live `done` event. Live totals remain available as `done.totalUsage`.
 */
export function conversationUsage(messages: readonly Message[]): TokenUsage {
  let total = emptyUsage();
  for (const m of messages) {
    const u = m.metadata?.usage;
    if (u !== undefined && u !== null && typeof u === "object") {
      total = addUsage(total, u as TokenUsage);
    }
  }
  return total;
}

function isRetryable(err: unknown): boolean {
  const e = err as ProviderError & { retryable?: boolean; status?: number };
  if (typeof e.retryable === "boolean") return e.retryable;
  const status = e.status;
  if (typeof status === "number") {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  return true; // unknown / network → retry
}

/**
 * Compute the backoff delay for a retryable provider error. Honors a server-suggested
 * `retryAfterMs` set by the adapter (e.g. parsed from a `retry-after` header) when
 * present and finite — as an UPPER bound: the result is equal-part jittered into
 * [chosen/2, chosen] (AWS-style) so many clients sharing a rate limit don't retry
 * in lockstep. Falls back to exponential backoff `baseDelayMs * 2^attempt` (then
 * jittered the same way), and always caps at `retry.maxDelayMs`. Pure/exported
 * for unit testing.
 */
export function computeBackoff(
  err: unknown,
  attempt: number,
  retry: { baseDelayMs: number; maxDelayMs: number },
): number {
  const hint = (err as ProviderError).retryAfterMs;
  const exp = retry.baseDelayMs * 2 ** attempt;
  const chosen = typeof hint === "number" && Number.isFinite(hint) ? hint : exp;
  const jittered = chosen / 2 + Math.random() * (chosen / 2);
  return Math.min(Math.max(0, jittered), retry.maxDelayMs);
}

function emptyAssistant(now: () => number): Message {
  return { id: randomId(), role: "assistant", content: "", createdAt: now() };
}

/** @deprecated CJK-aware replacement: estimateMessagesTokens (tokens.ts,
 *  exported from the package root). Kept as an alias for deep importers. */
export function heuristicTokens(msgs: Message[]): number {
  return estimateMessagesTokens(msgs);
}

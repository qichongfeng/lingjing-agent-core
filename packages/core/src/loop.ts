// The agentic loop: stream → accumulate assistant message → (on tool_use)
// execute tools in parallel → feed results back → repeat → terminate.
// Termination is a hard guarantee: maxTurns caps the loop even if the provider
// always returns tool_use. This is the heart of the library.

import type { ContextManager } from "./context.js";
import type { AgentEvent } from "./events.js";
import type { Hooks } from "./hooks.js";
import type { PermissionGate } from "./permission.js";
import type {
  LLMProvider,
  ProviderConfig,
  ProviderError,
  ProviderRequest,
  ProviderChunk,
  StopReason,
  TokenUsage,
} from "./provider.js";
import { validateJsonSchema } from "./schema.js";
import type { Tool, ToolCallContext } from "./tool.js";
import type { Content, Message, TextContent, ToolCall, ToolResult } from "./types.js";
import { extractText, randomId, userMessage, withRunId } from "./types.js";
import { AbortError, anySignal, detectRuntime, sleep, TimeoutError } from "./abort.js";

export interface LoopOptions {
  provider: LLMProvider;
  model: string;
  system?: string | TextContent[];
  tools: Tool[];
  messages: Message[]; // mutated in place (append assistant + tool_result turns)
  /** Stamped onto every message this run appends (metadata.runId); groups the
   *  run into one exchange for groupExchanges(). */
  runId: string;
  config: ProviderConfig;
  maxTurns: number;
  toolTimeoutMs: number;
  tokenBudget: number;
  maxContinuations: number;
  maxStalledTurns: number;
  permissionGate?: PermissionGate;
  hooks?: Hooks;
  context?: ContextManager;
  retry: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  signal: AbortSignal;
  conversationId: string;
  now: () => number;
  emit: (e: AgentEvent) => void;
}

const RUNTIME = detectRuntime();

export async function runLoop(opts: LoopOptions): Promise<Message> {
  const {
    provider, model, system, tools, messages, config, maxTurns, toolTimeoutMs,
    tokenBudget, maxContinuations, maxStalledTurns,
    permissionGate, hooks, context, retry, signal, conversationId, runId, now, emit,
  } = opts;

  let turn = 0;
  let lastAssistant: Message | undefined;
  let totalUsage: TokenUsage = emptyUsage();
  let consecutiveMaxTokens = 0;
  let continuations = 0;
  let overflowRetries = 0;

  emit({ type: "start", conversationId, turn: 0, ts: now(), model });

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

      // Context window management (optional). Trims in place.
      if (context) {
        const fit = await context.fit({
          messages, tools, system,
          tokenBudget, runId,
          countTokens: (msgs) => provider.countTokens?.(msgs, model) ?? Promise.resolve(heuristicTokens(msgs)),
          signal,
        });
        if (fit.compacted) {
          messages.length = 0;
          messages.push(...fit.messages);
        }
      }

      // beforeRequest hook (RAG inject, guardrails, or abort).
      if (hooks?.beforeRequest) {
        const r = await hooks.beforeRequest({
          conversationId, turn, messages: [...messages], tools, signal,
        });
        if (r && "abort" in r && r.abort) {
          throw new HookAbortError(r.reason);
        }
        if (r && "inject" in r) {
          // Inject context as new message(s) right before the request is built.
          // The hook receives a snapshot and returns `inject` rather than mutating.
          if (typeof r.inject === "string") {
            messages.push(withRunId(userMessage(r.inject, now), runId));
          } else {
            messages.push(...r.inject.map((m) => withRunId(m, runId)));
          }
        }
      }

      const req: ProviderRequest = {
        model,
        messages: [...messages],
        tools,
        config,
        signal,
        conversationId,
        ...(system !== undefined ? { system } : {}),
      };

      // Stream one turn (with retry on transient provider errors).
      let { message, stopReason, usage } = await streamTurn(
        provider, req, retry, signal, emit, conversationId, turn, now,
      );
      // Stamp once, up front: the SAME object is pushed into history, returned
      // to the caller, resolved by handle.done, and handed to afterResponse —
      // identity between them is load-bearing (hosts locate the turn via
      // indexOf/===), so never push a copy while returning the original.
      message = withRunId(message, runId);
      // context_window_exceeded is a compaction signal, not a real reply — don't
      // push the (empty) assistant into history, else memory.append would persist it.
      if (stopReason !== "context_window_exceeded") messages.push(message);
      lastAssistant = message;
      totalUsage = addUsage(totalUsage, usage);
      consecutiveMaxTokens = stopReason === "max_tokens" ? consecutiveMaxTokens + 1 : 0;

      emit({ type: "turn_end", conversationId, turn, ts: now(), stopReason, usage });

      if (hooks?.afterResponse) {
        await hooks.afterResponse({
          conversationId, turn, messages: [...messages], tools, signal,
          response: message, stopReason, usage,
        });
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
          continue; // feed the partial back, let the model continue
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
              messages, tools, system, tokenBudget, runId,
              countTokens: (msgs) => provider.countTokens?.(msgs, model) ?? Promise.resolve(heuristicTokens(msgs)),
              signal,
            });
            messages.length = 0;
            messages.push(...c.messages);
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
    const code = aborted ? "aborted" : err instanceof HookAbortError ? "hook_abort" : "provider_error";
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

class HookAbortError extends Error {
  override readonly name = "HookAbortError";
  constructor(reason: string) {
    super(reason);
  }
}

/** Stream one provider turn, accumulating an assistant Message + tool calls.
 *  Retries only BEFORE the stream delivers its first chunk (matching OpenAI /
 *  Anthropic SDK behavior): once streaming starts, a mid-stream failure is
 *  terminal and the partial output already emitted stays with the consumer
 *  (no rollback, no replay). */
async function streamTurn(
  provider: LLMProvider,
  req: ProviderRequest,
  retry: LoopOptions["retry"],
  signal: AbortSignal,
  emit: (e: AgentEvent) => void,
  conversationId: string,
  turn: number,
  now: () => number,
): Promise<{ message: Message; stopReason: StopReason; usage: TokenUsage }> {
  let attempt = 0;
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
      // Retry only if the stream hadn't delivered its first chunk yet (no deltas
      // emitted). Once streaming began, a failure is terminal — partial output
      // stays with the consumer (industry standard; avoids replay on retry).
      if (started || !isRetryable(err) || attempt >= retry.maxRetries) throw err;
      const delay = computeBackoff(err, attempt, retry);
      await sleep(delay, signal);
      attempt++;
    }
  }
}

async function consumeStream(
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

  for await (const chunk of iter) {
    if (signal.aborted) throw new AbortError();
    if (!firstChunkSeen) {
      firstChunkSeen = true;
      markStarted();
    }
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

  const content: Content[] = [];
  if (thinkingBuf)
    content.push({
      type: "thinking",
      text: thinkingBuf,
      ...(thinkingSignature ? { signature: thinkingSignature } : {}),
      ...(thinkingMs !== undefined ? { ms: thinkingMs } : {}),
    });
  if (textBuf) content.push({ type: "text", text: textBuf });
  for (const tc of toolCalls) content.push(tc);

  const message: Message = {
    id: messageId || randomId(),
    role: "assistant",
    content: content.length > 0 ? content : "",
    createdAt: now(),
  };
  return { message, stopReason, usage };
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
  opts.messages.push({
    id: randomId(),
    role: "user",
    content: results,
    createdAt: opts.now(),
    metadata: { runId: opts.runId, sourceMessageId: assistant.id },
  });
}

async function executeOne(
  call: ToolCall,
  opts: LoopOptions,
  turn: number,
): Promise<ToolResult> {
  const { tools, toolTimeoutMs, permissionGate, hooks, signal, conversationId, now, emit } = opts;
  const startMs = now();

  // Emit the tool_call event (with parsed input) before execution.
  emit({ type: "tool_call", conversationId, turn, ts: now(), toolCallId: call.id, name: call.name, input: call.input });

  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return finish(call.id, `Unknown tool: ${call.name}`, true, startMs, now, emit, conversationId, turn);
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
      if (r && "abort" in r && r.abort) {
        return finish(call.id, `Vetoed by beforeToolCall: ${(r as { reason: string }).reason}`, true, startMs, now, emit, conversationId, turn);
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

  // Permission gate (human-in-the-loop). Destructive tools are deny-by-default:
  // if a tool requires confirmation but no gate is configured, it is refused.
  if (tool.requiresConfirmation) {
    const need =
      typeof tool.requiresConfirmation === "function"
        ? tool.requiresConfirmation(input)
        : tool.requiresConfirmation;
    if (need) {
      if (!permissionGate) {
        return finish(
          call.id,
          `Tool '${call.name}' requires confirmation but no permissionGate is configured`,
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
          { toolCallId: call.id, name: call.name, input, destructive: tool.permissions?.destructive ?? false },
          signal,
        );
        if (!decision.allow) {
          return finish(call.id, `Denied: ${(decision as { reason: string }).reason}`, true, startMs, now, emit, conversationId, turn);
        }
        if ("modifiedInput" in decision) {
          input = (decision as { modifiedInput: unknown }).modifiedInput;
        }
      } catch (err) {
        if (signal.aborted) throw new AbortError();
        return finish(call.id, `Permission gate threw: ${err instanceof Error ? err.message : String(err)}`, true, startMs, now, emit, conversationId, turn);
      }
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
    log: () => {},
  };

  try {
    const out = await Promise.race([tool.execute(input, ctx), timeoutP]);
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
  } catch (err) {
    if (signal.aborted) throw new AbortError();
    return finish(call.id, `Tool error: ${err instanceof Error ? err.message : String(err)}`, true, startMs, now, emit, conversationId, turn);
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
 * present and finite — but always caps it at `retry.maxDelayMs`. Falls back to
 * exponential backoff `baseDelayMs * 2^attempt`. Pure/exported for unit testing.
 */
export function computeBackoff(
  err: unknown,
  attempt: number,
  retry: { baseDelayMs: number; maxDelayMs: number },
): number {
  const hint = (err as ProviderError).retryAfterMs;
  const exp = retry.baseDelayMs * 2 ** attempt;
  const chosen = typeof hint === "number" && Number.isFinite(hint) ? hint : exp;
  return Math.min(Math.max(0, chosen), retry.maxDelayMs);
}

function emptyAssistant(now: () => number): Message {
  return { id: randomId(), role: "assistant", content: "", createdAt: now() };
}

/** Rough token estimate (char/4) used when a provider has no `countTokens`.
 *  Same heuristic as provider-openai; keeps context management functional
 *  (approximate) instead of silently never triggering fit/compact. */
function heuristicTokens(msgs: Message[]): number {
  let chars = 0;
  for (const m of msgs) {
    if (typeof m.content === "string") {
      chars += m.content.length;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_result")
        chars += typeof b.content === "string" ? b.content.length : 0;
    }
  }
  return Math.ceil(chars / 4);
}

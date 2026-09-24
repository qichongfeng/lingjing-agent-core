// Structured output — respondSchema-grade final answers. Forces a JSON
// Schema-shaped reply through ONE synthetic `respond` tool with
// toolChoice:"tool": identical behavior on every provider (no native
// response_format fast path — that can be an adapter-level optimization
// later without changing this contract), zero adapter changes today, and it
// works on OpenAI-compat dialects. Tools are NOT available during a respond
// call by design: it is an extraction turn over the conversation so far.
// Hosts that need research first compose send()/run() and then respond() —
// the second call sees the full persisted history.
//
// Repair ladder: an answer that never calls `respond`, calls it with
// unparseable JSON, or fails schema validation gets ONE corrective retry —
// protocol-clean either way (a failed call is answered by an isError
// tool_result; a no-call turn by a plain corrective user message — never a
// bare text turn after an unanswered tool_use). Failure past that throws
// StructuredOutputError; the caller then does NOT persist the assistant turn
// (history must never keep a dangling respond tool_use without its
// tool_result).

import { AbortError } from "./abort.js";
import { HookAbortError, HookError, normalizeInjected } from "./hooks.js";
import type { BeforeRequestResult, Hooks } from "./hooks.js";
import { streamTurn } from "./loop.js";
import type { LoopOptions } from "./loop.js";
import { fallbackChain } from "./models.js";
import type { ModelTiers } from "./models.js";
import type {
  LLMProvider,
  ProviderConfig,
  ProviderRequest,
  TokenUsage,
} from "./provider.js";
import type { AgentEvent } from "./events.js";
import { validateJsonSchema } from "./schema.js";
import type { Tool } from "./tool.js";
import { randomId, type Message, type ToolCall } from "./types.js";

/** The synthetic tool every structured turn is forced through. */
export const RESPOND_TOOL_NAME = "respond";
/** Corrective retries after the first invalid answer. */
export const MAX_STRUCTURED_REPAIRS = 1;

/** Raised when the model cannot produce a schema-valid answer within the
 *  repair budget. `details` says why the last attempt was rejected. */
export class StructuredOutputError extends Error {
  override readonly name = "StructuredOutputError";
  readonly details: string | undefined;
  constructor(message: string, details?: string) {
    super(message);
    this.details = details;
  }
}

export interface RunStructuredOptions {
  provider: LLMProvider;
  model: string;
  /** Tier table enabling availability fallback inside the extraction turn. */
  models?: ModelTiers;
  /** The conversation INCLUDING the new user input (not mutated — the driver
   *  works on a copy; repair turns never leak back to the caller). */
  messages: Message[];
  /** JSON Schema (draft-07 subset, same as tool inputs). Root MUST be
   *  { type: "object", ... } — a structured answer is one JSON object. */
  schema: object;
  /** Base sampling config (maxTokens/temperature/...). toolChoice is always
   *  overridden to force the respond tool. */
  config: ProviderConfig;
  retry: LoopOptions["retry"];
  signal: AbortSignal;
  conversationId?: string;
  now: () => number;
  /** Optional sink for the underlying stream events (deltas, model_fallback
   *  on tier switch). Without it, a fallback during respond is silent. */
  emit?: (e: AgentEvent) => void;
  /** Intercept hooks for the extraction request. ONLY `beforeRequest` applies:
   *  the forced roster holds one synthetic tool that is never executed (so the
   *  tool hooks have nothing to fire on) and there is no turn loop (so
   *  `afterTurn` would report a turn that does not exist).
   *  It fires ONCE, before the first attempt — the repair attempts are protocol
   *  retries of the same logical turn, so injecting per attempt would stack the
   *  same context into every retry.
   *  `{inject}` here is REQUEST-ONLY (this driver works on a copy and persists
   *  nothing), unlike the loop where an injection becomes durable history. */
  hooks?: Pick<Hooks, "beforeRequest">;
  /** Run id stamped onto injected messages (the caller's `runId`). */
  runId?: string;
}

export interface RunStructuredResult {
  /** The model's answer, validated against `schema`. */
  data: unknown;
  /** The assistant message carrying the respond tool_call (stamp + persist). */
  message: Message;
  /** The synthetic tool_result carrier answering that call (persist after
   *  `message` — keeps the history protocol-complete for the next request). */
  carrier: Message;
  usage: TokenUsage;
}

export async function runStructured(opts: RunStructuredOptions): Promise<RunStructuredResult> {
  const {
    provider, model, models, messages, schema, config, retry,
    signal, conversationId, now, emit,
  } = opts;
  if ((schema as { type?: unknown }).type !== "object") {
    throw new Error(
      `runStructured: schema root must be { type: "object", ... } (got ${JSON.stringify((schema as { type?: unknown }).type)}) — a structured answer is one JSON object`,
    );
  }
  const respondTool: Tool = {
    name: RESPOND_TOOL_NAME,
    description:
      "Submit the final answer. `input` must be one JSON object that strictly conforms to the provided schema: " +
      "no extra fields, exact types, all required fields present. This is the ONLY way to answer.",
    inputSchema: { jsonSchema: schema },
    async execute() {
      // Extraction, never execution: the driver pulls the call's input out of
      // the streamed message; the loop's tool machinery is not involved.
      throw new Error("unreachable: the respond tool is extracted, never executed");
    },
  };
  const emitFn = emit ?? (() => {});
  const chain = fallbackChain(model, models);
  const working: Message[] = [...messages];
  let repairs = 0;
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  // Intercept hooks reach the extraction request too — without this the guard a
  // host installed on AgentConfig.hooks would silently not apply here, on the
  // one request that carries the whole history and is most likely to be used
  // for bulk extraction. Run scope ⇒ fail closed, exactly like the loop's.
  if (opts.hooks?.beforeRequest) {
    let r: BeforeRequestResult;
    try {
      r = await opts.hooks.beforeRequest({
        conversationId: conversationId ?? "", turn: 1, messages: [...working], tools: [], signal,
      });
    } catch (err) {
      if (signal.aborted || err instanceof AbortError) throw err;
      throw new HookError("beforeRequest", err);
    }
    if (r && ("abortRun" in r || (r as { abort?: boolean }).abort === true)) {
      throw new HookAbortError(
        (r as { reason?: string }).reason ?? "beforeRequest aborted the run",
      );
    }
    if (r && "inject" in r) working.push(...normalizeInjected(r.inject, now, opts.runId));
  }

  for (;;) {
    if (signal.aborted) throw new AbortError();
    const req: ProviderRequest = {
      model,
      messages: [...working],
      tools: [respondTool],
      config: { ...config, toolChoice: { type: "tool", name: RESPOND_TOOL_NAME } },
      signal,
      ...(conversationId !== undefined ? { conversationId } : {}),
    };
    const { message, stopReason, usage } = await streamTurn(
      provider, req, chain, retry, signal, emitFn, conversationId ?? "respond", 1, now,
    );
    totalUsage = addUsage(totalUsage, usage);
    if (stopReason === "aborted") throw new AbortError();

    const call = findRespondCall(message);
    let failure: string | undefined;
    if (call === undefined) {
      failure = `model ended with stopReason "${stopReason}" without calling ${RESPOND_TOOL_NAME}`;
    } else if (call.input === undefined) {
      failure = "the respond arguments were not valid JSON (possibly cut by the output limit)";
    } else {
      const v = validateJsonSchema(call.input, schema);
      if (!v.ok) failure = v.error;
    }

    if (failure === undefined) {
      const ok = call as ToolCall; // non-null: call !== undefined and input parsed
      return {
        data: ok.input,
        message,
        carrier: {
          id: randomId(),
          role: "user",
          content: [{ type: "tool_result", toolCallId: ok.id, content: "Recorded." }],
          createdAt: now(),
        },
        usage: totalUsage,
      };
    }

    if (repairs >= MAX_STRUCTURED_REPAIRS) {
      throw new StructuredOutputError(`Structured output failed: ${failure}`, failure);
    }
    repairs++;
    // Corrective retry — the failed attempt rides in the REQUEST only; the
    // caller persists nothing of it (see file header).
    working.push(message);
    working.push(
      call !== undefined
        ? {
            id: randomId(),
            role: "user",
            content: [{
              type: "tool_result",
              toolCallId: call.id,
              content:
                `Invalid answer: ${failure}. Call ${RESPOND_TOOL_NAME} again with one corrected JSON object ` +
                `that strictly conforms to the schema.`,
              isError: true,
            }],
            createdAt: now(),
          }
        : {
            id: randomId(),
            role: "user",
            content:
              `That answer was rejected: ${failure}. Call the ${RESPOND_TOOL_NAME} tool with one JSON object ` +
              `that strictly conforms to the schema — that is the only way to answer.`,
            createdAt: now(),
          },
    );
  }
}

/** The first tool_call named `respond` in the message (the forced roster has
 *  exactly one tool, so at most one is expected — first wins defensively). */
function findRespondCall(message: Message): ToolCall | undefined {
  if (typeof message.content === "string") return undefined;
  return message.content.find((b): b is ToolCall => b.type === "tool_call" && b.name === RESPOND_TOOL_NAME);
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

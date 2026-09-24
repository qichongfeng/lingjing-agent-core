// OpenAI Chat Completions adapter for @lingjing-agent/core.
//
// SDK-FREE by design: talks to the OpenAI REST API through a neutral
// HttpTransport (default: the global `fetch`), so it has zero runtime
// dependencies and runs unchanged in Node, browsers, Edge, AND runtimes without
// a global `fetch` (e.g. WeChat mini-programs — supply your own transport that
// bridges wx.request). The map/* helpers translate between core's neutral types
// and OpenAI's wire shapes; the SSE parser consumes a plain AsyncIterable.

import type {
  Content,
  HttpTransport,
  HttpTransportResponse,
  LLMProvider,
  Message,
  ProviderChunk,
  ProviderError,
  ProviderRequest,
  ProviderResponse,
  StopReason,
  TokenUsage,
} from "@lingjing-agent/core";
import { estimateMessagesTokens, fetchTransport, randomId } from "@lingjing-agent/core";
import { mapRequest, type ProviderDialect } from "./map-request.js";
import { mapStream } from "./map-stream.js";
import { mapStop } from "./map-stop.js";
import { mapUsage } from "./map-usage.js";
import { enrichError } from "./enrich-error.js";
import { parseSSE } from "./sse.js";
import type { ChatCompletion, ChatCompletionChunk, OpenAIChatParams } from "./types.js";

export { mapRequest } from "./map-request.js";
export type { ProviderDialect } from "./map-request.js";
export { mapStream } from "./map-stream.js";
export { mapStop } from "./map-stop.js";
export { mapUsage } from "./map-usage.js";
export { parseRetryAfter } from "./parse-retry-after.js";
export { enrichError, isRetryableStatus } from "./enrich-error.js";
export { parseSSE } from "./sse.js";
export type * from "./types.js";

export interface OpenAIProviderOptions {
  /** API key. Sent as `Authorization: Bearer <key>`. Omit to rely on headers/proxy. */
  apiKey?: string;
  /** API base. Default `https://api.openai.com/v1`. Set to ANY OpenAI-compatible endpoint: DeepSeek `api.deepseek.com/v1`, 豆包 `ark.cn-beijing.volces.com/api/v3`, 通义 DashScope compatible-mode, Kimi/Moonshot, 智谱 GLM, Ollama `localhost:11434/v1`, OneAPI/OpenRouter gateways, … */
  baseURL?: string;
  /** Custom `fetch` used by the default `fetchTransport` (Node/browser/Edge). Ignored when `transport` is set. */
  fetch?: typeof fetch;
  /** Custom HTTP transport. Override to run where no global `fetch` exists (e.g. WeChat mini-programs: bridge `wx.request`). Defaults to `fetchTransport(fetch)`. */
  transport?: HttpTransport;
  /** Extra headers applied to every request (e.g. `OpenAI-Beta`, proxy auth). */
  headers?: Record<string, string>;
  /** Wire dialect of the endpoint behind `baseURL` — declares how far the
   *  OpenAI-official parameter extensions apply. `"auto"` (default) sniffs
   *  model names; `"openai"` forces official semantics (aliases, `ft:`
   *  fine-tunes the sniff table misses); `"compat"` never emits OpenAI-only
   *  params (`max_completion_tokens` / `reasoning_effort`) — the right choice
   *  for generic compatible endpoints (DashScope, vLLM, gateways) whatever
   *  their model names look like. Vendor quirks beyond this (e.g. Qwen
   *  `enable_thinking`) go through per-request `providerOptions.body`. */
  dialect?: ProviderDialect;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI Chat Completions adapter over a neutral `HttpTransport`. Speaks the
 * OpenAI Chat Completions PROTOCOL — set `baseURL` to any compatible endpoint
 * (OpenAI, DeepSeek, 豆包/火山, 通义, Kimi, 智谱, Ollama, vLLM, gateways…), not
 * just OpenAI's own API. Streaming maps OpenAI's index-keyed tool-call deltas to
 * core's id-keyed `tool_call_delta`, reasoning deltas (`reasoning_content` /
 * `reasoning`, emitted by compatible thinking models) to core `thinking_delta`
 * chunks, and defers `message_end` to the usage-only final chunk (with a
 * zeroed-usage fallback if usage never arrives).
 *
 * NOTE on overflow: OpenAI signals that the conversation is too long with an
 * HTTP 400 (`context_length_exceeded`) error, NOT a stop reason. So
 * `capabilities.stopReasons` omits `pause_turn`/`context_window_exceeded`. Core's
 * context-overflow path is reached when this adapter throws a non-retryable
 * `ProviderError` (status 400) — it does not retry into a `compact()` cycle the
 * way the Anthropic adapter's `context_window_exceeded` stop reason does.
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = "openai";
  readonly capabilities = {
    // OpenAI has no pause_turn stop reason. context_window_exceeded is surfaced
    // via HTTP 400 (context_length_exceeded) — the adapter tags it with
    // code:"context_length_exceeded" so core's loop routes it to compact.
    stopReasons: [
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "refusal",
      "context_window_exceeded",
    ] as readonly StopReason[],
    streaming: true,
    // Thinking IS surfaced: compatible endpoints (DeepSeek R1, Kimi, GLM, Qwen,
    // 豆包, OpenRouter) stream `reasoning_content`/`reasoning` deltas, which
    // map to core thinking blocks. OpenAI proper keeps reasoning server-side.
    thinking: true,
  };

  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly transport: HttpTransport;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly dialect: ProviderDialect;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = opts.transport ?? fetchTransport(opts.fetch);
    this.extraHeaders = opts.headers;
    this.dialect = opts.dialect ?? "auto";
  }

  stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const params = mapRequest(req, this.dialect);
    return this.runStream(params, req);
  }

  private async *runStream(params: OpenAIChatParams, req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const response = await this.request(params, req, true);
    // mapStream wraps the SSE iterator and re-throws any error as a classified
    // ProviderError (status/retryable/retryAfterMs) via enrichError.
    yield* mapStream(parseSSE(response.body));
  }

  /** Non-streaming completion. Drains the model's single response into a Message. */
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const streaming = mapRequest(req, this.dialect);
    const params: OpenAIChatParams = { ...streaming, stream: false };
    delete (params as Partial<OpenAIChatParams>).stream_options;
    const response = await this.request(params, req, false);
    const text = await drainText(response.body);
    if (text === "") {
      throw malformedBody("OpenAI returned an empty response body", response.status);
    }
    let res: ChatCompletion;
    try {
      res = JSON.parse(text) as ChatCompletion;
    } catch {
      throw malformedBody(`OpenAI returned a malformed JSON body: ${text.slice(0, 200)}`, response.status);
    }
    const choice = res.choices?.[0];
    const message = choice?.message;
    const textContent = message?.content ?? "";
    const blocks: Content[] = [];
    // Thinking block (compatible endpoints: DeepSeek R1 / Kimi / GLM / Qwen …)
    // precedes the answer, mirroring the streaming chunk order.
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    if (typeof reasoning === "string" && reasoning.length > 0) {
      blocks.push({ type: "thinking", text: reasoning });
    }
    // Refusal text (safety channel) is surfaced as text alongside content.
    const refusal = typeof message?.refusal === "string" && message.refusal.length > 0 ? message.refusal : "";
    if (textContent || refusal) {
      blocks.push({ type: "text", text: [textContent, refusal].filter(Boolean).join("\n") });
    }
    for (const tc of message?.tool_calls ?? []) {
      blocks.push({
        type: "tool_call",
        id: tc.id ?? randomId(),
        name: tc.function?.name ?? "",
        inputJson: tc.function?.arguments ?? "{}",
      });
    }
    const msg: Message = {
      id: res.id ?? randomId(),
      role: "assistant",
      content: blocks.length > 0 ? blocks : textContent,
      createdAt: Date.now(),
    };
    const stopReason: StopReason = mapStop(choice?.finish_reason);
    const usage: TokenUsage = mapUsage(res.usage ?? null);
    return { message: msg, stopReason, usage };
  }

  /** CJK-aware heuristic estimate (shared with core — see core tokens.ts).
   *  Good enough for budget checks and incremental deltas; absolute context
   *  size comes from the usage anchor the loop maintains. */
  countTokens(messages: Message[], _model: string): Promise<number> {
    return Promise.resolve(estimateMessagesTokens(messages));
  }

  private buildHeaders(req: ProviderRequest): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.apiKey !== undefined ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    const fromOpts = this.extraHeaders;
    if (fromOpts) Object.assign(headers, fromOpts);
    const perReq = req.config.providerOptions?.headers as Record<string, string> | undefined;
    if (perReq) Object.assign(headers, perReq);
    return headers;
  }

  private async request(
    params: OpenAIChatParams,
    req: ProviderRequest,
    _stream: boolean,
  ): Promise<HttpTransportResponse> {
    const headers = this.buildHeaders(req);
    let response: HttpTransportResponse;
    try {
      response = await this.transport({
        url: `${this.baseURL}/chat/completions`,
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: req.signal,
      });
    } catch (err) {
      // Caller-initiated abort: propagate as-is (don't mask as a retryable error).
      if (req.signal.aborted || isAbortError(err)) throw err;
      // Network error: no HTTP status ⇒ enrichError treats as transient/retryable.
      throw enrichError(err);
    }
    if (response.status < 200 || response.status >= 300) {
      throw await this.httpError(response);
    }
    return response;
  }

  private async httpError(response: HttpTransportResponse): Promise<ProviderError> {
    const body = await drainText(response.body);
    const detail = body ? ` — ${body.slice(0, 300)}` : "";
    const overflow = response.status === 400 && body.includes("context_length_exceeded");
    // Machine-readable codes so core can tier-fallback without parsing the
    // message: 404 model_not_found (the model is gone) and bare 529 (some
    // OpenAI-compatible gateways use it for overload).
    let code: string | undefined = overflow ? "context_length_exceeded" : undefined;
    if (code === undefined) {
      const c = tryParseJson(body)?.error?.code;
      if (c === "model_not_found" || (typeof c === "string" && c.includes("model_not_found"))) {
        code = "model_not_found";
      }
    }
    if (code === undefined && response.status === 529) code = "overloaded";
    const err = Object.assign(
      new Error(`OpenAI request failed: ${response.status} ${response.statusText}${detail}`),
      {
        status: response.status,
        headers: response.headers,
        ...(code !== undefined ? { code } : {}),
      },
    );
    return enrichError(err);
  }
}

/** Best-effort JSON.parse of an error body; undefined on anything unparsable. */
function tryParseJson(body: string): { error?: { type?: string; code?: string } } | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as { error?: { type?: string; code?: string } })
      : undefined;
  } catch {
    return undefined;
  }
}

/** Drain a transport body (AsyncIterable<Uint8Array>) into a string. */
async function drainText(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of body) out += decoder.decode(chunk, { stream: true });
  out += decoder.decode();
  return out;
}

/** Build a NON-retryable ProviderError for a protocol-level body problem (empty/malformed). */
function malformedBody(message: string, status: number): ProviderError {
  return Object.assign(new Error(message), {
    name: "ProviderError",
    retryable: false,
    status,
  }) as ProviderError;
}

/** True for the AbortError/DOMException thrown when a request is cancelled. */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" ||
      (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError"))
  );
}

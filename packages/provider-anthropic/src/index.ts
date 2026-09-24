// Anthropic Messages adapter for @lingjing-agent/core.
//
// SDK-FREE by design: talks to the Anthropic REST API (POST /v1/messages) through
// a neutral HttpTransport (default: the global `fetch`), so it has zero runtime
// dependencies and runs unchanged in Node, browsers, Edge, AND runtimes without
// a global `fetch` (e.g. WeChat mini-programs — supply your own transport that
// bridges wx.request). The map/* helpers translate between core's neutral types
// and Anthropic's wire shapes; the SSE parser consumes a plain AsyncIterable.

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
import { mapRequest } from "./map-request.js";
import { mapStream } from "./map-stream.js";
import { mapStop } from "./map-stop.js";
import { mapUsage } from "./map-usage.js";
import { enrichError } from "./enrich-error.js";
import { parseSSE } from "./sse.js";
import type { AnthropicMessageRequest, AnthropicMessageResponse } from "./types.js";

export { mapRequest } from "./map-request.js";
export { mapStream } from "./map-stream.js";
export { mapStop } from "./map-stop.js";
export { mapUsage } from "./map-usage.js";
export { parseRetryAfter } from "./parse-retry-after.js";
export { enrichError, isRetryableStatus } from "./enrich-error.js";
export { parseSSE } from "./sse.js";
export type * from "./types.js";

export interface AnthropicProviderOptions {
  /** API key. Sent as `x-api-key`. Omit to rely on headers/proxy. */
  apiKey?: string;
  /** API base. Default `https://api.anthropic.com/v1`. */
  baseURL?: string;
  /** Custom `fetch` used by the default `fetchTransport`. Ignored when `transport` is set. */
  fetch?: typeof fetch;
  /** Custom HTTP transport. Override to run where no global `fetch` exists (e.g. WeChat mini-programs). Defaults to `fetchTransport(fetch)`. */
  transport?: HttpTransport;
  /** Extra headers applied to every request (e.g. `anthropic-beta`). */
  headers?: Record<string, string>;
  /** `anthropic-version` header value. Default `2023-06-01`. */
  anthropicVersion?: string;
  /** Prompt-caching DEFAULT for every request — the one-line "auto" switch:
   *  sets cache_control breakpoints (default targets: system + last user
   *  message) without threading providerOptions per request. Per-request
   *  `providerOptions.cacheControl` still overrides this. Omit to keep
   *  caching off (today's behavior). */
  cacheControl?: { targets?: ("system" | "last_user")[]; ttl?: "5m" | "1h" };
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_VERSION = "2023-06-01";

/**
 * Anthropic Messages adapter over a neutral `HttpTransport`. Streaming maps
 * Anthropic's `content_block_*` events (id-keyed tool_use, signature-bearing
 * thinking) to core's neutral ProviderChunk. Overflow is a `context_window_exceeded`
 * stop reason (not HTTP 400 like OpenAI), so core compacts directly.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly capabilities = {
    stopReasons: [
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "pause_turn",
      "refusal",
      "context_window_exceeded",
    ] as readonly StopReason[],
    streaming: true,
    thinking: true,
    promptCaching: true,
  };

  private readonly apiKey: string | undefined;
  private readonly baseURL: string;
  private readonly transport: HttpTransport;
  private readonly extraHeaders: Record<string, string> | undefined;
  private readonly version: string;
  private readonly cacheControl: { targets: string[]; ttl?: "5m" | "1h" } | undefined;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = opts.transport ?? fetchTransport(opts.fetch);
    this.extraHeaders = opts.headers;
    this.version = opts.anthropicVersion ?? DEFAULT_VERSION;
    // Normalize once: an empty cacheControl object still means "on, with the
    // standard two breakpoints" (system + last user — the documented recipe;
    // two breakpoints stay well under Anthropic's limit of four).
    this.cacheControl = opts.cacheControl
      ? {
          targets: opts.cacheControl.targets ?? ["system", "last_user"],
          ...(opts.cacheControl.ttl !== undefined ? { ttl: opts.cacheControl.ttl } : {}),
        }
      : undefined;
  }

  /** Fold the constructor-level caching default into the request's
   *  providerOptions — an explicit per-request cacheControl always wins. */
  private prep(req: ProviderRequest): ProviderRequest {
    if (this.cacheControl === undefined) return req;
    const po = (req.config.providerOptions ?? {}) as Record<string, unknown>;
    if (po.cacheControl !== undefined) return req;
    return {
      ...req,
      config: { ...req.config, providerOptions: { ...po, cacheControl: this.cacheControl } },
    };
  }

  stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const prepped = this.prep(req);
    const params = mapRequest(prepped);
    return this.runStream(params, prepped);
  }

  private async *runStream(params: AnthropicMessageRequest, req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const response = await this.request(params, req);
    // mapStream wraps the SSE iterator and re-throws any error as a classified
    // ProviderError (status/retryable/retryAfterMs) via enrichError.
    yield* mapStream(parseSSE(response.body));
  }

  /** Non-streaming completion. Drains the model's single response into a Message. */
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const streaming = mapRequest(this.prep(req));
    const params: AnthropicMessageRequest = { ...streaming, stream: false };
    delete (params as Partial<AnthropicMessageRequest>).stream;
    const response = await this.request(params, req);
    const text = await drainText(response.body);
    if (text === "") {
      throw malformedBody("Anthropic returned an empty response body", response.status);
    }
    let res: AnthropicMessageResponse;
    try {
      res = JSON.parse(text) as AnthropicMessageResponse;
    } catch {
      throw malformedBody(`Anthropic returned a malformed JSON body: ${text.slice(0, 200)}`, response.status);
    }
    const blocks: Content[] = [];
    for (const b of res.content ?? []) {
      if (b.type === "text") {
        blocks.push({ type: "text", text: b.text });
      } else if (b.type === "thinking") {
        blocks.push({ type: "thinking", text: b.thinking, ...(b.signature ? { signature: b.signature } : {}) });
      } else if (b.type === "tool_use") {
        blocks.push({
          type: "tool_call",
          id: b.id,
          name: b.name,
          inputJson: JSON.stringify(b.input ?? {}),
          input: b.input,
        });
      }
    }
    const msg: Message = {
      id: res.id ?? randomId(),
      role: "assistant",
      content: blocks.length > 0 ? blocks : "",
      createdAt: Date.now(),
    };
    const stopReason: StopReason = mapStop(res.stop_reason);
    const usage: TokenUsage = mapUsage(res.usage ?? null);
    return { message: msg, stopReason, usage };
  }

  /** CJK-aware heuristic estimate (shared with core — see core tokens.ts).
   *  Good enough for budget checks and incremental deltas; absolute context
   *  size comes from the usage anchor the loop maintains. */
  countTokens(messages: Message[], _model: string): Promise<number> {
    return Promise.resolve(estimateMessagesTokens(messages));
  }

  private buildHeaders(_req: ProviderRequest): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": this.version,
      ...(this.apiKey !== undefined ? { "x-api-key": this.apiKey } : {}),
    };
    if (this.extraHeaders) Object.assign(headers, this.extraHeaders);
    return headers;
  }

  private async request(
    params: AnthropicMessageRequest,
    req: ProviderRequest,
  ): Promise<HttpTransportResponse> {
    const headers = this.buildHeaders(req);
    let response: HttpTransportResponse;
    try {
      response = await this.transport({
        url: `${this.baseURL}/messages`,
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
    // Machine-readable code so core can tier-fallback without parsing the
    // message: overloaded_error (529) and model-gone 404s are the availability
    // signals. Anthropic's 404 for an unknown model uses error.type
    // "not_found_error" (message mentions the model), not "model_not_found".
    let code: string | undefined;
    const type = tryParseJson(body)?.error?.type;
    if (type === "overloaded_error") code = "overloaded";
    else if (type === "model_not_found" || type === "not_found_error") code = "model_not_found";
    if (code === undefined && response.status === 529) code = "overloaded"; // gateways emit bare 529
    const err = Object.assign(
      new Error(`Anthropic request failed: ${response.status} ${response.statusText}${detail}`),
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

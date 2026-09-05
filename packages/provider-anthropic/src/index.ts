// Anthropic Messages adapter for @lingjing/agent-core.
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
} from "@lingjing/agent-core";
import { fetchTransport, randomId } from "@lingjing/agent-core";
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

  constructor(opts: AnthropicProviderOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseURL = (opts.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = opts.transport ?? fetchTransport(opts.fetch);
    this.extraHeaders = opts.headers;
    this.version = opts.anthropicVersion ?? DEFAULT_VERSION;
  }

  stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const params = mapRequest(req);
    return this.runStream(params, req);
  }

  private async *runStream(params: AnthropicMessageRequest, req: ProviderRequest): AsyncIterable<ProviderChunk> {
    const response = await this.request(params, req);
    // mapStream wraps the SSE iterator and re-throws any error as a classified
    // ProviderError (status/retryable/retryAfterMs) via enrichError.
    yield* mapStream(parseSSE(response.body));
  }

  /** Non-streaming completion. Drains the model's single response into a Message. */
  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const streaming = mapRequest(req);
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

  /** Cheap char/4 token estimate (no tokenizer dep). Good enough for budget checks. */
  countTokens(messages: Message[], _model: string): Promise<number> {
    let chars = 0;
    for (const m of messages) {
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
    return Promise.resolve(Math.ceil(chars / 4));
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
    const err = Object.assign(
      new Error(`Anthropic request failed: ${response.status} ${response.statusText}${detail}`),
      {
        status: response.status,
        headers: response.headers,
      },
    );
    return enrichError(err);
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

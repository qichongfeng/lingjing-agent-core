// HTTP transport abstraction for runtime-agnostic networking.
//
// core's providers and tools reach the network only through an HttpTransport: a
// single function that turns a neutral request into a response whose body is an
// AsyncIterable<Uint8Array>. This deliberately avoids the Web Response /
// ReadableStream.getReader() shape so the SAME provider/tool code runs unchanged
// in Node, browsers, Edge, AND runtimes that lack those globals — most notably
// WeChat mini-programs (wx.request yields chunked data via callbacks, not a
// ReadableStream). Hosts without a global `fetch` supply their own HttpTransport;
// hosts that have one can reuse `fetchTransport` below.

/**
 * A neutral HTTP request. `headers` is a plain record (not a `Headers` object)
 * so it is constructable in any runtime. `body` is OMITTED for bodyless
 * requests (GET) rather than set to `undefined`, so callers stay clean under
 * `exactOptionalPropertyTypes`.
 */
export interface HttpTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/**
 * A neutral HTTP response. `body` is a one-shot `AsyncIterable<Uint8Array>`: it
 * must be consumed at most once, and it MUST respect `signal` (throw on abort)
 * so upper layers can cancel an in-flight stream. `headers` keys are
 * lower-cased so lookups are case-insensitive.
 */
export interface HttpTransportResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

/**
 * Turn a neutral request into a neutral response. Implementations bridge to the
 * host's network API (global `fetch`, `wx.request`, a mocked fetch in tests, …).
 * They must NOT swallow errors or classify aborts — that is the caller's job.
 */
export type HttpTransport = (req: HttpTransportRequest) => Promise<HttpTransportResponse>;

/**
 * Default `HttpTransport` backed by the global `fetch`. Bridges the Web
 * `Response` / `ReadableStream` shape to the neutral transport contract. Only
 * meaningful in a runtime that provides a global `fetch` (Node 18+, browsers,
 * Edge) — runtimes without one (mini-programs) pass their own transport and
 * never call this.
 *
 * The fetch impl is resolved at CALL time (`fetchImpl ?? fetch`, not a default
 * parameter) so merely importing this module never touches the global `fetch` —
 * a runtime without `fetch` pays nothing unless it actually invokes the default.
 */
export function fetchTransport(fetchImpl?: typeof fetch): HttpTransport {
  return async (req) => {
    const f = fetchImpl ?? fetch;
    const init: RequestInit = {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
    };
    if (req.body !== undefined) init.body = req.body;
    const res = await f(req.url, init);
    // A conforming fetch RESOLVES a Response for every request it completes and
    // REJECTS otherwise. Wrappers that break this contract exist in the wild —
    // some browsers' proxy/acceleration features and extensions resolve
    // `undefined` for requests they silently dropped (observed on a CORS-blocked
    // fetch in a Chromium derivative). Crash there reads as an opaque
    // "Cannot read properties of undefined (reading 'headers')" from deep inside
    // the agent; say what actually happened instead.
    if (!isResponseLike(res)) {
      throw new Error(
        `fetch for ${req.url} resolved ${res === undefined ? "undefined" : res === null ? "null" : "a non-Response object"} ` +
          "instead of a Response — the runtime's fetch is wrapped or broken " +
          "(browser extension, proxy/acceleration feature, polyfill?) and swallowed the failure",
      );
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body: AsyncIterable<Uint8Array> = res.body
      ? readableStreamToAsyncIterable(res.body)
      : emptyAsyncIterable();
    return { status: res.status, statusText: res.statusText, headers, body };
  };
}

/** Bridge a Web ReadableStream to an AsyncIterable. ReadableStream is async-
 *  iterable AT RUNTIME in Node 18+, browsers, and Edge (WHATWG) — exactly the
 *  runtimes where fetchTransport is used. The TS lib declaration lags the
 *  standard, so we cast to AsyncIterable for the iterator protocol. */
async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
  } finally {
    // Release the underlying body when the consumer stops early (abort / break),
    // so the HTTP connection returns to the pool (undici sockets, browser fetch).
    // No-op if already fully consumed or errored.
    try {
      await stream.cancel();
    } catch {
      /* already closed / cancelled / unsupported */
    }
  }
}

/** Yields nothing — used for null bodies (204/205/304). */
async function* emptyAsyncIterable(): AsyncIterable<Uint8Array> {
  // intentionally empty
}

/** Minimum Response shape fetchTransport dereferences (headers.forEach + status). */
function isResponseLike(res: unknown): res is Response {
  return (
    typeof res === "object" && res !== null &&
    typeof (res as { headers?: { forEach?: unknown } }).headers?.forEach === "function"
  );
}

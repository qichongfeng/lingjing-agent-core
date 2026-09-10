// Streamable HTTP transport (legacy 2025-03-26+ semantics) over core's
// HttpTransport — so the SAME bridge reaches MCP servers from Node, browsers,
// Edge, and mini-programs (inject a wx.request-backed HttpTransport).
//
// Wire rules implemented here:
// - Every message is a POST of one JSON-RPC message; Accept both
//   application/json and text/event-stream.
// - 202 = notification accepted (no body). 200 = single JSON response OR an
//   SSE stream of messages; the response to OUR request id arrives on the
//   same stream and we MAY stop consuming once it does (breaking the for-await
//   runs the core transport body generator's finally — releasing the
//   connection).
// - `Mcp-Session-Id` from the initialize response is echoed on every
//   subsequent request; a 404 while carrying it means the session expired
//   (thrown as McpSessionExpiredError — McpClient re-initializes once).
// - `MCP-Protocol-Version` is sent on subsequent requests once the client has
//   negotiated a version (setProtocolVersion).
// - close() sends a best-effort DELETE to terminate the server session.

import {
  TimeoutError,
  concatBytes,
  decodeUtf8,
  fetchTransport,
  sseDataEvents,
  type HttpTransport,
  type HttpTransportResponse,
} from "@lingjing-agent/core";
import { isResponse, parseJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.js";
import { McpSessionExpiredError, type McpTransport, type McpTransportSendOptions } from "./mcp-transport.js";
import { OAuthSession, type McpOAuthConfig } from "./oauth.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_SNIPPET = 512;
/** Floor for the POST safety cap: the client's per-request timer is the primary
 *  budget; this cap is the backstop that eventually kills an abandoned POST
 *  (the client rejects on timeout but does not abort the connection). */
const SSE_HARD_CAP_MS = 60_000;

/** A non-session (>= 400, not the 404-with-session) HTTP error. `.status` lets
 *  McpClient classify transient (5xx/408/429) vs terminal (other 4xx). */
export class McpHttpError extends Error {
  override readonly name = "McpHttpError";
  readonly status: number;
  readonly statusText: string;
  constructor(status: number, statusText: string, message: string) {
    super(message);
    this.status = status;
    this.statusText = statusText;
  }
}

export interface HttpMcpTransportOptions {
  url: string;
  /** Core HttpTransport (e.g. a mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Extra headers on every request (Authorization etc.). */
  headers?: Record<string, string>;
  /** OAuth 2.1 for this server: injects a Bearer token, refreshes on 401. */
  auth?: McpOAuthConfig;
}

export function createHttpMcpTransport(opts: HttpMcpTransportOptions): McpTransport {
  const label = `http ${opts.url}`;
  // Resolved lazily (core precedent) so importing this module never touches
  // a missing global fetch in exotic runtimes.
  let coreTransport: HttpTransport | undefined = opts.transport;
  const extraHeaders = opts.headers ?? {};
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let msgListener: ((msg: JsonRpcMessage) => void) | undefined;
  let closed = false;
  const oauth = opts.auth ? new OAuthSession(opts.auth, opts.auth.key ?? `mcp:${opts.url}`) : undefined;

  const transport = (): HttpTransport => {
    coreTransport ??= fetchTransport();
    return coreTransport;
  };

  /** Buffer the response body up to cap bytes and decode it (UTF-8). */
  async function readBodyCapped(resp: HttpTransportResponse): Promise<string> {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of resp.body) {
      chunks.push(chunk);
      received += chunk.byteLength;
      if (received > MAX_BODY_BYTES) {
        throw new Error(`${label}: response body exceeds ${MAX_BODY_BYTES} bytes`);
      }
    }
    return decodeUtf8(concatBytes(chunks));
  }

  function headersFor(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extraHeaders,
      ...(sessionId !== undefined && { "mcp-session-id": sessionId }),
      ...(protocolVersion !== undefined && { "mcp-protocol-version": protocolVersion }),
    };
  }

  const t: McpTransport = {
    label,
    send(msg, sendOpts): Promise<void> {
      if (closed) return Promise.reject(new Error(`${label}: transport closed`));
      return sendImpl(msg, sendOpts);
    },
    onMessage(l) {
      msgListener = l;
    },
    onClose() {
      // HTTP has no push close; session loss surfaces per-request (404).
    },
    async close() {
      closed = true;
      if (sessionId === undefined) return;
      // Best-effort DELETE to terminate the server session; ignore failures.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        await transport()({
          url: opts.url,
          method: "DELETE",
          headers: headersFor(),
          signal: controller.signal,
        });
      } catch {
        /* best-effort */
      } finally {
        clearTimeout(timer);
      }
    },
    setProtocolVersion(v) {
      protocolVersion = v;
    },
    resetSession() {
      sessionId = undefined;
    },
    async reopen() {
      sessionId = undefined;
      closed = false;
    },
  };

  async function sendImpl(msg: JsonRpcMessage, sendOpts: McpTransportSendOptions | undefined): Promise<void> {
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    if (sendOpts?.signal !== undefined) {
      if (sendOpts.signal.aborted) {
        controller.abort();
      } else {
        sendOpts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    let capFired = false;
    // Safety cap = the caller's budget when it exceeds the floor, so a
    // configured timeoutMs (e.g. a bridged tool's 120s) is never silently
    // cut short by the lower-layer default.
    const capMs = Math.max(SSE_HARD_CAP_MS, sendOpts?.timeoutMs ?? 0);
    const capTimer = setTimeout(() => {
      capFired = true;
      controller.abort();
    }, capMs);

    try {
      // One 401 replay (token refresh) — the common OAuth expiry case.
      let authHeaders = await authHeader();
      for (let attempt = 0; ; attempt++) {
        try {
          await postOnce(msg, authHeaders, controller, capMs, () => capFired);
          return;
        } catch (err) {
          const retryAuth = oauth !== undefined && attempt === 0 && err instanceof McpHttpError && err.status === 401;
          if (!retryAuth) throw err;
          // Keep the refresh token: the 401 invalidated the access token, not
          // the session — refresh first, re-authorize only if that fails.
          await oauth.invalidateAccessToken();
          authHeaders = await authHeader();
        }
      }
    } catch (err) {
      if (capFired) {
        throw new TimeoutError(`${label}: SSE stream exceeded ${capMs}ms without a response`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(capTimer);
      sendOpts?.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  async function authHeader(): Promise<Record<string, string>> {
    if (oauth === undefined) return {};
    const token = await oauth.getAccessToken();
    return { authorization: `Bearer ${token}` };
  }

  async function postOnce(
    msg: JsonRpcMessage,
    authHeaders: Record<string, string>,
    controller: AbortController,
    capMs: number,
    capFired: () => boolean,
  ): Promise<void> {
    const resp = await transport()({
      url: opts.url,
      method: "POST",
      headers: { ...headersFor(), ...authHeaders },
      body: JSON.stringify(msg),
      signal: controller.signal,
    });

    const newSession = resp.headers["mcp-session-id"];
    if (typeof newSession === "string" && newSession !== "") sessionId = newSession;

    if (resp.status === 202) return; // notification accepted, no body

    if (resp.status >= 400) {
      const body = await readBodyCapped(resp).catch(() => "");
      if (resp.status === 404 && sessionId !== undefined) {
        throw new McpSessionExpiredError(`${label}: HTTP 404 — session ${sessionId} expired`);
      }
      const snippet = body.slice(0, MAX_ERROR_SNIPPET).replace(/\s+/g, " ").trim();
      throw new McpHttpError(
        resp.status,
        resp.statusText,
        `${label}: HTTP ${resp.status} ${resp.statusText}${snippet === "" ? "" : ` — ${snippet}`}`,
      );
    }

    const contentType = resp.headers["content-type"] ?? "";
    if (/text\/event-stream/i.test(contentType)) {
      await pumpSse(resp, msg, controller, capMs, capFired);
      return;
    }
    // Single JSON response.
    const text = await readBodyCapped(resp);
    const parsed = parseJsonRpcMessage(text);
    if (parsed === undefined) {
      throw new Error(`${label}: response body is not a JSON-RPC message`);
    }
    msgListener?.(parsed);
  }

  /**
   * Pump the SSE response: dispatch every message; for a REQUEST (id +
   * method) stop as soon as ITS response arrives (MAY per spec) — breaking
   * out of the for-await releases the underlying connection. Throws if the
   * stream ends without the awaited response.
   */
  async function pumpSse(
    resp: HttpTransportResponse,
    msg: JsonRpcMessage,
    controller: AbortController,
    capMs: number,
    capFired: () => boolean,
  ): Promise<void> {
    const awaitedId = "id" in msg && "method" in msg ? msg.id : undefined;
    let sawResponse = awaitedId === undefined;
    try {
      for await (const payload of sseDataEvents(resp.body, label)) {
        const parsed = parseJsonRpcMessage(payload);
        if (parsed === undefined) continue;
        msgListener?.(parsed);
        if (awaitedId !== undefined && isResponse(parsed) && parsed.id === awaitedId) {
          sawResponse = true;
          break; // stop consuming → transport body generator finally runs
        }
      }
    } catch (err) {
      if (capFired()) {
        throw new TimeoutError(`${label}: SSE stream exceeded ${capMs}ms without a response`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (!sawResponse) {
      // The awaited response never arrived on this stream — surface now
      // instead of letting the request hang until its timeout.
      controller.abort();
      throw new Error(`${label}: SSE stream ended without a response for request ${String(awaitedId)}`);
    }
  }

  return t;
}

// McpClient — legacy-era (initialize handshake) JSON-RPC client for MCP.
//
// Owns: request-id correlation, per-request timeout + abort, protocol version
// negotiation, ping responses, and a one-shot session re-initialization when
// the HTTP transport reports McpSessionExpiredError. Transport-agnostic via
// the McpTransport seam; only the tools surface (initialize / tools/list /
// tools/call / notifications/cancelled) is implemented — resources, prompts
// and sampling are out of scope.

import { AbortError, TimeoutError, sleep } from "@lingjing-agent/core";
import {
  isNotification,
  isRequest,
  isResponse,
  JsonRpcRemoteError,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./json-rpc.js";
import { McpSessionExpiredError, type McpTransport } from "./mcp-transport.js";

/** The highest legacy version this client asks for; servers may answer lower. */
export const REQUESTED_PROTOCOL_VERSION = "2025-11-25";
/** Legacy (initialize-handshake) protocol versions this client can speak. */
export const KNOWN_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;

const MAX_LIST_PAGES = 100;
const MAX_ARGUMENTS_BYTES = 4 * 1024 * 1024;

export class McpUnsupportedProtocolError extends Error {
  override readonly name = "McpUnsupportedProtocolError";
  readonly serverVersion: string;

  constructor(serverVersion: string) {
    super(
      `MCP server returned protocol version '${serverVersion}', which this client does not support. ` +
        `This bridge speaks the legacy initialize era (${KNOWN_PROTOCOL_VERSIONS.join(", ")}); ` +
        `versions from 2026-07-28 are modern-era (no initialize handshake) and not yet supported.`,
    );
    this.serverVersion = serverVersion;
  }
}

/** Server answered a known legacy version → use it; anything else → refuse. */
export function negotiateProtocolVersion(requested: string, serverVersion: string): string {
  if ((KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(serverVersion)) return serverVersion;
  throw new McpUnsupportedProtocolError(serverVersion);
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
  instructions?: string;
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema — passed through verbatim into core's Tool.inputSchema.jsonSchema. */
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpToolContentBlock {
  type: "text" | "image" | "audio" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
}

export interface McpToolCallResult {
  content: McpToolContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string };
}

export interface McpPromptGetResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpRetryOptions {
  /** Total attempts (1 = no retry). Default 5. */
  maxAttempts: number;
  /** Initial backoff, doubled each attempt with jitter. Default 250. */
  baseDelayMs: number;
  /** Backoff ceiling. Default 5000. */
  maxDelayMs: number;
}

export interface McpClientOptions {
  transport: McpTransport;
  clientInfo?: { name: string; version: string };
  /** Timeout for handshake/list/call requests. Default 60_000. */
  requestTimeoutMs?: number;
  /** Transient-failure retry: network loss, transport drop, HTTP 5xx/408/429.
   *  Logical timeouts and aborts are NOT retried (replay safety). */
  retry?: McpRetryOptions;
}

interface PendingEntry {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  abortListener: (() => void) | undefined;
  signal: AbortSignal | undefined;
}

export class McpClient {
  private readonly transport: McpTransport;
  private readonly clientInfo: { name: string; version: string };
  private readonly defaultTimeoutMs: number;
  private readonly retry: McpRetryOptions;
  private nextId = 0;
  private readonly pending = new Map<number | string, PendingEntry>();
  private initResult: McpInitializeResult | undefined;
  private negotiated: string | undefined;
  private connected = false;
  private closed = false;
  /** Transport died unexpectedly and needs reopen+reconnect before the next request. */
  private dead = false;
  /** Why the client closed (transport failure or deliberate close()) — surfaced by post-close calls. */
  private closeError: Error | undefined;
  private readonly closeHandlers: ((err?: Error) => void)[] = [];
  /** One session-expired retry per session generation (reset by connect()). */
  private reinitRetried = false;
  /** In-flight ensureConnected() — the single-flight shared by concurrent callers. */
  private connecting: Promise<void> | undefined;
  private toolsChangedHandler: (() => void) | undefined;

  constructor(opts: McpClientOptions) {
    this.transport = opts.transport;
    this.clientInfo = opts.clientInfo ?? { name: "@lingjing-agent/mcp", version: "0.1.0" };
    this.defaultTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.retry = opts.retry ?? { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5000 };
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.transport.onClose((err) => this.onTransportClosed(err));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get protocolVersion(): string {
    return this.negotiated ?? REQUESTED_PROTOCOL_VERSION;
  }

  get serverInfo(): McpServerInfo | undefined {
    return this.initResult?.serverInfo;
  }

  get instructions(): string | undefined {
    return this.initResult?.instructions;
  }

  onClose(handler: (err?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  /** Fires when the server sends notifications/tools/list_changed — the Tool
   *  bridge re-lists and diffs. At most one handler (the session owns it). */
  onToolsChanged(handler: () => void): void {
    this.toolsChangedHandler = handler;
  }

  /** Legacy initialize handshake; negotiate the protocol version (server's
   *  answer wins within KNOWN_PROTOCOL_VERSIONS) → `notifications/initialized`.
   *  Non-dying: throws WITHOUT closing the client so a reconnect loop can
   *  retry. Public connect() wraps this and terminates on failure. */
  private async connectInternal(): Promise<McpInitializeResult> {
    let raw: unknown;
    try {
      raw = await this.requestOnce(
        "initialize",
        {
          protocolVersion: REQUESTED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
        {},
      );
    } catch (err) {
      if (err instanceof JsonRpcRemoteError || err instanceof McpSessionExpiredError) throw err;
      throw new Error(
        `${this.transport.label}: initialize failed (${errMsg(err)}) — the server may require the ` +
          `modern (2026-07-28+) MCP era, which this client does not speak yet`,
        { cause: err },
      );
    }
    const result = asInitializeResult(raw);
    if (result === undefined) {
      throw new Error(`${this.transport.label}: initialize returned a malformed result`);
    }
    const version = negotiateProtocolVersion(REQUESTED_PROTOCOL_VERSION, result.protocolVersion);
    this.initResult = result;
    this.negotiated = version;
    this.transport.setProtocolVersion?.(version);
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    // Connected only once the handshake is complete: a failed initialized
    // POST leaves connected=false, so a later attempt re-handshakes instead
    // of short-circuiting ensureConnected against a half-initialized session.
    this.connected = true;
    this.reinitRetried = false;
    return result;
  }

  async connect(): Promise<McpInitializeResult> {
    if (this.closed) throw new Error("MCP client closed");
    try {
      return await this.connectInternal();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.handleTerminal(e);
      await this.transport.close(); // no leaked child/session
      throw err;
    }
  }

  /** `tools/list`, following nextCursor pagination to exhaustion. */
  async listTools(): Promise<McpToolDescriptor[]> {
    this.assertUsable();
    const out: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > MAX_LIST_PAGES) {
        throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages (misbehaving nextCursor loop?)`);
      }
      // First page omits `cursor` entirely — some servers reject unknown params.
      const raw = await this.request("tools/list", cursor === undefined ? undefined : { cursor });
      const page = asListToolsResult(raw);
      if (page === undefined) {
        throw new Error(`${this.transport.label}: tools/list returned a malformed result`);
      }
      out.push(...page.tools);
      if (page.nextCursor === undefined || page.nextCursor === "") break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /**
   * `tools/call`. Resolves with the server's result even when it carries
   * `isError: true` (the Tool bridge owns isError mapping); rejects on
   * JSON-RPC error, timeout, abort, or transport loss.
   */
  async callTool(name: string, args: unknown, opts: McpRequestOptions = {}): Promise<McpToolCallResult> {
    this.assertUsable();
    const arguments_ = args === undefined || args === null ? {} : args;
    const serialized = JSON.stringify(arguments_);
    if (serialized !== undefined && serialized.length > MAX_ARGUMENTS_BYTES) {
      throw new Error(`MCP tool arguments exceed ${MAX_ARGUMENTS_BYTES} bytes (serialized)`);
    }
    const raw = await this.request("tools/call", { name, arguments: arguments_ }, opts);
    const result = asToolCallResult(raw);
    if (result === undefined) {
      throw new Error(`${this.transport.label}: tools/call returned a malformed result`);
    }
    return result;
  }

  /** `resources/list`, following nextCursor pagination to exhaustion. */
  async listResources(): Promise<McpResourceDescriptor[]> {
    this.assertUsable();
    const out: McpResourceDescriptor[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (++pages > MAX_LIST_PAGES) throw new Error(`MCP resources/list exceeded ${MAX_LIST_PAGES} pages`);
      const raw = await this.request("resources/list", cursor === undefined ? undefined : { cursor });
      const page = asListResourcesResult(raw);
      if (page === undefined) throw new Error(`${this.transport.label}: resources/list returned a malformed result`);
      out.push(...page.resources);
      if (page.nextCursor === undefined || page.nextCursor === "") break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /** `resources/read` → its `contents` array (text or base64 blob). */
  async readResource(uri: string, opts: McpRequestOptions = {}): Promise<McpResourceContent[]> {
    this.assertUsable();
    const raw = await this.request("resources/read", { uri }, opts);
    const result = asResourceReadResult(raw);
    if (result === undefined) throw new Error(`${this.transport.label}: resources/read returned a malformed result`);
    return result.contents;
  }

  /** `prompts/list`, following nextCursor pagination to exhaustion. */
  async listPrompts(): Promise<McpPromptDescriptor[]> {
    this.assertUsable();
    const out: McpPromptDescriptor[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      if (++pages > MAX_LIST_PAGES) throw new Error(`MCP prompts/list exceeded ${MAX_LIST_PAGES} pages`);
      const raw = await this.request("prompts/list", cursor === undefined ? undefined : { cursor });
      const page = asListPromptsResult(raw);
      if (page === undefined) throw new Error(`${this.transport.label}: prompts/list returned a malformed result`);
      out.push(...page.prompts);
      if (page.nextCursor === undefined || page.nextCursor === "") break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /** `prompts/get` → the rendered prompt (description + messages). */
  async getPrompt(name: string, args?: unknown, opts: McpRequestOptions = {}): Promise<McpPromptGetResult> {
    this.assertUsable();
    const raw = await this.request("prompts/get", { name, ...(args !== undefined && args !== null ? { arguments: args } : {}) }, opts);
    const result = asPromptGetResult(raw);
    if (result === undefined) throw new Error(`${this.transport.label}: prompts/get returned a malformed result`);
    return result;
  }

  /** Best-effort terminate: fails all pending, closes the transport. Idempotent. */
  async close(): Promise<void> {
    this.handleTerminal(new Error("MCP client closed"));
    await this.transport.close();
  }

  // ---- internals ---------------------------------------------------------

  /**
   * request() = reconnect/ensure-connected + session-expiry re-init + retry
   * with backoff for transient failures (network loss, HTTP 5xx/408/429).
   * Logical timeouts and aborts are NOT retried — replaying a timed-out tool
   * call would be unsafe.
   */
  private async request(
    method: string,
    params?: unknown,
    opts: McpRequestOptions = {},
  ): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        await this.ensureConnected();
        try {
          return await this.requestOnce(method, params, opts);
        } catch (err) {
          if (err instanceof McpSessionExpiredError && method !== "initialize" && !this.reinitRetried && !this.dead) {
            this.reinitRetried = true;
            this.transport.resetSession?.();
            try {
              await this.connectInternal();
            } catch (reErr) {
              // Half-reconnected: drop connected so a LATER attempt re-handshakes
              // via ensureConnected instead of hitting the dead session forever.
              this.connected = false;
              const e = new Error(`MCP session expired; re-initialization failed: ${errMsg(reErr)}`, { cause: reErr });
              // The recovery path already failed once — surface it to the caller
              // instead of hammering the dead session through the retry loop.
              (e as { retryable?: boolean }).retryable = false;
              throw e;
            }
            return await this.requestOnce(method, params, opts);
          }
          throw err;
        }
      } catch (err) {
        lastErr = err;
        if (opts.signal?.aborted) throw err instanceof AbortError ? err : new AbortError(errMsg(err));
        if (attempt >= this.retry.maxAttempts || !isRetryableError(err)) throw err;
        try {
          await sleep(this.backoffMs(attempt), opts.signal);
        } catch {
          throw new AbortError(errMsg(err));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Re-establish the session if the transport died or we never connected.
   * Single-flight: parallel callers after a transport loss (N in-flight tool
   * calls all failing into their retry loops) share ONE reopen + handshake —
   * otherwise each would respawn its own child / mint its own session.
   */
  private ensureConnected(): Promise<void> {
    if (this.connected && !this.dead) return Promise.resolve();
    this.connecting ??= (async () => {
      if (this.dead) {
        await this.transport.reopen?.();
        this.dead = false;
      }
      await this.connectInternal();
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private backoffMs(attempt: number): number {
    const exp = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  private requestOnce(method: string, params: unknown | undefined, opts: McpRequestOptions): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closedError());
    const id = ++this.nextId;
    let resolve!: (v: unknown) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: PendingEntry = {
      method,
      resolve,
      reject,
      timer: undefined,
      abortListener: undefined,
      signal: opts.signal,
    };
    const cleanup = (): void => {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (entry.abortListener !== undefined && entry.signal !== undefined) {
        entry.signal.removeEventListener("abort", entry.abortListener);
      }
    };
    /** Settle this request if it is still pending; returns false if someone else did. */
    const drop = (): boolean => this.pending.delete(id);

    const settle = (make: () => Error, reason: string | undefined): void => {
      if (!drop()) return;
      cleanup();
      if (reason !== undefined) this.sendCancelled(id, reason);
      reject(make());
    };

    this.pending.set(id, entry);

    if (opts.signal !== undefined && opts.signal.aborted) {
      // Never sent — reject immediately, no cancellation owed to the server.
      if (drop()) {
        cleanup();
        reject(new AbortError(`MCP ${method} aborted`));
      }
      return promise;
    }

    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    entry.timer = setTimeout(() => {
      settle(() => new TimeoutError(`MCP ${method} timed out after ${timeoutMs}ms`), "timeout");
    }, timeoutMs);

    if (opts.signal !== undefined) {
      const onAbort = (): void => settle(() => new AbortError(`MCP ${method} aborted`), "aborted");
      entry.abortListener = onAbort;
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params !== undefined) msg.params = params;

    void (async () => {
      try {
        await this.transport.send(
          msg,
          opts.signal === undefined ? { timeoutMs } : { signal: opts.signal, timeoutMs },
        );
      } catch (err) {
        if (drop()) {
          cleanup();
          reject(
            opts.signal?.aborted
              ? new AbortError(`MCP ${method} aborted`)
              : err instanceof Error
                ? err
                : new Error(String(err)),
          );
        }
      }
    })();

    return promise;
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (entry === undefined) return; // stale — settled by timeout/abort already
      this.pending.delete(msg.id);
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (entry.abortListener !== undefined && entry.signal !== undefined) {
        entry.signal.removeEventListener("abort", entry.abortListener);
      }
      if ("error" in msg && msg.error !== undefined) entry.reject(new JsonRpcRemoteError(msg.error));
      else entry.resolve(msg.result);
      return;
    }
    if (isRequest(msg)) {
      // ping must be answered promptly; anything else (sampling/elicitation
      // we never advertised) gets method-not-found so the server isn't left hanging.
      const response: JsonRpcMessage =
        msg.method === "ping"
          ? { jsonrpc: "2.0", id: msg.id, result: {} }
          : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
      void this.transport.send(response).catch(() => {});
      return;
    }
    if (isNotification(msg)) {
      // The one notification that matters to us: the server changed its tool
      // set — tell the Tool bridge to re-list + diff.
      if (msg.method === "notifications/tools/list_changed") this.toolsChangedHandler?.();
      // logging/message, resources/list_changed, prompts/list_changed — ignored in v1.
    }
  }

  private sendCancelled(requestId: number | string, reason: string): void {
    const n: JsonRpcNotification = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, reason },
    };
    void this.transport.send(n).catch(() => {});
  }

  /** Terminal: deliberate close() or a reconnect that exhausted retries. */
  private handleTerminal(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.dead = false;
    this.closeError = err;
    this.failPending(err ?? new Error(`${this.transport.label}: transport closed`));
    this.notifyClose(err);
  }

  /** Unexpected transport loss (stdio child exit). If reopenable, mark dead so
   *  the next request reconnects; fail in-flight so their retry loop re-drives.
   *  Non-reopenable transports go terminal immediately. */
  private onTransportClosed(err?: Error): void {
    if (this.closed) return;
    const fail = err ?? new Error(`${this.transport.label}: transport closed`);
    this.connected = false;
    this.closeError = err;
    if (this.transport.reopen) {
      this.dead = true;
      this.failPending(fail);
      return; // close handlers fire only once reconnected or terminal
    }
    this.handleTerminal(fail);
  }

  private failPending(fail: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      if (entry.abortListener !== undefined && entry.signal !== undefined) {
        entry.signal.removeEventListener("abort", entry.abortListener);
      }
      entry.reject(fail);
    }
    this.pending.clear();
  }

  private notifyClose(err?: Error): void {
    for (const h of this.closeHandlers) {
      try {
        h(err);
      } catch {
        /* handler errors are not ours to propagate */
      }
    }
  }

  private assertUsable(): void {
    if (this.closed) throw this.closedError();
    // Never-connected is an error; transport loss (`dead`) is reconnectable.
    if (!this.connected && !this.dead) throw new Error("not connected");
  }

  /** "MCP client closed" plus the close cause (e.g. "server exited (code 3)")
   *  in the message and `cause` — a bare label would hide why the transport died. */
  private closedError(): Error {
    return this.closeError === undefined
      ? new Error("MCP client closed")
      : new Error(`MCP client closed: ${this.closeError.message}`, { cause: this.closeError });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Transient (retryable) vs terminal. Logical failures — timeouts, aborts,
 *  JSON-RPC server rejections (-32602 bad params etc.) — are never retried
 *  (replaying them cannot help, and replaying a timed-out tool call would be
 *  unsafe); HTTP 5xx/408/429, session expiry, and transport/network losses are. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof AbortError) return false;
  if (err instanceof TimeoutError) return false;
  if (err instanceof JsonRpcRemoteError) return false;
  if (err instanceof McpSessionExpiredError) return true;
  if (err instanceof McpUnsupportedProtocolError) return false;
  // Errors that opt out explicitly (e.g. a failed session re-initialization).
  if ((err as { retryable?: unknown }).retryable === false) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status >= 500 || status === 408 || status === 429;
  return true; // transport loss / network error
}

// ---- defensive result parsers (wire data is never trusted) ----------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asInitializeResult(v: unknown): McpInitializeResult | undefined {
  const r = asRecord(v);
  if (r === undefined) return undefined;
  const protocolVersion = optString(r["protocolVersion"]);
  const info = asRecord(r["serverInfo"]);
  const name = info === undefined ? undefined : optString(info["name"]);
  const version = info === undefined ? undefined : optString(info["version"]);
  if (protocolVersion === undefined || name === undefined || version === undefined) return undefined;
  const out: McpInitializeResult = {
    protocolVersion,
    capabilities: asRecord(r["capabilities"]) ?? {},
    serverInfo: { name, version },
  };
  const title = info === undefined ? undefined : optString(info["title"]);
  if (title !== undefined) out.serverInfo.title = title;
  const instructions = optString(r["instructions"]);
  if (instructions !== undefined) out.instructions = instructions;
  return out;
}

function asAnnotations(v: unknown): McpToolAnnotations | undefined {
  const r = asRecord(v);
  if (r === undefined) return undefined;
  const out: McpToolAnnotations = {};
  let any = false;
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
    if (r[key] === true) {
      out[key] = true;
      any = true;
    }
  }
  return any ? out : undefined;
}

export function asToolDescriptor(v: unknown): McpToolDescriptor | undefined {
  const r = asRecord(v);
  if (r === undefined) return undefined;
  const name = optString(r["name"]);
  if (name === undefined || name === "") return undefined;
  const out: McpToolDescriptor = { name, inputSchema: asRecord(r["inputSchema"]) ?? { type: "object" } };
  const title = optString(r["title"]);
  if (title !== undefined) out.title = title;
  const description = optString(r["description"]);
  if (description !== undefined) out.description = description;
  const annotations = asAnnotations(r["annotations"]);
  if (annotations !== undefined) out.annotations = annotations;
  return out;
}

function asListToolsResult(v: unknown): { tools: McpToolDescriptor[]; nextCursor?: string } | undefined {
  const r = asRecord(v);
  if (r === undefined || !Array.isArray(r["tools"])) return undefined;
  const tools: McpToolDescriptor[] = [];
  for (const t of r["tools"]) {
    const d = asToolDescriptor(t);
    if (d !== undefined) tools.push(d);
  }
  const out: { tools: McpToolDescriptor[]; nextCursor?: string } = { tools };
  const nextCursor = optString(r["nextCursor"]);
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  return out;
}

export function asToolCallResult(v: unknown): McpToolCallResult | undefined {
  const r = asRecord(v);
  if (r === undefined || !Array.isArray(r["content"])) return undefined;
  const content: McpToolContentBlock[] = [];
  for (const c of r["content"]) {
    const b = asRecord(c);
    const type = b === undefined ? undefined : optString(b["type"]);
    if (b === undefined || type === undefined) continue;
    if (type !== "text" && type !== "image" && type !== "audio" && type !== "resource") continue;
    const block: McpToolContentBlock = { type };
    const text = optString(b["text"]);
    if (text !== undefined) block.text = text;
    const data = optString(b["data"]);
    if (data !== undefined) block.data = data;
    const mimeType = optString(b["mimeType"]);
    if (mimeType !== undefined) block.mimeType = mimeType;
    const resource = asRecord(b["resource"]);
    const uri = resource === undefined ? undefined : optString(resource["uri"]);
    if (resource !== undefined && uri !== undefined) {
      const res: { uri: string; mimeType?: string; text?: string; blob?: string } = { uri };
      const rmime = optString(resource["mimeType"]);
      if (rmime !== undefined) res.mimeType = rmime;
      const rtext = optString(resource["text"]);
      if (rtext !== undefined) res.text = rtext;
      const rblob = optString(resource["blob"]);
      if (rblob !== undefined) res.blob = rblob;
      block.resource = res;
    }
    content.push(block);
  }
  const out: McpToolCallResult = { content };
  const structured = asRecord(r["structuredContent"]);
  if (structured !== undefined) out.structuredContent = structured;
  if (r["isError"] === true) out.isError = true;
  return out;
}

function asListResourcesResult(v: unknown): { resources: McpResourceDescriptor[]; nextCursor?: string } | undefined {
  const r = asRecord(v);
  if (r === undefined || !Array.isArray(r["resources"])) return undefined;
  const resources: McpResourceDescriptor[] = [];
  for (const item of r["resources"]) {
    const d = asRecord(item);
    if (d === undefined) continue;
    const uri = optString(d["uri"]);
    const name = optString(d["name"]);
    if (uri === undefined || name === undefined) continue;
    const out: McpResourceDescriptor = { uri, name };
    const description = optString(d["description"]);
    if (description !== undefined) out.description = description;
    const mimeType = optString(d["mimeType"]);
    if (mimeType !== undefined) out.mimeType = mimeType;
    resources.push(out);
  }
  const out: { resources: McpResourceDescriptor[]; nextCursor?: string } = { resources };
  const nextCursor = optString(r["nextCursor"]);
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  return out;
}

function asResourceReadResult(v: unknown): { contents: McpResourceContent[] } | undefined {
  const r = asRecord(v);
  if (r === undefined || !Array.isArray(r["contents"])) return undefined;
  const contents: McpResourceContent[] = [];
  for (const item of r["contents"]) {
    const c = asRecord(item);
    if (c === undefined) continue;
    const uri = optString(c["uri"]);
    if (uri === undefined) continue;
    const out: McpResourceContent = { uri };
    const mimeType = optString(c["mimeType"]);
    if (mimeType !== undefined) out.mimeType = mimeType;
    const text = optString(c["text"]);
    if (text !== undefined) out.text = text;
    const blob = optString(c["blob"]);
    if (blob !== undefined) out.blob = blob;
    contents.push(out);
  }
  return { contents };
}

function asListPromptsResult(v: unknown): { prompts: McpPromptDescriptor[]; nextCursor?: string } | undefined {
  const r = asRecord(v);
  if (r === undefined || !Array.isArray(r["prompts"])) return undefined;
  const prompts: McpPromptDescriptor[] = [];
  for (const item of r["prompts"]) {
    const p = asRecord(item);
    if (p === undefined) continue;
    const name = optString(p["name"]);
    if (name === undefined) continue;
    const out: McpPromptDescriptor = { name };
    const description = optString(p["description"]);
    if (description !== undefined) out.description = description;
    if (Array.isArray(p["arguments"])) {
      const args: McpPromptArgument[] = [];
      for (const a of p["arguments"]) {
        const ar = asRecord(a);
        if (ar === undefined) continue;
        const aname = optString(ar["name"]);
        if (aname === undefined) continue;
        const arg: McpPromptArgument = { name: aname };
        const adesc = optString(ar["description"]);
        if (adesc !== undefined) arg.description = adesc;
        if (ar["required"] === true) arg.required = true;
        args.push(arg);
      }
      out.arguments = args;
    }
    prompts.push(out);
  }
  const result: { prompts: McpPromptDescriptor[]; nextCursor?: string } = { prompts };
  const nextCursor = optString(r["nextCursor"]);
  if (nextCursor !== undefined) result.nextCursor = nextCursor;
  return result;
}

function asPromptGetResult(v: unknown): McpPromptGetResult | undefined {
  const r = asRecord(v);
  if (r === undefined || !Array.isArray(r["messages"])) return undefined;
  const messages: McpPromptMessage[] = [];
  for (const item of r["messages"]) {
    const m = asRecord(item);
    if (m === undefined) continue;
    const role = optString(m["role"]);
    if (role !== "user" && role !== "assistant") continue;
    const c = asRecord(m["content"]);
    if (c === undefined) continue;
    const type = optString(c["type"]);
    if (type !== "text" && type !== "image") continue;
    const content: { type: "text" | "image"; text?: string; data?: string; mimeType?: string } = { type };
    const text = optString(c["text"]);
    if (text !== undefined) content.text = text;
    const data = optString(c["data"]);
    if (data !== undefined) content.data = data;
    const mimeType = optString(c["mimeType"]);
    if (mimeType !== undefined) content.mimeType = mimeType;
    messages.push({ role, content });
  }
  const out: McpPromptGetResult = { messages };
  const description = optString(r["description"]);
  if (description !== undefined) out.description = description;
  return out;
}

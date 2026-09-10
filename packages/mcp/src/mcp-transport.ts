// Internal seam between the JSON-RPC client and byte transports: streamable
// HTTP (this package), stdio (`./node`), and test fakes. Not part of the wire
// protocol — just the message-channel contract both sides code against.

import type { JsonRpcMessage } from "./json-rpc.js";

/**
 * Thrown by the HTTP transport on a 404 that carried our Mcp-Session-Id —
 * the server expired our session. McpClient reacts by re-initializing once.
 */
export class McpSessionExpiredError extends Error {
  override readonly name = "McpSessionExpiredError";
}

export interface McpTransportSendOptions {
  /**
   * Aborts an in-flight HTTP POST (closing the response stream is the
   * spec-sanctioned cancellation on Streamable HTTP). stdio ignores it —
   * cancellation there is `notifications/cancelled`, driven by McpClient.
   */
  signal?: AbortSignal;
  /**
   * The caller's budget for this request (McpClient's per-request timeout).
   * HTTP raises its POST safety cap to at least this when it exceeds the
   * default floor, so a configured timeout is never silently cut short;
   * stdio ignores it (cancellation is notifications/cancelled).
   */
  timeoutMs?: number;
}

export interface McpTransport {
  /** Human label for error messages ("stdio node ./server.js", "http https://…/mcp"). */
  readonly label: string;
  /**
   * Write one message (client request/notification, or a response to a
   * server-initiated request like ping). Resolves once the write is accepted
   * — stdio: queued to stdin; http: POST completed and its body routed to the
   * onMessage listener.
   */
  send(msg: JsonRpcMessage, opts?: McpTransportSendOptions): Promise<void>;
  /** All server→client messages. Registered exactly once (by McpClient). */
  onMessage(listener: (msg: JsonRpcMessage) => void): void;
  /** Fatal transport loss (child exit, stream error) — all pending requests fail. */
  onClose(listener: (err?: Error) => void): void;
  /** Best-effort terminate. Idempotent. */
  close(): Promise<void>;
  /** HTTP only: record the negotiated version → MCP-Protocol-Version header on subsequent POSTs. */
  setProtocolVersion?(version: string): void;
  /** HTTP only: forget Mcp-Session-Id so the next initialize mints a fresh session. */
  resetSession?(): void;
  /**
   * Re-establish the transport after an unexpected loss so McpClient can
   * reconnect + re-handshake: stdio respawns the child; HTTP resets the session
   * id and clears its closed flag (HTTP has no push close — recovery is just
   * per-request retry, so its reopen is a near no-op). Absent (test fakes) means
   * the transport is not reconnectable and the client fails its retries.
   */
  reopen?(): Promise<void>;
}

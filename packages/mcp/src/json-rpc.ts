// JSON-RPC 2.0 message types + duck-typed parsing for the MCP client.
//
// Strict enough for the protocol, forgiving of wire noise: parseJsonRpcMessage
// returns undefined for anything that is not a recognizable JSON-RPC message
// (blank lines, banner text on stdout, malformed JSON) instead of throwing —
// a noisy server must not take down the message pump.

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * A response carries EITHER result OR error (JSON-RPC 2.0 §5.1) — modeled as a
 * discriminated union so call sites must narrow before reading either field.
 */
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
  error?: undefined;
} | {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: undefined;
  error: JsonRpcErrorObject;
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "id" in msg && "method" in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return !("id" in msg) && "method" in msg;
}

function isErrorObject(v: unknown): v is JsonRpcErrorObject {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e["code"] === "number" && typeof e["message"] === "string";
}

/**
 * Parse one JSON-RPC message from a line/payload string. Returns undefined for
 * anything unrecognizable — never throws. `id` must be number or string (the
 * null-id error form is not used by MCP tool traffic and is treated as noise).
 */
export function parseJsonRpcMessage(text: string): JsonRpcMessage | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const m = value as Record<string, unknown>;
  if (m["jsonrpc"] !== "2.0") return undefined;

  const rawId = m["id"];
  const hasId = typeof rawId === "number" || typeof rawId === "string";
  const method = typeof m["method"] === "string" ? m["method"] : undefined;

  // Request: id + method, no result/error.
  if (hasId && method !== undefined && !("result" in m) && !("error" in m)) {
    const req: JsonRpcRequest = { jsonrpc: "2.0", id: rawId, method };
    const params = m["params"];
    if (params !== undefined) req.params = params;
    return req;
  }
  // Response: id + (result | error), no method.
  if (hasId && method === undefined) {
    if ("result" in m) return { jsonrpc: "2.0", id: rawId, result: m["result"] };
    if (isErrorObject(m["error"])) return { jsonrpc: "2.0", id: rawId, error: m["error"] };
  }
  // Notification: method only, no id.
  if (!hasId && method !== undefined) {
    const n: JsonRpcNotification = { jsonrpc: "2.0", method };
    const params = m["params"];
    if (params !== undefined) n.params = params;
    return n;
  }
  return undefined;
}

/** Error raised when a server answers a request with a JSON-RPC error object. */
export class JsonRpcRemoteError extends Error {
  override readonly name = "McpJsonRpcError";
  readonly code: number;
  readonly data: unknown | undefined;

  constructor(error: JsonRpcErrorObject) {
    super(`JSON-RPC error ${error.code}: ${error.message}`);
    this.code = error.code;
    if (error.data !== undefined) this.data = error.data;
  }
}

// parseJsonRpcMessage duck-typing + guards + JsonRpcRemoteError.

import { describe, expect, it } from "vitest";
import {
  isNotification,
  isRequest,
  isResponse,
  JsonRpcRemoteError,
  parseJsonRpcMessage,
} from "../src/json-rpc.js";

describe("parseJsonRpcMessage", () => {
  it("parses a request with number id and params", () => {
    const msg = parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"cursor":"x"}}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "x" } });
    expect(isRequest(msg!)).toBe(true);
  });

  it("parses a request with string id and without params", () => {
    const msg = parseJsonRpcMessage('{"jsonrpc":"2.0","id":"abc","method":"ping"}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: "abc", method: "ping" });
    expect(isRequest(msg!)).toBe(true);
  });

  it("parses a notification", () => {
    const msg = parseJsonRpcMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(msg).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(isNotification(msg!)).toBe(true);
    expect(isRequest(msg!)).toBe(false);
    expect(isResponse(msg!)).toBe(false);
  });

  it("parses a response with result (null result included)", () => {
    const msg = parseJsonRpcMessage('{"jsonrpc":"2.0","id":2,"result":null}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 2, result: null });
    expect(isResponse(msg!)).toBe(true);
  });

  it("parses a response with error carrying data", () => {
    const msg = parseJsonRpcMessage(
      '{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"method not found","data":{"m":"x"}}}',
    );
    expect(msg).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "method not found", data: { m: "x" } },
    });
    expect(isResponse(msg!)).toBe(true);
  });

  it("returns undefined for blank / non-JSON / non-object / wrong version / null id", () => {
    expect(parseJsonRpcMessage("")).toBeUndefined();
    expect(parseJsonRpcMessage("   \t ")).toBeUndefined();
    expect(parseJsonRpcMessage("not json at all")).toBeUndefined();
    expect(parseJsonRpcMessage('"a string"')).toBeUndefined();
    expect(parseJsonRpcMessage("42")).toBeUndefined();
    expect(parseJsonRpcMessage('{"jsonrpc":"1.0","id":1,"method":"x"}')).toBeUndefined();
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":null,"error":{"code":1,"message":"m"}}')).toBeUndefined();
  });

  it("returns undefined for shape mixes (id+method+result, id only, method+id types)", () => {
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"method":"x","result":{}}')).toBeUndefined();
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":1}')).toBeUndefined();
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","method":42}')).toBeUndefined();
    // error object malformed → not a response, and has method-less id → noise
    expect(parseJsonRpcMessage('{"jsonrpc":"2.0","id":1,"error":"oops"}')).toBeUndefined();
  });
});

describe("JsonRpcRemoteError", () => {
  it("carries code and data, formats the message", () => {
    const err = new JsonRpcRemoteError({ code: -32022, message: "Unsupported protocol version", data: [1] });
    expect(err.name).toBe("McpJsonRpcError");
    expect(err.message).toBe("JSON-RPC error -32022: Unsupported protocol version");
    expect(err.code).toBe(-32022);
    expect(err.data).toEqual([1]);
  });

  it("omits data when absent", () => {
    const err = new JsonRpcRemoteError({ code: -1, message: "x" });
    expect("data" in err && err.data !== undefined).toBe(false);
  });
});

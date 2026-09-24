// createMcpServer — the server-side contract: initialize/ping/tools/list/tools/call
// + notifications/cancelled, protocol errors vs isError tool failures, dynamic
// registration. Uses an in-memory channel fake (the stdio channel's shape).

import { describe, expect, test } from "vitest";
import type { Tool } from "@lingjing-agent/core";
import { createMcpServer, type McpServerChannel } from "../src/server.js";
import type { JsonRpcMessage } from "../src/json-rpc.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeChannel extends McpServerChannel {
  /** Every message handed to send(), in order. */
  readonly sent: JsonRpcMessage[];
  /** Inject a client→server message through the registered listener. */
  emit(msg: JsonRpcMessage): void;
  /** Simulate fatal channel loss. */
  fail(): void;
  readonly closed: boolean;
}

function fakeChannel(): FakeChannel {
  const sent: JsonRpcMessage[] = [];
  let msgListener: ((msg: JsonRpcMessage) => void) | undefined;
  let closeListener: ((err?: Error) => void) | undefined;
  let closed = false;
  return {
    label: "test channel",
    sent,
    send(msg) {
      sent.push(msg);
      return Promise.resolve();
    },
    onMessage(l) {
      msgListener = l;
    },
    onClose(l) {
      closeListener = l;
    },
    emit(msg) {
      msgListener?.(msg);
    },
    fail() {
      closed = true;
      closeListener?.(new Error("channel lost"));
    },
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      return Promise.resolve();
    },
  };
}

function request(id: number | string, method: string, params?: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) };
}

/** The response sent for a request id. */
function responseFor(sent: JsonRpcMessage[], id: number | string): JsonRpcMessage | undefined {
  return sent.find((m) => "id" in m && m.id === id && !("method" in m));
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

function echoTool(): Tool {
  return {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    async execute(input) {
      return { content: String((input as { text?: unknown }).text ?? "") };
    },
  };
}

function addTool(): Tool {
  return {
    name: "add",
    description: "Add two numbers.",
    inputSchema: { jsonSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
    async execute(input) {
      const { a, b } = input as { a: number; b: number };
      return { content: String(a + b) };
    },
  };
}

function failingTool(): Tool {
  return {
    name: "fail",
    description: "Always fails.",
    inputSchema: { jsonSchema: { type: "object" } },
    async execute() {
      throw new Error("boom");
    },
  };
}

function destructiveTool(): Tool {
  return {
    name: "rm",
    description: "Destructive.",
    inputSchema: { jsonSchema: { type: "object" } },
    permissions: { destructive: true },
    async execute() {
      return { content: "destroyed" };
    },
  };
}

// ---------------------------------------------------------------------------
// Handshake + listing
// ---------------------------------------------------------------------------

describe("createMcpServer", () => {
  test("initialize answers a known requested version with the full result shape", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", version: "1.2.3", title: "Agent Tools", instructions: "Use carefully." });
    channel.emit(request(1, "initialize", { protocolVersion: "2025-06-18" }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: Record<string, unknown> };
    expect(res.result.protocolVersion).toBe("2025-06-18");
    expect((res.result.capabilities as Record<string, unknown>).tools).toEqual({ listChanged: false });
    expect(res.result.serverInfo).toEqual({ name: "agent-tools", version: "1.2.3", title: "Agent Tools" });
    expect(res.result.instructions).toBe("Use carefully.");
  });

  test("initialize answers an unsupported ask with the latest known version", async () => {
    const channel = fakeChannel();
    const handle = createMcpServer({ channel, name: "agent-tools" });
    channel.emit(request(1, "initialize", { protocolVersion: "1999-01-01" }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { protocolVersion: string } };
    expect(res.result.protocolVersion).toBe(handle.protocolVersion);
    expect(res.result.protocolVersion).toBe("2025-11-25");
    // version omitted → "0.0.0"
    expect(handle.version).toBe("0.0.0");
  });

  test("ping answers {}", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools" });
    channel.emit(request(7, "ping"));
    await until(() => responseFor(channel.sent, 7) !== undefined);
    const res = responseFor(channel.sent, 7)!;
    expect(res).toMatchObject({ result: {} });
  });

  test("tools/list maps core Tools — schema unwrapped, destructiveHint only when true", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [echoTool(), destructiveTool()] });
    channel.emit(request(1, "tools/list"));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { tools: Array<Record<string, unknown>> } };
    const [echo, rm] = res.result.tools;
    expect(echo!.name).toBe("echo");
    expect(echo!.description).toBe("Echo the text back.");
    expect(echo!.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(echo!.annotations).toBeUndefined(); // read-only hints are not guessed
    expect(rm!.annotations).toEqual({ destructiveHint: true });
  });

  test("registerTool / unregisterTool are reflected by the next tools/list", async () => {
    const channel = fakeChannel();
    const handle = createMcpServer({ channel, name: "agent-tools", tools: [echoTool()] });
    handle.registerTool(addTool());
    channel.emit(request(1, "tools/list"));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    let res = responseFor(channel.sent, 1)! as { result: { tools: Array<{ name: string }> } };
    expect(res.result.tools.map((t) => t.name)).toEqual(["echo", "add"]);
    handle.unregisterTool("echo");
    channel.sent.length = 0;
    channel.emit(request(2, "tools/list"));
    await until(() => responseFor(channel.sent, 2) !== undefined);
    res = responseFor(channel.sent, 2)! as { result: { tools: Array<{ name: string }> } };
    expect(res.result.tools.map((t) => t.name)).toEqual(["add"]);
  });

  // ---------------------------------------------------------------------------
  // tools/call
  // ---------------------------------------------------------------------------

  test("tools/call runs the tool — arguments pass through, text result", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [addTool(), echoTool()] });
    channel.emit(request(1, "tools/call", { name: "add", arguments: { a: 2, b: 3 } }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(res.result.content).toEqual([{ type: "text", text: "5" }]);
    expect(res.result.isError).toBeUndefined();
  });

  test("tools/call with missing arguments passes {} to the tool", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [echoTool()] });
    channel.emit(request(1, "tools/call", { name: "echo" }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { content: Array<{ type: string; text: string }> } };
    expect(res.result.content).toEqual([{ type: "text", text: "" }]);
  });

  test("tools/call with an unknown tool is a -32602 protocol error", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [echoTool()] });
    channel.emit(request(1, "tools/call", { name: "nope", arguments: {} }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)!;
    expect(res).toMatchObject({ error: { code: -32602, message: "Unknown tool: nope" } });
  });

  test("a tool failure is an isError RESULT, not a JSON-RPC error object", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [failingTool()] });
    channel.emit(request(1, "tools/call", { name: "fail", arguments: {} }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as {
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
      error?: { code: number };
    };
    expect(res.error).toBeUndefined();
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0]?.text).toContain("boom");
  });

  test("tools/call maps image content; non-consumable blocks are skipped", async () => {
    const channel = fakeChannel();
    const imageTool: Tool = {
      name: "img",
      description: "Returns text + image + a tool_result block.",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute() {
        return {
          content: [
            { type: "text", text: "caption" },
            { type: "image", mediaType: "image/png", data: "QUJD" },
            { type: "tool_result", toolCallId: "t1", content: "internal" },
          ],
        };
      },
    };
    createMcpServer({ channel, name: "agent-tools", tools: [imageTool] });
    channel.emit(request(1, "tools/call", { name: "img", arguments: {} }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { content: Array<Record<string, unknown>> } };
    expect(res.result.content).toEqual([
      { type: "text", text: "caption" },
      { type: "image", data: "QUJD", mimeType: "image/png" },
    ]);
  });

  test("maxResultChars truncates an oversized text result", async () => {
    const channel = fakeChannel();
    const big = "x".repeat(500);
    const bigTool: Tool = {
      name: "big",
      description: "Returns a huge string.",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute() {
        return { content: big };
      },
    };
    createMcpServer({ channel, name: "agent-tools", tools: [bigTool], maxResultChars: 100 });
    channel.emit(request(1, "tools/call", { name: "big", arguments: {} }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { content: Array<{ type: string; text: string }> } };
    const text = res.result.content[0]!.text;
    expect(text.startsWith("x".repeat(100))).toBe(true);
    expect(text).toContain("[truncated at 100 chars]");
  });

  test("toolTimeoutMs aborts a slow tool into an isError result", async () => {
    const channel = fakeChannel();
    const slow: Tool = {
      name: "slow",
      description: "Never finishes in time.",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute(input, ctx) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 10_000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted by signal"));
          });
        });
        return { content: "done" };
      },
    };
    createMcpServer({ channel, name: "agent-tools", tools: [slow], toolTimeoutMs: 20 });
    channel.emit(request(1, "tools/call", { name: "slow", arguments: {} }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]?.text).toContain("timed out after 20ms");
  });

  // ---------------------------------------------------------------------------
  // Notifications + unknown methods
  // ---------------------------------------------------------------------------

  test("notifications/initialized and unknown notifications get no response", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools" });
    channel.emit({ jsonrpc: "2.0", method: "notifications/initialized" });
    channel.emit({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.sent).toEqual([]);
  });

  test("notifications/cancelled aborts an in-flight call into a (cancelled) result", async () => {
    const channel = fakeChannel();
    const slow: Tool = {
      name: "slow",
      description: "Cancellable.",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute(input, ctx) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 10_000);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted by signal"));
          });
        });
        return { content: "done" };
      },
    };
    createMcpServer({ channel, name: "agent-tools", tools: [slow], toolTimeoutMs: 60_000 });
    channel.emit(request("req-1", "tools/call", { name: "slow", arguments: {} }));
    await until(() => true); // let it start
    channel.emit({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "req-1" } });
    await until(() => responseFor(channel.sent, "req-1") !== undefined);
    const res = responseFor(channel.sent, "req-1")!;
    expect(res).toMatchObject({
      result: { content: [{ type: "text", text: "(cancelled)" }], isError: true },
    });
  });

  test("an unknown requested method is -32601", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [echoTool()] });
    channel.emit(request(1, "resources/list"));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    expect(responseFor(channel.sent, 1)!).toMatchObject({ error: { code: -32601, message: "Method not found: resources/list" } });
  });

  test("channel loss aborts in-flight calls", async () => {
    const channel = fakeChannel();
    let aborted = false;
    const slow: Tool = {
      name: "slow",
      description: "Notices the abort.",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute(input, ctx) {
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
        return { content: "done" };
      },
    };
    createMcpServer({ channel, name: "agent-tools", tools: [slow], toolTimeoutMs: 60_000 });
    channel.emit(request(1, "tools/call", { name: "slow", arguments: {} }));
    await until(() => true); // let it start
    channel.fail();
    await until(() => aborted);
    expect(aborted).toBe(true);
  });

  test("stdin noise on the channel is skipped, never kills the pump", async () => {
    const channel = fakeChannel();
    createMcpServer({ channel, name: "agent-tools", tools: [echoTool()] });
    channel.emit({ jsonrpc: "2.0" } as unknown as JsonRpcMessage); // not a recognizable message
    channel.emit("banner text" as unknown as JsonRpcMessage);
    channel.emit(request(1, "tools/call", { name: "echo", arguments: { text: "hi" } }));
    await until(() => responseFor(channel.sent, 1) !== undefined);
    const res = responseFor(channel.sent, 1)! as { result: { content: Array<{ type: string; text: string }> } };
    expect(res.result.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

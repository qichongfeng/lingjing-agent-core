// McpClient over the fake transport: handshake wire shape + negotiation,
// initialized ordering, ping handling, pagination, correlation, timeouts,
// abort + cancelled notifications, session re-init, transport close.

import { describe, expect, it } from "vitest";
import { AbortError, TimeoutError } from "@lingjing-agent/core";
import {
  KNOWN_PROTOCOL_VERSIONS,
  McpClient,
  McpUnsupportedProtocolError,
  negotiateProtocolVersion,
  REQUESTED_PROTOCOL_VERSION,
} from "../src/client.js";
import { McpSessionExpiredError } from "../src/mcp-transport.js";
import { isRequest, type JsonRpcNotification, type JsonRpcRequest } from "../src/json-rpc.js";
import { fakeMcpTransport, type FakeMcpTransport } from "./helpers.js";

function okResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    serverInfo: { name: "fixture", version: "1.0" },
    ...extra,
  };
}

/** Script the fake to answer every request with a result built from its method/id. */
function respond(t: FakeMcpTransport, make: (req: JsonRpcRequest) => unknown): void {
  t.onSend = (msg) => {
    if (isRequest(msg)) t.emit({ jsonrpc: "2.0", id: msg.id, result: make(msg) });
  };
}

/** initialize → okResult; every other request → a plain text tool result. */
function scriptOk(t: FakeMcpTransport, extra: Record<string, unknown> = {}): void {
  respond(t, (req) =>
    req.method === "initialize"
      ? okResult(extra)
      : { content: [{ type: "text", text: "ok" }] },
  );
}

function lastRequest(t: FakeMcpTransport): JsonRpcRequest {
  const reqs = t.sent.filter(isRequest);
  const last = reqs[reqs.length - 1];
  if (last === undefined) throw new Error("no request sent");
  return last;
}

function sentNotifications(t: FakeMcpTransport, method: string): JsonRpcNotification[] {
  return t.sent.filter((m): m is JsonRpcNotification => !("id" in m) && m.method === method);
}

async function connectedClient(t: FakeMcpTransport, extra: Record<string, unknown> = {}): Promise<McpClient> {
  scriptOk(t, extra);
  const c = new McpClient({ transport: t });
  await c.connect();
  t.sent.length = 0; // drop handshake traffic; tests assert from a clean slate
  return c;
}

/** requestOnce dispatches its transport.send from a microtask (after
 *  ensureConnected awaits) — asserting on sent traffic needs one macrotask. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("connect handshake", () => {
  it("sends initialize with requested version, empty capabilities, clientInfo; then initialized", async () => {
    const t = fakeMcpTransport();
    scriptOk(t);
    const c = new McpClient({ transport: t, clientInfo: { name: "app", version: "2.0" } });
    const result = await c.connect();

    expect(t.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: REQUESTED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "app", version: "2.0" },
      },
    });
    // initialized notification strictly after the initialize response.
    expect(t.sent[1]).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(c.protocolVersion).toBe("2025-06-18");
    expect(c.serverInfo).toEqual({ name: "fixture", version: "1.0" });
    expect(result.serverInfo.name).toBe("fixture");
    // negotiated version pushed into the transport (HTTP header hook)
    expect(t.protocolVersionCalls).toEqual(["2025-06-18"]);
  });

  it("negotiation accepts any known legacy version echoed by the server", async () => {
    for (const v of KNOWN_PROTOCOL_VERSIONS) {
      const t = fakeMcpTransport();
      scriptOk(t, { protocolVersion: v });
      const c = new McpClient({ transport: t });
      await c.connect();
      expect(c.protocolVersion).toBe(v);
      await c.close();
    }
  });

  it("unknown (modern-era) version → McpUnsupportedProtocolError, transport closed", async () => {
    const t = fakeMcpTransport();
    scriptOk(t, { protocolVersion: "2026-07-28" });
    const c = new McpClient({ transport: t });
    await expect(c.connect()).rejects.toBeInstanceOf(McpUnsupportedProtocolError);
    await expect(c.connect()).rejects.toThrow(/closed/); // client died with the transport
    expect(t.closed).toBe(true);
    expect(() => negotiateProtocolVersion("2025-11-25", "2026-07-28")).toThrow(/modern-era/);
  });

  it("initialize rejected with plain error → wrapped with modern-era hint, transport closed", async () => {
    const t = fakeMcpTransport();
    t.onSend = () => {
      throw new Error("HTTP 400 Bad Request");
    };
    const c = new McpClient({ transport: t });
    await expect(c.connect()).rejects.toThrow(/modern \(2026-07-28\+\) MCP era/);
    expect(t.closed).toBe(true);
  });

  it("malformed initialize result → clear error, transport closed", async () => {
    const t = fakeMcpTransport();
    respond(t, () => ({ nonsense: true }));
    const c = new McpClient({ transport: t });
    await expect(c.connect()).rejects.toThrow(/malformed result/);
    expect(t.closed).toBe(true);
  });
});

describe("server→client traffic", () => {
  it("answers ping immediately with an empty result", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    t.emit({ jsonrpc: "2.0", id: 900, method: "ping" });
    expect(t.sent).toContainEqual({ jsonrpc: "2.0", id: 900, result: {} });
    await c.close();
  });

  it("refuses unexpected server requests with -32601, ignores notifications", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    t.emit({ jsonrpc: "2.0", id: 901, method: "sampling/createMessage" });
    expect(t.sent).toContainEqual({
      jsonrpc: "2.0",
      id: 901,
      error: { code: -32601, message: "Method not found: sampling/createMessage" },
    });
    t.sent.length = 0;
    t.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(t.sent).toEqual([]);
    await c.close();
  });
});

describe("listTools", () => {
  it("passes through descriptors and follows nextCursor pagination", async () => {
    const t = fakeMcpTransport();
    const pages = new Map<string | undefined, Record<string, unknown>>([
      [undefined, { tools: [{ name: "a", inputSchema: { type: "object" } }], nextCursor: "p2" }],
      ["p2", { tools: [{ name: "b", inputSchema: { type: "object" } }, { title: "T", name: "c" }], nextCursor: "" }],
    ]);
    respond(t, (req) => {
      if (req.method === "initialize") return okResult();
      const cursor = (req.params as { cursor?: string } | undefined)?.cursor;
      return pages.get(cursor) ?? {};
    });
    const c = new McpClient({ transport: t });
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((d) => d.name)).toEqual(["a", "b", "c"]);
    expect(tools[2]?.title).toBe("T");
    // First page omitted cursor; second carried it.
    const listReqs = t.sent.filter((m): m is JsonRpcRequest => isRequest(m) && m.method === "tools/list");
    expect(listReqs[0]?.params).toBeUndefined();
    expect(listReqs[1]?.params).toEqual({ cursor: "p2" });
    await c.close();
  });

  it("guards against a misbehaving nextCursor loop (100 pages)", async () => {
    const t = fakeMcpTransport();
    respond(t, (req) => (req.method === "initialize" ? okResult() : { tools: [], nextCursor: "forever" }));
    const c = new McpClient({ transport: t, requestTimeoutMs: 200 });
    await c.connect();
    await expect(c.listTools()).rejects.toThrow(/100 pages/);
    await c.close();
  });

  it("throws before connect", async () => {
    const t = fakeMcpTransport();
    const c = new McpClient({ transport: t });
    await expect(c.listTools()).rejects.toThrow(/not connected/);
  });
});

describe("callTool", () => {
  it("sends {name, arguments} and resolves isError results without throwing", async () => {
    const t = fakeMcpTransport();
    respond(t, (req) =>
      req.method === "initialize"
        ? okResult()
        : { content: [{ type: "text", text: "boom" }], isError: true },
    );
    const c = new McpClient({ transport: t });
    await c.connect();
    t.sent.length = 0;
    const res = await c.callTool("explode", { a: 1 });
    expect(lastRequest(t).params).toEqual({ name: "explode", arguments: { a: 1 } });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "boom" }]);
    await c.close();
  });

  it("rejects with JsonRpcRemoteError on a JSON-RPC error response", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    t.sent.length = 0;
    t.onSend = (msg) => {
      if (isRequest(msg)) t.emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } });
    };
    await expect(c.callTool("x", {})).rejects.toThrow(/JSON-RPC error -32000/);
    await c.close();
  });

  it("rejects oversized serialized arguments up front", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    const big = "x".repeat(4 * 1024 * 1024 + 100);
    await expect(c.callTool("upload", { blob: big })).rejects.toThrow(/arguments exceed/);
    await c.close();
  });
});

describe("timeouts, abort, concurrency", () => {
  it("per-request timeout → TimeoutError + cancelled carries the request id", async () => {
    const t = fakeMcpTransport();
    const c = new McpClient({ transport: t, requestTimeoutMs: 30 });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;
    t.onSend = () => {}; // never answer
    await expect(c.callTool("slow", {})).rejects.toBeInstanceOf(TimeoutError);
    const call = t.sent.find((m) => isRequest(m) && m.method === "tools/call") as JsonRpcRequest;
    const cancelled = sentNotifications(t, "notifications/cancelled")[0];
    expect(cancelled?.params).toEqual({ requestId: call.id, reason: "timeout" });
    await c.close();
  });

  it("caller signal abort → AbortError + cancelled notification", async () => {
    const t = fakeMcpTransport();
    const c = new McpClient({ transport: t, requestTimeoutMs: 5_000 });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;
    t.onSend = () => {}; // hang BEFORE issuing the call
    const ac = new AbortController();
    const pending = c.callTool("slow", {}, { signal: ac.signal });
    await tick(); // let the request go out — aborting pre-send owes no notification
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    const cancelled = sentNotifications(t, "notifications/cancelled")[0];
    expect(cancelled?.params).toEqual(expect.objectContaining({ reason: "aborted" }));
    await c.close();
  });

  it("already-aborted signal rejects without sending anything", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    t.sent.length = 0;
    const ac = new AbortController();
    ac.abort();
    await expect(c.callTool("x", {}, { signal: ac.signal })).rejects.toBeInstanceOf(AbortError);
    expect(t.sent).toEqual([]);
    await c.close();
  });

  it("resolves concurrent requests matched by id, out of order", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    t.sent.length = 0;
    const reqs: JsonRpcRequest[] = [];
    t.onSend = (msg) => {
      if (isRequest(msg)) reqs.push(msg);
    };
    const p1 = c.callTool("one", {});
    const p2 = c.callTool("two", {});
    const p3 = c.callTool("three", {});
    await tick(); // sends dispatch from microtasks
    expect(reqs).toHaveLength(3);
    // Answer in reverse order.
    t.emit({ jsonrpc: "2.0", id: reqs[2]!.id, result: { content: [{ type: "text", text: "3" }] } });
    t.emit({ jsonrpc: "2.0", id: reqs[0]!.id, result: { content: [{ type: "text", text: "1" }] } });
    t.emit({ jsonrpc: "2.0", id: reqs[1]!.id, result: { content: [{ type: "text", text: "2" }] } });
    expect((await p3).content[0]?.text).toBe("3");
    expect((await p1).content[0]?.text).toBe("1");
    expect((await p2).content[0]?.text).toBe("2");
    await c.close();
  });

  it("transport loss fails all pending with the exit error and fires onClose", async () => {
    const t = fakeMcpTransport();
    const c = new McpClient({ transport: t });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;
    t.onSend = () => {};
    const pending = c.callTool("slow", {});
    let closedWith: Error | undefined;
    c.onClose((err) => {
      closedWith = err;
    });
    t.fail(new Error("child exited (code 1)"));
    await expect(pending).rejects.toThrow(/child exited/);
    expect(closedWith?.message).toBe("child exited (code 1)");
    expect(c.isClosed).toBe(true);
    await expect(c.callTool("x", {})).rejects.toThrow(/closed/);
  });
});

describe("session re-initialization (one shot per generation)", () => {
  it("404-style expiry → resetSession, re-handshake, retry succeeds transparently", async () => {
    const t = fakeMcpTransport();
    let toolsListAttempts = 0;
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: okResult() });
      } else if (msg.method === "tools/list") {
        toolsListAttempts += 1;
        if (toolsListAttempts === 1) throw new McpSessionExpiredError("session gone");
        t.emit({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "only", inputSchema: { type: "object" } }] },
        });
      }
    };
    const c = new McpClient({ transport: t });
    await c.connect();
    t.sent.length = 0;
    const tools = await c.listTools();
    expect(tools.map((d) => d.name)).toEqual(["only"]);
    expect(toolsListAttempts).toBe(2);
    expect(t.resetSessionCalls).toBe(1);
    // The retry generation: failed tools/list → re-initialize → tools/list.
    expect(t.sent.filter(isRequest).map((m) => m.method)).toEqual(["tools/list", "initialize", "tools/list"]);
    expect(sentNotifications(t, "notifications/initialized")).toHaveLength(1);
    await c.close();
  });

  it("a second expiry in the next generation retries again (flag resets per connect)", async () => {
    const t = fakeMcpTransport();
    let attempts = 0;
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: okResult() });
      } else if (msg.method === "tools/list") {
        attempts += 1;
        if (attempts % 2 === 1) throw new McpSessionExpiredError("expired");
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
      }
    };
    const c = new McpClient({ transport: t });
    await c.connect();
    await c.listTools(); // attempt 1 expired → re-init → attempt 2 ok
    await c.listTools(); // attempt 3 expired → re-init → attempt 4 ok
    expect(attempts).toBe(4);
    await c.close();
  });

  it("expiry during re-handshake surfaces as 're-initialization failed'", async () => {
    const t = fakeMcpTransport();
    let phase = 0;
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") {
        if (phase === 0) t.emit({ jsonrpc: "2.0", id: msg.id, result: okResult() });
        else throw new Error("HTTP 500"); // the re-handshake blows up
      } else if (msg.method === "tools/list") {
        phase += 1;
        throw new McpSessionExpiredError("expired");
      }
    };
    const c = new McpClient({ transport: t });
    await c.connect();
    await expect(c.listTools()).rejects.toThrow(/re-initialization failed/);
    await c.close();
  });
});

describe("retry (transient failures)", () => {
  const tiny = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

  it("retries a transient network error and succeeds on the second attempt", async () => {
    const t = fakeMcpTransport();
    let calls = 0;
    const c = new McpClient({ transport: t, retry: tiny });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "tools/call") {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
      }
    };
    const res = await c.callTool("x", {});
    expect(res.content[0]?.text).toBe("ok");
    expect(calls).toBe(2);
    await c.close();
  });

  it("does NOT retry a logical timeout (replay safety)", async () => {
    const t = fakeMcpTransport();
    const c = new McpClient({ transport: t, requestTimeoutMs: 20, retry: tiny });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;
    let calls = 0;
    t.onSend = (msg) => {
      if (isRequest(msg) && msg.method === "tools/call") calls += 1; // never answer
    };
    await expect(c.callTool("slow", {})).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toBe(1); // no replay
    await c.close();
  });

  it("does NOT retry an abort", async () => {
    const t = fakeMcpTransport();
    const c = new McpClient({ transport: t, retry: tiny });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;
    let calls = 0;
    t.onSend = (msg) => {
      if (isRequest(msg) && msg.method === "tools/call") calls += 1;
    };
    const ac = new AbortController();
    const pending = c.callTool("x", {}, { signal: ac.signal });
    await tick(); // the request must be sent before the abort (else nothing replays anyway)
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
    await c.close();
  });
});

describe("reconnect (reopenable transport)", () => {
  it("transport loss marks dead; the next request reopens, re-handshakes, and succeeds", async () => {
    const t = fakeMcpTransport("stdio", true);
    const c = new McpClient({ transport: t, retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    scriptOk(t);
    await c.connect();
    t.sent.length = 0;

    // Simulate the child process exiting mid-session.
    t.fail(new Error("server exited (code 1)"));
    expect(c.isClosed).toBe(false); // not terminal — reconnectable

    // The next request reopens + reconnects transparently.
    const res = await c.callTool("x", {});
    expect(res.content[0]?.text).toBe("ok");
    expect(t.reopenCalls).toBe(1);
    // The handshake ran again before the call.
    const methods = t.sent.filter(isRequest).map((m) => m.method);
    expect(methods).toContain("initialize");
    await c.close();
  });
});

describe("resources and prompts", () => {
  it("listResources + readResource follow pagination and map content", async () => {
    const t = fakeMcpTransport();
    respond(t, (req) => {
      if (req.method === "initialize") return okResult({ capabilities: { resources: {} } });
      if (req.method === "resources/list") {
        const cursor = (req.params as { cursor?: string } | undefined)?.cursor;
        return cursor === undefined
          ? { resources: [{ uri: "file:///a.txt", name: "A", mimeType: "text/plain" }], nextCursor: "p2" }
          : { resources: [{ uri: "file:///b.txt", name: "B" }] };
      }
      if (req.method === "resources/read") {
        return { contents: [{ uri: "file:///a.txt", text: "hello", mimeType: "text/plain" }] };
      }
      return {};
    });
    const c = new McpClient({ transport: t });
    await c.connect();
    const list = await c.listResources();
    expect(list.map((d) => d.name)).toEqual(["A", "B"]);
    const contents = await c.readResource("file:///a.txt");
    expect(contents).toEqual([{ uri: "file:///a.txt", text: "hello", mimeType: "text/plain" }]);
    await c.close();
  });

  it("listPrompts + getPrompt", async () => {
    const t = fakeMcpTransport();
    respond(t, (req) => {
      if (req.method === "initialize") return okResult({ capabilities: { prompts: {} } });
      if (req.method === "prompts/list") {
        return { prompts: [{ name: "greet", description: "Say hi", arguments: [{ name: "who", required: true }] }] };
      }
      if (req.method === "prompts/get") {
        return { description: "Greeting", messages: [{ role: "user", content: { type: "text", text: "hi" } }] };
      }
      return {};
    });
    const c = new McpClient({ transport: t });
    await c.connect();
    const prompts = await c.listPrompts();
    expect(prompts[0]?.name).toBe("greet");
    expect(prompts[0]?.arguments?.[0]?.required).toBe(true);
    const rendered = await c.getPrompt("greet", { who: "you" });
    expect(rendered.messages[0]?.content.text).toBe("hi");
    await c.close();
  });
});

describe("tools/list_changed notification", () => {
  it("fires the registered handler", async () => {
    const t = fakeMcpTransport();
    const c = await connectedClient(t);
    let fired = 0;
    c.onToolsChanged(() => {
      fired += 1;
    });
    t.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(fired).toBe(1);
    await c.close();
  });
});

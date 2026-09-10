// Streamable HTTP transport over a scripted fake core HttpTransport: headers,
// session id capture/echo, 202/JSON/SSE handling, stop-after-match, 404
// expiry, DELETE-on-close, abort mid-stream, and the client-level re-init loop.

import { describe, expect, it } from "vitest";
import { AbortError, type HttpTransport, type HttpTransportRequest, type HttpTransportResponse } from "@lingjing-agent/core";
import { McpClient } from "../src/client.js";
import { createHttpMcpTransport } from "../src/http-transport.js";
import { McpSessionExpiredError } from "../src/mcp-transport.js";
import type { JsonRpcMessage, JsonRpcNotification } from "../src/json-rpc.js";
import { bodyOf } from "./helpers.js";

const BASE = { status: 200, statusText: "OK", headers: {}, body: bodyOf("") };

/** A fake core HttpTransport playing a fixed sequence of responses (static or per-request). */
type ScriptStep = Partial<HttpTransportResponse> | ((req: HttpTransportRequest) => Partial<HttpTransportResponse>);
function httpScript(steps: ScriptStep[]): {
  t: HttpTransport;
  reqs: HttpTransportRequest[];
} {
  const reqs: HttpTransportRequest[] = [];
  let i = 0;
  const t: HttpTransport = async (req) => {
    reqs.push(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const resp = typeof step === "function" ? step(req) : step;
    return { ...BASE, ...resp };
  };
  return { t, reqs };
}

/** An initialize 200 response echoing the REQUEST's id (ids advance across re-inits). */
function initStep(sessionId?: string): ScriptStep {
  return (req) =>
    jsonResp(
      {
        jsonrpc: "2.0",
        id: JSON.parse(req.body ?? "{}").id ?? 0,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } },
      },
      sessionId === undefined ? {} : { "mcp-session-id": sessionId },
    );
}

function jsonResp(msg: JsonRpcMessage, extraHeaders: Record<string, string> = {}): Partial<HttpTransportResponse> {
  return {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: bodyOf(JSON.stringify(msg), 11),
  };
}

function sseResp(
  events: JsonRpcMessage[],
  extraHeaders: Record<string, string> = {},
  chunkSize = 13,
): Partial<HttpTransportResponse> {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", ...extraHeaders },
    body: bodyOf(text, chunkSize),
  };
}

function initResult(sessionId?: string): Partial<HttpTransportResponse> {
  return jsonResp(
    {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } },
    },
    sessionId === undefined ? {} : { "mcp-session-id": sessionId },
  );
}

const INIT_REQ = { jsonrpc: "2.0", id: 1, method: "initialize" } as JsonRpcMessage;
const CALL_REQ = { jsonrpc: "2.0", id: 2, method: "tools/call" } as JsonRpcMessage;

const NOTIF: JsonRpcNotification = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("request framing", () => {
  it("POSTs JSON with accept + content-type, no session header before one exists", async () => {
    const { t, reqs } = httpScript([initResult()]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t, headers: { authorization: "Bearer x" } });
    await mt.send(INIT_REQ);
    const req = reqs[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://srv/mcp");
    expect(req.headers["accept"]).toBe("application/json, text/event-stream");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["authorization"]).toBe("Bearer x");
    expect("mcp-session-id" in req.headers).toBe(false);
    expect(JSON.parse(req.body!)).toEqual(INIT_REQ);
    await mt.close();
  });

  it("captures Mcp-Session-Id, echoes it, and adds MCP-Protocol-Version after negotiation", async () => {
    const { t, reqs } = httpScript([initResult("s-1"), { status: 202 }, { status: 202 }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await mt.send(INIT_REQ); // captures s-1
    mt.setProtocolVersion?.("2025-06-18");
    await mt.send(NOTIF);
    expect(reqs[1]!.headers["mcp-session-id"]).toBe("s-1");
    expect(reqs[1]!.headers["mcp-protocol-version"]).toBe("2025-06-18");
    mt.resetSession?.();
    await mt.send(NOTIF);
    expect("mcp-session-id" in reqs[2]!.headers).toBe(false);
    await mt.close();
  });
});

describe("response handling", () => {
  it("202 for a notification resolves without dispatching anything", async () => {
    const { t, reqs } = httpScript([{ status: 202, statusText: "Accepted" }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    const got: JsonRpcMessage[] = [];
    mt.onMessage((m) => got.push(m));
    await mt.send(NOTIF);
    expect(got).toEqual([]);
    await mt.close();
  });

  it("200 application/json body is dispatched to the listener", async () => {
    const resp = { jsonrpc: "2.0", id: 7, result: { ok: true } } as JsonRpcMessage;
    const { t } = httpScript([jsonResp(resp)]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    const got: JsonRpcMessage[] = [];
    mt.onMessage((m) => got.push(m));
    await mt.send(CALL_REQ);
    expect(got).toEqual([resp]);
    await mt.close();
  });

  it("200 SSE: stops consuming once the awaited response arrives (finally runs, later events unseen)", async () => {
    const first = { jsonrpc: "2.0", id: 5, result: { content: [] } } as JsonRpcMessage;
    const second = { jsonrpc: "2.0", method: "notifications/message" };
    const text = `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(second)}\n\n`;
    let finallyRan = false;
    let secondDispatched = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      try {
        yield* bodyOf(text, 9);
      } finally {
        finallyRan = true;
      }
    }
    const { t } = httpScript([{ status: 200, headers: { "content-type": "text/event-stream" }, body: body() }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    mt.onMessage((m) => {
      if (!("id" in m) && m.method === "notifications/message") secondDispatched = true;
    });
    await mt.send({ jsonrpc: "2.0", id: 5, method: "tools/call" } as JsonRpcMessage);
    expect(finallyRan).toBe(true);
    expect(secondDispatched).toBe(false);
    await mt.close();
  });

  it("SSE reassembles multi-byte payloads split across tiny chunks", async () => {
    const resp = { jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "灵境🎉" }] } } as JsonRpcMessage;
    const { t } = httpScript([sseResp([resp], {}, 1)]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    const got: JsonRpcMessage[] = [];
    mt.onMessage((m) => got.push(m));
    await mt.send({ jsonrpc: "2.0", id: 9, method: "tools/call" } as JsonRpcMessage);
    expect(got).toEqual([resp]);
    await mt.close();
  });

  it("SSE stream ending without the awaited response throws instead of hanging", async () => {
    const other = { jsonrpc: "2.0", id: 999, result: {} } as JsonRpcMessage;
    const { t } = httpScript([sseResp([other])]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await expect(mt.send(CALL_REQ)).rejects.toThrow(/ended without a response/);
    await mt.close();
  });

  it("non-JSON 200 body → clear error", async () => {
    const { t } = httpScript([{ status: 200, headers: { "content-type": "application/json" }, body: bodyOf("plain text") }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await expect(mt.send(CALL_REQ)).rejects.toThrow(/not a JSON-RPC message/);
    await mt.close();
  });
});

describe("errors", () => {
  it("404 while carrying a session → McpSessionExpiredError", async () => {
    const { t } = httpScript([initResult("s-1"), { status: 404, statusText: "Not Found", body: bodyOf("gone") }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await mt.send(INIT_REQ); // session captured
    await expect(mt.send(CALL_REQ)).rejects.toBeInstanceOf(McpSessionExpiredError);
    await mt.close();
  });

  it("404 without a session is an ordinary error; other 4xx include a body snippet", async () => {
    const { t } = httpScript([
      { status: 404, statusText: "Not Found", body: bodyOf("nope") },
      { status: 400, statusText: "Bad Request", body: bodyOf("this server wants the modern era") },
    ]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await expect(mt.send(CALL_REQ)).rejects.toThrow(/HTTP 404/);
    await expect(mt.send(CALL_REQ)).rejects.toThrow(/modern era/);
    await mt.close();
  });

  it("abort mid-SSE: the in-flight send rejects and body iteration stops", async () => {
    const ac = new AbortController();
    async function* hanging(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("data: ");
      await new Promise<never>((_, reject) => {
        // Mirror real fetch: an already-aborted signal rejects immediately
        // (listeners added after abort never fire).
        if (ac.signal.aborted) {
          reject(new AbortError());
          return;
        }
        const onAbort = () => reject(new AbortError());
        ac.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    const { t } = httpScript([{ status: 200, headers: { "content-type": "text/event-stream" }, body: hanging() }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    const pending = mt.send(CALL_REQ, { signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    await mt.close();
  });
});

describe("close()", () => {
  it("sends a best-effort DELETE with the session header once a session exists", async () => {
    const { t, reqs } = httpScript([initResult("s-9"), { status: 200 }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await mt.send(INIT_REQ);
    await mt.close();
    expect(reqs[1]!.method).toBe("DELETE");
    expect(reqs[1]!.headers["mcp-session-id"]).toBe("s-9");
    expect(reqs[1]!.body).toBeUndefined();
    // Closed transport refuses further sends.
    await expect(mt.send(NOTIF)).rejects.toThrow(/closed/);
  });

  it("no session → close sends nothing", async () => {
    const { t, reqs } = httpScript([]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    await mt.close();
    expect(reqs).toEqual([]);
  });
});

describe("client + http transport end to end", () => {
  it("session expiry mid-call re-initializes transparently (fresh session, no stale header)", async () => {
    const okCall: ScriptStep = (req) =>
      jsonResp({
        jsonrpc: "2.0",
        id: JSON.parse(req.body ?? "{}").id ?? 0,
        result: { content: [{ type: "text", text: "hi" }] },
      });
    const expired = { status: 404, statusText: "Not Found", body: bodyOf("expired") };
    const { t, reqs } = httpScript([
      initStep("s-1"), // initialize
      { status: 202 }, // notifications/initialized
      expired, // tools/call → 404 with session
      initStep("s-2"), // re-initialize (echoes the new request id)
      { status: 202 }, // notifications/initialized (again)
      okCall, // retried tools/call
    ]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    const c = new McpClient({ transport: mt, requestTimeoutMs: 1_000 });
    await c.connect();
    const res = await c.callTool("greet", {});
    expect(res.content[0]?.text).toBe("hi");
    const methods = reqs.map((r) => `${r.method} ${JSON.parse(r.body ?? "{}").method ?? "(none)"}`);
    expect(methods).toEqual(["POST initialize", "POST notifications/initialized", "POST tools/call", "POST initialize", "POST notifications/initialized", "POST tools/call"]);
    expect(reqs[2]!.headers["mcp-session-id"]).toBe("s-1");
    expect("mcp-session-id" in reqs[3]!.headers).toBe(false); // reset before re-init
    expect(reqs[5]!.headers["mcp-session-id"]).toBe("s-2");
    await c.close();
  });

  it("400 non-JSON-RPC body on initialize surfaces the modern-era hint from the client", async () => {
    const { t } = httpScript([{ status: 400, statusText: "Bad Request", body: bodyOf("missing MCP-Protocol-Version") }]);
    const mt = createHttpMcpTransport({ url: "https://srv/mcp", transport: t });
    const c = new McpClient({ transport: mt });
    await expect(c.connect()).rejects.toThrow(/modern \(2026-07-28\+\) MCP era/);
  });
});

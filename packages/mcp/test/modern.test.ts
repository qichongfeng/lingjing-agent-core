// Modern-era (2026-07-28+) client behavior: era probe via server/discover,
// fallback to the legacy handshake on non-modern servers, -32022 version
// retry, modern dressing (_meta + mirrored headers), x-mcp-header extraction
// and mirroring, HeaderMismatch re-list+retry, MRTR detection, era caching,
// and no notifications/cancelled in modern mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpTransport, HttpTransportRequest } from "@lingjing-agent/core";
import { McpClient, McpUnsupportedProtocolError } from "../src/client.js";
import { McpHttpError, createHttpMcpTransport } from "../src/http-transport.js";
import {
  __resetEraCacheForTests,
  encodeHeaderValue,
  extractHeaderAnnotations,
  getCachedEra,
  isInputRequiredResult,
  parseDiscoverResult,
  pickModernVersion,
} from "../src/modern.js";
import { createMcpTools } from "../src/tools.js";
import { bodyOf, fakeMcpTransport } from "./helpers.js";
import type { JsonRpcMessage, JsonRpcRequest } from "../src/json-rpc.js";

/** HTTP-shaped discover 200 result. */
function discoverResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "qianmiao-bill", version: "1.0.0" } },
    instructions: "测试指引",
    ...extra,
  };
}

function httpErr(status: number, rpc: { code: number; message: string; data?: unknown } | undefined, body = ""): McpHttpError {
  // Message mirrors the real transport: body snippet (the JSON-RPC error
  // text) rides along when present.
  const snippet = body !== "" ? body : rpc?.message ?? "";
  return new McpHttpError(status, "Err", `HTTP ${status}${snippet === "" ? "" : ` — ${snippet}`}`, undefined, rpc);
}

describe("modern era unit helpers", () => {
  it("parseDiscoverResult is strict: legacy-shaped results do not pass", () => {
    expect(parseDiscoverResult(discoverResult())).toBeDefined();
    expect(parseDiscoverResult({ protocolVersion: "2025-06-18", serverInfo: { name: "x", version: "1" } })).toBeUndefined();
    expect(parseDiscoverResult({ resultType: "complete", supportedVersions: "2026-07-28" })).toBeUndefined();
    expect(parseDiscoverResult({ resultType: "partial", supportedVersions: ["2026-07-28"] })).toBeUndefined();
  });

  it("pickModernVersion intersects with modern-known and takes the highest", () => {
    expect(pickModernVersion(["2025-11-25", "2026-07-28"])).toBe("2026-07-28");
    expect(pickModernVersion(["2030-01-01"])).toBeUndefined();
    expect(pickModernVersion(undefined)).toBeUndefined();
    expect(pickModernVersion([42, "nope"])).toBeUndefined();
  });

  it("encodeHeaderValue: plain ASCII passes, non-ASCII/controls/trim/sentinel wrap", () => {
    expect(encodeHeaderValue("us-west1")).toBe("us-west1");
    expect(encodeHeaderValue("Hello, 世界")).toMatch(/^=\?base64\?.+\?=$/);
    expect(encodeHeaderValue(" padded ")).toMatch(/^=\?base64\?/);
    expect(encodeHeaderValue("line1\nline2")).toMatch(/^=\?base64\?/);
    expect(encodeHeaderValue("=?base64?literal?=")).not.toBe("=?base64?literal?=");
    expect(encodeHeaderValue("=?base64?literal?=")).toMatch(/^=\?base64\?.+\?=$/);
  });

  it("extractHeaderAnnotations: valid chains, excluded placements/types, duplicates", () => {
    const ok = extractHeaderAnnotations({
      type: "object",
      properties: { region: { type: "string", "x-mcp-header": "Region" }, n: { type: "integer", "x-mcp-header": "N" }, b: { type: "boolean", "x-mcp-header": "B" } },
    });
    expect([...ok.valid]).toEqual([
      ["region", "Region"],
      ["n", "N"],
      ["b", "B"],
    ]);
    expect(ok.invalid).toEqual([]);

    // number type excluded by spec; under allOf unreachable; bad header name; duplicate.
    const bad = extractHeaderAnnotations({
      type: "object",
      properties: {
        f: { type: "number", "x-mcp-header": "F" },
        nested: { type: "object", properties: { deep: { type: "string", "x-mcp-header": "Deep" } } },
      },
      allOf: [{ properties: { hidden: { type: "string", "x-mcp-header": "Hidden" } } }],
    });
    expect(bad.valid.get("nested")).toBeUndefined(); // nested itself has no annotation
    expect(bad.valid.get("f")).toBeUndefined();
    // The nested.properties.deep IS on a pure properties chain — valid.
    expect(bad.valid.get("deep")).toBe("Deep");
    expect(bad.invalid.some((m) => m.includes("'F'") && m.includes("type"))).toBe(true);
    expect(bad.invalid.some((m) => m.includes("'Hidden'") && m.includes("chain"))).toBe(true);

    const dup = extractHeaderAnnotations({
      type: "object",
      properties: { a: { type: "string", "x-mcp-header": "Same" }, b: { type: "string", "x-mcp-header": "same" } },
    });
    expect(dup.valid.size).toBe(1);
    expect(dup.invalid.some((m) => m.includes("duplicate"))).toBe(true);

    const badName = extractHeaderAnnotations({ type: "object", properties: { x: { type: "string", "x-mcp-header": "bad name" } } });
    expect(badName.valid.size).toBe(0);
    expect(badName.invalid.length).toBe(1);
  });

  it("isInputRequiredResult detects MRTR payloads", () => {
    expect(isInputRequiredResult({ inputRequests: [{ method: "elicitation/create" }] })).toBe(true);
    expect(isInputRequiredResult({ inputRequests: [] })).toBeFalsy();
    expect(isInputRequiredResult({ content: [] })).toBeFalsy();
  });
});

describe("modern era client (era: auto/modern via fake transport)", () => {
  beforeEach(() => {
    __resetEraCacheForTests();
  });
  afterEach(() => {
    __resetEraCacheForTests();
  });

  it("modern probe succeeds → no initialize/initialized ever; modern dressing on every request", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      if (msg.method === "server/discover") {
        t.emit({ jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result: discoverResult() });
      } else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result: { tools: [{ name: "tool", inputSchema: { type: "object" } }] } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-modern-1" });
    const init = await c.connect();
    expect(init.serverInfo).toEqual({ name: "qianmiao-bill", version: "1.0.0" });
    expect(init.instructions).toBe("测试指引");
    expect(c.protocolVersion).toBe("2026-07-28");
    await c.listTools();

    const methods = t.sent.filter((m) => "method" in m).map((m) => (m as JsonRpcRequest).method);
    expect(methods).toEqual(["server/discover", "tools/list"]); // NEVER initialize
    // Probe dressing: _meta identity + base mirror headers.
    const probe = t.sent[0] as JsonRpcRequest;
    const meta = (probe.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({ name: "@lingjing-agent/mcp", version: "0.1.0" });
    expect(t.sentOpts[0]?.headers).toMatchObject({ "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
    // tools/list dressed too; list page 1 has only _meta (no cursor).
    const list = t.sent[1] as JsonRpcRequest;
    expect((list.params as Record<string, unknown>)["_meta"]).toBeDefined();
    expect(t.sentOpts[1]?.headers?.["mcp-method"]).toBe("tools/list");
    await c.close();
    expect(getCachedEra("k-modern-1")).toBe("modern");
  });

  it("probe 400 with empty/unrecognized body → clean legacy fallback, handshake traffic identical to legacy-only", async () => {
    const t = fakeMcpTransport();
    let sentDiscover = false;
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") {
        sentDiscover = true;
        throw httpErr(400, undefined, "missing MCP-Protocol-Version");
      }
      if (m.method === "initialize") {
        t.emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "legacy", version: "1" } } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-legacy-1" });
    const init = await c.connect();
    expect(init.serverInfo?.name).toBe("legacy");
    expect(sentDiscover).toBe(true);
    // The initialize POST carries NO modern dressing (byte-identical legacy).
    const initIdx = t.sent.findIndex((m) => "method" in m && (m as JsonRpcRequest).method === "initialize");
    expect(t.sentOpts[initIdx]?.headers).toBeUndefined();
    expect((t.sent[initIdx] as JsonRpcRequest).params).toMatchObject({ protocolVersion: "2025-11-25" });
    // Failure is not cached.
    expect(getCachedEra("k-legacy-1")).toBeUndefined();
    await c.close();
  });

  it("probe 200 + JSON-RPC error (legacy unknown-method shape) → legacy fallback", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") {
        t.emit({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: server/discover" } });
        return;
      }
      if (m.method === "initialize") {
        // The fallback handshake completes normally → legacy era in force.
        t.emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "legacy", version: "1" } } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-legacy-2" });
    const init = await c.connect();
    expect(init.serverInfo?.name).toBe("legacy");
    expect(c.protocolVersion).toBe("2025-06-18");
    // Failure was not cached as anything.
    expect(getCachedEra("k-legacy-2")).toBeUndefined();
    await c.close();
  });

  it("probe 400 + -32022 → version retry once; empty intersection → McpUnsupportedProtocolError with the advertised list", async () => {
    const t = fakeMcpTransport();
    let discoverCalls = 0;
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") {
        discoverCalls += 1;
        if (discoverCalls === 1) {
          throw httpErr(400, { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28"] } });
        }
        t.emit({ jsonrpc: "2.0", id: m.id, result: discoverResult() });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-retry-1" });
    const init = await c.connect();
    expect(discoverCalls).toBe(2); // retried with the picked version
    expect(init.protocolVersion).toBe("2026-07-28");
    await c.close();

    const t2 = fakeMcpTransport();
    t2.onSend = (msg) => {
      if ("method" in msg && (msg as JsonRpcRequest).method === "server/discover") {
        throw httpErr(400, { code: -32022, message: "Unsupported protocol version", data: { supported: ["2030-01-01"] } });
      }
    };
    const c2 = new McpClient({ transport: t2, era: "auto", eraCacheKey: "k-retry-2" });
    const err = await c2.connect().then(
      () => undefined,
      (e) => e,
    );
    expect(err).toBeInstanceOf(McpUnsupportedProtocolError);
    expect((err as McpUnsupportedProtocolError).supported).toEqual(["2030-01-01"]);
    expect(t2.closed).toBe(true);
  });

  it("probe 400 + -32020/-32021 → terminal, NO legacy fallback", async () => {
    for (const code of [-32020, -32021]) {
      const t = fakeMcpTransport();
      t.onSend = (msg) => {
        if ("method" in msg && (msg as JsonRpcRequest).method === "server/discover") {
          throw httpErr(400, { code, message: "nope" });
        }
      };
      const c = new McpClient({ transport: t, era: "auto", eraCacheKey: `k-hard-${code}` });
      await expect(c.connect()).rejects.toThrow(/header\/capability requirements unmet/);
      expect(t.sent.some((m) => "method" in m && (m as JsonRpcRequest).method === "initialize")).toBe(false);
      expect(t.closed).toBe(true);
    }
  });

  it("probe 404 + JSON-RPC body → modern era with fabricated metadata", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") {
        throw httpErr(404, { code: -32601, message: "Method not found: server/discover" });
      }
      if (m.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-404-1" });
    const init = await c.connect();
    expect(init.serverInfo).toEqual({ name: "mcp-server", version: "unknown" });
    await c.listTools();
    expect(t.sent.filter((m) => "method" in m && (m as JsonRpcRequest).method === "initialize")).toEqual([]);
    await c.close();
  });

  it("cached modern era skips the probe semantics: a legacy-shaped error does NOT trigger fallback", async () => {
    const key = "k-cache-1";
    const a = fakeMcpTransport();
    a.onSend = (msg) => {
      if ("method" in msg && (msg as JsonRpcRequest).method === "server/discover") {
        a.emit({ jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result: discoverResult() });
      }
    };
    await new McpClient({ transport: a, era: "auto", eraCacheKey: key }).connect();
    expect(getCachedEra(key)).toBe("modern");

    const b = fakeMcpTransport();
    b.onSend = (msg) => {
      if ("method" in msg && (msg as JsonRpcRequest).method === "server/discover") {
        throw httpErr(400, undefined, "now legacy-shaped");
      }
    };
    const c2 = new McpClient({ transport: b, era: "auto", eraCacheKey: key });
    // Cached era says modern: the failing discover is an ERROR, not a probe
    // result — no initialize fallback.
    await expect(c2.connect()).rejects.toThrow(/HTTP 400/);
    expect(b.sent.some((m) => "method" in m && (m as JsonRpcRequest).method === "initialize")).toBe(false);
  });

  it("callTool modern dressing: mcp-name sentinel for non-ASCII, mcp-param-* from the x-mcp-header registry", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") {
        t.emit({ jsonrpc: "2.0", id: m.id, result: discoverResult() });
      } else if (m.method === "tools/list") {
        t.emit({
          jsonrpc: "2.0",
          id: m.id,
          result: {
            tools: [
              {
                name: "工具",
                inputSchema: {
                  type: "object",
                  properties: {
                    region: { type: "string", "x-mcp-header": "Region" },
                    count: { type: "integer", "x-mcp-header": "Count" },
                    dry: { type: "boolean", "x-mcp-header": "Dry" },
                    skipped: { type: "string" }, // no annotation, no header
                  },
                },
              },
            ],
          },
        });
      } else if (m.method === "tools/call") {
        t.emit({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-call-1" });
    await c.connect();
    await c.listTools();
    const res = await c.callTool("工具", { region: "us-west1", count: 42, dry: true, skipped: "x" });
    expect(res.content[0]?.text).toBe("ok");

    const call = t.sent.find((m) => "method" in m && (m as JsonRpcRequest).method === "tools/call");
    const idx = t.sent.indexOf(call!);
    const headers = t.sentOpts[idx]?.headers ?? {};
    expect(headers["mcp-name"]).toMatch(/^=\?base64\?.+\?=$/); // non-ASCII tool name
    expect(headers["mcp-param-Region"]).toBe("us-west1");
    expect(headers["mcp-param-Count"]).toBe("42");
    expect(headers["mcp-param-Dry"]).toBe("true");
    expect(Object.keys(headers).some((k) => k.startsWith("mcp-param-") && k.endsWith("skipped"))).toBe(false);
    await c.close();
  });

  it("callTool HeaderMismatch (-32020) → re-list + retry once; a second mismatch surfaces", async () => {
    const t = fakeMcpTransport();
    // "once" = only the first tools/call mismatches (retry succeeds);
    // "always" = every call mismatches (retry surfaces the error).
    let mode: "once" | "always" | "off" = "off";
    let calls = 0;
    let lists = 0;
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") t.emit({ jsonrpc: "2.0", id: m.id, result: discoverResult() });
      else if (m.method === "tools/list") {
        lists += 1;
        t.emit({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "tool", inputSchema: { type: "object" } }] } });
      } else if (m.method === "tools/call") {
        calls += 1;
        if (mode === "always" || (mode === "once" && calls === 1)) {
          throw httpErr(400, { code: -32020, message: "Header mismatch: Mcp-Name" });
        }
        t.emit({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-mm-1" });
    await c.connect();
    await c.listTools();
    mode = "once";
    const res = await c.callTool("tool", {});
    expect(res.content[0]?.text).toBe("ok");
    expect(calls).toBe(2);
    expect(lists).toBe(2); // initial list + mismatch re-list

    // Persistent mismatch: retried once, then surfaces.
    mode = "always";
    calls = 0;
    await expect(c.callTool("tool", {})).rejects.toThrow(/Header mismatch/);
    expect(calls).toBe(2);
    await c.close();
  });

  it("MRTR InputRequiredResult → McpInputRequiredError (not 'malformed')", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") t.emit({ jsonrpc: "2.0", id: m.id, result: discoverResult() });
      else if (m.method === "tools/list") t.emit({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "tool", inputSchema: { type: "object" } }] } });
      else if (m.method === "tools/call") {
        t.emit({ jsonrpc: "2.0", id: m.id, result: { resultType: "inputRequired", inputRequests: [{ method: "sampling/createTextMessage" }] } });
      }
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-mrtr-1" });
    await c.connect();
    await c.listTools();
    const err = await c.callTool("tool", {}).then(
      () => undefined,
      (e) => e,
    );
    expect(err?.name).toBe("McpInputRequiredError");
    expect(err.message).toMatch(/Multi Round-Trip/);
    await c.close();
  });

  it("modern timeout sends NO notifications/cancelled; legacy does", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!("method" in msg)) return;
      const m = msg as JsonRpcRequest;
      if (m.method === "server/discover") t.emit({ jsonrpc: "2.0", id: m.id, result: discoverResult() });
      else if (m.method === "tools/list") t.emit({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "tool", inputSchema: { type: "object" } }] } });
      // tools/call: no response → timeout
    };
    const c = new McpClient({ transport: t, era: "auto", eraCacheKey: "k-timeout-1" });
    await c.connect();
    await c.listTools();
    await expect(c.callTool("tool", {}, { timeoutMs: 40 })).rejects.toThrow(/timed out/);
    expect(t.sent.some((m) => "method" in m && (m as JsonRpcRequest).method === "notifications/cancelled")).toBe(false);
    await c.close();

    // Legacy comparison: same silence DOES produce a cancelled notification.
    const tl = fakeMcpTransport();
    tl.onSend = (msg) => {
      if ("method" in msg && (msg as JsonRpcRequest).method === "initialize") {
        tl.emit({ jsonrpc: "2.0", id: (msg as JsonRpcRequest).id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "l", version: "1" } } });
      }
    };
    const cl = new McpClient({ transport: tl });
    await cl.connect();
    await expect(cl.callTool("tool", {}, { timeoutMs: 40 })).rejects.toThrow(/timed out/);
    expect(tl.sent.some((m) => "method" in m && (m as JsonRpcRequest).method === "notifications/cancelled")).toBe(true);
    await cl.close();
  });

  it("modern session close sends no DELETE (no session id was ever minted)", async () => {
    const reqs: HttpTransportRequest[] = [];
    const httpFake: HttpTransport = async (req) => {
      reqs.push(req);
      const body = JSON.parse(req.body ?? "{}") as { method?: string; id?: number };
      if (body.method === "server/discover") {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: bodyOf(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: discoverResult() })),
        };
      }
      return { status: 202, statusText: "Accepted", headers: {}, body: bodyOf("") };
    };
    const mt = createHttpMcpTransport({ url: "https://modern/close", transport: httpFake });
    const c = new McpClient({ transport: mt, era: "modern" });
    await c.connect();
    await c.close();
    expect(reqs.length).toBe(1); // just the discover POST
    expect(reqs.every((r) => r.method === "POST")).toBe(true); // no DELETE, no initialized
  });
});

describe("modern era tools bridge", () => {
  it("invalid x-mcp-header annotations drop the tool (warn), valid ones bridge", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = fakeMcpTransport();
      t.onSend = (msg) => {
        if (!("method" in msg)) return;
        const m = msg as JsonRpcRequest;
        if (m.method === "initialize") {
          t.emit({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } } });
        } else if (m.method === "tools/list") {
          t.emit({
            jsonrpc: "2.0",
            id: m.id,
            result: {
              tools: [
                { name: "good", inputSchema: { type: "object", properties: { r: { type: "string", "x-mcp-header": "R" } } } },
                { name: "bad_number", inputSchema: { type: "object", properties: { f: { type: "number", "x-mcp-header": "F" } } } },
                { name: "bad_allof", inputSchema: { type: "object", allOf: [{ properties: { h: { type: "string", "x-mcp-header": "H" } } }] } },
              ],
            },
          });
        }
      };
      const s = await createMcpTools({ name: "srv", transport: t });
      expect(s.tools.map((x) => x.name)).toEqual(["srv__good"]); // invalid ones dropped
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toMatch(/bad_number/);
      await s.close();
    } finally {
      warn.mockRestore();
    }
  });
});

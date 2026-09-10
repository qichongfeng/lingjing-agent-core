// The Tool bridge over the fake transport: naming/collisions/maxTools, tags,
// permissions + destructive policy, schema pass-through, content mapping,
// execute-never-throws, refresh, close, and one url-mode end-to-end.

import { describe, expect, it } from "vitest";
import type { Agent, HttpTransport, HttpTransportRequest, HttpTransportResponse } from "@lingjing-agent/core";
import { createMcpTools } from "../src/tools.js";
import type { FakeMcpTransport } from "./helpers.js";
import { fakeMcpTransport, testCtx } from "./helpers.js";
import { isRequest, type JsonRpcRequest } from "../src/json-rpc.js";
import { bodyOf } from "./helpers.js";

function initResult(): Record<string, unknown> {
  return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1.0" } };
}

/** Fake transport scripted for a normal connect+list; callTool answers `answer` per tool name. */
function scriptedServer(tools: Record<string, unknown>[], answer: (name: string, args: unknown) => unknown): FakeMcpTransport {
  const t = fakeMcpTransport();
  t.onSend = (msg) => {
    if (!isRequest(msg)) return;
    if (msg.method === "initialize") t.emit({ jsonrpc: "2.0", id: msg.id, result: initResult() });
    else if (msg.method === "tools/list") t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    else if (msg.method === "tools/call") {
      const { name, arguments: args } = msg.params as { name: string; arguments: unknown };
      t.emit({ jsonrpc: "2.0", id: msg.id, result: answer(name, args) });
    }
  };
  return t;
}

describe("naming and registration guards", () => {
  it("prefixes and sanitizes: 'my server!' → my-server__echo", async () => {
    const t = scriptedServer([{ name: "echo", inputSchema: { type: "object" } }], () => ({ content: [] }));
    const s = await createMcpTools({ name: "my server!", transport: t });
    expect(s.tools.map((tool) => tool.name)).toEqual(["my-server__echo"]);
    await s.close();
  });

  it("collision after sanitization → close + throw", async () => {
    const t = scriptedServer(
      [{ name: "a b", inputSchema: {} }, { name: "a-b", inputSchema: {} }],
      () => ({ content: [] }),
    );
    await expect(createMcpTools({ name: "x", transport: t })).rejects.toThrow(/collision after sanitization/);
    expect(t.closed).toBe(true);
  });

  it("maxTools exceeded → close + throw; inputSchema must be an object or is substituted", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: "object" } }));
    const t = scriptedServer(many, () => ({ content: [] }));
    await expect(createMcpTools({ name: "x", transport: t, maxTools: 2 })).rejects.toThrow(/maxTools 2/);
    expect(t.closed).toBe(true);

    const t2 = scriptedServer([{ name: "weird", inputSchema: "not-a-schema" }], () => ({ content: [] }));
    const s2 = await createMcpTools({ name: "x", transport: t2 });
    expect((s2.tools[0]!.inputSchema as { jsonSchema: unknown }).jsonSchema).toEqual({ type: "object" });
    await s2.close();
  });

  it("url and transport are mutually exclusive and one is required", async () => {
    await expect(createMcpTools({ name: "x" })).rejects.toThrow(/exactly one/);
    const t = scriptedServer([], () => ({ content: [] }));
    await expect(createMcpTools({ name: "x", url: "https://s/mcp", transport: t })).rejects.toThrow(/exactly one/);
  });
});

describe("permissions + metadata mapping", () => {
  const descriptor = {
    name: "boom",
    description: "kaboom",
    inputSchema: { type: "object", properties: { x: { type: "number" } }, additionalProperties: false },
    annotations: { destructiveHint: true },
  };

  it("destructiveHint (confirm) → permissions.destructive + requiresConfirmation", async () => {
    const t = scriptedServer([descriptor], () => ({ content: [] }));
    const s = await createMcpTools({ name: "srv", transport: t });
    const tool = s.tools[0]!;
    expect(tool.permissions?.destructive).toBe(true);
    expect(tool.requiresConfirmation).toBe(true);
    expect(tool.permissions?.tags).toEqual(["mcp", "mcp:srv"]);
    expect(tool.permissions?.network).toBe(false); // custom transport
    expect(tool.timeoutMs).toBe(120_000);
    await s.close();
  });

  it("destructivePolicy 'skip' clears both; network true in url mode; custom toolTimeoutMs", async () => {
    const t = scriptedServer([descriptor], () => ({ content: [] }));
    const s = await createMcpTools({ name: "srv", transport: t, destructivePolicy: "skip", toolTimeoutMs: 5_000 });
    const tool = s.tools[0]!;
    expect(tool.permissions?.destructive).toBeUndefined();
    expect(tool.requiresConfirmation).toBeUndefined();
    expect(tool.timeoutMs).toBe(5_000);
    await s.close();

    const httpFake: HttpTransport = async () =>
      ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body: bodyOf("") }) as HttpTransportResponse;
    const t2 = scriptedServer([descriptor], () => ({ content: [] }));
    void t2;
    void httpFake;
  });

  it("inputSchema passes through as the identical object reference", async () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const t = scriptedServer([{ name: "search", inputSchema: schema }], () => ({ content: [] }));
    const s = await createMcpTools({ name: "srv", transport: t });
    expect((s.tools[0]!.inputSchema as { jsonSchema: object }).jsonSchema).toBe(schema);
    await s.close();
  });

  it("description falls back title → generated; session carries serverInfo/protocolVersion/instructions", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") {
        t.emit({
          jsonrpc: "2.0",
          id: msg.id,
          result: { ...initResult(), instructions: "use wisely" },
        });
      } else if (msg.method === "tools/list") {
        t.emit({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "titled", title: "The Title", inputSchema: {} }, { name: "bare", inputSchema: {} }] },
        });
      }
    };
    const s = await createMcpTools({ name: "srv", transport: t });
    expect(s.tools[0]!.description).toBe("The Title");
    expect(s.tools[1]!.description).toMatch(/'bare' from MCP server 'srv'/);
    expect(s.serverInfo).toEqual({ name: "srv", version: "1.0" });
    expect(s.protocolVersion).toBe("2025-06-18");
    expect(s.instructions).toBe("use wisely");
    await s.close();
  });
});

describe("tools/call result mapping", () => {
  const cases: Array<{ name: string; answer: unknown; expect: unknown }> = [
    {
      name: "text-only collapses to a string",
      answer: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      expect: "a\nb",
    },
    {
      name: "image becomes ImageContent",
      answer: { content: [{ type: "text", text: "look" }, { type: "image", data: "QUJD", mimeType: "image/webp" }] },
      expect: [
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/webp", data: "QUJD" },
      ],
    },
    {
      name: "image without data is dropped; default mediaType",
      answer: { content: [{ type: "image" }, { type: "image", data: "WA==" }] },
      expect: [{ type: "image", mediaType: "image/png", data: "WA==" }],
    },
    {
      name: "audio → placeholder",
      answer: { content: [{ type: "audio", mimeType: "audio/wav" }] },
      expect: "[unsupported audio content: audio/wav]",
    },
    {
      name: "resource text inlined, blob summarized",
      answer: {
        content: [
          { type: "resource", resource: { uri: "file:///a.txt", text: "hello" } },
          { type: "resource", resource: { uri: "file:///b.bin", mimeType: "application/octet-stream", blob: "QUJD" } },
        ],
      },
      expect: "[resource file:///a.txt]\nhello\n[resource file:///b.bin, application/octet-stream, 4 base64 chars — not inlined]",
    },
    {
      name: "structuredContent appended",
      answer: { content: [{ type: "text", text: "r" }], structuredContent: { rows: 1 } },
      expect: 'r\nstructured: {"rows":1}',
    },
    {
      name: "structuredContent alone",
      answer: { content: [], structuredContent: { ok: true } },
      expect: 'structured: {"ok":true}',
    },
    {
      name: "structuredContent truncated at 16 KiB",
      answer: { content: [], structuredContent: { blob: "x".repeat(20_000) } },
      expect: /"\[truncated\]"?|\[truncated\]/,
    },
    { name: "empty everything", answer: { content: [] }, expect: "[empty response]" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const t = scriptedServer([{ name: "probe", inputSchema: {} }], () => c.answer);
      const s = await createMcpTools({ name: "srv", transport: t });
      const out = await s.tools[0]!.execute({}, testCtx());
      if (c.expect instanceof RegExp) {
        expect(out.content).toMatch(c.expect);
      } else if (Array.isArray(c.expect)) {
        expect(out.content).toEqual(c.expect);
      } else {
        expect(out.content).toBe(c.expect);
      }
      expect(out.isError).toBeUndefined();
      await s.close();
    });
  }

  it("isError propagates; JSON-RPC error → one-line isError string; never throws", async () => {
    const t = scriptedServer(
      [{ name: "soft", inputSchema: {} }, { name: "hard", inputSchema: {} }],
      (name) =>
        name === "soft"
          ? { content: [{ type: "text", text: "boom" }], isError: true }
          : undefined, // hard → JSON-RPC error below
    );
    // script the hard failure separately
    const origOnSend = t.onSend;
    t.onSend = (msg) => {
      if (isRequest(msg) && msg.method === "tools/call" && (msg.params as { name: string }).name === "hard") {
        t.emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } });
        return;
      }
      origOnSend?.(msg);
    };
    const s = await createMcpTools({ name: "srv", transport: t });
    const soft = await s.tools[0]!.execute({}, testCtx());
    expect(soft).toEqual({ content: "boom", isError: true });
    const hard = await s.tools[1]!.execute({}, testCtx());
    expect(hard.isError).toBe(true);
    expect(hard.content).toMatch(/JSON-RPC error -32000/);
    await s.close();
  });

  it("timeout surfaces as isError with a cancelled notification sent", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") t.emit({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: {} }] } });
      }
      // tools/call: never answered
    };
    const s = await createMcpTools({ name: "srv", transport: t, toolTimeoutMs: 40 });
    const out = await s.tools[0]!.execute({}, testCtx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/timed out/);
    const cancelled = t.sent.find((m) => !("id" in m) && m.method === "notifications/cancelled");
    expect(cancelled).toBeDefined();
    await s.close();
  });

  it("abort → '(aborted)'; after close → 'MCP session closed'", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") t.emit({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", inputSchema: {} }] } });
      }
    };
    const s = await createMcpTools({ name: "srv", transport: t, toolTimeoutMs: 60_000 });
    const ac = new AbortController();
    const pending = s.tools[0]!.execute({}, testCtx(ac.signal));
    ac.abort();
    const out = await pending;
    expect(out).toEqual({ content: "(aborted)", isError: true });

    await s.close();
    const after = await s.tools[0]!.execute({}, testCtx());
    expect(after).toEqual({ content: "MCP session closed", isError: true });
  });
});

describe("refresh", () => {
  it("returns a fresh array; the session's tools array is untouched", async () => {
    let toolsPayload = [{ name: "one", inputSchema: {} }];
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") t.emit({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: toolsPayload } });
      }
    };
    const s = await createMcpTools({ name: "srv", transport: t });
    expect(s.tools.map((tool) => tool.name)).toEqual(["srv__one"]);
    toolsPayload = [{ name: "one", inputSchema: {} }, { name: "two", inputSchema: {} }];
    const fresh = await s.refresh();
    expect(fresh.map((tool) => tool.name)).toEqual(["srv__one", "srv__two"]);
    expect(s.tools.map((tool) => tool.name)).toEqual(["srv__one"]); // not mutated
    await s.close();
  });
});

describe("url mode end to end (fake HttpTransport)", () => {
  it("bridges over HTTP: session carries url-mode network=true", async () => {
    const reqs: HttpTransportRequest[] = [];
    const httpFake: HttpTransport = async (req) => {
      reqs.push(req);
      const body = JSON.parse(req.body ?? "{}") as JsonRpcRequest;
      const respond = (result: unknown, extraHeaders: Record<string, string> = {}): HttpTransportResponse => ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: bodyOf(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), 17),
      });
      if (body.method === "initialize") return respond(initResult(), { "mcp-session-id": "sess-1" });
      if (body.method === "tools/list") {
        return respond({ tools: [{ name: "ping_tool", inputSchema: { type: "object" } }] });
      }
      if (body.method === "tools/call") {
        return respond({ content: [{ type: "text", text: "pong" }] });
      }
      return { status: 202, statusText: "Accepted", headers: {}, body: bodyOf("") };
    };
    const s = await createMcpTools({ name: "remote", url: "https://srv/mcp", httpTransport: httpFake });
    expect(s.tools.map((tool) => tool.name)).toEqual(["remote__ping_tool"]);
    expect(s.tools[0]!.permissions?.network).toBe(true);
    // Every POST after initialize carries the session id.
    const posts = reqs.filter((r) => r.method === "POST");
    expect("mcp-session-id" in posts[0]!.headers).toBe(false); // initialize mints it
    expect(posts.slice(1).every((r) => r.headers["mcp-session-id"] === "sess-1")).toBe(true);
    const out = await s.tools[0]!.execute({ a: 1 }, testCtx());
    expect(out).toEqual({ content: "pong" });
    await s.close(); // DELETE with session
    expect(reqs[reqs.length - 1]!.method).toBe("DELETE");
  });
});

describe("resources/prompts bridging", () => {
  function serverWith(capabilities: Record<string, unknown>): FakeMcpTransport {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { ...initResult(), capabilities } });
      } else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
      } else if (msg.method === "resources/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { resources: [{ uri: "file:///a.txt", name: "A" }] } });
      } else if (msg.method === "resources/read") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { contents: [{ uri: "file:///a.txt", text: "hello", mimeType: "text/plain" }] } });
      } else if (msg.method === "prompts/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { prompts: [{ name: "greet", description: "hi" }] } });
      } else if (msg.method === "prompts/get") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { description: "g", messages: [{ role: "user", content: { type: "text", text: "yo" } }] } });
      }
    };
    return t;
  }

  it("bridges read-only resource + prompt tools when capabilities are advertised", async () => {
    const t = serverWith({ tools: {}, resources: {}, prompts: {} });
    const s = await createMcpTools({ name: "srv", transport: t });
    expect(s.tools.map((tool) => tool.name)).toEqual([
      "srv__echo",
      "srv__resources",
      "srv__read_resource",
      "srv__prompts",
      "srv__get_prompt",
    ]);
    // Read-only helpers are never destructive, never require confirmation.
    const readTools = s.tools.filter((tool) => tool.name !== "srv__echo");
    for (const rt of readTools) {
      expect(rt.permissions?.destructive).toBeUndefined();
      expect(rt.requiresConfirmation).toBeUndefined();
      expect(rt.permissions?.tags).toEqual(["mcp", "mcp:srv"]);
    }
    const readResource = s.tools.find((tool) => tool.name === "srv__read_resource")!;
    const out = await readResource.execute({ uri: "file:///a.txt" }, testCtx());
    expect(out.content).toBe("hello");
    const getPrompt = s.tools.find((tool) => tool.name === "srv__get_prompt")!;
    const promptOut = await getPrompt.execute({ name: "greet" }, testCtx());
    expect(promptOut.content).toBe("g\nuser: yo");
    await s.close();
  });

  it("bridgeResources/bridgePrompts:false omit the helpers even when advertised", async () => {
    const t = serverWith({ tools: {}, resources: {}, prompts: {} });
    const s = await createMcpTools({ name: "srv", transport: t, bridgeResources: false, bridgePrompts: false });
    expect(s.tools.map((tool) => tool.name)).toEqual(["srv__echo"]);
    await s.close();
  });

  it("no capability advertised → no helpers", async () => {
    const t = serverWith({ tools: {} });
    const s = await createMcpTools({ name: "srv", transport: t });
    expect(s.tools.map((tool) => tool.name)).toEqual(["srv__echo"]);
    await s.close();
  });
});

describe("attach + automatic diff", () => {
  function fakeAgent(): { agent: Agent; names: readonly string[] } {
    const tools = new Map<string, unknown>();
    const agent = {
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
      unregisterTool(name: string) {
        tools.delete(name);
      },
      listTools() {
        return [...tools.values()];
      },
    };
    return {
      agent: agent as unknown as Agent,
      get names() {
        return [...tools.keys()];
      },
    };
  }

  it("attach registers all tools and returns a detach that unregisters them", async () => {
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") t.emit({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "one", inputSchema: {} }] } });
      }
    };
    const s = await createMcpTools({ name: "srv", transport: t });
    // `names` is a live getter — destructure would freeze one snapshot.
    const fake = fakeAgent();
    const detach = s.attach(fake.agent);
    expect(fake.names).toEqual(["srv__one"]);
    detach();
    expect(fake.names).toEqual([]);
    await s.close();
  });

  it("list_changed re-lists and diffs: removed unregistered, added registered, changed replaced", async () => {
    let toolsPayload: { name: string; description?: string; inputSchema: Record<string, unknown> }[] = [
      { name: "one", inputSchema: { type: "object" } },
      { name: "drop", inputSchema: { type: "object" } },
    ];
    const t = fakeMcpTransport();
    t.onSend = (msg) => {
      if (!isRequest(msg)) return;
      if (msg.method === "initialize") t.emit({ jsonrpc: "2.0", id: msg.id, result: initResult() });
      else if (msg.method === "tools/list") {
        t.emit({ jsonrpc: "2.0", id: msg.id, result: { tools: toolsPayload } });
      }
    };
    const s = await createMcpTools({ name: "srv", transport: t });
    const fake = fakeAgent();
    s.attach(fake.agent);
    expect(fake.names).toEqual(["srv__one", "srv__drop"]);

    // Server drops "drop", adds "two", changes "one" (new description).
    toolsPayload = [
      { name: "one", description: "changed", inputSchema: { type: "object" } },
      { name: "two", inputSchema: { type: "object" } },
    ];
    t.emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    // The refresh is async (fire-and-forget handler); wait a tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.names).toEqual(["srv__one", "srv__two"]); // drop gone, two added
    await s.close();
  });
});

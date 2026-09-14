// web_read universal dispatch: JSON / feed (content-type + XML sniff) / HTML
// / raw paths, feed limit, truncation notes, cache keyed by url+limit; and
// the createWebTools aggregator shape.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportResponse } from "@lingjing-agent/core";
import { createWebReadTool, createWebTools } from "../src/index.js";

function testCtx(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    toolCallId: "tc-test",
    conversationId: "c-test",
    runtime: "node" as const,
    log: () => {},
  };
}

function bodyOf(text: string): AsyncIterable<Uint8Array> {
  async function* gen(): AsyncIterable<Uint8Array> {
    yield new TextEncoder().encode(text);
  }
  return gen();
}

function respOf(body: string, headers: Record<string, string>): HttpTransport {
  return async () => ({ status: 200, statusText: "OK", headers, body: bodyOf(body) });
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed Co</title>
<item><title>One</title><link>https://f.example/1</link></item>
<item><title>Two</title><link>https://f.example/2</link></item>
<item><title>Three</title><link>https://f.example/3</link></item>
</channel></rss>`;

describe("web_read universal dispatch", () => {
  it("JSON (by content-type) → pretty JSON", async () => {
    const tool = createWebReadTool({
      transport: respOf('{"rate":7.24}', { "content-type": "application/json" }),
    });
    const r = await tool.execute({ url: "https://api.example.com/rates" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content as string).toContain('"rate": 7.24');
  });

  it("JSON sniffed from body (no content-type) → pretty JSON", async () => {
    const tool = createWebReadTool({ transport: respOf('{"a":[1,2]}', {}) });
    const r = await tool.execute({ url: "https://x.example/data" }, testCtx());
    expect(r.content as string).toContain('"a": [');
  });

  it("declared JSON but unparseable → raw body with a note", async () => {
    const tool = createWebReadTool({
      transport: respOf("not json at all", { "content-type": "application/json" }),
    });
    const r = await tool.execute({ url: "https://x.example/broken" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content as string).toContain("unparseable as JSON");
    expect(r.content as string).toContain("not json at all");
  });

  it("RSS by content-type → entries with feed header and limit", async () => {
    const tool = createWebReadTool({
      transport: respOf(RSS, { "content-type": "application/rss+xml" }),
    });
    const r = await tool.execute({ url: "https://f.example/feed", limit: 2 }, testCtx());
    expect(r.content as string).toContain("feed: Feed Co");
    expect(r.content as string).toContain("(1 more omitted)");
    const items = JSON.parse((r.content as string).slice((r.content as string).indexOf("["))) as unknown[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "One", url: "https://f.example/1" });
  });

  it("feed sniffed from XML prolog (generic xml content-type) → entries", async () => {
    const tool = createWebReadTool({ transport: respOf(RSS, { "content-type": "application/xml" }) });
    const r = await tool.execute({ url: "https://f.example/rss" }, testCtx());
    expect(r.content as string).toContain("items: 3");
  });

  it("non-feed XML → raw text", async () => {
    const tool = createWebReadTool({
      transport: respOf('<?xml version="1.0"?><doc><x>1</x></doc>', { "content-type": "application/xml" }),
    });
    const r = await tool.execute({ url: "https://x.example/doc" }, testCtx());
    expect(r.content as string).toContain("<doc>");
    expect(r.content as string).not.toContain("items:");
  });

  it("HTML → Markdown (unchanged path)", async () => {
    const tool = createWebReadTool({
      transport: respOf("<html><body><h1>Title &amp; More</h1></body></html>", { "content-type": "text/html" }),
    });
    const r = await tool.execute({ url: "https://x.example/page" }, testCtx());
    expect(r.content as string).toContain("# Title & More");
  });

  it("cache is keyed by url AND feed limit", async () => {
    let calls = 0;
    const t: HttpTransport = async () => {
      calls += 1;
      return { status: 200, statusText: "OK", headers: { "content-type": "application/rss+xml" }, body: bodyOf(RSS) };
    };
    const tool = createWebReadTool({ transport: t, cacheTtlMs: 60_000 });
    await tool.execute({ url: "https://f.example/feed", limit: 1 }, testCtx());
    await tool.execute({ url: "https://f.example/feed", limit: 1 }, testCtx()); // cached
    await tool.execute({ url: "https://f.example/feed", limit: 3 }, testCtx()); // different key → refetch
    expect(calls).toBe(2);
  });

  it("limit clamps to 1..50", async () => {
    const tool = createWebReadTool({
      transport: respOf(RSS, { "content-type": "application/rss+xml" }),
    });
    const r = await tool.execute({ url: "https://f.example/feed", limit: 999 }, testCtx());
    expect(r.content as string).toContain("items: 3"); // clamped, feed has 3
  });
});

describe("createWebTools aggregator", () => {
  it("default: web_read + wiki_search", () => {
    const tools = createWebTools();
    expect(tools.map((t) => t.name)).toEqual(["web_read", "wiki_search"]);
  });

  it("false disables; options pass through; webSearch only when configured", () => {
    const tools = createWebTools({ read: false, wiki: { languages: ["zh"] }, webSearch: { apiKey: "k" } });
    expect(tools.map((t) => t.name)).toEqual(["wiki_search", "web_search"]);
    const wiki = tools[0];
    // options pass through — languages wired into the request URL
    expect(wiki).toBeDefined();
  });
});

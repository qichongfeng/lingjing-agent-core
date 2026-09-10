// read_feed: RSS 2.0 + Atom parsing (CDATA, entities, dc:date, rel=alternate),
// limit clamping, feed-title scoping, HTML-in-summary distillation, gating.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportResponse } from "@lingjing-agent/core";
import { createReadFeedTool } from "../src/index.js";

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

function feedTransport(xml: string): HttpTransport {
  return async () => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/rss+xml" },
    body: bodyOf(xml),
  });
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Engineering Notes &amp; More</title>
    <link>https://blog.example.com/</link>
    <description>posts</description>
    <item>
      <title>Post &amp; Ampersand</title>
      <link>https://blog.example.com/amp</link>
      <pubDate>Mon, 07 Sep 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello <b>world</b> &amp; more</p>]]></description>
    </item>
    <item>
      <title>Second</title>
      <link>https://blog.example.com/second</link>
      <dc:date>2026-09-01T10:00:00Z</dc:date>
      <description>Plain &#65;BC summary</description>
    </item>
    <item>
      <title>Third</title>
      <link>https://blog.example.com/third</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases &#8212; acme/app</title>
  <link rel="self" href="https://acme.example.com/feed.atom"/>
  <entry>
    <title>v2.1.0</title>
    <link rel="alternate" href="https://acme.example.com/app/v2.1.0"/>
    <link rel="self" href="https://acme.example.com/entries/1"/>
    <updated>2026-09-08T12:00:00Z</updated>
    <summary>Fixed &#39;that&#39; bug &amp; improved startup.</summary>
  </entry>
  <entry>
    <title>v2.0.0</title>
    <link href="https://acme.example.com/app/v2.0.0"/>
    <published>2026-08-30T09:00:00Z</published>
    <content type="html">&lt;p&gt;Big rewrite&lt;/p&gt;</content>
  </entry>
</feed>`;

describe("createReadFeedTool", () => {
  it("parses RSS 2.0: feed title, items in order, CDATA + entities + HTML distilled", async () => {
    const tool = createReadFeedTool({ transport: feedTransport(RSS) });
    const r = await tool.execute({ url: "https://blog.example.com/feed.xml" }, testCtx());
    expect(r.isError).toBeFalsy();
    const c = r.content as string;
    expect(c).toContain("feed: Engineering Notes & More");
    expect(c).toContain("items: 3");
    const items = JSON.parse(c.slice(c.indexOf("["))) as Array<Record<string, string>>;
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe("Post & Ampersand");
    expect(items[0]?.url).toBe("https://blog.example.com/amp");
    expect(items[0]?.date).toBe("Mon, 07 Sep 2026 08:00:00 GMT");
    expect(items[0]?.summary).toBe("Hello **world** & more"); // HTML → Markdown (bold kept), entity decoded
    expect(items[1]?.date).toBe("2026-09-01T10:00:00Z"); // dc:date fallback
    expect(items[1]?.summary).toBe("Plain ABC summary"); // numeric entity
    expect(items[2]?.summary).toBeUndefined(); // optional field omitted
  });

  it("parses Atom: rel=alternate link wins, updated/published, summary→content fallback", async () => {
    const tool = createReadFeedTool({ transport: feedTransport(ATOM) });
    const r = await tool.execute({ url: "https://acme.example.com/feed.atom" }, testCtx());
    expect(r.isError).toBeFalsy();
    const c = r.content as string;
    expect(c).toContain("feed: Releases — acme/app"); // &#8212; decoded
    const items = JSON.parse(c.slice(c.indexOf("["))) as Array<Record<string, string>>;
    expect(items[0]?.url).toBe("https://acme.example.com/app/v2.1.0"); // alternate, not self
    expect(items[0]?.date).toBe("2026-09-08T12:00:00Z");
    expect(items[0]?.summary).toContain("Fixed 'that' bug & improved startup.");
    expect(items[1]?.date).toBe("2026-08-30T09:00:00Z"); // published fallback
    expect(items[1]?.summary).toBe("Big rewrite"); // content fallback, HTML decoded
  });

  it("limit clamps to 1..50 and reports omitted count", async () => {
    const tool = createReadFeedTool({ transport: feedTransport(RSS) });
    const r = await tool.execute({ url: "https://blog.example.com/feed.xml", limit: 1 }, testCtx());
    const c = r.content as string;
    expect(c).toContain("(2 more omitted)");
    const items = JSON.parse(c.slice(c.indexOf("["))) as unknown[];
    expect(items).toHaveLength(1);
    const over = await tool.execute({ url: "https://blog.example.com/feed.xml", limit: 999 }, testCtx());
    expect(over.content as string).toContain("items: 3"); // clamped to 50, feed has 3
  });

  it("not a feed → clear error", async () => {
    const tool = createReadFeedTool({ transport: feedTransport("<html><body>nope</body></html>") });
    const r = await tool.execute({ url: "https://example.com/" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content as string).toContain("No RSS/Atom entries");
  });

  it("marks body truncation", async () => {
    const tool = createReadFeedTool({ transport: feedTransport(RSS), maxBytes: 200 });
    const r = await tool.execute({ url: "https://blog.example.com/feed.xml" }, testCtx());
    expect(r.content as string).toContain("truncated at 200 bytes");
  });

  it("refuses non-http(s) URLs", async () => {
    const tool = createReadFeedTool({ transport: feedTransport(RSS) });
    const r = await tool.execute({ url: "ftp://example.com/feed" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content as string).toContain("not allowed");
  });
});

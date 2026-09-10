// parseFeed (shared by web_fetch's feed dispatch): RSS 2.0 + Atom parsing —
// CDATA, entities, dc:date, rel=alternate, summary→content fallback,
// limit/omitted, non-feed rejection.

import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/index.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Engineering Notes &amp; More</title>
    <link>https://blog.example.com/</link>
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

describe("parseFeed", () => {
  it("parses RSS 2.0: feed title, order preserved, CDATA + entities + HTML distilled", () => {
    const feed = parseFeed(RSS, 10);
    expect(feed).toBeDefined();
    expect(feed?.title).toBe("Engineering Notes & More");
    const items = feed?.items ?? [];
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ title: "Post & Ampersand", url: "https://blog.example.com/amp" });
    expect(items[0]?.date).toBe("Mon, 07 Sep 2026 08:00:00 GMT");
    expect(items[0]?.summary).toBe("Hello **world** & more");
    expect(items[1]?.date).toBe("2026-09-01T10:00:00Z"); // dc:date fallback
    expect(items[1]?.summary).toBe("Plain ABC summary"); // numeric entity
    expect(items[2]?.summary).toBeUndefined(); // optional field omitted
  });

  it("parses Atom: rel=alternate wins, updated/published, summary→content fallback", () => {
    const feed = parseFeed(ATOM, 10);
    expect(feed?.title).toBe("Releases — acme/app"); // &#8212; decoded
    const items = feed?.items ?? [];
    expect(items[0]?.url).toBe("https://acme.example.com/app/v2.1.0"); // alternate, not self
    expect(items[0]?.date).toBe("2026-09-08T12:00:00Z");
    expect(items[0]?.summary).toContain("Fixed 'that' bug & improved startup.");
    expect(items[1]?.date).toBe("2026-08-30T09:00:00Z");
    expect(items[1]?.summary).toBe("Big rewrite"); // escaped HTML decoded + distilled
  });

  it("limit slices and reports omitted", () => {
    const feed = parseFeed(RSS, 1);
    expect(feed?.items).toHaveLength(1);
    expect(feed?.omitted).toBe(2);
  });

  it("returns undefined for non-feed content", () => {
    expect(parseFeed("<html><body>nope</body></html>", 10)).toBeUndefined();
    expect(parseFeed('<?xml version="1.0"?><doc><x>1</x></doc>', 10)).toBeUndefined();
    expect(parseFeed("", 10)).toBeUndefined();
  });
});

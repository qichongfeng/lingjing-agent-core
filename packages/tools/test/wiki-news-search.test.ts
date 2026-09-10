// wiki_search + news_search: request shapes (origin=* / endpoint / params),
// result mapping, multi-language merge with partial failure, clamps, gating.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from "@lingjing-agent/core";
import { createWikiSearchTool, createNewsSearchTool } from "../src/index.js";

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

function jsonResp(body: unknown, extra: Partial<HttpTransportResponse> = {}): HttpTransportResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: bodyOf(JSON.stringify(body)),
    ...extra,
  };
}

function recorder(respFor: (req: HttpTransportRequest) => HttpTransportResponse): {
  t: HttpTransport;
  reqs: HttpTransportRequest[];
} {
  const reqs: HttpTransportRequest[] = [];
  return {
    reqs,
    t: async (req) => {
      reqs.push(req);
      return respFor(req);
    },
  };
}

describe("createWikiSearchTool", () => {
  const WIKI_BODY = {
    query: {
      search: [
        { title: "Artificial intelligence", snippet: '<span class="searchmatch">Artificial</span> intelligence (AI)…' },
        { title: "AI safety" },
      ],
    },
  };

  it("searches each language edition with origin=* and maps title/url/snippet", async () => {
    const { t, reqs } = recorder(() => jsonResp(WIKI_BODY));
    const tool = createWikiSearchTool({ transport: t, languages: ["zh", "en"] });
    const r = await tool.execute({ query: "artificial intelligence" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]?.url).toContain("https://zh.wikipedia.org/w/api.php?action=query&list=search");
    expect(reqs[0]?.url).toContain("srsearch=artificial%20intelligence");
    expect(reqs[0]?.url).toContain("origin=*"); // the param that turns CORS on
    expect(reqs[0]?.url).toContain("srlimit=5");
    const results = JSON.parse(r.content as string) as Array<Record<string, string>>;
    expect(results).toHaveLength(4); // 2 per language, merged in language order
    expect(results[0]?.title).toBe("Artificial intelligence");
    expect(results[0]?.url).toBe("https://zh.wikipedia.org/wiki/Artificial_intelligence");
    expect(results[0]?.snippet).not.toContain("<span"); // highlights stripped
    expect(results[2]?.lang).toBe("en");
  });

  it("clamps limit and maps per-call limit", async () => {
    const { t, reqs } = recorder(() => jsonResp({ query: { search: [] } }));
    const tool = createWikiSearchTool({ transport: t });
    await tool.execute({ query: "x", limit: 99 }, testCtx());
    expect(reqs[0]?.url).toContain("srlimit=10");
  });

  it("one language failing is a partial-failure note, hits still returned", async () => {
    const { t } = recorder((req) =>
      req.url.startsWith("https://zh.") ? jsonResp({}, { status: 500, statusText: "Boom" }) : jsonResp(WIKI_BODY),
    );
    const tool = createWikiSearchTool({ transport: t, languages: ["zh", "en"] });
    const r = await tool.execute({ query: "ai" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content as string).toContain("partial failure");
    expect((JSON.parse((r.content as string).split("\n[partial")[0] ?? "[]") as unknown[]).length).toBe(2);
  });

  it("every language failing → isError; zero hits without errors → plain no-results", async () => {
    const fail = recorder(() => jsonResp({}, { status: 503, statusText: "Unavailable" }));
    const tool = createWikiSearchTool({ transport: fail.t, languages: ["en"] });
    const bad = await tool.execute({ query: "x" }, testCtx());
    expect(bad.isError).toBe(true);
    expect(bad.content as string).toContain("failed");

    const empty = recorder(() => jsonResp({ query: { search: [] } }));
    const tool2 = createWikiSearchTool({ transport: empty.t });
    const none = await tool2.execute({ query: "qqqq" }, testCtx());
    expect(none.isError).toBeFalsy();
    expect(none.content as string).toContain("No Wikipedia results");
  });

  it("refuses empty queries and non-http(s) is moot (fixed host)", async () => {
    const { t } = recorder(() => jsonResp(WIKI_BODY));
    const tool = createWikiSearchTool({ transport: t });
    expect((await tool.execute({ query: "  " }, testCtx())).isError).toBe(true);
  });
});

describe("createNewsSearchTool", () => {
  const HN_BODY = {
    hits: [
      {
        title: "A 10x Faster TypeScript",
        url: "https://devblogs.microsoft.com/typescript/typescript-native-port/",
        author: "DanR",
        points: 1042,
        num_comments: 356,
        created_at: "2026-09-08T10:00:00Z",
        objectID: "44000001",
      },
      { title: "Ask HN: Side projects?", author: "joe", points: 12, num_comments: 40, created_at: "2026-09-09T10:00:00Z", objectID: "44000002" },
    ],
  };

  it("searches HN Algolia (relevance endpoint, tags=story) and maps fields", async () => {
    const { t, reqs } = recorder(() => jsonResp(HN_BODY));
    const tool = createNewsSearchTool({ transport: t });
    const r = await tool.execute({ query: "typescript" }, testCtx());
    expect(reqs[0]?.url).toBe(
      "https://hn.algolia.com/api/v1/search?query=typescript&tags=story&hitsPerPage=8",
    );
    expect(r.content as string).toMatch(/^as_of: \d{4}-\d{2}-\d{2}T/); // recency anchor
    const results = JSON.parse((r.content as string).slice((r.content as string).indexOf("["))) as Array<Record<string, unknown>>;
    expect(results[0]?.points).toBe(1042);
    expect(results[0]?.comments).toBe(356);
    expect(results[0]?.source).toBe("hackernews");
    // Ask-HN style hit with no url falls back to the HN item link
    expect(results[1]?.url).toBe("https://news.ycombinator.com/item?id=44000002");
  });

  it("recent:true switches to the by-date endpoint", async () => {
    const { t, reqs } = recorder(() => jsonResp({ hits: [] }));
    const tool = createNewsSearchTool({ transport: t });
    await tool.execute({ query: "llm", recent: true, limit: 3 }, testCtx());
    expect(reqs[0]?.url).toContain("/search_by_date?");
    expect(reqs[0]?.url).toContain("hitsPerPage=3");
  });

  it("HTTP errors → isError; empty hits → plain no-results", async () => {
    const fail = recorder(() => jsonResp({}, { status: 500, statusText: "Server Error" }));
    const tool = createNewsSearchTool({ transport: fail.t });
    const bad = await tool.execute({ query: "x" }, testCtx());
    expect(bad.isError).toBe(true);
    expect(bad.content as string).toContain("500");

    const empty = recorder(() => jsonResp({ hits: [] }));
    const tool2 = createNewsSearchTool({ transport: empty.t });
    const none = await tool2.execute({ query: "zzz" }, testCtx());
    expect(none.isError).toBeFalsy();
    expect(none.content as string).toContain("No news results");
  });
});

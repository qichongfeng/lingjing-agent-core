// web_search: engine request shapes (brave GET / tavily+serper POST), result
// mapping to {title,url,snippet}, key handling, clamps, error paths.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from "@lingjing-agent/core";
import { createWebSearchTool } from "../src/index.js";

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

describe("createWebSearchTool", () => {
  it("brave (default): GET with q/count + X-Subscription-Token; maps web.results", async () => {
    const { t, reqs } = recorder(() =>
      jsonResp({ web: { results: [{ title: "Brave Result", url: "https://b.example/x", description: "a snippet" }] } }),
    );
    const tool = createWebSearchTool({ apiKey: "brave-key", transport: t });
    const r = await tool.execute({ query: "hello world" }, testCtx());
    expect(r.isError).toBeFalsy();
    const req = reqs[0]!;
    expect(req.url).toBe("https://api.search.brave.com/res/v1/web/search?q=hello%20world&count=5");
    expect(req.headers["x-subscription-token"]).toBe("brave-key");
    const results = JSON.parse(r.content as string) as Array<Record<string, string>>;
    expect(results[0]).toEqual({ title: "Brave Result", url: "https://b.example/x", snippet: "a snippet" });
  });

  it("tavily: POST JSON body with Bearer auth; maps results[]", async () => {
    const { t, reqs } = recorder(() =>
      jsonResp({ results: [{ title: "Tavily", url: "https://t.example/y", content: "tv snippet" }] }),
    );
    const tool = createWebSearchTool({ engine: "tavily", apiKey: "tv-key", transport: t, maxResults: 3 });
    const r = await tool.execute({ query: "q1" }, testCtx());
    const req = reqs[0]!;
    expect(req.url).toBe("https://api.tavily.com/search");
    expect(req.method).toBe("POST");
    expect(req.headers["authorization"]).toBe("Bearer tv-key");
    expect(JSON.parse(req.body as string)).toEqual({ query: "q1", max_results: 3 });
    const results = JSON.parse(r.content as string) as Array<Record<string, string>>;
    expect(results[0]?.snippet).toBe("tv snippet");
  });

  it("serper: POST with X-API-KEY; maps organic[]", async () => {
    const { t, reqs } = recorder(() =>
      jsonResp({ organic: [{ title: "Serper", link: "https://s.example/z", snippet: "sp snippet" }] }),
    );
    const tool = createWebSearchTool({ engine: "serper", apiKey: "sp-key", transport: t });
    await tool.execute({ query: "q2", maxResults: 7 }, testCtx());
    const req = reqs[0]!;
    expect(req.url).toBe("https://google.serper.dev/search");
    expect(req.headers["x-api-key"]).toBe("sp-key");
    expect(JSON.parse(req.body as string)).toEqual({ q: "q2", num: 7 });
    const r = await tool.execute({ query: "q2" }, testCtx());
    const results = JSON.parse(r.content as string) as Array<Record<string, string>>;
    expect(results[0]?.url).toBe("https://s.example/z");
  });

  it("requires an apiKey at factory time", () => {
    expect(() => createWebSearchTool({} as { apiKey: string })).toThrow(/apiKey is required/);
  });

  it("401/403 → isError with a check-the-key hint the model can relay", async () => {
    const { t } = recorder(() => jsonResp({ message: "Forbidden" }, { status: 403, statusText: "Forbidden" }));
    const tool = createWebSearchTool({ apiKey: "bad", transport: t });
    const r = await tool.execute({ query: "x" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content as string).toContain("403");
    expect(r.content as string).toContain("API key");
  });

  it("empty result set → friendly no-results, not an error", async () => {
    const { t } = recorder(() => jsonResp({ web: { results: [] } }));
    const tool = createWebSearchTool({ apiKey: "k", transport: t });
    const r = await tool.execute({ query: "nothing matches" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content as string).toContain("No results");
  });

  it("refuses empty queries; clamps maxResults to 1..10", async () => {
    const { t, reqs } = recorder(() => jsonResp({ web: { results: [] } }));
    const tool = createWebSearchTool({ apiKey: "k", transport: t });
    const empty = await tool.execute({ query: "  " }, testCtx());
    expect(empty.isError).toBe(true);
    await tool.execute({ query: "clamp", maxResults: 99 }, testCtx());
    expect(reqs[0]?.url).toContain("count=10");
  });
});

// web_search (Serper): request shape (POST + x-api-key + {q,num}), result
// mapping of organic[] to {title,url,snippet}, key handling, clamps, error paths.

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
  it("POSTs {q,num} with x-api-key; maps organic[] {title,link,snippet}", async () => {
    const { t, reqs } = recorder(() =>
      jsonResp({ organic: [{ title: "Serper", link: "https://s.example/z", snippet: "sp snippet" }] }),
    );
    const tool = createWebSearchTool({ apiKey: "sp-key", transport: t, maxResults: 3 });
    const r = await tool.execute({ query: "q1" }, testCtx());
    expect(r.isError).toBeFalsy();
    const req = reqs[0]!;
    expect(req.url).toBe("https://google.serper.dev/search");
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe("sp-key");
    expect(JSON.parse(req.body as string)).toEqual({ q: "q1", num: 3 });
    const results = JSON.parse(r.content as string) as Array<Record<string, string>>;
    expect(results[0]).toEqual({ title: "Serper", url: "https://s.example/z", snippet: "sp snippet" });
  });

  it("requires an apiKey with every endpoint (the key is part of the wire protocol)", () => {
    expect(() => createWebSearchTool({} as { apiKey: string })).toThrow(/apiKey is required/);
    expect(() => createWebSearchTool({ endpoint: "/api/serper" } as unknown as { apiKey: string })).toThrow(
      /apiKey is required/,
    );
  });

  it("custom endpoint: request goes there with the x-api-key header; protocol unchanged", async () => {
    const { t, reqs } = recorder(() =>
      jsonResp({ organic: [{ title: "Via proxy", link: "https://p.example/a", snippet: "s" }] }),
    );
    const tool = createWebSearchTool({ endpoint: "/api/serper", apiKey: "gw-token", transport: t });
    const r = await tool.execute({ query: "q" }, testCtx());
    expect(r.isError).toBeFalsy();
    const req = reqs[0]!;
    expect(req.url).toBe("/api/serper"); // WHERE customized…
    expect(req.headers["x-api-key"]).toBe("gw-token"); // …key is part of the protocol, always sent
    expect(JSON.parse(req.body as string)).toEqual({ q: "q", num: 5 }); // …HOW unchanged
    const results = JSON.parse(r.content as string) as Array<Record<string, string>>;
    expect(results[0]?.url).toBe("https://p.example/a");
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
    const { t } = recorder(() => jsonResp({ organic: [] }));
    const tool = createWebSearchTool({ apiKey: "k", transport: t });
    const r = await tool.execute({ query: "nothing matches" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content as string).toContain("No results");
  });

  it("refuses empty queries; clamps maxResults to 1..10", async () => {
    const { t, reqs } = recorder(() => jsonResp({ organic: [] }));
    const tool = createWebSearchTool({ apiKey: "k", transport: t });
    const empty = await tool.execute({ query: "  " }, testCtx());
    expect(empty.isError).toBe(true);
    await tool.execute({ query: "clamp", maxResults: 99 }, testCtx());
    expect(JSON.parse(reqs[0]?.body as string)).toEqual({ q: "clamp", num: 10 });
  });
});

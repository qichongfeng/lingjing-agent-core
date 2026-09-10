// fetch_json: JSON parsing + pretty output, non-JSON and HTTP-error paths,
// truncation marker, URL/protocol gating, host headers passthrough.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from "@lingjing-agent/core";
import { createFetchJsonTool } from "../src/index.js";

function testCtx(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    toolCallId: "tc-test",
    conversationId: "c-test",
    runtime: "node" as const,
    log: () => {},
  };
}

function bodyOf(text: string, chunkSize = 7): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  async function* gen(): AsyncIterable<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.slice(i, Math.min(i + chunkSize, bytes.length));
    }
  }
  return gen();
}

function resp(body: unknown, extra: Partial<HttpTransportResponse> = {}): HttpTransportResponse {
  return {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: bodyOf(typeof body === "string" ? body : JSON.stringify(body)),
    ...extra,
  };
}

/** Scripted transport that records requests. */
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

describe("createFetchJsonTool", () => {
  it("GETs the URL and returns pretty-printed JSON with a header", async () => {
    const { t, reqs } = recorder(() => resp({ rate: 7.24, base: "EUR" }));
    const tool = createFetchJsonTool({ transport: t });
    const r = await tool.execute({ url: "https://api.example.com/rates" }, testCtx());
    expect(r.isError).toBeFalsy();
    const c = r.content as string;
    expect(c).toContain("status: 200");
    expect(c).toContain('"rate": 7.24'); // pretty (2-space)
    expect(reqs[0]?.method).toBe("GET");
    expect(reqs[0]?.headers["accept"]).toBe("application/json");
  });

  it("passes host-configured headers (credentials are host-owned)", async () => {
    const { t, reqs } = recorder(() => resp({ ok: true }));
    const tool = createFetchJsonTool({ transport: t, headers: { authorization: "Bearer host-key" } });
    await tool.execute({ url: "https://api.example.com/private" }, testCtx());
    expect(reqs[0]?.headers["authorization"]).toBe("Bearer host-key");
  });

  it("non-JSON response → clear error pointing at web_fetch", async () => {
    const { t } = recorder(() =>
      resp("<html><body>hi</body></html>", { headers: { "content-type": "text/html" } }),
    );
    const tool = createFetchJsonTool({ transport: t });
    const r = await tool.execute({ url: "https://example.com/page" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content as string).toContain("not JSON");
    expect(r.content as string).toContain("web_fetch");
  });

  it("HTTP error status → isError with status and body snippet", async () => {
    const { t } = recorder(() => resp({ error: "bad request" }, { status: 400, statusText: "Bad Request" }));
    const tool = createFetchJsonTool({ transport: t });
    const r = await tool.execute({ url: "https://api.example.com/x" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content as string).toContain("status: 400");
    expect(r.content as string).toContain("bad request");
  });

  it("truncated body that cannot parse → explicit truncation error (not 'not JSON')", async () => {
    const big = { blob: "x".repeat(4096) };
    const { t } = recorder(() => resp(big));
    const tool = createFetchJsonTool({ transport: t, maxBytes: 1024 });
    const r = await tool.execute({ url: "https://api.example.com/big" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content as string).toContain("truncated at 1024 bytes");
    expect(r.content as string).not.toContain("not JSON");
  });

  it("refuses non-http(s) and invalid URLs", async () => {
    const { t } = recorder(() => resp({}));
    const tool = createFetchJsonTool({ transport: t });
    const file = await tool.execute({ url: "file:///etc/passwd" }, testCtx());
    expect(file.isError).toBe(true);
    expect(file.content as string).toContain("not allowed");
    const bad = await tool.execute({ url: "not a url" }, testCtx());
    expect(bad.isError).toBe(true);
    expect(bad.content as string).toContain("Invalid URL");
  });
});

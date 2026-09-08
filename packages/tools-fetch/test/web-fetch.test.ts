import { describe, expect, it, vi, afterEach } from "vitest";
import { AbortError, type HttpTransport, type HttpTransportResponse } from "@lingjing-agent/core";
import { createWebFetchTool, htmlToText } from "../src/index.js";

function testCtx(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    toolCallId: "tc-test",
    conversationId: "c-test",
    runtime: "node" as const,
    log: () => {},
  };
}

/** Build a body AsyncIterable from a string, chunked at BYTE level so
 * multi-byte characters genuinely split across chunk boundaries. */
function bodyOf(text: string, chunkSize = 7): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  async function* gen(): AsyncIterable<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.slice(i, i + chunkSize);
    }
  }
  return gen();
}

function fakeTransport(resp: Partial<HttpTransportResponse>): HttpTransport {
  return async () => ({
    status: 200,
    statusText: "OK",
    headers: {},
    body: bodyOf(""),
    ...resp,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWebFetchTool", () => {
  it("distills HTML to readable text (scripts/styles dropped, entities decoded)", async () => {
    const html =
      "<!DOCTYPE html><html><head><style>.x{color:red}</style>" +
      "<script>alert('evil')</script></head>" +
      "<body><nav>Menu</nav><h1>Title &amp; More</h1><p>First&nbsp;para</p>" +
      "<p>Second</p><footer>Foot</footer></body></html>";
    const tool = createWebFetchTool({
      transport: fakeTransport({ headers: { "content-type": "text/html; charset=utf-8" }, body: bodyOf(html) }),
    });
    const r = await tool.execute({ url: "https://example.com/page" }, testCtx());
    expect(r.isError).toBeFalsy();
    const c = r.content as string;
    expect(c).toContain("status: 200");
    expect(c).toContain("Title & More");
    expect(c).toContain("First para");
    expect(c).toContain("Second");
    expect(c).not.toContain("alert('evil')");
    expect(c).not.toContain("color:red");
  });

  it("returns non-HTML bodies as-is", async () => {
    const tool = createWebFetchTool({
      transport: fakeTransport({ headers: { "content-type": "text/plain" }, body: bodyOf('{"a":1}') }),
    });
    const r = await tool.execute({ url: "https://example.com/data.json" }, testCtx());
    expect(r.content).toContain('{"a":1}');
  });

  it("truncates at maxBytes and says so", async () => {
    const tool = createWebFetchTool({
      transport: fakeTransport({ body: bodyOf("x".repeat(1000), 10) }),
      maxBytes: 50,
    });
    const r = await tool.execute({ url: "https://example.com/big" }, testCtx());
    expect(r.content).toContain("truncated at 50 bytes");
    expect((r.content as string).length).toBeLessThan(200);
  });

  it("decodes multi-byte UTF-8 split across chunk boundaries", async () => {
    const tool = createWebFetchTool({
      transport: fakeTransport({ body: bodyOf("灵境 agent", 1) }), // 1 byte per chunk — splits every code point
    });
    const r = await tool.execute({ url: "https://example.com/cn" }, testCtx());
    expect(r.content).toContain("灵境 agent");
  });

  it("falls back to the manual decoder when TextDecoder is missing (mini-program engines)", async () => {
    vi.stubGlobal("TextDecoder", undefined);
    const tool = createWebFetchTool({
      transport: fakeTransport({ body: bodyOf("emoji 🎉 and 中文", 3) }),
    });
    const r = await tool.execute({ url: "https://example.com/x" }, testCtx());
    expect(r.content).toContain("emoji 🎉 and 中文");
  });

  it("refuses non-http(s) protocols", async () => {
    const tool = createWebFetchTool({ transport: fakeTransport({}) });
    expect((await tool.execute({ url: "file:///etc/passwd" }, testCtx())).isError).toBe(true);
    expect((await tool.execute({ url: "ftp://example.com/x" }, testCtx())).isError).toBe(true);
    expect((await tool.execute({ url: "javascript:alert(1)" }, testCtx())).isError).toBe(true);
  });

  it("refuses invalid URLs and bad input", async () => {
    const tool = createWebFetchTool({ transport: fakeTransport({}) });
    expect((await tool.execute({ url: "not a url" }, testCtx())).isError).toBe(true);
    expect((await tool.execute({}, testCtx())).isError).toBe(true);
  });

  it("marks 4xx/5xx as isError but still returns the body", async () => {
    const tool = createWebFetchTool({
      transport: fakeTransport({ status: 404, statusText: "Not Found", body: bodyOf("no such page") }),
    });
    const r = await tool.execute({ url: "https://example.com/missing" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("status: 404");
    expect(r.content).toContain("no such page");
  });

  it("reports transport failures without throwing", async () => {
    const tool = createWebFetchTool({
      transport: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await tool.execute({ url: "https://down.example.com" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Request failed");
  });

  it("maps transport AbortError to (aborted)", async () => {
    const ac = new AbortController();
    const tool = createWebFetchTool({
      transport: async () => {
        throw new AbortError();
      },
    });
    const p = tool.execute({ url: "https://example.com/slow" }, testCtx(ac.signal));
    ac.abort();
    const r = await p;
    expect(r.content).toBe("(aborted)");
  });

  it("ships network permission + http tag", () => {
    const tool = createWebFetchTool({});
    expect(tool.permissions?.network).toBe(true);
    expect(tool.permissions?.destructive).toBeFalsy();
    expect(tool.permissions?.tags).toEqual(["http"]);
  });
});

describe("htmlToText", () => {
  it("keeps <pre>/<li> line structure readable", () => {
    const out = htmlToText("<ul><li>one</li><li>two</li></ul><pre>code\nblock</pre>");
    expect(out).toContain("one");
    expect(out).toContain("two");
    expect(out).toContain("code\nblock");
  });

  it("decodes numeric entities and drops invalid ones", () => {
    expect(htmlToText("&#65;&#x4e2d;")).toBe("A中");
    expect(htmlToText("&#999999999;")).toContain("�");
  });

  it("drops comments", () => {
    expect(htmlToText("a<!-- hidden -->b")).toBe("a b");
  });
});

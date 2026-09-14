import { describe, expect, it, vi, afterEach } from "vitest";
import { AbortError, type HttpTransport, type HttpTransportRequest, type HttpTransportResponse } from "@lingjing-agent/core";
import { createWebReadTool, htmlToMarkdown } from "../src/index.js";

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

describe("createWebReadTool", () => {
  it("distills HTML to readable text (scripts/styles dropped, entities decoded)", async () => {
    const html =
      "<!DOCTYPE html><html><head><style>.x{color:red}</style>" +
      "<script>alert('evil')</script></head>" +
      "<body><nav>Menu</nav><h1>Title &amp; More</h1><p>First&nbsp;para</p>" +
      "<p>Second</p><footer>Foot</footer></body></html>";
    const tool = createWebReadTool({
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

  it("returns plain-text bodies as-is", async () => {
    const tool = createWebReadTool({
      transport: fakeTransport({ headers: { "content-type": "text/plain" }, body: bodyOf("just some plain text") }),
    });
    const r = await tool.execute({ url: "https://example.com/robots.txt" }, testCtx());
    expect(r.content).toContain("just some plain text");
  });

  it("truncates at maxBytes and says so", async () => {
    const tool = createWebReadTool({
      transport: fakeTransport({ body: bodyOf("x".repeat(1000), 10) }),
      maxBytes: 50,
    });
    const r = await tool.execute({ url: "https://example.com/big" }, testCtx());
    expect(r.content).toContain("truncated at 50 bytes");
    expect((r.content as string).length).toBeLessThan(200);
  });

  it("decodes multi-byte UTF-8 split across chunk boundaries", async () => {
    const tool = createWebReadTool({
      transport: fakeTransport({ body: bodyOf("灵境 agent", 1) }), // 1 byte per chunk — splits every code point
    });
    const r = await tool.execute({ url: "https://example.com/cn" }, testCtx());
    expect(r.content).toContain("灵境 agent");
  });

  it("falls back to the manual decoder when TextDecoder is missing (mini-program engines)", async () => {
    vi.stubGlobal("TextDecoder", undefined);
    const tool = createWebReadTool({
      transport: fakeTransport({ body: bodyOf("emoji 🎉 and 中文", 3) }),
    });
    const r = await tool.execute({ url: "https://example.com/x" }, testCtx());
    expect(r.content).toContain("emoji 🎉 and 中文");
  });

  it("refuses non-http(s) protocols", async () => {
    const tool = createWebReadTool({ transport: fakeTransport({}) });
    expect((await tool.execute({ url: "file:///etc/passwd" }, testCtx())).isError).toBe(true);
    expect((await tool.execute({ url: "ftp://example.com/x" }, testCtx())).isError).toBe(true);
    expect((await tool.execute({ url: "javascript:alert(1)" }, testCtx())).isError).toBe(true);
  });

  it("refuses invalid URLs and bad input", async () => {
    const tool = createWebReadTool({ transport: fakeTransport({}) });
    expect((await tool.execute({ url: "not a url" }, testCtx())).isError).toBe(true);
    expect((await tool.execute({}, testCtx())).isError).toBe(true);
  });

  it("marks 4xx/5xx as isError but still returns the body", async () => {
    const tool = createWebReadTool({
      transport: fakeTransport({ status: 404, statusText: "Not Found", body: bodyOf("no such page") }),
    });
    const r = await tool.execute({ url: "https://example.com/missing" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("status: 404");
    expect(r.content).toContain("no such page");
  });

  it("reports transport failures without throwing", async () => {
    const tool = createWebReadTool({
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
    const tool = createWebReadTool({
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
    const tool = createWebReadTool({});
    expect(tool.permissions?.network).toBe(true);
    expect(tool.permissions?.destructive).toBeFalsy();
    expect(tool.permissions?.tags).toEqual(["http"]);
  });
});

describe("web_read forward (URL 转发)", () => {
  function recordingTransport(): { t: HttpTransport; reqs: HttpTransportRequest[] } {
    const reqs: HttpTransportRequest[] = [];
    return {
      reqs,
      t: async (req) => {
        reqs.push(req);
        return { status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, body: bodyOf("proxied body") };
      },
    };
  }
  const target = "https://wttr.in/Beijing?format=j1";

  it("template with {urlEncoded} puts the encoded target in the query", async () => {
    const r = recordingTransport();
    const tool = createWebReadTool({ transport: r.t, forward: "/api/web-read?url={urlEncoded}" });
    const out = await tool.execute({ url: target }, testCtx());
    expect(r.reqs[0]?.url).toBe(`/api/web-read?url=${encodeURIComponent(target)}`);
    expect(out.isError).toBeFalsy();
  });

  it("template with {url} keeps the target verbatim (Jina-style)", async () => {
    const r = recordingTransport();
    const tool = createWebReadTool({ transport: r.t, forward: "https://r.jina.ai/{url}" });
    await tool.execute({ url: target }, testCtx());
    expect(r.reqs[0]?.url).toBe(`https://r.jina.ai/${target}`);
  });

  it("a placeholder-free string is a prefix the target is appended to", async () => {
    const r = recordingTransport();
    const tool = createWebReadTool({ transport: r.t, forward: "https://r.jina.ai/" });
    await tool.execute({ url: target }, testCtx());
    expect(r.reqs[0]?.url).toBe(`https://r.jina.ai/${target}`);
  });

  it("function form gets the target URL and returns the fetch URL", async () => {
    const r = recordingTransport();
    const tool = createWebReadTool({ transport: r.t, forward: (u) => `https://relay.example/?raw=${btoa(u)}` });
    await tool.execute({ url: target }, testCtx());
    expect(r.reqs[0]?.url).toBe(`https://relay.example/?raw=${btoa(target)}`);
  });

  it("is invisible to the model: output + cache key + link resolution stay on the target URL", async () => {
    const r = recordingTransport();
    const tool = createWebReadTool({ transport: r.t, forward: "/api/read?url={urlEncoded}", cacheTtlMs: 60_000 });
    const out = await tool.execute({ url: target }, testCtx());
    expect(out.content).toContain(`url: ${target}`); // target, not the forwarder
    expect(out.content).not.toContain("/api/read"); // forwarder never surfaces
    await tool.execute({ url: target }, testCtx()); // cached per TARGET url → no 2nd request
    await tool.execute({ url: "https://other.example/x" }, testCtx()); // different target → new request
    expect(r.reqs).toHaveLength(2);
  });

  it("the scheme gate still applies to the target, forwarder or not", async () => {
    const r = recordingTransport();
    const tool = createWebReadTool({ transport: r.t, forward: "/api/read?url={urlEncoded}" });
    expect((await tool.execute({ url: "file:///etc/passwd" }, testCtx())).isError).toBe(true);
    expect(r.reqs).toHaveLength(0); // refused before any request went out
  });
});

describe("htmlToMarkdown", () => {
  it("keeps <pre>/<li> structure: list markers + fenced code", () => {
    const out = htmlToMarkdown("<ul><li>one</li><li>two</li></ul><pre>code\nblock</pre>");
    expect(out).toContain("- one");
    expect(out).toContain("- two");
    expect(out).toContain("```\ncode\nblock\n```");
  });

  it("heading levels, links (resolved against the page URL), code language, bold", () => {
    const html =
      "<h2>Docs</h2>" +
      '<p>See <a href="/guide">the <b>guide</b></a> and ' +
      '<a href="https://abs.example/x">abs</a>.</p>' +
      '<pre class="language-ts"><code>const a = 1;</code></pre>';
    const out = htmlToMarkdown(html, "https://docs.example.com/intro");
    expect(out).toContain("## Docs");
    expect(out).toContain("[the **guide**](https://docs.example.com/guide)"); // relative resolved
    expect(out).toContain("[abs](https://abs.example/x)");
    expect(out).toContain("```ts\nconst a = 1;\n```");
  });

  it("captures <title> as the leading heading and drops the rest of <head>", () => {
    const out = htmlToMarkdown(
      "<html><head><title>My Page</title><meta name=\"x\" content=\"noise\"></head><body><p>hi</p></body></html>",
    );
    expect(out.startsWith("# My Page")).toBe(true);
    expect(out).not.toContain("noise");
    expect(out).toContain("hi");
  });

  it("title identical to the body's first heading is not duplicated", () => {
    const out = htmlToMarkdown(
      "<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>text</p></body></html>",
    );
    expect(out.match(/^# Example Domain$/gm)).toHaveLength(1);
  });

  it("images become markdown refs; data: URLs are summarized instead", () => {
    const out = htmlToMarkdown('<p><img src="/pic.png" alt="A pic"> <img src="data:image/png;base64,xx" alt="big"></p>', "https://x.example/");
    expect(out).toContain("![A pic](https://x.example/pic.png)");
    expect(out).not.toContain("base64");
  });

  it("decodes numeric entities and drops invalid ones", () => {
    expect(htmlToMarkdown("&#65;&#x4e2d;")).toBe("A中");
    expect(htmlToMarkdown("&#999999999;")).toContain("�");
  });

  it("drops comments and script/style", () => {
    expect(htmlToMarkdown("a<!-- hidden -->b")).toBe("a b");
    expect(htmlToMarkdown('<style>.x{}</style><script>bad()</script>ok')).toBe("ok");
  });
});

describe("web_read cache + host headers", () => {
  function recorder(respFor: () => HttpTransportResponse): { t: HttpTransport; calls: number } {
    const state = { calls: 0 };
    return {
      get calls() {
        return state.calls;
      },
      t: async (_req: HttpTransportRequest) => {
        state.calls += 1;
        return respFor();
      },
    };
  }

  it("caches successful fetches per URL for the TTL (no second request)", async () => {
    const r = recorder(() => ({ status: 200, statusText: "OK", headers: {}, body: bodyOf("cached page") }));
    const tool = createWebReadTool({ transport: r.t, cacheTtlMs: 60_000 });
    const a = await tool.execute({ url: "https://example.com/same" }, testCtx());
    const b = await tool.execute({ url: "https://example.com/same" }, testCtx());
    expect(r.calls).toBe(1);
    expect(b.content).toBe(a.content);
  });

  it("cacheTtlMs:0 disables caching", async () => {
    const r = recorder(() => ({ status: 200, statusText: "OK", headers: {}, body: bodyOf("page") }));
    const tool = createWebReadTool({ transport: r.t, cacheTtlMs: 0 });
    await tool.execute({ url: "https://example.com/same" }, testCtx());
    await tool.execute({ url: "https://example.com/same" }, testCtx());
    expect(r.calls).toBe(2);
  });

  it("errors are not cached", async () => {
    let status = 500;
    const r = recorder(() => ({ status, statusText: "Boom", headers: {}, body: bodyOf("oops") }));
    const tool = createWebReadTool({ transport: r.t });
    await tool.execute({ url: "https://example.com/flaky" }, testCtx());
    status = 200;
    const ok = await tool.execute({ url: "https://example.com/flaky" }, testCtx());
    expect(r.calls).toBe(2);
    expect(ok.isError).toBeFalsy();
  });

  it("passes host-configured headers (UA policy is the host's call)", async () => {
    const reqs: HttpTransportRequest[] = [];
    const t: HttpTransport = async (req) => {
      reqs.push(req);
      return { status: 200, statusText: "OK", headers: {}, body: bodyOf("x") };
    };
    const tool = createWebReadTool({ transport: t, headers: { "user-agent": "Mozilla/5.0 (host decided)" } });
    await tool.execute({ url: "https://example.com/ua" }, testCtx());
    expect(reqs[0]?.headers["user-agent"]).toBe("Mozilla/5.0 (host decided)");
  });
});

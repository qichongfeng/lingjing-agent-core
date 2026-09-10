// createReadabilityExtractor (./node): article extraction strips nav/sidebar,
// title handling, decline → web_fetch falls back to the built-in converter,
// extractor failure → fallback, non-HTML bodies bypass the extractor.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportResponse } from "@lingjing-agent/core";
import { createWebFetchTool } from "../src/index.js";
import { createReadabilityExtractor } from "../src/node/index.js";

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

function htmlTransport(html: string): HttpTransport {
  return async () => ({
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/html" },
    body: bodyOf(html),
  });
}

/** Article-shaped page with plenty of boilerplate around the main content. */
const ARTICLE = `<!DOCTYPE html>
<html><head><title>Understanding Event Loops</title><meta name="x" content="noise"></head>
<body>
<nav><a href="/home">Home</a> <a href="/blog">Blog</a> <a href="/about">About</a></nav>
<aside class="sidebar"><h3>Related</h3><a href="/a">Link A</a> <a href="/b">Link B</a></aside>
<article>
  <h1>Understanding Event Loops</h1>
  <p>The event loop is the core mechanism that gives JavaScript its concurrent
  behavior despite being single-threaded. It continuously checks the call stack
  and the task queues, moving queued callbacks onto the stack whenever it is
  empty, which is why non-blocking I/O works the way it does in practice.</p>
  <p>Macrotasks and microtasks differ in when they run: microtasks such as
  promise callbacks drain completely after each macrotask, before the next
  macrotask begins. This ordering explains several classic interview puzzles
  and real production bugs where a promise callback observes state that a
  setTimeout callback scheduled earlier has not yet seen.</p>
  <pre class="language-js"><code>Promise.resolve().then(() =&gt; console.log("micro"));
setTimeout(() =&gt; console.log("macro"));</code></pre>
  <p>Understanding this ordering is essential when reasoning about framework
  scheduling, request batching, and hydration. Most modern frameworks expose
  their own scheduling primitives on top of these two queues, and knowing the
  underlying semantics makes their behavior predictable rather than magical.</p>
</article>
<footer><a href="/tos">Terms</a> <a href="/privacy">Privacy</a></footer>
</body></html>`;

/** No article here — just a link farm. Readability should decline. */
const LINK_FARM = `<!DOCTYPE html>
<html><head><title>Portal</title></head><body>
<nav><a href="/1">One</a> <a href="/2">Two</a> <a href="/3">Three</a></nav>
<nav><a href="/4">Four</a> <a href="/5">Five</a></nav>
</body></html>`;

describe("createReadabilityExtractor", () => {
  it("extracts the article: nav/sidebar/footer gone, content + code fence + title kept", async () => {
    const extractor = createReadabilityExtractor();
    const out = await extractor(ARTICLE, "https://blog.example.com/event-loops");
    expect(out).toBeDefined();
    const md = out as string;
    expect(md).toContain("Understanding Event Loops");
    expect(md).toContain("Macrotasks and microtasks");
    expect(md).toContain('```js'); // code fence with language
    expect(md).not.toContain("/home");
    expect(md).not.toContain("Related");
    expect(md).not.toContain("Terms");
  });

  it("relative links inside the article resolve against the page URL", async () => {
    const extractor = createReadabilityExtractor();
    const out = await extractor(
      ARTICLE.replace("<p>The event loop", '<p><a href="/deep">The event loop</a>'),
      "https://blog.example.com/event-loops",
    );
    expect(out).toContain("(https://blog.example.com/deep)");
  });

  it("declines on pages with no article → web_fetch falls back to the full-page converter", async () => {
    const tool = createWebFetchTool({
      transport: htmlTransport(LINK_FARM),
      extractor: createReadabilityExtractor(),
    });
    const r = await tool.execute({ url: "https://portal.example.com/" }, testCtx());
    expect(r.isError).toBeFalsy();
    // Fallback kept the boilerplate links (full-page conversion ran).
    expect(r.content as string).toContain("/1");
    expect(r.content as string).toContain("# Portal");
  });

  it("a throwing extractor falls back instead of failing the fetch", async () => {
    const tool = createWebFetchTool({
      transport: htmlTransport(ARTICLE),
      extractor: async () => {
        throw new Error("boom");
      },
    });
    const r = await tool.execute({ url: "https://blog.example.com/x" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content as string).toContain("Macrotasks and microtasks"); // built-in converter output
    expect(r.content as string).toContain("/home"); // …including the nav it never strips
  });

  it("explicit undefined (declined) also falls back", async () => {
    const tool = createWebFetchTool({
      transport: htmlTransport(ARTICLE),
      extractor: () => undefined,
    });
    const r = await tool.execute({ url: "https://blog.example.com/y" }, testCtx());
    expect(r.content as string).toContain("Related"); // full page
  });

  it("non-HTML bodies bypass the extractor entirely", async () => {
    let called = false;
    const t: HttpTransport = async () =>
      ({
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
        body: bodyOf("plain bytes"),
      }) as HttpTransportResponse;
    const tool = createWebFetchTool({
      transport: t,
      extractor: async () => {
        called = true;
        return "SHOULD NOT BE USED";
      },
    });
    const r = await tool.execute({ url: "https://example.com/robots.txt" }, testCtx());
    expect(called).toBe(false);
    expect(r.content as string).toContain("plain bytes");
  });
});

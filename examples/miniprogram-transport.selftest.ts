// createWxTransport 的自验证:用 mock wx 模拟微信事件时序,验证它满足 core 的
// HttpTransport 契约。跑:
//   pnpm --filter @lingjing-agent/example-anthropic-demo demo:wx-transport
//   (或:node --experimental-strip-types miniprogram-transport.selftest.ts)

import assert from "node:assert/strict";
import { createWxTransport } from "./miniprogram-transport.ts";
import type { WxLike } from "./miniprogram-transport.ts";

/** A mock `wx` whose event emission the test drives by hand. */
function mockWx(): { wx: WxLike; captured: { url: string; method: string; data: string | ArrayBuffer | undefined; enableChunked: boolean | undefined; aborted: boolean }; emit: { headers: (status: number, header: Record<string, string>) => void; chunk: (bytes: Uint8Array) => void; success: (status: number, header: Record<string, string>, data: string | ArrayBuffer) => void; fail: (errMsg: string) => void } } {
  let chunkCb: ((res: { data: ArrayBuffer }) => void) | null = null;
  let headersCb: ((res: { header: Record<string, string>; statusCode: number }) => void) | null = null;
  let successCb: ((res: { statusCode: number; header: Record<string, string>; data: string | ArrayBuffer }) => void) | null = null;
  let failCb: ((err: { errMsg: string }) => void) | null = null;
  let aborted = false;
  const captured = { url: "", method: "", data: undefined as string | ArrayBuffer | undefined, enableChunked: undefined as boolean | undefined, get aborted() { return aborted; } };
  const wx: WxLike = {
    request(options) {
      captured.url = options.url;
      captured.method = options.method ?? "";
      captured.data = options.data;
      captured.enableChunked = options.enableChunked;
      successCb = options.success ?? null;
      failCb = options.fail ?? null;
      return {
        abort() {
          aborted = true;
          // Emulate wx: abort triggers fail with an abort errMsg.
          failCb?.({ errMsg: "request:fail abort" });
        },
        onChunkReceived(cb) {
          chunkCb = cb;
        },
        onHeadersReceived(cb) {
          headersCb = cb;
        },
      };
    },
  };
  return {
    wx,
    captured,
    emit: {
      headers: (status, header) => headersCb?.({ statusCode: status, header }),
      chunk: (bytes) => {
        const buf = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buf).set(bytes);
        chunkCb?.({ data: buf });
      },
      success: (status, header, data) => successCb?.({ statusCode: status, header, data }),
      fail: (errMsg) => failCb?.({ errMsg }),
    },
  };
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const c of body) out += decoder.decode(c, { stream: true });
  out += decoder.decode();
  return out;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function main(): Promise<void> {
  // 1. 流式:headers → chunks → success
  {
    const m = mockWx();
    const transport = createWxTransport(m.wx);
    const p = transport({ url: "https://x.test/v1/chat/completions", method: "POST", headers: { "content-type": "application/json" }, body: '{"hi":1}', signal: new AbortController().signal });
    // wx.request was called with the right args:
    assert.equal(m.captured.url, "https://x.test/v1/chat/completions");
    assert.equal(m.captured.method, "POST");
    assert.equal(m.captured.data, '{"hi":1}');
    assert.equal(m.captured.enableChunked, true);
    m.emit.headers(200, { "content-type": "text/event-stream" });
    const res = await p;
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-type"], "text/event-stream");
    m.emit.chunk(enc('data: {"id":"a","choices":[]}\n\n'));
    m.emit.chunk(enc("data: [DONE]\n\n"));
    m.emit.success(200, {}, "");
    const text = await drain(res.body);
    assert.ok(text.includes('{"id":"a"'), "body should contain chunk data, got: " + text);
    console.log("✓ streaming: headers + chunks + success → transport contract satisfied");
  }

  // 2. 非 2xx + retry-after header(body 经 success 兜底)
  {
    const m = mockWx();
    const transport = createWxTransport(m.wx);
    const p = transport({ url: "https://x.test", method: "POST", headers: {}, body: "{}", signal: new AbortController().signal });
    m.emit.headers(429, { "retry-after": "4" });
    m.emit.success(429, {}, "rate limited");
    const res = await p;
    assert.equal(res.status, 429);
    assert.equal(res.headers["retry-after"], "4");
    const text = await drain(res.body);
    assert.equal(text, "rate limited"); // non-streaming fallback: success.data fed as one chunk
    console.log("✓ non-2xx: status + retry-after header + body surfaced");
  }

  // 3. 流式中途 abort → body 抛 AbortError(不被误判为可重试)
  {
    const m = mockWx();
    const ctrl = new AbortController();
    const transport = createWxTransport(m.wx);
    const p = transport({ url: "https://x.test", method: "POST", headers: {}, body: "{}", signal: ctrl.signal });
    m.emit.headers(200, {});
    const res = await p;
    m.emit.chunk(enc("partial..."));
    const it = res.body[Symbol.asyncIterator]();
    const first = await it.next();
    assert.ok(!first.done && first.value instanceof Uint8Array);
    ctrl.abort(); // → onAbort → task.abort() → mock fail → failed = AbortError
    let threw: unknown;
    try {
      await it.next();
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof Error && threw.name === "AbortError", "body should throw AbortError after signal abort, got: " + String(threw));
    console.log("✓ mid-stream abort: body throws AbortError (not mis-classified as retryable)");
  }

  // 4. 请求发起前 signal 已 abort → 立即 reject AbortError
  {
    const m = mockWx();
    const ctrl = new AbortController();
    ctrl.abort();
    const transport = createWxTransport(m.wx);
    const p = transport({ url: "https://x.test", method: "POST", headers: {}, body: "{}", signal: ctrl.signal });
    let threw: unknown;
    try {
      await p;
    } catch (e) {
      threw = e;
    }
    assert.ok(threw instanceof Error && threw.name === "AbortError", "pre-aborted signal should reject with AbortError");
    assert.equal(m.captured.aborted, true);
    console.log("✓ pre-aborted signal → task aborted + reject immediately");
  }

  console.log("\nAll createWxTransport self-tests passed.");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

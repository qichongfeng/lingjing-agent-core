import { describe, it, expect } from "vitest";
import { fetchTransport } from "../src/transport.js";

async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of body) out += decoder.decode(chunk, { stream: true });
  out += decoder.decode();
  return out;
}

const NO_SIGNAL = (): AbortSignal => new AbortController().signal;

describe("fetchTransport", () => {
  it("bridges a fetch Response body to an async iterable", async () => {
    const transport = fetchTransport(async () => new Response("hello", { status: 200 }));
    const res = await transport({
      url: "https://example.test/x",
      method: "GET",
      headers: {},
      signal: NO_SIGNAL(),
    });
    expect(res.status).toBe(200);
    expect(await drain(res.body)).toBe("hello");
  });

  it("forwards method/body/signal to fetch", async () => {
    let seenUrl: string | URL | RequestInfo | undefined;
    let seenMethod: string | undefined;
    let seenBody: BodyInit | null | undefined;
    let seenSignal: AbortSignal | null | undefined;
    const transport = fetchTransport(async (url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      seenBody = init?.body;
      seenSignal = init?.signal;
      return new Response("ok");
    });
    const ctrl = new AbortController();
    await transport({
      url: "https://example.test/p",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: ctrl.signal,
    });
    expect(seenUrl).toBe("https://example.test/p");
    expect(seenMethod).toBe("POST");
    expect(seenBody).toBe("{}");
    expect(seenSignal).toBe(ctrl.signal);
  });

  it("returns an empty body iterable when Response.body is null (204)", async () => {
    const transport = fetchTransport(async () => new Response(null, { status: 204 }));
    const res = await transport({
      url: "https://example.test/n",
      method: "GET",
      headers: {},
      signal: NO_SIGNAL(),
    });
    expect(res.status).toBe(204);
    expect(await drain(res.body)).toBe("");
  });

  it("lower-cases response header keys", async () => {
    const transport = fetchTransport(
      async () => new Response("x", { status: 200, headers: { "X-Foo": "bar" } }),
    );
    const res = await transport({
      url: "https://example.test/h",
      method: "GET",
      headers: {},
      signal: NO_SIGNAL(),
    });
    expect(res.headers["x-foo"]).toBe("bar");
    expect(res.headers["X-Foo"]).toBeUndefined();
  });

  it("propagates fetch rejections unchanged (does not swallow or classify)", async () => {
    const transport = fetchTransport(async () => {
      throw new TypeError("network failed");
    });
    await expect(
      transport({
        url: "https://example.test/e",
        method: "GET",
        headers: {},
        signal: NO_SIGNAL(),
      }),
    ).rejects.toThrow("network failed");
  });

  it("throws a diagnosable error when a wrapped fetch resolves undefined", async () => {
    // Seen in the wild: a Chromium-derivative browser's proxy/acceleration layer
    // resolved `undefined` for a fetch it silently dropped (CORS-blocked) instead
    // of rejecting — the raw crash was "reading 'headers' of undefined".
    const transport = fetchTransport(async () => undefined as unknown as Response);
    await expect(
      transport({
        url: "https://example.test/wrapped",
        method: "GET",
        headers: {},
        signal: NO_SIGNAL(),
      }),
    ).rejects.toThrow(
      /fetch for https:\/\/example\.test\/wrapped resolved undefined instead of a Response/,
    );
  });

  it("throws a diagnosable error when fetch resolves a non-Response object", async () => {
    const transport = fetchTransport(async () => ({}) as unknown as Response);
    await expect(
      transport({
        url: "https://example.test/malformed",
        method: "GET",
        headers: {},
        signal: NO_SIGNAL(),
      }),
    ).rejects.toThrow(/resolved a non-Response object instead of a Response/);
  });

  it("surfaces a fetch abort as a thrown error (signal threaded through)", async () => {
    const transport = fetchTransport(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const ctrl = new AbortController();
    const pending = transport({
      url: "https://example.test/a",
      method: "GET",
      headers: {},
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});

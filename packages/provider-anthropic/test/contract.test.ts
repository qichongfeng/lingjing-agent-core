import { describe, expect, test } from "vitest";
import type { HttpTransport, HttpTransportResponse, ProviderChunk, ProviderRequest, Tool } from "@lingjing-agent/core";
import { mapStop } from "../src/map-stop.js";
import { mapUsage } from "../src/map-usage.js";
import { mapRequest } from "../src/map-request.js";
import { mapStream } from "../src/map-stream.js";
import { enrichError, isRetryableStatus } from "../src/enrich-error.js";
import { AnthropicProvider } from "../src/index.js";
import type { AnthropicStreamEvent } from "../src/types.js";

async function collect(iter: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}
function evs(...list: AnthropicStreamEvent[]): AsyncIterable<AnthropicStreamEvent> {
  return (async function* () {
    for (const e of list) yield e;
  })();
}

function baseReq(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "claude-opus-4-8",
    system: "you are helpful",
    messages: [{ id: "u1", role: "user", content: "hi", createdAt: 0 }],
    config: { maxTokens: 1024 },
    signal: new AbortController().signal,
    ...over,
  };
}

describe("mapStop", () => {
  test("7 Anthropic stop_reasons map 1:1; unknown → end_turn", () => {
    expect(mapStop("end_turn")).toBe("end_turn");
    expect(mapStop("tool_use")).toBe("tool_use");
    expect(mapStop("max_tokens")).toBe("max_tokens");
    expect(mapStop("stop_sequence")).toBe("stop_sequence");
    expect(mapStop("pause_turn")).toBe("pause_turn");
    expect(mapStop("refusal")).toBe("refusal");
    expect(mapStop("context_window_exceeded")).toBe("context_window_exceeded");
    expect(mapStop(null)).toBe("end_turn");
    expect(mapStop("unknown")).toBe("end_turn");
  });
});

describe("mapUsage", () => {
  test("maps input/output + prompt-cache tokens", () => {
    expect(mapUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5 });
    const withCache = mapUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
    // inputTokens is TOTAL input context (cached tokens occupy the window
    // too — matching OpenAI prompt_tokens semantics); the cache fields stay
    // as subsets for cost math.
    expect(withCache.inputTokens).toBe(15);
    expect(withCache.cacheReadTokens).toBe(3);
    expect(withCache.cacheWriteTokens).toBe(2);
    expect(mapUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("mapRequest", () => {
  test("system is top-level (not in messages)", () => {
    const params = mapRequest(baseReq({ system: "be helpful" }));
    expect(params.system).toBe("be helpful");
    // messages carry only user/assistant — system is top-level (type-guaranteed
    // by AnthropicMessage, so no runtime assertion needed here).
  });

  test("user tool_result stays inside user content (not a standalone tool message)", () => {
    const req = baseReq({
      messages: [
        { id: "u2", role: "user", createdAt: 0, content: [{ type: "tool_result", toolCallId: "tc1", content: "result text" }] },
      ],
    });
    const params = mapRequest(req);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]?.role).toBe("user");
    const block = (params.messages[0]?.content as { type: string }[])[0];
    expect(block?.type).toBe("tool_result");
  });

  test("assistant tool_call → tool_use; thinking preserved with signature", () => {
    const req = baseReq({
      messages: [
        {
          id: "a1", role: "assistant", createdAt: 0,
          content: [
            { type: "text", text: "ok" },
            { type: "thinking", text: "secret", signature: "sig" },
            { type: "tool_call", id: "tc1", name: "echo", inputJson: "{}", input: {} },
          ],
        },
      ],
    });
    const params = mapRequest(req);
    const blocks = params.messages[0]?.content as { type: string; signature?: string; id?: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "thinking", "tool_use"]);
    expect(blocks[1]?.signature).toBe("sig");
    expect(blocks[2]?.id).toBe("tc1");
  });

  test("image → base64 source; tools → input_schema; tool_choice any; thinking adaptive", () => {
    const echo: Tool = { name: "echo", description: "d", inputSchema: { jsonSchema: { type: "object" } }, async execute() { return { content: "" }; } };
    const req = baseReq({
      messages: [{ id: "u", role: "user", createdAt: 0, content: [{ type: "image", mediaType: "image/png", data: "abc" }] }],
      tools: [echo],
      config: { maxTokens: 100, toolChoice: { type: "any" }, thinking: { type: "adaptive" } },
    });
    const params = mapRequest(req);
    const img = (params.messages[0]?.content as { type: string; source?: { type: string; media_type: string; data: string } }[])[0];
    expect(img?.type).toBe("image");
    expect(img?.source).toEqual({ type: "base64", media_type: "image/png", data: "abc" });
    expect(params.tools?.[0]).toMatchObject({ name: "echo" });
    expect(params.tools?.[0]?.input_schema).toEqual({ type: "object" });
    expect(params.tool_choice).toEqual({ type: "any" });
    expect(params.thinking?.type).toBe("enabled");
    expect(typeof params.thinking?.budget_tokens).toBe("number");
  });

  test("image INSIDE tool_result content maps through (game_run screenshots)", () => {
    const req = baseReq({
      messages: [
        {
          id: "u2", role: "user", createdAt: 0,
          content: [
            {
              type: "tool_result", toolCallId: "tc1",
              content: [
                { type: "text", text: "Loaded index.html · screenshot 1280x720 png" },
                { type: "image", mediaType: "image/png", data: "abc" },
              ],
            },
          ],
        },
      ],
    });
    const params = mapRequest(req);
    const tr = (params.messages[0]?.content as { type: string; content?: unknown }[])[0];
    expect(tr?.type).toBe("tool_result");
    const inner = tr?.content as { type: string; source?: { media_type: string; data: string } }[];
    expect(Array.isArray(inner)).toBe(true);
    expect(inner[0]?.type).toBe("text");
    expect(inner[1]?.type).toBe("image");
    expect(inner[1]?.source).toEqual({ type: "base64", media_type: "image/png", data: "abc" });
  });
});

describe("mapStream", () => {
  test("text turn: message_start → text_delta → message_end", async () => {
    const out = await collect(mapStream(evs(
      { type: "message_start", message: { id: "m1", model: "claude" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "message_stop" },
    )));
    expect(out.map((c) => c.type)).toEqual(["message_start", "text_delta", "message_delta", "message_end"]);
    expect((out[3] as { usage: { inputTokens: number } }).usage.inputTokens).toBe(1);
  });

  test("tool_use: input_json deltas accumulate by id; tool_call_end emitted", async () => {
    const out = await collect(mapStream(evs(
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "echo" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "message_stop" },
    )));
    const starts = out.filter((c) => c.type === "tool_call_start");
    const deltas = out.filter((c) => c.type === "tool_call_delta");
    expect(starts[0]).toMatchObject({ toolCallId: "tu1", name: "echo" });
    expect(deltas.map((d) => (d as { inputJsonDelta: string }).inputJsonDelta).join("")).toBe('{"a":1}');
    expect(out.some((c) => c.type === "tool_call_end")).toBe(true);
    expect((out[out.length - 1] as { stopReason: string }).stopReason).toBe("tool_use");
  });

  test("thinking: thinking_delta + signature_delta → thinking_end with signature", async () => {
    const out = await collect(mapStream(evs(
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "message_stop" },
    )));
    expect(out.map((c) => c.type)).toContain("thinking_delta");
    expect(out.find((c) => c.type === "thinking_end")).toMatchObject({ signature: "sig123" });
  });
});

describe("enrichError / isRetryableStatus", () => {
  const mkErr = (status: number, retryAfter?: string): unknown =>
    Object.assign(new Error(`HTTP ${status}`), {
      status,
      headers: retryAfter !== undefined ? new Headers(retryAfter ? { "retry-after": retryAfter } : {}) : null,
    });

  test("429 → retryable + retryAfterMs; 400 → not; network → retryable; abort → throws", () => {
    const e429 = enrichError(mkErr(429, "3")) as Error & { retryable?: boolean; status?: number; retryAfterMs?: number };
    expect(e429.status).toBe(429);
    expect(e429.retryable).toBe(true);
    expect(e429.retryAfterMs).toBe(3000);
    const e400 = enrichError(mkErr(400)) as Error & { retryable?: boolean };
    expect(e400.retryable).toBe(false);
    const eNet = enrichError(new Error("fetch failed")) as Error & { retryable?: boolean };
    expect(eNet.retryable).toBe(true);
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(() => enrichError(abortErr)).toThrow();
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
  });
});

describe("AnthropicProvider capabilities", () => {
  test("stopReasons include pause_turn + context_window_exceeded; thinking + promptCaching", () => {
    const p = new AnthropicProvider({ apiKey: "k" });
    expect([...p.capabilities.stopReasons]).toEqual([
      "end_turn", "tool_use", "max_tokens", "stop_sequence", "pause_turn", "refusal", "context_window_exceeded",
    ]);
    expect(p.capabilities.thinking).toBe(true);
    expect(p.capabilities.promptCaching).toBe(true);
  });
});

describe("AnthropicProvider.stream over transport", () => {
  test("end-to-end: SSE → ProviderChunk; x-api-key + anthropic-version headers", async () => {
    let posted: { url: string; headers: Record<string, string> } | undefined;
    const transport = (async (req: {
      url: string; method: string; headers: Record<string, string>; body: string; signal: AbortSignal;
    }): Promise<HttpTransportResponse> => {
      posted = { url: req.url, headers: req.headers };
      const enc = new TextEncoder();
      const body = (async function* () {
        yield enc.encode("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-opus-4-8" } }) + "\n\n");
        yield enc.encode("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }) + "\n\n");
        yield enc.encode("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 1 } }) + "\n\n");
        yield enc.encode("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
      })();
      return { status: 200, statusText: "OK", headers: {}, body };
    }) as unknown as HttpTransport;
    const p = new AnthropicProvider({ apiKey: "sk-ant-test", baseURL: "https://example.test/v1", transport });
    const out = await collect(p.stream(baseReq()));
    expect(posted?.url).toBe("https://example.test/v1/messages");
    expect(posted?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(posted?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(out.find((c) => c.type === "message_end")).toMatchObject({ stopReason: "end_turn", usage: { inputTokens: 3, outputTokens: 1 } });
    expect(out.filter((c) => c.type === "text_delta").map((c) => (c as { text: string }).text).join("")).toBe("Hi");
  });
});

describe("no vendor fields leak into core output", () => {
  test("mapStream emits only neutral ProviderChunk shapes", async () => {
    const out = await collect(mapStream(evs(
      { type: "message_start", message: { id: "m", model: "c" } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
      { type: "message_stop" },
    )));
    const serialized = JSON.stringify(out);
    for (const banned of ["content_block", "tool_use_id", "input_schema", "cache_control", "stop_reason", "input_tokens"]) {
      expect(serialized).not.toContain(banned);
    }
  });
});

describe("availability-error codes (tier fallback signals)", () => {
  function errorTransport(status: number, statusText: string, body: string): HttpTransport {
    return (async (): Promise<HttpTransportResponse> => {
      const enc = new TextEncoder();
      const iter = (async function* () {
        yield enc.encode(body);
      })();
      return { status, statusText, headers: {}, body: iter };
    }) as unknown as HttpTransport;
  }

  /** Drains the stream and rejects with the provider error (or fails the test
   *  if the stream unexpectedly succeeds). */
  async function streamError(status: number, statusText: string, body: string): Promise<never> {
    const p = new AnthropicProvider({
      apiKey: "k",
      baseURL: "https://example.test/v1",
      transport: errorTransport(status, statusText, body),
    });
    for await (const _c of p.stream(baseReq())) void _c;
    throw new Error("expected stream to reject");
  }

  test("529 + error.type overloaded_error → code 'overloaded', retryable", async () => {
    await expect(
      streamError(529, "Overloaded", JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })),
    ).rejects.toMatchObject({ name: "ProviderError", status: 529, retryable: true, code: "overloaded" });
  });

  test("404 + not_found_error (unknown model) → code 'model_not_found', non-retryable", async () => {
    await expect(
      streamError(404, "Not Found", JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: claude-nope not found" } })),
    ).rejects.toMatchObject({ name: "ProviderError", status: 404, retryable: false, code: "model_not_found" });
  });

  test("bare 529 with unparsable body (gateway) → code 'overloaded'", async () => {
    await expect(
      streamError(529, "Overloaded", "<html>busy</html>"),
    ).rejects.toMatchObject({ status: 529, retryable: true, code: "overloaded" });
  });

  test("enrichError preserves an explicit retryable + code on status-less input (SSE error path)", () => {
    const input = Object.assign(new Error("model gone"), {
      name: "ProviderError",
      retryable: false,
      code: "model_not_found",
    });
    const out = enrichError(input);
    expect(out.retryable).toBe(false);
    expect(out.code).toBe("model_not_found");
  });

  test("mapStream error event maps the machine type to a code; model-gone is non-retryable", async () => {
    await expect(
      collect(mapStream(evs({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } } as never))),
    ).rejects.toMatchObject({ code: "overloaded", retryable: true });
    await expect(
      collect(mapStream(evs({ type: "error", error: { type: "model_not_found", message: "no such model" } } as never))),
    ).rejects.toMatchObject({ code: "model_not_found", retryable: false });
  });
});

describe("sampling + effort model gating", () => {
  const req = (model: string, extra: Partial<ProviderRequest["config"]> = {}) =>
    mapRequest(baseReq({ model, config: { maxTokens: 100, temperature: 0.7, topP: 0.9, ...extra } })) as unknown as Record<string, unknown>;

  test("claude 4.7+/5+ reject sampling — adapter swallows temperature/top_p", () => {
    for (const model of ["claude-opus-4-7", "claude-fable-5-1", "claude-opus-4-7-20251101"]) {
      const params = req(model);
      expect(params["temperature"]).toBeUndefined();
      expect(params["top_p"]).toBeUndefined();
    }
  });

  test("older / non-claude models keep sampling", () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-5", "some-vendor-model"]) {
      const params = req(model);
      expect(params["temperature"]).toBe(0.7);
      expect(params["top_p"]).toBe(0.9);
    }
  });

  test("effort maps to output_config per model support matrix", () => {
    // 4.7+/5+: full range passes
    expect(req("claude-opus-4-7", { effort: "xhigh" })["output_config"]).toEqual({ effort: "xhigh" });
    expect(req("claude-fable-5-1", { effort: "max" })["output_config"]).toEqual({ effort: "max" });
    // 4.6: no xhigh → clamped
    expect(req("claude-opus-4-6", { effort: "xhigh" })["output_config"]).toEqual({ effort: "high" });
    expect(req("claude-opus-4-6", { effort: "low" })["output_config"]).toEqual({ effort: "low" });
    // opus-4.5: low..high only
    expect(req("claude-opus-4-5", { effort: "max" })["output_config"]).toEqual({ effort: "high" });
    // sonnet-4.5 / older / non-claude: dropped (no output_config at all)
    expect(req("claude-sonnet-4-5", { effort: "high" })["output_config"]).toBeUndefined();
    expect(req("some-vendor-model", { effort: "high" })["output_config"]).toBeUndefined();
  });
});

describe("constructor-level prompt caching (cacheControl)", () => {
  /** Transport that records each request's JSON body and returns a minimal SSE stream. */
  function captureTransport(bodies: unknown[]): HttpTransport {
    return (async (req: { body: string }): Promise<HttpTransportResponse> => {
      bodies.push(JSON.parse(req.body));
      const enc = new TextEncoder();
      const body = (async function* () {
        yield enc.encode("event: message_start\ndata: " + JSON.stringify({ type: "message_start", message: { id: "m", model: "c" } }) + "\n\n");
        yield enc.encode("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } }) + "\n\n");
        yield enc.encode("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
      })();
      return { status: 200, statusText: "OK", headers: {}, body };
    }) as unknown as HttpTransport;
  }

  test("cacheControl: {} → default two breakpoints (system + last user) on every request", async () => {
    const bodies: unknown[] = [];
    const p = new AnthropicProvider({ apiKey: "k", baseURL: "https://example.test/v1", transport: captureTransport(bodies), cacheControl: {} });
    await collect(p.stream(baseReq()));
    await collect(p.stream(baseReq()));
    for (const b of bodies) {
      const req = b as { system?: Array<{ cache_control?: unknown }>; messages: Array<{ role: string; content: unknown }> };
      expect(Array.isArray(req.system)).toBe(true);
      expect(req.system?.[0]?.cache_control).toEqual({ type: "ephemeral" });
      const lastMsg = req.messages[req.messages.length - 1]!;
      const lastBlock = Array.isArray(lastMsg.content) ? lastMsg.content[0] : undefined;
      expect((lastBlock as { cache_control?: unknown } | undefined)?.cache_control).toEqual({ type: "ephemeral" });
    }
  });

  test("cacheControl with ttl + custom targets is honored", async () => {
    const bodies: unknown[] = [];
    const p = new AnthropicProvider({
      apiKey: "k", baseURL: "https://example.test/v1", transport: captureTransport(bodies),
      cacheControl: { targets: ["system"], ttl: "1h" },
    });
    await collect(p.stream(baseReq()));
    const req = bodies[0] as { system?: Array<{ cache_control?: unknown }>; messages: Array<{ role: string; content: unknown }> };
    expect(req.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const lastBlock = (Array.isArray(req.messages[0]!.content) ? req.messages[0]!.content[0] : undefined) as { cache_control?: unknown } | undefined;
    expect(lastBlock?.cache_control).toBeUndefined(); // last_user not targeted
  });

  test("per-request providerOptions.cacheControl overrides the constructor default", async () => {
    const bodies: unknown[] = [];
    const p = new AnthropicProvider({
      apiKey: "k", baseURL: "https://example.test/v1", transport: captureTransport(bodies),
      cacheControl: { targets: ["system"], ttl: "1h" },
    });
    await collect(p.stream(baseReq({
      config: { maxTokens: 8, providerOptions: { cacheControl: { targets: ["last_user"] } } },
    })));
    const req = bodies[0] as { system?: Array<{ cache_control?: unknown }>; messages: Array<{ role: string; content: unknown }> };
    expect(req.system).toBe("you are helpful"); // string: no system breakpoint
    const lastBlock = (Array.isArray(req.messages[0]!.content) ? req.messages[0]!.content[0] : undefined) as { cache_control?: unknown } | undefined;
    expect(lastBlock?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("no cacheControl option → unchanged (no cache_control anywhere)", async () => {
    const bodies: unknown[] = [];
    const p = new AnthropicProvider({ apiKey: "k", baseURL: "https://example.test/v1", transport: captureTransport(bodies) });
    await collect(p.stream(baseReq()));
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
  });
});

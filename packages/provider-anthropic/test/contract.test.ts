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

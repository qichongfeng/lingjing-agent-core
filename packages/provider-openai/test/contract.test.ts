import { describe, expect, test } from "vitest";
import type {
  ProviderChunk,
  ProviderRequest,
  Tool,
} from "@lingjing/agent-core";
import { mapRequest, isOpenAISeries } from "../src/map-request.js";
import { mapStream } from "../src/map-stream.js";
import { mapStop } from "../src/map-stop.js";
import { mapUsage } from "../src/map-usage.js";
import { parseRetryAfter } from "../src/parse-retry-after.js";
import { enrichError, isRetryableStatus } from "../src/enrich-error.js";
import { OpenAIProvider } from "../src/index.js";
import { parseSSE } from "../src/sse.js";
import type { ChatCompletionChunk } from "../src/types.js";

const ck = (o: unknown) => o as unknown as ChatCompletionChunk;

/** Build a streaming Response whose body emits the given SSE-encoded strings. */
function sseResponse(parts: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Build a Response that emits the body byte-by-byte to exercise partial reads. */
function sseResponseDrip(body: string): Response {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const b of bytes) {
        controller.enqueue(new Uint8Array([b]));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Build an AsyncIterable<Uint8Array> emitting the given SSE-encoded strings (no Web Response). */
function sseBody(parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return (async function* () {
    for (const p of parts) yield encoder.encode(p);
  })();
}

/** Build an AsyncIterable<Uint8Array> emitting the body byte-by-byte to exercise partial reads. */
function sseBodyDrip(body: string): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  return (async function* () {
    for (const b of bytes) yield new Uint8Array([b]);
  })();
}

type FetchInit = { method: string; headers: Record<string, string>; body: string; signal: AbortSignal };

async function collect(iter: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: { jsonSchema: { type: "object", properties: { msg: { type: "string" } } } },
  async execute() {
    return { content: "" };
  },
};

function baseReq(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gpt-4o",
    system: "you are helpful",
    messages: [
      { id: "u1", role: "user", content: "hi", createdAt: 0 },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "thinking", text: "secret reasoning" },
          { type: "tool_call", id: "tc1", name: "echo", inputJson: '{"msg":"hi"}', input: { msg: "hi" } },
        ],
        createdAt: 0,
      },
      {
        id: "u2",
        role: "user",
        content: [{ type: "tool_result", toolCallId: "tc1", content: "echoed" }],
        createdAt: 0,
      },
    ],
    tools: [echoTool],
    config: { maxTokens: 1024, effort: "high", toolChoice: { type: "auto" } },
    signal: new AbortController().signal,
    conversationId: "c1",
    ...overrides,
  };
}

describe("mapStop", () => {
  test("maps every OpenAI finish_reason to a neutral StopReason", () => {
    expect(mapStop("stop")).toBe("stop_sequence"); // DESIGN-mandated; loop-equivalent to end_turn
    expect(mapStop("length")).toBe("max_tokens");
    expect(mapStop("tool_calls")).toBe("tool_use");
    expect(mapStop("function_call")).toBe("tool_use");
    expect(mapStop("content_filter")).toBe("refusal");
    expect(mapStop(null)).toBe("end_turn");
    expect(mapStop(undefined)).toBe("end_turn");
    expect(mapStop("something_new")).toBe("end_turn"); // safe default
  });
});

describe("mapRequest", () => {
  test("system leads, tool_call→assistant.tool_calls[], tool_result→{role:tool}, thinking dropped", () => {
    const params = mapRequest(baseReq());
    const msgs = params.messages as unknown as Array<Record<string, unknown>>;

    // system is the FIRST message (leading).
    expect(msgs[0]).toMatchObject({ role: "system", content: "you are helpful" });

    // user text message.
    expect(msgs[1]).toMatchObject({ role: "user", content: "hi" });

    // assistant: text + tool_calls[]; NO thinking block survives.
    const assistant = msgs[2];
    expect(assistant?.["role"]).toBe("assistant");
    const toolCalls = assistant?.["tool_calls"] as Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ id: "tc1", type: "function" });
    expect(toolCalls[0]?.function).toEqual({ name: "echo", arguments: '{"msg":"hi"}' });
    // Assistant text joined; no vendor thinking field.
    expect(assistant).not.toHaveProperty("thinking");

    // tool_result expanded into a separate {role:"tool", tool_call_id} message.
    expect(msgs[3]).toMatchObject({ role: "tool", tool_call_id: "tc1", content: "echoed" });

    // tools → function tools with parameters = inputSchema.jsonSchema.
    const tools = params.tools as unknown as Array<{ type: string; function: { name: string; parameters: unknown } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe("function");
    expect(tools[0]?.function.name).toBe("echo");
    expect(tools[0]?.function.parameters).toMatchObject({ type: "object" });

    // tool_choice auto → "auto"; stream + include_usage set.
    expect(params.tool_choice).toBe("auto");
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    // legacy (non-o-series) model uses max_tokens.
    expect(params).toHaveProperty("max_tokens", 1024);
  });

  test("tool_choice variants map to OpenAI option", () => {
    expect(mapRequest(baseReq({ config: { maxTokens: 1, toolChoice: { type: "any" } } })).tool_choice).toBe("required");
    expect(mapRequest(baseReq({ config: { maxTokens: 1, toolChoice: { type: "none" } } })).tool_choice).toBe("none");
    expect(
      mapRequest(baseReq({ config: { maxTokens: 1, toolChoice: { type: "tool", name: "echo" } } })).tool_choice,
    ).toEqual({ type: "function", function: { name: "echo" } });
  });

  test("o-series model: reasoning_effort emitted + max_completion_tokens (not max_tokens)", () => {
    const params = mapRequest(baseReq({ model: "o3-mini" })) as unknown as Record<string, unknown>;
    expect(params["reasoning_effort"]).toBe("high");
    expect(params["max_completion_tokens"]).toBe(1024);
    expect(params["max_tokens"]).toBeUndefined();
  });

  test("non-o-series model: reasoning_effort omitted even when effort set", () => {
    const params = mapRequest(baseReq({ model: "gpt-4o" })) as unknown as Record<string, unknown>;
    expect(params["reasoning_effort"]).toBeUndefined();
  });

  test("isOpenAISeries recognizes o-series / gpt-5", () => {
    expect(isOpenAISeries("o1")).toBe(true);
    expect(isOpenAISeries("o3-mini")).toBe(true);
    expect(isOpenAISeries("gpt-5")).toBe(true);
    expect(isOpenAISeries("gpt-4o")).toBe(false);
  });
});

describe("mapStream", () => {
  test("text + indexed tool_call: arguments accumulated; message_end deferred to usage chunk", async () => {
    const chunks = [
      ck({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ delta: { role: "assistant" } }] }),
      ck({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ delta: { content: "Hello" } }] }),
      ck({
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "echo", arguments: '{"msg":"' } }] } }],
      }),
      ck({
        id: "chatcmpl-1",
        model: "gpt-4o",
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'hi"}' } }] } }],
      }),
      ck({ id: "chatcmpl-1", model: "gpt-4o", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      // usage-only final chunk: empty choices + usage.
      ck({ id: "chatcmpl-1", model: "gpt-4o", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    ];

    const out = await collect(mapStream((async function* () { for (const c of chunks) yield c; })()));

    expect(out.map((c) => c.type)).toEqual([
      "message_start",
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_delta",
      "tool_call_end",
      "message_delta",
      "message_end",
    ]);

    const deltas = out.filter((c) => c.type === "tool_call_delta");
    expect(deltas[0]).toMatchObject({ toolCallId: "call_0", inputJsonDelta: '{"msg":"' });
    expect(deltas[1]).toMatchObject({ toolCallId: "call_0", inputJsonDelta: 'hi"}' });

    const end = out.find((c) => c.type === "message_end");
    expect(end).toMatchObject({ stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } });
  });

  test("fallback message_end with zeroed usage when include_usage absent", async () => {
    const chunks = [
      ck({ id: "chatcmpl-2", model: "gpt-4o", choices: [{ delta: { content: "hi" } }] }),
      ck({ id: "chatcmpl-2", model: "gpt-4o", choices: [{ delta: {}, finish_reason: "stop" }] }),
      // no usage chunk — stream just ends.
    ];
    const out = await collect(mapStream((async function* () { for (const c of chunks) yield c; })()));
    const ends = out.filter((c) => c.type === "message_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ stopReason: "stop_sequence", usage: { inputTokens: 0, outputTokens: 0 } });
  });

  test("synthesizes a stable toolCallId when start delta omits id", async () => {
    const chunks = [
      ck({ id: "m", model: "gpt-4o", choices: [{ delta: { tool_calls: [{ index: 2, function: { name: "echo", arguments: "{}" } }] } }] }),
      ck({ id: "m", model: "gpt-4o", choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ck({ id: "m", model: "gpt-4o", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    ];
    const out = await collect(mapStream((async function* () { for (const c of chunks) yield c; })()));
    const start = out.find((c) => c.type === "tool_call_start");
    expect(start).toMatchObject({ toolCallId: "call_openai_2", name: "echo" });
  });

  test("source rejection is re-thrown as a classified ProviderError", async () => {
    const iter = (async function* (): AsyncIterable<ChatCompletionChunk> {
      throw Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "2" }) });
    })();
    const map = mapStream(iter);
    await expect(async () => {
      for await (const _c of map) void _c;
    }).rejects.toMatchObject({ name: "ProviderError", status: 429, retryable: true, retryAfterMs: 2000 });
  });
});

describe("mapUsage", () => {
  test("maps prompt/completion tokens + reasoning detail", () => {
    expect(mapUsage({ prompt_tokens: 12, completion_tokens: 7 })).toEqual({ inputTokens: 12, outputTokens: 7 });
    const withReasoning = mapUsage({ prompt_tokens: 1, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 } });
    expect(withReasoning.reasoningTokens).toBe(4);
  });
  test("null → zeroed", () => {
    expect(mapUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("parseRetryAfter", () => {
  test("delta-seconds / HTTP-date / garbage", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    const future = new Date(Date.now() + 8000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("garbage123")).toBeUndefined();
  });
});

describe("enrichError / isRetryableStatus", () => {
  const mkErr = (status: number, retryAfter?: string): unknown =>
    Object.assign(new Error(`HTTP ${status}`), {
      status,
      headers: retryAfter !== undefined ? new Headers(retryAfter ? { "retry-after": retryAfter } : {}) : null,
    });

  test("429 → retryable + retryAfterMs", () => {
    const e = enrichError(mkErr(429, "3")) as Error & { retryable?: boolean; status?: number; retryAfterMs?: number };
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(3000);
    expect(e.name).toBe("ProviderError");
  });

  test("400 → NOT retryable (overflow surfaces here as non-retryable)", () => {
    const e = enrichError(mkErr(400)) as Error & { retryable?: boolean };
    expect(e.retryable).toBe(false);
  });

  test("network error (no status) → retryable", () => {
    const e = enrichError(new Error("fetch failed")) as Error & { retryable?: boolean; status?: number };
    expect(e.retryable).toBe(true);
    expect(e.status).toBeUndefined();
  });

  test("isRetryableStatus", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(undefined)).toBe(false);
  });

  test("abort error → re-thrown unchanged (never wrapped as a retryable ProviderError)", () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    let thrown: unknown;
    try {
      enrichError(abortErr);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(abortErr);
  });
});

describe("OpenAIProvider capabilities", () => {
  test("stopReasons omit pause_turn; context_window_exceeded included (overflow tagged via code → routed to compact)", () => {
    const p = new OpenAIProvider({ apiKey: "test" });
    expect([...p.capabilities.stopReasons]).toEqual([
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "refusal",
      "context_window_exceeded",
    ]);
  });

  test("countTokens is a char/4 heuristic", async () => {
    const p = new OpenAIProvider({ apiKey: "test" });
    const n = await p.countTokens(
      [{ id: "x", role: "user", content: "12345678", createdAt: 0 }],
      "gpt-4o",
    );
    expect(n).toBe(2); // 8 chars / 4
  });
});

describe("no vendor fields leak into core output", () => {
  test("mapStream emits only neutral ProviderChunk shapes", async () => {
    const chunks = [
      ck({ id: "m", model: "gpt-4o", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
      ck({ id: "m", model: "gpt-4o", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    ];
    const out = await collect(mapStream((async function* () { for (const c of chunks) yield c; })()));
    // Every emitted chunk is JSON-serializable & carries no openai-only field names.
    const serialized = JSON.stringify(out);
    for (const banned of ["tool_use_id", "input_schema", "cache_control", "finish_reason", "prompt_tokens"]) {
      expect(serialized).not.toContain(banned);
    }
  });
});

describe("parseSSE", () => {
  test("parses data: lines and stops at [DONE]", async () => {
    const body = [
      'data: {"id":"a","choices":[]}\n\n',
      'data: {"id":"b","choices":[]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const out: ChatCompletionChunk[] = [];
    for await (const c of parseSSE(sseBody([body]))) out.push(c);
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("survives byte-at-a-time partial reads", async () => {
    const body = 'data: {"id":"x","choices":[]}\n\ndata: [DONE]\n\n';
    const out: ChatCompletionChunk[] = [];
    for await (const c of parseSSE(sseBodyDrip(body))) out.push(c);
    expect(out.map((c) => c.id)).toEqual(["x"]);
  });

  test("skips malformed JSON payloads without dying", async () => {
    const body = 'data: {not json}\n\ndata: {"id":"ok","choices":[]}\n\ndata: [DONE]\n\n';
    const out: ChatCompletionChunk[] = [];
    for await (const c of parseSSE(sseBody([body]))) out.push(c);
    expect(out.map((c) => c.id)).toEqual(["ok"]);
  });

  test("data: without leading space is parsed", async () => {
    const body = 'data:{"id":"n","choices":[]}\n\ndata: [DONE]\n\n';
    const out: ChatCompletionChunk[] = [];
    for await (const c of parseSSE(sseBody([body]))) out.push(c);
    expect(out.map((c) => c.id)).toEqual(["n"]);
  });
});

describe("OpenAIProvider.stream over fetch", () => {
  test("end-to-end: request body + SSE → ProviderChunk stream", async () => {
    let posted: { url: string; body: Record<string, unknown>; auth: string | undefined } | undefined;
    const fetchMock = async (url: string, init: FetchInit) => {
      posted = {
        url,
        body: JSON.parse(init.body) as Record<string, unknown>,
        auth: init.headers.Authorization,
      };
      const sse = [
        'data: {"id":"m","model":"gpt-4o","choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"id":"m","model":"gpt-4o","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"id":"m","model":"gpt-4o","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return sseResponse([sse]);
    };
    const p = new OpenAIProvider({ apiKey: "sk-test", baseURL: "https://example.test/v1", fetch: fetchMock as unknown as typeof fetch });
    const out = await collect(p.stream(baseReq()));

    expect(posted?.url).toBe("https://example.test/v1/chat/completions");
    expect(posted?.body.model).toBe("gpt-4o");
    expect(posted?.body.stream).toBe(true);
    expect(posted?.body.stream_options).toEqual({ include_usage: true });
    expect(posted?.auth).toBe("Bearer sk-test");

    const end = out.find((c) => c.type === "message_end");
    expect(end).toMatchObject({ stopReason: "stop_sequence", usage: { inputTokens: 3, outputTokens: 1 } });
    expect(out.filter((c) => c.type === "text_delta").map((c) => (c as { text: string }).text).join("")).toBe("Hi");
  });

  test("HTTP 429 → classified ProviderError with retryAfterMs", async () => {
    const fetchMock = async () => new Response("rate limited", { status: 429, headers: { "retry-after": "4" } });
    const p = new OpenAIProvider({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(async () => {
      for await (const _c of p.stream(baseReq())) void _c;
    }).rejects.toMatchObject({ name: "ProviderError", status: 429, retryable: true, retryAfterMs: 4000 });
  });

  test("network error (fetch rejects) → retryable ProviderError", async () => {
    const fetchMock = async () => {
      throw new TypeError("fetch failed");
    };
    const p = new OpenAIProvider({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    await expect(async () => {
      for await (const _c of p.stream(baseReq())) void _c;
    }).rejects.toMatchObject({ name: "ProviderError", retryable: true });
  });

  test("extra providerOptions headers are forwarded", async () => {
    let got: Record<string, string> | undefined;
    const fetchMock = async (_url: string, init: FetchInit) => {
      got = init.headers;
      return sseResponse(['data: {"id":"m","choices":[]}\n\ndata: [DONE]\n\n']);
    };
    const p = new OpenAIProvider({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    for await (const _c of p.stream(baseReq({ config: { maxTokens: 1, providerOptions: { headers: { "OpenAI-Beta": "x" } } } }))) void _c;
    expect(got?.["OpenAI-Beta"]).toBe("x");
  });
});

describe("OpenAIProvider.complete over fetch", () => {
  test("non-streaming response → ProviderResponse", async () => {
    const fetchMock = async () =>
      new Response(
        JSON.stringify({
          id: "chat-1",
          model: "gpt-4o",
          choices: [
            {
              message: { role: "assistant", content: "hello", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{}" } }] },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const p = new OpenAIProvider({ apiKey: "k", fetch: fetchMock as unknown as typeof fetch });
    const res = await p.complete(baseReq());
    expect(res.stopReason).toBe("tool_use");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(res.message.id).toBe("chat-1");
    expect(Array.isArray(res.message.content)).toBe(true);
  });
});


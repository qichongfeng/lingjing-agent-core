import { describe, expect, test } from "vitest";
import {
  createAgent,
  extractText,
  type AgentEvent,
  type ContextManager,
  type LLMProvider,
  type Message,
  type ProviderChunk,
  type ProviderRequest,
  type StreamHandle,
  type Tool,
} from "../src/index.js";
import { computeBackoff } from "../src/loop.js";
import {
  FakeProvider,
  scriptedProvider,
  textTurn,
  toolCallTurn,
  pauseTurn,
  cweTurn,
  failingThenRecover,
  echoTool,
  allowGate,
  denyGate,
  modifyingGate,
  recordingHooks,
  vetoingHook,
  inputRewritingHook,
} from "./helpers/index.js";

async function collect(handle: StreamHandle): Promise<{ events: AgentEvent[]; message?: Message; error?: unknown }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  try {
    return { events, message: await handle.done };
  } catch (error) {
    return { events, error };
  }
}
const findDone = (es: AgentEvent[]) => es.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }> | undefined;
const findError = (es: AgentEvent[]) => es.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
const findPermission = (es: AgentEvent[]) => es.find((e) => e.type === "permission_request") as Extract<AgentEvent, { type: "permission_request" }> | undefined;
const resultText = (e: Extract<AgentEvent, { type: "tool_result" }>): string =>
  e.content.map((b: unknown) => (b as { text?: string }).text ?? "").join("");

function guardedTool(): Tool {
  return {
    name: "guarded",
    description: "guarded",
    inputSchema: { jsonSchema: { type: "object" } },
    requiresConfirmation: true,
    async execute() {
      return { content: "ran" };
    },
  };
}

function makeShrinkingContext(): { mgr: ContextManager; calls: { fit: number; compact: number } } {
  const calls = { fit: 0, compact: 0 };
  const mgr: ContextManager = {
    async fit(input) {
      calls.fit++;
      return { messages: input.messages, compacted: false };
    },
    async compact(input) {
      calls.compact++;
      return { messages: input.messages.slice(-2), compacted: true };
    },
  };
  return { mgr, calls };
}

describe("pause_turn", () => {
  test("continues to the next turn (server resumes)", async () => {
    const provider = scriptedProvider([pauseTurn("p"), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 10 });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(message && extractText(message)).toBe("ok");
    expect(findDone(events)?.turns).toBe(2);
    expect(events.filter((e) => e.type === "turn_end").length).toBe(2);
  });

  test("exhausted continuations terminates with max_continuations_exceeded", async () => {
    const provider = scriptedProvider([
      pauseTurn("p"), pauseTurn("p"), pauseTurn("p"),
      pauseTurn("p"), pauseTurn("p"), pauseTurn("p"),
      textTurn("never"),
    ]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 50 });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findError(events)?.code).toBe("max_continuations_exceeded");
    expect(findError(events)?.recoverable).toBe(true);
    expect(findDone(events)).toBeDefined();
  });
});

describe("context_window_exceeded", () => {
  test("with a context manager: compacts and recovers; emits context_compacted{reason:'overflow'}", async () => {
    const { mgr, calls } = makeShrinkingContext();
    const provider = scriptedProvider([cweTurn("cwe"), textTurn("recovered")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 10, context: mgr });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(message && extractText(message)).toBe("recovered");
    expect(calls.compact).toBeGreaterThanOrEqual(1);
    expect(findDone(events)?.turns).toBe(2);
    const compacted = events.filter((e): e is Extract<AgentEvent, { type: "context_compacted" }> => e.type === "context_compacted");
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(compacted.every((e) => e.reason === "overflow")).toBe(true);
  });

  test("soft compaction at fit time emits context_compacted{reason:'soft', tokensSaved}", async () => {
    const mgr: ContextManager = {
      async fit(input) {
        return { messages: input.messages.slice(-2), compacted: true, tokensSaved: 42 };
      },
      async compact(input) {
        return { messages: input.messages, compacted: false };
      },
    };
    const provider = scriptedProvider([textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 3, context: mgr });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    const compacted = events.filter((e): e is Extract<AgentEvent, { type: "context_compacted" }> => e.type === "context_compacted");
    expect(compacted).toEqual([
      { type: "context_compacted", conversationId: "c", turn: 1, ts: expect.any(Number), reason: "soft", tokensSaved: 42 },
    ]);
  });

  test("beforeRequest sees ctx.compacted=true only on the first request after compaction", async () => {
    const seen: boolean[] = [];
    let compactOnce = false;
    const mgr: ContextManager = {
      async fit(input) {
        if (!compactOnce) {
          compactOnce = true;
          return { messages: input.messages, compacted: true };
        }
        return { messages: input.messages, compacted: false };
      },
      async compact(input) {
        return { messages: input.messages, compacted: false };
      },
    };
    const provider = scriptedProvider([toolCallTurn("echo", {}), textTurn("ok")]);
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, context: mgr, tools: [echoTool()],
      hooks: {
        beforeRequest: async (ctx) => {
          seen.push(ctx.compacted === true);
        },
      },
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(seen).toEqual([true, false]); // turn 1 follows the compaction, turn 2 doesn't
  });

  test("overflow compaction: the retry turn's beforeRequest sees ctx.compacted=true", async () => {
    const seen: boolean[] = [];
    const { mgr } = makeShrinkingContext();
    const provider = scriptedProvider([cweTurn("cwe"), textTurn("recovered")]);
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, context: mgr,
      hooks: {
        beforeRequest: async (ctx) => {
          seen.push(ctx.compacted === true);
        },
      },
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(seen).toEqual([false, true]); // turn 1 normal; retry-after-compact carries the flag
  });

  test("without a context manager: terminal context_overflow with done", async () => {
    const provider = scriptedProvider([cweTurn("cwe"), textTurn("never")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 10 });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findError(events)?.code).toBe("context_overflow");
    expect(findError(events)?.recoverable).toBe(false);
    expect(findDone(events)).toBeDefined();
    expect(findDone(events)?.turns).toBe(1);
  });
});

describe("retry / backoff", () => {
  test("recovers after a transient provider error (same turn)", async () => {
    const err = Object.assign(new Error("rate limited"), { retryable: true, status: 429 });
    const provider = new FakeProvider(failingThenRecover(err, [textTurn("ok")]));
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    });
    const { events, message, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(error).toBeUndefined();
    expect(message && extractText(message)).toBe("ok");
    expect(findDone(events)?.turns).toBe(1);
    expect(findError(events)).toBeUndefined();
  });

  test("exhausted retries terminate with provider_error", async () => {
    const err = Object.assign(new Error("rate limited"), { retryable: true, status: 429 });
    const provider = new FakeProvider(() => Promise.reject(err));
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(error).toBeDefined();
    expect(findError(events)?.code).toBe("provider_error");
    expect(findError(events)?.recoverable).toBe(false);
    expect(findDone(events)).toBeUndefined();
  });
});

describe("computeBackoff", () => {
  // Equal-part jitter: every result lands in [chosen/2, chosen] (never past
  // the hint), capped at maxDelayMs. Assert ranges, not exact values.
  test("exponential (jittered to [base/2, base]) when no retryAfterMs", () => {
    for (let i = 0; i < 50; i++) {
      expect(computeBackoff({}, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBeGreaterThanOrEqual(500);
      expect(computeBackoff({}, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBeLessThanOrEqual(1000);
      expect(computeBackoff({}, 2, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBeGreaterThanOrEqual(2000);
      expect(computeBackoff({}, 2, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBeLessThanOrEqual(4000);
    }
  });
  test("retryAfterMs is the upper bound (jittered down), still capped at maxDelayMs", () => {
    for (let i = 0; i < 50; i++) {
      const withHint = computeBackoff({ retryAfterMs: 500 }, 0, { baseDelayMs: 1000, maxDelayMs: 30000 });
      expect(withHint).toBeGreaterThanOrEqual(250);
      expect(withHint).toBeLessThanOrEqual(500);
    }
    // Hint above the cap stays pinned at the cap after jitter + cap.
    expect(computeBackoff({ retryAfterMs: 100000 }, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(30000);
  });
  test("falls back to exponential when retryAfterMs is not finite", () => {
    for (const bad of [{ retryAfterMs: NaN }, { retryAfterMs: undefined }]) {
      const d = computeBackoff(bad, 0, { baseDelayMs: 1000, maxDelayMs: 30000 });
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
});

describe("permission gate", () => {
  test("allow: tool executes after approval", async () => {
    const provider = scriptedProvider([toolCallTurn("guarded", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [guardedTool()], permissionGate: allowGate() });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findPermission(events)).toBeDefined();
    expect(events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
    expect(message && extractText(message)).toBe("ok");
  });

  test("deny: tool_result isError with reason; loop continues", async () => {
    const provider = scriptedProvider([toolCallTurn("guarded", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [guardedTool()], permissionGate: denyGate("nope") });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findPermission(events)).toBeDefined();
    const r = events.find((e) => e.type === "tool_result" && e.isError) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(r).toBeDefined();
    expect(resultText(r as Extract<AgentEvent, { type: "tool_result" }>)).toContain("Denied: nope");
    expect(message && extractText(message)).toBe("ok");
  });

  test("modifiedInput rewrites the input passed to execute", async () => {
    let received: unknown;
    const recordingGuarded: Tool = {
      name: "guarded", description: "guarded",
      inputSchema: { jsonSchema: { type: "object" } },
      requiresConfirmation: true,
      async execute(input) { received = input; return { content: "ran" }; },
    };
    const provider = scriptedProvider([toolCallTurn("guarded", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [recordingGuarded], permissionGate: modifyingGate({ x: 9 }) });
    const { message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(JSON.stringify(received)).toBe(JSON.stringify({ x: 9 }));
    void message;
  });

  test("no gate + requiresConfirmation is denied by default", async () => {
    const provider = scriptedProvider([toolCallTurn("guarded", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [guardedTool()] });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    const r = events.find((e) => e.type === "tool_result" && e.isError) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(r).toBeDefined();
    expect(resultText(r as Extract<AgentEvent, { type: "tool_result" }>)).toContain("requires confirmation");
    expect(message && extractText(message)).toBe("ok");
  });

  test("gate modifiedInput is re-validated against the schema (a gate cannot bypass it)", async () => {
    const strict: Tool = {
      name: "guarded",
      description: "guarded",
      inputSchema: {
        jsonSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
          additionalProperties: false,
        },
      },
      requiresConfirmation: true,
      async execute() {
        return { content: "ran" };
      },
    };
    const provider = scriptedProvider([toolCallTurn("guarded", { x: 1 }, 0), textTurn("ok")]);
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, tools: [strict],
      permissionGate: modifyingGate({ nope: true }), // schema-violating rewrite
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    const r = events.find((e) => e.type === "tool_result" && e.isError) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(r).toBeDefined();
    expect(resultText(r!)).toContain("Invalid modified input");
    expect(message && extractText(message)).toBe("ok");
  });
});

describe("hooks", () => {
  test("beforeToolCall veto produces isError tool_result", async () => {
    const provider = scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [echoTool()], hooks: vetoingHook("vetoed") });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    const r = events.find((e) => e.type === "tool_result" && e.isError) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(r).toBeDefined();
    expect(resultText(r as Extract<AgentEvent, { type: "tool_result" }>)).toContain("Vetoed by beforeToolCall: vetoed");
    expect(message && extractText(message)).toBe("ok");
  });

  test("beforeToolCall modifiedInput rewrites tool input", async () => {
    const provider = scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [echoTool()], hooks: inputRewritingHook({ hello: "modified" }) });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    const r = events.find((e) => e.type === "tool_result" && !e.isError) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(r).toBeDefined();
    expect(resultText(r as Extract<AgentEvent, { type: "tool_result" }>)).toContain('{"hello":"modified"}');
  });

  test("execution order across a tool_use turn", async () => {
    const { hooks, log } = recordingHooks();
    const provider = scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [echoTool()], hooks });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(log.map((h) => h.type)).toEqual([
      "beforeRequest",
      "afterTurn",
      "beforeToolCall",
      "afterToolCall",
      "beforeRequest",
      "afterTurn",
    ]);
    expect(log.map((h) => h.stopReason ?? null)).toEqual([
      null, "tool_use", null, null, null, "end_turn",
    ]);
  });

  test("afterToolCall hook errors surface through the configured logger, not silence", async () => {
    const logs: Array<[string, string]> = [];
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [echoTool()],
      logger: (level, msg) => { logs.push([level, msg]); },
      hooks: { afterToolCall: async () => { throw new Error("hook boom"); } },
    });
    const { message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]![0]).toBe("warn");
    expect(logs[0]![1]).toContain("afterToolCall");
    expect(message && extractText(message)).toBe("ok"); // the run itself is unaffected
  });
});

describe("core review fixes", () => {
  test("retries only before the first chunk (pre-stream failure recovers, no replay)", async () => {
    let attempt = 0;
    const provider: LLMProvider = {
      id: "pre-stream-fail",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream() {
        const mine = attempt++;
        return (async function* (): AsyncIterable<ProviderChunk> {
          if (mine === 0) {
            // Reject BEFORE yielding any chunk → safe to retry (nothing emitted).
            throw Object.assign(new Error("transient"), { retryable: true, status: 503 });
          }
          yield { type: "message_start", messageId: "m", model: "fake" };
          yield { type: "text_delta", text: "ok" };
          yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })();
      },
    };
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as Extract<AgentEvent, { type: "text_delta" }>).text)
      .join("");
    expect(text).toBe("ok");
    expect(message && extractText(message)).toBe("ok");
  });

  test("mid-stream failure (after first chunk) is terminal; partial output retained (no replay)", async () => {
    const provider: LLMProvider = {
      id: "mid-stream-fail",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream() {
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "m", model: "fake" };
          yield { type: "text_delta", text: "PARTIAL" };
          throw Object.assign(new Error("mid-stream"), { retryable: true, status: 503 });
        })();
      },
    };
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(error).toBeDefined();
    expect(findError(events)?.code).toBe("provider_error"); // terminal — not retried
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as Extract<AgentEvent, { type: "text_delta" }>).text)
      .join("");
    expect(text).toBe("PARTIAL"); // partial stays with consumer (no rollback, no replay)
  });

  test("provider without countTokens: fit still gets a heuristic estimate (char/4), not 0", async () => {
    let fitTokens = -1;
    const mgr: ContextManager = {
      async fit(input) {
        fitTokens = await input.countTokens(input.messages);
        return { messages: input.messages, compacted: false };
      },
      async compact(input) {
        return { messages: input.messages, compacted: false };
      },
    };
    const provider = scriptedProvider([textTurn("ok")]); // FakeProvider has no countTokens
    const agent = createAgent({ provider, model: "fake", maxTurns: 3, context: mgr });
    await collect(agent.stream("x".repeat(400), { conversationId: "c" }));
    expect(fitTokens).toBe(100); // 400 chars / 4, not 0
  });

  test("overflow via thrown code: compact once, then terminate on second overflow", async () => {
    const { mgr, calls } = makeShrinkingContext();
    const provider: LLMProvider = {
      id: "overflow-throw",
      capabilities: { stopReasons: ["context_window_exceeded", "end_turn"], streaming: true },
      stream() {
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "m", model: "fake" };
          throw Object.assign(new Error("context_length_exceeded"), {
            code: "context_length_exceeded", retryable: false, status: 400,
          });
        })();
      },
    };
    const agent = createAgent({ provider, model: "fake", maxTurns: 10, context: mgr });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(calls.compact).toBe(1);
    expect(findError(events)?.code).toBe("context_overflow");
  });
});

describe("real-usage context anchor", () => {
  function recordingContext(): { mgr: ContextManager; fits: Array<{ currentTokens?: number; tokenBudget: number; model?: string }> } {
    const fits: Array<{ currentTokens?: number; tokenBudget: number; model?: string }> = [];
    const mgr: ContextManager = {
      async fit(input) {
        fits.push({ ...(input.currentTokens !== undefined ? { currentTokens: input.currentTokens } : {}), tokenBudget: input.tokenBudget });
        return { messages: input.messages, compacted: false };
      },
      async compact(input) {
        fits.push({ ...(input.currentTokens !== undefined ? { currentTokens: input.currentTokens } : {}), tokenBudget: input.tokenBudget });
        return { messages: input.messages, compacted: false };
      },
    };
    return { mgr, fits };
  }

  function bigUsageProvider(inputTokens: number): LLMProvider {
    return new FakeProvider((_req, turn) => [
      { type: "message_start", messageId: `m${turn}`, model: "fake" },
      { type: "text_delta", text: "回复内容" },
      { type: "message_end", stopReason: "end_turn", usage: { inputTokens, outputTokens: 3 } },
    ]);
  }

  test("fit gets anchored currentTokens: undefined on turn 1, real usage + increment afterwards", async () => {
    const { mgr, fits } = recordingContext();
    const agent = createAgent({ provider: bigUsageProvider(5000), model: "fake", context: mgr, contextTokenBudget: 1_000_000 });
    const conv = agent.conversation("anchor-1");
    await collect(conv.send("你好"));
    expect(fits[0]?.currentTokens).toBeUndefined(); // no anchor before the first response
    await collect(conv.send("第二句"));
    // Second run seeds the anchor from the persisted assistant's stamped usage
    // (5000 covered the first request), then adds the increment: the reply +
    // this send's input.
    expect(fits[1]?.currentTokens).toBeGreaterThan(5000);
    // And it keeps re-anchoring on each fresh response.
    await collect(conv.send("第三句"));
    expect(fits[2]?.currentTokens).toBeGreaterThan(5000);
  });

  test("turn_end carries the anchored contextTokens for host usage meters", async () => {
    const agent = createAgent({ provider: bigUsageProvider(5000), model: "fake", contextTokenBudget: 1_000_000 });
    const conv = agent.conversation("anchor-2");
    const { events } = await collect(conv.send("你好"));
    const te = events.find((e) => e.type === "turn_end") as Extract<AgentEvent, { type: "turn_end" }>;
    expect(te.contextTokens).toBeGreaterThan(5000); // anchor + the reply itself
  });

  test("token budget follows models.contextWindow for the turn's model", async () => {
    const { mgr, fits } = recordingContext();
    const agent = createAgent({
      provider: bigUsageProvider(5),
      models: { main: "m-main", fast: "m-fast", contextWindow: { main: 250_000, fast: 128_000 } },
      modelFor: () => "m-fast",
      context: mgr,
    });
    await collect(agent.stream("你好", { conversationId: "anchor-3" }));
    expect(fits[0]?.tokenBudget).toBe(128_000); // fast tier's window, not the 250k default
    // An explicit contextTokenBudget still wins over the tier table.
    const { mgr: mgr2, fits: fits2 } = recordingContext();
    const agent2 = createAgent({
      provider: bigUsageProvider(5),
      models: { main: "m-main", contextWindow: { main: 250_000 } },
      contextTokenBudget: 42_000,
      context: mgr2,
    });
    await collect(agent2.stream("你好", { conversationId: "anchor-4" }));
    expect(fits2[0]?.tokenBudget).toBe(42_000);
  });
});

describe("unparseable tool arguments", () => {
  test("diagnosis instead of the cryptic schema error", async () => {
    // write_file 式大参数调用:arguments 是截断/非法的 JSON,parse 失败 →
    // input undefined(仅此一处会设 undefined;空 arguments 走 {})。模型
    // 看到的必须是指向输出上限的诊断,不是 "$: expected object, got
    // undefined"。(max_tokens 停止的轮不执行工具、直接回喂续写,所以
    // 执行到这里的坏参数都发生在 tool_use 停止下。)
    const broken: ProviderChunk[] = [
      { type: "tool_call_start", toolCallId: "tc-cut", name: "echo" },
      { type: "tool_call_delta", toolCallId: "tc-cut", inputJsonDelta: '{"path":"snake.html","content":"<html>…' },
      { type: "tool_call_end", toolCallId: "tc-cut" },
      { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const agent = createAgent({ provider: scriptedProvider([broken, textTurn("ok")]), model: "fake", tools: [echoTool()] });
    const { events } = await collect(agent.stream("写个游戏", { conversationId: "trunc-1" }));
    const tr = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(tr).toBeTruthy();
    expect(tr?.isError).toBe(true);
    const text = resultText(tr!);
    expect(text).toContain("not valid JSON");
    expect(text).toContain("maxTokens");
    expect(text).not.toContain("expected object");
  });
});

describe("max_tokens salvage", () => {
  test("a max_tokens partial persists text but NO tool_call blocks (no unanswered tool_use on replay)", async () => {
    // write_file 式大参数调用被输出上限截断:max_tokens 轮不执行工具、直接
    // 回喂续写。partial 里的 tool_call(解析成功与否都一样)不能进历史——
    // 否则它成为永远等不到 tool_result 的 tool_use,续写之后的请求在
    // Anthropic/OpenAI 严格校验下直接 400。与 abort salvage 同一条规则:
    // 文本存活,调用由模型续写时重新决定。
    const truncated: ProviderChunk[] = [
      { type: "message_start", messageId: "m-cut", model: "fake" },
      { type: "text_delta", text: "让我写入文件" },
      { type: "tool_call_start", toolCallId: "tc-cut", name: "echo" },
      { type: "tool_call_delta", toolCallId: "tc-cut", inputJsonDelta: '{"path":"snake.html","content":"<html>…' },
      { type: "tool_call_end", toolCallId: "tc-cut" },
      { type: "message_end", stopReason: "max_tokens", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const reqs: ProviderRequest[] = [];
    const provider = new FakeProvider((req, turn) => {
      reqs.push(req);
      return turn === 0 ? truncated : textTurn("done");
    });
    const agent = createAgent({ provider, model: "fake", tools: [echoTool()] });
    const conv = agent.conversation("mt-cut");
    const { events, message } = await collect(conv.send("写个游戏"));
    expect(extractText(message!)).toBe("done");
    // The truncated call was never executed...
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.some((e) => e.type === "tool_result")).toBe(false);
    // ...and the continuation request replays the partial WITHOUT the call.
    const turn2 = reqs[1]!.messages;
    const hasToolCall = turn2.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_call"),
    );
    expect(hasToolCall).toBe(false);
    expect(turn2.some((m) => extractText(m) === "让我写入文件")).toBe(true);
  });
});

describe("confirm (agent-level override)", () => {
  test('"always" sends undeclared (read-class) tools through the gate', async () => {
    const provider = scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]);
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, tools: [echoTool()],
      confirm: "always", permissionGate: allowGate(),
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findPermission(events)).toBeDefined();
    expect(events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
    expect(message && extractText(message)).toBe("ok");
  });

  test('"never" skips the gate for tools that declare requiresConfirmation', async () => {
    const provider = scriptedProvider([toolCallTurn("guarded", {}, 0), textTurn("ok")]);
    // denyGate would deny if it were consulted — the run proves it never was.
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, tools: [guardedTool()],
      confirm: "never", permissionGate: denyGate("nope"),
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findPermission(events)).toBeUndefined();
    expect(events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
    expect(message && extractText(message)).toBe("ok");
  });

  test('"always" with no gate refuses every call', async () => {
    const provider = scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]);
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, tools: [echoTool()], confirm: "always",
    });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    const r = events.find((e) => e.type === "tool_result" && e.isError) as Extract<AgentEvent, { type: "tool_result" }> | undefined;
    expect(r).toBeDefined();
    expect(resultText(r!)).toContain("requires confirmation");
    expect(resultText(r!)).toContain('confirm = "always"');
  });

  test('"tool" default: undeclared tools run without consulting the gate', async () => {
    const provider = scriptedProvider([toolCallTurn("echo", {}, 0), textTurn("ok")]);
    const agent = createAgent({
      provider, model: "fake", maxTurns: 5, tools: [echoTool()], permissionGate: denyGate("nope"),
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findPermission(events)).toBeUndefined();
    expect(events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
    expect(message && extractText(message)).toBe("ok");
  });
});

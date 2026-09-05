import { describe, expect, test } from "vitest";
import {
  createAgent,
  extractText,
  type AgentEvent,
  type ContextManager,
  type LLMProvider,
  type Message,
  type ProviderChunk,
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
  test("with a context manager: compacts and recovers", async () => {
    const { mgr, calls } = makeShrinkingContext();
    const provider = scriptedProvider([cweTurn("cwe"), textTurn("recovered")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 10, context: mgr });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(message && extractText(message)).toBe("recovered");
    expect(calls.compact).toBeGreaterThanOrEqual(1);
    expect(findDone(events)?.turns).toBe(2);
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
  test("exponential when no retryAfterMs", () => {
    expect(computeBackoff({}, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(1000);
    expect(computeBackoff({}, 2, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(4000);
  });
  test("honors retryAfterMs but caps at maxDelayMs", () => {
    expect(computeBackoff({ retryAfterMs: 500 }, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(500);
    expect(computeBackoff({ retryAfterMs: 100000 }, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(30000);
  });
  test("falls back to exponential when retryAfterMs is not finite", () => {
    expect(computeBackoff({ retryAfterMs: NaN }, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(1000);
    expect(computeBackoff({ retryAfterMs: undefined }, 0, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(1000);
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
      "afterResponse",
      "beforeToolCall",
      "afterToolCall",
      "beforeRequest",
      "afterResponse",
    ]);
    expect(log.map((h) => h.stopReason ?? null)).toEqual([
      null, "tool_use", null, null, null, "end_turn",
    ]);
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

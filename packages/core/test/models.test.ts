// Tiered models: config validation, per-turn availability fallback semantics,
// modelFor hook, per-send override, and auto-compact role routing. Fallback
// tests key on req.model (never FakeScript turn counters — fallback makes
// several stream() calls per turn).

import { describe, expect, test } from "vitest";
import {
  createAgent,
  extractText,
  type AgentEvent,
  type ContextManager,
  type LLMProvider,
  type MemoryStore,
  type Message,
  type ProviderChunk,
  type ProviderRequest,
  type StreamHandle,
} from "../src/index.js";
import { contextWindowFor, fallbackChain, isFallbackEligible } from "../src/models.js";
import { echoTool, textTurn, toolCallTurn } from "./helpers/index.js";

const FAST_RETRY = { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 };
const ONE_RETRY = { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 };

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
const fallbackEvents = (es: AgentEvent[]) =>
  es.filter((e): e is Extract<AgentEvent, { type: "model_fallback" }> => e.type === "model_fallback");

const err529 = () => Object.assign(new Error("overloaded"), { retryable: true, status: 529 });
const err429 = () => Object.assign(new Error("rate limited"), { retryable: true, status: 429 });
const errModelGone = () =>
  Object.assign(new Error("model not found"), { retryable: false, status: 404, code: "model_not_found" });

/** Inline provider that records req.model per stream() call and dispatches on
 *  it. Fallback mutates req.model between attempts of the SAME turn, so the
 *  record shows the true per-attempt model sequence. */
function trackingProvider(
  onStream: (req: ProviderRequest, call: number) => ProviderChunk[] | Promise<never>,
): { provider: LLMProvider; models: string[] } {
  const models: string[] = [];
  let call = 0;
  const provider: LLMProvider = {
    id: "tracking",
    capabilities: { stopReasons: ["end_turn", "tool_use"], streaming: true },
    stream(req) {
      models.push(req.model);
      const mine = call++;
      const out = onStream(req, mine);
      return (async function* (): AsyncIterable<ProviderChunk> {
        for (const c of await out) yield c;
      })();
    },
  };
  return { provider, models };
}

// ---------------------------------------------------------------- validation

describe("config validation", () => {
  test("throws when neither model nor models.main is set", () => {
    expect(() => createAgent({ provider: trackingProvider(() => textTurn("x")).provider })).toThrow(
      /requires a model/,
    );
  });

  test("throws when models is set without a main", () => {
    const { provider } = trackingProvider(() => textTurn("x"));
    expect(() => createAgent({ provider, models: { fast: "f" } as never })).toThrow(/models\.main/);
  });

  test("throws when model and models.main conflict", () => {
    const { provider } = trackingProvider(() => textTurn("x"));
    expect(() => createAgent({ provider, model: "a", models: { main: "b" } })).toThrow(/conflict/);
  });

  test("model === models.main is a valid alias; models without fast/max is valid", async () => {
    const { provider, models } = trackingProvider(() => textTurn("ok"));
    const agent = createAgent({ provider, model: "a", models: { main: "a" } });
    const { message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(message && extractText(message)).toBe("ok");
    expect(models).toEqual(["a"]);

    const bare = createAgent({ provider, models: { main: "m" }, retry: FAST_RETRY });
    const r = await collect(bare.stream("go", { conversationId: "c" }));
    expect(r.message && extractText(r.message)).toBe("ok");
  });
});

// ------------------------------------------------------------ tier fallback

describe("tier fallback", () => {
  test("529: same-model retries burn first, then step down; one fallback event", async () => {
    const { provider, models } = trackingProvider((req) => {
      if (req.model === "max-m") return Promise.reject(err529());
      return textTurn("ok");
    });
    const agent = createAgent({
      provider,
      models: { max: "max-m", main: "main-m", fast: "fast-m" },
      modelFor: () => "max-m", // start at the top tier → chain [max, main, fast]
      retry: ONE_RETRY,
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(models).toEqual(["max-m", "max-m", "main-m"]);
    expect(message && extractText(message)).toBe("ok");
    expect(findDone(events)?.turns).toBe(1);
    expect(fallbackEvents(events)).toEqual([
      { type: "model_fallback", conversationId: "c", turn: 1, ts: expect.any(Number), from: "max-m", to: "main-m", status: 529 },
    ]);
  });

  test("non-sticky: next turn starts from the default again", async () => {
    let mainFailed = false;
    const { provider, models } = trackingProvider((req) => {
      if (req.model === "main-m" && !mainFailed) {
        mainFailed = true; // turn 1's only main-m attempt fails once
        return Promise.reject(err529());
      }
      if (req.model === "fast-m") return toolCallTurn("echo", {});
      return textTurn("ok");
    });
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      tools: [echoTool()],
      retry: FAST_RETRY,
    });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(models).toEqual(["main-m", "fast-m", "main-m"]);
    expect(findDone(events)?.turns).toBe(2);
    expect(fallbackEvents(events).length).toBe(1);
  });

  test("429 never falls back (account-level quota is shared by every tier)", async () => {
    const { provider, models } = trackingProvider(() => Promise.reject(err429()));
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      retry: ONE_RETRY,
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(error).toBeDefined();
    expect(findError(events)?.code).toBe("provider_error");
    expect(models).toEqual(["main-m", "main-m"]);
    expect(fallbackEvents(events)).toEqual([]);
  });

  test("chain exhaustion throws the original error", async () => {
    const original = err529();
    const { provider, models } = trackingProvider(() => Promise.reject(original));
    const agent = createAgent({
      provider,
      models: { max: "a", main: "b", fast: "c" }, // default start = "b" → chain [b, c]
      retry: FAST_RETRY,
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(error).toBe(original); // the original object, not a wrapper
    expect(models).toEqual(["b", "c"]);
    expect(fallbackEvents(events).map((e) => [e.from, e.to])).toEqual([["b", "c"]]);
  });

  test("model_not_found (non-retryable) switches immediately — no same-model retry", async () => {
    const { provider, models } = trackingProvider((req) => {
      if (req.model === "main-m") return Promise.reject(errModelGone());
      return textTurn("ok");
    });
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 }, // would retry if it could
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(models).toEqual(["main-m", "fast-m"]); // exactly one main-m call
    expect(message && extractText(message)).toBe("ok");
    expect(fallbackEvents(events)[0]).toMatchObject({ from: "main-m", to: "fast-m", status: 404, code: "model_not_found" });
  });

  test("mid-stream failure (after first chunk) is terminal — no fallback, no replay", async () => {
    const provider: LLMProvider = {
      id: "mid-stream",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "m", model: req.model };
          yield { type: "text_delta", text: "PARTIAL" };
          throw Object.assign(new Error("mid-stream"), { retryable: true, status: 503 });
        })();
      },
    };
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      retry: ONE_RETRY,
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(error).toBeDefined();
    expect(findError(events)?.code).toBe("provider_error");
    expect(fallbackEvents(events)).toEqual([]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("PARTIAL");
  });

  test("model_fallback payload is JSON-safe and carries status+code when present", async () => {
    const { provider } = trackingProvider((req) => {
      if (req.model === "main-m") {
        return Promise.reject(Object.assign(new Error("overloaded"), { retryable: true, status: 503, code: "overloaded" }));
      }
      return textTurn("ok");
    });
    const agent = createAgent({ provider, models: { main: "main-m", fast: "fast-m" }, retry: FAST_RETRY });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    const ev = fallbackEvents(events)[0]!;
    expect(ev).toMatchObject({ from: "main-m", to: "fast-m", status: 503, code: "overloaded" });
    expect(() => JSON.parse(JSON.stringify(ev))).not.toThrow();
    expect(JSON.parse(JSON.stringify(ev))).toMatchObject({ type: "model_fallback", from: "main-m", to: "fast-m" });
  });

  test("start model not in the tiers gets a chain of one — no fallback", async () => {
    const { provider, models } = trackingProvider(() => Promise.reject(err529()));
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      retry: ONE_RETRY,
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c", model: "custom" }));
    expect(error).toBeDefined();
    expect(models).toEqual(["custom", "custom"]); // same-model retry still applies
    expect(fallbackEvents(events)).toEqual([]);
  });
});

// ----------------------------------------------------------------- modelFor

describe("modelFor", () => {
  test("consulted once per turn with {conversationId, turn, messages, defaultModel}; start carries the turn-1 model", async () => {
    const seen: Array<{ conversationId: string; turn: number; defaultModel: string }> = [];
    const { provider, models } = trackingProvider((req) => {
      if (req.model === "fast-m") return toolCallTurn("echo", {});
      return textTurn("ok");
    });
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      tools: [echoTool()],
      modelFor: (input) => {
        seen.push({ conversationId: input.conversationId, turn: input.turn, defaultModel: input.defaultModel });
        return input.turn === 1 ? "fast-m" : "main-m";
      },
    });
    const { events } = await collect(agent.stream("go", { conversationId: "cc" }));
    expect(seen).toEqual([
      { conversationId: "cc", turn: 1, defaultModel: "main-m" },
      { conversationId: "cc", turn: 2, defaultModel: "main-m" },
    ]);
    expect(models).toEqual(["fast-m", "main-m"]);
    const start = events.find((e) => e.type === "start") as Extract<AgentEvent, { type: "start" }>;
    expect(start.model).toBe("fast-m");
  });

  test("may be async", async () => {
    const { provider, models } = trackingProvider((req) =>
      req.model === "fast-m" ? textTurn("from fast") : textTurn("from main"),
    );
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      modelFor: async () => "fast-m",
    });
    const { message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(models).toEqual(["fast-m"]);
    expect(message && extractText(message)).toBe("from fast");
  });

  test("countTokens closure counts with the turn's effective model", async () => {
    const countModels: string[] = [];
    const provider: LLMProvider = {
      id: "counting",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      countTokens: async (_msgs, model) => {
        countModels.push(model);
        return 0;
      },
      stream(req) {
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield* textTurn("ok").map((c) => (c.type === "message_start" ? { ...c, model: req.model } : c));
        })();
      },
    };
    const mgr: ContextManager = {
      async fit(input) {
        await input.countTokens(input.messages);
        return { messages: input.messages, compacted: false };
      },
      async compact(input) {
        return { messages: input.messages, compacted: false };
      },
    };
    const agent = createAgent({
      provider,
      model: "m",
      context: mgr,
      modelFor: () => "fast-m",
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(countModels).toEqual(["fast-m"]);
  });
});

// -------------------------------------------------------- per-send override

describe("per-send model override", () => {
  test("opts.model overrides the default for the run (start event + provider)", async () => {
    const { provider, models } = trackingProvider(() => textTurn("ok"));
    const agent = createAgent({ provider, model: "m", models: { main: "m", fast: "f" } });
    const { events } = await collect(agent.stream("go", { conversationId: "c", model: "override-m" }));
    expect(models).toEqual(["override-m"]);
    const start = events.find((e) => e.type === "start") as Extract<AgentEvent, { type: "start" }>;
    expect(start.model).toBe("override-m");
  });

  test("an override suppresses modelFor (a one-off pick must win predictably)", async () => {
    let hookCalls = 0;
    const { provider } = trackingProvider(() => textTurn("ok"));
    const agent = createAgent({
      provider,
      model: "m",
      modelFor: () => {
        hookCalls++;
        return "m";
      },
    });
    await collect(agent.stream("go", { conversationId: "c", model: "picked" }));
    expect(hookCalls).toBe(0);
  });

  test("conversation(id).send accepts the override too", async () => {
    const { provider, models } = trackingProvider(() => textTurn("ok"));
    const agent = createAgent({ provider, model: "m", models: { main: "m", fast: "f" } });
    await collect(agent.conversation("c").send("go", { model: "via-send" }));
    expect(models).toEqual(["via-send"]);
  });
});

// ------------------------------------------------------- auto-compact routing

const SUMMARIZE_PREFIX = "Summarize the earlier conversation";

describe("auto-compact role routing", () => {
  test("models + no config.context → CompactContextManager on the fast tier", async () => {
    const summaryModels: string[] = [];
    const chatModels: string[] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "routing",
      capabilities: { stopReasons: ["end_turn", "tool_use"], streaming: true },
      countTokens: async (msgs) => msgs.length * 100, // 11 msgs ⇒ 1100 > 0.75×budget(300→225)
      stream(req) {
        const isSummary =
          typeof req.system === "string" && req.system.startsWith(SUMMARIZE_PREFIX);
        if (isSummary) {
          summaryModels.push(req.model);
          return (async function* (): AsyncIterable<ProviderChunk> {
            yield { type: "message_start", messageId: "s", model: req.model };
            yield { type: "text_delta", text: "SUMMARY" };
            yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          })();
        }
        chatModels.push(req.model);
        const chunks = turn === 0 ? toolCallTurn("echo", {}) : textTurn("ok");
        turn++;
        return (async function* (): AsyncIterable<ProviderChunk> {
          for (const c of chunks) yield c;
        })();
      },
    };
    const appended: Message[] = [];
    const store: MemoryStore = {
      async load() {
        return [];
      },
      async append(_id, msgs) {
        appended.push(...msgs);
      },
    };
    const agent = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      tools: [echoTool()],
      memory: store,
      contextTokenBudget: 300,
      maxTurns: 5,
    });
    // 11 messages: head (11 - keepLastN 6 = 5 ≥ 2) actually summarizes on turn 1's
    // fit — with fewer messages compact degrades to trim and never calls the model.
    const seed: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `seed_${i}`,
      role: "user" as const,
      content: `earlier message ${i}`,
      createdAt: 0,
    }));
    const { events } = await collect(agent.stream([...seed, { id: "seed_go", role: "user", content: "go", createdAt: 0 }], { conversationId: "c" }));
    expect(summaryModels.length).toBeGreaterThanOrEqual(1);
    expect(summaryModels.every((m) => m === "fast-m")).toBe(true); // summarization runs on the fast tier
    expect(chatModels.every((m) => m === "main-m")).toBe(true); // chat stays on main
    expect(appended.some((m) => typeof m.content === "string" && m.content.startsWith("[Earlier conversation summary"))).toBe(true);
    expect(findDone(events)?.turns).toBeGreaterThanOrEqual(2);
  });

  test("explicit config.context wins — no auto-compact", async () => {
    let fitCalls = 0;
    const mgr: ContextManager = {
      async fit(input) {
        fitCalls++;
        return { messages: input.messages, compacted: false };
      },
      async compact(input) {
        return { messages: input.messages, compacted: false };
      },
    };
    const summaryModels: string[] = [];
    const provider: LLMProvider = {
      id: "explicit-ctx",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        if (typeof req.system === "string" && req.system.startsWith(SUMMARIZE_PREFIX)) summaryModels.push(req.model);
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield* textTurn("ok");
        })();
      },
    };
    const agent = createAgent({ provider, models: { main: "m", fast: "f" }, context: mgr });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(fitCalls).toBeGreaterThanOrEqual(1);
    expect(summaryModels).toEqual([]);
  });

  test("model-only config keeps today's behavior: no context manager, overflow is terminal", async () => {
    const provider: LLMProvider = {
      id: "overflow",
      capabilities: { stopReasons: ["context_window_exceeded", "end_turn"], streaming: true },
      stream() {
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield* textTurn("cwe", "context_window_exceeded");
        })();
      },
    };
    const agent = createAgent({ provider, model: "m" });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findError(events)?.code).toBe("context_overflow");
  });

  test("agent.compact pre-seeds a summary note into the store; second call adds nothing", async () => {
    const store = {
      data: [] as Message[],
      async load() {
        return [...this.data];
      },
      async append(_id: string, msgs: Message[]) {
        this.data.push(...msgs);
      },
    };
    const summaryModels: string[] = [];
    const provider: LLMProvider = {
      id: "manual-compact",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      countTokens: async (msgs) => msgs.length * 100,
      stream(req) {
        if (typeof req.system === "string" && req.system.startsWith("Summarize the earlier conversation")) {
          summaryModels.push(req.model);
          return (async function* (): AsyncIterable<ProviderChunk> {
            yield { type: "message_start", messageId: "s", model: req.model };
            yield { type: "text_delta", text: "RECAP" };
            yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
          })();
        }
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield* textTurn("ok");
        })();
      },
    };
    const agent2 = createAgent({
      provider,
      models: { main: "main-m", fast: "fast-m" },
      memory: store,
    });
    const seed: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`, role: "user" as const, content: `msg ${i}`, createdAt: i,
    }));
    await store.append("c", seed);
    const before = store.data.length;
    const r1 = await agent2.compact("c");
    expect(r1).not.toBeNull();
    expect(summaryModels).toEqual(["fast-m"]); // summarization on the fast tier
    expect(store.data.length).toBe(before + 1); // exactly the note appended
    expect(store.data.at(-1)?.content).toMatch(/^\[Earlier conversation summary/);
    const lenAfterFirst = store.data.length;
    const r2 = await agent2.compact("c"); // incremental reuse: nothing new to append
    expect(store.data.length).toBe(lenAfterFirst);
    expect(r2).not.toBeNull();
  });
});

// ------------------------------------------------------------ pure functions

describe("fallbackChain", () => {
  const tiers = { max: "max", main: "main", fast: "fast" };
  test("derives the downward chain from each tier", () => {
    expect(fallbackChain("max", tiers)).toEqual(["max", "main", "fast"]);
    expect(fallbackChain("main", tiers)).toEqual(["main", "fast"]);
    expect(fallbackChain("fast", tiers)).toEqual(["fast"]);
  });
  test("unknown start or no tiers → chain of one", () => {
    expect(fallbackChain("custom", tiers)).toEqual(["custom"]);
    expect(fallbackChain("main")).toEqual(["main"]);
  });
  test("dedupes when tiers repeat a model", () => {
    expect(fallbackChain("m", { main: "m", fast: "m" })).toEqual(["m"]);
    expect(fallbackChain("x", { max: "x", main: "x", fast: "f" })).toEqual(["x", "f"]);
  });
});

describe("isFallbackEligible", () => {
  test("529 and 5xx qualify", () => {
    expect(isFallbackEligible({ status: 529 } as never)).toBe(true);
    expect(isFallbackEligible({ status: 500 } as never)).toBe(true);
    expect(isFallbackEligible({ status: 503 } as never)).toBe(true);
  });
  test("4xx (other than via code) do not — especially 429", () => {
    for (const status of [400, 401, 403, 404, 413, 429]) {
      expect(isFallbackEligible({ status, retryable: true } as never)).toBe(false);
    }
  });
  test("adapter codes qualify without a status", () => {
    expect(isFallbackEligible({ code: "overloaded" } as never)).toBe(true);
    expect(isFallbackEligible({ code: "model_not_found" } as never)).toBe(true);
  });
  test("ignores the retryable flag — a non-retryable 503 is still a capacity signal", () => {
    expect(isFallbackEligible({ status: 503, retryable: false } as never)).toBe(true);
  });
});

describe("contextWindowFor", () => {
  const tiers = {
    fast: "m-fast",
    main: "m-main",
    max: "m-max",
    contextWindow: { fast: 128_000, main: 250_000, max: 1_000_000 },
  };
  test("resolves the window for each tier slot", () => {
    expect(contextWindowFor("m-fast", tiers)).toBe(128_000);
    expect(contextWindowFor("m-main", tiers)).toBe(250_000);
    expect(contextWindowFor("m-max", tiers)).toBe(1_000_000);
  });
  test("unknown model or missing contextWindow → undefined (caller falls back to the default)", () => {
    expect(contextWindowFor("other", tiers)).toBeUndefined();
    expect(contextWindowFor("m-main", { main: "m-main" })).toBeUndefined();
    expect(contextWindowFor("m-main")).toBeUndefined();
  });
});

import { describe, expect, test } from "vitest";
import {
  AbortError,
  conversationUsage,
  createAgent,
  extractText,
  type AgentEvent,
  type ContextManager,
  type LLMProvider,
  type MemoryStore,
  type Message,
  type StreamHandle,
  type Tool,
} from "../src/index.js";
import { FakeProvider, scriptedProvider, slowTool, textTurn, toolCallTurn } from "./helpers/index.js";

/** A MemoryStore that records every append() call, for asserting what got persisted. */
function recordingStore(): { store: MemoryStore; appended: Message[][]; data: Map<string, Message[]> } {
  const data = new Map<string, Message[]>();
  const appended: Message[][] = [];
  const store: MemoryStore = {
    async load(id) {
      return data.get(id) ?? [];
    },
    async append(id, msgs) {
      const ex = data.get(id) ?? [];
      ex.push(...msgs);
      data.set(id, ex);
      appended.push(msgs);
    },
    async recall() {
      return [];
    },
  };
  return { store, appended, data };
}

async function drain(handle: StreamHandle): Promise<Message | undefined> {
  for await (const _e of handle.events) void _e;
  try {
    return await handle.done;
  } catch {
    return undefined;
  }
}

const pingTool: Tool = {
  name: "ping",
  description: "reply pong",
  inputSchema: { jsonSchema: { type: "object", properties: {} } },
  async execute() {
    return { content: "pong" };
  },
};

const textOf = (m: Message): string => (typeof m.content === "string" ? m.content : "");

describe("memory persistence", () => {
  test("P0: a multi-tool stream persists ALL new messages, not a fixed 2-message tail", async () => {
    const { store, appended } = recordingStore();
    const provider = scriptedProvider([
      toolCallTurn("ping", {}),
      textTurn("done"),
    ]);
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      tools: [pingTool],
      memory: store,
    });

    await drain(agent.stream("go", { conversationId: "c1" }));

    expect(appended.length).toBe(1);
    // input + asst(tool_use) + user(tool_result) + asst(end) = 4 new messages.
    // The old `slice(-2)` would have persisted only 2.
    expect(appended[0]?.length).toBe(4);
    // The original user input must survive (slice(-2) would have dropped it).
    expect(appended[0]?.some((m) => textOf(m) === "go")).toBe(true);
    // The first assistant tool-call turn must also survive.
    expect(appended[0]?.some((m) => m.role === "assistant")).toBe(true);
  });

  test("P1: a named conversation loads prior history across agent instances", async () => {
    const { store } = recordingStore();
    const seen: Message[][] = [];

    const agent1 = createAgent({
      provider: scriptedProvider([textTurn("first reply")]),
      model: "fake",
      maxTurns: 5,
      memory: store,
    });
    await drain(agent1.conversation("c1").send("remember this"));

    // Fresh agent instance sharing the same store + conversation id.
    const agent2 = createAgent({
      provider: new FakeProvider((req) => {
        seen.push(req.messages);
        return textTurn("second reply");
      }),
      model: "fake",
      maxTurns: 5,
      memory: store,
    });
    await drain(agent2.conversation("c1").send("follow up"));

    // agent2's first request must include the earlier turn, loaded from memory.
    const firstReq = seen[0];
    expect(firstReq?.some((m) => textOf(m).includes("remember this"))).toBe(true);
  });

  test("incremental: consecutive same-id streams each persist only their own delta", async () => {
    const { store, appended } = recordingStore();
    const agent = createAgent({
      provider: scriptedProvider([textTurn("r1"), textTurn("r2")]),
      model: "fake",
      maxTurns: 5,
      memory: store,
    });

    await drain(agent.stream("a", { conversationId: "c1" }));
    await drain(agent.stream("b", { conversationId: "c1" }));

    expect(appended.length).toBe(2);
    // Each single-turn stream adds exactly input + assistant = 2.
    expect(appended[0]?.length).toBe(2);
    expect(appended[1]?.length).toBe(2);
    // Second delta is "b" + its reply — NOT a re-persist of "a".
    expect(appended[1]?.some((m) => textOf(m) === "b")).toBe(true);
    expect(appended[1]?.some((m) => textOf(m) === "a")).toBe(false);
  });

  test("named conversation is memory-persistent even via conversation() handle", async () => {
    const { store, appended } = recordingStore();
    const agent = createAgent({
      provider: scriptedProvider([textTurn("ok")]),
      model: "fake",
      maxTurns: 5,
      memory: store,
    });
    await drain(agent.conversation("sess").send("hello"));
    // Named handle → persistent → append called (would be skipped pre-fix).
    expect(appended.length).toBe(1);
    expect(appended[0]?.some((m) => textOf(m) === "hello")).toBe(true);
  });

  test("append persists new messages even when context.fit shortens history (id-based, not baseline index)", async () => {
    const { store, appended, data } = recordingStore();
    // Pre-seed a long history so context.fit will trim it in place.
    const seed: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: `seed-${i}`, role: "user", content: `old ${i}`, createdAt: 0,
    }));
    data.set("c1", seed);
    const shrinkingContext: ContextManager = {
      async fit(input) { return { messages: input.messages.slice(-2), compacted: true }; },
      async compact(input) { return { messages: input.messages.slice(-2), compacted: true }; },
    };
    const provider = scriptedProvider([textTurn("reply")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, memory: store, context: shrinkingContext });

    await drain(agent.stream("fresh input", { conversationId: "c1" }));

    expect(appended.length).toBe(1);
    // fit trimmed history to ~2 in place, but append must still capture this stream's new messages.
    expect(appended[0]?.some((m) => textOf(m) === "fresh input")).toBe(true);
    expect(appended[0]?.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("agent config validation", () => {
  test("createAgent rejects maxTurns < 1 at construction", () => {
    expect(() => createAgent({ provider: scriptedProvider([]), model: "fake", maxTurns: 0 })).toThrow(/maxTurns/);
    expect(() => createAgent({ provider: scriptedProvider([]), model: "fake", maxTurns: -1 })).toThrow(/maxTurns/);
  });
});

// ---------------------------------------------------------------------------
// Abort persistence (Claude parity): an interrupted run keeps what it really
// produced — the input, completed turns, and any partial reply that had
// already streamed — instead of losing the whole run.
// ---------------------------------------------------------------------------

/** Streams `text`, reports usage mid-stream, then hangs until the request is
 *  aborted — mimics a real provider whose transport dies on abort. */
function hangAfterTextProvider(text: string): LLMProvider {
  return {
    id: "fake",
    capabilities: { stopReasons: ["end_turn"], streaming: true },
    stream(req) {
      return (async function* () {
        yield { type: "message_start", messageId: "m_hang", model: "fake" };
        if (text !== "") yield { type: "text_delta", text };
        yield { type: "message_delta", usage: { inputTokens: 3, outputTokens: 4 } };
        await new Promise<never>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
        });
      })();
    },
  };
}

/** Drain events, aborting the handle as soon as an event matches `when`. */
async function drainWithAbort(
  handle: StreamHandle,
  when: (e: AgentEvent) => boolean,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) {
    events.push(e);
    if (when(e)) handle.abort();
  }
  return events;
}

describe("abort persistence (Claude parity)", () => {
  test("abort mid-stream persists the salvaged partial reply + partial usage", async () => {
    const { store, data } = recordingStore();
    const agent = createAgent({ provider: hangAfterTextProvider("partial answer"), model: "fake", memory: store });
    const handle = agent.stream("q", { conversationId: "c1" });
    const events = await drainWithAbort(handle, (e) => e.type === "text_delta");
    await handle.done.catch(() => {}); // hard failure: done rejects AbortError by contract

    const err = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    expect(err?.code).toBe("aborted");
    expect(events.some((e) => e.type === "done")).toBe(false);

    const persisted = data.get("c1") ?? [];
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant"]);
    const partial = persisted[1]!;
    expect(extractText(partial)).toBe("partial answer");
    expect(partial.metadata?.stopReason).toBe("aborted");
    expect(partial.metadata?.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  test("abort before any content persists only the input (no empty assistant turn)", async () => {
    const { store, data } = recordingStore();
    const agent = createAgent({ provider: hangAfterTextProvider(""), model: "fake", memory: store });
    const handle = agent.stream("q", { conversationId: "c1" });
    await drainWithAbort(handle, (e) => e.type === "start");
    await handle.done.catch(() => {});
    expect((data.get("c1") ?? []).map((m) => m.role)).toEqual(["user"]);
  });

  test("abort during tool execution persists the tool turn + its (error) result", async () => {
    const { store, data } = recordingStore();
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("slow", {})]),
      model: "fake",
      tools: [slowTool(10_000)],
      memory: store,
    });
    const handle = agent.stream("q", { conversationId: "c1" });
    await drainWithAbort(handle, (e) => e.type === "tool_call");
    await handle.done.catch(() => {});

    const persisted = data.get("c1") ?? [];
    // user input + assistant(tool_call) + user(tool_result carrier) — replay-safe:
    // every tool_use the next request replays carries its tool_result answer.
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const carrier = persisted[2]!;
    const results = Array.isArray(carrier.content) ? carrier.content : [];
    expect(results[0]).toMatchObject({ type: "tool_result", isError: true });
  });
});

describe("per-turn usage persistence", () => {
  test("usage + stopReason stamped on every assistant turn; conversationUsage totals them", async () => {
    const { store, data } = recordingStore();
    const agent = createAgent({
      provider: scriptedProvider([textTurn("one"), textTurn("two")]),
      model: "fake",
      memory: store,
    });
    await drain(agent.stream("first", { conversationId: "c1" }));
    await drain(agent.stream("second", { conversationId: "c1" }));

    const assistants = (data.get("c1") ?? []).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(2);
    for (const a of assistants) {
      expect(a.metadata?.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
      expect(a.metadata?.stopReason).toBe("end_turn");
    }
    // Conversation total from persisted history — derivable after a reload,
    // without having watched the live done.totalUsage event.
    expect(conversationUsage(data.get("c1") ?? [])).toEqual({ inputTokens: 2, outputTokens: 2 });
  });
});

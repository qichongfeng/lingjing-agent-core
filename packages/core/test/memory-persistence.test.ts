import { describe, expect, test } from "vitest";
import {
  createAgent,
  type ContextManager,
  type MemoryStore,
  type Message,
  type StreamHandle,
  type Tool,
} from "../src/index.js";
import { FakeProvider, scriptedProvider, textTurn, toolCallTurn } from "./helpers/index.js";

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

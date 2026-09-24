import { describe, expect, test } from "vitest";
import {
  AbortError,
  CompactContextManager,
  conversationUsage,
  createAgent,
  extractText,
  type AgentEvent,
  type ContextManager,
  type LLMProvider,
  type MemoryStore,
  type Message,
  type ProviderChunk,
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

// ---------------------------------------------------------------------------
// In-run compaction persistence (append-only contract): the store always keeps
// the verbatim originals — dropped-at-compaction messages are persisted BEFORE
// the view rewrite — and the next load MATERIALIZES the compacted view from
// the note's coveredUntil stamp instead of re-sending the full history.
// ---------------------------------------------------------------------------

describe("in-run compaction persistence + reload materialization", () => {
  test("dropped originals persist at compaction time; the next send materializes the note's view", async () => {
    const { store, data } = recordingStore();
    const SUMMARY_LABEL =
      "[Earlier conversation summary — auto-generated recap of earlier turns, not a user message]";

    // fit: no-op on turn 1, compacts once on turn 2 to [note, last message].
    // coveredUntil = the last head message, mirroring CompactContextManager.
    let fitCalls = 0;
    const compacting: ContextManager = {
      async fit(input) {
        fitCalls++;
        if (fitCalls < 2) return { messages: input.messages, compacted: false };
        const tail = input.messages.slice(-1);
        const lastHead = input.messages[input.messages.length - 2];
        const noteMsg: Message = {
          id: "note-run1", role: "user",
          content: `${SUMMARY_LABEL}\nrecap of early turns`,
          createdAt: 0,
          metadata: { coveredUntil: lastHead?.id },
        };
        return { messages: [noteMsg, ...tail], compacted: true, tokensSaved: 10 };
      },
      async compact(input) { return { messages: input.messages, compacted: false }; },
    };

    // Run 1: turn 1 = tool_use (echo), turn 2 = text. fit before turn 2 compacts.
    const reqs: Message[][] = [];
    const provider1 = new FakeProvider((req, turn) => {
      reqs.push(req.messages);
      return turn === 0 ? toolCallTurn("ping", {}) : textTurn("done");
    });
    const agent = createAgent({
      provider: provider1, model: "fake", maxTurns: 5,
      memory: store, context: compacting,
      tools: [{ name: "ping", description: "ping", inputSchema: { jsonSchema: { type: "object" } }, async execute() { return { content: "pong" }; } }],
    });
    await drain(agent.stream("go", { conversationId: "c" }));

    // Append-only: the store holds the verbatim originals the view dropped
    // (input + the tool turn), the note, and the post-compaction turns.
    const persisted = data.get("c")!.map((m) => m.id);
    expect(persisted).toContain("note-run1");
    expect(persisted.some((id) => id !== "note-run1" && id.startsWith("note-"))).toBe(false); // one note only
    // The original user input and the tool_use assistant turn survived in the
    // store even though the run's view compacted them away.
    const stored = data.get("c")!;
    expect(stored.some((m) => m.role === "user" && m.content === "go")).toBe(true);
    expect(stored.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_call"))).toBe(true);

    // Run 2 (same conversation): the request view materializes the compaction —
    // the note leads, the covered originals (incl. "go") are NOT re-sent.
    const viewReqs: Message[][] = [];
    const provider2 = new FakeProvider((req) => {
      viewReqs.push(req.messages);
      return textTurn("second");
    });
    const agent2 = createAgent({ provider: provider2, model: "fake", memory: store, context: compacting });
    await drain(agent2.stream("next", { conversationId: "c" }));
    const view = viewReqs[0]!;
    expect(view[0]?.id).toBe("note-run1");
    expect(view.some((m) => m.content === "go")).toBe(false);
    expect(view.some((m) => m.content === "next")).toBe(true);
    // fitCalls: run 1 saw 2 (turn 1 + turn 2), run 2 adds 1 → the run-2 fit ran
    // over the MATERIALIZED view, not the full store.
    expect(fitCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Per-conversation send serialization (queue): a second send on the SAME
// conversation waits for the previous run — including its persistence flush —
// before loading history; different conversations stay fully parallel.
// ---------------------------------------------------------------------------

describe("same-conversation send serialization", () => {
  test("concurrent double send: the second run's base includes the first run's messages", async () => {
    const { store } = recordingStore();
    const reqs: Message[][] = [];
    const provider = new FakeProvider((req, turn) => {
      reqs.push(req.messages);
      return textTurn(turn === 0 ? "first" : "second");
    });
    const agent = createAgent({ provider, model: "fake", memory: store });
    const conv = agent.conversation("serial");
    const h1 = conv.send("one");
    const h2 = conv.send("two"); // launched while h1 is in flight
    const [m1, m2] = await Promise.all([h1.done, h2.done]);
    expect(extractText(m1!)).toBe("first");
    expect(extractText(m2!)).toBe("second");
    // Run 1 saw only its input; run 2's base contains run 1's input AND reply.
    expect(reqs[0]!.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["one"]);
    const view2 = reqs[1]!.map((m) => extractText(m));
    expect(view2).toEqual(["one", "first", "two"]);
  });

  test("abort → immediate resend: the resend's base includes the aborted run's salvaged partial", async () => {
    const { store } = recordingStore();
    const reqs: Message[][] = [];
    let turn = 0;
    const provider: LLMProvider = {
      id: "hang-then-resend",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        const mine = turn++;
        reqs.push(req.messages);
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: `m${mine}`, model: "fake" };
          if (mine === 0) {
            // Stream real text, then hang until aborted (a real transport dies on abort).
            yield { type: "text_delta", text: "PARTIAL" };
            await new Promise<never>((_, reject) => {
              req.signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
            });
          }
          yield { type: "text_delta", text: "AFTER" };
          yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })();
      },
    };
    const agent = createAgent({ provider, model: "fake", memory: store });
    const conv = agent.conversation("abort-race");
    const h1 = conv.send("original");
    const settled1 = h1.done.then(() => "ok", () => "aborted");
    // Wait for the partial to actually stream before aborting.
    for await (const e of h1.events) {
      if (e.type === "text_delta") break;
    }
    h1.abort();
    const h2 = conv.send("resend"); // launched BEFORE h1's persistence flush
    const m2 = await h2.done;
    expect(extractText(m2)).toBe("AFTER");
    expect(await settled1).toBe("aborted");
    // The resend's request saw the aborted run's input + salvaged partial —
    // without the queue this load raced the flush and could miss them.
    const view2 = reqs[1]!.map((m) => extractText(m));
    expect(view2).toContain("original");
    expect(view2).toContain("PARTIAL");
    expect(view2).toContain("resend");
  });

  test("different conversations do NOT serialize (a slow one never blocks another)", async () => {
    let releaseC2!: () => void;
    const c2Started = new Promise<void>((resolve) => { releaseC2 = resolve; });
    const provider = new FakeProvider((req) => {
      if (req.conversationId === "c1") {
        // c1 cannot finish until c2 has STARTED — a global lock would deadlock here.
        return c2Started.then(() => textTurn("a"));
      }
      releaseC2();
      return textTurn("b");
    });
    const agent = createAgent({ provider, model: "fake" });
    const h1 = agent.stream("x", { conversationId: "c1" });
    const h2 = agent.stream("y", { conversationId: "c2" });
    const [m1, m2] = await Promise.all([h1.done, h2.done]);
    expect(extractText(m1!)).toBe("a");
    expect(extractText(m2!)).toBe("b");
  }, 2000);
});

describe("pre-run store failures", () => {
  test("a failing durable persist terminates the events stream (no hang) and emits memory_error", async () => {
    const failing: MemoryStore = {
      async load() {
        return [];
      },
      async append() {
        throw new Error("idb quota exceeded");
      },
    };
    const agent = createAgent({
      provider: scriptedProvider([textTurn("never reached")]),
      model: "fake",
      memory: failing,
      persistRuns: true,
    });
    const handle = agent.stream("hi", { conversationId: "c" });
    const events: AgentEvent[] = [];
    // Terminates ONLY because the failure path closes the queue — before the
    // fix this for-await hung forever while done rejected.
    for await (const e of handle.events) events.push(e);
    await expect(handle.done).rejects.toThrow("idb quota");
    const err = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
    expect(err?.code).toBe("memory_error");
    expect(err?.recoverable).toBe(true);
  }, 2000);

  test("a failing store LOAD behaves the same — stream closes, done rejects", async () => {
    const failing: MemoryStore = {
      async load() {
        throw new Error("store corrupt");
      },
      async append() {
        return;
      },
    };
    const agent = createAgent({
      provider: scriptedProvider([textTurn("never reached")]),
      model: "fake",
      memory: failing,
    });
    const handle = agent.stream("hi", { conversationId: "c" });
    const events: AgentEvent[] = [];
    for await (const e of handle.events) events.push(e);
    await expect(handle.done).rejects.toThrow("store corrupt");
    expect(events.some((e) => e.type === "error")).toBe(true);
  }, 2000);
});

describe("in-run microcompact keeps verbatim originals in the store", () => {
  test("an old tool_result stubbed by fit persists VERBATIM, not the '[cleared]' marker", async () => {
    const { store } = recordingStore();
    const fat: Tool = {
      name: "fat",
      description: "returns a fat result",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute() {
        return { content: `F${"F".repeat(20000)}` };
      },
    };
    const noop: Tool = {
      name: "noop",
      description: "returns ok",
      inputSchema: { jsonSchema: { type: "object" } },
      async execute() {
        return { content: "ok" };
      },
    };
    const agent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("fat", {}),
        toolCallTurn("noop", {}),
        toolCallTurn("noop", {}),
        toolCallTurn("noop", {}),
        toolCallTurn("noop", {}),
        textTurn("done"),
      ]),
      model: "fake",
      memory: store,
      tools: [fat, noop],
      maxTurns: 10,
      // Small budget + a fat tool_result that ages into the head region → the
      // turn-5 fit microcompacts (stubs) it under the SAME message id.
      context: new CompactContextManager({ provider: scriptedProvider([]), model: "fake" }),
      contextTokenBudget: 400,
    });
    await drain(agent.stream("go", { conversationId: "c" }));

    const msgs = await store.load("c");
    const fatCarrier = msgs.find((m) => JSON.stringify(m.content).includes("FFFF"));
    expect(fatCarrier).toBeDefined(); // the verbatim fat result reached the store…
    expect(JSON.stringify(msgs)).not.toContain("cleared for context"); // …the stub never replaced it
  });
});

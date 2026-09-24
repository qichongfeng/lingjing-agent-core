import { describe, expect, test } from "vitest";
import {
  InMemoryStore,
  createRecallStore,
  isRecallInjected,
  markRecallInjected,
  ragInjectHook,
  tokenize,
  type HookContext,
  type MemoryStore,
  type Message,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(role: Message["role"], text: string, id: string, createdAt = 0): Message {
  return { id, role, content: text, createdAt };
}

/** A message that exists only to carry tool results — the shape the loop
 *  appends after every tool round. extractText() yields "" for it. */
function carrier(id: string, createdAt = 0): Message {
  return {
    id,
    role: "user",
    content: [{ type: "tool_result", toolCallId: "c1", content: "ok" }],
    createdAt,
  };
}

/** Store with enumeration, seeded directly (as if a previous session wrote it)
 *  and recording which conversations were ever loaded. */
class SpyStore implements MemoryStore {
  private readonly map = new Map<string, Message[]>();
  readonly loaded: string[] = [];

  seed(conversationId: string, messages: Message[]): void {
    this.map.set(conversationId, messages);
  }
  remove(conversationId: string): void {
    this.map.delete(conversationId);
  }
  async load(conversationId: string): Promise<Message[]> {
    this.loaded.push(conversationId);
    return this.map.get(conversationId) ?? [];
  }
  async append(conversationId: string, messages: Message[]): Promise<void> {
    this.map.set(conversationId, [...(this.map.get(conversationId) ?? []), ...messages]);
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

/** Store with no enumeration — the append-only degradation path. */
class NoListStore implements MemoryStore {
  private readonly map = new Map<string, Message[]>();
  async load(conversationId: string): Promise<Message[]> {
    return this.map.get(conversationId) ?? [];
  }
  async append(conversationId: string, messages: Message[]): Promise<void> {
    this.map.set(conversationId, [...(this.map.get(conversationId) ?? []), ...messages]);
  }
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("latin runs are lowercased; single characters carry no signal", () => {
    expect(tokenize("Deploy The Service")).toEqual(["deploy", "the", "service"]);
    expect(tokenize("a b cd")).toEqual(["cd"]);
  });

  test("CJK gets unigrams AND bigrams", () => {
    const tokens = tokenize("今天");
    expect(tokens).toHaveLength(3);
    expect(tokens).toContain("今"); // unigram: recall
    expect(tokens).toContain("天");
    expect(tokens).toContain("今天"); // bigram: precision
  });

  test("punctuation terminates a CJK run instead of bridging bigrams", () => {
    const tokens = tokenize("好。今天");
    expect(tokens).toContain("今天");
    expect(tokens).not.toContain("好。");
    expect(tokens).not.toContain("。今");
  });

  test("NFKC folds fullwidth forms so they match what a user types", () => {
    expect(tokenize("ＡＢＣ")).toEqual(["abc"]);
    expect(tokenize("１２３")).toEqual(["123"]);
  });

  test("astral CJK stays whole instead of splitting into surrogate halves", () => {
    expect(tokenize("𠀀")).toEqual(["𠀀"]);
  });

  test("a single CJK character is still a token (single-char queries must work)", () => {
    expect(tokenize("京")).toEqual(["京"]);
  });
});

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

describe("createRecallStore", () => {
  test("ranks matching conversations above unrelated ones", async () => {
    const store = new SpyStore();
    store.seed("c1", [msg("user", "how do I fix the flaky integration test", "m1")]);
    store.seed("c2", [msg("user", "what is the weather in beijing", "m1")]);
    store.seed("c3", [msg("user", "the flaky test was fixed by awaiting the signal", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1", "c2", "c3"]) });

    const hits = await recall.recall("flaky test");
    expect(hits.map((h) => h.source)).toEqual(["c1", "c3"]);
    expect(hits.every((h) => h.content.includes("flaky"))).toBe(true);
  });

  test("retrieves Chinese text and answers single-character queries", async () => {
    const store = new SpyStore();
    store.seed("c1", [msg("user", "明天北京天气如何", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });

    expect((await recall.recall("北京天气")).map((h) => h.source)).toEqual(["c1"]);
    expect((await recall.recall("京")).map((h) => h.source)).toEqual(["c1"]);
  });

  test("matching is case-insensitive in both directions", async () => {
    const store = new SpyStore();
    store.seed("c1", [msg("assistant", "Deploy the Service to prod", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });
    expect(await recall.recall("DEPLOY")).toHaveLength(1);
  });

  test("returns [] for an empty query, an unmatched query, and an empty store", async () => {
    const store = new SpyStore();
    store.seed("c1", [msg("user", "hello world", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });

    expect(await recall.recall("")).toEqual([]);
    expect(await recall.recall("    ")).toEqual([]);
    expect(await recall.recall("zzzzzz")).toEqual([]);

    const empty = createRecallStore({ store: new SpyStore() });
    expect(await empty.recall("anything")).toEqual([]);
  });

  test("exclude drops a conversation from the result", async () => {
    const store = new SpyStore();
    store.seed("c1", [msg("user", "the flaky test needs a signal", "m1")]);
    store.seed("c2", [msg("user", "the flaky test was a signal bug", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1", "c2"]) });

    const hits = await recall.recall("flaky test", { exclude: ["c1"] });
    expect(hits.map((h) => h.source)).toEqual(["c2"]);
  });

  test("scope keeps out-of-scope conversations out of the index entirely", async () => {
    const store = new SpyStore();
    store.seed("mine", [msg("user", "the flaky test needs a signal", "m1")]);
    store.seed("someone-else", [msg("user", "the flaky test is also mentioned here", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["mine"]) });

    const hits = await recall.recall("flaky test");
    expect(hits.map((h) => h.source)).toEqual(["mine"]);
    // Not merely filtered out of the result — never read in the first place.
    expect(store.loaded).toEqual(["mine"]);
  });

  test("reconcile forgets conversations that disappeared and picks up new ones", async () => {
    const store = new SpyStore();
    store.seed("old", [msg("user", "the flaky test needs a signal", "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["old", "new"]) });

    expect((await recall.recall("flaky test")).map((h) => h.source)).toEqual(["old"]);

    store.remove("old");
    store.seed("new", [msg("user", "the flaky test was a signal bug all along", "m1")]);

    const hits = await recall.recall("flaky test");
    expect(hits.map((h) => h.source)).toEqual(["new"]);
    // The dropped conversation is genuinely gone from the index, not just
    // hidden: a follow-up query cannot resurrect it.
    expect(await recall.recall("needs")).toEqual([]);
  });

  test("a store without list() still recalls what flows through append", async () => {
    const store = new NoListStore();
    const recall = createRecallStore({ store });

    await recall.append("c1", [msg("user", "the flaky test needs a signal", "m1")]);
    expect((await recall.recall("flaky test")).map((h) => h.source)).toEqual(["c1"]);
  });

  test("messages appended through the wrapper are searchable immediately", async () => {
    const store = new SpyStore();
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });

    await recall.append("c1", [msg("user", "the flaky test needs a signal", "m1")]);
    expect((await recall.recall("flaky test"))).toHaveLength(1);
  });

  test("re-appending the same message does not double-index it", async () => {
    const store = new SpyStore();
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });
    const m = msg("user", "the flaky test needs a signal", "m1");

    await recall.append("c1", [m]);
    await recall.append("c1", [m]); // the persistDropped / persist race the loop can produce
    const hits = await recall.recall("flaky test");
    expect(hits.filter((h) => h.messageId === "m1")).toHaveLength(1);
  });

  test("RAG-injected blocks are never indexed (no self-feeding)", async () => {
    const store = new SpyStore();
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });

    await recall.append("c1", [
      markRecallInjected(msg("user", "[Retrieved context] the flaky test needs a signal", "m1")),
    ]);
    expect(await recall.recall("flaky test")).toEqual([]);
  });

  test("takes snippets around the match, not the head of the message", async () => {
    const store = new SpyStore();
    const filler = "lorem ipsum dolor sit amet ".repeat(60); // ~1600 chars
    store.seed("c1", [msg("user", `${filler}the flaky test needs a signal`, "m1")]);
    const recall = createRecallStore({ store, scope: () => Promise.resolve(["c1"]) });

    const [hit] = await recall.recall("flaky");
    expect(hit!.content).toContain("flaky");
    expect(hit!.content.startsWith("…")).toBe(true); // window, not the head
  });

  test("caps snippets per conversation so one stretch cannot fill the result", async () => {
    const store = new SpyStore();
    store.seed("a", [
      msg("user", "the flaky test needs a signal", "m1"),
      msg("user", "the flaky test needs patience", "m2"),
    ]);
    store.seed("b", [msg("user", "the flaky test needs rest", "m1")]);
    const recall = createRecallStore({
      store,
      scope: () => Promise.resolve(["a", "b"]),
      maxPerConversation: 1,
      minScoreRatio: 0,
    });

    const hits = await recall.recall("flaky test");
    expect(hits.filter((h) => h.source === "a")).toHaveLength(1);
    expect(hits.filter((h) => h.source === "b")).toHaveLength(1);
  });

  test("minScoreRatio cuts weak hits instead of padding the result", async () => {
    const store = new SpyStore();
    store.seed("strong", [msg("user", "flaky test flaky test flaky test", "m1")]);
    store.seed("weak", [msg("user", "test", "m1")]);
    const recall = createRecallStore({
      store,
      scope: () => Promise.resolve(["strong", "weak"]),
      minScoreRatio: 0.9,
    });

    const hits = await recall.recall("flaky test");
    expect(hits.map((h) => h.source)).toEqual(["strong"]);
  });

  test("list() is exposed when the wrapped store has one", async () => {
    const store = new SpyStore();
    store.seed("c1", []);
    expect(await createRecallStore({ store }).list?.()).toEqual(["c1"]);
    expect(await createRecallStore({ store: new NoListStore() }).list).toBeUndefined();
  });

  test("works over InMemoryStore — the Node/testing default", async () => {
    const store = new InMemoryStore();
    const recall = createRecallStore({ store });
    await recall.append("c1", [msg("user", "the flaky test needs a signal", "m1")]);
    expect(await recall.recall("flaky test")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ragInjectHook — the wiring createRecallStore exists to feed
// ---------------------------------------------------------------------------

function hookCtx(messages: Message[], conversationId = "c1"): HookContext {
  return {
    conversationId,
    turn: 1,
    messages,
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("ragInjectHook", () => {
  async function fixture(): Promise<{ store: SpyStore; hook: NonNullable<ReturnType<typeof ragInjectHook>> }> {
    const store = new SpyStore();
    store.seed("c1", [msg("user", "we decided the flaky test needs a signal", "m1")]);
    store.seed("c2", [msg("user", "the flaky test was a signal bug in the harness", "m1")]);
    const recallStore = createRecallStore({ store, scope: () => Promise.resolve(["c1", "c2"]) });
    return { store, hook: ragInjectHook({ store: recallStore }) };
  }

  test("injects framed snippets from other conversations", async () => {
    const { hook } = await fixture();
    const result = await hook(hookCtx([msg("user", "what about the flaky test", "q1")]));

    const injected = (result as { inject: Message[] }).inject;
    expect(injected).toHaveLength(1);
    const text = injected[0]!.content as string;
    expect(text.startsWith("[Retrieved context]")).toBe(true);
    expect(text).toContain("not instructions");
    expect(text).toContain("signal bug in the harness");
    expect(isRecallInjected(injected[0]!)).toBe(true);
  });

  test("excludes the current conversation — its content is already in context", async () => {
    const { hook } = await fixture();
    const result = await hook(hookCtx([msg("user", "what about the flaky test", "q1")]));
    const text = ((result as { inject: Message[] }).inject[0]!.content as string);
    expect(text).not.toContain("we decided the flaky test needs a signal");
  });

  test("only fires on a fresh user turn, not mid-tool-loop", async () => {
    const { hook } = await fixture();
    const midLoop = hookCtx([
      msg("user", "what about the flaky test", "q1"),
      carrier("t1"),
    ]);
    expect(await hook(midLoop)).toBeUndefined();
  });

  test("does not fire again on its own injected block", async () => {
    const { hook } = await fixture();
    const first = await hook(hookCtx([msg("user", "what about the flaky test", "q1")]));
    const injected = (first as { inject: Message[] }).inject;
    expect(await hook(hookCtx([msg("user", "what about the flaky test", "q1"), ...injected]))).toBeUndefined();
  });

  test("keeps scanning past carriers and compaction notes for the user's own text", async () => {
    const queries: string[] = [];
    const store: MemoryStore = {
      load: () => Promise.resolve([]),
      append: () => Promise.resolve(),
      recall: (q) => {
        queries.push(q);
        return Promise.resolve([]);
      },
    };
    const hook = ragInjectHook({ store });
    // Reaching the query builder means the gate let this turn through — which
    // is exactly the post-compaction case (ctx.compacted). The tail is the
    // summary note, then a tool carrier: neither is the user asking anything,
    // so the first *empty* user-role hit must not end the scan.
    await hook(
      hookCtx([
        msg("user", "why is the build red", "q1"),
        msg("assistant", "looking", "a1"),
        carrier("t1"),
        msg("user", "[Earlier conversation summary] we discussed the build", "s1"),
      ]),
    );
    expect(queries).toEqual(["why is the build red"]);
  });

  test("stays silent when the store has no recall, or returns nothing", async () => {
    const bare: MemoryStore = {
      load: () => Promise.resolve([]),
      append: () => Promise.resolve(),
    };
    expect(await ragInjectHook({ store: bare })(hookCtx([msg("user", "anything", "q1")]))).toBeUndefined();

    // InMemoryStore.recall exists but is a stub returning [].
    const empty = ragInjectHook({ store: new InMemoryStore() });
    expect(await empty(hookCtx([msg("user", "anything", "q1")]))).toBeUndefined();
  });

  test("a failing recall degrades to no injection rather than killing the run", async () => {
    const store: MemoryStore = {
      load: () => Promise.resolve([]),
      append: () => Promise.resolve(),
      recall: () => Promise.reject(new Error("store exploded")),
    };
    await expect(ragInjectHook({ store })(hookCtx([msg("user", "anything", "q1")]))).resolves.toBeUndefined();
  });

  test("an aborted run does not wait on retrieval", async () => {
    const ac = new AbortController();
    ac.abort();
    const store = new SpyStore();
    store.seed("c1", [msg("user", "the flaky test needs a signal", "m1")]);
    const recallStore = createRecallStore({ store });

    expect(await recallStore.recall("flaky test", { signal: ac.signal })).toEqual([]);
    expect(store.loaded).toEqual([]); // never even built the index
  });
});

import { describe, expect, test } from "vitest";
import {
  InMemoryStore,
  createVectorRecallStore,
  markRecallInjected,
  sleep,
  type MemoryStore,
  type Message,
  type SavedVectorIndex,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function msg(role: Message["role"], text: string, id: string, createdAt = 0): Message {
  return { id, role, content: text, createdAt };
}

/** Deterministic bag-of-characters embedder: 64 dims, each code point hashes
 *  into a slot INDEPENDENTLY of position (a rolling hash would make the slot
 *  depend on the prefix — the same character at different offsets would land
 *  in different slots and shared characters would not collide). No network,
 *  no nondeterminism — and similarity tracks shared characters, so "shares
 *  all of the query" beats "shares none" cleanly. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  for (const ch of text) {
    v[(ch.codePointAt(0) ?? 0) % 64]! += 1;
  }
  return v;
}

function countingEmbed(): {
  embed: (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>;
  calls: () => number;
} {
  let n = 0;
  return {
    embed: async (text) => {
      n += 1;
      return hashEmbed(text);
    },
    calls: () => n,
  };
}

/** Store with enumeration and a remove() — to simulate a conversation
 *  vanishing between recalls. */
class DeletableStore implements MemoryStore {
  private readonly map = new Map<string, Message[]>();
  seed(conversationId: string, messages: Message[]): void {
    this.map.set(conversationId, messages);
  }
  remove(conversationId: string): void {
    this.map.delete(conversationId);
  }
  async load(conversationId: string): Promise<Message[]> {
    return this.map.get(conversationId) ?? [];
  }
  async append(conversationId: string, messages: Message[]): Promise<void> {
    this.map.set(conversationId, [...(this.map.get(conversationId) ?? []), ...messages]);
  }
  async list(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

// ---------------------------------------------------------------------------
// recall
// ---------------------------------------------------------------------------

describe("createVectorRecallStore", () => {
  test("ranks by cosine similarity — nearest document first", async () => {
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({ store, embed: e.embed });
    await store.append("c1", [msg("user", "数据库索引优化方案", "m1")]);
    await store.append("c2", [msg("user", "今天天气不错去散步", "m2")]);
    const out = await mem.recall("数据库索引");
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.source).toBe("c1");
    expect(out[0]!.messageId).toBe("m1");
    expect(out[0]!.score).toBeGreaterThan(0);
  });

  test("append indexes incrementally — no full rebuild per recall", async () => {
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({ store, embed: e.embed });
    await mem.append("c1", [msg("user", "第一轮讨论开始了", "m1")]);
    const first = await mem.recall("第一轮");
    expect(first.length).toBe(1);
    const before = e.calls();
    await mem.append("c1", [msg("user", "第二轮讲向量化", "m2")]);
    const second = await mem.recall("向量化");
    expect(second.some((s) => s.messageId === "m2")).toBe(true);
    // one embed for the new message + one for the query — m1 was not re-embedded
    expect(e.calls() - before).toBe(2);
  });

  test("reconcile drops conversations that vanished from the store", async () => {
    const store = new DeletableStore();
    const mem = createVectorRecallStore({ store, embed: hashEmbed });
    await store.seed("c1", [msg("user", "要被删除的会话内容", "m1")]);
    await mem.recall("会话"); // build the index
    store.remove("c1");
    expect(await mem.recall("会话")).toEqual([]);
  });

  test("scope keeps out-of-scope conversations out of the index entirely", async () => {
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({
      store,
      embed: e.embed,
      scope: async () => ["c1"],
    });
    await store.append("c1", [msg("user", "范围内的内容", "m1")]);
    await store.append("c2", [msg("user", "范围外的机密内容", "m2")]);
    const out = await mem.recall("机密内容");
    expect(out.every((s) => s.source !== "c2")).toBe(true);
    const visible = await mem.recall("范围内");
    expect(visible.every((s) => s.source === "c1")).toBe(true);
    // c1's embed + a query embed per recall — m2 never reached the embedder
    expect(e.calls()).toBe(3);
  });

  test("recall-injected blocks, tool-result carriers and thinking are never indexed", async () => {
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({ store, embed: e.embed });
    await store.append("c1", [
      markRecallInjected(msg("user", "被注入的检索材料", "m1")),
      {
        id: "m2",
        role: "user",
        content: [{ type: "tool_result", toolCallId: "t1", content: "工具结果的大量文字" }],
        createdAt: 0,
      },
      {
        id: "m3",
        role: "assistant",
        content: [{ type: "thinking", text: "思考过程的大量文字" }],
        createdAt: 0,
      },
      msg("user", "真实用户说的话", "m4"),
    ]);
    await mem.recall("检索材料"); // build
    expect(e.calls()).toBe(2); // only m4's embed + the query
    const out = await mem.recall("真实用户说的话");
    expect(out.length).toBe(1);
    expect(out[0]!.messageId).toBe("m4");
  });

  test("minScoreRatio cuts hits far below the top", async () => {
    const store = new InMemoryStore();
    const mem = createVectorRecallStore({ store, embed: hashEmbed });
    await store.append("c1", [msg("user", "数据库索引", "m1")]);
    await store.append("c2", [msg("user", "今天天气", "m2")]);
    const strict = await mem.recall("数据库索引", { minScoreRatio: 1 });
    expect(strict.length).toBe(1);
    expect(strict[0]!.source).toBe("c1");
    const loose = await mem.recall("数据库索引", { minScoreRatio: 0 });
    expect(loose.length).toBe(2);
  });

  test("a store without list() is indexed append-only", async () => {
    const map = new Map<string, Message[]>();
    const store: MemoryStore = {
      load: async (id) => map.get(id) ?? [],
      append: async (id, ms) => {
        map.set(id, [...(map.get(id) ?? []), ...ms]);
      },
    };
    const mem = createVectorRecallStore({ store, embed: hashEmbed });
    await mem.append("c1", [msg("user", "没有枚举的追加内容", "m1")]);
    const out = await mem.recall("追加内容");
    expect(out.length).toBe(1);
  });

  test("a build aborted mid-conversation is not marked known — the remainder indexes on the next recall", async () => {
    const store = new InMemoryStore();
    await store.append("c1", [
      msg("user", "第一条会被编入", "m1"),
      msg("user", "第二条编入时触发中止", "m2"),
      msg("user", "第三条落在中止之后", "m3"),
    ]);
    const c = new AbortController();
    let n = 0;
    const mem = createVectorRecallStore({
      store,
      embed: async (text) => {
        n += 1;
        if (n === 2) c.abort(); // abort while embedding the SECOND doc
        return hashEmbed(text);
      },
    });
    // First recall: indexes m1, m2, then the abort guard stops before m3 and
    // reconcile must NOT mark the conversation known (partial build).
    expect(await mem.recall("任何", { signal: c.signal })).toEqual([]);
    // Second recall with a live signal: the build resumes — only m3 is new.
    const out = await mem.recall("第三条");
    expect(out.some((s) => s.messageId === "m3")).toBe(true);
    expect(n).toBe(4); // m1+m2 (first pass) + m3 + this query — no re-embedding
  });
});

// ---------------------------------------------------------------------------
// persistIndex
// ---------------------------------------------------------------------------

describe("createVectorRecallStore — persistIndex", () => {
  test("a reboot reuses saved vectors instead of re-embedding", async () => {
    let savedIdx: SavedVectorIndex | undefined;
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({
      store,
      embed: e.embed,
      persistIndex: {
        load: async () => savedIdx,
        save: async (idx) => {
          savedIdx = idx;
        },
      },
    });
    await store.append("c1", [msg("user", "持久化的向量索引", "m1")]);
    await mem.recall("持久化");
    expect(e.calls()).toBe(2); // m1 + the query
    expect(savedIdx?.docs.length).toBe(1);
    expect(savedIdx?.docs[0]?.text).toBe("持久化的向量索引");

    const after = e.calls();
    const rebooted = createVectorRecallStore({
      store,
      embed: e.embed,
      persistIndex: {
        load: async () => savedIdx,
        save: async (idx) => {
          savedIdx = idx;
        },
      },
    });
    const out = await rebooted.recall("持久化");
    expect(out.length).toBe(1);
    expect(out[0]!.messageId).toBe("m1");
    expect(e.calls() - after).toBe(1); // only the new query — m1 came from the saved vector
  });

  test("a stale saved entry — same id, rewritten text — is re-embedded", async () => {
    const persist = {
      load: async () =>
        ({
          docs: [{ conversationId: "c1", messageId: "m1", text: "旧文本", vector: hashEmbed("旧文本") }],
        }) as SavedVectorIndex,
      save: async () => {},
    };
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({ store, embed: e.embed, persistIndex: persist });
    await store.append("c1", [msg("user", "新文本", "m1")]);
    const out = await mem.recall("新文本");
    expect(out.length).toBe(1);
    expect(e.calls()).toBe(2); // m1 re-embedded + the query — the stale vector was not trusted
  });

  test("an embed failure propagates and stays retryable", async () => {
    const store = new InMemoryStore();
    let fail = true;
    const mem = createVectorRecallStore({
      store,
      embed: async (text) => {
        if (fail) throw new Error("embedder down");
        return hashEmbed(text);
      },
    });
    await store.append("c1", [msg("user", "嵌入失败的内容", "m1")]);
    await expect(mem.recall("嵌入失败")).rejects.toThrow("embedder down");
    fail = false;
    const out = await mem.recall("嵌入失败");
    expect(out.length).toBe(1);
    expect(out[0]!.messageId).toBe("m1");
  });

  test("an empty query returns [] without paying for a query embed", async () => {
    const store = new InMemoryStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({ store, embed: e.embed });
    await store.append("c1", [msg("user", "内容在这里", "m1")]);
    expect(await mem.recall("")).toEqual([]);
    expect(e.calls()).toBe(1); // the corpus build still ran; only the query embed is skipped
  });

  test("reset drops the index; the next recall rebuilds it from the store", async () => {
    let savedIdx: SavedVectorIndex | undefined;
    const store = new DeletableStore();
    const e = countingEmbed();
    const mem = createVectorRecallStore({
      store,
      embed: e.embed,
      persistIndex: {
        load: async () => savedIdx,
        save: async (idx) => {
          savedIdx = idx;
        },
      },
    });
    await store.seed("c1", [msg("user", "会被重置的内容", "m1")]);
    await mem.recall("重置");
    expect(e.calls()).toBe(2);
    mem.reset();
    await sleep(0); // fire-and-forget — let the chain drain
    expect(savedIdx?.docs.length ?? 0).toBe(0); // the persisted index was emptied
    const out = await mem.recall("重置");
    expect(out.length).toBe(1); // rebuilt from the store — reset clears vectors, not memory
    expect(e.calls()).toBe(4); // m1 re-embedded + the new query
  });
});

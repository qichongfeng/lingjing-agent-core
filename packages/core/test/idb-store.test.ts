// IDBStore tests over fake-indexeddb (dev-only shim providing the global
// `indexedDB` in Node — no production dependency).

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBStore, InMemoryStore } from "../src/index.js";
import type { Message } from "../src/index.js";

function msg(text: string, role: Message["role"] = "user"): Message {
  return { id: `m-${text}`, role, content: text, createdAt: 0 };
}

async function freshStore(): Promise<IDBStore> {
  // Unique db name per test — fake-indexeddb keeps databases around.
  const name = `test-idb-${Math.random().toString(36).slice(2)}`;
  await indexedDB.deleteDatabase(name);
  return new IDBStore({ dbName: name });
}

let store: IDBStore;

beforeEach(async () => {
  store = await freshStore();
});

afterEach(async () => {
  await store.close();
});

describe("IDBStore", () => {
  it("append → load roundtrip, preserving block content", async () => {
    const complex: Message = {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", text: "hmm" },
        { type: "text", text: "answer" },
        { type: "tool_call", id: "tc1", name: "echo", inputJson: '{"x":1}', input: { x: 1 } },
      ],
      createdAt: 0,
    };
    await store.append("c1", [msg("hi"), complex]);
    const loaded = await store.load("c1");
    expect(loaded).toEqual([msg("hi"), complex]);
  });

  it("appends accumulate in order; unknown conversation → []", async () => {
    await store.append("c1", [msg("one")]);
    await store.append("c1", [msg("two")]);
    expect((await store.load("c1")).map((m) => (m.content as string))).toEqual(["one", "two"]);
    expect(await store.load("missing")).toEqual([]);
  });

  it("conversations are isolated", async () => {
    await store.append("a", [msg("for-a")]);
    await store.append("b", [msg("for-b")]);
    expect(await store.load("a")).toEqual([msg("for-a")]);
    expect(await store.load("b")).toEqual([msg("for-b")]);
  });

  it("persists across instances (reload simulation)", async () => {
    const dbName = `test-idb-reload-${Math.random().toString(36).slice(2)}`;
    const first = new IDBStore({ dbName });
    await first.append("c1", [msg("survives")]);
    await first.close();
    const second = new IDBStore({ dbName });
    expect(await second.load("c1")).toEqual([msg("survives")]);
    await second.close();
  });

  it("delete removes only the target conversation; list reflects state", async () => {
    await store.append("a", [msg("1")]);
    await store.append("b", [msg("2")]);
    expect((await store.list()).sort()).toEqual(["a", "b"]);
    await store.delete("a");
    expect(await store.load("a")).toEqual([]);
    expect(await store.list()).toEqual(["b"]);
  });

  it("append with no messages is a no-op", async () => {
    await store.append("c1", []);
    expect(await store.load("c1")).toEqual([]);
  });

  it("implements the MemoryStore interface (usable as agent memory)", () => {
    const memory: InMemoryStore | IDBStore = store;
    expect(typeof memory.load).toBe("function");
    expect(typeof memory.append).toBe("function");
  });
});

import { describe, expect, test } from "vitest";
import {
  ragInjectHook,
  InMemoryStore,
  createAgent,
  type MemoryStore,
  type MemorySnippet,
  type Message,
} from "../src/index.js";
import { FakeProvider, textTurn } from "./helpers/index.js";

const LABEL = "[Retrieved context]";

function ctxWith(messages: Message[]) {
  return {
    conversationId: "c",
    turn: 1,
    messages,
    tools: [],
    signal: new AbortController().signal,
  };
}

describe("ragInjectHook", () => {
  test("injects a labelled user message when recall returns snippets", async () => {
    const store: MemoryStore = {
      async load() { return []; },
      async append() {},
      async recall() { return [{ content: "fact A", source: "doc1" }, { content: "fact B" }]; },
    };
    const hook = ragInjectHook({ store });
    const r = await hook(ctxWith([{ id: "u1", role: "user", content: "question?", createdAt: 0 }]));
    expect(r).toBeDefined();
    expect(r && "inject" in r).toBe(true);
    const inj = (r as { inject: Message[] }).inject;
    expect(inj[0]?.role).toBe("user");
    expect(typeof inj[0]?.content === "string" && inj[0].content.startsWith(LABEL)).toBe(true);
    expect(typeof inj[0]?.content === "string" && inj[0].content.includes("fact A")).toBe(true);
    expect(typeof inj[0]?.content === "string" && inj[0].content.includes("(doc1)")).toBe(true);
  });

  test("no-op when recall returns no snippets", async () => {
    const store: MemoryStore = { async load() { return []; }, async append() {}, async recall() { return []; } };
    const hook = ragInjectHook({ store });
    const r = await hook(ctxWith([{ id: "u1", role: "user", content: "q", createdAt: 0 }]));
    expect(r).toBeUndefined();
  });

  test("no-op when store has no recall", async () => {
    const store: MemoryStore = new InMemoryStore(); // recall stub returns []
    const hook = ragInjectHook({ store });
    const r = await hook(ctxWith([{ id: "u1", role: "user", content: "q", createdAt: 0 }]));
    expect(r).toBeUndefined();
  });

  test("loop integration: injected context reaches the provider request", async () => {
    const seen: Message[][] = [];
    const provider = new FakeProvider((req) => {
      seen.push(req.messages);
      return textTurn("ok");
    });
    const snippets: MemorySnippet[] = [{ content: "prior fact", source: "mem" }];
    const store: MemoryStore = {
      async load() { return []; },
      async append() {},
      async recall() { return snippets; },
    };
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      hooks: { beforeRequest: ragInjectHook({ store }) },
    });
    await (async () => {
      for await (const _e of agent.stream("what is the prior fact?", { conversationId: "c" }).events) void _e;
    })();
    const firstReq = seen[0];
    expect(firstReq).toBeDefined();
    expect(firstReq?.some((m) => typeof m.content === "string" && (m.content as string).includes(LABEL))).toBe(true);
    expect(firstReq?.some((m) => typeof m.content === "string" && (m.content as string).includes("prior fact"))).toBe(true);
  });
});

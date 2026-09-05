import { describe, expect, test } from "vitest";
import {
  CompactContextManager,
  TrimContextManager,
  type LLMProvider,
  type ProviderChunk,
  type Message,
} from "../src/index.js";

/** A tiny provider: streams `summary` text once + a char/100 token counter.
 * countTokens = messages.length * 100 so we can cross the trigger deterministically. */
function summarizeProvider(summary: string, throws = false): LLMProvider {
  return {
    id: "fake",
    capabilities: { stopReasons: ["end_turn"], streaming: true },
    stream() {
      return (async function* (): AsyncIterable<ProviderChunk> {
        if (throws) throw new Error("summarize boom");
        yield { type: "message_start", messageId: "s1", model: "fake" };
        yield { type: "text_delta", text: summary };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      })();
    },
    countTokens: (msgs) => Promise.resolve(msgs.length * 100),
  };
}

function plainMsg(role: Message["role"], text: string, i: number): Message {
  return { id: `m${i}`, role, content: text, createdAt: i };
}

function toolPair(i: number): [Message, Message] {
  return [
    { id: `a${i}`, role: "assistant", content: [{ type: "tool_call", id: `tc${i}`, name: "x", inputJson: "{}", input: {} }], createdAt: i },
    { id: `u${i}`, role: "user", content: [{ type: "tool_result", toolCallId: `tc${i}`, content: "ok" }], createdAt: i + 1 },
  ];
}

const LABEL = "[Earlier conversation summary]";

describe("TrimContextManager", () => {
  test("drops oldest tool_call/tool_result pair when over trigger", async () => {
    const [a, u] = toolPair(0);
    const msgs = [a, u, plainMsg("user", "keep me", 2), plainMsg("user", "last", 3)];
    const mgr = new TrimContextManager({ triggerRatio: 0.5, keepLastN: 2 });
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 400,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect(r.messages.length).toBe(2); // pair dropped, keepLastN kept
  });
});

describe("CompactContextManager", () => {
  test("fit is a no-op under the trigger ratio", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("S"), model: "fake" });
    const msgs = [plainMsg("user", "one", 0), plainMsg("user", "two", 1)];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(msgs);
  });

  test("fit summarizes head into one labelled note; tail kept verbatim", async () => {
    const mgr = new CompactContextManager({
      provider: summarizeProvider("RECAP"),
      model: "fake",
      keepLastN: 6,
      triggerRatio: 0.75,
    });
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) msgs.push(plainMsg("user", `turn ${i} content`, i));
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect(r.messages.length).toBe(7); // note + 6 tail
    expect(r.messages[0]?.role).toBe("user");
    const noteText = r.messages[0]?.content as string;
    expect(noteText.startsWith(LABEL)).toBe(true);
    expect(noteText).toContain("RECAP");
    // tail verbatim
    for (let i = 0; i < 6; i++) {
      expect(r.messages[1 + i]?.id).toBe(`m${i + 4}`);
    }
  });

  test("compact forces summarization even under the trigger", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("FORCED"), model: "fake" });
    // 8 messages with default keepLastN:6 → head has 2 msgs to summarize.
    // countTokens:0 means fit() would no-op (under trigger); compact() must still summarize.
    const msgs: Message[] = [];
    for (let i = 0; i < 8; i++) msgs.push(plainMsg("user", `m${i}`, i));
    const r = await mgr.compact({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: () => Promise.resolve(0),
    });
    expect(r.compacted).toBe(true);
    expect(r.messages[0]?.content).toContain("FORCED");
  });

  test("provider error falls back to trim (never throws)", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("", true), model: "fake" });
    const [a, u] = toolPair(0);
    const msgs = [a, u, ...Array.from({ length: 8 }, (_, i) => plainMsg("user", `p${i}`, i + 2))];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    // trim dropped the one tool pair → 8 messages kept
    expect(r.messages.length).toBe(8);
  });

  test("a second compact does not nest summary notes", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("RECAP2"), model: "fake" });
    const oldNote: Message = { id: "old", role: "user", content: `${LABEL}\nold recap`, createdAt: 0 };
    const msgs = [oldNote, ...Array.from({ length: 8 }, (_, i) => plainMsg("user", `t${i}`, i + 1))];
    const r = await mgr.compact({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    const notes = r.messages.filter((m) => typeof m.content === "string" && (m.content as string).startsWith(LABEL));
    expect(notes.length).toBe(1);
    expect((notes[0]?.content as string)).toContain("RECAP2");
  });
});

import { describe, expect, test } from "vitest";
import {
  CompactContextManager,
  TrimContextManager,
  materializeCompactedView,
  type LLMProvider,
  type ProviderChunk,
  type Message,
  type ProviderRequest,
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

const LABEL = "[Earlier conversation summary]"; // legacy label form (notes built below use it)
const PREFIX = "[Earlier conversation summary"; // matching key — current notes carry a self-describing suffix

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
    expect(noteText.startsWith(PREFIX)).toBe(true);
    expect(noteText).toContain("not a user message"); // self-describing label
    expect(noteText).toContain("RECAP");
    // tail verbatim
    for (let i = 0; i < 6; i++) {
      expect(r.messages[1 + i]?.id).toBe(`m${i + 4}`);
    }
  });

  test("runId in the fit input stamps the summary note (run's exchange grouping)", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("RECAP"), model: "fake" });
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) msgs.push(plainMsg("user", `turn ${i} content`, i));
    const base = {
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m: Message[]) => Promise.resolve(m.length * 100),
    };
    const stamped = await mgr.fit({ ...base, runId: "run-1" });
    expect(stamped.compacted).toBe(true);
    expect(stamped.messages[0]?.metadata?.runId).toBe("run-1");
    // Without a runId the note carries no stamp — groupExchanges' structural
    // fallback for host-authored history keeps working unchanged.
    const unstamped = await mgr.fit({ ...base });
    expect(unstamped.messages[0]?.metadata?.runId).toBeUndefined();
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

  test("pair-aware split: a tool_result at the tail boundary keeps its tool_use (no orphan tool message)", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("RECAP"), model: "fake", keepLastN: 6 });
    const [tu, tr] = toolPair(9);
    const msgs: Message[] = [
      plainMsg("user", "q0", 0),
      plainMsg("assistant", "a1", 1),
      plainMsg("user", "q2", 2),
      plainMsg("assistant", "a3", 3),
      tu, // idx 4 — assistant(tool_use tc9)
      tr, // idx 5 — user(tool_result tc9); raw split (11 - keepLastN 6) lands exactly here
      plainMsg("user", "q6", 6),
      plainMsg("assistant", "a7", 7),
      plainMsg("user", "q8", 8),
      plainMsg("assistant", "a9", 9),
      plainMsg("user", "q10", 10),
    ];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    // The pair is pulled back into the tail together: the message right after
    // the note is the assistant(tool_use), NOT an orphaned user(tool_result).
    expect(r.messages.length).toBe(8); // note + 7-message tail
    expect(r.messages[1]?.id).toBe("a9");
    expect(r.messages[2]?.id).toBe("u9");
    expect((r.messages[0]?.content as string)).toContain("RECAP");
  });

  test("a second compact does not nest summary notes", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("RECAP2"), model: "fake" });
    const oldNote: Message = { id: "old", role: "user", content: `${LABEL}\nold recap`, createdAt: 0 };
    const msgs = [oldNote, ...Array.from({ length: 8 }, (_, i) => plainMsg("user", `t${i}`, i + 1))];
    const r = await mgr.compact({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    const notes = r.messages.filter((m) => typeof m.content === "string" && (m.content as string).startsWith(PREFIX));
    expect(notes.length).toBe(1);
    expect((notes[0]?.content as string)).toContain("RECAP2");
  });

  test("microcompact: stubbing old tool_results + dropping old thinking gets under the trigger with ZERO model calls", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: "stub-counter",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream() {
        calls++;
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "text_delta", text: "SHOULD-NOT-RUN" };
        })();
      },
    };
    const mgr = new CompactContextManager({ provider, model: "fake" });
    // char-based counter so stubbing actually moves the estimate: a fat old
    // tool_result dominates, the stub marker shrinks it to noise.
    const chars = (msgs: Message[]) =>
      msgs.reduce(
        (sum, m) =>
          sum + (typeof m.content === "string"
            ? m.content.length
            : m.content.reduce((s: number, b) =>
                s + (b.type === "tool_result" ? String(b.content).length : b.type === "text" ? b.text.length : 4), 0)),
        0,
      ) / 4;
    const msgs: Message[] = [
      { id: "a0", role: "assistant", createdAt: 0, content: [
        { type: "thinking", text: "长".repeat(400), signature: "s" }, // old thinking → dropped
        { type: "tool_call", id: "tc0", name: "web_read", inputJson: "{}", input: {} },
      ] },
      { id: "u0", role: "user", createdAt: 1, content: [
        { type: "tool_result", toolCallId: "tc0", content: "结".repeat(4000) }, // fat result → stubbed
      ] },
      ...Array.from({ length: 6 }, (_, i) => plainMsg("user", `tail ${i}`, i + 2)),
    ];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(chars(m)),
    });
    expect(r.compacted).toBe(true);
    expect(calls).toBe(0); // microcompact alone sufficed — no summarize call
    expect(r.messages.length).toBe(8); // full view kept, nothing summarized away
    expect(r.messages.every((m, i) => m.id === msgs[i]!.id)).toBe(true); // ids stable
    const a0 = r.messages[0]!.content as Message["content"];
    expect(Array.isArray(a0) && a0.some((b) => b.type === "thinking")).toBe(false); // thinking dropped
    expect(Array.isArray(a0) && a0.some((b) => b.type === "tool_call" && b.id === "tc0")).toBe(true); // call kept
    const u0 = r.messages[1]!.content as Extract<Message["content"], Array<any>>;
    expect(u0[0]).toMatchObject({ type: "tool_result", toolCallId: "tc0", content: "[cleared for context: old tool result]" });
    // tail untouched
    expect(r.messages[2]).toBe(msgs[2]);
  });

  test("microcompact insufficient (plain-text head) falls through to summarize", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("RECAP"), model: "fake" });
    const msgs = Array.from({ length: 10 }, (_, i) => plainMsg("user", `t${i}`, i));
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect((r.messages[0]?.content as string).startsWith(PREFIX)).toBe(true);
    expect(r.messages[0]?.content).toContain("\nRECAP"); // summarize ran — nothing to stub
  });

  test("incremental: boundary not past coverage → reuse the note verbatim, ZERO model calls", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: "counting",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream() {
        calls++;
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "s", model: "fake" };
          yield { type: "text_delta", text: "SHOULD-NOT-RUN" };
          yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })();
      },
      countTokens: (msgs) => Promise.resolve(msgs.length * 100),
    };
    const mgr = new CompactContextManager({ provider, model: "fake" });
    // Store order (append-only): originals, then the note covering through the
    // second message (id m1), then newer turns. splitAt = 8 - 6 = 2 →
    // headRegion = [m0, m1, note]: after coveredUntil (m1) the only head
    // message is the note itself → reuse.
    const note: Message = {
      id: "note1", role: "user", content: `${LABEL}\nREUSED-RECAP`, createdAt: 5,
      metadata: { coveredUntil: "m1" },
    };
    const msgs = [
      plainMsg("user", "h0 text", 0),
      plainMsg("user", "h1 text", 1),
      note,
      plainMsg("assistant", "t0", 2),
      plainMsg("user", "t1", 3),
      plainMsg("assistant", "t2", 4),
      plainMsg("user", "t3", 5),
      plainMsg("assistant", "t4", 6),
      plainMsg("user", "input", 7),
    ];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect(calls).toBe(0); // the whole point: no re-summarize when coverage holds
    expect(r.messages.length).toBe(7); // reused note + 6 tail
    expect(r.messages[0]?.id).toBe("note1");
    expect(r.messages[0]?.content).toBe(`${LABEL}\nREUSED-RECAP`);
    expect(r.messages[1]?.id).toBe(msgs[3]!.id); // tail starts right after the note
  });

  test("incremental: new material past coverage → ONE call folding prior recap + increment; stamps fresh coverage", async () => {
    const seen: string[] = [];
    const provider: LLMProvider = {
      id: "capturing",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        seen.push(String(req.messages[0]?.content));
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "s", model: "fake" };
          yield { type: "text_delta", text: "NEW-RECAP" };
          yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })();
      },
      countTokens: (msgs) => Promise.resolve(msgs.length * 100),
    };
    const mgr = new CompactContextManager({ provider, model: "fake" });
    // splitAt = 10 - 6 = 4 → headRegion = [m0, m1, note1(covered m1), m2]:
    // increment past coverage = [m2] → fold OLD-RECAP + it into NEW-RECAP.
    const note: Message = {
      id: "note1", role: "user", content: `${LABEL}\nOLD-RECAP`, createdAt: 5,
      metadata: { coveredUntil: "m1" },
    };
    const msgs = [
      plainMsg("user", "h0 text", 0),
      plainMsg("user", "h1 text", 1),
      note,
      plainMsg("assistant", "m1 text", 2), // id m2 — the only uncovered head message
      plainMsg("user", "m2 text", 3), // id m3 — already inside the tail window
      plainMsg("assistant", "t0", 4),
      plainMsg("user", "t1", 5),
      plainMsg("assistant", "t2", 6),
      plainMsg("user", "t3", 7),
      plainMsg("user", "input", 8),
    ];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect(seen.length).toBe(1); // one incremental call, not a full-head summarize
    expect(seen[0]).toContain("OLD-RECAP"); // prior recap folded in
    expect(seen[0]).toContain("m1 text"); // the increment
    expect(seen[0]).not.toContain("h0 text"); // covered originals NOT re-sent
    expect(r.messages.length).toBe(7); // fresh note + 6 tail
    expect((r.messages[0]?.content as string).startsWith(PREFIX)).toBe(true);
    expect(r.messages[0]?.content).toContain("\nNEW-RECAP");
    expect(r.messages[0]?.metadata?.coveredUntil).toBe("m2"); // coverage advanced to the last head message
  });

  test("full summarize stamps coveredUntil so the NEXT fit goes incremental", async () => {
    const mgr = new CompactContextManager({ provider: summarizeProvider("FIRST-RECAP"), model: "fake" });
    const msgs = Array.from({ length: 10 }, (_, i) => plainMsg("user", `t${i}`, i));
    const first = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(first.messages[0]?.metadata?.coveredUntil).toBe("m3"); // last head message at split time
  });

  test("materialized view (covered originals dropped): re-compaction FOLDS the prior note — coverage is not lost", async () => {
    const seen: string[] = [];
    const provider: LLMProvider = {
      ...summarizeProvider("ROLLING-RECAP"),
      stream(req) {
        seen.push(String(req.messages[0]?.content));
        return summarizeProvider("ROLLING-RECAP").stream(req);
      },
    };
    const mgr = new CompactContextManager({ provider, model: "fake" });
    // What a reload materializes: note1 leads, the messages its coveredUntil
    // ("m99") covered are GONE from the array → the incremental path cannot
    // resolve coverage → full path, which must still fold note1's recap.
    const note: Message = {
      id: "note1", role: "user", content: `${LABEL}\nOLD-RECAP`, createdAt: 5,
      metadata: { coveredUntil: "m99" },
    };
    const msgs = [
      note,
      ...Array.from({ length: 6 }, (_, i) => plainMsg("user", `head${i} text`, i)),
      ...Array.from({ length: 6 }, (_, i) => plainMsg("user", `tail${i} text`, i + 6)),
    ];
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("OLD-RECAP"); // the prior recap rode along — m-anything before it is not lost
    expect(r.messages.some((m) => m.id === "note1")).toBe(false); // subsumed by the new note
    expect(String(r.messages[0]?.content)).toContain("ROLLING-RECAP");
  });
});

describe("real-usage anchor (currentTokens)", () => {
  test("Trim fires on the anchored total even when the heuristic alone says we're fine", async () => {
    const [a, u] = toolPair(0);
    const msgs = [a, u, plainMsg("user", "keep me", 2), plainMsg("user", "last", 3)];
    const mgr = new TrimContextManager({ triggerRatio: 0.5, keepLastN: 2 });
    // Heuristic 4*100=400 ≤ trigger 500 → no-op without an anchor…
    const unanchored = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(unanchored.compacted).toBe(false);
    // …but the provider really reported 900 total (system + tools + cache the
    // heuristic can't see): 400 + overhead 500 = 900 > 500 → trim.
    const anchored = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
      currentTokens: 900,
    });
    expect(anchored.compacted).toBe(true);
    expect(anchored.messages.length).toBe(2); // trimmed to keepLastN, still over — can't go further
  });

  test("Compact microcompacts on the anchored total with ZERO model calls", async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: "stub-counter",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream() {
        calls++;
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "text_delta", text: "SHOULD-NOT-RUN" };
        })();
      },
    };
    const mgr = new CompactContextManager({ provider, model: "fake" });
    // One fat old tool_result dominates the heuristic; the tail stays lean.
    const msgs: Message[] = [
      { id: "a0", role: "assistant", createdAt: 0, content: [{ type: "tool_call", id: "tc0", name: "web_read", inputJson: "{}", input: {} }] },
      { id: "u0", role: "user", createdAt: 1, content: [{ type: "tool_result", toolCallId: "tc0", content: "x".repeat(2200) }] },
      ...Array.from({ length: 6 }, (_, i) => plainMsg("user", `tail ${i}`, i + 2)),
    ];
    const chars = (m: Message[]) =>
      m.reduce(
        (sum, x) =>
          sum + (typeof x.content === "string"
            ? x.content.length
            : x.content.reduce((s: number, b) =>
              s + (b.type === "tool_result" ? String(b.content).length : b.type === "text" ? b.text.length : 4), 0)),
        0,
      ) / 4;
    const base = {
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m: Message[]) => Promise.resolve(chars(m)),
    };
    // Heuristic ≈ (2200 + tail)/4 ≈ 575 < trigger 750 → heuristic-only no-op.
    const unanchored = await mgr.fit({ ...base });
    expect(unanchored.compacted).toBe(false);
    // Anchored 800 (real overhead from system+tools+cache the heuristic can't
    // see) → over trigger → microcompact stubs the fat result → back under,
    // without ever calling the summarize model.
    const anchored = await mgr.fit({ ...base, currentTokens: 800 });
    expect(anchored.compacted).toBe(true);
    expect(calls).toBe(0); // stubbing sufficed — the summarize model never ran
  });
});

describe("summarize request hygiene (thinking off + vendor switch)", () => {
  test("requestSummaryText disables thinking and forwards providerOptions", async () => {
    const seen: ProviderRequest[] = [];
    const provider: LLMProvider = {
      id: "capturing",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        seen.push(req);
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "s", model: req.model };
          yield { type: "text_delta", text: "RECAP" };
          yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
        })();
      },
    };
    const mgr = new CompactContextManager({
      provider, model: "fake",
      providerOptions: { body: { enable_thinking: false } },
    });
    const msgs = Array.from({ length: 10 }, (_, i) => plainMsg("user", `t${i}`, i));
    const r = await mgr.fit({
      messages: msgs, tools: [], system: undefined, tokenBudget: 1000,
      countTokens: (m) => Promise.resolve(m.length * 100),
    });
    expect(r.compacted).toBe(true);
    expect(seen.length).toBe(1);
    // Summarization is mechanical compression: no thinking, vendor switch through.
    expect(seen[0]!.config.thinking).toEqual({ type: "disabled" });
    expect(seen[0]!.config.providerOptions).toEqual({ body: { enable_thinking: false } });
  });
});

describe("materializeCompactedView (persisted-compaction inverse)", () => {
  const note = (coveredUntil: string | undefined, id = "note-1"): Message => ({
    id,
    role: "user",
    content: `${PREFIX} — auto-generated recap of earlier turns, not a user message]\nrecap`,
    createdAt: 0,
    ...(coveredUntil !== undefined ? { metadata: { coveredUntil } } : {}),
  });

  test("drops the originals the newest note covers, leads the view with it, keeps the rest", () => {
    // Append-only store layout: [originals…, tail-originals…, note, post-compaction turns].
    const store = [
      plainMsg("user", "q1", 0),
      plainMsg("assistant", "a1", 1),
      plainMsg("user", "q2", 2), // ← coveredUntil (last head message)
      plainMsg("user", "q3", 3), // tail original kept verbatim at compaction time
      note("m2"),
      plainMsg("assistant", "post", 5),
    ];
    const view = materializeCompactedView(store);
    expect(view.map((m) => m.id)).toEqual(["note-1", "m3", "m5"]);
  });

  test("older notes in the remainder are subsumed (dropped)", () => {
    const store = [
      plainMsg("user", "q1", 0),
      note("m0", "note-old"),
      note("m0", "note-new"),
      plainMsg("user", "q2", 3),
    ];
    const view = materializeCompactedView(store);
    expect(view.map((m) => m.id)).toEqual(["note-new", "m3"]);
  });

  test("no note → unchanged (same reference)", () => {
    const store = [plainMsg("user", "q1", 0)];
    expect(materializeCompactedView(store)).toBe(store);
  });

  test("stamp unresolvable / missing / after the note → conservative full view", () => {
    const noStamp = [plainMsg("user", "q1", 0), note(undefined), plainMsg("user", "q2", 2)];
    expect(materializeCompactedView(noStamp).length).toBe(3);
    const stale = [plainMsg("user", "q1", 0), note("gone-id")];
    expect(materializeCompactedView(stale).length).toBe(2);
    // coveredUntil pointing AFTER the note (odd host reordering) → bail out.
    const odd = [note("m1"), plainMsg("user", "q1", 0), plainMsg("user", "q2", 1)];
    expect(materializeCompactedView(odd).length).toBe(3);
  });
});

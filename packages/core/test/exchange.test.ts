import { beforeEach, describe, expect, test } from "vitest";
import { groupExchanges, type ExchangeStep, type Exchange, type ToolPairStep } from "../src/exchange.js";
import type { Message, ToolCall, ToolResult } from "../src/types.js";
import { withRunId } from "../src/types.js";
import { createAgent, InMemoryStore } from "../src/index.js";
import { scriptedProvider, toolCallTurn, textTurn, echoTool } from "./helpers/index.js";

let seq = 0;
function user(content: Message["content"]): Message {
  return { id: `u${++seq}`, role: "user", content, createdAt: 0 };
}
function assistant(content: Message["content"]): Message {
  return { id: `a${++seq}`, role: "assistant", content, createdAt: 0 };
}
/** Stamp with a runId, mirroring what agent.stream()/runLoop write. */
function run(m: Message, runId: string): Message {
  return withRunId(m, runId);
}
/** A carrier as runLoop writes it: runId + sourceMessageId back-pointer. */
function runCarrier(runId: string, source: Message, ...results: ToolResult[]): Message {
  return { ...carrier(...results), metadata: { runId, sourceMessageId: source.id } };
}
/** The carrier runLoop persists after a tool-bearing turn: one user message,
 *  content purely tool_result blocks. */
function carrier(...results: ToolResult[]): Message {
  return user(results);
}
function call(id: string): ToolCall {
  return { type: "tool_call", id, name: "search", inputJson: "{}", input: {} };
}
function result(toolCallId: string, text = "ok"): ToolResult {
  return { type: "tool_result", toolCallId, content: text };
}

function kinds(steps: ExchangeStep[]): string[] {
  return steps.map((s) => s.kind);
}

/** Strict-index-safe accessors: fail loudly if the projection moved a step. */
function exAt(list: Exchange[], i: number): Exchange {
  const e = list[i];
  if (!e) throw new Error(`expected exchange at ${i}`);
  return e;
}
function pairAt(steps: ExchangeStep[], i: number): ToolPairStep {
  const s = steps[i];
  if (!s || s.kind !== "tool_pair") throw new Error(`expected tool_pair at ${i}`);
  return s;
}
function orphanAt(steps: ExchangeStep[], i: number): ToolResult {
  const s = steps[i];
  if (!s || s.kind !== "tool_result") throw new Error(`expected tool_result at ${i}`);
  return s.result;
}

beforeEach(() => {
  seq = 0;
});

describe("groupExchanges", () => {
  test("plain Q&A is one exchange", () => {
    const [u, a] = [user("hi"), assistant("hello")];
    const out = groupExchanges([u, a]);
    expect(out).toHaveLength(1);
    expect(exAt(out, 0).user).toBe(u);
    expect(kinds(exAt(out, 0).steps)).toEqual(["assistant"]);
    expect(exAt(out, 0).steps[0]).toEqual({ kind: "assistant", message: a });
  });

  test("tool round stays inside one exchange with the result paired", () => {
    const out = groupExchanges([
      user("search it"),
      assistant([{ type: "text", text: "let me look" }, call("t1")]),
      carrier(result("t1", "found")),
      assistant("here is the answer"),
    ]);
    expect(out).toHaveLength(1);
    expect(kinds(exAt(out, 0).steps)).toEqual(["assistant", "tool_pair", "assistant"]);
    const pair = pairAt(exAt(out, 0).steps, 1);
    expect(pair.call.id).toBe("t1");
    expect(pair.result?.content).toBe("found");
  });

  test("parallel tool calls share one carrier and pair by toolCallId", () => {
    const out = groupExchanges([
      user("both"),
      assistant([call("t1"), call("t2")]),
      carrier(result("t2", "second"), result("t1", "first")),
    ]);
    expect(out).toHaveLength(1);
    const pairs = exAt(out, 0).steps.filter((s) => s.kind === "tool_pair");
    expect(pairs).toHaveLength(2);
    // Pair order follows call order, results matched by id not position.
    const p1 = pairAt(exAt(out, 0).steps, 1);
    const p2 = pairAt(exAt(out, 0).steps, 2);
    expect(p1.call.id).toBe("t1");
    expect(p1.result?.content).toBe("first");
    expect(p2.call.id).toBe("t2");
    expect(p2.result?.content).toBe("second");
  });

  test("interrupted tail: tool_pair stays with result undefined", () => {
    const out = groupExchanges([user("q"), assistant([call("t1")])]);
    expect(pairAt(exAt(out, 0).steps, 1).result).toBeUndefined();
  });

  test("hook-injected user message structurally opens its own exchange", () => {
    const out = groupExchanges([user("q"), user("[rag context]"), assistant("answer")]);
    expect(out).toHaveLength(2);
    expect(exAt(out, 0).user?.content).toBe("q");
    expect(exAt(out, 0).steps).toEqual([]);
    expect(exAt(out, 1).user?.content).toBe("[rag context]");
    expect(kinds(exAt(out, 1).steps)).toEqual(["assistant"]);
  });

  test("history without a leading user seeds an exchange with user undefined", () => {
    const out = groupExchanges([assistant("hi there"), user("hello"), assistant("how can I help")]);
    expect(out).toHaveLength(2);
    expect(exAt(out, 0).user).toBeUndefined();
    expect(kinds(exAt(out, 0).steps)).toEqual(["assistant"]);
    expect(exAt(out, 1).user?.content).toBe("hello");
  });

  test("orphan results are kept, not dropped (compaction trimmed the call)", () => {
    const out = groupExchanges([
      user("q"),
      assistant([call("t1")]),
      carrier(result("t1"), result("gone")),
      assistant("answer"),
    ]);
    const steps = exAt(out, 0).steps;
    const orphanIdx = steps.findIndex((s) => s.kind === "tool_result");
    expect(orphanIdx).toBeGreaterThanOrEqual(0);
    expect(orphanAt(steps, orphanIdx).toolCallId).toBe("gone");
    // The matched pair still filled; the unmatched one left the pair untouched.
    expect(pairAt(steps, 1).result?.toolCallId).toBe("t1");
  });

  test("leading carrier after compaction: orphans open a userless exchange", () => {
    const out = groupExchanges([carrier(result("x")), assistant("resumed")]);
    expect(out).toHaveLength(1);
    expect(exAt(out, 0).user).toBeUndefined();
    expect(kinds(exAt(out, 0).steps)).toEqual(["tool_result", "assistant"]);
  });

  test("mixed-content user message opens an exchange verbatim (not deconstructed)", () => {
    const mixed = user([
      { type: "text", text: "host-built" },
      result("t9"),
    ]);
    const out = groupExchanges([assistant([call("t9")]), mixed, assistant("done")]);
    // Structural rule: any non-carrier user message opens a new exchange. The
    // mixed message is kept verbatim — t9's result stays embedded in
    // exchange.user.content, never paired and never orphaned.
    expect(out).toHaveLength(2);
    expect(exAt(out, 0).user).toBeUndefined();
    expect(exAt(out, 1).user).toBe(mixed);
    expect(exAt(out, 0).steps.filter((s) => s.kind === "tool_result")).toEqual([]);
    expect(pairAt(exAt(out, 0).steps, 1).result).toBeUndefined();
  });

  test("tool_pair.call references the same object as the assistant message content", () => {
    const c = call("t1");
    const out = groupExchanges([user("q"), assistant([c])]);
    expect(pairAt(exAt(out, 0).steps, 1).call).toBe(c);
  });

  test("two consecutive conversations group independently", () => {
    const out = groupExchanges([
      user("1"),
      assistant("a1"),
      user("2"),
      assistant([call("t1")]),
      carrier(result("t1")),
      assistant("a2"),
    ]);
    expect(out).toHaveLength(2);
    expect(exAt(out, 0).user?.content).toBe("1");
    expect(kinds(exAt(out, 0).steps)).toEqual(["assistant"]);
    expect(exAt(out, 1).user?.content).toBe("2");
    expect(kinds(exAt(out, 1).steps)).toEqual(["assistant", "tool_pair", "assistant"]);
  });

  test("empty input yields no exchanges", () => {
    expect(groupExchanges([])).toEqual([]);
  });

  test("conservation: every message and tool_result block appears exactly once", () => {
    const r1 = result("t1");
    const rOrphan = result("orphan");
    const msgs = [
      user("1"),
      assistant([call("t1"), call("t2")]),
      carrier(r1, rOrphan),
      assistant("mid"),
      user("2"),
      assistant("a2"),
    ];
    const out = groupExchanges(msgs);

    // Every non-carrier message appears exactly once (as user or assistant step).
    for (const [i, m] of msgs.entries()) {
      if (i === 2) continue; // carrier handled at block level below
      const asUser = out.filter((e) => e.user === m).length;
      const asStep = out.filter((e) => e.steps.some((s) => s.kind === "assistant" && s.message === m)).length;
      expect(asUser + asStep).toBe(1);
    }
    // Every tool_result block appears exactly once (paired or orphaned).
    for (const r of [r1, rOrphan]) {
      const n = out.reduce(
        (acc, e) =>
          acc +
          e.steps.filter(
            (s) =>
              (s.kind === "tool_pair" && s.result === r) ||
              (s.kind === "tool_result" && s.result === r),
          ).length,
        0,
      );
      expect(n).toBe(1);
    }
    // Every tool_call block surfaces exactly once as a pair step.
    expect(out.reduce((acc, e) => acc + e.steps.filter((s) => s.kind === "tool_pair").length, 0)).toBe(2);
  });
});

describe("groupExchanges — runId (explicit) path", () => {
  test("one run = one exchange: input, tool round, final answer", () => {
    const a1 = assistant([call("t1")]);
    const out = groupExchanges([
      run(user("search"), "r1"),
      run(a1, "r1"),
      runCarrier("r1", a1, result("t1", "found")),
      run(assistant("answer"), "r1"),
    ]);
    expect(out).toHaveLength(1);
    expect(exAt(out, 0).user?.content).toBe("search");
    expect(kinds(exAt(out, 0).steps)).toEqual(["assistant", "tool_pair", "assistant"]);
    expect(pairAt(exAt(out, 0).steps, 1).result?.content).toBe("found");
  });

  test("hook-injected context stays inside the run (user step, not a new exchange)", () => {
    const out = groupExchanges([
      run(user("q"), "r1"),
      run(user("[rag context]"), "r1"),
      run(assistant("answer"), "r1"),
    ]);
    expect(out).toHaveLength(1);
    expect(exAt(out, 0).user?.content).toBe("q");
    expect(kinds(exAt(out, 0).steps)).toEqual(["user", "assistant"]);
  });

  test("Message[] input: first message is the opener, the rest are user steps", () => {
    const out = groupExchanges([
      run(user("a"), "r1"),
      run(user("b"), "r1"),
      run(assistant("ok"), "r1"),
    ]);
    expect(out).toHaveLength(1);
    expect(exAt(out, 0).user?.content).toBe("a");
    expect(kinds(exAt(out, 0).steps)).toEqual(["user", "assistant"]);
  });

  test("runs and unstamped history interleave in order", () => {
    const a1 = assistant([call("t1")]);
    const out = groupExchanges([
      user("before"), // structural exchange (host-seeded, no run stamp)
      run(user("in run"), "r1"), // run exchange
      run(a1, "r1"),
      runCarrier("r1", a1, result("t1")),
      user("after"), // structural exchange closes the run
      assistant("tail"), // joins the "after" exchange
    ]);
    expect(out).toHaveLength(3);
    expect(exAt(out, 0).user?.content).toBe("before");
    expect(exAt(out, 0).steps).toEqual([]);
    expect(exAt(out, 1).user?.content).toBe("in run");
    expect(kinds(exAt(out, 1).steps)).toEqual(["assistant", "tool_pair"]);
    expect(exAt(out, 2).user?.content).toBe("after");
    expect(kinds(exAt(out, 2).steps)).toEqual(["assistant"]);
  });

  test("orphan in a run stays in the run's exchange", () => {
    const out = groupExchanges([
      run(user("q"), "r1"),
      runCarrier("r1", assistant([]), result("ghost")),
      run(assistant("a"), "r1"),
    ]);
    expect(out).toHaveLength(1);
    expect(kinds(exAt(out, 0).steps)).toEqual(["tool_result", "assistant"]);
  });

  test("two runs are two exchanges even without user-role boundaries", () => {
    const out = groupExchanges([
      run(user("1"), "r1"),
      run(assistant("a1"), "r1"),
      run(user("2"), "r2"),
      run(assistant("a2"), "r2"),
    ]);
    expect(out).toHaveLength(2);
    expect(exAt(out, 0).user?.content).toBe("1");
    expect(exAt(out, 1).user?.content).toBe("2");
  });
});

describe("groupExchanges — end to end with the real loop", () => {
  test("agent.stream stamps runId; memory load groups into one exchange with tools paired", async () => {
    const memory = new InMemoryStore();
    const provider = scriptedProvider([
      toolCallTurn("echo", { hello: "world" }, 0),
      textTurn("done"),
    ]);
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      tools: [echoTool()],
      memory,
    });
    await agent.run("hi", { conversationId: "c" });

    const stored = await memory.load("c");
    // Write side: every stored message carries the same runId; the carrier
    // additionally back-points at the assistant message it answers.
    const runIds = new Set(stored.map((m) => (m.metadata as { runId?: string }).runId));
    expect(runIds.size).toBe(1);
    const carrierMsg = stored.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    const assistantMsg = stored.find((m) => m.role === "assistant");
    expect((carrierMsg?.metadata as { sourceMessageId?: string }).sourceMessageId).toBe(
      assistantMsg?.id,
    );

    // Read side: one exchange, input as opener, tool paired, final answer present.
    const out = groupExchanges(stored);
    expect(out).toHaveLength(1);
    const ex = exAt(out, 0);
    expect(ex.user?.content).toBe("hi");
    expect(kinds(ex.steps)).toEqual(["assistant", "tool_pair", "assistant"]);
    const pair = pairAt(ex.steps, 1);
    expect(pair.call.name).toBe("echo");
    expect(pair.result?.content).toBe(JSON.stringify({ hello: "world" }));
    // Duration persists on the block → the reloaded tool card matches the live one.
    expect(typeof pair.result?.ms).toBe("number");
  });
});

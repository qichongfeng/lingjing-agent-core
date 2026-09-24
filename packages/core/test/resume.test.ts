// Run-level resume: tail classification, protocol repair for dangling tool
// rounds, prefill continuation of partial replies, nothing_to_resume for
// conversations at rest, and persistRuns crash-safe incremental persistence.

import { describe, expect, test } from "vitest";
import {
  AbortError,
  createAgent,
  extractText,
  inspectRunTail,
  InMemoryStore,
  materializeCompactedView,
  type AgentEvent,
  type LLMProvider,
  type Message,
  type ProviderChunk,
  type StreamHandle,
  type ToolCall,
} from "../src/index.js";
import { echoTool, FakeProvider, scriptedProvider, textTurn, toolCallTurn } from "./helpers/index.js";

async function collect(handle: StreamHandle): Promise<{ events: AgentEvent[]; message?: Message; error?: unknown }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  try {
    return { events, message: await handle.done };
  } catch (error) {
    return { events, error };
  }
}

const user = (text: string, i = 0): Message => ({ id: `u${i}`, role: "user", content: text, createdAt: i });
const assistantText = (text: string, stopReason: string | undefined, i = 1): Message => ({
  id: `a${i}`,
  role: "assistant",
  content: text,
  createdAt: i,
  ...(stopReason !== undefined ? { metadata: { stopReason, usage: { inputTokens: 1, outputTokens: 1 } } } : {}),
});
const assistantToolUse = (calls: Array<{ id: string; name: string; input: unknown }>): Message => ({
  id: "a-tools",
  role: "assistant",
  content: calls.map((c): ToolCall => ({ type: "tool_call", id: c.id, name: c.name, inputJson: JSON.stringify(c.input), input: c.input })),
  createdAt: 2,
  metadata: { runId: "r-old", stopReason: "tool_use" },
});
const carrier = (toolCallId: string, i = 3): Message => ({
  id: `c${i}`,
  role: "user",
  content: [{ type: "tool_result", toolCallId, content: "ok" }],
  createdAt: i,
});

describe("inspectRunTail (pure classification)", () => {
  test("empty / finished → at-rest", () => {
    expect(inspectRunTail([])).toEqual({ kind: "at-rest" });
    expect(inspectRunTail([user("q"), assistantText("done", "end_turn")])).toEqual({ kind: "at-rest" });
    expect(inspectRunTail([user("q"), assistantText("done", "stop_sequence")])).toEqual({ kind: "at-rest" });
  });
  test("user tail (input or tool-result carrier) → continue", () => {
    expect(inspectRunTail([assistantText("a", "end_turn", 0), user("q")])).toEqual({ kind: "continue" });
    expect(inspectRunTail([assistantToolUse([{ id: "t1", name: "x", input: {} }]), carrier("t1")])).toEqual({ kind: "continue" });
  });
  test("assistant tool_use tail → answer-tools with the unanswered calls", () => {
    const tail = inspectRunTail([user("q"), assistantToolUse([{ id: "t1", name: "x", input: {} }, { id: "t2", name: "y", input: {} }])]) as
      Extract<ReturnType<typeof inspectRunTail>, { kind: "answer-tools" }>;
    expect(tail.kind).toBe("answer-tools");
    expect(tail.calls.map((c) => c.id)).toEqual(["t1", "t2"]);
  });
  test("non-terminal assistant → continue-partial", () => {
    expect(inspectRunTail([user("q"), assistantText("half", "aborted")])).toEqual({ kind: "continue-partial" });
    expect(inspectRunTail([user("q"), assistantText("cut", "max_tokens")])).toEqual({ kind: "continue-partial" });
    expect(inspectRunTail([user("q"), assistantText("legacy unstamped", undefined)])).toEqual({ kind: "continue-partial" });
  });
});

describe("agent.resume", () => {
  test("dangling tool round: synthesizes honest isError results, then re-drives to completion", async () => {
    const store = new InMemoryStore();
    await store.append("c", [user("write the report"), assistantToolUse([{ id: "t9", name: "write_file", input: { path: "r.md" } }])]);
    const reqs: Message[][] = [];
    const provider = new FakeProvider((req) => {
      reqs.push(req.messages);
      return textTurn("resumed and finished");
    });
    const agent = createAgent({ provider, model: "fake", memory: store, tools: [echoTool()] });
    const { events, message } = await collect(agent.resume({ conversationId: "c" }));

    expect(message && extractText(message)).toBe("resumed and finished");
    // The resume request carried a protocol-complete carrier for the dangling call.
    const reqCarrier = reqs[0]!.find((m) => m.role === "user" && Array.isArray(m.content)
      && m.content.some((b) => b.type === "tool_result")) as Message;
    expect(reqCarrier).toBeDefined();
    const tr = (reqCarrier.content as Array<{ type: string; toolCallId?: string; isError?: boolean; content?: unknown }>)[0]!;
    expect(tr.toolCallId).toBe("t9");
    expect(tr.isError).toBe(true);
    expect(String(tr.content)).toContain("MAY or MAY NOT");
    // Persisted: the carrier is durable before the re-drive.
    const persisted = await store.load("c");
    expect(persisted.some((m) => Array.isArray(m.content)
      && m.content.some((b) => b.type === "tool_result" && (b as { toolCallId?: string }).toolCallId === "t9"))).toBe(true);
    // The exchange stays grouped: the carrier carries the old run's runId.
    expect((persisted.find((m) => m.id !== "a-tools" && Array.isArray(m.content)) as Message | undefined)?.metadata?.runId).toBe("r-old");
    void events;
  });

  test("partial reply: the request ends with it (prefill continuation) and completes", async () => {
    const store = new InMemoryStore();
    await store.append("c", [user("tell me a story"), assistantText("Once upon a", "aborted")]);
    const reqs: Message[][] = [];
    const provider = new FakeProvider((req) => {
      reqs.push(req.messages);
      return textTurn(" time there was a bot.");
    });
    const agent = createAgent({ provider, model: "fake", memory: store });
    const { message } = await collect(agent.resume({ conversationId: "c" }));
    expect(message && extractText(message)).toBe(" time there was a bot.");
    const last = reqs[0]![reqs[0]!.length - 1]!;
    expect(last.role).toBe("assistant");
    expect(extractText(last)).toBe("Once upon a");
  });

  test("dangling input (run crashed before any reply): drives the next turn", async () => {
    const store = new InMemoryStore();
    await store.append("c", [user("hello?")]);
    const agent = createAgent({ provider: scriptedProvider([textTurn("here I am")]), model: "fake", memory: store });
    const { message } = await collect(agent.resume({ conversationId: "c" }));
    expect(message && extractText(message)).toBe("here I am");
  });

  test("conversation at rest: recoverable nothing_to_resume + normal done, no provider call", async () => {
    const store = new InMemoryStore();
    await store.append("c", [user("q"), assistantText("final", "end_turn")]);
    let calls = 0;
    const provider = new FakeProvider(() => {
      calls++;
      return textTurn("should not run");
    });
    const agent = createAgent({ provider, model: "fake", memory: store });
    const { events, message } = await collect(agent.resume({ conversationId: "c" }));
    expect(calls).toBe(0);
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(err?.code).toBe("nothing_to_resume");
    expect(err?.recoverable).toBe(true);
    const done = events.find((e) => e.type === "done") as Extract<AgentEvent, { type: "done" }> | undefined;
    expect(done?.finalText).toBe("final");
    expect(message && extractText(message)).toBe("final");
  });
});

describe("persistRuns (crash-safe incremental persistence)", () => {
  /** Streams a tool_use turn, executes the tool, then hangs the next provider
   * call until aborted — the persistence state mid-run is observable. */
  function hangAfterToolProvider(): { provider: LLMProvider; reqs: number } {
    const state = { reqs: 0 };
    const provider: LLMProvider = {
      id: "hang-after-tool",
      capabilities: { stopReasons: ["end_turn", "tool_use"], streaming: true },
      stream(req) {
        const mine = state.reqs++;
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: `m${mine}`, model: "fake" };
          if (mine === 0) {
            yield { type: "tool_call_start", toolCallId: "tc-h", name: "echo" };
            yield { type: "tool_call_delta", toolCallId: "tc-h", inputJsonDelta: "{}" };
            yield { type: "tool_call_end", toolCallId: "tc-h" };
            yield { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
            return;
          }
          await new Promise<never>((_, reject) => {
            req.signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
          });
        })();
      },
    };
    return { provider, ...state };
  }

  test("input/assistant/carrier are durable WHILE the run is still in flight; no duplicates after abort", async () => {
    const store = new InMemoryStore();
    const { provider } = hangAfterToolProvider();
    const agent = createAgent({ provider, model: "fake", memory: store, tools: [echoTool()], persistRuns: true });
    const conv = agent.conversation("crash");
    const handle = conv.send("do it");
    const settled = handle.done.then(() => "ok", () => "aborted");

    // Wait for the tool round to complete (carrier persisted) while the next
    // provider call hangs — i.e. done has NOT settled yet. The tool_result
    // EVENT is a per-tool streaming signal emitted before the round's single
    // carrier is built, so it does not imply durability; poll instead (the run
    // is parked on the hanging provider call, so the state is stable).
    for await (const e of handle.events) {
      if (e.type === "tool_result") break;
    }
    for (let i = 0; i < 100 && (await store.load("crash")).length < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const midRun = await store.load("crash");
    expect(midRun.length).toBe(3); // input + assistant(tool_use) + carrier — already durable
    expect(midRun[0]?.content).toBe("do it");
    expect(midRun[2] && Array.isArray(midRun[2]!.content)).toBe(true);

    handle.abort();
    expect(await settled).toBe("aborted");
    const afterAbort = await store.load("crash");
    expect(afterAbort.length).toBe(3); // batch append added nothing (no duplicates)
  });
});

describe("resume after a user abort (host-side filtering)", () => {
  /** Streams some text, then hangs until aborted — what a real transport leaves
   *  behind when the user hits stop. */
  const hangMidText = (text: string): LLMProvider => ({
    id: "hang-mid-text",
    capabilities: { stopReasons: ["end_turn"], streaming: true },
    stream(req) {
      return (async function* (): AsyncIterable<ProviderChunk> {
        yield { type: "message_start", messageId: "m0", model: "fake" };
        yield { type: "text_delta", text };
        await new Promise<never>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
        });
      })();
    },
  });

  test("an aborted run's durable tail classifies as continue-partial, stamped 'aborted'", async () => {
    const store = new InMemoryStore();
    const agent = createAgent({ provider: hangMidText("Half a sen"), model: "fake", memory: store, persistRuns: true });
    const handle = agent.conversation("stop").send("tell me a story");
    for await (const e of handle.events) {
      if (e.type === "text_delta") break;
    }
    handle.abort();
    await expect(handle.done).rejects.toThrow();

    const persisted = await store.load("stop");
    const tail = inspectRunTail(materializeCompactedView(persisted));
    // Shape-wise identical to a crash-cut partial — which is why the offer is
    // the host's call, and why stopReason is the precise filter.
    expect(tail.kind).toBe("continue-partial");
    const last = persisted[persisted.length - 1]!;
    expect(last.metadata?.stopReason).toBe("aborted");
    expect(extractText(last)).toBe("Half a sen");
  });
});

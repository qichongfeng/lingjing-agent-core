import { describe, expect, test } from "vitest";
import {
  createAgent,
  extractText,
  AbortError,
  type AgentEvent,
  type Message,
  type StreamHandle,
} from "../src/index.js";
import {
  loopTrapProvider,
  scriptedProvider,
  textTurn,
  toolCallTurn,
  multiToolCallTurn,
  echoTool,
  addTool,
  failTool,
} from "./helpers/index.js";

type DoneEvent = Extract<AgentEvent, { type: "done" }>;
type ErrorEvent = Extract<AgentEvent, { type: "error" }>;

async function collect(handle: StreamHandle): Promise<{
  events: AgentEvent[];
  message?: Message;
  error?: unknown;
}> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  try {
    const message = await handle.done;
    return { events, message };
  } catch (error) {
    return { events, error };
  }
}

const findDone = (events: AgentEvent[]): DoneEvent | undefined =>
  events.find((e) => e.type === "done") as DoneEvent | undefined;
const findError = (events: AgentEvent[]): ErrorEvent | undefined =>
  events.find((e) => e.type === "error") as ErrorEvent | undefined;

describe("agentic loop", () => {
  test("termination guarantee: loop-trap provider still terminates at maxTurns", async () => {
    // FakeProvider ALWAYS returns tool_use. Without a hard cap this would loop forever.
    const provider = loopTrapProvider("echo");
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 10,
      tools: [echoTool()],
    });

    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));

    expect(error).toBeUndefined(); // soft terminal — done resolves, does not reject
    const err = findError(events);
    expect(err?.code).toBe("max_turns_exceeded");
    expect(err?.recoverable).toBe(true);
    const done = findDone(events);
    expect(done).toBeDefined();
    expect(done?.turns).toBe(10); // exactly 10 turns executed, then capped
  });

  test("single tool call: echo executes and final text is returned", async () => {
    const provider = scriptedProvider([
      toolCallTurn("echo", { hello: "world" }, 0),
      textTurn("done"),
    ]);
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      tools: [echoTool()],
    });

    const { events, message } = await collect(agent.stream("hi", { conversationId: "c" }));

    expect(message && extractText(message)).toBe("done");
    expect(events.some((e) => e.type === "tool_call" && e.name === "echo")).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
    const done = findDone(events);
    expect(done?.turns).toBe(2);
  });

  test("parallel tool calls: all execute, results returned in one user turn", async () => {
    const provider = scriptedProvider([
      multiToolCallTurn([
        { name: "add", input: { a: 1, b: 2 }, id: "t1" },
        { name: "add", input: { a: 10, b: 20 }, id: "t2" },
      ]),
      textTurn("added"),
    ]);
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      tools: [addTool()],
    });

    const { events, message } = await collect(agent.stream("hi", { conversationId: "c" }));

    const results = events.filter((e) => e.type === "tool_result");
    expect(results.length).toBe(2);
    expect(message && extractText(message)).toBe("added");
  });

  test("final message IS the persisted history object (identity + run stamp)", async () => {
    // The object runLoop pushes into history, returns, resolves done with, and
    // hands to afterTurn must be the SAME instance — hosts locate the turn
    // via indexOf/===, and memory.append persists what was pushed.
    const seen: { indexOfResponse: number; runId: unknown }[] = [];
    const provider = scriptedProvider([textTurn("done")]);
    const agent = createAgent({
      provider,
      model: "fake",
      hooks: {
        async afterTurn(ctx) {
          seen.push({ indexOfResponse: ctx.messages.indexOf(ctx.response), runId: ctx.response.metadata?.runId });
        },
      },
    });
    const handle = agent.stream("hi", { conversationId: "identity" });
    const finalMsg = await handle.done;

    expect(extractText(finalMsg)).toBe("done");
    expect(finalMsg.metadata?.runId).toBeTypeOf("string");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.indexOfResponse).toBeGreaterThanOrEqual(0); // found in history
    expect(seen[0]?.runId).toBe(finalMsg.metadata?.runId); // same stamped instance
  });

  test("tool error becomes isError tool_result; loop recovers", async () => {
    const provider = scriptedProvider([
      toolCallTurn("fail", {}, 0),
      textTurn("recovered"),
    ]);
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      tools: [failTool()],
    });

    const { events, message } = await collect(agent.stream("hi", { conversationId: "c" }));

    expect(message && extractText(message)).toBe("recovered");
    const errResult = events.find(
      (e) => e.type === "tool_result" && e.isError,
    );
    expect(errResult).toBeDefined();
  });

  test("max_tokens continues to the next turn (not terminal)", async () => {
    const provider = scriptedProvider([
      textTurn("partial", "max_tokens"),
      textTurn("final"),
    ]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5 });

    const { events, message } = await collect(agent.stream("hi", { conversationId: "c" }));

    expect(message && extractText(message)).toBe("final");
    expect(events.filter((e) => e.type === "turn_end").length).toBe(2);
    const done = findDone(events);
    expect(done?.turns).toBe(2);
  });

  test("unknown tool yields isError tool_result; loop continues", async () => {
    const provider = scriptedProvider([
      toolCallTurn("does_not_exist", {}, 0),
      textTurn("moved on"),
    ]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [] });

    const { events, message } = await collect(agent.stream("hi", { conversationId: "c" }));

    expect(message && extractText(message)).toBe("moved on");
    const r = events.find((e) => e.type === "tool_result" && e.isError);
    expect(r).toBeDefined();
  });

  test("abort propagates as AbortError and emits an aborted error event", async () => {
    const provider = loopTrapProvider("echo");
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 100,
      tools: [echoTool()],
    });

    const handle = agent.stream("go", { conversationId: "c" });
    handle.abort();
    const { events, error } = await collect(handle);

    expect(error).toBeInstanceOf(AbortError);
    const err = findError(events);
    expect(err?.code).toBe("aborted");
    expect(findDone(events)).toBeUndefined(); // hard failure — no done event
  });

  test("schema validation rejects invalid tool input before execute", async () => {
    let executed = false;
    const provider = scriptedProvider([
      toolCallTurn("add", { a: "not-a-number", b: 2 }, 0), // a wrong type
      textTurn("ok"),
    ]);
    const agent = createAgent({
      provider,
      model: "fake",
      maxTurns: 5,
      tools: [
        {
          name: "add",
          description: "add",
          inputSchema: {
            jsonSchema: {
              type: "object",
              properties: { a: { type: "integer" }, b: { type: "integer" } },
              required: ["a", "b"],
              additionalProperties: false,
            },
          },
          async execute() {
            executed = true;
            return { content: "0" };
          },
        },
      ],
    });

    const { events } = await collect(agent.stream("hi", { conversationId: "c" }));

    expect(executed).toBe(false); // never ran — schema rejected it
    const r = events.find((e) => e.type === "tool_result" && e.isError);
    expect(r).toBeDefined();
  });

  test("multi-turn continuity on the default conversation", async () => {
    let n = 0;
    const provider = scriptedProvider([
      textTurn("turn-1"),
      textTurn("turn-2"),
    ]);
    // scriptedProvider replays per stream() call (turn counter resets per FakeProvider? No —
    // it's shared across calls). Use a fresh scripted provider per call instead:
    const agent = createAgent({ provider, model: "fake", maxTurns: 5 });

    // First send
    const r1 = await collect(agent.stream("first", { conversationId: "c" }));
    expect(r1.message && extractText(r1.message)).toBe("turn-1");
    void n;

    // Second send continues the same history (scripted provider advanced to turn-2)
    const r2 = await collect(agent.stream("second", { conversationId: "c" }));
    expect(r2.message && extractText(r2.message)).toBe("turn-2");
  });

  test("thinking duration is stamped on the persisted ThinkingContent block", async () => {
    const provider = scriptedProvider([
      [
        { type: "message_start", messageId: "msg_th", model: "fake" },
        { type: "thinking_delta", text: "hmm " },
        { type: "thinking_delta", text: "hmm" },
        { type: "thinking_end", signature: "sig_1" },
        { type: "text_delta", text: "answer" },
        { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ]);
    const agent = createAgent({ provider, model: "fake" });
    const { message } = await collect(agent.stream("q", { conversationId: "c" }));
    const blocks = message && Array.isArray(message.content) ? message.content : [];
    const thinking = blocks.find((b): b is Extract<(typeof blocks)[number], { type: "thinking" }> => b.type === "thinking");
    expect(thinking?.text).toBe("hmm hmm");
    expect(thinking?.signature).toBe("sig_1");
    expect(typeof thinking?.ms).toBe("number");
  });
});

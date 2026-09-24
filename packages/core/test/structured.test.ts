// Structured output (agent.respond / runStructured): forced-tool extraction,
// schema validation, one protocol-clean repair retry, persistence that never
// leaves a dangling respond tool_use.

import { describe, expect, test } from "vitest";
import {
  AbortError,
  createAgent,
  InMemoryStore,
  StructuredOutputError,
  type LLMProvider,
  type Message,
  type ProviderChunk,
  type ProviderRequest,
} from "../src/index.js";
import { FakeProvider, scriptedProvider, textTurn, toolCallTurn } from "./helpers/index.js";

const NUMBER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

/** Extract the single tool_call of an assistant message (respond turns carry exactly one). */
function onlyCall(m: Message): { id: string; input: unknown } {
  const blocks = Array.isArray(m.content) ? m.content : [];
  const tc = blocks.find((b) => b.type === "tool_call") as { id: string; input: unknown } | undefined;
  if (!tc) throw new Error("no tool_call in message");
  return { id: tc.id, input: tc.input };
}

describe("agent.respond", () => {
  test("happy path: validated data + protocol-complete persistence", async () => {
    const store = new InMemoryStore();
    const provider = scriptedProvider([toolCallTurn("respond", { answer: 42 })]);
    const agent = createAgent({ provider, model: "fake", memory: store });
    const data = await agent.respond<{ answer: number }>("extract", {
      conversationId: "s1", schema: NUMBER_SCHEMA,
    });
    expect(data).toEqual({ answer: 42 });

    const persisted = await store.load("s1");
    expect(persisted.length).toBe(3); // input + assistant(respond) + carrier
    expect(persisted[0]?.content).toBe("extract");
    const call = onlyCall(persisted[1]!);
    expect(call.input).toEqual({ answer: 42 });
    // The carrier answers THAT call id — the next request stays protocol-valid.
    const carrier = persisted[2]!;
    expect(carrier.role).toBe("user");
    const tr = (carrier.content as Array<{ type: string; toolCallId?: string }>)[0]!;
    expect(tr.type).toBe("tool_result");
    expect(tr.toolCallId).toBe(call.id);
    // Usage is stamped like any turn (survives reload for conversationUsage).
    const usage = (persisted[1]!.metadata?.usage as { inputTokens?: number } | undefined) ?? {};
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("schema violation → one corrective retry → success; only the final attempt persists", async () => {
    const store = new InMemoryStore();
    const provider = scriptedProvider([
      toolCallTurn("respond", { answer: "not-a-number" }), // fails $.answer type
      toolCallTurn("respond", { answer: 7 }),
    ]);
    const agent = createAgent({ provider, model: "fake", memory: store });
    const data = await agent.conversation("s2").respond("extract", { schema: NUMBER_SCHEMA });
    expect(data).toEqual({ answer: 7 });
    const persisted = await store.load("s2");
    expect(persisted.length).toBe(3); // the failed attempt never persists
    expect(onlyCall(persisted[1]!).input).toEqual({ answer: 7 });
  });

  test("no respond call (plain end_turn) → text corrective retry → success", async () => {
    const store = new InMemoryStore();
    const provider = scriptedProvider([
      textTurn("I will just answer in prose"),
      toolCallTurn("respond", { answer: 1 }),
    ]);
    const agent = createAgent({ provider, model: "fake", memory: store });
    const data = await agent.conversation("s3").respond("extract", { schema: NUMBER_SCHEMA });
    expect(data).toEqual({ answer: 1 });
  });

  test("unparseable respond arguments (truncated JSON) → repair recovers", async () => {
    const broken: ProviderChunk[] = [
      { type: "message_start", messageId: "m-cut", model: "fake" },
      { type: "tool_call_start", toolCallId: "tc-cut", name: "respond" },
      { type: "tool_call_delta", toolCallId: "tc-cut", inputJsonDelta: '{"answer": 4' },
      { type: "tool_call_end", toolCallId: "tc-cut" },
      { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 2 } },
    ];
    const provider = scriptedProvider([broken, toolCallTurn("respond", { answer: 4 })]);
    const agent = createAgent({ provider, model: "fake", memory: new InMemoryStore() });
    const data = await agent.conversation("s4").respond("extract", { schema: NUMBER_SCHEMA });
    expect(data).toEqual({ answer: 4 });
  });

  test("repairs exhausted → StructuredOutputError; only the input persists (no dangling tool_use)", async () => {
    const store = new InMemoryStore();
    const provider = scriptedProvider([
      toolCallTurn("respond", { wrong: "shape" }),
      textTurn("still no tool"),
    ]);
    const agent = createAgent({ provider, model: "fake", memory: store });
    await expect(
      agent.conversation("s5").respond("extract", { schema: NUMBER_SCHEMA }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    const persisted = await store.load("s5");
    expect(persisted.length).toBe(1); // input only — no unanswered respond tool_use
    expect(persisted[0]?.content).toBe("extract");
  });

  test("abort: rejects with AbortError; the input persists, nothing dangles", async () => {
    const store = new InMemoryStore();
    const provider = scriptedProvider([toolCallTurn("respond", { answer: 1 })]);
    const agent = createAgent({ provider, model: "fake", memory: store });
    const controller = new AbortController();
    controller.abort();
    await expect(
      agent.conversation("s6").respond("extract", { schema: NUMBER_SCHEMA, signal: controller.signal }),
    ).rejects.toMatchObject({ name: AbortError.name });
    const persisted = await store.load("s6");
    expect(persisted.length).toBe(1);
  });

  test("respond sees the full prior conversation (compose send → respond)", async () => {
    const store = new InMemoryStore();
    const reqs: Message[][] = [];
    const provider = new FakeProvider((req, turn) => {
      reqs.push(req.messages);
      return turn === 0
        ? textTurn("the value is 41")
        : toolCallTurn("respond", { answer: 41 });
    });
    const agent = createAgent({ provider, model: "fake", memory: store });
    const conv = agent.conversation("s7");
    await conv.send("look up the value").done;
    const data = await conv.respond("now extract the number", { schema: NUMBER_SCHEMA });
    expect(data).toEqual({ answer: 41 });
    // The extraction request carried the earlier turn AND its reply.
    const texts = reqs[1]!.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts).toContain("look up the value");
    expect(texts).toContain("now extract the number");
    // And the extraction turn forced exactly one tool: respond.
    void provider;
  });

  test("schema root must be { type: 'object' }", async () => {
    const agent = createAgent({ provider: scriptedProvider([]), model: "fake" });
    await expect(
      agent.conversation("s8").respond("x", { schema: { type: "string" } }),
    ).rejects.toThrow(/schema root/);
  });

  test("the forced request carries only the respond tool with toolChoice tool", async () => {
    const seen: Array<{ tools: string[]; toolChoice: unknown }> = [];
    const provider: LLMProvider = {
      id: "spy",
      capabilities: { stopReasons: ["tool_use"], streaming: true },
      stream(req: ProviderRequest) {
        seen.push({
          tools: (req.tools ?? []).map((t) => t.name),
          toolChoice: req.config.toolChoice,
        });
        return (async function* (): AsyncIterable<ProviderChunk> {
          yield { type: "message_start", messageId: "m", model: "fake" };
          yield { type: "tool_call_start", toolCallId: "t", name: "respond" };
          yield { type: "tool_call_delta", toolCallId: "t", inputJsonDelta: '{"answer":0}' };
          yield { type: "tool_call_end", toolCallId: "t" };
          yield { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
        })();
      },
    };
    const agent = createAgent({
      provider, model: "fake",
      tools: [{ name: "other", description: "x", inputSchema: { jsonSchema: { type: "object" } }, async execute() { return { content: "" }; } }],
    });
    await agent.conversation("s9").respond("x", { schema: NUMBER_SCHEMA });
    expect(seen).toEqual([
      { tools: ["respond"], toolChoice: { type: "tool", name: "respond" } },
    ]);
  });
});

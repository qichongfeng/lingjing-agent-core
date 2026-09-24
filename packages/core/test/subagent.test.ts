// Subagents (spawn pattern): report plumbing, event forwarding with meta,
// usage footer, concurrency cap, depth semantics, abort propagation, and
// registry validation. Parents and subagents get separate fake providers so
// their scripts don't interleave.

import { describe, expect, test } from "vitest";
import {
  AbortError,
  createAgent,
  createSpawnTool,
  extractText,
  type AgentEvent,
  type LLMProvider,
  type ProviderChunk,
  type SpawnEventMeta,
  type StreamHandle,
} from "../src/index.js";
import {
  multiToolCallTurn,
  scriptedProvider,
  textTurn,
  toolCallTurn,
} from "./helpers/index.js";

async function collect(handle: StreamHandle): Promise<{ events: AgentEvent[]; finalText: string }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  return { events, finalText: extractText(await handle.done) };
}

const toolResults = (es: AgentEvent[]) =>
  es.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
const resultText = (es: AgentEvent[], i = 0): string => {
  const c = toolResults(es)[i]!.content;
  return Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : "")).join("") : String(c);
};

/** Provider that records each run's last user text + model, serving `chunks()`. */
function capturingProvider(
  chunks: () => ProviderChunk[] | Promise<ProviderChunk[]>,
): { provider: LLMProvider; tasks: string[]; models: string[] } {
  const tasks: string[] = [];
  const models: string[] = [];
  const provider: LLMProvider = {
    id: "capturing",
    capabilities: { stopReasons: ["end_turn", "tool_use"], streaming: true },
    stream(req) {
      models.push(req.model);
      const input = [...req.messages].reverse().find((m) => m.role === "user");
      tasks.push(typeof input?.content === "string" ? input.content : JSON.stringify(input?.content ?? null));
      return (async function* () {
        for (const c of await chunks()) yield c;
      })();
    },
  };
  return { provider, tasks, models };
}

const RESEARCHER = { name: "researcher", description: "researches things", system: "be brief", tools: [] };

describe("createSpawnTool", () => {
  test("runs the subagent in a fresh conversation and returns its report", async () => {
    const child = capturingProvider(() => textTurn("child report"));
    const spawn = createSpawnTool([RESEARCHER], { provider: child.provider, model: "fake-main" });
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "researcher", task: "find X" }),
        textTurn("parent done"),
      ]),
      model: "fake",
      tools: [spawn],
    });

    const { events, finalText } = await collect(parent.stream("go", { conversationId: "c" }));

    // The subagent saw ONLY the task text, on the spawn tool's default model.
    expect(child.tasks).toEqual(["find X"]);
    expect(child.models).toEqual(["fake-main"]);
    expect(toolResults(events)[0]!.isError).toBe(false);
    expect(resultText(events)).toContain("child report");
    expect(finalText).toBe("parent done");
  });

  test("per-definition model override wins over the spawn default", async () => {
    const child = capturingProvider(() => textTurn("ok"));
    const spawn = createSpawnTool(
      [{ ...RESEARCHER, name: "fast", model: "cheap-model" }],
      { provider: child.provider, model: "fake-main" },
    );
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "fast", task: "t" }),
        textTurn("done"),
      ]),
      model: "fake",
      tools: [spawn],
    });
    await collect(parent.stream("go", { conversationId: "c" }));
    expect(child.models).toEqual(["cheap-model"]);
  });

  test("model override + tier config: override rewrites main, tiers stay as fallbacks", async () => {
    const child = capturingProvider(() => textTurn("ok"));
    const spawn = createSpawnTool(
      [{ ...RESEARCHER, name: "fast", model: "cheap-model" }],
      {
        provider: child.provider,
        models: { main: "fake-main", fast: "tiny-model", max: "big-model" },
      },
    );
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "fast", task: "t" }),
        textTurn("done"),
      ]),
      model: "fake",
      tools: [spawn],
    });
    await collect(parent.stream("go", { conversationId: "c" }));
    // Child starts on the override; the tier table around it changed main.
    expect(child.models).toEqual(["cheap-model"]);
  });

  test("forwards child events with agent/runId/depth meta and a usage footer", async () => {
    const child = capturingProvider(() => textTurn("child report"));
    const forwarded: Array<{ event: AgentEvent; meta: SpawnEventMeta }> = [];
    const spawn = createSpawnTool([RESEARCHER], {
      provider: child.provider,
      model: "fake-main",
      onEvent: (event, meta) => forwarded.push({ event, meta }),
    });
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "researcher", task: "find X" }),
        textTurn("parent done"),
      ]),
      model: "fake",
      tools: [spawn],
    });

    const { events } = await collect(parent.stream("go", { conversationId: "c" }));

    expect(forwarded.map((f) => f.event.type)).toEqual(["start", "text_delta", "turn_end", "done"]);
    const metas = forwarded.map((f) => f.meta);
    expect(metas.every((m) => m.agent === "researcher" && m.depth === 1)).toBe(true);
    expect(metas.every((m) => typeof m.toolCallId === "string" && m.toolCallId !== "")).toBe(true);
    expect(new Set(metas.map((m) => m.runId)).size).toBe(1); // one correlated stream
    const childDone = forwarded.at(-1)!.event as Extract<AgentEvent, { type: "done" }>;
    expect(childDone.finalText).toBe("child report");
    expect(childDone.totalUsage.inputTokens).toBeGreaterThan(0);
    // Usage rollup rides the parent-visible tool result.
    expect(resultText(events)).toMatch(/\[subagent "researcher": 1 turn\(s\), ~\d+ in \/ ~\d+ out tokens\]$/);
  });

  test("unknown subagent name is a recoverable error listing the registry", async () => {
    const child = capturingProvider(() => textTurn("unused"));
    const spawn = createSpawnTool([RESEARCHER], { provider: child.provider, model: "fake-main" });
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "nope", task: "x" }),
        textTurn("parent done"),
      ]),
      model: "fake",
      tools: [spawn],
    });
    const { events } = await collect(parent.stream("go", { conversationId: "c" }));
    const r = toolResults(events)[0]!;
    expect(r.isError).toBe(true);
    expect(resultText(events)).toContain("researcher");
    expect(child.tasks).toEqual([]); // nothing was spawned
  });

  // ------------------------------------------------------------ concurrency

  test("parallel spawn calls run concurrently up to maxConcurrent", async () => {
    let active = 0;
    let maxActive = 0;
    const child: LLMProvider = {
      id: "slow",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream() {
        return (async function* () {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 25));
          active--;
          for (const c of textTurn("w")) yield c;
        })();
      },
    };
    const twoSpawnTurn = (): ProviderChunk[] =>
      multiToolCallTurn([
        { name: "spawn_agent", input: { agent: "worker", task: "1" }, id: "tc_a" },
        { name: "spawn_agent", input: { agent: "worker", task: "2" }, id: "tc_b" },
      ]);
    const makeParent = (maxConcurrent: number) =>
      createAgent({
        provider: scriptedProvider([twoSpawnTurn(), textTurn("parent done")]),
        model: "fake",
        tools: [
          createSpawnTool([{ name: "worker", description: "w", system: "s", tools: [] }], {
            provider: child,
            model: "fake",
            maxConcurrent,
          }),
        ],
      });

    maxActive = 0;
    await collect(makeParent(3).stream("go", { conversationId: "a" }));
    expect(maxActive).toBe(2); // cap above demand: both children overlap

    maxActive = 0;
    await collect(makeParent(1).stream("go", { conversationId: "b" }));
    expect(maxActive).toBe(1); // serialized through the shared semaphore
  });

  // ---------------------------------------------------------------- depth

  test("maxDepth default 1: subagents get no spawn tool", async () => {
    const child = capturingProvider(() => toolCallTurn("spawn_agent", { agent: "researcher", task: "again" }));
    const forwarded: AgentEvent[] = [];
    const spawn = createSpawnTool([RESEARCHER], {
      provider: child.provider,
      model: "fake-main",
      onEvent: (e) => forwarded.push(e),
    });
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "researcher", task: "outer" }),
        textTurn("parent done"),
      ]),
      model: "fake",
      tools: [spawn],
    });
    await collect(parent.stream("go", { conversationId: "c" }));

    // The child tried to recurse and got the standard unknown-tool refusal
    // (its own recoverable error — forwarded, not fatal).
    const childToolResult = toolResults(forwarded)[0]!;
    expect(childToolResult.isError).toBe(true);
    expect(JSON.stringify(childToolResult.content)).toContain("Unknown tool: spawn_agent");
  });

  test("maxDepth 2: subagents can spawn one level deeper", async () => {
    // One shared provider dispatching on the incoming task text: the researcher
    // delegates to `leaf`, the leaf answers with its report, the researcher wraps up.
    const leafTasks: string[] = [];
    const provider: LLMProvider = {
      id: "nested",
      capabilities: { stopReasons: ["end_turn", "tool_use"], streaming: true },
      stream(req) {
        const input = [...req.messages].reverse().find((m) => m.role === "user");
        const text = typeof input?.content === "string" ? input.content : "";
        return (async function* () {
          if (text === "leaf task") {
            leafTasks.push(text);
            for (const c of textTurn("grand report")) yield c;
          } else if (text === "outer") {
            for (const c of toolCallTurn("spawn_agent", { agent: "leaf", task: "leaf task" })) yield c;
          } else {
            for (const c of textTurn("child done after grandchild")) yield c;
          }
        })();
      },
    };
    const metas: SpawnEventMeta[] = [];
    const spawn = createSpawnTool(
      [RESEARCHER, { name: "leaf", description: "leaf work", system: "s", tools: [] }],
      { provider, model: "fake-main", maxDepth: 2, onEvent: (_e, meta) => metas.push(meta) },
    );
    const parent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("spawn_agent", { agent: "researcher", task: "outer" }),
        textTurn("parent done"),
      ]),
      model: "fake",
      tools: [spawn],
    });

    const { events } = await collect(parent.stream("go", { conversationId: "c" }));

    expect(leafTasks).toEqual(["leaf task"]); // the grandchild really ran
    expect(metas).toContainEqual(expect.objectContaining({ agent: "leaf", depth: 2 }));
    // The grandchild's output reached the researcher (turn 2), whose report — not
    // the grandchild's transcript — is what the parent conversation sees.
    expect(resultText(events)).toContain("child done after grandchild");
  });

  // ---------------------------------------------------------------- abort

  test("aborting the parent run aborts the subagent", async () => {
    const child: LLMProvider = {
      id: "hang",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        return (async function* () {
          yield { type: "message_start", messageId: "m", model: "fake" };
          // Transport-parity hang: like a real provider whose fetch body dies
          // on abort, the stream rejects when req.signal fires.
          await new Promise<never>((_, reject) => {
            req.signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
          });
        })();
      },
    };
    const spawn = createSpawnTool([RESEARCHER], { provider: child, model: "fake-main" });
    const parent = createAgent({
      provider: scriptedProvider([toolCallTurn("spawn_agent", { agent: "researcher", task: "find X" })]),
      model: "fake",
      tools: [spawn],
    });

    const handle = parent.stream("go", { conversationId: "c" });
    const events: AgentEvent[] = [];
    let error: unknown;
    const settled = (async () => {
      try {
        await handle.done;
      } catch (e) {
        error = e;
      }
    })();
    for await (const e of handle.events) {
      events.push(e);
      if (e.type === "tool_call") handle.abort(); // stop once the subagent is running
    }
    await settled;

    expect(error).toBeInstanceOf(AbortError);
    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.code).toBe("aborted");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("aborting a queued subagent does not inflate the concurrency cap", async () => {
    // Shared spawn tool across two runs. Run 1: cap 1 — the first child hangs,
    // the second queues; abort mid-wait. Run 2 must still serialize (maxActive
    // 1): a waiter aborted out of the queue must not release a slot it never held.
    let active = 0;
    let maxActive = 0;
    let hang = true;
    const child: LLMProvider = {
      id: "hang-or-run",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        active++;
        maxActive = Math.max(maxActive, active);
        return (async function* () {
          try {
            if (hang) {
              // Transport-parity hang: rejects on abort like a dying fetch body.
              await new Promise<never>((_, reject) => {
                req.signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
              });
            } else {
              await new Promise((r) => setTimeout(r, 20));
            }
            for (const c of textTurn("w")) yield c;
          } finally {
            active--; // runs on return()/throw() too — the abort path stops consuming
          }
        })();
      },
    };
    const twoSpawnTurn = (): ProviderChunk[] =>
      multiToolCallTurn([
        { name: "spawn_agent", input: { agent: "worker", task: "1" }, id: "tc_a" },
        { name: "spawn_agent", input: { agent: "worker", task: "2" }, id: "tc_b" },
      ]);
    const spawn = createSpawnTool([{ name: "worker", description: "w", system: "s", tools: [] }], {
      provider: child,
      model: "fake",
      maxConcurrent: 1,
    });

    // Run 1 — aborted while one child hangs and one waits in the queue.
    const parent1 = createAgent({
      provider: scriptedProvider([twoSpawnTurn(), textTurn("unreached")]),
      model: "fake",
      tools: [spawn],
    });
    const handle = parent1.stream("go", { conversationId: "c1" });
    let seenCalls = 0;
    const settled = (async () => {
      try {
        await handle.done;
      } catch {
        /* AbortError expected */
      }
    })();
    for await (const e of handle.events) {
      if (e.type === "tool_call") seenCalls++;
      if (seenCalls === 2) handle.abort(); // both calls dispatched: one running, one queued
    }
    await settled;

    // Run 2 — same tool instance; capacity must be intact (still 1).
    hang = false;
    maxActive = 0;
    const parent2 = createAgent({
      provider: scriptedProvider([twoSpawnTurn(), textTurn("parent done")]),
      model: "fake",
      tools: [spawn],
    });
    const r2 = await collect(parent2.stream("go again", { conversationId: "c2" }));
    expect(r2.finalText).toBe("parent done");
    expect(maxActive).toBe(1);
  });

  // ----------------------------------------------------------- validation

  test("rejects empty registry, duplicate names, bad names, missing default model", () => {
    const { provider } = capturingProvider(() => textTurn("x"));
    expect(() => createSpawnTool([], { provider, model: "m" })).toThrow(/at least one/);
    expect(() => createSpawnTool([RESEARCHER, RESEARCHER], { provider, model: "m" })).toThrow(/Duplicate/);
    expect(() =>
      createSpawnTool([{ ...RESEARCHER, name: "Bad Name" }], { provider, model: "m" }),
    ).toThrow(/must match/);
    expect(() => createSpawnTool([RESEARCHER], { provider })).toThrow(/default model/);
    expect(() =>
      createSpawnTool([{ ...RESEARCHER, model: "m" }], { provider, models: {} as never }),
    ).toThrow(/models\.main/);
  });
});

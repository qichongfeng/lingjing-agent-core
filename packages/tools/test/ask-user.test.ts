// ask_user — handler contract, input sanitization, and the no-throw
// guarantee on every exit path (resolve / reject / abort / bad input).

import { describe, expect, it } from "vitest";
import { createAskUserTool, type AskUserQuestion } from "../src/index.js";
import { testCtx } from "./helpers.js";

describe("createAskUserTool", () => {
  it("returns the handler's answer verbatim (trimmed) as a success result", async () => {
    const tool = createAskUserTool({ handler: async () => "  钱喵小程序  " });
    const r = await tool.execute({ question: "哪个站点?" }, testCtx());
    expect(r).toEqual({ content: "钱喵小程序" });
  });

  it("passes the sanitized payload to the handler (question, clamped options, ctx identity, same signal)", async () => {
    let seen: AskUserQuestion | undefined;
    let seenSignal: AbortSignal | undefined;
    const ac = new AbortController();
    const tool = createAskUserTool({
      handler: async (q, signal) => {
        seen = q;
        seenSignal = signal;
        return "ok";
      },
    });
    const ctx = testCtx(ac.signal);
    await tool.execute({ question: "q", options: [{ label: "A" }, { label: "B", description: "b" }] }, ctx);
    expect(seen?.question).toBe("q");
    expect(seen?.options).toEqual([{ label: "A" }, { label: "B", description: "b" }]);
    expect(seen?.allowMultiple).toBeUndefined();
    expect(seen?.toolCallId).toBe("tc-test");
    expect(seen?.conversationId).toBe("c-test");
    expect(seenSignal).toBe(ac.signal);
  });

  it("refuses a missing/empty question", async () => {
    const tool = createAskUserTool({ handler: async () => "x" });
    for (const bad of [undefined, "", "   ", 42]) {
      const r = await tool.execute({ question: bad }, testCtx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Refused: input.question");
    }
  });

  it("drops malformed option entries and keeps at most 4", async () => {
    let seen: AskUserQuestion | undefined;
    const tool = createAskUserTool({ handler: async (q) => (seen = q, "ok") });
    await tool.execute(
      {
        question: "q",
        options: [
          { label: "A" },
          "junk",
          null,
          { label: "" },
          { description: "no label" },
          { label: "B" },
          { label: "C" },
          { label: "D" },
          { label: "E" },
        ],
      },
      testCtx(),
    );
    expect(seen?.options?.map((o) => o.label)).toEqual(["A", "B", "C", "D"]);
  });

  it("reports an empty answer as a non-error outcome", async () => {
    const tool = createAskUserTool({ handler: async () => "   " });
    const r = await tool.execute({ question: "q" }, testCtx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toBe("(the user submitted an empty answer)");
  });

  it("caps a very long answer and marks the truncation", async () => {
    const tool = createAskUserTool({ handler: async () => "x".repeat(5_000) });
    const r = await tool.execute({ question: "q" }, testCtx());
    expect(typeof r.content).toBe("string");
    expect((r.content as string).length).toBe(4_000 + " [truncated]".length);
    expect(r.content).toContain("[truncated]");
  });

  it("maps a non-abort handler rejection to an Ask failed: error result (never throws)", async () => {
    const tool = createAskUserTool({
      handler: async () => {
        throw new Error("UI crashed");
      },
    });
    const r = await tool.execute({ question: "q" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toBe("Ask failed: UI crashed");
  });

  it("returns (aborted) without calling the handler when the signal is already aborted", async () => {
    let called = false;
    const tool = createAskUserTool({
      handler: async () => {
        called = true;
        return "x";
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({ question: "q" }, testCtx(ac.signal));
    expect(called).toBe(false);
    expect(r).toEqual({ content: "(aborted)", isError: true });
  });

  it("returns (aborted) when the run aborts while waiting for the user", async () => {
    const ac = new AbortController();
    const tool = createAskUserTool({
      handler: (_q, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by signal")), { once: true });
        }),
    });
    const pending = tool.execute({ question: "q" }, testCtx(ac.signal));
    setTimeout(() => ac.abort(), 50);
    const r = await pending;
    expect(r).toEqual({ content: "(aborted)", isError: true });
  });

  it("defaults to a 10-minute timeout, overridable per host", () => {
    expect(createAskUserTool({ handler: async () => "x" }).timeoutMs).toBe(600_000);
    expect(createAskUserTool({ handler: async () => "x", timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
  });
});

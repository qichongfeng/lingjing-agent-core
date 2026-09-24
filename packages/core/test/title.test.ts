// createTitleGenerator: one-shot fast-tier title call + normalization.

import { describe, expect, test } from "vitest";
import { createTitleGenerator, type LLMProvider, type ProviderChunk, type ProviderRequest } from "../src/index.js";

/** Streams `out` text once; optionally records the request / rejects. */
function provider(
  out: string,
  opts: { throws?: boolean; onReq?: (req: ProviderRequest) => void } = {},
): LLMProvider {
  return {
    id: "title-fake",
    capabilities: { stopReasons: ["end_turn"], streaming: true },
    stream(req) {
      opts.onReq?.(req);
      return (async function* (): AsyncIterable<ProviderChunk> {
        if (opts.throws) throw new Error("boom");
        yield { type: "message_start", messageId: "t", model: req.model };
        yield { type: "text_delta", text: out };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      })();
    },
  };
}

describe("createTitleGenerator", () => {
  test("returns the normalized title; request carries the given model + system + excerpt", async () => {
    const seen: ProviderRequest[] = [];
    const gen = createTitleGenerator({ provider: provider("天气查询", { onReq: (r) => seen.push(r) }), model: "fast-m" });
    const title = await gen({ userText: "北京今天天气怎么样?", replyText: "北京今天晴,22 度。" });
    expect(title).toBe("天气查询");
    const req = seen[0]!;
    expect(req.model).toBe("fast-m");
    expect(req.tools).toBeUndefined();
    expect(req.config.maxTokens).toBe(128);
    // No reasoning on a title call — disabled by default (thinking-default
    // fast-tier models otherwise burn the budget before any text).
    expect(req.config.thinking).toEqual({ type: "disabled" });
    expect(req.system).toContain("short title");
    expect(req.messages[0]?.content).toContain("北京今天天气怎么样?");
    expect(req.messages[0]?.content).toContain("22 度");
  });

  test("forwards providerOptions (vendor thinking switch) into the request", async () => {
    const seen: ProviderRequest[] = [];
    const gen = createTitleGenerator({
      provider: provider("t", { onReq: (r) => seen.push(r) }),
      model: "f",
      providerOptions: { body: { enable_thinking: false } },
    });
    await gen({ userText: "q" });
    expect(seen[0]!.config.providerOptions).toEqual({ body: { enable_thinking: false } });
  });

  test("onError surfaces the otherwise-silent failures (still resolves null)", async () => {
    const errs: unknown[] = [];
    // empty output → synthetic error
    const empty = createTitleGenerator({ provider: provider("  "), model: "f", onError: (e) => errs.push(e) });
    expect(await empty({ userText: "q" })).toBeNull();
    expect(errs.length).toBe(1);
    // provider throw → the original error
    const boom = createTitleGenerator({ provider: provider("x", { throws: true }), model: "f", onError: (e) => errs.push(e) });
    expect(await boom({ userText: "q" })).toBeNull();
    expect(errs.length).toBe(2);
    expect(errs[1]).toBeInstanceOf(Error);
  });

  test("takes the first line, strips wrapping quotes (ASCII + CJK), caps length", async () => {
    const gen = createTitleGenerator({ provider: provider("「这是标题」\n多余的下一行"), model: "f" });
    expect(await gen({ userText: "q" })).toBe("这是标题");
    const quoted = createTitleGenerator({ provider: provider('"Quoted Title"'), model: "f" });
    expect(await quoted({ userText: "q" })).toBe("Quoted Title");
    const long = createTitleGenerator({ provider: provider("一".repeat(30)), model: "f" });
    expect((await long({ userText: "q" }))!.length).toBe(24);
    const custom = createTitleGenerator({ provider: provider("一二三四五六"), model: "f", maxChars: 4 });
    expect(await custom({ userText: "q" })).toBe("一二三四");
  });

  test("empty output → null; provider error → null (never throws)", async () => {
    const empty = createTitleGenerator({ provider: provider("   "), model: "f" });
    expect(await empty({ userText: "q" })).toBeNull();
    const boom = createTitleGenerator({ provider: provider("x", { throws: true }), model: "f" });
    await expect(boom({ userText: "q" })).resolves.toBeNull();
  });

  test("long inputs are excerpted to bound the call", async () => {
    const seen: ProviderRequest[] = [];
    const gen = createTitleGenerator({ provider: provider("t", { onReq: (r) => seen.push(r) }), model: "f" });
    await gen({ userText: "x".repeat(5000), replyText: "y".repeat(5000) });
    const content = seen[0]!.messages[0]!.content as string;
    expect(content.length).toBeLessThan(1100); // 2×500 excerpts + labels
  });

  test("works without replyText", async () => {
    const seen: ProviderRequest[] = [];
    const gen = createTitleGenerator({ provider: provider("仅问题", { onReq: (r) => seen.push(r) }), model: "f" });
    expect(await gen({ userText: "翻译这段话" })).toBe("仅问题");
    expect((seen[0]!.messages[0]!.content as string)).not.toContain("Assistant");
  });
});

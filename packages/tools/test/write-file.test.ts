// write_file tool tests — node env, fake write handler (family style: call
// tool.execute directly, assert isError/content).

import { describe, expect, test } from "vitest";
import { createWriteFileTool, type Filesystem } from "../src/index.js";
import { testCtx } from "./helpers.js";

const fakeFs = (): Filesystem => ({
  async writeFile() {},
  async readFile() {
    throw new Error("x");
  },
});

describe("createWriteFileTool", () => {
  test("writes through the injected handler and reports the size", async () => {
    const seen: { path: string; content: string }[] = [];
    const tool = createWriteFileTool({
      fs: {
        async readFile() {
          throw new Error("unexpected read");
        },
        async writeFile(path, content) {
          seen.push({ path, content });
        },
      },
    });
    const r = await tool.execute({ path: "snake.html", content: "<html></html>" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("saved snake.html");
    expect(r.content).toContain("KiB");
    expect(seen).toEqual([{ path: "snake.html", content: "<html></html>" }]);
  });

  test("refuses a missing/empty/over-long path", async () => {
    const tool = createWriteFileTool({ fs: fakeFs() });
    for (const path of [undefined, "", " ", "x".repeat(201)]) {
      const r = await tool.execute({ path, content: "c" }, testCtx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Refused: input.path");
    }
  });

  test("refuses empty and over-long content (default and custom caps)", async () => {
    const tool = createWriteFileTool({ fs: fakeFs() });
    expect((await tool.execute({ path: "a.html" }, testCtx())).content).toContain("Refused: input.content");
    expect((await tool.execute({ path: "a.html", content: "" }, testCtx())).content).toContain("Refused: input.content");
    expect(
      (await tool.execute({ path: "a.html", content: "x".repeat(1_200_001) }, testCtx())).content,
    ).toContain("Refused: input.content");

    const tight = createWriteFileTool({ fs: fakeFs(), maxContentChars: 10 });
    expect((await tight.execute({ path: "a.html", content: "x".repeat(11) }, testCtx())).content).toContain(
      "Refused: input.content",
    );
  });

  test("handler failure → Save failed prefix, never throws", async () => {
    const tool = createWriteFileTool({
      fs: { readFile: async () => "", writeFile: () => Promise.reject(new Error("quota")) },
    });
    const r = await tool.execute({ path: "a.html", content: "x" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Save failed: quota");
  });

  test("aborts before the handler runs; a throwing handler after abort reads as (aborted)", async () => {
    const tool = createWriteFileTool({ fs: fakeFs() });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({ path: "a.html", content: "x" }, testCtx(ac.signal));
    expect(r.content).toBe("(aborted)");
    expect(r.isError).toBe(true);
  });

  test("tool metadata: name, tags, no network", () => {
    const tool = createWriteFileTool({ fs: fakeFs() });
    expect(tool.name).toBe("write_file");
    expect(tool.permissions?.tags).toEqual(["artifact:write"]);
    expect(tool.permissions?.network).toBeUndefined();
    expect(tool.permissions?.destructive).toBeUndefined();
  });
});

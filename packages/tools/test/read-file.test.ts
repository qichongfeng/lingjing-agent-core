// read_file tool tests — node env, fake read handler (mirrors write-file tests).

import { describe, expect, test } from "vitest";
import { createReadFileTool, type Filesystem } from "../src/index.js";
import { testCtx } from "./helpers.js";

const rdFs = (readFile: (p: string) => Promise<string>): Filesystem => ({
  readFile: (p) => readFile(p),
  async writeFile() {},
});

describe("createReadFileTool", () => {
  test("reads through the injected handler with a path/size header", async () => {
    const tool = createReadFileTool({ fs: rdFs(async () => "<html></html>") });
    const r = await tool.execute({ path: "snake.html" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("path: snake.html");
    expect(r.content).toContain("13 chars");
    expect(r.content).toContain("<html></html>");
  });

  test("refuses a missing/empty/over-long path", async () => {
    const tool = createReadFileTool({ fs: rdFs(async () => "x") });
    for (const path of [undefined, "", " ", "p".repeat(201)]) {
      const r = await tool.execute({ path }, testCtx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Refused: input.path");
    }
  });

  test("handler miss/failure → Read failed prefix, never throws", async () => {
    const tool = createReadFileTool({
      fs: rdFs(() => Promise.reject(new Error("'a.html' not found"))),
    });
    const r = await tool.execute({ path: "a.html" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Read failed: 'a.html' not found");
  });

  test("truncates over-long content with a marker (default and custom caps)", async () => {
    const tool = createReadFileTool({ fs: rdFs(async () => "x".repeat(100_001)) });
    const r = await tool.execute({ path: "a.html" }, testCtx());
    expect(r.content).toContain("…[truncated]");
    expect(r.content).toContain("showing first 100000");

    const tight = createReadFileTool({ fs: rdFs(async () => "x".repeat(11)), maxChars: 10 });
    const r2 = await tight.execute({ path: "a.html" }, testCtx());
    expect(r2.content).toContain("…[truncated]");
  });

  test("pre-aborted signal short-circuits to (aborted)", async () => {
    const tool = createReadFileTool({ fs: rdFs(async () => "x") });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({ path: "a.html" }, testCtx(ac.signal));
    expect(r.content).toBe("(aborted)");
    expect(r.isError).toBe(true);
  });

  test("tool metadata: name, tags, no network", () => {
    const tool = createReadFileTool({ fs: rdFs(async () => "x") });
    expect(tool.name).toBe("read_file");
    expect(tool.permissions?.tags).toEqual(["artifact:read"]);
    expect(tool.permissions?.network).toBeUndefined();
  });
});

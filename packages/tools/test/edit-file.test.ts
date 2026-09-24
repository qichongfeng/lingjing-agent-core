// edit_file tool tests — node env, fake fs (family style: call tool.execute
// directly, assert isError/content).

import { describe, expect, test } from "vitest";
import { createEditFileTool, type Filesystem } from "../src/index.js";
import { testCtx } from "./helpers.js";

function fakeFs(files: Record<string, string>): {
  fs: Filesystem;
  written: Record<string, string>;
} {
  const written: Record<string, string> = {};
  const store = { ...files };
  return {
    written,
    fs: {
      readFile: (p: string) => {
        if (!(p in store)) return Promise.reject(new Error(`'${p}' not found in the workspace`));
        return Promise.resolve(store[p]!);
      },
      writeFile: (p: string, c: string) => {
        store[p] = c;
        written[p] = c;
        return Promise.resolve();
      },
    },
  };
}

describe("createEditFileTool", () => {
  test("replaces a unique span and writes the merged result back", async () => {
    const { fs, written } = fakeFs({ "g.html": "<body>score: 0</body>" });
    const tool = createEditFileTool({ fs });
    const r = await tool.execute(
      { path: "g.html", oldText: "score: 0", newText: "score: 10" },
      testCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("edited g.html (1 replacement");
    expect(written["g.html"]).toBe("<body>score: 10</body>");
  });

  test("newText is inserted LITERALLY — $-patterns ($&, $`, $', $$) never expand", async () => {
    // String.prototype.replace with a string arg interprets replacement
    // patterns; the tool must not corrupt a file whose new text contains $.
    const { fs, written } = fakeFs({ "a.txt": "cost: 10; name: A; id: 7; lit: 5" });
    const tool = createEditFileTool({ fs });
    const r = await tool.execute(
      { path: "a.txt", oldText: "10", newText: "$&0 USD" },
      testCtx(),
    );
    expect(r.isError).toBeFalsy();
    expect(written["a.txt"]).toBe("cost: $&0 USD; name: A; id: 7; lit: 5");
    // $$ collapses to $ — must stay two literal dollars.
    const r2 = await tool.execute(
      { path: "a.txt", oldText: "A", newText: "$$B" },
      testCtx(),
    );
    expect(r2.isError).toBeFalsy();
    expect(written["a.txt"]).toBe("cost: $&0 USD; name: $$B; id: 7; lit: 5");
  });

  test("empty newText deletes the span; multi-byte content round-trips", async () => {
    const { fs, written } = fakeFs({ "a.txt": "keep\n删除我\nkeep" });
    const tool = createEditFileTool({ fs });
    await tool.execute({ path: "a.txt", oldText: "\n删除我\n", newText: "" }, testCtx());
    expect(written["a.txt"]).toBe("keepkeep");
  });

  test("refuses on zero or ambiguous matches; replaceAll resolves ambiguity", async () => {
    const { fs, written } = fakeFs({ "a.txt": "x – x – x" });
    const tool = createEditFileTool({ fs });
    const miss = await tool.execute({ path: "a.txt", oldText: "nope", newText: "y" }, testCtx());
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain("oldText not found");

    const amb = await tool.execute({ path: "a.txt", oldText: "x", newText: "y" }, testCtx());
    expect(amb.isError).toBe(true);
    expect(amb.content).toContain("matches 3 places");

    const all = await tool.execute(
      { path: "a.txt", oldText: "x", newText: "y", replaceAll: true },
      testCtx(),
    );
    expect(all.isError).toBeFalsy();
    expect(all.content).toContain("3 replacements");
    expect(written["a.txt"]).toBe("y – y – y");
  });

  test("refuses bad input: paths, empty/over-long oldText, equal texts, non-boolean replaceAll", async () => {
    const { fs } = fakeFs({ "a.txt": "x" });
    const tool = createEditFileTool({ fs });
    expect((await tool.execute({ path: "", oldText: "x", newText: "y" }, testCtx())).content).toContain("Refused: input.path");
    expect((await tool.execute({ path: "a.txt", oldText: "", newText: "y" }, testCtx())).content).toContain("Refused: input.oldText");
    expect((await tool.execute({ path: "a.txt", oldText: "x".repeat(200_001), newText: "y" }, testCtx())).content).toContain("Refused: input.oldText");
    expect((await tool.execute({ path: "a.txt", oldText: "x", newText: "x" }, testCtx())).content).toContain("newText equals oldText");
    expect(
      (await tool.execute({ path: "a.txt", oldText: "x", newText: "y", replaceAll: "yes" }, testCtx())).content,
    ).toContain("Refused: input.replaceAll");
  });

  test("handler failures → Edit failed prefix, never throws", async () => {
    const tool = createEditFileTool({
      fs: {
        readFile: () => Promise.reject(new Error("'a.txt' not found in the workspace")),
        writeFile: () => Promise.reject(new Error("quota")),
      },
    });
    const r = await tool.execute({ path: "a.txt", oldText: "x", newText: "y" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Edit failed: read('a.txt')");
  });

  test("aborts before the handler runs; a throwing handler after abort reads as (aborted)", async () => {
    const { fs } = fakeFs({ "a.txt": "x" });
    const tool = createEditFileTool({ fs });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({ path: "a.txt", oldText: "x", newText: "y" }, testCtx(ac.signal));
    expect(r.content).toBe("(aborted)");
    expect(r.isError).toBe(true);
  });

  test("tool metadata: name, tags, no network", () => {
    const { fs } = fakeFs({});
    const tool = createEditFileTool({ fs });
    expect(tool.name).toBe("edit_file");
    expect(tool.permissions?.tags).toEqual(["artifact:edit"]);
    expect(tool.permissions?.network).toBeUndefined();
  });
});

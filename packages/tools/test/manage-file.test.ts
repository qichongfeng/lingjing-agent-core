// manage_file tool tests — node env, fake fs (family style: call
// tool.execute directly, assert isError/content).

import { describe, expect, test } from "vitest";
import { createManageFileTool, type Filesystem } from "../src/index.js";
import { testCtx } from "./helpers.js";

const fakeFs = (over: Partial<Filesystem> = {}): Filesystem => ({
  async readFile() {
    return "";
  },
  async writeFile() {},
  ...over,
});

describe("createManageFileTool", () => {
  test("delete goes through fs.remove with the recursive flag", async () => {
    const seen: { path: string; recursive: boolean }[] = [];
    const tool = createManageFileTool({
      fs: fakeFs({
        async remove(path, _signal, opts) {
          seen.push({ path, recursive: opts?.recursive === true });
        },
      }),
    });
    expect((await tool.execute({ op: "delete", path: "a.html" }, testCtx())).content).toBe("deleted a.html");
    expect(
      (await tool.execute({ op: "delete", path: "old/", recursive: true }, testCtx())).content,
    ).toBe("deleted old/");
    expect(seen).toEqual([
      { path: "a.html", recursive: false },
      { path: "old/", recursive: true },
    ]);
  });

  test("move goes through fs.move and reports src → dst", async () => {
    const seen: { from: string; to: string }[] = [];
    const tool = createManageFileTool({
      fs: fakeFs({
        async move(from, to) {
          seen.push({ from, to });
        },
      }),
    });
    const r = await tool.execute({ op: "move", path: "snake-v2.html", to: "old/snake.html" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toBe("moved snake-v2.html → old/snake.html");
    expect(seen).toEqual([{ from: "snake-v2.html", to: "old/snake.html" }]);
  });

  test("refuses bad op / paths / to, and non-boolean recursive", async () => {
    const tool = createManageFileTool({
      fs: fakeFs({ remove: async () => {}, move: async () => {} }),
    });
    expect((await tool.execute({ op: "copy", path: "a" }, testCtx())).content).toContain("Refused: input.op");
    expect((await tool.execute({ op: "delete" }, testCtx())).content).toContain("Refused: input.path");
    expect((await tool.execute({ op: "delete", path: "x".repeat(201) }, testCtx())).content).toContain("Refused: input.path");
    expect((await tool.execute({ op: "move", path: "a" }, testCtx())).content).toContain("Refused: move needs input.to");
    expect(
      (await tool.execute({ op: "delete", path: "a", recursive: "yes" }, testCtx())).content,
    ).toContain("Refused: input.recursive");
  });

  test("refuses when the backend lacks remove/move; failures prefix and never throw", async () => {
    const bare = createManageFileTool({ fs: fakeFs() });
    expect((await bare.execute({ op: "delete", path: "a" }, testCtx())).content).toContain("Refused: this workspace backend cannot delete");
    expect((await bare.execute({ op: "move", path: "a", to: "b" }, testCtx())).content).toContain("Refused: this workspace backend cannot move");

    const failing = createManageFileTool({
      fs: fakeFs({
        remove: () => Promise.reject(new Error("non-empty directory")),
        move: () => Promise.reject(new Error("cannot move into itself")),
      }),
    });
    expect((await failing.execute({ op: "delete", path: "d" }, testCtx())).content).toContain("Delete failed: non-empty directory");
    expect((await failing.execute({ op: "move", path: "d", to: "d/x" }, testCtx())).content).toContain("Move failed: cannot move into itself");
  });

  test("aborts before the handler runs; a throwing handler after abort reads as (aborted)", async () => {
    const tool = createManageFileTool({
      fs: fakeFs({ remove: () => Promise.reject(new Error("late")), move: () => Promise.reject(new Error("late")) }),
    });
    const ac = new AbortController();
    ac.abort();
    expect((await tool.execute({ op: "delete", path: "a" }, testCtx(ac.signal))).content).toBe("(aborted)");
    expect((await tool.execute({ op: "move", path: "a", to: "b" }, testCtx(ac.signal))).content).toBe("(aborted)");
  });

  test("tool metadata: name, tags, no network", () => {
    const tool = createManageFileTool({ fs: fakeFs({ remove: async () => {}, move: async () => {} }) });
    expect(tool.name).toBe("manage_file");
    expect(tool.permissions?.tags).toEqual(["artifact:manage"]);
    expect(tool.permissions?.network).toBeUndefined();
  });
});

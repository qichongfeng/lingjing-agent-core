import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGlobTool, createGrepTool } from "../src/index.js";
import { testCtx } from "./helpers.js";

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "tools-node-search-"));
  await fsp.mkdir(path.join(root, "sub", "deep"), { recursive: true });
  await fsp.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fsp.writeFile(path.join(root, "a.ts"), "const x = 1; // TODO fix me\n");
  await fsp.writeFile(path.join(root, "b.md"), "# doc\nnothing here\n");
  await fsp.writeFile(path.join(root, "sub", "s.ts"), "TODO: second\n");
  await fsp.writeFile(path.join(root, "sub", "deep", "d.md"), "deep note\n");
  await fsp.writeFile(path.join(root, "node_modules", "pkg", "i.ts"), "TODO ignored\n");
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe("createGlobTool", () => {
  it("matches ** across segments", async () => {
    const glob = createGlobTool({ root });
    const r = await glob.execute({ pattern: "**/*.md" }, testCtx());
    const lines = (r.content as string).split("\n");
    expect(lines).toContain("b.md");
    expect(lines).toContain("sub/deep/d.md");
    expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
  });

  it("matches within a subdirectory via path", async () => {
    const glob = createGlobTool({ root });
    const r = await glob.execute({ pattern: "*.ts", path: "sub" }, testCtx());
    expect(r.content).toBe("sub/s.ts");
  });

  it("supports ? and char classes", async () => {
    const glob = createGlobTool({ root });
    expect((await glob.execute({ pattern: "?.ts" }, testCtx())).content).toBe("a.ts");
    expect((await glob.execute({ pattern: "[ab].*" }, testCtx())).isError).toBeFalsy();
  });

  it("truncates at maxResults with a note", async () => {
    const glob = createGlobTool({ root, maxResults: 1 });
    const r = await glob.execute({ pattern: "**/*" }, testCtx());
    expect(r.content).toContain("result cap 1 reached");
  });

  it("refuses paths outside the root", async () => {
    const glob = createGlobTool({ root });
    const r = await glob.execute({ pattern: "*", path: ".." }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
  });
});

describe("createGrepTool", () => {
  it("finds matches as path:line:text, skipping ignored dirs", async () => {
    const grep = createGrepTool({ root });
    const r = await grep.execute({ pattern: "TODO" }, testCtx());
    const lines = (r.content as string).split("\n");
    expect(lines).toContain("a.ts:1:const x = 1; // TODO fix me");
    expect(lines).toContain("sub/s.ts:1:TODO: second");
    expect(lines.some((l) => l.includes("node_modules"))).toBe(false);
  });

  it("honours glob file filters", async () => {
    const grep = createGrepTool({ root });
    const r = await grep.execute({ pattern: ".", glob: "*.md" }, testCtx());
    expect(r.content).toContain("b.md:1");
    expect(r.content).not.toContain("a.ts:");
  });

  it("rejects invalid regex", async () => {
    const grep = createGrepTool({ root });
    const r = await grep.execute({ pattern: "([unclosed" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Invalid regex");
  });

  it("skips binary files (NUL bytes)", async () => {
    await fsp.writeFile(path.join(root, "bin.dat"), Buffer.from([0x61, 0x00, 0x62]));
    const grep = createGrepTool({ root });
    const r = await grep.execute({ pattern: "a" }, testCtx());
    expect(r.content).not.toContain("bin.dat");
  });

  it("skips oversized files", async () => {
    await fsp.writeFile(path.join(root, "huge.txt"), "needle " + "x".repeat(2048));
    const grep = createGrepTool({ root, maxFileSizeBytes: 1024 });
    const r = await grep.execute({ pattern: "needle" }, testCtx());
    expect(r.content).toContain("No matches");
  });

  it("returns (aborted) for a pre-aborted signal", async () => {
    const grep = createGrepTool({ root });
    const ac = new AbortController();
    ac.abort();
    const r = await grep.execute({ pattern: "TODO" }, testCtx(ac.signal));
    expect(r.content).toBe("(aborted)");
  });

  it("caps results with a note", async () => {
    const grep = createGrepTool({ root, maxResults: 1 });
    const r = await grep.execute({ pattern: "TODO" }, testCtx());
    expect(r.content).toContain("result cap 1 reached");
  });

  it("ships fs:read tags, non-destructive", () => {
    const grep = createGrepTool({ root });
    expect(grep.permissions?.tags).toEqual(["fs", "fs:read"]);
    expect(grep.permissions?.destructive).toBeFalsy();
  });
});

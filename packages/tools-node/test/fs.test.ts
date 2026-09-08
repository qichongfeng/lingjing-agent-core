import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "@lingjing-agent/core";
import { createFsTools } from "../src/index.js";
import { testCtx } from "./helpers.js";

let root: string;
let outside: string;

beforeEach(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "tools-node-fs-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "secret.txt"), "SECRET");
});

afterEach(async () => {
  await fsp.rm(path.dirname(root), { recursive: true, force: true });
});

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("createFsTools", () => {
  it("writes then reads back (parent dirs auto-created)", async () => {
    const tools = createFsTools({ root });
    const w = await byName(tools, "write_file").execute(
      { path: "src/deep/a.txt", content: "hello 灵境" },
      testCtx(),
    );
    expect(w.isError).toBeFalsy();
    const r = await byName(tools, "read_file").execute({ path: "src/deep/a.txt" }, testCtx());
    expect(r.content).toBe("hello 灵境");
  });

  it("read_file truncates at maxReadBytes", async () => {
    await fsp.writeFile(path.join(root, "big.txt"), "x".repeat(1000));
    const tools = createFsTools({ root, maxReadBytes: 100 });
    const r = await byName(tools, "read_file").execute({ path: "big.txt" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("truncated at 100 bytes");
    expect((r.content as string).length).toBeLessThan(200);
  });

  it("write_file refuses content over maxWriteBytes", async () => {
    const tools = createFsTools({ root, maxWriteBytes: 10 });
    const r = await byName(tools, "write_file").execute({ path: "a.txt", content: "x".repeat(11) }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("maxWriteBytes");
  });

  it("list_dir marks dirs and files, dirs first", async () => {
    await fsp.writeFile(path.join(root, "z.txt"), "1");
    await fsp.mkdir(path.join(root, "adir"));
    const tools = createFsTools({ root });
    const r = await byName(tools, "list_dir").execute({}, testCtx());
    const lines = (r.content as string).split("\n");
    expect(lines[0]).toBe("dir   adir/");
    expect(lines[1]).toBe("file  z.txt");
  });

  it("deletes a file; directories need recursive", async () => {
    await fsp.writeFile(path.join(root, "a.txt"), "1");
    await fsp.mkdir(path.join(root, "d"));
    await fsp.writeFile(path.join(root, "d", "b.txt"), "1");
    const tools = createFsTools({ root });
    const delDir = await byName(tools, "delete_path").execute({ path: "d" }, testCtx());
    expect(delDir.isError).toBe(true); // without recursive
    const delFile = await byName(tools, "delete_path").execute({ path: "a.txt" }, testCtx());
    expect(delFile.isError).toBeFalsy();
    const delRecursive = await byName(tools, "delete_path").execute({ path: "d", recursive: true }, testCtx());
    expect(delRecursive.isError).toBeFalsy();
    expect(await fsp.readdir(root)).toEqual([]);
  });

  it("refuses .. traversal outside the root", async () => {
    const tools = createFsTools({ root });
    const r = await byName(tools, "read_file").execute({ path: "../outside/secret.txt" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
  });

  it("refuses absolute paths outside the root", async () => {
    const tools = createFsTools({ root });
    const r = await byName(tools, "read_file").execute(
      { path: path.join(outside, "secret.txt") },
      testCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
  });

  it("refuses reads through a symlink that escapes the root", async () => {
    await fsp.symlink(outside, path.join(root, "leak"));
    const tools = createFsTools({ root });
    const r = await byName(tools, "read_file").execute({ path: "leak/secret.txt" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
  });

  it("refuses writes where a symlinked PARENT escapes the root (target not yet existing)", async () => {
    await fsp.symlink(outside, path.join(root, "leakdir"));
    const tools = createFsTools({ root });
    const r = await byName(tools, "write_file").execute(
      { path: "leakdir/new.txt", content: "pwn" },
      testCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("escapes the workspace root");
    expect(await fsp.readdir(outside)).toEqual(["secret.txt"]); // nothing smuggled out
  });

  it("refuses deleting the root itself", async () => {
    const tools = createFsTools({ root });
    const r = await byName(tools, "delete_path").execute({ path: ".", recursive: true }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("workspace root");
  });

  it("ships destructive permissions on write/delete only", () => {
    const tools = createFsTools({ root });
    expect(byName(tools, "write_file").permissions?.destructive).toBe(true);
    expect(byName(tools, "delete_path").permissions?.destructive).toBe(true);
    expect(byName(tools, "read_file").permissions?.destructive).toBeFalsy();
    expect(byName(tools, "list_dir").permissions?.tags).toEqual(["fs", "fs:read"]);
  });
});

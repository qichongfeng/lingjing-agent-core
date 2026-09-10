// Path-confined fs tools for Node hosts: read_file / write_file / list_dir / delete_path.
//
// SECURITY (DESIGN.md §7.6): every model-supplied path is resolved to its
// canonical (realpath) form and must stay inside the configured root. `..`
// traversal, absolute paths outside root, and symlinks pointing outside root
// are all refused with an isError tool_result (never a throw — the loop turns
// those into tool errors the model can see and recover from).
//
// Write/delete ship with `permissions.destructive: true` so hosts get the
// deny-by-default permission gate unless they explicitly opt out.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { Tool, ToolResultValue } from "@lingjing-agent/core";
import { confine, lazyRealroot, refused } from "./util.js";

export interface FsToolsOptions {
  /** Confinement root. Model paths are resolved against (and must stay inside) this directory. */
  root: string;
  /** Cap for read_file output. Default 64 KiB. */
  maxReadBytes?: number;
  /** Cap for write_file input size. Default 256 KiB. */
  maxWriteBytes?: number;
}

export function createFsTools(opts: FsToolsOptions): Tool[] {
  // realpath the root ONCE at first use — the confine check compares canonical
  // forms, so a symlinked root itself is fine.
  const getRoot = lazyRealroot(opts.root);
  const maxReadBytes = opts.maxReadBytes ?? 64 * 1024;
  const maxWriteBytes = opts.maxWriteBytes ?? 256 * 1024;

  const readFile: Tool = {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace root and return its content " +
      "(truncated to a size cap). Use for source code, configs, notes — not binaries.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root (or absolute inside it)." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["fs", "fs:read"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { path: p } = raw as { path?: string };
      if (typeof p !== "string" || p.length === 0) return refused("input.path must be a non-empty string");
      const root = await getRoot();
      const abs = await confine(root, p);
      if (abs === null) return refused(`path escapes the workspace root: ${p}`);
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) return { content: `No such file: ${p}`, isError: true };
      if (stat.isDirectory()) return refused(`${p} is a directory — use list_dir`);
      const buf = await fsp.readFile(abs);
      const truncated = buf.byteLength > maxReadBytes;
      const text = (truncated ? buf.subarray(0, maxReadBytes) : buf).toString("utf8");
      return { content: truncated ? `${text}\n\n[truncated at ${maxReadBytes} bytes]` : text };
    },
  };

  const writeFile: Tool = {
    name: "write_file",
    description:
      "Create or overwrite a text file inside the workspace root. Parent directories " +
      "are created automatically. Existing content is REPLACED — read the file first if merging.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root (or absolute inside it)." },
          content: { type: "string", description: "Full UTF-8 content to write." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    permissions: { destructive: true, tags: ["fs", "fs:write"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { path: p, content } = raw as { path?: string; content?: string };
      if (typeof p !== "string" || p.length === 0) return refused("input.path must be a non-empty string");
      if (typeof content !== "string") return refused("input.content must be a string");
      if (content.length > maxWriteBytes) return refused(`content exceeds maxWriteBytes (${maxWriteBytes})`);
      const root = await getRoot();
      const abs = await confine(root, p);
      if (abs === null) return refused(`path escapes the workspace root: ${p}`);
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content, "utf8");
      return { content: `Wrote ${content.length} chars to ${p}` };
    },
  };

  const listDir: Tool = {
    name: "list_dir",
    description: "List entries of a directory inside the workspace root (type + name).",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to the workspace root. Default '.'." },
        },
        additionalProperties: false,
      },
    },
    permissions: { tags: ["fs", "fs:read"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { path: p = "." } = raw as { path?: string };
      const root = await getRoot();
      const abs = await confine(root, p || ".");
      if (abs === null) return refused(`path escapes the workspace root: ${p}`);
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      let entries;
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { content: `No such directory: ${p}`, isError: true };
        if (code === "ENOTDIR") return refused(`${p} is a file — use read_file`);
        throw err;
      }
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map((e) => {
          if (e.isSymbolicLink()) return `link  ${e.name}`;
          if (e.isDirectory()) return `dir   ${e.name}/`;
          return `file  ${e.name}`;
        });
      return { content: lines.length > 0 ? lines.join("\n") : "(empty directory)" };
    },
  };

  const deletePath: Tool = {
    name: "delete_path",
    description:
      "Delete a file inside the workspace root. Deleting a directory requires " +
      "recursive:true and removes its entire contents — prefer file-by-file.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the workspace root (or absolute inside it)." },
          recursive: { type: "boolean", description: "Required (and sufficient) to delete a non-empty directory." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    permissions: { destructive: true, tags: ["fs", "fs:delete"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { path: p, recursive = false } = raw as { path?: string; recursive?: boolean };
      if (typeof p !== "string" || p.length === 0) return refused("input.path must be a non-empty string");
      const root = await getRoot();
      const abs = await confine(root, p);
      if (abs === null) return refused(`path escapes the workspace root: ${p}`);
      if (abs === root) return refused("refusing to delete the workspace root itself");
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat) return { content: `No such file: ${p}`, isError: true };
      if (stat.isDirectory()) {
        if (!recursive) {
          return refused(`${p} is a directory — pass recursive:true to delete it (and everything inside)`);
        }
        await fsp.rm(abs, { recursive: true });
        return { content: `Deleted directory ${p}` };
      }
      await fsp.unlink(abs);
      return { content: `Deleted file ${p}` };
    },
  };

  return [readFile, writeFile, listDir, deletePath];
}

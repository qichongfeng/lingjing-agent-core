// read_file tool — the read half of the artifact workspace (write_file.ts is
// the write half, preview.ts the render/verify half).
//
// Why a read at all, when the model just wrote the file? Two real moments:
// context compaction folds earlier write_file calls into a summary (the model
// no longer holds what it wrote — rewriting from memory is waste and drift),
// and resuming an old conversation starts with no memory of the files at all.
// Reading the workspace back is the recovery path.
//
// Same contract shape as write_file: the library owns schema/validation/caps/
// description; the host injects the read handler and decides what a path
// means (IDB artifact store, granted folder, real workspace) — typically the
// SAME handler preview's `read` uses, so the three tools share one namespace.
//
// Family discipline: never throws (Refused:/Read failed: ladder), abort
// short-circuit + re-check after awaits, bounds on everything (path + content
// caps), tags ["artifact:read"], no network, instant.

import type { Tool, ToolResultValue } from "@lingjing-agent/core";
import type { Filesystem } from "./filesystem.js";

export interface ReadFileToolOptions {
  /** Workspace storage — REQUIRED. Same `fs` as write_file / preview, so the
   *  three tools share one namespace. */
  fs: Filesystem;
  /** Returned content cap (the write side allows ~1.2 MB; returning that
   *  whole into context would blow the budget — truncate instead and let
   *  the model decide). Default 100_000 chars. */
  maxChars?: number;
}

const PATH_CAP = 200;
const DEFAULT_MAX_CHARS = 100_000;

export function createReadFileTool(opts: ReadFileToolOptions): Tool {
  const fs = opts.fs;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  return {
    name: "read_file",
    description:
      "Read a workspace file back as text — the same paths write_file saves to and preview opens. Use it to " +
      "recover a file's current content (after earlier turns were compacted, or when resuming an old " +
      "conversation) instead of rewriting from memory.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `File path as write_file/preview understand it (max ${PATH_CAP} chars).`,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["artifact:read"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const r = raw as { path?: unknown };
      if (typeof r.path !== "string" || r.path.trim() === "" || r.path.length > PATH_CAP) {
        return { content: `Refused: input.path must be a non-empty string (max ${PATH_CAP} chars)`, isError: true };
      }
      const path = r.path.trim();
      let content: string;
      try {
        content = await fs.readFile(path, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Read failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      const truncated = content.length > maxChars;
      const body = truncated ? content.slice(0, maxChars) + "…[truncated]" : content;
      const header = `path: ${path}\n${content.length} chars${truncated ? ` (showing first ${maxChars}, raise maxChars if you truly need it all)` : ""}`;
      return { content: `${header}\n\n${body}` };
    },
  };
}

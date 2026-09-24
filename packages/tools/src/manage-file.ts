// manage_file tool — the tidy-up half of the artifact workflow (write_file
// creates, preview verifies, this moves and deletes).
//
// Overwrite-only storage grows stale versions forever ("v2-final.html",
// "v2-final-FIXED.html"). One tool, one op parameter: move (rename/relocate,
// parents created) and delete — with deletion of a NON-EMPTY directory gated
// behind an explicit `recursive` opt-in, so wiping a tree is always a choice
// the model made, never an accident. Both land on the same HOST-INJECTED
// Filesystem as write_file/read_file/preview (fs.move / fs.remove).
//
// Family discipline: never throws (Refused:/Move failed:/Delete failed:
// ladder), abort short-circuit, bounds on everything (path caps), tags
// ["artifact:manage"], no network, instant.

import type { Tool, ToolResultValue } from "@lingjing-agent/core";
import type { Filesystem } from "./filesystem.js";

export interface ManageFileToolOptions {
  /** Workspace storage — REQUIRED (see filesystem.ts; createOpfsFilesystem /
   *  createFsaFilesystem, or your own adapter). Needs `remove` for delete and
   *  `move` for move; missing capability is refused with a clear message. */
  fs: Filesystem;
}

const PATH_CAP = 200;

export function createManageFileTool(opts: ManageFileToolOptions): Tool {
  const fs = opts.fs;
  return {
    name: "manage_file",
    description:
      "Move or delete workspace files: move renames or relocates (parent folders are created), delete removes a " +
      "file — or a folder, but a non-empty folder only with recursive: true. Use it to keep the workspace tidy: " +
      "retire superseded versions (`snake-v2.html` after the fix), group files into folders. Deletion is permanent.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["move", "delete"],
            description: "move: rename/relocate path → to. delete: remove path.",
          },
          path: {
            type: "string",
            description: `The file (or folder) to operate on, e.g. "snake-v2.html" (max ${PATH_CAP} chars).`,
          },
          to: {
            type: "string",
            description: `move only — the destination path, e.g. "old/snake.html" (max ${PATH_CAP} chars).`,
          },
          recursive: {
            type: "boolean",
            description: "delete only — set true to delete a non-empty folder and everything inside it.",
          },
        },
        required: ["op", "path"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["artifact:manage"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const r = raw as { op?: unknown; path?: unknown; to?: unknown; recursive?: unknown };
      const badPath = (v: unknown): boolean =>
        typeof v !== "string" || v.trim() === "" || v.length > PATH_CAP;
      if (r.op !== "move" && r.op !== "delete") {
        return { content: "Refused: input.op must be 'move' or 'delete'", isError: true };
      }
      if (badPath(r.path)) {
        return { content: `Refused: input.path must be a non-empty string (max ${PATH_CAP} chars)`, isError: true };
      }
      const path = (r.path as string).trim();
      if (r.op === "delete") {
        if (fs.remove === undefined) {
          return { content: "Refused: this workspace backend cannot delete (no remove support)", isError: true };
        }
        if (r.recursive !== undefined && typeof r.recursive !== "boolean") {
          return { content: "Refused: input.recursive must be a boolean", isError: true };
        }
        try {
          await fs.remove(path, ctx.signal, { recursive: r.recursive === true });
        } catch (err) {
          if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
          return {
            content: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
        return { content: `deleted ${path}` };
      }
      if (fs.move === undefined) {
        return { content: "Refused: this workspace backend cannot move (no move support)", isError: true };
      }
      if (badPath(r.to)) {
        return { content: `Refused: move needs input.to — a non-empty destination path (max ${PATH_CAP} chars)`, isError: true };
      }
      try {
        await fs.move(path, (r.to as string).trim(), ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Move failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      return { content: `moved ${path} → ${(r.to as string).trim()}` };
    },
  };
}

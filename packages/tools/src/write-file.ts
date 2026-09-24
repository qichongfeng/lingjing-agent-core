// write_file tool — the write half of the artifact workflow (preview.ts is
// the read/verify half).
//
// An agent producing HTML artifacts needs somewhere to put them, and pure
// browser hosts have no fs. This tool hands the model a path/content write
// primitive over a HOST-INJECTED storage handler — the same contract shape
// as preview's `read`: the library owns the schema, validation, caps and
// description; the host decides what a path means (IDB, memory, a real
// workspace). Together: write_file → preview(open → act/read/shot) → fix →
// repeat, until the artifact actually works.
//
// Family discipline: never throws (Refused:/Save failed: ladder), abort
// short-circuit, bounds on everything (path + content caps), tags
// ["artifact:write"], no network, instant.

import type { Tool, ToolResultValue } from "@lingjing-agent/core";
import type { Filesystem } from "./filesystem.js";

export interface WriteFileToolOptions {
  /** Workspace storage — REQUIRED (see filesystem.ts; createOpfsFilesystem /
   *  createFsaFilesystem, or your own adapter). */
  fs: Filesystem;
  /** Per-file content cap. Default 1_200_000 (~1.2 MB — one self-contained
   *  HTML file with inline assets fits comfortably). */
  maxContentChars?: number;
}

const PATH_CAP = 200;
const DEFAULT_MAX_CONTENT = 1_200_000;

export function createWriteFileTool(opts: WriteFileToolOptions): Tool {
  const fs = opts.fs;
  const maxContent = opts.maxContentChars ?? DEFAULT_MAX_CONTENT;
  return {
    name: "write_file",
    description:
      "Save a text file to the workspace (e.g. `snake.html`). Write HTML as ONE self-contained file — inline all CSS/JS, " +
      "embed images as data: URLs, no external resources (the preview sandbox blocks network). After writing, always " +
      "verify with the preview tool before telling the user it works.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `File path, e.g. "snake.html" (max ${PATH_CAP} chars). The preview tool opens this same path.`,
          },
          content: {
            type: "string",
            description: `Full file content (max ~${Math.floor(maxContent / 1000)}k chars).`,
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["artifact:write"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const r = raw as { path?: unknown; content?: unknown };
      if (typeof r.path !== "string" || r.path.trim() === "" || r.path.length > PATH_CAP) {
        return { content: `Refused: input.path must be a non-empty string (max ${PATH_CAP} chars)`, isError: true };
      }
      if (typeof r.content !== "string" || r.content.length === 0 || r.content.length > maxContent) {
        return {
          content: `Refused: input.content must be a non-empty string (max ${maxContent} chars)`,
          isError: true,
        };
      }
      const path = r.path.trim();
      try {
        await fs.writeFile(path, r.content, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      const kib = (r.content.length / 1024).toFixed(1);
      return { content: `saved ${path} (${kib} KiB)` };
    },
  };
}

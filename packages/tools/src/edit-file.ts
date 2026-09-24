// edit_file tool — the surgical half of the artifact workflow (write_file
// rewrites whole files, this changes just the parts that changed).
//
// Rewriting a 40 KB HTML to fix one line burns ~15k output tokens and risks
// max_tokens truncation; after context compaction the model may not even hold
// the full file, so a rewrite can silently drop content. A str_replace-style
// edit costs only the changed fragments: exact `oldText` (unique, or
// replaceAll) → `newText` (empty = deletion), read-replace-write over the same
// HOST-INJECTED Filesystem as the rest of the family — the fs seam needs
// nothing new (readFile + writeFile).
//
// Family discipline: never throws (Refused:/Edit failed: ladder), abort
// short-circuit, bounds on everything (path + text caps), tags
// ["artifact:edit"], no network, instant.

import type { Tool, ToolResultValue } from "@lingjing-agent/core";
import type { Filesystem } from "./filesystem.js";

export interface EditFileToolOptions {
  /** Workspace storage — REQUIRED (see filesystem.ts; needs readFile +
   *  writeFile, which every backend ships). */
  fs: Filesystem;
  /** oldText cap — the context anchor must be sizable for big files.
   *  Default 200_000 chars. */
  maxOldChars?: number;
  /** newText cap, aligned with write_file's content cap. Default 1_200_000. */
  maxNewChars?: number;
}

const PATH_CAP = 200;
const DEFAULT_MAX_OLD = 200_000;
const DEFAULT_MAX_NEW = 1_200_000;

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

export function createEditFileTool(opts: EditFileToolOptions): Tool {
  const fs = opts.fs;
  const maxOld = opts.maxOldChars ?? DEFAULT_MAX_OLD;
  const maxNew = opts.maxNewChars ?? DEFAULT_MAX_NEW;
  return {
    name: "edit_file",
    description:
      "Make a targeted change to a file without rewriting it: oldText (copied EXACTLY from the file — read it " +
      "first if unsure) is replaced by newText. Prefer this over write_file whenever the file exists and only " +
      "parts change — it costs a fraction of the tokens and cannot lose untouched content. oldText must match " +
      "exactly once (pass replaceAll: true to replace every match); empty newText deletes the matched span.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `The file to edit, e.g. "snake.html" (max ${PATH_CAP} chars).`,
          },
          oldText: {
            type: "string",
            description: `Exact text to replace — include enough surrounding lines to make it unique (max ${maxOld} chars).`,
          },
          newText: {
            type: "string",
            description: "The replacement (empty string deletes the matched span; equal to oldText is refused).",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace every occurrence of oldText instead of requiring a unique match.",
          },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["artifact:edit"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const r = raw as {
        path?: unknown;
        oldText?: unknown;
        newText?: unknown;
        replaceAll?: unknown;
      };
      if (typeof r.path !== "string" || r.path.trim() === "" || r.path.length > PATH_CAP) {
        return { content: `Refused: input.path must be a non-empty string (max ${PATH_CAP} chars)`, isError: true };
      }
      if (typeof r.oldText !== "string" || r.oldText.length === 0 || r.oldText.length > maxOld) {
        return { content: `Refused: input.oldText must be a non-empty string (max ${maxOld} chars)`, isError: true };
      }
      if (typeof r.newText !== "string" || r.newText.length > maxNew) {
        return { content: `Refused: input.newText must be a string (max ${maxNew} chars)`, isError: true };
      }
      if (r.replaceAll !== undefined && typeof r.replaceAll !== "boolean") {
        return { content: "Refused: input.replaceAll must be a boolean", isError: true };
      }
      if (r.oldText === r.newText) {
        return { content: "Refused: newText equals oldText — nothing would change", isError: true };
      }
      const replaceAll = r.replaceAll === true;
      const path = r.path.trim();
      // Hoisted so the closure below keeps the string narrowing (property
      // narrowings do not survive inside function expressions).
      const newText: string = r.newText;
      let current: string;
      try {
        current = await fs.readFile(path, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Edit failed: read('${path}'): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      const matches = countOccurrences(current, r.oldText);
      if (matches === 0) {
        return {
          content:
            `Refused: oldText not found in '${path}' — the file may have changed since you last saw it; ` +
            `read_file it and retry with text copied exactly`,
          isError: true,
        };
      }
      if (matches > 1 && !replaceAll) {
        return {
          content:
            `Refused: oldText matches ${matches} places in '${path}' — include more surrounding lines to make it ` +
            `unique, or pass replaceAll: true`,
          isError: true,
        };
      }
      const next = replaceAll
        ? current.split(r.oldText).join(newText)
        : // Function replacer: the return value is inserted LITERALLY — a
          // string arg would interpret $-patterns in newText ($&, $`, $', $$)
          // and corrupt the file.
          current.replace(r.oldText, () => newText); // first occurrence only
      try {
        await fs.writeFile(path, next, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Edit failed: write('${path}'): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      const kib = (next.length / 1024).toFixed(1);
      return {
        content: `edited ${path} (${replaceAll ? `${matches} replacements` : "1 replacement"}, ${kib} KiB)`,
      };
    },
  };
}

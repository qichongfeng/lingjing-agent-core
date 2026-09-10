// Search tools for Node hosts: glob (find files by name pattern) and grep
// (find content by regex). Both walk the confinement root recursively with a
// depth cap, skip ignored directories (node_modules/.git by default), cap
// results, and honour the abort signal so a run cancel stops the walk.
//
// Read-only → non-destructive, tags ["fs","fs:read"] (same allowlist slot as
// read_file/list_dir).

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { Tool, ToolResultValue } from "@lingjing-agent/core";
import { confine, globToRegExp, lazyRealroot, refused, walk } from "./util.js";

export interface SearchToolsOptions {
  /** Confinement root. Searches never leave this directory. */
  root: string;
  /** Max directory depth. Default 10. */
  maxDepth?: number;
  /** Directory names to skip at any depth. Default ["node_modules", ".git"]. */
  ignore?: string[];
  /** Max returned matches. Default 200. */
  maxResults?: number;
  /** grep skips files larger than this. Default 1 MiB. */
  maxFileSizeBytes?: number;
}

export function createGlobTool(opts: SearchToolsOptions): Tool {
  const getRoot = lazyRealroot(opts.root);
  const maxDepth = opts.maxDepth ?? 10;
  const ignore = opts.ignore ?? ["node_modules", ".git"];
  const maxResults = opts.maxResults ?? 200;

  return {
    name: "glob",
    description:
      "Find files/directories under the workspace root by glob pattern: `*` within one " +
      "segment, `**` across segments, `?` single char, `[abc]` char class. " +
      "e.g. `src/**/*.ts`, `docs/*.md`. Returns matching relative paths.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern matched against paths relative to the root." },
          path: { type: "string", description: "Optional subdirectory to search under. Default the root." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["fs", "fs:read"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { pattern, path: sub = "." } = raw as { pattern?: string; path?: string };
      if (typeof pattern !== "string" || pattern.length === 0) {
        return refused("input.pattern must be a non-empty string");
      }
      let re: RegExp;
      try {
        re = globToRegExp(pattern);
      } catch {
        return { content: `Invalid glob pattern: ${pattern}`, isError: true };
      }
      const root = await getRoot();
      const abs = await confine(root, sub || ".");
      if (abs === null) return refused(`path escapes the workspace root: ${sub}`);
      // Report workspace-relative paths so hits feed straight into read_file.
      const prefix = path.relative(root, abs).split(path.sep).join("/");

      const matches: string[] = [];
      let capped = false;
      for await (const entry of walk(abs, { maxDepth, ignore, signal: ctx.signal })) {
        const rel = prefix ? `${prefix}/${entry.rel}` : entry.rel;
        // Pattern semantics: relative to the search path (`path`), like
        // `cd <path> && ls <pattern>`. Reported paths: workspace-relative.
        if (entry.rel !== "" && re.test(entry.rel)) {
          matches.push(entry.isDir ? `${rel}/` : rel);
          if (matches.length >= maxResults) {
            capped = true;
            break;
          }
        }
      }
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      if (matches.length === 0) return { content: `No matches for ${pattern}` };
      const note = capped ? `\n[result cap ${maxResults} reached — narrow the pattern or set a path]` : "";
      return { content: matches.join("\n") + note };
    },
  };
}

export function createGrepTool(opts: SearchToolsOptions): Tool {
  const getRoot = lazyRealroot(opts.root);
  const maxDepth = opts.maxDepth ?? 10;
  const ignore = opts.ignore ?? ["node_modules", ".git"];
  const maxResults = opts.maxResults ?? 200;
  const maxFileSizeBytes = opts.maxFileSizeBytes ?? 1024 * 1024;

  return {
    name: "grep",
    description:
      "Search file CONTENTS under the workspace root by regex (JavaScript syntax, case-sensitive). " +
      "Returns `path:line:text` matches. Optionally narrow with `glob` (e.g. `*.ts`) " +
      "and `path` (subdirectory). Binary and oversized files are skipped.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression source, e.g. `TODO|FIXME`." },
          glob: { type: "string", description: "Optional glob filter on file paths, e.g. `*.ts`." },
          path: { type: "string", description: "Optional subdirectory to search under. Default the root." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
    permissions: { tags: ["fs", "fs:read"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { pattern, glob, path: sub = "." } = raw as { pattern?: string; glob?: string; path?: string };
      if (typeof pattern !== "string" || pattern.length === 0) {
        return refused("input.pattern must be a non-empty string");
      }
      let re: RegExp;
      try {
        re = new RegExp(pattern); // per-line test — no flags (case-sensitive, no global)
      } catch (err) {
        return { content: `Invalid regex ${pattern}: ${(err as Error).message}`, isError: true };
      }
      let fileFilter: RegExp | null = null;
      if (typeof glob === "string" && glob.length > 0) {
        try {
          fileFilter = globToRegExp(glob);
        } catch {
          return { content: `Invalid glob filter: ${glob}`, isError: true };
        }
      }
      const root = await getRoot();
      const abs = await confine(root, sub || ".");
      if (abs === null) return refused(`path escapes the workspace root: ${sub}`);
      // Report workspace-relative paths so hits feed straight into read_file.
      const prefix = path.relative(root, abs).split(path.sep).join("/");

      const matches: string[] = [];
      let capped = false;
      for await (const entry of walk(abs, { maxDepth, ignore, signal: ctx.signal })) {
        const rel = prefix ? `${prefix}/${entry.rel}` : entry.rel;
        // Filter semantics: relative to the search path (`path`). Reported paths: workspace-relative.
        if (entry.isDir || (fileFilter !== null && !fileFilter.test(entry.rel))) continue;
        const stat = await fsp.stat(entry.abs).catch(() => null);
        if (stat === null || !stat.isFile() || stat.size > maxFileSizeBytes) continue;
        const text = await fsp.readFile(entry.abs, "utf8").catch(() => null);
        if (text === null || text.includes("\u0000")) continue; // unreadable or binary
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (re.test(line)) {
            matches.push(`${rel}:${i + 1}:${line.trim().slice(0, 200)}`);
            if (matches.length >= maxResults) {
              capped = true;
              break;
            }
          }
        }
        if (capped) break;
      }
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      if (matches.length === 0) return { content: `No matches for /${pattern}/` };
      const note = capped ? `\n[result cap ${maxResults} reached — narrow the pattern, glob, or path]` : "";
      return { content: matches.join("\n") + note };
    },
  };
}

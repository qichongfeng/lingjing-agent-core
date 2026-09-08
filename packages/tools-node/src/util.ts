// Shared internals for the Node tool factories.

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { ToolResultValue } from "@lingjing-agent/core";

/** Refusal result for policy violations — surfaced to the model, no side effects. */
export function refused(msg: string): ToolResultValue {
  return { content: `Refused: ${msg}`, isError: true };
}

/**
 * Resolve a model-supplied path to a canonical absolute path inside `rootReal`
 * (DESIGN.md §7.6 path confinement). Returns null when the path — after symlink
 * resolution — escapes the root.
 *
 * For paths that don't exist yet (write targets), the deepest EXISTING
 * ancestor is realpath'd and the remaining tail re-joined — so a symlinked
 * parent directory can't smuggle the write outside the root.
 */
export async function confine(rootReal: string, modelPath: string): Promise<string | null> {
  const abs = path.resolve(rootReal, modelPath);
  // Lexical check first (path.resolve normalizes `..` away).
  if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) return null;
  // Symlink check on the deepest existing ancestor.
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = await fsp.realpath(probe);
    } catch (err) {
      const parent = path.dirname(probe);
      if (parent !== probe && (err as NodeJS.ErrnoException).code === "ENOENT") {
        probe = parent;
        continue;
      }
      throw err; // EACCES etc. — let the caller surface it
    }
    if (real === rootReal || real.startsWith(rootReal + path.sep)) {
      return probe === abs ? real : path.join(real, abs.slice(probe.length + 1));
    }
    return null; // an existing ancestor resolves outside the root
  }
}

/** realpath the confinement root once per factory (see createFsTools). */
export function lazyRealroot(root: string): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached === null) cached = await fsp.realpath(path.resolve(root));
    return cached;
  };
}

/**
 * Glob → RegExp for `/`-separated relative paths. Supports `*` (within one
 * segment), `?`, `[...]`/`[!...]` char classes, and a full `**` segment
 * (zero or more directories). Trailing `/` means "everything under".
 * Hand-rolled to keep the package dependency-free.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern;
  if (p.endsWith("/")) p += "**";
  const segs = p.split("/");
  let re = "";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (seg === "**") {
      // trailing `**` = zero+ dirs then a final name; mid `**` = zero+ dirs
      re += last ? "(?:[^/]+/)*[^/]*" : "(?:[^/]+/)*";
      continue;
    }
    let s = "";
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j]!;
      if (c === "*") s += "[^/]*";
      else if (c === "?") s += "[^/]";
      else if (c === "[") {
        const close = seg.indexOf("]", j + 1);
        if (close === -1) {
          s += "\\[";
          continue;
        }
        let cls = seg.slice(j + 1, close);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        s += `[${cls.replace(/\\/g, "\\\\")}]`;
        j = close;
      } else {
        s += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    re += s;
    if (!last) re += "/";
  }
  return new RegExp(`^${re}$`);
}

export interface WalkEntry {
  /** Path relative to the walk root, `/`-separated (posix-normalized). */
  rel: string;
  abs: string;
  isDir: boolean;
}

/** Recursive walk with depth cap, ignored-name skip, and abort checks. */
export async function* walk(
  root: string,
  opts: { maxDepth: number; ignore: readonly string[]; signal: AbortSignal },
): AsyncGenerator<WalkEntry> {
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { dir, rel, depth } = queue.shift()!;
    if (opts.signal.aborted) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir (EACCES…) — skip, don't kill the walk
    }
    for (const e of entries) {
      if (opts.ignore.includes(e.name)) continue;
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      const childAbs = path.join(dir, e.name);
      const isDir = e.isDirectory();
      yield { rel: childRel, abs: childAbs, isDir };
      if (isDir && depth < opts.maxDepth) {
        queue.push({ dir: childAbs, rel: childRel, depth: depth + 1 });
      }
    }
  }
}

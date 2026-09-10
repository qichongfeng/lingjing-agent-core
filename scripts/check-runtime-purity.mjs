// Runtime-purity guard: the UNIVERSAL main entry of every package must stay
// free of Node builtin imports (node:* or legacy bare names) — that is the
// "runs in browser/Edge/mini-program" contract. Node-only layers live behind
// explicit subpaths (tools/node, mcp/node — dist/node.* is exempt here).
//
// Run after a build (reads dist/); wired into scripts/release-snapshot.sh so
// both --pack and release abort on violation. A missing dist is a hard error
// (no silent skips — a skip would be a false green).

import { readFileSync, existsSync } from "node:fs";

const UNIVERSAL_PACKAGES = ["core", "provider-openai", "provider-anthropic", "tools", "mcp"];

// Node builtins that can appear as bare specifiers in bundled output.
const BUILTINS = [
  "fs", "path", "os", "url", "util", "events", "stream", "crypto", "zlib",
  "http", "https", "net", "tls", "dns", "child_process", "worker_threads",
  "buffer", "querystring", "string_decoder", "timers", "assert",
];
const BARE = BUILTINS.join("|");
const PATTERNS = [
  [/from\s+["']node:/g, 'import … from "node:…"'],
  [/require\(\s*["']node:/g, 'require("node:…")'],
  [/import\(\s*["']node:/g, 'import("node:…")'],
  [new RegExp(`from\\s+["'](${BARE})["']`, "g"), 'import … from "<bare builtin>"'],
  [new RegExp(`require\\(\\s*["'](${BARE})["']\\s*\\)`, "g"), 'require("<bare builtin>")'],
];

let failures = 0;
for (const pkg of UNIVERSAL_PACKAGES) {
  for (const file of ["dist/index.js", "dist/index.cjs"]) {
    const p = new URL(`../packages/${pkg}/${file}`, import.meta.url);
    if (!existsSync(p)) {
      console.error(`✗ packages/${pkg}/${file} missing — build first (pnpm -r build)`);
      failures += 1;
      continue;
    }
    const src = readFileSync(p, "utf8");
    const lines = src.split("\n");
    for (const [re, label] of PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i] ?? "")) {
          console.error(`✗ packages/${pkg}/${file}:${i + 1} ${label} → ${(lines[i] ?? "").trim().slice(0, 100)}`);
          failures += 1;
        }
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} violation(s): a universal main entry imports Node builtins — ` +
    "move the code behind a ./node subpath (see tools/src/node, mcp/src/node).");
  process.exit(1);
}
console.log(`✓ runtime purity: ${UNIVERSAL_PACKAGES.length} universal main entries are node:-free`);

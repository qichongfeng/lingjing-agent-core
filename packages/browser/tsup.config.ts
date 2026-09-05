import { defineConfig } from "tsup";

// One self-contained ESM file. tsup externalizes package.json `dependencies`
// by default, so the @lingjing/* workspace deps must be pulled back in via
// `noExternal` — that inlining is the whole point of this package.
export default defineConfig({
  entry: { "lingjing-agent": "src/index.ts" },
  format: ["esm"],
  target: "es2020",
  splitting: false,
  clean: true,
  sourcemap: true,
  minify: true,
  noExternal: [/^@lingjing\//],
});

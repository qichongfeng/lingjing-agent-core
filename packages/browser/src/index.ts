// Single-file CDN bundle: everything from core + the OpenAI-compatible
// provider, inlined into one dependency-free ESM file. Load directly with
// <script type="module"> — no import map, no bundler.
export * from "@lingjing/agent-core";
export * from "@lingjing/provider-openai";

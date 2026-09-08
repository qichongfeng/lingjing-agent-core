// HTML → readable plain text, hand-rolled to keep the package dependency-free
// and runtime-portable (string + regex only — no DOMParser, no node:* imports,
// so the same code runs in mini-program JS engines).

/** Basic named entities + numeric code points → characters; invalid → U+FFFD. */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    lsquo: "‘",
    rsquo: "’",
    ldquo: "“",
    rdquo: "”",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "�";
  // Lone surrogates would corrupt downstream UTF-8 encoding — replace.
  if (code >= 0xd800 && code <= 0xdfff) return "�";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "�";
  }
}

/** Collapse runs of whitespace while preserving intentional line structure. */
function tidy(s: string): string {
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract readable text from an HTML document: comments, script/style/noscript
 * blocks and tags are dropped; block-level closers and <br> become newlines;
 * entities are decoded. Good enough for a model to READ a page — not a
 * fidelity renderer (no tables/layout/base64 images).
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|section|article|header|footer|nav|blockquote|pre|ul|ol|table|dd|dt)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return tidy(decodeEntities(s));
}

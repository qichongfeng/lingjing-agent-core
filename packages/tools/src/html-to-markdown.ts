// HTML → Markdown, hand-rolled to keep the package dependency-free and
// runtime-portable (string + regex only — no DOMParser, no node:* imports, so
// the same code runs in mini-program JS engines).
//
// Structure the model actually uses is preserved: heading levels, links
// (relative hrefs resolved against the page URL so they stay followable),
// fenced code blocks (with a `language-x` hint when present), inline code,
// bold/italic, list items, and images as `![alt](src)`. Not a fidelity
// renderer — tables collapse to pipe-ish rows, nested lists flatten.

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

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (m === null) return undefined;
  return m[2] ?? m[3];
}

/** Resolve a link/image reference against the page URL (absolute stays put). */
function resolveUrl(href: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return href;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

/**
 * Extract a page as Markdown. `baseUrl` (the page's own URL) resolves
 * relative link/image references so the model can follow them with another
 * fetch.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  // 1. Drop comments and script/style blocks (their TEXT would otherwise
  //    leak into the output); capture <title>; drop the rest of <head>.
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ");

  // 2. Protect <pre> blocks as fenced code — before any tag-stripping mangles
  //    their inner whitespace. Tokens are single-line so tidy() leaves them.
  const fences: string[] = [];
  s = s.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi, (_m, attrs: string, inner: string) => {
    const lang =
      /language-([\w-]+)/i.exec(attrs)?.[1] ?? /<code\b[^>]*class\s*=\s*["'][^"']*language-([\w-]+)/i.exec(inner)?.[1];
    const text = decodeEntities(inner.replace(/<[^>]*>/g, "")).replace(/^\n+|\n+$/g, "");
    const fence = `\n\n\`\`\`${lang ?? ""}\n${text}\n\`\`\`\n\n`;
    fences.push(fence);
    return ` FENCE${fences.length - 1}END `;
  });

  // 3. Inline transforms — images first so `<a><img></a>` nests correctly.
  s = s.replace(/<img\b([^>]*)\/?>/gi, (_m, attrs: string) => {
    const src = attr(attrs, "src");
    if (src === undefined || src === "") return " ";
    if (/^(data|javascript):/i.test(src)) return " [image] ";
    const alt = attr(attrs, "alt") ?? "";
    return `![${alt}](${resolveUrl(src, baseUrl)})`;
  });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (m, attrs: string, inner: string) => {
    const href = attr(attrs, "href");
    if (href === undefined || href === "" || /^javascript:/i.test(href)) return m;
    const text = inner.trim();
    const url = resolveUrl(href, baseUrl);
    return text === "" ? `<${url}>` : `[${text}](${url})`;
  });
  s = s
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "*$2*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, "`$1`");

  // 4. Block structure: headings, list items, rules, breaks, cell separators.
  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) =>
      `\n\n${"#".repeat(Number(level))} ${inner.trim()}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (_m, inner: string) => `\n- ${inner.trim()}`)
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>\s*/gi, " | ")
    .replace(
      /<\/(p|div|section|article|header|footer|nav|aside|blockquote|table|thead|tbody|tr|ul|ol|dl|dt|dd|figure|figcaption|main|form|fieldset|address|h[1-6])\s*>/gi,
      "\n\n",
    );

  // 5. Strip remaining tags, decode entities, normalize whitespace.
  s = tidy(decodeEntities(s.replace(/<[^>]*>/g, " ")));

  // 6. Restore the code fences (post-tidy, so their formatting survives).
  s = s.replace(/FENCE(\d+)END/g, (_m, i: string) => fences[Number(i)] ?? "");

  const body = s.replace(/\n{3,}/g, "\n\n").trim();
  // <title> leads the output as context — unless the body's first heading
  // already says the same thing (the near-universal title == h1 case).
  const titleText = title === undefined ? "" : decodeEntities(title).trim();
  const firstHeading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1]?.trim();
  const heading =
    titleText !== "" && firstHeading?.toLowerCase() !== titleText.toLowerCase()
      ? `# ${titleText}\n\n`
      : "";
  return `${heading}${body}`;
}

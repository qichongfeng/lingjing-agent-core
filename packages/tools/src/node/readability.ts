// Node-only Readability extractor for web_read.
//
// The Firefox Reader Mode content-scoring algorithm (@mozilla/readability,
// Apache-2.0): scores DOM nodes by text/link density, keeps the main article
// container, and discards nav/sidebar/footer junk. It needs a DOM — linkedom
// (ISC, pure JS) supplies one — which is exactly why this lives behind the
// "./node" subpath as an OPTIONAL enhancement: the package's main entry stays
// zero-dependency and runs where no DOM exists (browsers aside, that means
// mini-program engines).
//
// Both packages are optional peerDependencies — install them yourself:
//   npm install @lingjing-agent/tools @mozilla/readability linkedom
//
// The extracted article HTML is converted to Markdown by the package's own
// built-in converter, so link resolution and code fences behave identically
// to the default web_read output.

import { htmlToMarkdown } from "../html-to-markdown.js";
import type { HtmlExtractor } from "../web-read.js";

export interface ReadabilityExtractorOptions {
  /** Options passed through to Readability (charThreshold, classesToPreserve, …). */
  readability?: Record<string, unknown>;
}

/**
 * Build a Readability-based `extractor` for `createWebReadTool({ extractor })`.
 * Declines (returns undefined) on pages with no article-shaped content —
 * web_read then falls back to the full-page built-in converter, so any URL
 * still yields content.
 */
export function createReadabilityExtractor(opts: ReadabilityExtractorOptions = {}): HtmlExtractor {
  return async (html, url) => {
    const [{ Readability }, { parseHTML }] = await Promise.all([
      import("@mozilla/readability"),
      import("linkedom"),
    ]);
    // linkedom's parseHTML returns a window-like object — the Document lives
    // on its `.document` (passing the wrapper itself is Readability's #1 misuse).
    const { document } = parseHTML(html);
    // keepClasses so `class="language-x"` survives into the serialized article
    // (code-fence hints); scoring/removal is unaffected, and the Markdown
    // converter ignores every other class anyway.
    const article = new Readability(document as unknown as Document, {
      keepClasses: true,
      ...opts.readability,
    }).parse();
    if (article === null) return undefined;
    const content = article.content;
    if (content === null || content === undefined || content === "") return undefined;
    const body = htmlToMarkdown(content, url);
    // The article title leads the output unless the body's first heading
    // already says the same thing (mirrors the built-in converter's dedup).
    const title = article.title?.trim() ?? "";
    const firstHeading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1]?.trim();
    const heading =
      title !== "" && firstHeading?.toLowerCase() !== title.toLowerCase() ? `# ${title}\n\n` : "";
    return `${heading}${body}`;
  };
}

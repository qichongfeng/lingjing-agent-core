# @lingjing-agent/tools

**[简体中文](https://github.com/qichongfeng/lingjing-agent-core#内置工具可选注入)** | English

Built-in tools for [`@lingjing-agent/core`](https://www.npmjs.com/package/@lingjing-agent/core) — **one package, two layers**:

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@lingjing-agent/tools` | **Node / browser / Edge / mini-program** | `web_search` · `read_feed` · `fetch_json` · `web_fetch` — zero `node:*` imports, network only through core's `HttpTransport` |
| `@lingjing-agent/tools/node` | **Node / Electron / Tauri-main only** | `fs` (path-confined) · hardened `shell` · `glob` · `grep` · Readability extractor |

The platform split is the package's internal structure, not your problem: import the main entry anywhere; import `./node` only from Node-side code (that import is the single point where platform-specific code enters your bundle).

```bash
npm install @lingjing-agent/tools
# Node hosts wanting fs/shell/glob/grep + Readability:
npm install @lingjing-agent/tools @mozilla/readability linkedom
```

```ts
import { createAgent } from "@lingjing-agent/core";
import { createWebSearchTool, createReadFeedTool, createFetchJsonTool, createWebFetchTool } from "@lingjing-agent/tools";
import { createFsTools, createSafeShell, createGrepTool } from "@lingjing-agent/tools/node"; // Node side only

const agent = createAgent({
  /* provider, model, … */
  tools: [
    // web layer (any runtime)
    createWebSearchTool({ apiKey: process.env.BRAVE_API_KEY! }),// search API → {title,url,snippet}[]
    createReadFeedTool(),                                       // RSS/Atom → structured entries
    createFetchJsonTool(),                                      // JSON API GET → pretty value
    createWebFetchTool(),                                       // static-page GET → Markdown, 15 min cache
    // node layer
    ...createFsTools({ root: process.cwd() }),                  // path-confined read/write/list/delete
    createSafeShell({ allowlist: ["git", "ls", "cat", "rg"] }), // no metachars, spawn(shell:false), timeout
    createGrepTool({ root: process.cwd() }),                    // content search (+ createGlobTool)
  ],
});
```

> Migrated from `@lingjing-agent/tools-node` + `@lingjing-agent/tools-fetch` (both beta-era, now unified here).

## Why a reliable-channel-first web toolbox

A plain HTTP GET against today's web fails more often than it succeeds: JS-rendered SPAs return empty shells, anti-bot fronts refuse non-browser clients, and mini-program runtimes only reach whitelisted domains. The web layer is therefore built **reliable-channel-first**:

| Tool | Channel | Reliability |
| --- | --- | --- |
| `web_search` | host-keyed search API (Brave / Tavily / Serper) | ★★★ — server-rendered snippets, no scraping |
| `read_feed` | RSS 2.0 / Atom feeds | ★★★ — structured XML, no anti-bot |
| `fetch_json` | public JSON APIs | ★★★ — structured, rarely gated |
| `web_fetch` | direct page GET → Markdown | ★☆☆ — static, server-rendered pages only |

Every tool ships with `permissions.network: true` (hosts can gate) and tags for `allowedToolTags` matching.

## web_search

```ts
createWebSearchTool({ engine: "brave", apiKey: process.env.BRAVE_API_KEY! }) // or "tavily" | "serper"
```

Returns `[{title, url, snippet}]` as JSON. The API key is **host-owned configuration** — exactly like OAuth credentials in the MCP package — never something the model supplies. Snippets often answer the question outright; fetch a result URL only when detail is needed. 15 s timeout, `maxResults` 1–10 (default 5).

## read_feed

```ts
createReadFeedTool() // + optional { defaultLimit, maxBytes, timeoutMs }
```

Fetches an RSS/Atom feed and returns entries as `[{title, url, date, summary}]`, most recent first as the feed orders them. News, blogs, changelogs, release notes — anywhere a site offers a feed, this beats scraping the page. Zero-dependency tolerance-first parsing: CDATA, XML/numeric entities, `dc:date`, Atom `rel="alternate"` links, and HTML inside summaries (distilled to Markdown, links survive). 256 KiB body cap, `limit` 1–50 (default 10).

## fetch_json

```ts
createFetchJsonTool({ headers: { authorization: `Bearer ${process.env.API_KEY!}` } })
```

GETs a JSON endpoint and returns the parsed value pretty-printed (data lookups, catalogs, docs APIs). Request headers come from the **host** (`opts.headers` — credentials), never from the model. Non-JSON responses get a clear error pointing at `web_fetch`; a body cut by the byte cap reports itself instead of a confusing parse error. 128 KiB cap, 30 s timeout.

## web_fetch

```ts
createWebFetchTool() // http(s) GET → Markdown, byte-capped, 15 min/URL cache
```

Best-effort reader for **static, server-rendered** pages: HTML distilled to **Markdown** — heading levels, links (relative hrefs resolved against the page URL, so the model can follow them), fenced code blocks with `language-x` hints, inline code, bold/italic, list items, and images as `![alt](src)`; `<title>` becomes the leading heading (deduped against the body's first heading). Successful results are cached per URL for 15 min (`cacheTtlMs`, `0` disables). 128 KiB body cap, 30 s timeout.

Request headers come from the host (`opts.headers`): the default User-Agent is honest and self-identifying, and switching to a browser-like UA is **your** policy call, not the library's default. web_fetch does not fight SPAs or anti-bot fronts — search first, prefer structured channels.

## Readability 正文提取(`./node`,DLC)

`web_fetch` 默认全页转换 —— 导航/侧栏也保留。Node host 可以注入 **Readability 算法**(Firefox 阅读模式的正文打分提取,`@mozilla/readability`,Apache-2.0)拿到"只剩正文"的输出:

```ts
import { createWebFetchTool } from "@lingjing-agent/tools";
import { createReadabilityExtractor } from "@lingjing-agent/tools/node";

createWebFetchTool({ extractor: createReadabilityExtractor() })
```

- **实测 MDN 文档页**:40.6 KiB/186 链接(全页)→ 29.1 KiB/69 链接(正文),侧栏特征词零残留,代码围栏完整;
- **优雅降级是契约的一部分**:页面没有文章结构(首页/列表页)或 Readability 判定失败时,提取器返回"拒绝",自动回退内置全页转换 —— 任何 URL 都有输出;提取器抛异常同样回退;
- `@mozilla/readability` + `linkedom` 是**可选 peerDependencies**(算法需要 DOM)。

## Node 工具安全默认值

(承继自原 `@lingjing-agent/tools-node`,见 [DESIGN.md §7](../../DESIGN.md)):模型可见路径被 confinement 到 `root`(`..`/绝对路径/symlink 逃逸均拒绝);`write_file`/`delete_path`/`shell` 默认 `permissions.destructive: true`(无 permissionGate 的 host 会被拒绝);shell 走可执行白名单 + 元字符拒绝 + `spawn(shell:false)`;工具带 tag(`fs:read`/`fs:write`/`fs:delete`/`shell`)供 `allowedToolTags` 精确放行。

## Custom transport (mini-programs)

Runtimes without a global `fetch` (WeChat mini-programs) inject a transport — one whitelisted proxy endpoint makes every web tool work:

```ts
createWebSearchTool({ apiKey, transport: createWxTransport(wx) });
createReadFeedTool({ transport: createWxTransport(wx) });
createFetchJsonTool({ transport: createWxTransport(wx) });
createWebFetchTool({ transport: createWxTransport(wx) });
```

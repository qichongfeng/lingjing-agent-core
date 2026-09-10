# @lingjing-agent/tools

**[简体中文](https://github.com/qichongfeng/lingjing-agent-core#内置工具可选注入)** | English

Built-in tools for [`@lingjing-agent/core`](https://www.npmjs.com/package/@lingjing-agent/core) — **one package, two layers**:

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@lingjing-agent/tools` | **Node / browser / Edge / mini-program** | `createWebTools()` → `web_read` (universal reader) · `wiki_search` · `news_search` (+ keyed `web_search`) — zero `node:*` imports, network only through core's `HttpTransport` |
| `@lingjing-agent/tools/node` | **Node / Electron / Tauri-main only** | `fs` (path-confined) · hardened `shell` · `glob` · `grep` · Readability extractor |

The platform split is the package's internal structure, not your problem: import the main entry anywhere; import `./node` only from Node-side code (that import is the single point where platform-specific code enters your bundle).

```bash
npm install @lingjing-agent/tools
# Node hosts wanting fs/shell/glob/grep + Readability:
npm install @lingjing-agent/tools @mozilla/readability linkedom
```

```ts
import { createAgent } from "@lingjing-agent/core";
import { createWebTools } from "@lingjing-agent/tools";
import { createFsTools, createSafeShell, createGrepTool } from "@lingjing-agent/tools/node"; // Node side only

const agent = createAgent({
  /* provider, model, … */
  tools: [
    // web layer (any runtime) — web_read + wiki_search + news_search in one call;
    // add webSearch: { apiKey } for keyed web search
    ...createWebTools({ wiki: { languages: ["zh", "en"] } }),
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
| `wiki_search` | Wikipedia API (any language, **no key**, CORS-open) | ★★★ — free, browser-direct |
| `news_search` | Hacker News via Algolia (**no key**, CORS-open) | ★★★ — tech news, newest-first option |
| `web_search` | host-keyed search API (Brave / Tavily / Serper) | ★★★ — server-rendered snippets, no scraping |
| `web_read` | universal URL GET — JSON / feeds / HTML auto-dispatch | ★★★ JSON·feed / ★☆☆ HTML (static pages only) |

Every tool ships with `permissions.network: true` (hosts can gate) and tags for `allowedToolTags` matching.

## wiki_search / news_search — keyless search

The two searches that need **no API key and run browser-direct** (both send `Access-Control-Allow-Origin: *`):

```ts
createWikiSearchTool({ languages: ["zh", "en"] }) // Wikipedia, multilingual merge
createNewsSearchTool()                            // Hacker News; { recent: true } for newest-first
```

- `wiki_search` → `[{title, url, snippet, lang}]`. Concepts, definitions, factual lookups; the first choice before any keyed web search.
- `news_search` → `[{title, url, points, comments, author, createdAt}]` — Hacker News, i.e. a **tech-community lens**: tech + science + major current events; English-only content (the tool description tells the model to translate queries and to flag scope for local/non-tech news).
- Caveat: reachability follows the user's network (e.g. `*.wikipedia.org` is unreachable from mainland China without a proxy) — failures surface as tool errors for the model to report honestly.

## web_search (keyed)

```ts
createWebSearchTool({ engine: "brave", apiKey: process.env.BRAVE_API_KEY! }) // or "tavily" | "serper"
```

Returns `[{title, url, snippet}]` as JSON. The API key is **host-owned configuration** — exactly like OAuth credentials in the MCP package — never something the model supplies. Snippets often answer the question outright; fetch a result URL only when detail is needed. 15 s timeout, `maxResults` 1–10 (default 5).

## web_read — the universal URL reader

```ts
createWebReadTool() // or via createWebTools
```

ONE tool, one decision — "read this URL". The response shape picks the treatment (the model usually cannot know a URL's content type in advance; parameter-based dispatch would just hide selection errors in parameter validation):

| Server returns | You get |
| --- | --- |
| JSON (content-type, or a body that parses) | pretty-printed JSON |
| RSS 2.0 / Atom (content-type or XML sniff) | entries as `[{title, url, date, summary}]` (`limit`, default 10) |
| HTML | Markdown — headings, links resolved against the page URL (followable), code fences with `language-x` hints; optional Readability extractor |
| anything else | raw body |

Successful results cached per URL (+feed limit) for 15 min (`cacheTtlMs`, `0` disables). 128 KiB body cap, 30 s timeout. HTML works for static, server-rendered pages — it does not fight SPAs or anti-bot fronts. Request headers come from the host (`opts.headers`); the default UA is honest and self-identifying, and a browser-like UA is your policy call.

The feed parser (`parseFeed`) and `htmlToMarkdown` are exported for direct use.

## createWebTools — the one-call toolbox

```ts
tools: [...createWebTools({ wiki: { languages: ["zh", "en"] } })]
// → [web_read, wiki_search, news_search]; each entry: options to configure, false to drop.
// webSearch: { apiKey } adds keyed web search (never ship a key in client-side code).
```

Aggregation happens at the factory level, never at the tool level: the model keeps focused, well-named tools (routing by name beats a multi-mode dispatcher).

## Readability 正文提取(`./node`,DLC)

`web_read` 默认全页转换 —— 导航/侧栏也保留。Node host 可以注入 **Readability 算法**(Firefox 阅读模式的正文打分提取,`@mozilla/readability`,Apache-2.0)拿到"只剩正文"的输出:

```ts
import { createWebReadTool } from "@lingjing-agent/tools";
import { createReadabilityExtractor } from "@lingjing-agent/tools/node";

createWebReadTool({ extractor: createReadabilityExtractor() })
```

- **实测 MDN 文档页**:40.6 KiB/186 链接(全页)→ 29.1 KiB/69 链接(正文),侧栏特征词零残留,代码围栏完整;
- **优雅降级是契约的一部分**:页面没有文章结构(首页/列表页)或 Readability 判定失败时,提取器返回"拒绝",自动回退内置全页转换 —— 任何 URL 都有输出;提取器抛异常同样回退;
- `@mozilla/readability` + `linkedom` 是**可选 peerDependencies**(算法需要 DOM)。

## Node 工具安全默认值

(承继自原 `@lingjing-agent/tools-node`,见 [DESIGN.md §7](../../DESIGN.md)):模型可见路径被 confinement 到 `root`(`..`/绝对路径/symlink 逃逸均拒绝);`write_file`/`delete_path`/`shell` 默认 `permissions.destructive: true`(无 permissionGate 的 host 会被拒绝);shell 走可执行白名单 + 元字符拒绝 + `spawn(shell:false)`;工具带 tag(`fs:read`/`fs:write`/`fs:delete`/`shell`)供 `allowedToolTags` 精确放行。

## Custom transport (mini-programs)

Runtimes without a global `fetch` (WeChat mini-programs) inject a transport — one whitelisted proxy endpoint makes every web tool work:

```ts
createWebTools({ wiki: { transport: createWxTransport(wx) }, read: { transport: createWxTransport(wx) } });
```

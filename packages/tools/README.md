# @lingjing-agent/tools

**[简体中文](https://github.com/qichongfeng/lingjing-agent-core#内置工具可选注入)** | English

Built-in tools for [`@lingjing-agent/core`](https://www.npmjs.com/package/@lingjing-agent/core) — **one package, two layers**:

| Entry | Runtime | Contents |
| --- | --- | --- |
| `@lingjing-agent/tools` | **Node / browser / Edge / mini-program** | `createWebTools()` → `web_read` (universal reader) · `wiki_search` (+ keyed `web_search`) · `createAskUserTool()` (human-in-the-loop) · `createPlanTool()` (agent's task list) · `createWriteFileTool()` / `createReadFileTool()` + `createPreviewTool()` (the artifact workflow: write → read back → sandboxed verify) — zero `node:*` imports, network only through core's `HttpTransport` |
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
    // web layer (any runtime) — web_read + wiki_search in one call;
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
| `web_search` | Serper — Google results via host-keyed API | ★★★ — server-rendered snippets, no scraping |
| `web_read` | universal URL GET — JSON / feeds / HTML auto-dispatch | ★★★ JSON·feed / ★☆☆ HTML (static pages only) |

Every tool ships with `permissions.network: true` (hosts can gate) and tags for `allowedToolTags` matching.

## ask_user — human-in-the-loop clarification

The one tool that is not about the web: the model asks the user ONE clarifying question when it is genuinely blocked, and the run blocks until they answer.

```ts
import { createAskUserTool } from "@lingjing-agent/tools";

createAskUserTool({
  handler: async (q, signal) => {
    // render q.question (+ q.options as clickable choices, q.allowMultiple)
    // resolve with the user's answer string; honor `signal` — an aborted
    // signal means the run is over, stop waiting and drop the UI
    return answer;
  },
})
```

- Schema: `question` (one thing, in the user's language) + optional `options[]` (1–4 `{label, description?}`) + `allowMultiple`. The handler owns the whole UX — rendering, joining a multi-select, mapping a dismiss to an empty string; the tool returns the resolved string verbatim (trimmed, 4 000-char cap).
- Waiting for a human is slow: the default timeout is **10 minutes** (`timeoutMs`), the largest in the family. On timeout the loop reports it as a tool error and the model proceeds on its own judgment (the description tells it to).
- Abort-safe: `execute` never throws; an aborted run surfaces as `(aborted)`. `permissions: { tags: ["ask"] }` — no network, nothing destructive.
- Not part of `createWebTools` — a standalone factory the host wires explicitly (it is useless without a handler anyway).

## update_plan — the agent's shared task list

Codex-style plan tracking: the model publishes its full step list when starting multi-step work and re-publishes it as steps move along, so the user sees progress instead of guessing from prose. Each call carries the **complete** plan (full replacement, no diffs) — stateless and idempotent, a retried call can never corrupt it.

```ts
import { createPlanTool } from "@lingjing-agent/tools";

createPlanTool({
  // fire-and-forget, sync, errors swallowed — persist the latest plan per
  // conversationId: context compaction may drop old update_plan calls, this
  // callback is where the durable copy comes from
  onUpdate: ({ plan, conversationId, toolCallId }) => savePlan(conversationId, plan),
})
```

- Schema: `plan[]` of `{ step, status: "pending" | "in_progress" | "completed" }` (status defaults to pending). Max 20 steps, 500 chars each; the result echoes the canonical plan as `Plan updated (2/5 done): …`.
- `Refused:` errors (never throws) on a missing/empty plan, over-long plans, or bad statuses — the message names the offending index so the model can self-correct.
- Instant, no network, `permissions: { tags: ["plan"] }`. Like `ask_user`, a standalone factory — but it works with zero host wiring; `onUpdate` is the optional persistence hook.

## write_file / read_file — the artifact workspace pair

Pure browser hosts have no fs, but an agent producing HTML artifacts needs somewhere to put them. `write_file` is a path/content write primitive over a **host-injected storage handler** — the library owns schema/validation/caps/description, the host decides what a path means (IDB, memory, workspace). `read_file` is the read-back half (same handler shape, typically the SAME handler preview's `read` uses — one shared path namespace across the family). It exists for the two moments the model loses what it wrote: context compaction folded the earlier write calls into a summary, or an old conversation resumed cold — reading the workspace back beats rewriting from memory.

```ts
import { createWriteFileTool, createReadFileTool } from "@lingjing-agent/tools";

createWriteFileTool({
  // REQUIRED — host storage write; path semantics are entirely the host's
  write: (path, content, signal) => idbSet(path, content, artifactStore),
  // maxContentChars: 1_200_000 default (~1.2 MB per self-contained HTML)
})
createReadFileTool({
  // same store, same namespace — usually the very same handler preview uses
  read: (path, signal) => idbGet(path, artifactStore),
  // maxChars: 100_000 default — truncate instead of blowing the context budget
})
```

- write schema: `path` (≤200 chars) + `content` (non-empty, ≤ `maxContentChars`); result `saved snake.html (12.3 KiB)`. read schema: `path`; result = `path/chars` header + content, `…[truncated]` past `maxChars`.
- `Refused:` on bad input, `Save failed:` / `Read failed:` on handler failure — never throws.
- Instant, no network, `permissions: { tags: ["artifact:write"] | ["artifact:read"] }`. Standalone factories, not in `createWebTools` (need host wiring, like `ask_user`).

## edit_file — targeted changes without the rewrite

Rewriting a 40 KB file to fix one line burns ~15k output tokens and risks max_tokens truncation; after compaction the model may not hold the full file, so a rewrite can silently drop content. `edit_file` is str_replace over the same fs: `oldText` (copied exactly from the file) → `newText` (empty = deletion). The fs seam needs nothing new — readFile + writeFile.

```ts
import { createEditFileTool } from "@lingjing-agent/tools";

createEditFileTool({ fs }) // same fs as write_file/read_file/manage_file
```

- `oldText` must match exactly once; ambiguous matches refuse with the count (`add surrounding context or pass replaceAll: true`), zero matches refuse with "the file may have changed — read_file it and retry". `oldText === newText` refuses (no-op).
- Result `edited snake.html (1 replacement, 12.4 KiB)`. `Refused:` on bad input/matches, `Edit failed:` on handler failure — never throws. `permissions: { tags: ["artifact:edit"] }`.

## manage_file — move/delete, one op parameter

The tidy-up half: overwrite-only storage grows `snake-v2-FINAL.html` forever. One tool with `op` — **move** (`path` → `to`, parents created, destination overwritten; rename is a move within the folder) and **delete** (files and empty folders always; a NON-EMPTY folder only with `recursive: true`, so wiping a tree is an explicit choice). Needs a hierarchical backend (`fs.move` / `fs.remove` — both ship in the OPFS/FSA adapters; move is byte-exact copy + source delete, since FSA has no native rename).

```ts
import { createManageFileTool } from "@lingjing-agent/tools";

createManageFileTool({ fs }) // same fs as write_file/read_file/preview
```

- Results: `moved a.html → old/a.html`, `deleted a.html`. `Refused:` on bad input or a backend without the capability, `Move failed:` / `Delete failed:` on handler failure (the non-empty-folder refusal surfaces here) — never throws.
- Instant, no network, `permissions: { tags: ["artifact:manage"] }`.
- For hosts over a real folder, `filesystem.ts` ships the storage seam: `Filesystem` (readFile / readFileBytes / writeFile / listDir? / remove? / scope?) with OPFS & FSA adapters (`createOpfsFilesystem`, `createFsaFilesystem`). `scope(path)` returns a subdirectory-rooted workspace — multi-tenant roots (projects under one granted folder) get handle-level confinement instead of host-side path prefixing; `remove` deletes files/directories recursively.

## preview — the agent's eyes on its own artifacts

An agent writing a game/page/chart is blind: it cannot tell "renders fine" from "throws on load". `preview` opens the artifact in a **sandboxed iframe** (`sandbox="allow-scripts"`, opaque origin, CSP-forced zero egress), injects a driver script ahead of the artifact's own code, and talks to it over postMessage. The model can then act (click / key / type / scroll / wait), read DOM values, eval JS inside it, and screenshot its canvas — console output and uncaught errors come back with every call. The loop it exists for: write → open → act/read/shot → fix → repeat. Direction matters: `web_read` faces the world (information in, never executes); `preview` faces the agent's OWN output (executes, but inside a sandbox that cannot reach the host or the network).

```ts
import { createPreviewTool } from "@lingjing-agent/tools";

const preview = createPreviewTool({
  // REQUIRED — the artifact source. Path semantics are entirely the host's
  // (real workspace, virtual store, generated artifacts). MUST honor signal.
  read: (path, signal) => workspace.readFile(path, signal),
  // optional: show the frame yourself — the user watches what the agent tests
  attach: (frame) => panelRoot.appendChild(frame),
});
// agent calls: preview({op:"open", path:"snake.html"})
//              preview({op:"act", actions:[{type:"click",x:640,y:400},{type:"key",key:"ArrowRight",}]})
//              preview({op:"read", queries:[{css:"#score"}]})
//              preview({op:"eval", code:"return game.state"})
//              preview({op:"shot"}) / preview({op:"close"})
```

- **Ops**: `open` (fresh session — always reloads; new-path or same-path) · `act` (≤32 actions, click/key/type/scroll/wait) · `read` (≤20 css queries, `attr`: text|html|value|any attribute) · `eval` (JS inside the artifact, `return` to yield) · `shot` (largest `<canvas>` → image block) · `close`. Sessions persist between calls (multi-step play works) and idle out after 2 min (`idleMs`); a stale `act` just tells the model to `open` again. One session per conversation, FIFO-capped at 8.
- **Every response** = op result + session line + console/errors since the last call (consecutive duplicates collapse to `×N`). Screenshots ship as an image block with a text summary — image blocks inside tool results reach Anthropic-class models; text-only providers (OpenAI chat completions) drop them, rely on `read`/`eval` there.
- **Sandbox**: CSP meta forces zero egress (`connect-src 'none'`, inline-only scripts/styles, `data:`/`blob:` assets) — so the single-file, inline-your-assets convention; WebGL contexts get `preserveDrawingBuffer` so shots work; a memory shim covers `localStorage` (access throws in opaque origins). Known limits: no workers, no persistent storage, synthesized input is `isTrusted:false` (games filtering it can be driven via `eval` on their own APIs).
- **Timeout/abort**: 30 s default; total wait budgets are validated up front (refusal quotes the real numbers — the lesson from the archived playwright-era `game_run`); the internal deadline sits 250 ms inside `tool.timeoutMs` so the graceful error wins the race. Abort kills the call (`(aborted)`), never the session. `permissions: { tags: ["preview"] }`, no network.
- **Runtime**: browser-like hosts only (needs `document`); imports fine everywhere and refuses gracefully in Node/mini-programs. `frameFactory` is the test/DI seam (all DOM code lives in one adapter) — outside tests you normally never touch it.
- rAF 保真度:离屏 iframe(非 `display:none`)部分引擎会限流 rAF,动画帧率可能偏低——要完整帧率就 `attach` 一个可见面板,让用户顺便看到 agent 正在测的画面。

## wiki_search — keyless search

The search that needs **no API key and runs browser-direct** (Wikipedia sends `Access-Control-Allow-Origin: *`):

```ts
createWikiSearchTool({ languages: ["zh", "en"] }) // Wikipedia, multilingual merge
```

- `wiki_search` → `[{title, url, snippet, lang}]`. Concepts, definitions, factual lookups; the first choice before any keyed web search.
- Caveat: reachability follows the user's network (e.g. `*.wikipedia.org` is unreachable from mainland China without a proxy) — failures surface as tool errors for the model to report honestly.

## web_search (keyed — Serper)

```ts
createWebSearchTool({ apiKey: process.env.SERPER_API_KEY! })          // server hosts: key in env
createWebSearchTool({ endpoint: "/api/serper", apiKey: "gw-token" })  // gateway route: host-issued
                                                                      // token; gateway swaps in the
                                                                      // real Serper key server-side
```

Returns Google results as `[{title, url, snippet}]` JSON. The API key is **host-owned configuration** — exactly like OAuth credentials in the MCP package — never something the model supplies. Snippets often answer the question outright; fetch a result URL only when detail is needed. 15 s timeout, `maxResults` 1–10 (default 5).

**The endpoint is customizable, the protocol is not.** `endpoint` changes WHERE requests go — a gateway route or any Serper-protocol-compatible backend. The wire format stays fixed by the tool: `POST` with a `{q, num}` JSON body, an `x-api-key` header (**always sent — the key is part of the protocol and `apiKey` is required with every endpoint**, be it the Serper key or the host gateway's own token), and an `organic[]` response.

Why Serper as the single engine (probed 2026-09-14): it is the only keyed search API that is **both** browser-readable (`Access-Control-Allow-Origin: *` on preflight and actual responses) **and** reachable from mainland China without a proxy. Tavily answers preflights but sends no ACAO on actual responses; Brave sends no CORS headers at all; Jina `s.jina.ai` is CORS-open but mainland-unreachable. Practical consequence: a **pure browser host may call Serper direct**, accepting that the key ships in the bundle — with a free-tier key the worst case is quota theft, bounded; or point `endpoint` at a gateway so the real key stays server-side while the client carries only a gateway token.

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

### Forwarding — browser hosts (URL 转发)

浏览器直连受 CORS 与网络可达性双重限制("curl 能访问,工具读不了"的多半根因)。`forward` 让读取改走一个转发端点(自家服务端路由最稳:同源无 CORS、服务端网络无墙、无限速):

```ts
createWebReadTool({ forward: "/api/web-read?url={urlEncoded}" }) // own same-origin route
createWebReadTool({ forward: "https://r.jina.ai/{url}" })        // Jina Reader(prefix style)
createWebReadTool({ forward: (url) => signedProxyUrl(url) })      // full control
```

- 模板占位符:`{url}` 原样拼接、`{urlEncoded}` 编码进查询参数;无占位符的字符串按前缀拼接;函数形态随意;
- 对模型完全透明:协议门禁、输出的 `url:`、缓存键、HTML 链接解析全部仍用**目标 URL**,转发端点不外露;
- 不设默认转发方:每个被读的 URL 都会发给转发服务(隐私),且公共免费代理实测不可靠(AllOrigins/codetabs 间歇 500/超时;Jina 匿名档限速且拦机房 IP,免费 key 放 `headers` 即可用)——这是宿主的决策。要"先直连、失败再转发"的宿主请包一层自定义 `transport`。

## createWebTools — the one-call toolbox

```ts
tools: [...createWebTools({ wiki: { languages: ["zh", "en"] } })]
// → [web_read, wiki_search]; each entry: options to configure, false to drop.
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

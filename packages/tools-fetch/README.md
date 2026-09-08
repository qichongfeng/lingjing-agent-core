# @lingjing-agent/tools-fetch

**[简体中文](https://github.com/qichongfeng/lingjing-agent-core#内置工具可选注入)** | English

`web_fetch` tool for [`@lingjing-agent/core`](https://www.npmjs.com/package/@lingjing-agent/core) — cross-runtime (**Node / browser / Edge / mini-program**): zero `node:` imports, reaches the network only through core's `HttpTransport` abstraction.

```bash
npm install @lingjing-agent/tools-fetch
```

```ts
import { createAgent } from "@lingjing-agent/core";
import { createWebFetchTool } from "@lingjing-agent/tools-fetch";

const agent = createAgent({
  /* provider, model, … */
  tools: [createWebFetchTool()], // http(s) GET → readable text (HTML distilled), byte-capped
});
```

Runtimes without a global `fetch` (WeChat mini-programs) inject a transport:

```ts
createWebFetchTool({ transport: createWxTransport(wx) });
```

Bounds by default: http/https only, 128 KiB body cap, 30 s timeout, HTML distilled to text (scripts/styles dropped). Ships with `permissions.network: true` and tag `http` for `allowedToolTags` matching.

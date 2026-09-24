# 微信小程序最小骨架(lingjing-agent-core)

一个可直接拷进微信开发者工具的最小工程:用 `@lingjing-agent/core` + `provider-openai` +
`createWxTransport` 跑通一个流式聊天页(输入 → 流式渲染回复 → 停止/离开页面取消)。

## 文件
| 文件 | 作用 |
| --- | --- |
| `app.js` | **AbortController polyfill(必须在 require core 之前)** + 创建全局 agent |
| `app.json` / `sitemap.json` | 小程序配置 |
| `pages/chat/*` | 聊天页:消费 `agent.stream` 事件流、流式渲染、`onUnload` abort、停止按钮 |
| `miniprogram-transport.js` | `wx.request` → `HttpTransport` 适配器(派生自 `examples/miniprogram-transport.ts`,改逻辑请改 `.ts` 源) |

## 接入 @lingjing-agent/* 包

包已发布到 npm 公共 registry(`--access public`,当前 0.1.0-beta.x)。小程序工程要用,三选一:

### 方式 A:registry 安装(默认)
在小程序工程的 `miniprogram/package.json`(版本号换成当前发布版):
```json
{
  "dependencies": {
    "@lingjing-agent/core": "0.1.0-beta.10",
    "@lingjing-agent/provider-openai": "0.1.0-beta.10"
  }
}
```
`cd miniprogram && npm install`,然后微信开发者工具「工具 → 构建 npm」。升级 = 改版本号重装 + 重新构建 npm。

### 方式 B:本地 `file:` 依赖(改内核源码联调时)
先在本仓库 `pnpm -r build`(产出各包 `dist/`),依赖写 `file:../../path/to/lingjing-agent-core/packages/core` 等路径,其余同方式 A。

### 方式 C:拷贝 dist(最稳,不依赖符号链接/网络)
把 `packages/core/dist` 整个拷成 `miniprogram/libs/agent-core/`,`packages/provider-openai/dist` 拷成 `miniprogram/libs/provider-openai/`。`app.js` 改成:
```js
const { createAgent } = require("./libs/agent-core/index.cjs");
const { OpenAIProvider } = require("./libs/provider-openai/index.cjs");
```

## 使用步骤
1. 微信开发者工具**新建项目**(填你的 appid 或选测试号),把本目录所有文件拷进 `miniprogram/`(或直接以本目录为 `miniprogramRoot`)。
2. 填 `app.js` 的 `API_KEY` 和 `BASE_URL`(OpenAI 兼容端点,如 OpenAI / 字节豆包 / 通义 / 自建网关)。
3. **小程序后台** → 开发管理 → 服务器域名 → 「request 合法域名」加 `BASE_URL` 的域名(必须 https)。
4. 在 `miniprogram/` 下 `npm install`(方式 A/C),开发者工具「工具 → 构建 npm」。
5. 跑;输入消息 → 流式渲染;「停止」按钮取消(`handle.abort()`)。

## 注意事项
- **AbortController polyfill 必须在 `require("@lingjing-agent/core")` 之前**(`app.js` 顶部已就位)。core 内部 `new AbortController()`,小程序原生没有,缺则启动即崩。
- **真机流式**:微信 `enableChunked` 在真机某些版本不真流式(一次性返回 / 丢数据),是微信的 bug,非本骨架问题。先在开发者工具测,真机充分测试。
- **后台/离开页面**:`onUnload` 已 `handle.abort()`(本骨架);如需切后台也停,在 `onHide` 里同样 abort。
- **合法域名**:微信强制 request 域名 https 且在后台白名单,否则 `wx.request` 静默失败。
- **小程序 npm 构建只处理 CJS 入口**:core 的 `dist/index.cjs` 会被正确处理;ESM 入口不用于小程序。

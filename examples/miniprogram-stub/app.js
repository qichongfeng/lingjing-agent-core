// app.js — 全局 polyfill + 创建全局 agent。
//
// ⚠️ AbortController polyfill 必须在 require("@lingjing-agent/core") 之前执行:
//    core 内部会 new AbortController(),微信小程序原生没有该全局,缺则启动即崩。
if (typeof globalThis.AbortController === "undefined") {
  globalThis.AbortController = class AbortController {
    constructor() {
      const listeners = [];
      this.signal = {
        aborted: false,
        addEventListener(type, fn) {
          if (type === "abort") listeners.push(fn);
        },
        removeEventListener(type, fn) {
          if (type === "abort") {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          }
        },
      };
      this.abort = () => {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        for (const fn of listeners) {
          try {
            fn();
          } catch (e) {
            /* swallow listener errors */
          }
        }
      };
    }
  };
}

const { createAgent } = require("@lingjing-agent/core");
const { OpenAIProvider } = require("@lingjing-agent/provider-openai");
const { createWxTransport } = require("./miniprogram-transport");

// TODO: 填你的 OpenAI 兼容后端(API key + baseURL)。BASE_URL 域名必须在小程序后台白名单。
const API_KEY = "sk-xxxxxxxx";
const BASE_URL = "https://api.openai.com/v1";

App({
  agent: createAgent({
    provider: new OpenAIProvider({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      transport: createWxTransport(wx), // 全局 wx
    }),
    model: "gpt-4o-mini",
    system: "你是一个简洁的助手。",
    tools: [
      {
        // 小程序自定义工具示例:读本地缓存。更多工具按需加(扫一扫/位置/剪贴板…)。
        name: "get_storage",
        description: "读取小程序本地缓存(指定 key),返回字符串值。",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
        },
        permissions: {},
        requiresConfirmation: false,
        async execute({ key }) {
          return { content: String(wx.getStorageSync(key) ?? "") };
        },
      },
    ],
    maxTurns: 10,
    // demo 用 auto-approve;生产环境配 permissionGate 做破坏性工具的人工审批。
    permissionGate: { async request() { return { allow: true }; } },
  }),
});

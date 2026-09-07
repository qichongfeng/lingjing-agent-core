// 微信小程序 wx.request → core HttpTransport 适配器(参考实现,可直接复制到小程序工程)。
//
// 把 wx.request 的 enableChunked + onChunkReceived 回调式流,桥接成 core 的
// HttpTransport 契约(body: AsyncIterable<Uint8Array>),让同一份 provider/tool 代码
// 在小程序里零 polyfill 运行。
//
// 用法(小程序工程内,经「构建 npm」引入 @lingjing-agent/core 与 provider-openai):
//
//   import { createAgent } from "@lingjing-agent/core";
//   import { OpenAIProvider } from "@lingjing-agent/provider-openai";
//   import { createWxTransport } from "./miniprogram-transport";
//
//   const agent = createAgent({
//     provider: new OpenAIProvider({
//       apiKey: "sk-...", baseURL: "https://api.example.com/v1",
//       transport: createWxTransport(wx),  // 全局 wx
//     }),
//     model: "gpt-4o-mini",
//     tools: [/* 小程序自定义工具 */],
//   });
//
// 时序契约:enableChunked 模式下事件顺序为
//   onHeadersReceived(status+headers) → onChunkReceived(ArrayBuffer)×N → success
// 我们在 onHeadersReceived 时 resolve(此时 status/headers 已可用),body 通过
// onChunkReceived 推队列、success 收尾;fail(含 abort)→ reject 或在 body 流上 throw。
//
// 参考:https://developers.weixin.qq.com/miniprogram/dev/api/network/request/RequestTask.onChunkReceived.html

import type { HttpTransport, HttpTransportResponse } from "@lingjing-agent/core";

/** 微信小程序最小网络类型(只覆盖本适配器用到的部分;真实工程一般用 miniprogram-api-typings,结构兼容)。 */
export interface WxRequestTaskLike {
  abort(): void;
  onChunkReceived(listener: (res: { data: ArrayBuffer }) => void): void;
  onHeadersReceived(listener: (res: { header: Record<string, string>; statusCode: number }) => void): void;
}
export interface WxRequestOptionsLike {
  url: string;
  method?: string;
  header?: Record<string, string>;
  data?: string | ArrayBuffer;
  enableChunked?: boolean;
  success?: (res: { statusCode: number; header: Record<string, string>; data: string | ArrayBuffer }) => void;
  fail?: (err: { errMsg: string }) => void;
}
export interface WxLike {
  request(options: WxRequestOptionsLike): WxRequestTaskLike;
}

/**
 * Create an `HttpTransport` backed by WeChat mini-program `wx.request`.
 * Pass the global `wx` (or a mock in tests). Streaming (SSE) works via `enableChunked`.
 */
export function createWxTransport(wx: WxLike): HttpTransport {
  return (req) =>
    new Promise<HttpTransportResponse>((resolve, reject) => {
      const queue: Uint8Array[] = [];
      let notify: (() => void) | null = null;
      let done = false;
      let failed: Error | null = null;
      let resolved = false;
      const headers: Record<string, string> = {};

      // body: pull from `queue`; wait on `notify` when empty; throw `failed`; end on `done`.
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              while (true) {
                const chunk = queue.shift();
                if (chunk) return { value: chunk, done: false };
                if (failed) throw failed;
                if (done) return { done: true, value: undefined };
                await new Promise<void>((r) => {
                  notify = r;
                });
              }
            },
            return(): Promise<IteratorResult<Uint8Array>> {
              // Consumer broke out early (break/throw) — cancel the underlying request.
              cleanup();
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };

      const finishResolve = (status: number, hdr: Record<string, string>): void => {
        if (resolved) return;
        resolved = true;
        for (const [k, v] of Object.entries(hdr)) headers[k.toLowerCase()] = v;
        resolve({ status, statusText: statusTextFor(status), headers, body });
      };

      const onAbort = (): void => {
        failed = Object.assign(new Error("aborted"), { name: "AbortError" });
        task.abort(); // triggers wx fail → handler below classifies as AbortError
      };
      const cleanup = (): void => {
        req.signal.removeEventListener("abort", onAbort);
      };

      const task = wx.request({
        url: req.url,
        method: req.method,
        header: req.headers,
        ...(req.body !== undefined ? { data: req.body } : {}),
        enableChunked: true,
        success: (res) => {
          // Non-streaming fallback: if no chunks arrived, treat success.data as one chunk.
          if (queue.length === 0 && res.data != null && res.data !== "") {
            queue.push(toBytes(res.data));
          }
          done = true;
          finishResolve(res.statusCode ?? 200, res.header ?? {});
          notify?.();
        },
        fail: (err) => {
          failed = req.signal.aborted
            ? Object.assign(new Error("aborted"), { name: "AbortError" })
            : new Error(err?.errMsg ?? "wx.request failed");
          if (!resolved) {
            cleanup();
            reject(failed);
            return;
          }
          notify?.(); // already resolved: surface `failed` on the body stream
        },
      });

      task.onHeadersReceived((res) => {
        // Headers arrive before chunks — resolve now so status/headers are visible.
        finishResolve(res.statusCode ?? 200, res.header ?? {});
      });
      task.onChunkReceived((res) => {
        queue.push(new Uint8Array(res.data));
        notify?.();
      });

      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
}

function toBytes(data: string | ArrayBuffer): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function statusTextFor(status: number): string {
  const map: Record<number, string> = {
    200: "OK",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    409: "Conflict",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return map[status] ?? "";
}

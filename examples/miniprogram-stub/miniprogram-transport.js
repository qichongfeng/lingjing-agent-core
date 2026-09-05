// miniprogram-transport.js — wx.request → core HttpTransport 适配器(小程序可直接 require)。
//
// 派生自 examples/miniprogram-transport.ts(带类型 + 自验证 self-test 的源)。
// 改逻辑请改 .ts 源并重新派生本文件,保持两者同步。
//
// 时序契约(enableChunked 模式):
//   onHeadersReceived(status+headers) → onChunkReceived(ArrayBuffer)×N → success
// 在 onHeadersReceived 时 resolve(status/headers 可用);body 用队列+notify 桥接成
// AsyncIterable;fail(含 abort)→ reject 或在 body 流上 throw AbortError。

function createWxTransport(wx) {
  return function transport(req) {
    return new Promise(function (resolve, reject) {
      const queue = [];
      let notify = null;
      let done = false;
      let failed = null;
      let resolved = false;
      const headers = {};

      // body: pull from queue; wait on notify when empty; throw failed; end on done.
      const body = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              while (true) {
                const chunk = queue.shift();
                if (chunk) return { value: chunk, done: false };
                if (failed) throw failed;
                if (done) return { done: true, value: undefined };
                await new Promise(function (r) {
                  notify = r;
                });
              }
            },
            return() {
              cleanup(); // consumer broke early — cancel underlying request
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };

      function finishResolve(status, hdr) {
        if (resolved) return;
        resolved = true;
        for (const k in hdr) headers[k.toLowerCase()] = hdr[k];
        resolve({ status: status, statusText: statusTextFor(status), headers: headers, body: body });
      }

      function onAbort() {
        failed = Object.assign(new Error("aborted"), { name: "AbortError" });
        task.abort(); // triggers wx fail → handler classifies as AbortError
      }
      function cleanup() {
        req.signal.removeEventListener("abort", onAbort);
      }

      const task = wx.request({
        url: req.url,
        method: req.method,
        header: req.headers,
        ...(req.body !== undefined ? { data: req.body } : {}),
        enableChunked: true,
        success: function (res) {
          // Non-streaming fallback: if no chunks arrived, treat success.data as one chunk.
          if (queue.length === 0 && res.data != null && res.data !== "") {
            queue.push(toBytes(res.data));
          }
          done = true;
          finishResolve(res.statusCode != null ? res.statusCode : 200, res.header || {});
          if (notify) notify();
        },
        fail: function (err) {
          failed = req.signal.aborted
            ? Object.assign(new Error("aborted"), { name: "AbortError" })
            : new Error((err && err.errMsg) || "wx.request failed");
          if (!resolved) {
            cleanup();
            reject(failed);
            return;
          }
          if (notify) notify(); // already resolved: surface failed on the body stream
        },
      });

      task.onHeadersReceived(function (res) {
        finishResolve(res.statusCode != null ? res.statusCode : 200, res.header || {});
      });
      task.onChunkReceived(function (res) {
        queue.push(new Uint8Array(res.data));
        if (notify) notify();
      });

      if (req.signal.aborted) {
        onAbort();
      } else {
        req.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  };
}

function toBytes(data) {
  return typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
}

function statusTextFor(status) {
  const map = {
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
  return map[status] || "";
}

module.exports = { createWxTransport: createWxTransport };

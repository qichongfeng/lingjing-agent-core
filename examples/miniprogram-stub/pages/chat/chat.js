// pages/chat/chat.js — 聊天页:消费 agent.stream 事件流,流式渲染 + 取消。
const app = getApp();

Page({
  data: {
    messages: [], // [{ role: "user"|"assistant", text }]
    input: "",
    sending: false,
    scrollTo: "",
  },

  _handle: null, // 当前 turn 的 StreamHandle({ events, abort, done })

  onUnload() {
    // 离开页面必取消进行中的 turn,否则 loop 继续 / wx.request 继续发。
    if (this._handle) {
      this._handle.abort();
      this._handle = null;
    }
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  async send() {
    const text = (this.data.input || "").trim();
    if (!text || this.data.sending) return;

    const assistantIdx = this.data.messages.length + 1; // user 在 length,assistant 在 length+1
    const messages = this.data.messages.concat([
      { role: "user", text },
      { role: "assistant", text: "" },
    ]);
    this.setData({
      messages,
      input: "",
      sending: true,
      scrollTo: "msg-" + assistantIdx,
    });

    this._handle = app.agent.stream(text, { conversationId: "chat" });
    let assistantText = "";
    const patch = () =>
      this.setData({ ["messages[" + assistantIdx + "].text"]: assistantText });

    try {
      for await (const ev of this._handle.events) {
        if (ev.type === "text_delta") {
          assistantText += ev.text;
          patch();
        } else if (ev.type === "tool_call") {
          assistantText += `\n[调用工具 ${ev.name}]`;
          patch();
        } else if (ev.type === "error") {
          assistantText += `\n[错误: ${ev.message}]`;
          patch();
        }
        // turn_end / done / tool_result 等可按需处理
      }
      await this._handle.done;
    } catch (e) {
      // handle.abort() 会触发 AbortError —— 这是正常取消,不显示为错误
      if (!e || e.name !== "AbortError") {
        assistantText += `\n[异常: ${(e && e.message) || String(e)}]`;
        patch();
      }
    } finally {
      this._handle = null;
      this.setData({ sending: false });
    }
  },

  stop() {
    if (this._handle) this._handle.abort();
  },
});

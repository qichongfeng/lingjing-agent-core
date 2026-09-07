// media-store — 图片/语音历史的两种持久化策略参考。
//
// 问题:Message 里的 ImageContent 是 base64(大),直接存 memory 会膨胀(每轮 load
// 全拉)。语音同理。标准做法:原始媒体存对象存储,memory 只存文字 + 引用。
//
// 本文件给两个 MemoryStore 实现(都经对象存储,只区别在 load 时还不还原 base64):
//   1. StripMediaStore  — append 把 image base64 上传对象存储 → 换成文字引用;
//                         load 返回文字+引用(模型靠文字,不重放历史图)。多数场景够用。
//   2. RestoreMediaStore — append 同上(strip);load 时把引用还原成 image base64
//                         (从对象存储 download)→ 模型仍能看历史图(多轮针对同一图讨论)。
//
// 跑(Node,无网络,验证 store 行为):
//   pnpm --filter @lingjing-agent/example-demo demo:media-store

import { InMemoryStore, type MemoryStore, type Message } from "@lingjing-agent/core";
import type { Content } from "@lingjing-agent/core";

// ---------------------------------------------------------------------------
// StorageAdapter —— 把 base64 媒体存到/取自对象存储(小程序云存储 / OSS / S3 / mock)。
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  /** Upload a base64 media blob; return a reference (URL / fileId). */
  upload(base64: string, mediaType: string): Promise<string>;
  /** Download a previously uploaded reference back to { base64, mediaType }. */
  download(ref: string): Promise<{ data: string; mediaType: string }>;
}

/** Node in-memory mock — demo 用(真实场景换云存储 adapter)。 */
export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, { data: string; mediaType: string }>();
  private n = 0;
  async upload(data: string, mediaType: string): Promise<string> {
    const ref = `mem://${++this.n}`;
    this.map.set(ref, { data, mediaType });
    return ref;
  }
  async download(ref: string): Promise<{ data: string; mediaType: string }> {
    const v = this.map.get(ref);
    if (!v) throw new Error(`media not found: ${ref}`);
    return v;
  }
}

/*
// 小程序云存储 adapter(复制到小程序工程用)
import type { StorageAdapter } from "./media-store";
export class WxCloudStorage implements StorageAdapter {
  async upload(base64: string, mediaType: string): Promise<string> {
    const ext = mediaType.split("/")[1] ?? "png";
    const filePath = `${wx.env.USER_DATA_PATH}/upload_${Date.now()}.${ext}`;
    // base64 → ArrayBuffer → 写临时文件
    const buf = wx.base64ToArrayBuffer(base64);
    const fsm = wx.getFileSystemManager();
    fsm.writeFileSync(filePath, buf.buffer);
    return new Promise((resolve, reject) =>
      wx.cloud.uploadFile({
        cloudPath: `media/${Date.now()}.${ext}`,
        filePath,
        success: (r) => resolve(r.fileID),
        fail: reject,
      }),
    );
  }
  async download(ref: string): Promise<{ data: string; mediaType: string }> {
    return new Promise((resolve, reject) =>
      wx.cloud.downloadFile({
        fileID: ref,
        success: (r) => {
          const fsm = wx.getFileSystemManager();
          fsm.readFile({
            filePath: r.tempFilePath,
            encoding: "base64",
            success: (rr) => resolve({ data: rr.data as string, mediaType: guessMediaType(ref) }),
            fail: reject,
          });
        },
        fail: reject,
      }),
    );
  }
}
function guessMediaType(ref: string): string {
  const ext = ref.split(".").pop() ?? "png";
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
}
*/

// ---------------------------------------------------------------------------
// 共享:strip image base64 → 文字引用(append 时用)
// ---------------------------------------------------------------------------

const IMG_REF_RE = /^\[图片: (.+)\]$/;

/** image block → 上传 → 文字 `[图片: <ref>]`;其他 block 原样。 */
async function stripImages(m: Message, storage: StorageAdapter): Promise<Message> {
  if (typeof m.content === "string") return m;
  const out: Content[] = [];
  for (const b of m.content) {
    if (b.type === "image") {
      const ref = await storage.upload(b.data, b.mediaType);
      out.push({ type: "text", text: `[图片: ${ref}]` });
    } else {
      out.push(b);
    }
  }
  return { ...m, content: out };
}

/** 文字 `[图片: <ref>]` → download → image block(restore 时用)。 */
async function restoreImages(m: Message, storage: StorageAdapter): Promise<Message> {
  if (typeof m.content === "string") return m;
  const out: Content[] = [];
  for (const b of m.content) {
    if (b.type === "text") {
      const match = IMG_REF_RE.exec(b.text);
      if (match) {
        const ref = match[1] ?? "";
        const { data, mediaType } = await storage.download(ref);
        out.push({ type: "image", mediaType, data });
      } else {
        out.push(b);
      }
    } else {
      out.push(b);
    }
  }
  return { ...m, content: out };
}

// ---------------------------------------------------------------------------
// 策略 1:StripMediaStore —— load 返回文字+引用(模型靠文字,不重放历史图)
// ---------------------------------------------------------------------------

export class StripMediaStore implements MemoryStore {
  private inner = new InMemoryStore();
  private readonly storage: StorageAdapter;
  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }
  async load(id: string): Promise<Message[]> {
    return this.inner.load(id); // 已是文字+引用,无 base64
  }
  async append(id: string, msgs: Message[]): Promise<void> {
    const stripped = await Promise.all(msgs.map((m) => stripImages(m, this.storage)));
    await this.inner.append(id, stripped);
  }
  async recall(): Promise<[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 策略 2:RestoreMediaStore —— append strip;load 还原 image(模型能看历史图)
// ---------------------------------------------------------------------------

export class RestoreMediaStore implements MemoryStore {
  private inner = new InMemoryStore();
  private readonly storage: StorageAdapter;
  constructor(storage: StorageAdapter) {
    this.storage = storage;
  }
  async load(id: string): Promise<Message[]> {
    const stored = await this.inner.load(id);
    return Promise.all(stored.map((m) => restoreImages(m, this.storage)));
  }
  async append(id: string, msgs: Message[]): Promise<void> {
    const stripped = await Promise.all(msgs.map((m) => stripImages(m, this.storage)));
    await this.inner.append(id, stripped);
  }
  async recall(): Promise<[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// demo
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const storage = new MemoryStorage();
  const strip = new StripMediaStore(storage);
  const restore = new RestoreMediaStore(storage);

  const imgMsg: Message = {
    id: "m1",
    role: "user",
    createdAt: 0,
    content: [
      { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }, // 假 base64(PNG 头片段)
      { type: "text", text: "这是什么?" },
    ],
  };

  console.log("原始消息 content:", JSON.stringify(imgMsg.content));
  console.log("(含 image base64)\n");

  // 策略 1:Strip
  await strip.append("c1", [imgMsg]);
  const afterStrip = await strip.load("c1");
  console.log("【StripMediaStore】load 结果:");
  console.log(JSON.stringify(afterStrip[0]?.content));
  console.log("→ image 被换成 [图片: mem://1],无 base64(模型靠文字;memory 小)\n");

  // 策略 2:Restore
  await restore.append("c2", [imgMsg]);
  const afterRestore = await restore.load("c2");
  console.log("【RestoreMediaStore】load 结果:");
  console.log(JSON.stringify(afterRestore[0]?.content));
  console.log("→ 引用还原成 image base64(模型能看历史图;memory 仍只存引用)");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

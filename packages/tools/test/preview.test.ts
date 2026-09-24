// preview tool tests — all in plain node (the family way): the DOM never
// runs here. Instead:
// - scriptedFrame(): a fake PreviewFrame recording posts, letting tests emit
//   driver replies by hand (parent-side logic);
// - loopbackFrame(): runs the REAL previewDriver against a minimal fake DOM,
//   so parent ↔ driver speak the true protocol (integration);
// - assemblePreviewDocument/previewDriver are imported from src modules, not
//   the package index — a deliberate, narrow deviation to keep the public
//   API clean (same spirit as the deleted game_run `launch` test hook).

import { describe, expect, test, vi } from "vitest";
import type { ToolCallContext } from "@lingjing-agent/core";
import { createPreviewTool } from "../src/index.js";
import { assemblePreviewDocument } from "../src/preview.js";
import type { PreviewFrameFactory, PreviewFrameInit, PreviewToolOptions } from "../src/preview.js";
import { previewDriver } from "../src/preview-driver.js";
import type { PreviewDriverEvent, PreviewDriverGlobal } from "../src/preview-driver.js";
import { testCtx } from "./helpers.js";

// ---------------------------------------------------------------------------
// minimal fake DOM — exactly the PreviewDriverGlobal shape, nothing more
// ---------------------------------------------------------------------------

type Listener = (e: PreviewDriverEvent) => void;

class FakeEventTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, cb: Listener): void {
    let s = this.listeners.get(type);
    if (s === undefined) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(cb);
  }
  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }
  fire(type: string, e: unknown): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) cb(e as PreviewDriverEvent);
  }
}

class FakeEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  /** init props merged in the constructor (clientX, key, code, …) */
  [prop: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    Object.assign(this, init);
  }
}
class FakeMouseEvent extends FakeEvent {}
class FakePointerEvent extends FakeEvent {}
class FakeKeyboardEvent extends FakeEvent {}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

class FakeElement extends FakeEventTarget {
  tagName: string;
  textContent = "";
  innerHTML = "";
  attrs = new Map<string, string>();
  value?: string;
  width?: number;
  height?: number;
  selectors: string[] = [];
  rect?: Rect;
  /** simplified bubbling: element → (these targets, in order) */
  bubbleTo: FakeEventTarget[] = [];
  dispatched: { type: string; event: FakeEvent }[] = [];
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  dispatchEvent(e: object): boolean {
    const ev = e as FakeEvent;
    this.dispatched.push({ type: ev.type, event: ev });
    this.fire(ev.type, ev);
    for (const t of this.bubbleTo) t.fire(ev.type, ev);
    return true;
  }
}

class FakeCanvas extends FakeElement {
  contexts: { type: string; attrs?: Record<string, unknown> | undefined }[] = [];
  pngHuge = false;
  taint = false;
  constructor(width: number, height: number) {
    super("canvas");
    this.width = width;
    this.height = height;
  }
  getContext(type: string, attrs?: Record<string, unknown>): unknown {
    this.contexts.push({ type, attrs });
    return { canvas: this };
  }
  toDataURL(format = "image/png", _quality?: number): string {
    if (this.taint) {
      const err = new Error("The operation is insecure.");
      err.name = "SecurityError";
      throw err;
    }
    if (this.pngHuge && format === "image/png") {
      return "data:image/png;base64," + "A".repeat(4_100_000);
    }
    return `data:${format};base64,${"QUJDREVGRw==".repeat(4)}`;
  }
}

class FakeDocument extends FakeEventTarget {
  readyState = "loading";
  elements: FakeElement[] = [];
  activeElement: FakeElement | null = null;
  body: FakeElement;
  constructor() {
    super();
    this.body = new FakeElement("body");
    this.body.bubbleTo = [this];
  }
  fireDomContentLoaded(): void {
    this.readyState = "interactive";
    this.fire("DOMContentLoaded", {});
  }
  querySelectorAll(css: string): FakeElement[] {
    if (css === "[[") throw new Error("invalid selector");
    return this.elements.filter((e) => e.selectors.includes(css));
  }
  elementFromPoint(x: number, y: number): FakeElement | null {
    for (const e of this.elements) {
      const r = e.rect;
      if (r !== undefined && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return e;
    }
    return null;
  }
}

class FakeWindow extends FakeEventTarget {
  document: FakeDocument;
  parent: { postMessage(msg: unknown, targetOrigin: string): void };
  console: { log: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
  sent: Record<string, unknown>[] = [];
  consoleCalls: { level: string; args: unknown[] }[] = [];
  scrollByCalls: { dx: number; dy: number }[] = [];
  Event = FakeEvent;
  MouseEvent = FakeMouseEvent;
  PointerEvent = FakePointerEvent;
  KeyboardEvent = FakeKeyboardEvent;
  /** the REAL prototype object — the driver's getContext patch must land where
   *  instances actually look it up (exactly like a real browser) */
  HTMLCanvasElement = { prototype: FakeCanvas.prototype };
  constructor(doc: FakeDocument) {
    super();
    this.document = doc;
    this.parent = {
      postMessage: (msg: unknown) => {
        this.sent.push(msg as Record<string, unknown>);
      },
    };
    const record =
      (level: string) =>
      (...args: unknown[]): void => {
        this.consoleCalls.push({ level, args });
      };
    this.console = { log: record("log"), warn: record("warn"), error: record("error"), info: record("info") };
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return setTimeout(fn, ms);
  }
  scrollBy(dx: number, dy: number): void {
    this.scrollByCalls.push({ dx, dy });
  }
  deliver(data: unknown): void {
    this.fire("message", { data });
  }
}

const mkWin = (doc = new FakeDocument()): FakeWindow => new FakeWindow(doc);

// ---------------------------------------------------------------------------
// harnesses
// ---------------------------------------------------------------------------

function tokenOf(srcdoc: string): string {
  const m = /\(window,\s*("(?:[^"\\]|\\.)*")\)/.exec(srcdoc);
  if (m === null) throw new Error("no token found in srcdoc");
  return JSON.parse(m[1] as string) as string;
}

function scriptedFrame(): {
  factory: PreviewFrameFactory;
  inits: PreviewFrameInit[];
  posted: Record<string, unknown>[];
  emit: (msg: unknown) => void;
  destroyedCount: () => number;
  /** Mark every frame dead — simulates the host unmounting the panel */
  kill: () => void;
} {
  const inits: PreviewFrameInit[] = [];
  const posted: Record<string, unknown>[] = [];
  const subs = new Set<(msg: unknown) => void>();
  let destroyed = 0;
  let dead = false;
  return {
    factory: (init) => {
      inits.push(init);
      return {
        post: (m) => {
          posted.push(m as Record<string, unknown>);
        },
        onMessage(cb) {
          subs.add(cb);
          return () => {
            subs.delete(cb);
          };
        },
        alive: () => !dead,
        destroy: () => {
          destroyed += 1;
          subs.clear();
        },
      };
    },
    inits,
    posted,
    emit: (msg) => {
      for (const cb of [...subs]) cb(msg);
    },
    destroyedCount: () => destroyed,
    kill: () => {
      dead = true;
    },
  };
}

/** The real driver against a fake DOM — parent↔driver true protocol. */
function loopbackFrame(win: FakeWindow, autoReady = true): PreviewFrameFactory {
  return (init) => {
    const token = tokenOf(init.srcdoc);
    previewDriver(win, token);
    const subs = new Set<(msg: unknown) => void>();
    // driver → parent now pumps into the frame's subscribers too
    win.parent.postMessage = (msg: unknown) => {
      win.sent.push(msg as Record<string, unknown>);
      for (const cb of [...subs]) cb(msg);
    };
    if (autoReady && win.document.readyState === "loading") {
      setTimeout(() => win.document.fireDomContentLoaded(), 0);
    }
    return {
      post: (m) => {
        win.deliver(m);
      },
      onMessage(cb) {
        subs.add(cb);
        return () => {
          subs.delete(cb);
        };
      },
      destroy: () => {
        subs.clear();
      },
    };
  };
}

const GAME_HTML =
  "<!doctype html><html><head><title>S</title></head><body><canvas id='c'></canvas></body></html>";

function mkTool(over: Partial<PreviewToolOptions> = {}): {
  tool: ReturnType<typeof createPreviewTool>;
  frame: ReturnType<typeof scriptedFrame>;
  files: Record<string, string>;
} {
  const files: Record<string, string> = { "g.html": GAME_HTML };
  const frame = scriptedFrame();
  const tool = createPreviewTool({
    fs: { readFile: (p) => Promise.resolve(files[p] ?? ""), async writeFile() {} },
    frameFactory: frame.factory,
    ...over,
  });
  return { tool, frame, files };
}

async function openSession(
  tool: ReturnType<typeof createPreviewTool>,
  frame: ReturnType<typeof scriptedFrame>,
  ctx: ToolCallContext,
  path = "g.html",
): Promise<void> {
  const before = frame.inits.length;
  const p = tool.execute({ op: "open", path }, ctx);
  await vi.waitFor(() => expect(frame.inits.length).toBe(before + 1));
  frame.emit({ __preview: tokenOf(frame.inits[before]!.srcdoc), t: "ready" });
  const r = await p;
  expect(r.isError).toBeFalsy();
}

/** Result text whether the tool returned a plain string or [text, image]. */
const textOf = (r: { content: string | { type: string; text?: string }[] }): string =>
  typeof r.content === "string"
    ? r.content
    : r.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");

const replyTo = (
  frame: ReturnType<typeof scriptedFrame>,
  initIdx: number,
  id: number,
  body: Record<string, unknown>,
): void => {
  frame.emit({ __preview: tokenOf(frame.inits[initIdx]!.srcdoc), id, ...body });
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// srcdoc assembly
// ---------------------------------------------------------------------------

describe("assemblePreviewDocument", () => {
  test("inserts charset, CSP, and driver at head start — artifact HTML follows", () => {
    const out = assemblePreviewDocument("<html><head><title>T</title></head><body></body></html>", "tok");
    const headEnd = out.indexOf("<title>");
    expect(out.slice(0, headEnd)).toContain('<meta charset="utf-8">');
    expect(out.slice(0, headEnd)).toContain('http-equiv="Content-Security-Policy"');
    expect(out.slice(0, headEnd)).toContain("previewDriver");
    expect(out.indexOf("previewDriver")).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain("<title>T</title>");
  });

  test("falls back to after-<html>, then plain prepend, for fragments", () => {
    const afterHtml = assemblePreviewDocument("<html><body>x</body></html>", "tok");
    expect(afterHtml.indexOf("previewDriver")).toBeGreaterThan(afterHtml.indexOf("<html"));
    expect(afterHtml.indexOf("previewDriver")).toBeLessThan(afterHtml.indexOf("<body"));
    const frag = assemblePreviewDocument("<div>hi</div>", "tok");
    expect(frag.startsWith('<meta charset="utf-8">')).toBe(true);
    expect(frag).toContain("<div>hi</div>");
  });

  test("CSP allows only inline script/style + data/blob assets and blocks connect/base", () => {
    const out = assemblePreviewDocument("<head></head>", "tok");
    expect(out).toContain("script-src 'unsafe-inline' 'unsafe-eval'");
    expect(out).toContain("img-src data: blob:");
    expect(out).toContain("connect-src 'none'");
    expect(out).toContain("base-uri 'none'");
    expect(out).toContain("form-action 'none'");
  });

  test("embeds the token exactly once (invocation argument)", () => {
    const out = assemblePreviewDocument("<head></head>", "tok-123");
    const m = /\(window,\s*("(?:[^"\\]|\\.)*")\)/g;
    const matches = [...out.matchAll(m)];
    expect(matches).toHaveLength(1);
    expect(JSON.parse(matches[0]![1] as string)).toBe("tok-123");
  });

  test("driver source survives embedding intact (new Function parse check)", () => {
    expect(() => new Function("return (" + previewDriver.toString() + ")")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// driver (real previewDriver against the fake DOM)
// ---------------------------------------------------------------------------

describe("previewDriver", () => {
  const request = (win: FakeWindow, token: string, msg: Record<string, unknown>): void => {
    win.deliver({ __preview: token, ...msg });
  };
  const waitForSent = async (win: FakeWindow, pred: (m: Record<string, unknown>) => boolean) => {
    await vi.waitFor(() => {
      expect(win.sent.some(pred)).toBe(true);
    });
    return win.sent.find(pred)!;
  };

  test("patches console and forwards logs with consecutive-duplicate collapse and line cap", async () => {
    const win = mkWin();
    previewDriver(win, "t");
    win.console.log("tick");
    win.console.log("tick");
    win.console.log("tick");
    win.console.log("x".repeat(5_000));
    request(win, "t", { id: 1, op: "eval", code: "return 1" });
    const reply = await waitForSent(win, (m) => m.id === 1 && m.ok === true);
    const logs = win.sent.filter((m) => m.t === "log");
    expect(logs.map((l) => [l.text, l.n, l.level])).toEqual([
      ["tick", 3, "log"],
      ["x".repeat(2_000) + "…[truncated]", 1, "log"],
    ]);
    // flush-before-reply: logs precede the reply in the send order
    expect(win.sent.indexOf(logs[0]!)).toBeLessThan(win.sent.indexOf(reply));
    // the wrapped console still calls through
    expect(win.consoleCalls.map((c) => c.level)).toEqual(["log", "log", "log", "log"]);
  });

  test("captures window error and unhandledrejection as level:error", async () => {
    const win = mkWin();
    previewDriver(win, "t");
    win.fire("error", { message: "boom", filename: "app.js", lineno: 3 });
    win.fire("unhandledrejection", { reason: new Error("rj") });
    await vi.waitFor(() => expect(win.sent.filter((m) => m.t === "log").length).toBe(2));
    const texts = win.sent.filter((m) => m.t === "log").map((l) => [l.level, l.text]);
    expect(texts).toContainEqual(["error", "boom (app.js:3)"]);
    expect(texts).toContainEqual(["error", "unhandled rejection: Error: rj"]);
  });

  test("sends ready on DOMContentLoaded (and immediately when already loaded)", () => {
    const win = mkWin();
    previewDriver(win, "t");
    expect(win.sent.filter((m) => m.t === "ready")).toHaveLength(0);
    win.document.fireDomContentLoaded();
    expect(win.sent.filter((m) => m.t === "ready")).toHaveLength(1);

    const doc2 = new FakeDocument();
    doc2.readyState = "complete";
    const win2 = mkWin(doc2);
    previewDriver(win2, "t");
    expect(win2.sent.filter((m) => m.t === "ready")).toHaveLength(1);
  });

  test("click dispatches pointerdown/mousedown/pointerup/mouseup/click with coordinates", async () => {
    const doc = new FakeDocument();
    const btn = new FakeElement("button");
    btn.selectors = ["#btn"];
    btn.rect = { x: 0, y: 0, w: 100, h: 100 };
    doc.elements.push(btn);
    const win = mkWin(doc);
    previewDriver(win, "t");
    request(win, "t", { id: 1, op: "act", actions: [{ type: "click", x: 50, y: 60 }] });
    await waitForSent(win, (m) => m.id === 1 && m.ok === true);
    expect(btn.dispatched.map((d) => d.type)).toEqual([
      "pointerdown", "mousedown", "pointerup", "mouseup", "click",
    ]);
    const pd = btn.dispatched[0]!.event;
    expect(pd.clientX).toBe(50);
    expect(pd.clientY).toBe(60);
    expect(pd.pointerId).toBe(1);
    expect(pd.pointerType).toBe("mouse");
    expect(pd.isPrimary).toBe(true);
    expect(btn.dispatched[4]!.event.bubbles).toBe(true);
  });

  test("key dispatches keydown+keyup with key and derived code, bubbling to window", async () => {
    const doc = new FakeDocument();
    const input = new FakeElement("input");
    const win = mkWin(doc);
    input.bubbleTo = [doc, win]; // simplified bubbling: element → document → window
    doc.activeElement = input;
    const seen: unknown[] = [];
    win.addEventListener("keydown", (e) => {
      seen.push((e as FakeEvent).code);
    });
    previewDriver(win, "t");
    request(win, "t", { id: 1, op: "act", actions: [{ type: "key", key: "a" }] });
    await waitForSent(win, (m) => m.id === 1 && m.ok === true);
    expect(input.dispatched.map((d) => d.type)).toEqual(["keydown", "keyup"]);
    expect(input.dispatched[0]!.event.key).toBe("a");
    expect(input.dispatched[0]!.event.code).toBe("KeyA");
    expect(seen).toEqual(["KeyA"]); // bubbled to window listeners
  });

  test("type appends to the focused input's value and fires input+change; errors when nothing focusable", async () => {
    const doc = new FakeDocument();
    const input = new FakeElement("input");
    input.value = "ab";
    doc.activeElement = input;
    const win = mkWin(doc);
    previewDriver(win, "t");
    request(win, "t", { id: 1, op: "act", actions: [{ type: "type", text: "cd" }] });
    await waitForSent(win, (m) => m.id === 1 && m.ok === true);
    expect(input.value).toBe("abcd");
    expect(input.dispatched.map((d) => d.type)).toEqual(["input", "change"]);

    const win2 = mkWin();
    previewDriver(win2, "t");
    request(win2, "t", { id: 2, op: "act", actions: [{ type: "type", text: "x" }] });
    const reply = await waitForSent(win2, (m) => m.id === 2);
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("no focused <input>/<textarea>");
  });

  test("wait replies after the requested delay; scroll calls scrollBy", async () => {
    const win = mkWin();
    previewDriver(win, "t");
    const t0 = Date.now();
    request(win, "t", { id: 1, op: "act", actions: [{ type: "scroll", dy: 200 }, { type: "wait", ms: 30 }] });
    await waitForSent(win, (m) => m.id === 1 && m.ok === true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(win.scrollByCalls).toEqual([{ dx: 0, dy: 200 }]);
  });

  test("read returns first-match value + match count, null on no match, per-query error on a bad selector", async () => {
    const doc = new FakeDocument();
    const score = new FakeElement("span");
    score.selectors = ["#score"];
    score.textContent = "12";
    const row = new FakeElement("div");
    row.selectors = [".row"];
    row.innerHTML = "<p>x</p>";
    doc.elements.push(score, row);
    const win = mkWin(doc);
    previewDriver(win, "t");
    request(win, "t", {
      id: 1,
      op: "read",
      queries: [{ css: "#score" }, { css: ".row", attr: "html" }, { css: "#missing" }, { css: "[[" }],
    });
    const reply = await waitForSent(win, (m) => m.id === 1);
    expect(reply.ok).toBe(true);
    const results = (reply.value as { results: Record<string, unknown>[] }).results;
    expect(results[0]).toMatchObject({ css: "#score", attr: "text", value: "12", count: 1 });
    expect(results[1]).toMatchObject({ value: "<p>x</p>", count: 1 });
    expect(results[2]).toMatchObject({ value: null, count: 0 });
    expect(results[3]).toMatchObject({ error: "invalid selector" });
  });

  test("eval returns a JSON stringified result, error text on throw, caps oversized results", async () => {
    const win = mkWin();
    previewDriver(win, "t");
    request(win, "t", { id: 1, op: "eval", code: "return 1 + 1" });
    const r1 = await waitForSent(win, (m) => m.id === 1);
    expect((r1.value as { result: string }).result).toBe("2");

    request(win, "t", { id: 2, op: "eval", code: "return undefined" });
    const r2 = await waitForSent(win, (m) => m.id === 2);
    expect((r2.value as { result: string }).result).toBe("(undefined)");

    request(win, "t", { id: 3, op: "eval", code: "return 'x'.repeat(10_000)" });
    const r3 = await waitForSent(win, (m) => m.id === 3);
    expect((r3.value as { result: string }).result.endsWith("…[truncated]")).toBe(true);

    request(win, "t", { id: 4, op: "eval", code: "throw new Error('boom')" });
    const r4 = await waitForSent(win, (m) => m.id === 4);
    expect(r4.ok).toBe(false);
    expect(r4.error).toContain("boom");
  });

  test("shot picks the largest canvas and returns its dataUrl; errors when no canvas", async () => {
    const doc = new FakeDocument();
    const small = new FakeCanvas(300, 150);
    const big = new FakeCanvas(800, 600);
    small.selectors = big.selectors = ["canvas"];
    doc.elements.push(small, big);
    const win = mkWin(doc);
    previewDriver(win, "t");
    request(win, "t", { id: 1, op: "shot", format: "png" });
    const reply = await waitForSent(win, (m) => m.id === 1);
    expect(reply.ok).toBe(true);
    expect(reply.value).toMatchObject({ width: 800, height: 600, format: "png" });
    expect((reply.value as { dataUrl: string }).dataUrl).toMatch(/^data:image\/png;base64,/);

    const win2 = mkWin();
    previewDriver(win2, "t");
    request(win2, "t", { id: 2, op: "shot" });
    const r2 = await waitForSent(win2, (m) => m.id === 2);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("no <canvas>");
  });

  test("forces preserveDrawingBuffer on webgl context creation", () => {
    const doc = new FakeDocument();
    const canvas = new FakeCanvas(300, 150);
    canvas.selectors = ["canvas"];
    doc.elements.push(canvas);
    const win = mkWin(doc);
    previewDriver(win, "t");
    canvas.getContext("webgl", { antialias: false });
    canvas.getContext("2d");
    expect(canvas.contexts[0]).toMatchObject({ type: "webgl", attrs: { antialias: false, preserveDrawingBuffer: true } });
    expect(canvas.contexts[1]).toMatchObject({ type: "2d" });
  });

  test("ignores messages whose __preview token mismatches", async () => {
    const win = mkWin();
    previewDriver(win, "right");
    win.deliver({ __preview: "wrong", id: 1, op: "eval", code: "return 1" });
    await sleep(30);
    expect(win.sent).toHaveLength(0);
  });

  test("installs an in-memory localStorage shim when access throws", () => {
    const win = mkWin();
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("denied");
      },
      configurable: true,
    });
    previewDriver(win, "t");
    const ls = (win as unknown as { localStorage: Storage }).localStorage;
    expect(ls.getItem("k")).toBeNull();
    ls.setItem("k", "v");
    expect(ls.getItem("k")).toBe("v");
    expect(ls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// tool / parent side (scripted frame — no driver involved)
// ---------------------------------------------------------------------------

describe("createPreviewTool", () => {
  test("refuses in a runtime without document unless frameFactory is provided", async () => {
    const tool = createPreviewTool({ fs: { readFile: () => Promise.resolve(GAME_HTML), async writeFile() {} } });
    const r = await tool.execute({ op: "open", path: "g.html" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Refused: preview needs a browser-like runtime");
  });

  test("open reads via the injected source, waits for ready, returns status + session line", async () => {
    const { tool, frame } = mkTool();
    const r = await openSession(tool, frame, testCtx()).then(() =>
      // re-run capture-free open to inspect the result text
      openSession(tool, frame, testCtx()),
    );
    void r;
    const p = tool.execute({ op: "open", path: "g.html" }, testCtx());
    await vi.waitFor(() => expect(frame.inits.length).toBe(3));
    frame.emit({ __preview: tokenOf(frame.inits[2]!.srcdoc), t: "ready" });
    const out = await p;
    expect(out.isError).toBeFalsy();
    const text = typeof out.content === "string" ? out.content : "";
    expect(text).toContain("open: g.html");
    expect(text).toContain("session: g.html");
    expect(text).toContain("ready");
  });

  test("open always rebuilds — a same-path reopen destroys the previous frame", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    await openSession(tool, frame, ctx);
    expect(frame.inits).toHaveLength(2);
    expect(frame.destroyedCount()).toBe(1);
  });

  test("open wraps a .svg into a centered standalone page (wrapSvgDocument)", async () => {
    const { tool, frame, files } = mkTool();
    files["icon.svg"] = '<svg xmlns="http://www.w3.org/2000/svg" width="24"><circle r="9"/></svg>';
    const p = tool.execute({ op: "open", path: "icon.svg" }, testCtx());
    await vi.waitFor(() => expect(frame.inits.length).toBe(1));
    frame.emit({ __preview: tokenOf(frame.inits[0]!.srcdoc), t: "ready" });
    const out = await p;
    expect(out.isError).toBeFalsy();
    const doc = frame.inits[0]!.srcdoc;
    expect(doc).toContain("place-items:center"); // the wrapper's centered layout
    expect(doc).toContain('<circle r="9"/>'); // the svg markup rides along
  });

  test("open refuses content that does not look like HTML; source failure → Preview failed prefix", async () => {    const { tool, frame, files } = mkTool();
    files["x.txt"] = "just text, no markup";
    const r1 = await tool.execute({ op: "open", path: "x.txt" }, testCtx());
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain("did not look like HTML");
    expect(frame.inits).toHaveLength(0); // refused before any frame was built

    const tool2 = createPreviewTool({
      fs: { readFile: () => Promise.reject(new Error("gone")), async writeFile() {} },
      frameFactory: frame.factory,
    });
    const r2 = await tool2.execute({ op: "open", path: "g.html" }, testCtx());
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain("Preview failed: read('g.html'): gone");
  });

  test("act/read/eval/shot refuse with 'no preview session — open first'", async () => {
    const { tool } = mkTool();
    for (const input of [
      { op: "act", actions: [{ type: "key", key: "a" }] },
      { op: "read", queries: [{ css: "#a" }] },
      { op: "eval", code: "return 1" },
      { op: "shot" },
    ]) {
      const r = await tool.execute(input, testCtx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("no preview session — call preview open first");
    }
  });

  test("refuses a wait budget over the deadline with the actual numbers in the message", async () => {
    const { tool } = mkTool({ timeoutMs: 5_000 }); // budget = 5000 - 250 - 1500 = 3250
    const r = await tool.execute(
      { op: "act", actions: [{ type: "wait", ms: 4_000 }] },
      testCtx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Refused: total wait 4000ms exceeds this call's 3250ms budget");
    expect(r.content).toContain("tool timeout 5000ms");
  });

  test("act returns a per-action summary and the console drained since the last response", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    frame.emit({ __preview: tokenOf(frame.inits[0]!.srcdoc), t: "log", level: "log", text: "hi", n: 1 });

    const p = tool.execute({ op: "act", actions: [{ type: "key", key: "ArrowRight" }, { type: "wait", ms: 10 }] }, ctx);
    await vi.waitFor(() => expect(frame.posted.some((m) => m.op === "act")).toBe(true));
    const req = frame.posted.find((m) => m.op === "act")!;
    replyTo(frame, 0, req.id as number, { ok: true, value: { performed: 2 } });
    const r = await p;
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text).toContain("act: 2 actions");
    expect(text).toContain("2 performed");
    expect(text).toContain("console:");
    expect(text).toContain("[log] hi");

    // second act: cursor advanced, no stale console replay
    const p2 = tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    await vi.waitFor(() => expect(frame.posted.filter((m) => m.op === "act").length).toBe(2));
    const req2 = frame.posted.filter((m) => m.op === "act")[1]!;
    replyTo(frame, 0, req2.id as number, { ok: true, value: { performed: 1 } });
    const r2 = await p2;
    expect(textOf(r2)).not.toContain("[log] hi");
  });

  test("shot result carries a text part AND an ImageContent with the base64 stripped", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    const p = tool.execute({ op: "shot" }, ctx);
    await vi.waitFor(() => expect(frame.posted.some((m) => m.op === "shot")).toBe(true));
    const req = frame.posted.find((m) => m.op === "shot")!;
    replyTo(frame, 0, req.id as number, {
      ok: true,
      value: { dataUrl: "data:image/png;base64,QUJD", width: 800, height: 600, format: "png" },
    });
    const r = await p;
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.content)).toBe(true);
    const blocks = r.content as { type: string; text?: string; mediaType?: string; data?: string }[];
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toContain("800×600");
    expect(blocks[1]).toMatchObject({ type: "image", mediaType: "image/png", data: "QUJD" });
  });

  test("close destroys the frame, is idempotent, and a following act asks to open", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    const r1 = await tool.execute({ op: "close" }, ctx);
    expect(r1.content).toContain("closed");
    const r2 = await tool.execute({ op: "close" }, ctx);
    expect(r2.content).toContain("closed");
    expect(frame.destroyedCount()).toBe(1);
    const r3 = await tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    expect(r3.content).toContain("no preview session");
  });

  test("idle timeout tears the session down; the next act asks to open", async () => {
    // idleMs must exceed openSession's waitFor polling, else the timer fires
    // mid-open and takes the 1s in-flight deferral branch.
    const { tool, frame } = mkTool({ idleMs: 200 });
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    await sleep(500);
    expect(frame.destroyedCount()).toBe(1);
    const r = await tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    expect(r.content).toContain("no preview session");
  });

  test("stale replies (wrong token / unknown id / post-close) never resolve or corrupt a call", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    const p = tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    await vi.waitFor(() => expect(frame.posted.some((m) => m.op === "act")).toBe(true));
    const req = frame.posted.find((m) => m.op === "act")!;
    const token = tokenOf(frame.inits[0]!.srcdoc);
    frame.emit({ __preview: token, id: 999, ok: true, value: { performed: 0 } }); // unknown id
    frame.emit({ __preview: "other", id: req.id, ok: true, value: { performed: 0 } }); // wrong token
    replyTo(frame, 0, req.id as number, { ok: true, value: { performed: 1 } }); // the real one
    const r = await p;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("1 performed");
  });

  test("internal deadline produces a graceful error and the session survives", async () => {
    const { tool, frame } = mkTool({ timeoutMs: 800 }); // deadline at ~550ms
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    const r = await tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Preview failed:");
    expect(r.content).toContain("no reply");
    // session survived: a second act with a proper reply works
    const p2 = tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    await vi.waitFor(() => expect(frame.posted.filter((m) => m.op === "act").length).toBe(2));
    const req2 = frame.posted.filter((m) => m.op === "act")[1]!;
    replyTo(frame, 0, req2.id as number, { ok: true, value: { performed: 1 } });
    const r2 = await p2;
    expect(r2.isError).toBeFalsy();
  });

  test("abort mid-wait returns (aborted) and the session survives for the next call", async () => {
    const { tool, frame } = mkTool();
    const ac = new AbortController();
    const ctx = testCtx(ac.signal);
    await openSession(tool, frame, testCtx());
    setTimeout(() => ac.abort(), 30);
    const r = await tool.execute({ op: "act", actions: [{ type: "wait", ms: 5_000 }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toBe("(aborted)");
    // session survived
    const ctx2 = testCtx();
    const p2 = tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx2);
    await vi.waitFor(() => expect(frame.posted.filter((m) => m.op === "act").length).toBe(2));
    const req2 = frame.posted.filter((m) => m.op === "act")[1]!;
    replyTo(frame, 0, req2.id as number, { ok: true, value: { performed: 1 } });
    const r2 = await p2;
    expect(r2.isError).toBeFalsy();
  });

  test("FIFO evicts the oldest session at 8, destroying its frame", async () => {
    const { tool, frame } = mkTool();
    const ctxFor = (cid: string): ToolCallContext => ({
      signal: new AbortController().signal,
      toolCallId: "tc",
      conversationId: cid,
      runtime: "node",
      log: () => {},
    });
    for (let i = 1; i <= 8; i++) {
      await openSession(tool, frame, ctxFor(`c${i}`));
    }
    expect(frame.inits).toHaveLength(8);
    expect(frame.destroyedCount()).toBe(0);
    await openSession(tool, frame, ctxFor("c9"));
    expect(frame.inits).toHaveLength(9);
    expect(frame.destroyedCount()).toBe(1); // c1's frame gone
  });

  test("a spoofed game postMessage without the token never leaks into results", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    const p = tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    await vi.waitFor(() => expect(frame.posted.some((m) => m.op === "act")).toBe(true));
    const req = frame.posted.find((m) => m.op === "act")!;
    frame.emit({ t: "log", level: "error", text: "FAKE", n: 1 }); // no token at all
    frame.emit({ __preview: "spoofed", t: "log", level: "error", text: "FAKE2", n: 1 });
    replyTo(frame, 0, req.id as number, { ok: true, value: { performed: 1 } });
    const r = await p;
    expect(textOf(r)).not.toContain("FAKE");
  });

  test("two concurrent executes on one conversation serialize", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    const p1 = tool.execute({ op: "act", actions: [{ type: "key", key: "a" }] }, ctx);
    const p2 = tool.execute({ op: "act", actions: [{ type: "key", key: "b" }] }, ctx);
    await vi.waitFor(() => expect(frame.posted.filter((m) => m.op === "act").length).toBe(1));
    await sleep(20); // second still held back
    expect(frame.posted.filter((m) => m.op === "act")).toHaveLength(1);
    const req1 = frame.posted.find((m) => m.op === "act")!;
    replyTo(frame, 0, req1.id as number, { ok: true, value: { performed: 1 } });
    const r1 = await p1;
    expect(textOf(r1)).toContain("1 performed");
    await vi.waitFor(() => expect(frame.posted.filter((m) => m.op === "act").length).toBe(2));
    const req2 = frame.posted.filter((m) => m.op === "act")[1]!;
    replyTo(frame, 0, req2.id as number, { ok: true, value: { performed: 2 } });
    const r2 = await p2;
    expect(r2.content).toContain("2 performed");
  });

  test("session ops fail fast when the host unmounted the frame (alive=false)", async () => {
    const { tool, frame } = mkTool();
    const ctx = testCtx();
    await openSession(tool, frame, ctx);
    frame.kill(); // the host closed its panel — the iframe left the DOM
    const t0 = Date.now();
    const r = await tool.execute({ op: "read", queries: [{ css: "#c" }] }, ctx);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("preview open again");
    expect(Date.now() - t0).toBeLessThan(2000); // fast-fail, not the ~30s deadline
    expect(frame.destroyedCount()).toBe(1); // the dead session is torn down
    // and the model can recover: open rebuilds on a fresh (live) frame
    frame.inits.length = 0;
    await openSession(tool, frame, ctx);
  });

  test("open fails fast when the frame dies before signaling ready", async () => {
    const { tool, frame } = mkTool();
    frame.kill();
    const t0 = Date.now();
    const r = await tool.execute({ op: "open", path: "g.html" }, testCtx());
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("left the DOM");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(frame.destroyedCount()).toBe(1); // never-ready garbage is cleaned up
  });
});

// ---------------------------------------------------------------------------
// integration — the real driver over the loopback frame
// ---------------------------------------------------------------------------

describe("createPreviewTool + previewDriver (loopback)", () => {
  function gameWindow(): { win: FakeWindow; score: FakeElement; canvas: FakeCanvas } {
    const doc = new FakeDocument();
    const win = mkWin(doc);
    doc.body.bubbleTo = [doc, win];
    const start = new FakeElement("button");
    start.selectors = ["#start"];
    start.rect = { x: 0, y: 0, w: 100, h: 50 };
    const score = new FakeElement("span");
    score.selectors = ["#score"];
    score.textContent = "0";
    const canvas = new FakeCanvas(800, 600);
    canvas.selectors = ["canvas"];
    doc.elements.push(start, score, canvas);
    doc.activeElement = start;
    let n = 0;
    start.addEventListener("click", () => {
      n += 1;
      score.textContent = String(n);
      win.console.log("clicked");
    });
    return { win, score, canvas };
  }

  async function open(tool: ReturnType<typeof createPreviewTool>): Promise<void> {
    const r = await tool.execute({ op: "open", path: "g.html" }, testCtx());
    expect(r.isError).toBeFalsy();
  }

  test("open → act(click) → read(#score) → shot end-to-end over the loopback frame", async () => {
    const { win } = gameWindow();
    const tool = createPreviewTool({
      fs: { readFile: () => Promise.resolve(GAME_HTML), async writeFile() {} },
      frameFactory: loopbackFrame(win),
    });
    await open(tool);

    const rAct = await tool.execute(
      { op: "act", actions: [{ type: "click", x: 50, y: 25 }, { type: "key", key: "ArrowLeft" }] },
      testCtx(),
    );
    expect(rAct.isError).toBeFalsy();
    expect(textOf(rAct)).toContain("2 performed");
    expect(textOf(rAct)).toContain("[log] clicked"); // flushed before the reply

    const rRead = await tool.execute(
      { op: "read", queries: [{ css: "#score" }] },
      testCtx(),
    );
    expect(rRead.isError).toBeFalsy();
    expect(textOf(rRead)).toContain('"1"');
    expect(textOf(rRead)).toContain("[1 match]");

    const rShot = await tool.execute({ op: "shot" }, testCtx());
    expect(rShot.isError).toBeFalsy();
    const blocks = rShot.content as { type: string; text?: string; mediaType?: string }[];
    expect(blocks[1]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(blocks[0]!.text).toContain("800×600");
  });

  test("act failure reports the failing action index and what applied before it", async () => {
    const { win, score } = gameWindow();
    const tool = createPreviewTool({
      fs: { readFile: () => Promise.resolve(GAME_HTML), async writeFile() {} },
      frameFactory: loopbackFrame(win),
    });
    await open(tool);
    const r = await tool.execute(
      { op: "act", actions: [{ type: "click", x: 50, y: 25 }, { type: "click", x: 9_999, y: 9_999 }] },
      testCtx(),
    );
    expect(r.isError).toBe(true);
    const text = typeof r.content === "string" ? r.content : "";
    expect(text).toContain("Preview error: action 2 (click): no element at (9999, 9999)");
    expect(score.textContent).toBe("1"); // the first click applied before the failure
  });
});

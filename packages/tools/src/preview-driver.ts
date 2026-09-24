// preview tool — the injected driver, the half of the tool that lives INSIDE
// the sandboxed iframe (see preview.ts for the parent half).
//
// The parent assembles `(<this function>)(window, "<token>")` into the srcdoc
// as the FIRST script, so it runs before any artifact code and can patch what
// the artifact will use: console (capture), canvas contexts (WebGL
// preserveDrawingBuffer — screenshots need it), localStorage (access throws in
// an opaque-origin sandbox; a memory shim keeps score-saving games alive).
//
// SELF-CONTAINMENT CONTRACT — this function is embedded via
// Function.prototype.toString(), therefore:
//   - NO imports, NO references to module scope: every constant lives inside;
//   - the body starts with "use strict" (the embedding <script> is sloppy mode);
//   - every DOM constructor is reached through `win.` (win.MouseEvent), never
//     as a bare identifier, so tests can supply fakes of exactly that shape.
// A parse test guards the contract (test/preview.test.ts); if a bundler ever
// mangles the body, the fallback is a hand-written source string — the file
// layout does not change.
//
// Trust model: the artifact shares this frame and CAN read the token from the
// document and postMessage the parent. The token only filters ACCIDENTAL
// traffic (games postMessage too); spoofing the driver is self-defeating for
// agent-authored content and cannot escape the sandbox (CSP blocks egress,
// sandbox="allow-scripts" without allow-same-origin blocks host access).
//
// Family discipline: never throws across the postMessage boundary (every op
// reply carries ok/error), bounds on everything (log ring + line cap, eval and
// read value caps, shot size fallback), flush-before-reply so cause always
// precedes effect in what the model sees.

/** Structural surface the driver touches — sized to exactly what it uses, so
 *  tests supply fakes of this shape and no DOM type enters the contract. */
export interface PreviewDriverElement {
  tagName: string;
  addEventListener(type: string, cb: (e: unknown) => void): void;
  dispatchEvent(e: object): boolean;
  getAttribute(name: string): string | null;
  textContent: string;
  innerHTML: string;
  value?: string;
  width?: number;
  height?: number;
  toDataURL?(format?: string, quality?: number): string;
}

/** A canvas element as the driver uses it (shot op). */
export interface PreviewDriverCanvas extends PreviewDriverElement {
  toDataURL(format?: string, quality?: number): string;
}

/** Event shapes reaching the driver's window listeners (message/error/
 *  unhandledrejection collapsed into one bag — fakes construct plain objects). */
export interface PreviewDriverEvent {
  data?: unknown;
  message?: string;
  filename?: string;
  lineno?: number;
  reason?: unknown;
}

/** The `window` the driver runs against — the real iframe window, or a fake. */
export interface PreviewDriverGlobal {
  addEventListener(type: string, cb: (e: PreviewDriverEvent) => void): void;
  parent: { postMessage(msg: unknown, targetOrigin: string): void };
  document: {
    readyState: string;
    addEventListener(type: string, cb: () => void): void;
    querySelectorAll(css: string): PreviewDriverElement[];
    elementFromPoint(x: number, y: number): PreviewDriverElement | null;
    activeElement: PreviewDriverElement | null;
    body: PreviewDriverElement;
  };
  console: Partial<
    Record<"log" | "warn" | "error" | "info", (...args: unknown[]) => void>
  >;
  setTimeout(fn: () => void, ms: number): unknown;
  scrollBy(dx: number, dy: number): void;
  HTMLCanvasElement?: {
    prototype: {
      getContext: (
        this: PreviewDriverCanvas,
        type: string,
        attrs?: Record<string, unknown>,
      ) => unknown;
    };
  };
  localStorage?: { getItem(key: string): string | null };
  Event?: new (type: string, init?: Record<string, unknown>) => object;
  MouseEvent?: new (type: string, init?: Record<string, unknown>) => object;
  PointerEvent?: new (type: string, init?: Record<string, unknown>) => object;
  KeyboardEvent?: new (type: string, init?: Record<string, unknown>) => object;
}

/** The injected driver. See the file header for the self-containment contract. */
export function previewDriver(win: PreviewDriverGlobal, token: string): void {
  "use strict";
  const LOG_LINE_CAP = 2_000;
  const RING_CAP = 200;
  const FLUSH_MS = 500;
  const EVAL_CAP = 8_000;
  const READ_CAP = 500;
  const SHOT_CAP = 4_000_000;
  const MAX_WAIT_MS = 10_000;

  const doc = win.document;
  const send = (msg: Record<string, unknown>): void => {
    win.parent.postMessage({ __preview: token, ...msg }, "*");
  };

  // ---- console + error capture → ring with consecutive-duplicate collapse ----
  // The ring lives HERE (not the parent) because consecutiveness is only
  // observable at the source — a game logging per rAF frame must collapse to
  // "tick ×437", not flood postMessage 60×/s.
  interface RingEntry {
    level: string;
    text: string;
    n: number;
  }
  const ring: RingEntry[] = [];
  let flushScheduled = false;

  const fmtArg = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return String(a); // JSON.stringify(Error) is "{}"
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s;
    } catch {
      return String(a);
    }
  };
  const fmt = (args: unknown[]): string => args.map(fmtArg).join(" ");
  const capLine = (s: string): string =>
    s.length <= LOG_LINE_CAP ? s : s.slice(0, LOG_LINE_CAP) + "…[truncated]";

  const flush = (): void => {
    flushScheduled = false;
    for (const e of ring) send({ t: "log", level: e.level, text: e.text, n: e.n });
    ring.length = 0;
  };
  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    win.setTimeout(() => {
      if (ring.length > 0) flush();
      else flushScheduled = false;
    }, FLUSH_MS);
  };
  const push = (level: string, text: string): void => {
    const t = capLine(text);
    const last = ring.length > 0 ? ring[ring.length - 1] : undefined;
    if (last !== undefined && last.level === level && last.text === t) {
      last.n += 1;
    } else {
      ring.push({ level, text: t, n: 1 });
      if (ring.length > RING_CAP) ring.shift();
    }
    if (level === "error") flush();
    else scheduleFlush();
  };

  for (const level of ["log", "warn", "error", "info"] as const) {
    const orig = win.console[level];
    if (typeof orig !== "function") continue;
    win.console[level] = (...args: unknown[]) => {
      push(level, fmt(args));
      orig.apply(win.console, args);
    };
  }
  win.addEventListener("error", (e) => {
    const src = e.filename !== undefined ? ` (${e.filename}:${e.lineno ?? 0})` : "";
    push("error", `${e.message ?? "script error"}${src}`);
  });
  win.addEventListener("unhandledrejection", (e) => {
    push("error", `unhandled rejection: ${fmtArg(e.reason ?? "unknown")}`);
  });

  // ---- WebGL patch: screenshots need preserveDrawingBuffer ----
  const HCE = win.HTMLCanvasElement;
  if (HCE !== undefined && typeof HCE.prototype.getContext === "function") {
    const origGetContext = HCE.prototype.getContext;
    HCE.prototype.getContext = function (
      this: PreviewDriverCanvas,
      type: string,
      attrs?: Record<string, unknown>,
    ) {
      const a = /webgl/i.test(type)
        ? { ...(attrs ?? {}), preserveDrawingBuffer: true }
        : attrs;
      return origGetContext.call(this, type, a);
    };
  }

  // ---- localStorage shim (opaque-origin sandbox throws on access) ----
  try {
    win.localStorage?.getItem("__preview_probe__");
  } catch {
    const store = new Map<string, string>();
    const shim = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        store.set(k, String(v));
      },
      removeItem: (k: string): void => {
        store.delete(k);
      },
      clear: (): void => {
        store.clear();
      },
      key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
      get length(): number {
        return store.size;
      },
    };
    try {
      Object.defineProperty(win, "localStorage", { value: shim, configurable: true, writable: true });
    } catch {
      // non-configurable — the artifact will see the SecurityError in console
    }
  }

  // ---- ready ----
  const sendReady = (): void => {
    flush();
    send({ t: "ready" });
  };
  if (doc.readyState !== "loading") sendReady();
  else doc.addEventListener("DOMContentLoaded", sendReady);

  // ---- event synthesis ----
  type EventCtor = new (type: string, init?: Record<string, unknown>) => object;
  const dispatch = (
    target: PreviewDriverElement,
    type: string,
    ctor: EventCtor | undefined,
    init: Record<string, unknown>,
  ): void => {
    if (ctor === undefined) throw new Error(`cannot synthesize ${type} events in this runtime`);
    target.dispatchEvent(new ctor(type, { bubbles: true, cancelable: true, ...init }));
  };
  const deriveCode = (key: string): string => {
    if (key.length === 1) {
      if (/[a-z]/i.test(key)) return "Key" + key.toUpperCase();
      if (/[0-9]/.test(key)) return "Digit" + key;
      return key === " " ? "Space" : key;
    }
    return key; // ArrowRight, Enter, Escape… pass through as their own code
  };
  const click = (x: number, y: number): void => {
    const el = doc.elementFromPoint(x, y);
    if (el === null) throw new Error(`no element at (${x}, ${y})`);
    const pos = { clientX: x, clientY: y, button: 0 };
    const pointer = win.PointerEvent ?? win.MouseEvent;
    const P = (buttons: number): Record<string, unknown> => ({
      ...pos,
      buttons,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    });
    // Phaser/PixiJS-style games listen for pointer events only — the full
    // sequence is what a real user produces.
    dispatch(el, "pointerdown", pointer, P(1));
    dispatch(el, "mousedown", win.MouseEvent, { ...pos, buttons: 1 });
    dispatch(el, "pointerup", pointer, P(0));
    dispatch(el, "mouseup", win.MouseEvent, { ...pos, buttons: 0 });
    dispatch(el, "click", win.MouseEvent, pos);
  };
  const pressKey = (key: string): void => {
    // Games listen on window/document; a bubbling dispatch on the active
    // element (or body) reaches both.
    const target = doc.activeElement !== null && doc.activeElement !== doc.body ? doc.activeElement : doc.body;
    const init = { key, code: deriveCode(key) };
    dispatch(target, "keydown", win.KeyboardEvent ?? win.Event, init);
    dispatch(target, "keyup", win.KeyboardEvent ?? win.Event, init);
  };
  const typeText = (text: string): void => {
    const el = doc.activeElement;
    const tag = el === null ? "" : el.tagName.toLowerCase();
    if (el === null || (tag !== "input" && tag !== "textarea")) {
      throw new Error("no focused <input>/<textarea> to type into — click one first");
    }
    el.value = (el.value ?? "") + text;
    dispatch(el, "input", win.Event, {});
    dispatch(el, "change", win.Event, {});
  };
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      win.setTimeout(resolve, ms);
    });

  // ---- op handlers ----
  interface ActAction {
    type: string;
    x?: unknown;
    y?: unknown;
    key?: unknown;
    text?: unknown;
    dy?: unknown;
    ms?: unknown;
  }
  const doActions = async (actions: unknown): Promise<number> => {
    const list = Array.isArray(actions) ? (actions as ActAction[]) : [];
    let i = 0;
    for (const a of list) {
      i += 1;
      try {
        if (a.type === "click") {
          click(Number(a.x), Number(a.y));
        } else if (a.type === "key") {
          pressKey(String(a.key));
        } else if (a.type === "type") {
          typeText(String(a.text));
        } else if (a.type === "scroll") {
          win.scrollBy(0, Number(a.dy));
        } else if (a.type === "wait") {
          const ms = Math.max(0, Math.min(MAX_WAIT_MS, Number(a.ms)));
          await sleep(ms);
        } else {
          throw new Error(`unknown action type '${String(a.type)}'`);
        }
      } catch (err) {
        throw new Error(
          `action ${i} (${String(a.type)}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return list.length;
  };

  interface ReadQuery {
    css: string;
    attr?: string;
  }
  const readQueries = (queries: unknown): unknown[] => {
    const list = Array.isArray(queries) ? (queries as ReadQuery[]) : [];
    return list.map((q) => {
      const attr = q.attr ?? "text";
      const base = { css: q.css, attr };
      try {
        const els = doc.querySelectorAll(q.css);
        if (els.length === 0) return { ...base, value: null, count: 0 };
        const el = els[0]!;
        let v: string;
        if (attr === "text") v = el.textContent;
        else if (attr === "html") v = el.innerHTML;
        else if (attr === "value") v = String(el.value ?? "");
        else v = el.getAttribute(attr) ?? "";
        return { ...base, value: v.length > READ_CAP ? v.slice(0, READ_CAP) + "…[truncated]" : v, count: els.length };
      } catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
      }
    });
  };

  const runEval = (code: string): string => {
    const v = new Function(code)() as unknown;
    if (v === undefined) return "(undefined)";
    let s: string;
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = String(v);
    }
    return s.length > EVAL_CAP ? s.slice(0, EVAL_CAP) + "…[truncated]" : s;
  };

  const shoot = (format: string): { dataUrl: string; width: number; height: number; format: string } => {
    let best: PreviewDriverCanvas | null = null;
    let bestArea = -1;
    for (const c of doc.querySelectorAll("canvas")) {
      const area = (c.width ?? 0) * (c.height ?? 0);
      if (area > bestArea) {
        bestArea = area;
        best = c as PreviewDriverCanvas;
      }
    }
    if (best === null || typeof best.toDataURL !== "function") {
      throw new Error("no <canvas> in the document (shots capture canvases)");
    }
    try {
      let dataUrl = best.toDataURL("image/png");
      let fmt = "png";
      if (format === "jpeg" || dataUrl.length > SHOT_CAP) {
        dataUrl = best.toDataURL("image/jpeg", 0.85);
        fmt = "jpeg";
      }
      if (dataUrl.length > SHOT_CAP) {
        throw new Error("screenshot too large even as jpeg — reduce the canvas size");
      }
      return { dataUrl, width: best.width ?? 0, height: best.height ?? 0, format: fmt };
    } catch (err) {
      if (err instanceof Error && /security/i.test(`${err.name} ${err.message}`)) {
        throw new Error("canvas is tainted (a drawn image lacks CORS) — screenshot unavailable");
      }
      throw err;
    }
  };

  // ---- request dispatch ----
  win.addEventListener("message", (e) => {
    const d = e.data as Record<string, unknown> | null | undefined;
    if (d === null || d === undefined || typeof d !== "object" || d.__preview !== token) return;
    const id = d.id;
    const op = d.op;
    if (typeof id !== "number" || typeof op !== "string") return;
    void (async () => {
      try {
        let value: unknown;
        if (op === "act") value = { performed: await doActions(d.actions) };
        else if (op === "read") value = { results: readQueries(d.queries) };
        else if (op === "eval") value = { result: runEval(String(d.code)) };
        else if (op === "shot") value = shoot(String(d.format ?? "png"));
        else throw new Error(`unknown op '${op}'`);
        flush(); // cause precedes effect in the model's view
        send({ id, ok: true, value });
      } catch (err) {
        flush();
        send({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

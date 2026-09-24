// preview tool — the agent's eyes and hands on its OWN HTML artifacts.
//
// An agent writing a game/page/chart is blind: it cannot tell "renders fine"
// from "throws on load". preview opens the artifact in a SANDBOXED iframe
// (sandbox="allow-scripts", opaque origin, CSP-forced zero egress), injects a
// driver script (preview-driver.ts) ahead of the artifact's own code, and
// talks to it over postMessage. The model can then act on it (click / key /
// type / scroll / wait), read its DOM, eval JS inside it, and screenshot its
// canvas — with console output and uncaught errors returned on every call.
// The loop the tool exists for: write → open → act/read/shot → fix → repeat.
//
// Direction matters: web_read faces the WORLD (information in, never
// executes); preview faces the agent's OWN OUTPUT (executes, but inside a
// sandbox that cannot reach the host or the network). Different trust shapes,
// different tools.
//
// Sessions: one iframe per conversation (keyed by ctx.conversationId), kept
// across tool calls so multi-step play works (open → click start → read score
// → play on). Idle sessions die after idleMs (default 120s); open always
// rebuilds. Core has no teardown hook — the TTL + a FIFO session cap + a
// `close` op are the whole lifecycle story.
//
// Timeout discipline (the game_run lesson): core's per-call timer starts
// BEFORE execute runs, so this tool's internal deadline is strictly shorter
// (timeoutMs - 250ms) — the graceful, resource-explaining error must win the
// race, and total wait budgets are validated up front with the real numbers
// instead of dying at runtime. Abort kills the CALL, never the session
// (ctx.signal is per-call; the iframe is conversation-scoped).
//
// Family discipline: never throws (Refused:/Preview failed:/Preview error:/
// (aborted) ladder), abort short-circuit + re-check after awaits, bounds on
// everything (sessions, logs, values, shots), tags ["preview"], no network —
// the CSP makes egress impossible by construction.

import { randomId, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { previewDriver } from "./preview-driver.js";
import type { Filesystem } from "./filesystem.js";

const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
/** Core's timeout timer starts before execute — stay strictly inside it. */
const DEADLINE_MARGIN_MS = 250;
/** Room for ready/round-trip/shot outside the wait budget. */
const WAIT_RESERVE_MS = 1_500;
const MAX_SESSIONS = 8;
const MAX_ACTIONS = 32;
const MAX_WAIT_MS = 10_000;
const MAX_QUERIES = 20;
const MAX_EVAL_CHARS = 8_000;
const PATH_CAP = 500;
const CSS_CAP = 500;
const MAX_LOG_LINES_PER_RESULT = 30;
const MAX_LOG_TEXT = 2_000;
/** Offscreen but NOT display:none — hidden frames stop their rAF loops. */
const OFFSCREEN_STYLE =
  "position:fixed;left:-99999px;top:0;border:0;pointer-events:none;z-index:-1;";

/** Host-injected artifact source — see Filesystem (filesystem.ts). */

/** The frame port — both directions of the sandbox channel behind one seam,
 *  so every DOM touch collapses into a single adapter (createBrowserFrame)
 *  and node tests provide a plain loopback instead. */
export interface PreviewFrame {
  post(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
  /** Best-effort liveness probe (the DOM adapter reports iframe.isConnected).
   *  Hosts can unmount the frame at any time (tooolx tears its preview panel
   *  down with the whole panel); a dead frame never replies, so ops on one
   *  fail FAST via this instead of burning the call budget. Optional — test
   *  loopback and custom adapters may omit it. */
  alive?(): boolean;
  /** Idempotent; safe to call twice. */
  destroy(): void;
}

export interface PreviewFrameInit {
  srcdoc: string;
  width: number;
  height: number;
  /** Host-side display hook; when given, the HOST owns DOM insertion and MUST
   *  insert the iframe (a never-inserted frame never fires ready and open
   *  fails at its deadline with a message saying exactly that). */
  attach?: (frame: HTMLIFrameElement) => void;
}

export type PreviewFrameFactory = (init: PreviewFrameInit) => PreviewFrame;

export type PreviewAction =
  | { type: "click"; x: number; y: number }
  | { type: "key"; key: string }
  | { type: "type"; text: string }
  | { type: "scroll"; dy: number }
  | { type: "wait"; ms: number };

export interface PreviewToolOptions {
  /** Workspace storage — REQUIRED (see filesystem.ts). Same `fs` as
   *  write_file / read_file: one namespace across the family. */
  fs: Filesystem;
  /** Tear down an idle session after this long. Default 120_000. */
  idleMs?: number;
  /** Per-call timeout; the internal reply deadline sits 250ms inside it.
   *  Default 30_000. */
  timeoutMs?: number;
  /** Frame dimensions. Default 1280×720. */
  width?: number;
  height?: number;
  /** Console entries kept per session (ring). Default 50. */
  maxLogMessages?: number;
  /** Show the frame yourself (a host preview panel — the user watches what
   *  the agent is testing). Default: offscreen. */
  attach?: (frame: HTMLIFrameElement) => void;
  /** Test/DI seam: build the frame yourself. Default: the real DOM adapter. */
  frameFactory?: PreviewFrameFactory;
}

interface LogLine {
  level: string;
  text: string;
  n: number;
}

interface DriverReply {
  ok: boolean;
  value?:
    | { dataUrl?: string; width?: number; height?: number; format?: string; results?: unknown[]; result?: unknown; performed?: number }
    | undefined;
  error?: string | undefined;
}

interface Session {
  frame: PreviewFrame;
  token: string;
  path: string;
  nextId: number;
  logs: LogLine[];
  cursor: number;
  dropped: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  inFlight: boolean;
  pending: { id: number; resolve: (v: DriverReply) => void } | null;
  readyResolve: (() => void) | null;
  unsub: (() => void) | null;
}

/** Pure string assembly: charset + CSP + driver invocation at head start, in
 *  that order (the driver must precede all artifact code). Exported for
 *  tests — not re-exported from the package index. */
export function assemblePreviewDocument(html: string, token: string): string {
  const head =
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<script>(${previewDriver.toString()})(window,${JSON.stringify(token)});</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + head);
  return head + html; // fragment — the parser puts leading meta/script into the implied head
}

/** Wrap raw SVG markup into a standalone preview page (centered, scaled to the
 *  frame viewport, transparent background). Used by open for .svg paths —
 *  internal (not on the package index); hosts that render user file previews
 *  carry their own shell. */
function wrapSvgDocument(svg: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    "<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:transparent}" +
    "svg{max-width:100%;max-height:100%}</style></head><body>" +
    svg +
    "</body></html>"
  );
}

/** The only DOM code in the tool — the real PreviewFrame adapter. */function createBrowserFrame(init: PreviewFrameInit): PreviewFrame {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = init.srcdoc;
  iframe.width = String(init.width);
  iframe.height = String(init.height);
  iframe.style.cssText = OFFSCREEN_STYLE + `width:${init.width}px;height:${init.height}px;`;
  const subs = new Set<(msg: unknown) => void>();
  const onWinMessage = (e: MessageEvent): void => {
    if (e.source !== iframe.contentWindow) return; // only OUR frame's messages
    for (const cb of subs) cb(e.data);
  };
  window.addEventListener("message", onWinMessage);
  if (init.attach !== undefined) {
    try {
      init.attach(iframe);
    } catch (err) {
      window.removeEventListener("message", onWinMessage); // don't leak the listener
      throw err;
    }
  } else if (document.body !== null) {
    document.body.appendChild(iframe);
  } else {
    window.removeEventListener("message", onWinMessage);
    throw new Error("document.body is not ready — create the preview after DOMContentLoaded, or pass attach");
  }
  return {
    post: (msg) => {
      iframe.contentWindow?.postMessage(msg, "*");
    },
    onMessage(cb) {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    alive: () => iframe.isConnected,
    destroy: () => {
      window.removeEventListener("message", onWinMessage);
      iframe.remove();
      subs.clear();
    },
  };
}

/** Sanitized input; `msg` set means refuse with it. */
interface Sanitized {
  msg?: string;
  op?: "open" | "act" | "read" | "eval" | "shot" | "close";
  path?: string;
  waitMs?: number;
  actions?: PreviewAction[];
  shot?: boolean;
  queries?: { css: string; attr?: string }[];
  code?: string;
  format?: "png" | "jpeg";
  totalWaitMs?: number;
}

function sanitize(raw: unknown): Sanitized {
  const r = raw as Record<string, unknown>;
  const bad = (msg: string): Sanitized => ({ msg });
  if (r === null || typeof r !== "object") return bad("input must be an object");
  const op = r.op;
  if (
    op !== "open" && op !== "act" && op !== "read" &&
    op !== "eval" && op !== "shot" && op !== "close"
  ) {
    return bad("input.op must be one of open|act|read|eval|shot|close");
  }
  if (op === "open") {
    const path = r.path;
    if (typeof path !== "string" || path.trim() === "" || path.length > PATH_CAP) {
      return bad(`input.path must be a non-empty string (max ${PATH_CAP} chars) as your read() source understands it`);
    }
    const out: Sanitized = { op, path };
    if (r.waitMs !== undefined) {
      if (typeof r.waitMs !== "number" || !Number.isFinite(r.waitMs) || r.waitMs < 0 || r.waitMs > MAX_WAIT_MS) {
        return bad(`input.waitMs must be a number 0..${MAX_WAIT_MS}`);
      }
      out.waitMs = r.waitMs;
      out.totalWaitMs = r.waitMs;
    }
    if (r.shot !== undefined) {
      if (typeof r.shot !== "boolean") return bad("input.shot must be a boolean");
      out.shot = r.shot;
    }
    return out;
  }
  if (op === "act") {
    if (!Array.isArray(r.actions) || r.actions.length === 0 || r.actions.length > MAX_ACTIONS) {
      return bad(`input.actions must be a non-empty array (max ${MAX_ACTIONS})`);
    }
    const acts: PreviewAction[] = [];
    let total = 0;
    for (const a of r.actions as Record<string, unknown>[]) {
      const t = a.type;
      if (t === "click") {
        if (typeof a.x !== "number" || typeof a.y !== "number" || !Number.isFinite(a.x) || !Number.isFinite(a.y)) {
          return bad("click actions need finite x and y");
        }
        acts.push({ type: "click", x: a.x, y: a.y });
      } else if (t === "key") {
        if (typeof a.key !== "string" || a.key === "") return bad('key actions need a non-empty "key"');
        acts.push({ type: "key", key: a.key });
      } else if (t === "type") {
        if (typeof a.text !== "string" || a.text === "") return bad('type actions need a non-empty "text"');
        acts.push({ type: "type", text: a.text });
      } else if (t === "scroll") {
        if (typeof a.dy !== "number" || !Number.isFinite(a.dy)) return bad("scroll actions need a finite dy");
        acts.push({ type: "scroll", dy: a.dy });
      } else if (t === "wait") {
        if (typeof a.ms !== "number" || !Number.isFinite(a.ms) || a.ms < 0 || a.ms > MAX_WAIT_MS) {
          return bad(`wait actions need ms in 0..${MAX_WAIT_MS}`);
        }
        acts.push({ type: "wait", ms: a.ms });
        total += a.ms;
      } else {
        return bad("each action.type must be click|key|type|scroll|wait");
      }
    }
    const out: Sanitized = { op, actions: acts, totalWaitMs: total };
    if (r.shot !== undefined) {
      if (typeof r.shot !== "boolean") return bad("input.shot must be a boolean");
      out.shot = r.shot;
    }
    return out;
  }
  if (op === "read") {
    if (!Array.isArray(r.queries) || r.queries.length === 0 || r.queries.length > MAX_QUERIES) {
      return bad(`input.queries must be a non-empty array (max ${MAX_QUERIES})`);
    }
    const qs: { css: string; attr?: string }[] = [];
    for (const q of r.queries as Record<string, unknown>[]) {
      if (typeof q.css !== "string" || q.css.trim() === "" || q.css.length > CSS_CAP) {
        return bad("each query needs a non-empty css selector");
      }
      if (q.attr !== undefined && (typeof q.attr !== "string" || q.attr.length > 100)) {
        return bad("query.attr must be a string (max 100 chars): text|html|value|any attribute name");
      }
      qs.push(q.attr !== undefined ? { css: q.css, attr: q.attr } : { css: q.css });
    }
    return { op, queries: qs };
  }
  if (op === "eval") {
    if (typeof r.code !== "string" || r.code.trim() === "" || r.code.length > MAX_EVAL_CHARS) {
      return bad(`input.code must be a non-empty string (max ${MAX_EVAL_CHARS} chars); include a return to yield a value`);
    }
    return { op, code: r.code };
  }
  if (op === "shot") {
    const out: Sanitized = { op };
    if (r.format !== undefined) {
      if (r.format !== "png" && r.format !== "jpeg") return bad("input.format must be 'png' or 'jpeg'");
      out.format = r.format;
    }
    return out;
  }
  return { op: "close" };
}

export function createPreviewTool(opts: PreviewToolOptions): Tool {
  const fs = opts.fs;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const maxLogs = opts.maxLogMessages ?? 50;
  const frameFactory =
    opts.frameFactory ??
    ((init: PreviewFrameInit): PreviewFrame => createBrowserFrame(init));

  const sessions = new Map<string, Session>();
  const queues = new Map<string, Promise<unknown>>();

  // ---- session lifecycle ----
  const destroySession = (cid: string): void => {
    const s = sessions.get(cid);
    if (s === undefined) return;
    sessions.delete(cid);
    if (s.idleTimer !== undefined) clearTimeout(s.idleTimer);
    if (s.unsub !== null) s.unsub();
    try {
      s.frame.destroy();
    } catch {
      // already gone — destroy is idempotent on our side regardless
    }
  };
  const scheduleIdle = (s: Session, cid: string): void => {
    if (s.idleTimer !== undefined) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(function onIdle(): void {
      s.idleTimer = undefined;
      if (s.inFlight) {
        s.idleTimer = setTimeout(onIdle, 1_000); // let the running call finish
        return;
      }
      destroySession(cid);
    }, idleMs);
  };
  const evictIfNeeded = (): void => {
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      destroySession(oldest);
    }
  };

  // ---- message routing ----
  const pushLog = (s: Session, level: string, text: string, n: number): void => {
    const t = text.length > MAX_LOG_TEXT ? text.slice(0, MAX_LOG_TEXT) + "…[truncated]" : text;
    const last = s.logs.length > 0 ? s.logs[s.logs.length - 1] : undefined;
    if (last !== undefined && last.level === level && last.text === t) {
      last.n += n;
      return;
    }
    s.logs.push({ level, text: t, n });
    if (s.logs.length > maxLogs) {
      s.logs.shift();
      s.cursor = Math.max(0, s.cursor - 1);
      s.dropped += 1;
    }
  };
  const routeMessage = (s: Session, msg: unknown): void => {
    const d = msg as Record<string, unknown> | null | undefined;
    if (d === null || d === undefined || typeof d !== "object" || d.__preview !== s.token) return;
    if (d.t === "log") {
      pushLog(s, String(d.level ?? "log"), String(d.text ?? ""), typeof d.n === "number" ? d.n : 1);
      return;
    }
    if (d.t === "ready") {
      if (s.readyResolve !== null) {
        const r = s.readyResolve;
        s.readyResolve = null;
        r();
      }
      return;
    }
    if (typeof d.id === "number" && s.pending !== null && d.id === s.pending.id) {
      const p = s.pending;
      s.pending = null;
      p.resolve({
        ok: d.ok === true,
        ...(d.value !== undefined ? { value: d.value as DriverReply["value"] } : {}),
        ...(d.error !== undefined ? { error: String(d.error) } : {}),
      });
    }
    // anything else (late replies, foreign ids) is dropped by design
  };

  const sleepAbort = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clean();
        resolve();
      }, ms);
      const onAbort = (): void => {
        clean();
        reject(new Error("aborted"));
      };
      const clean = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });

  const requestReply = (
    s: Session,
    op: string,
    payload: Record<string, unknown>,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<DriverReply> => {
    const id = s.nextId++;
    return new Promise<DriverReply>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clean();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("no reply from the preview frame within the call budget — close and re-open, or raise timeoutMs"))),
        Math.max(0, deadlineAt - Date.now()),
      );
      const onAbort = (): void =>
        finish(() => reject(new Error("aborted")));
      const clean = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      s.pending = {
        id,
        resolve: (v) =>
          finish(() => {
            if (s.pending !== null && s.pending.id === id) s.pending = null;
            resolve(v);
          }),
      };
      s.frame.post({ __preview: s.token, id, op, ...payload });
    });
  };

  // ---- rendering ----
  const drainLogs = (s: Session): string => {
    if (s.cursor >= s.logs.length) return "";
    const all = s.logs.slice(s.cursor);
    s.cursor = s.logs.length;
    const droppedHere = s.dropped;
    s.dropped = 0;
    const kept = all.length > MAX_LOG_LINES_PER_RESULT ? all.slice(all.length - MAX_LOG_LINES_PER_RESULT) : all;
    const skipped = all.length - kept.length + droppedHere;
    const lines = kept.map((l) => `[${l.level}] ${l.text}${l.n > 1 ? ` ×${l.n}` : ""}`);
    return (skipped > 0 ? `console (${skipped} earlier lines dropped):\n` : `console:\n`) + lines.join("\n");
  };
  const sessionLine = (s: Session): string =>
    `session: ${s.path} (closes after ${Math.round(idleMs / 1000)}s idle)`;

  const renderShot = (value: DriverReply["value"]): { text: string; image?: { type: "image"; mediaType: string; data: string } } => {
    const dataUrl = value?.dataUrl;
    if (typeof dataUrl !== "string") return { text: "shot: no screenshot returned" };
    const m = /^data:(image\/(?:png|jpeg));base64,([\s\S]*)$/.exec(dataUrl);
    if (m === null) return { text: "shot: unrecognized canvas data URL" };
    const mediaType = m[1] as string;
    const data = m[2] as string;
    const dims = `${value?.width ?? "?"}×${value?.height ?? "?"}`;
    return {
      text: `screenshot: ${dims} ${mediaType} attached` +
        " (image blocks inside tool results reach Anthropic-class models; text-only providers drop them — rely on read/eval there)",
      image: { type: "image", mediaType, data },
    };
  };

  // ---- op handlers (run inside the serialization queue) ----
  const handleOp = async (
    input: Sanitized,
    ctx: { conversationId: string; signal: AbortSignal },
    deadlineAt: number,
  ): Promise<ToolResultValue> => {
    const cid = ctx.conversationId;

    if (input.op === "close") {
      destroySession(cid);
      return { content: "preview session closed" };
    }

    if (input.op === "open") {
      const pathArg = input.path!;
      let html: string;
      try {
        html = await fs.readFile(pathArg, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Preview failed: read('${pathArg}'): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      if (/\.svg$/i.test(pathArg)) html = wrapSvgDocument(html); // standalone svg → centered page
      if (!html.includes("<")) {
        return { content: `Refused: '${pathArg}' did not look like HTML (no '<' found)`, isError: true };
      }
      destroySession(cid); // open ALWAYS rebuilds — a new token orphans the old frame
      evictIfNeeded();
      const token = randomId();
      const srcdoc = assemblePreviewDocument(html, token);
      let frame: PreviewFrame;
      try {
        frame = frameFactory({
          srcdoc,
          width,
          height,
          ...(opts.attach !== undefined ? { attach: opts.attach } : {}),
        });
      } catch (err) {
        return {
          content: `Preview failed: frame: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      const session: Session = {
        frame,
        token,
        path: pathArg,
        nextId: 1,
        logs: [],
        cursor: 0,
        dropped: 0,
        idleTimer: undefined,
        inFlight: true,
        pending: null,
        readyResolve: null,
        unsub: null,
      };
      sessions.set(cid, session);
      session.unsub = frame.onMessage((msg) => routeMessage(session, msg));
      scheduleIdle(session, cid);
      try {
        await new Promise<void>((resolve, reject) => {
          let done = false;
          let poll: ReturnType<typeof setInterval> | undefined;
          const timer = setTimeout(
            () => {
              if (done) return;
              done = true;
              clean();
              reject(
                new Error(
                  "the preview frame never signaled ready — if you passed attach, make sure it inserts the iframe into the DOM",
                ),
              );
            },
            Math.max(0, deadlineAt - Date.now()),
          );
          const onAbort = (): void => {
            if (done) return;
            done = true;
            clean();
            reject(new Error("aborted"));
          };
          const clean = (): void => {
            clearTimeout(timer);
            if (poll !== undefined) clearInterval(poll);
            ctx.signal.removeEventListener("abort", onAbort);
          };
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener("abort", onAbort, { once: true });
          if (frame.alive !== undefined) {
            // waiting on a frame the host already removed would eat the whole
            // budget — poll liveness and fail fast with the real reason
            poll = setInterval(() => {
              if (done || frame.alive!()) return;
              done = true;
              clean();
              reject(
                new Error(
                  "the preview frame left the DOM before signaling ready (the host closed its preview panel) — call preview open again",
                ),
              );
            }, 250);
          }
          session.readyResolve = () => {
            if (done) return;
            done = true;
            clean();
            resolve();
          };
        });
      } catch (err) {
        session.inFlight = false;
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        destroySession(cid); // a frame that never readied is garbage
        return {
          content: `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      if (input.waitMs !== undefined) {
        try {
          await sleepAbort(input.waitMs, ctx.signal);
        } catch {
          session.inFlight = false;
          return { content: "(aborted)", isError: true };
        }
      }
      const parts = [`open: ${pathArg} (${html.length} chars) — ready`];
      if (input.shot === true) {
        const reply = await requestReply(session, "shot", {}, deadlineAt, ctx.signal).catch(() => null);
        if (reply !== null && reply.ok) {
          const r = renderShot(reply.value);
          parts.push(r.text);
          const logs = drainLogs(session);
          session.inFlight = false;
          return { content: [{ type: "text", text: [parts.join("\n"), sessionLine(session), logs].filter(Boolean).join("\n") }, ...(r.image !== undefined ? [r.image] : [])] };
        }
        if (reply !== null && !reply.ok) parts.push(`shot failed: ${reply.error}`);
      }
      const logs = drainLogs(session);
      session.inFlight = false;
      return { content: [parts.join("\n"), sessionLine(session), logs].filter(Boolean).join("\n") };
    }

    // act / read / eval / shot — session required
    const session = sessions.get(cid);
    if (session === undefined) {
      return { content: "Refused: no preview session — call preview open first", isError: true };
    }
    // The host can unmount our iframe at any time (tooolx tears its preview
    // panel down with the whole panel). A dead frame never replies — fail
    // fast with the fix instead of burning the whole call budget on a deadline.
    if (session.frame.alive !== undefined && !session.frame.alive()) {
      const wasPath = session.path;
      destroySession(cid);
      return {
        content:
          `Preview failed: the preview frame is gone (the host closed its preview panel) — ` +
          `call preview open again to rebuild the session (was: ${wasPath})`,
        isError: true,
      };
    }
    session.inFlight = true;
    scheduleIdle(session, cid);
    try {
      let payload: Record<string, unknown>;
      let summary: string;
      if (input.op === "act") {
        payload = { actions: input.actions };
        summary = `act: ${input.actions!.length} actions`;
      } else if (input.op === "read") {
        payload = { queries: input.queries };
        summary = `read: ${input.queries!.length} queries`;
      } else if (input.op === "eval") {
        payload = { code: input.code };
        summary = "eval";
      } else {
        payload = input.format !== undefined ? { format: input.format } : {};
        summary = "shot";
      }
      const reply = await requestReply(session, input.op!, payload, deadlineAt, ctx.signal);
      if (!reply.ok) {
        return { content: [`Preview error: ${reply.error}`, sessionLine(session), drainLogs(session)].filter(Boolean).join("\n"), isError: true };
      }
      const lines: string[] = [summary];
      if (input.op === "act") lines.push(`${reply.value?.performed ?? 0} performed`);
      if (input.op === "read") {
        for (const q of (reply.value?.results ?? []) as { css: string; attr: string; value: string | null; count: number; error?: string }[]) {
          lines.push(q.error !== undefined ? `  ${q.css} (${q.attr}) — error: ${q.error}` : `  ${q.css} (${q.attr}) = ${q.value === null ? "null" : JSON.stringify(q.value)} [${q.count} match${q.count === 1 ? "" : "es"}]`);
        }
      }
      if (input.op === "eval") lines.push(`  → ${String(reply.value?.result ?? "(no value)")}`);
      const contentBlocks: ({ type: "text"; text: string } | { type: "image"; mediaType: string; data: string })[] = [];
      if (input.op === "shot") {
        const r = renderShot(reply.value);
        lines.push(r.text);
        if (r.image !== undefined) contentBlocks.push(r.image);
      }
      if (input.op === "act" && input.shot === true) {
        const shotReply = await requestReply(session, "shot", {}, deadlineAt, ctx.signal);
        if (shotReply.ok) {
          const r = renderShot(shotReply.value);
          lines.push(r.text);
          if (r.image !== undefined) contentBlocks.push(r.image);
        } else {
          lines.push(`shot failed: ${shotReply.error}`);
        }
      }
      lines.push(sessionLine(session));
      const logs = drainLogs(session);
      const text = [...lines, logs].filter(Boolean).join("\n");
      if (contentBlocks.length === 0) return { content: text }; // text-only → plain string
      contentBlocks.unshift({ type: "text", text });
      return { content: contentBlocks };
    } catch (err) {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      return { content: `Preview failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    } finally {
      session.inFlight = false;
    }
  };

  // Serialize per conversation: core runs one message's tool calls via
  // Promise.allSettled, and interleaved ops would confuse both the artifact
  // and the log cursor.
  const runSerialized = <T>(cid: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(cid) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {}).then(() => {
      if (queues.get(cid) === tail) queues.delete(cid);
    });
    queues.set(cid, tail);
    return next;
  };

  return {
    name: "preview",
    description:
      "See and drive your own HTML artifact (game, page, chart): open it in a sandboxed preview, " +
      "then act on it (click / key / type / scroll / wait), read DOM values, eval JS inside it, and " +
      "screenshot its canvas — console output and uncaught errors come back with every call. " +
      "A standalone .svg opens as a centered image (shot it to check how it looks). Use it " +
      "after writing or changing an HTML artifact — never guess whether it works: open → look → fix → " +
      "repeat. Sessions persist between calls (open always starts fresh) and idle out after ~2 min. " +
      "Synthesized input is untrusted (isTrusted:false); games that filter it can be driven via eval " +
      "on their own APIs instead.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["open", "act", "read", "eval", "shot", "close"],
            description:
              "open: load an artifact (fresh session). act: play it. read: query the DOM. eval: run JS " +
              "inside it. shot: screenshot the canvas. close: tear the session down.",
          },
          path: {
            type: "string",
            description: `open — the artifact path, as the host's file source understands it (max ${PATH_CAP} chars).`,
          },
          waitMs: {
            type: "number",
            description: `open — settle time after ready (lets rAF loops render) before acting/shooting. 0..${MAX_WAIT_MS}.`,
          },
          actions: {
            type: "array",
            description: `act — 1..${MAX_ACTIONS} actions to run in order.`,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["click", "key", "type", "scroll", "wait"],
                  description: "click(x,y) · key(name, e.g. ArrowRight) · type(text into the focused input) · scroll(dy) · wait(ms).",
                },
                x: { type: "number", description: "click — x coordinate." },
                y: { type: "number", description: "click — y coordinate." },
                key: { type: "string", description: 'key — key name, e.g. "ArrowRight", "a", "Enter", " ".' },
                text: { type: "string", description: "type — text to append to the focused input." },
                dy: { type: "number", description: "scroll — vertical pixels." },
                ms: { type: "number", description: `wait — 0..${MAX_WAIT_MS}.` },
              },
              required: ["type"],
              additionalProperties: false,
            },
          },
          shot: {
            type: "boolean",
            description: "open/act — also capture a screenshot at the end.",
          },
          queries: {
            type: "array",
            description: `read — 1..${MAX_QUERIES} css queries.`,
            items: {
              type: "object",
              properties: {
                css: { type: "string", description: "Selector, e.g. \"#score\"." },
                attr: {
                  type: "string",
                  description: 'text (default) | html | value | any attribute name.',
                },
              },
              required: ["css"],
              additionalProperties: false,
            },
          },
          code: {
            type: "string",
            description: `eval — JS run inside the artifact (max ${MAX_EVAL_CHARS} chars); include a return to yield a value.`,
          },
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            description: "shot — default png (falls back to jpeg when oversized).",
          },
        },
        required: ["op"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { tags: ["preview"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      if (typeof document === "undefined" && opts.frameFactory === undefined) {
        return {
          content: "Refused: preview needs a browser-like runtime (no `document` here) — use it from a browser/DOM host",
          isError: true,
        };
      }
      const input = sanitize(raw);
      if (input.msg !== undefined) return { content: `Refused: ${input.msg}`, isError: true };
      const budget = timeoutMs - DEADLINE_MARGIN_MS - WAIT_RESERVE_MS;
      const totalWait = input.totalWaitMs ?? 0;
      if (budget > 0 && totalWait > budget) {
        return {
          content:
            `Refused: total wait ${totalWait}ms exceeds this call's ${budget}ms budget ` +
            `(tool timeout ${timeoutMs}ms minus overhead) — split the work across calls or raise timeoutMs`,
          isError: true,
        };
      }
      const deadlineAt = () => Date.now() + (timeoutMs - DEADLINE_MARGIN_MS);
      try {
        return await runSerialized(ctx.conversationId, () =>
          // Deadline starts when the serialization slot is ACQUIRED — core
          // runs one message's tool calls in parallel, and a queued op whose
          // deadline was stamped at execute() entry can be dequeued already
          // expired and fail instantly with a misleading "no reply".
          handleOp(input, { conversationId: ctx.conversationId, signal: ctx.signal }, deadlineAt()),
        );
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return {
          content: `Preview failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

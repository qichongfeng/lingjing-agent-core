// Browser host glue: the localStorage TokenStore (seed-on-miss), config
// assembly, the landing-page callback, and the popup dance — state
// correlation, cross-origin/type rejection, and the blocked-popup error.
// window/localStorage are stubbed per test; the module only touches them
// inside functions, so importing it in the Node test env is side-effect free.

import { afterEach, describe, expect, it, vi } from "vitest";
import { browserOAuth, finishOAuthCallback } from "../src/browser/index.js";
import type { OAuthTokens, TokenStore } from "../src/oauth.js";

/** The wire contract between the popup dance and the landing page — pinned
 *  here so an accidental rename breaks a test, not every host app. */
const OAUTH_CALLBACK_MESSAGE = "lingjing-agent/mcp:oauth-callback";

function fakeLocalStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    dump: data,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browserOAuth config", () => {
  it("passes server/key/redirectUri through and wires the popup authorize step", () => {
    const cfg = browserOAuth({ server: "https://as", key: "k", redirectUri: "https://app/cb" });
    expect(cfg.authorizationServer).toBe("https://as");
    expect(cfg.key).toBe("k");
    expect(cfg.redirectUri).toBe("https://app/cb");
    expect(typeof cfg.authorize).toBe("function");
    expect(cfg.tokenStore).toBeDefined();
  });

  it("key is optional — omitted, the session's `mcp:` + url default applies", () => {
    const cfg = browserOAuth({ server: "https://as", redirectUri: "https://app/cb" });
    expect(cfg.key).toBeUndefined();
  });
});

describe("localStorage TokenStore", () => {
  it("seeds from the host credential on a cache miss (silent-first-refresh shape)", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r", seed: () => "widget-token" });
    expect(await cfg.tokenStore!.get("k")).toEqual({
      accessToken: "",
      refreshToken: "widget-token",
      expiresAt: 0,
    });
  });

  it("stored tokens win over the seed; a corrupt entry falls back to it", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r", seed: () => "widget-token" });
    await cfg.tokenStore!.set("k", { accessToken: "a", refreshToken: "r2" });
    expect(await cfg.tokenStore!.get("k")).toEqual({ accessToken: "a", refreshToken: "r2" });
    ls.dump.set("k", "{not json");
    expect(await cfg.tokenStore!.get("k")).toEqual({
      accessToken: "",
      refreshToken: "widget-token",
      expiresAt: 0,
    });
  });

  it("returns undefined when nothing is stored and there is no seed", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r" });
    expect(await cfg.tokenStore!.get("k")).toBeUndefined();
  });

  it("set persists JSON; clear removes the entry", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r" });
    await cfg.tokenStore!.set("k", { accessToken: "a", expiresAt: 123 });
    expect(ls.dump.get("k")).toBe('{"accessToken":"a","expiresAt":123}');
    await cfg.tokenStore!.clear("k");
    expect(ls.dump.has("k")).toBe(false);
  });
});

describe("store override", () => {
  function memStore() {
    const data = new Map<string, OAuthTokens>();
    const store: TokenStore = {
      async get(k) {
        return data.get(k);
      },
      async set(k, tokens) {
        data.set(k, tokens);
      },
      async clear(k) {
        data.delete(k);
      },
    };
    return { store, data };
  }

  it("a custom backend replaces localStorage entirely", async () => {
    const ls = fakeLocalStorage();
    vi.stubGlobal("localStorage", ls);
    const { store, data } = memStore();
    const cfg = browserOAuth({ server: "s", redirectUri: "r", store });
    await cfg.tokenStore!.set("k", { accessToken: "a" });
    expect(data.get("k")).toEqual({ accessToken: "a" });
    expect(await cfg.tokenStore!.get("k")).toEqual({ accessToken: "a" });
    expect(ls.dump.size).toBe(0); // localStorage never touched
  });

  it("seeding composes with a custom backend — miss seeds, hit wins", async () => {
    const { store } = memStore();
    const cfg = browserOAuth({ server: "s", redirectUri: "r", store, seed: () => "cred" });
    expect(await cfg.tokenStore!.get("k")).toEqual({ accessToken: "", refreshToken: "cred", expiresAt: 0 });
    await cfg.tokenStore!.set("k", { accessToken: "a" });
    expect(await cfg.tokenStore!.get("k")).toEqual({ accessToken: "a" });
  });
});

describe("finishOAuthCallback", () => {
  it("hands the full URL to the opener (same-origin target) and closes the window", () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("window", {
      opener: { postMessage },
      location: { origin: "https://app", href: "https://app/cb?code=x&state=s" },
      close,
    });
    expect(finishOAuthCallback()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      { type: OAUTH_CALLBACK_MESSAGE, url: "https://app/cb?code=x&state=s" },
      "https://app",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns false when opened directly (no opener)", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://app", href: "https://app/cb" },
      close: vi.fn(),
    });
    expect(finishOAuthCallback()).toBe(false);
  });
});

describe("authorize popup dance", () => {
  type Listener = (event: { origin: string; data: unknown }) => void;

  function stubWindow() {
    const listeners = new Set<Listener>();
    const popup = { closed: false, close: () => { popup.closed = true; } };
    vi.stubGlobal("window", {
      location: { origin: "https://app", href: "https://app/zh" },
      open: vi.fn(() => popup),
      addEventListener: (_type: string, l: Listener) => listeners.add(l),
      removeEventListener: (_type: string, l: Listener) => listeners.delete(l),
    });
    const emit = (origin: string, data: unknown) => {
      for (const l of [...listeners]) l({ origin, data });
    };
    return { emit };
  }

  it("throws when the popup is blocked", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://app" },
      open: vi.fn(() => null),
    });
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r" });
    await expect(cfg.authorize!("https://as/authorize?state=abc")).rejects.toThrow(/popup/i);
  });

  it("resolves only on the redirect whose state matches — foreign state, cross-origin, wrong type are ignored", async () => {
    const { emit } = stubWindow();
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r" });
    const promise = cfg.authorize!("https://as/authorize?state=abc");
    emit("https://app", { type: OAUTH_CALLBACK_MESSAGE, url: "https://app/cb?code=1&state=other" });
    emit("https://evil.test", { type: OAUTH_CALLBACK_MESSAGE, url: "https://app/cb?code=2&state=abc" });
    emit("https://app", { type: "unrelated", url: "https://app/cb?code=3&state=abc" });
    emit("https://app", { type: OAUTH_CALLBACK_MESSAGE, url: "not a url" });
    emit("https://app", { type: OAUTH_CALLBACK_MESSAGE, url: "https://app/cb?code=ok&state=abc" });
    await expect(promise).resolves.toBe("https://app/cb?code=ok&state=abc");
  });

  it("matches the state case-sensitively from the authorization URL", async () => {
    const { emit } = stubWindow();
    const cfg = browserOAuth({ server: "s", key: "k", redirectUri: "r" });
    const promise = cfg.authorize!("https://as/authorize?state=AbC123");
    emit("https://app", { type: OAUTH_CALLBACK_MESSAGE, url: "https://app/cb?code=1&state=abc123" });
    emit("https://app", { type: OAUTH_CALLBACK_MESSAGE, url: "https://app/cb?code=2&state=AbC123" });
    await expect(promise).resolves.toBe("https://app/cb?code=2&state=AbC123");
  });
});

// OAuth 2.1 (RFC 9728 browser-based) for the HTTP transport: caching, refresh,
// full authorize flow (RFC 8414 discovery + DCR + PKCE), CSRF state check, and
// the 401→refresh→replay loop at the transport boundary.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from "@lingjing-agent/core";
import { McpClient } from "../src/client.js";
import { createHttpMcpTransport } from "../src/http-transport.js";
import { OAuthSession, type McpOAuthConfig, type OAuthTokens, type TokenStore } from "../src/oauth.js";
import { bodyOf } from "./helpers.js";

function memStore(initial?: Record<string, OAuthTokens>): { store: TokenStore; data: Map<string, OAuthTokens> } {
  const data = new Map<string, OAuthTokens>(Object.entries(initial ?? {}));
  return {
    data,
    store: {
      async get(key) {
        return data.get(key);
      },
      async set(key, tokens) {
        data.set(key, tokens);
      },
      async clear(key) {
        data.delete(key);
      },
    },
  };
}

function resp(status: number, body: unknown, headers: Record<string, string> = {}): HttpTransportResponse {
  return {
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json", ...headers },
    body: bodyOf(JSON.stringify(body)),
  };
}

const METADATA = {
  authorization_endpoint: "https://idp/authorize",
  token_endpoint: "https://idp/token",
  registration_endpoint: "https://idp/register",
};

/** A scripted HttpTransport for the full authorize flow: discovery → DCR → token. */
function authorizeTransport(tokenResult: Record<string, unknown>): { t: HttpTransport; reqs: HttpTransportRequest[] } {
  const reqs: HttpTransportRequest[] = [];
  const t: HttpTransport = async (req) => {
    reqs.push(req);
    if (req.url.endsWith("/.well-known/oauth-authorization-server")) return resp(200, METADATA);
    if (req.url === METADATA.registration_endpoint) return resp(200, { client_id: "client-1" });
    if (req.url === METADATA.token_endpoint) return resp(200, tokenResult);
    return resp(404, {});
  };
  return { t, reqs };
}

describe("OAuthSession — token lifecycle", () => {
  it("returns a cached long-lived token without any network", async () => {
    const { store, data } = memStore({ key: { accessToken: "cached" } });
    const s = new OAuthSession({ tokenStore: store }, "key");
    await expect(s.getAccessToken()).resolves.toBe("cached");
    expect(data.has("key")).toBe(true);
  });

  it("returns a cached unexpired token (expiresAt in the future)", async () => {
    const { store } = memStore({ key: { accessToken: "fresh", expiresAt: Date.now() + 60_000 } });
    const s = new OAuthSession({ tokenStore: store }, "key");
    await expect(s.getAccessToken()).resolves.toBe("fresh");
  });

  it("no cached token and no authorize callback → clear error", async () => {
    const { store } = memStore();
    const s = new OAuthSession({ tokenStore: store, authorizationServer: "https://idp" }, "key");
    await expect(s.getAccessToken()).rejects.toThrow(/no `authorize` callback/);
  });

  it("full flow: discovery → DCR → PKCE authorize → code exchange → stored", async () => {
    const { store } = memStore();
    const { t  , reqs } = authorizeTransport({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" });
    const seenAuthUrls: string[] = [];
    let csrf: string | null = null;
    const s = new OAuthSession(
      {
        tokenStore: store,
        authorizationServer: "https://idp",
        scopes: ["read", "write"],
        transport: t,
        async authorize(url) {
          seenAuthUrls.push(url);
          const u = new URL(url);
          csrf = u.searchParams.get("state");
          // PKCE S256 challenge + required params must be present.
          expect(u.searchParams.get("code_challenge_method")).toBe("S256");
          expect(u.searchParams.get("code_challenge")).toBeTruthy();
          expect(u.searchParams.get("scope")).toBe("read write");
          return `http://127.0.0.1/callback?code=the-code&state=${csrf as string}`;
        },
      },
      "key",
    );

    const token = await s.getAccessToken();
    expect(token).toBe("at-1");

    const discovery = reqs.find((r) => r.url.endsWith("/.well-known/oauth-authorization-server"));
    expect(discovery).toBeDefined(); // RFC 8414 discovery ran once
    // DCR registered the loopback redirect + scopes, none auth method.
    const dcrBody = JSON.parse(reqs[1]!.body as string) as Record<string, unknown>;
    expect(dcrBody["redirect_uris"]).toEqual(["http://127.0.0.1/callback"]);
    expect(dcrBody["token_endpoint_auth_method"]).toBe("none");
    // Exchange used the authorization_code grant with verifier (PKCE) — the
    // token endpoint takes form-urlencoded bodies, not JSON.
    const tokenBody = new URLSearchParams(reqs[reqs.length - 1]!.body as string);
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("the-code");
    expect(tokenBody.get("code_verifier")).toBeTruthy();
    expect(tokenBody.get("client_id")).toBe("client-1");
  });

  it("CSRF state mismatch during authorize → rejected", async () => {
    const { store } = memStore();
    const { t } = authorizeTransport({ access_token: "at-1" });
    const s = new OAuthSession({
      tokenStore: store,
      authorizationServer: "https://idp",
      transport: t,
      authorize: async () => "http://127.0.0.1/callback?code=x&state=tampered",
    }, "key");
    await expect(s.getAccessToken()).rejects.toThrow(/state mismatch/);
  });

  it("cached refresh token → refresh grant, then new token stored", async () => {
    const { store } = memStore({
      key: { accessToken: "stale", refreshToken: "rt-old", expiresAt: Date.now() - 1000 },
    });
    const { t, reqs } = authorizeTransport({ access_token: "at-2", expires_in: 3600 });
    const s = new OAuthSession({
      tokenStore: store,
      authorizationServer: "https://idp",
      transport: t,
    }, "key");
    // refresh grant should NOT hit registration; only discovery + token.
    await expect(s.getAccessToken()).resolves.toBe("at-2");
    const tokenReq = reqs[reqs.length - 1]!;
    expect(tokenReq.url).toBe(METADATA.token_endpoint);
    const body = new URLSearchParams(tokenReq.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old");
  });

  it("invalidateAccessToken keeps the refresh token: 401 replay refreshes, no re-authorization", async () => {
    const { store } = memStore({
      key: { accessToken: "rejected", refreshToken: "rt-keep", expiresAt: Date.now() + 60_000 },
    });
    let authorizations = 0;
    const { t, reqs } = authorizeTransport({ access_token: "at-new", refresh_token: "rt-rot", expires_in: 3600 });
    const s = new OAuthSession({
      tokenStore: store,
      authorizationServer: "https://idp",
      transport: t,
      async authorize() {
        authorizations += 1;
        return "http://127.0.0.1/callback?code=x&state=bogus";
      },
    }, "key");

    // Cached token looks unexpired → returned without network (the 401 it
    // earned arrives out of band). The transport's replay path then calls:
    await s.invalidateAccessToken();
    await expect(s.getAccessToken()).resolves.toBe("at-new");

    expect(authorizations).toBe(0); // refresh grant — NOT an interactive re-auth
    const body = new URLSearchParams(reqs[reqs.length - 1]!.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-keep");
    // Rotated refresh token persisted.
    expect((await store.get("key"))?.refreshToken).toBe("rt-rot");
  });
});

describe("http transport — 401 replay", () => {
  it("401 on a call → clear + re-authorize → replay once, transparently", async () => {
    const TOKEN_KEY = "mcp:https://srv/mcp";
    const { store } = memStore({ [TOKEN_KEY]: { accessToken: "expired", expiresAt: Date.now() + 60_000 } });
    let authorizations = 0;
    // First token request returns a fresh token; the transport re-fetches after 401.
    const tokenResults = [{ access_token: "at-new", expires_in: 3600 }];

    const reqs: HttpTransportRequest[] = [];
    const t: HttpTransport = async (req) => {
      reqs.push(req);
      const isMcp = req.url === "https://srv/mcp";
      if (!isMcp) {
        if (req.url.endsWith("/.well-known/oauth-authorization-server")) return resp(200, METADATA);
        if (req.url === METADATA.registration_endpoint) return resp(200, { client_id: "c1" });
        if (req.url === METADATA.token_endpoint) {
          return resp(200, tokenResults.shift() ?? { access_token: "at-new", expires_in: 3600 });
        }
        return resp(404, {});
      }
      const body = JSON.parse(req.body ?? "{}") as { method: string; id: number };
      // Authorization must be injected on the FIRST attempt.
      if (req.method === "POST" && body.method === "tools/call") {
        if (req.headers["authorization"] === "Bearer expired") {
          return resp(401, { error: "invalid_token" });
        }
        return resp(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
      }
      if (body.method === "initialize") {
        return resp(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } },
        }, { "mcp-session-id": "s-1" });
      }
      return { status: 202, statusText: "Accepted", headers: {}, body: bodyOf("") };
    };

    const mt = createHttpMcpTransport({
      url: "https://srv/mcp",
      transport: t,
      auth: {
        tokenStore: store,
        authorizationServer: "https://idp",
        transport: t,
        async authorize(url) {
          authorizations += 1;
          const u = new URL(url);
          return `http://127.0.0.1/callback?code=c&state=${u.searchParams.get("state")}`;
        },
      },
    });

    const c = new McpClient({ transport: mt, requestTimeoutMs: 2_000 });
    await c.connect();
    const res = await c.callTool("x", {});
    expect(res.content[0]?.text).toBe("ok");
    expect(authorizations).toBe(1); // one authorize for the fresh token
    await c.close();
  });
});

// ---------- RFC 9728 protected-resource discovery ----------

const PRM_PATH_URL = "https://srv/.well-known/oauth-protected-resource/mcp";
const PRM_ROOT_URL = "https://srv/.well-known/oauth-protected-resource";
const PRM = {
  resource: "https://srv/mcp",
  authorization_servers: ["https://idp"],
  scopes_supported: ["prm-a", "prm-b"],
};

/** Scripted transport with selectable PRM availability (path-inserted / root
 *  variants), plus the AS metadata / DCR / token endpoints discovery feeds. */
function discoveryTransport(
  opts: { path?: boolean; root?: boolean; prm?: Record<string, unknown> | null; tokenResult?: Record<string, unknown> } = {},
): { t: HttpTransport; reqs: HttpTransportRequest[] } {
  const prm = "prm" in opts ? opts.prm : PRM;
  const reqs: HttpTransportRequest[] = [];
  const t: HttpTransport = async (req) => {
    reqs.push(req);
    if (req.url === PRM_PATH_URL) return opts.path !== false && prm ? resp(200, prm) : resp(404, {});
    if (req.url === PRM_ROOT_URL) return opts.root !== false && prm ? resp(200, prm) : resp(404, {});
    if (req.url.endsWith("/.well-known/oauth-authorization-server")) return resp(200, METADATA);
    if (req.url === METADATA.registration_endpoint) return resp(200, { client_id: "client-1" });
    if (req.url === METADATA.token_endpoint) return resp(200, opts.tokenResult ?? { access_token: "at-1", expires_in: 3600 });
    return resp(404, {});
  };
  return { t, reqs };
}

function urls(reqs: HttpTransportRequest[]): string[] {
  return reqs.map((r) => r.url);
}

/** authorize stub: records the auth URL, completes the dance with a valid state. */
function echoAuthorize(seen?: string[]): NonNullable<McpOAuthConfig["authorize"]> {
  return async (url) => {
    seen?.push(url);
    const u = new URL(url);
    return `http://127.0.0.1/callback?code=c&state=${u.searchParams.get("state")}`;
  };
}

describe("OAuthSession — protected-resource discovery (RFC 9728)", () => {
  it("challenge resource_metadata steers discovery — that URL only, no guessed well-knowns", async () => {
    const { store } = memStore();
    const reqs: HttpTransportRequest[] = [];
    const t: HttpTransport = async (req) => {
      reqs.push(req);
      if (req.url === "https://custom/prm") return resp(200, PRM);
      if (req.url.endsWith("/.well-known/oauth-authorization-server")) return resp(200, METADATA);
      if (req.url === METADATA.registration_endpoint) return resp(200, { client_id: "client-1" });
      if (req.url === METADATA.token_endpoint) return resp(200, { access_token: "at-1" });
      return resp(404, {});
    };
    const s = new OAuthSession({ tokenStore: store, serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize() }, "key");
    s.noteUnauthorized(`Bearer resource_metadata="https://custom/prm", scope="bill"`);
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(urls(reqs)[0]).toBe("https://custom/prm");
    expect(urls(reqs).some((u) => u.includes("oauth-protected-resource"))).toBe(false);
  });

  it("path-inserted 404 → root fallback wins; full request order pinned", async () => {
    const { store } = memStore();
    const { t, reqs } = discoveryTransport({ path: false, root: true });
    const s = new OAuthSession({ tokenStore: store, serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize() }, "key");
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(urls(reqs)).toEqual([PRM_PATH_URL, PRM_ROOT_URL, "https://idp/.well-known/oauth-authorization-server", METADATA.registration_endpoint, METADATA.token_endpoint]);
  });

  it("path-inserted hit → root never requested", async () => {
    const { store } = memStore();
    const { t, reqs } = discoveryTransport({ path: true, root: true });
    const s = new OAuthSession({ tokenStore: store, serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize() }, "key");
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(urls(reqs)[0]).toBe(PRM_PATH_URL);
    expect(urls(reqs)).not.toContain(PRM_ROOT_URL);
  });

  it("challenge URL identical to the path-inserted candidate → fetched once, not twice", async () => {
    const { store } = memStore();
    const { t, reqs } = discoveryTransport({ path: true, root: true });
    const s = new OAuthSession({ tokenStore: store, serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize() }, "key");
    s.noteUnauthorized(`Bearer resource_metadata="${PRM_PATH_URL}"`);
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(urls(reqs).filter((u) => u === PRM_PATH_URL)).toHaveLength(1);
    expect(urls(reqs)).not.toContain(PRM_ROOT_URL);
  });

  it("all candidates fail, or neither serverUrl nor challenge → clear error", async () => {
    const { t } = discoveryTransport({ path: false, root: false });
    const s = new OAuthSession({ tokenStore: memStore().store, serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize() }, "key");
    await expect(s.getAccessToken()).rejects.toThrow(/Protected-resource discovery failed/);
    const s2 = new OAuthSession({ tokenStore: memStore().store, transport: t, authorize: echoAuthorize() }, "key");
    await expect(s2.getAccessToken()).rejects.toThrow(/`authorizationServer` or `serverUrl`/);
  });

  it("pre-configured authorizationServer → zero PRM requests", async () => {
    const { store } = memStore();
    const { t, reqs } = discoveryTransport({ path: true, root: true });
    const s = new OAuthSession({ tokenStore: store, authorizationServer: "https://idp", transport: t, authorize: echoAuthorize() }, "key");
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(urls(reqs).some((u) => u.includes("oauth-protected-resource"))).toBe(false);
  });

  it("RFC 8707 resource: PRM resource on authorize + both grant bodies (discovered)", async () => {
    const { store } = memStore();
    const authUrls: string[] = [];
    const { t, reqs } = discoveryTransport({ path: true, root: false, tokenResult: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 } });
    const s = new OAuthSession({ tokenStore: store, serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize(authUrls) }, "key");
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(new URL(authUrls[0]!).searchParams.get("resource")).toBe("https://srv/mcp");
    const codeBody = new URLSearchParams(reqs[reqs.length - 1]!.body as string);
    expect(codeBody.get("grant_type")).toBe("authorization_code");
    expect(codeBody.get("resource")).toBe("https://srv/mcp");
    // Refresh grant carries it too.
    await s.invalidateAccessToken();
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    const refreshBody = new URLSearchParams(reqs[reqs.length - 1]!.body as string);
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("resource")).toBe("https://srv/mcp");
  });

  it("RFC 8707 resource falls back to serverUrl when the issuer was pre-configured", async () => {
    const { store } = memStore();
    const authUrls: string[] = [];
    const { t } = discoveryTransport({ path: true, root: true });
    const s = new OAuthSession({ tokenStore: store, authorizationServer: "https://idp", serverUrl: "https://srv/mcp", transport: t, authorize: echoAuthorize(authUrls) }, "key");
    await expect(s.getAccessToken()).resolves.toBe("at-1");
    expect(new URL(authUrls[0]!).searchParams.get("resource")).toBe("https://srv/mcp");
  });

  it("scope selection: config wins → challenge → PRM scopes_supported → omitted", async () => {
    // PRM scopes_supported (no challenge, no config).
    const authUrls: string[] = [];
    const s = new OAuthSession({ tokenStore: memStore().store, serverUrl: "https://srv/mcp", transport: discoveryTransport().t, authorize: echoAuthorize(authUrls) }, "key");
    await s.getAccessToken();
    expect(new URL(authUrls[0]!).searchParams.get("scope")).toBe("prm-a prm-b");

    // Challenge scope outranks the PRM's.
    const authUrls2: string[] = [];
    const s2 = new OAuthSession({ tokenStore: memStore().store, serverUrl: "https://srv/mcp", transport: discoveryTransport().t, authorize: echoAuthorize(authUrls2) }, "key");
    s2.noteUnauthorized(`Bearer scope="bill"`);
    await s2.getAccessToken();
    expect(new URL(authUrls2[0]!).searchParams.get("scope")).toBe("bill");

    // Explicit config outranks everything.
    const authUrls3: string[] = [];
    const s3 = new OAuthSession({ tokenStore: memStore().store, serverUrl: "https://srv/mcp", scopes: ["cfg"], transport: discoveryTransport().t, authorize: echoAuthorize(authUrls3) }, "key");
    s3.noteUnauthorized(`Bearer scope="bill"`);
    await s3.getAccessToken();
    expect(new URL(authUrls3[0]!).searchParams.get("scope")).toBe("cfg");

    // Nothing anywhere → parameter omitted.
    const authUrls4: string[] = [];
    const s4 = new OAuthSession({ tokenStore: memStore().store, serverUrl: "https://srv/mcp", transport: discoveryTransport({ prm: { resource: "https://srv/mcp", authorization_servers: ["https://idp"] } }).t, authorize: echoAuthorize(authUrls4) }, "key");
    await s4.getAccessToken();
    expect(new URL(authUrls4[0]!).searchParams.has("scope")).toBe(false);
  });
});

describe("OAuthSession — silentAccessToken (non-interactive best effort)", () => {
  it("empty store → undefined; never touches the authorize callback", async () => {
    let authorizations = 0;
    const s = new OAuthSession({ tokenStore: memStore().store, transport: discoveryTransport().t, authorize: async () => { authorizations += 1; return "http://127.0.0.1/callback"; } }, "key");
    await expect(s.silentAccessToken()).resolves.toBeUndefined();
    expect(authorizations).toBe(0);
  });

  it("unexpired cached token → returned as-is, zero network", async () => {
    const { store } = memStore({ key: { accessToken: "fresh", expiresAt: Date.now() + 60_000 } });
    const { t, reqs } = discoveryTransport();
    const s = new OAuthSession({ tokenStore: store, transport: t, authorize: echoAuthorize() }, "key");
    await expect(s.silentAccessToken()).resolves.toBe("fresh");
    expect(reqs).toHaveLength(0);
  });

  it("expired token + refresh token → one silent refresh; failed refresh → undefined, still no authorize", async () => {
    const { store } = memStore({ key: { accessToken: "stale", refreshToken: "rt-1", expiresAt: Date.now() - 1_000 } });
    const ok = discoveryTransport();
    const s = new OAuthSession({ tokenStore: store, authorizationServer: "https://idp", transport: ok.t, authorize: echoAuthorize() }, "key");
    await expect(s.silentAccessToken()).resolves.toBe("at-1");
    expect(new URLSearchParams(ok.reqs[ok.reqs.length - 1]!.body as string).get("grant_type")).toBe("refresh_token");

    const failing = discoveryTransport({ tokenResult: null as unknown as Record<string, unknown> });
    const reqs: HttpTransportRequest[] = [];
    const t: HttpTransport = async (req) => {
      reqs.push(req);
      if (req.url === METADATA.token_endpoint) return resp(400, { error: "invalid_grant" });
      return failing.t(req);
    };
    const { store: s2store } = memStore({ key: { accessToken: "stale", refreshToken: "rt-1", expiresAt: Date.now() - 1_000 } });
    let authorizations = 0;
    const s2 = new OAuthSession({ tokenStore: s2store, authorizationServer: "https://idp", transport: t, authorize: async () => { authorizations += 1; return "http://127.0.0.1/callback"; } }, "key");
    await expect(s2.silentAccessToken()).resolves.toBeUndefined();
    expect(authorizations).toBe(0);
  });
});

// ---------- http transport: lazy authorization + discovery, end to end ----------

/** A successful MCP JSON-RPC response handler for the scripted server. */
function mcpOk(req: HttpTransportRequest): HttpTransportResponse {
  const body = JSON.parse(req.body ?? "{}") as { method?: string; id?: number };
  if (req.method === "DELETE") return { status: 200, statusText: "OK", headers: {}, body: bodyOf("") };
  if (body.id === undefined) return { status: 202, statusText: "Accepted", headers: {}, body: bodyOf("") };
  if (body.method === "initialize") {
    return resp(200, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } } }, { "mcp-session-id": "s-1" });
  }
  return resp(200, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
}

describe("http transport — lazy authorization + discovery", () => {
  it("unauthenticated first request → 401 challenge → PRM discovery → DCR → authorize → replay, transparently", async () => {
    const { store } = memStore();
    let authorizations = 0;
    const reqs: HttpTransportRequest[] = [];
    const t: HttpTransport = async (req) => {
      reqs.push(req);
      if (req.url === "https://srv/mcp") {
        if (req.headers["authorization"] === "Bearer at-1") return mcpOk(req);
        return resp(401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${PRM_PATH_URL}", scope="bill"` });
      }
      if (req.url === PRM_PATH_URL) return resp(200, PRM);
      if (req.url === PRM_ROOT_URL) return resp(404, {});
      if (req.url.endsWith("/.well-known/oauth-authorization-server")) return resp(200, METADATA);
      if (req.url === METADATA.registration_endpoint) return resp(200, { client_id: "c1" });
      if (req.url === METADATA.token_endpoint) return resp(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
      return resp(404, {});
    };
    const mt = createHttpMcpTransport({
      url: "https://srv/mcp",
      transport: t,
      auth: {
        tokenStore: store,
        transport: t,
        authorize: async (url) => {
          authorizations += 1;
          return `http://127.0.0.1/callback?code=c&state=${new URL(url).searchParams.get("state")}`;
        },
      },
    });

    const c = new McpClient({ transport: mt, requestTimeoutMs: 2_000 });
    await c.connect();
    const res = await c.callTool("x", {});
    expect(res.content[0]?.text).toBe("ok");

    const mcpPosts = reqs.filter((r) => r.url === "https://srv/mcp" && r.method === "POST");
    expect(mcpPosts[0]!.headers["authorization"]).toBeUndefined(); // bare request first
    expect(mcpPosts.some((r) => r.headers["authorization"] === "Bearer at-1")).toBe(true);
    expect(authorizations).toBe(1);
    // Discovery: challenge URL (== path-inserted) fetched exactly once, root never needed.
    expect(urls(reqs).filter((u) => u === PRM_PATH_URL)).toHaveLength(1);
    expect(urls(reqs)).not.toContain(PRM_ROOT_URL);
    await c.close();
  });

  it("auth configured but the server accepts unauthenticated → no authorize, no token traffic", async () => {
    const { store } = memStore();
    let authorizations = 0;
    const reqs: HttpTransportRequest[] = [];
    const t: HttpTransport = async (req) => {
      reqs.push(req);
      if (req.url === "https://srv/mcp") return mcpOk(req);
      return resp(404, {}); // any OAuth endpoint hit would be a bug
    };
    const mt = createHttpMcpTransport({
      url: "https://srv/mcp",
      transport: t,
      auth: {
        tokenStore: store,
        transport: t,
        authorize: async () => {
          authorizations += 1;
          return "http://127.0.0.1/callback?code=c&state=s";
        },
      },
    });

    const c = new McpClient({ transport: mt, requestTimeoutMs: 2_000 });
    await c.connect();
    const res = await c.callTool("x", {});
    expect(res.content[0]?.text).toBe("ok");
    expect(authorizations).toBe(0);
    expect(urls(reqs).every((u) => u === "https://srv/mcp")).toBe(true);
    expect(reqs.every((r) => r.headers["authorization"] === undefined)).toBe(true);
    await c.close();
  });
});
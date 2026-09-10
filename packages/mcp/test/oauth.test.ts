// OAuth 2.1 (RFC 9728 browser-based) for the HTTP transport: caching, refresh,
// full authorize flow (RFC 8414 discovery + DCR + PKCE), CSRF state check, and
// the 401→refresh→replay loop at the transport boundary.

import { describe, expect, it } from "vitest";
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from "@lingjing-agent/core";
import { McpClient } from "../src/client.js";
import { createHttpMcpTransport } from "../src/http-transport.js";
import { OAuthSession, type OAuthTokens, type TokenStore } from "../src/oauth.js";
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
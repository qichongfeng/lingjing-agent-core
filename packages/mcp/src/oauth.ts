// OAuth 2.1 (RFC 9728 browser-based, as used for MCP) for the HTTP transport.
//
// Zero deps: authorization-server discovery (RFC 8414), Dynamic Client
// Registration (DCR), the authorization-code + PKCE flow, and token refresh all
// ride the host's HttpTransport. The ONE step we do not do here is the
// interactive browser dance — opening a browser and capturing the redirect is
// environment-specific (CLI vs desktop vs mini-program), so the host supplies an
// `authorize(url)` callback that returns the redirected URL.
//
// These helpers assume a runtime with `crypto` (Node 18+, browsers, Edge) —
// the interactive OAuth flow is a browser/desktop scenario, never a WeChat
// mini-program, so `crypto.getRandomValues` / `crypto.subtle` are acceptable here.

import { concatBytes, decodeUtf8, fetchTransport, type HttpTransport } from "@lingjing-agent/core";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms at which `accessToken` expires (derived from `expires_in`). */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

/** Persistence seam — keychain (Claude Code), a file, or in-memory. */
export interface TokenStore {
  get(key: string): Promise<OAuthTokens | undefined>;
  set(key: string, tokens: OAuthTokens): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface McpOAuthConfig {
  /** Persist/load tokens across sessions. Required. */
  tokenStore: TokenStore;
  /** Storage key under which tokens are kept. Defaults to `mcp:` + server url. */
  key?: string;
  /** Pre-registered OAuth client (static registration). Provide either this
   *  (+ optionally clientSecret) or authorizationServer (DCR). */
  clientId?: string;
  clientSecret?: string;
  /** Authorization-server issuer URL → RFC 8414 discovery + Dynamic Client
   *  Registration when clientId is absent. */
  authorizationServer?: string;
  /** Space-separated / array of OAuth scopes to request. */
  scopes?: string[];
  /** Host-provided interactive step: receives the authorization URL, resolves
   *  with the redirect URL the user landed on (carries `code`). */
  authorize?: (authorizationUrl: string) => Promise<string>;
  /** Underlying HttpTransport for discovery/DCR/token requests. Default fetchTransport(). */
  transport?: HttpTransport;
}

interface ServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

class OAuthError extends Error {
  override readonly name = "McpOAuthError";
}

/** RFC 8414 §5: insert /.well-known/oauth-authorization-server between the
 *  host and path components of the issuer — NOT append at the end. An issuer
 *  like https://auth.example.com/realms/myrealm (Keycloak) must yield
 *  https://auth.example.com/.well-known/oauth-authorization-server/realms/myrealm;
 *  appending would 404 against every AS whose issuer has a path. */
function wellKnownUrl(issuer: string): string {
  const base = issuer.replace(/\/+$/, "");
  const pathStart = base.indexOf("/", base.indexOf("://") + 3);
  return pathStart === -1
    ? `${base}/.well-known/oauth-authorization-server`
    : `${base.slice(0, pathStart)}/.well-known/oauth-authorization-server${base.slice(pathStart)}`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is present where crypto is; encode → base64url.
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** cryptographically-random PKCE code verifier + S256 challenge. */
async function buildPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomHex(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  return { verifier, challenge };
}

async function parseJson(resp: { status: number; body: AsyncIterable<Uint8Array> }): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const c of resp.body) chunks.push(c);
  return JSON.parse(decodeUtf8(concatBytes(chunks)));
}

async function postJson(
  transport: HttpTransport,
  url: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const payload = new URLSearchParams(body).toString();
  const resp = await transport({
    url,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: payload,
    signal: controller.signal,
  });
  const parsed = (await parseJson(resp)) as Record<string, unknown>;
  if (resp.status >= 400) {
    const desc = typeof parsed["error_description"] === "string" ? parsed["error_description"] : resp.status;
    throw new OAuthError(`OAuth token request failed (${resp.status}): ${desc}`);
  }
  return parsed;
}

export class OAuthSession {
  private metadata: ServerMetadata | undefined;
  private clientId: string | undefined;
  private clientSecret: string | undefined;
  /** In-memory mirror of the store — avoids a store read (keychain/file I/O)
   *  per JSON-RPC message. Reset by clearTokens(); the access token is
   *  invalidated in place by invalidateAccessToken() (401 replay). */
  private memo: OAuthTokens | undefined;
  /** Single-flight: concurrent callers at expiry share ONE refresh/authorize —
   *  with refresh-token rotation, parallel refreshes with the same token all
   *  but the first fail (invalid_grant). */
  private acquiring: Promise<string> | undefined;

  constructor(
    private readonly config: McpOAuthConfig,
    private readonly key: string,
  ) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
  }

  private transport(): HttpTransport {
    return this.config.transport ?? fetchTransport();
  }

  /** Forget cached tokens so the next getAccessToken() re-acquires from scratch
   *  (full reset — drops the refresh token too). */
  async clearTokens(): Promise<void> {
    this.memo = undefined;
    await this.config.tokenStore.clear(this.key);
  }

  /**
   * The access token was rejected (HTTP 401): mark ONLY it as expired so the
   * next getAccessToken() runs the refresh grant. Discarding the refresh token
   * here (clearTokens) would force an interactive re-authorization even though
   * the refresh token is typically still valid — rotation invalidated the
   * ACCESS token, not the session.
   */
  async invalidateAccessToken(): Promise<void> {
    const cached = this.memo ?? (await this.config.tokenStore.get(this.key));
    if (cached === undefined) return;
    const expired: OAuthTokens = { ...cached, expiresAt: 0 };
    this.memo = expired;
    await this.config.tokenStore.set(this.key, expired);
  }

  /** Best-effort: a fresh access token, acquiring/refreshing as needed. */
  async getAccessToken(): Promise<string> {
    this.acquiring ??= this.acquire().finally(() => {
      this.acquiring = undefined;
    });
    return this.acquiring;
  }

  private async acquire(): Promise<string> {
    const cached = this.memo ?? (await this.config.tokenStore.get(this.key));
    this.memo = cached;
    if (cached && cached.expiresAt === undefined) {
      // No expiry known — treat as long-lived.
      return cached.accessToken;
    }
    if (cached && cached.expiresAt && cached.expiresAt > Date.now() + 30_000) {
      return cached.accessToken;
    }
    if (cached?.refreshToken) {
      try {
        const fresh = await this.refresh(cached.refreshToken);
        return fresh.accessToken;
      } catch {
        // Fall through to a full (re)authorization.
      }
    }
    return (await this.authorizeFlow()).accessToken;
  }

  private async refresh(refreshToken: string): Promise<OAuthTokens> {
    const meta = await this.requireMetadata();
    const tokens = await this.exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
      ...(this.clientId ? { client_id: this.clientId } : {}),
    }, meta);
    const stored = toStored(tokens);
    await this.config.tokenStore.set(this.key, stored);
    this.memo = stored;
    return stored;
  }

  private async authorizeFlow(): Promise<OAuthTokens> {
    if (!this.config.authorize) {
      throw new OAuthError(
        "No cached token and no `authorize` callback — a fresh token requires the host's interactive OAuth step",
      );
    }
    const meta = await this.requireMetadata();
    if (!this.clientId) {
      await this.registerClient(meta);
    }
    const { verifier, challenge } = await buildPkce();
    const state = randomHex(16);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId!,
      redirect_uri: this.redirectUri(),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    if (this.config.scopes?.length) params.set("scope", this.config.scopes.join(" "));
    const authUrl = `${meta.authorization_endpoint}?${params.toString()}`;

    const redirect = await this.config.authorize(authUrl);
    const redirectUrl = new URL(redirect);
    const code = redirectUrl.searchParams.get("code");
    const returnedState = redirectUrl.searchParams.get("state");
    if (!code) throw new OAuthError("Authorization redirect did not carry a `code`");
    if (returnedState !== state) throw new OAuthError("OAuth state mismatch — possible CSRF");

    const tokens = await this.exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri(),
      code_verifier: verifier,
      client_id: this.clientId!,
      ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
    }, meta);
    const stored = toStored(tokens);
    await this.config.tokenStore.set(this.key, stored);
    this.memo = stored;
    return stored;
  }

  private async exchange(
    body: Record<string, string>,
    meta: ServerMetadata,
  ): Promise<Record<string, unknown>> {
    return postJson(this.transport(), meta.token_endpoint, body);
  }

  private async requireMetadata(): Promise<ServerMetadata> {
    if (this.metadata) return this.metadata;
    if (!this.config.authorizationServer) {
      throw new OAuthError("OAuth requires `authorizationServer` (for discovery) or explicit endpoints");
    }
    const controller = new AbortController();
    const resp = await this.transport()({
      url: wellKnownUrl(this.config.authorizationServer),
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (resp.status >= 400) {
      throw new OAuthError(`Authorization server discovery failed (${resp.status})`);
    }
    const m = (await parseJson(resp)) as ServerMetadata;
    if (!m.authorization_endpoint || !m.token_endpoint) {
      throw new OAuthError("Authorization server metadata missing authorization_endpoint/token_endpoint");
    }
    this.metadata = m;
    return m;
  }

  private async registerClient(meta: ServerMetadata): Promise<void> {
    if (!meta.registration_endpoint) {
      throw new OAuthError("No clientId and no registration_endpoint — dynamic client registration unavailable");
    }
    const controller = new AbortController();
    const resp = await this.transport()({
      url: meta.registration_endpoint,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [this.redirectUri()], token_endpoint_auth_method: "none", ...(this.config.scopes?.length ? { scope: this.config.scopes.join(" ") } : {}) }),
      signal: controller.signal,
    });
    if (resp.status >= 400) {
      throw new OAuthError(`Dynamic client registration failed (${resp.status})`);
    }
    const reg = (await parseJson(resp)) as { client_id?: string; client_secret?: string };
    if (!reg.client_id) throw new OAuthError("Dynamic client registration did not return a client_id");
    this.clientId = reg.client_id;
    this.clientSecret = reg.client_secret;
  }

  private redirectUri(): string {
    // Default loopback; hosts with a custom scheme may override via a future config field.
    return "http://127.0.0.1/callback";
  }
}

function toStored(raw: Record<string, unknown>): OAuthTokens {
  const accessToken = raw["access_token"];
  if (typeof accessToken !== "string") throw new OAuthError("Token response missing access_token");
  const out: OAuthTokens = { accessToken };
  if (typeof raw["refresh_token"] === "string") out.refreshToken = raw["refresh_token"];
  const expiresIn = raw["expires_in"];
  if (typeof expiresIn === "number" || (typeof expiresIn === "string" && !Number.isNaN(Number(expiresIn)))) {
    out.expiresAt = Date.now() + Number(expiresIn) * 1000;
  }
  if (typeof raw["token_type"] === "string") out.tokenType = raw["token_type"];
  if (typeof raw["scope"] === "string") out.scope = raw["scope"];
  return out;
}
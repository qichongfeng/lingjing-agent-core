// OAuth 2.1 (RFC 9728 browser-based, as used for MCP) for the HTTP transport.
//
// Zero deps: protected-resource discovery (RFC 9728) when the issuer is not
// pre-configured, authorization-server discovery (RFC 8414), Dynamic Client
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
   *  Registration when clientId is absent. Optional: when absent, the issuer is
   *  discovered via RFC 9728 protected-resource metadata from the MCP server
   *  (`serverUrl`, injected automatically by the HTTP transport). */
  authorizationServer?: string;
  /** The MCP server URL this auth protects. Injected automatically by
   *  createMcpTools / createHttpMcpTransport from their `url` — hosts never
   *  set it. Drives RFC 9728 discovery (when `authorizationServer` is absent)
   *  and the RFC 8707 `resource` parameter on authorize/token requests. */
  serverUrl?: string;
  /** Space-separated / array of OAuth scopes to request. */
  scopes?: string[];
  /** Host-provided interactive step: receives the authorization URL, resolves
   *  with the redirect URL the user landed on (carries `code`). */
  authorize?: (authorizationUrl: string) => Promise<string>;
  /** Redirect URI for the authorization-code flow. Default loopback
   *  `http://127.0.0.1/callback` (CLI hosts with a local listener); browser
   *  hosts pass their https landing page — registered verbatim with DCR and
   *  sent at authorize/exchange, so it must match exactly on both sides. */
  redirectUri?: string;
  /** Underlying HttpTransport for discovery/DCR/token requests. Default fetchTransport(). */
  transport?: HttpTransport;
}

interface ServerMetadata {
  /** MUST equal the issuer the well-known URL was built from (RFC 8414 §3.3 /
   *  OIDC §4.3 — anti-poisoning check; a mismatched document is rejected). */
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

class OAuthError extends Error {
  override readonly name = "McpOAuthError";
}

/** RFC 8414 + OIDC Discovery candidates, in the priority order the MCP auth
 *  spec prescribes (clients MUST try multiple endpoints): oauth-authorization-
 *  server (path-INSERTED, RFC 8414 §5 — an issuer like https://auth.example.com/
 *  realms/myrealm yields …/.well-known/oauth-authorization-server/realms/myrealm,
 *  appending would 404 against every path-carrying issuer), then the two OIDC
 *  forms (path-inserted, path-appended) for ASes that only speak OpenID Connect
 *  Discovery. No-path issuers try the two root suffixes. */
function wellKnownCandidates(issuer: string): string[] {
  const base = issuer.replace(/\/+$/, "");
  const pathStart = base.indexOf("/", base.indexOf("://") + 3);
  if (pathStart === -1) {
    return [`${base}/.well-known/oauth-authorization-server`, `${base}/.well-known/openid-configuration`];
  }
  const origin = base.slice(0, pathStart);
  const path = base.slice(pathStart);
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

/** RFC 9728 well-known candidates for an MCP server URL, in the order the MCP
 *  auth spec prescribes: path-inserted first (…/.well-known/oauth-protected-
 *  resource/api/bill/mcp), then the root fallback (…/.well-known/oauth-
 *  protected-resource). Same-origin dedupe happens at the call site. */
function protectedResourceUrls(serverUrl: string): string[] {
  const base = serverUrl.replace(/\/+$/, "");
  const pathStart = base.indexOf("/", base.indexOf("://") + 3);
  if (pathStart === -1) return [`${base}/.well-known/oauth-protected-resource`];
  const origin = base.slice(0, pathStart);
  const path = base.slice(pathStart);
  return [`${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`];
}

/** Extract `resource_metadata` / `scope` from a WWW-Authenticate value. A
 *  response can stack several challenges (`Basic …, Bearer …`); we slice from
 *  the first Bearer challenge and read quoted-or-bare params, first-wins per
 *  key (a param after a *second* challenge could bleed in — we only read two
 *  well-known keys, acceptable). */
function parseBearerChallenge(header: string): { resourceMetadata?: string; scope?: string } {
  const idx = header.search(/\bbearer\s/i);
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  for (const m of header.slice(idx).matchAll(/([a-z_]+)\s*=\s*(?:"([^"]*)"|([^\s",]+))/gi)) {
    const key = m[1]!.toLowerCase();
    if (params[key] === undefined) params[key] = m[2] ?? m[3] ?? "";
  }
  const out: { resourceMetadata?: string; scope?: string } = {};
  if (params["resource_metadata"]) out.resourceMetadata = params["resource_metadata"];
  if (params["scope"]) out.scope = params["scope"];
  return out;
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
  /** Single-flight for the non-interactive path (silentAccessToken) — same
   *  rotation hazard as `acquiring`, separate domain so a silent peek never
   *  queues behind an interactive authorize (and vice versa). */
  private silent: Promise<string | undefined> | undefined;
  /** Issuer discovered via RFC 9728 protected-resource metadata. Assigned only
   *  on success (a transient failure must not poison later attempts). */
  private issuer: string | undefined;
  /** `resource` / `scopes_supported` from the discovered PRM document — feed
   *  resourceFor()/scopesFor() once discovery has run. */
  private prmResource: string | undefined;
  private prmScopes: string[] | undefined;
  /** Last noted 401 challenge (WWW-Authenticate) — its resource_metadata URL
   *  takes priority over the guessed well-known candidates, its scope hints
   *  the scope to request. */
  private challenge: { resourceMetadata?: string; scope?: string } | undefined;

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

  /** Note the WWW-Authenticate challenge of a 401 response: its
   *  resource_metadata URL takes priority in PRM discovery and its scope hints
   *  the scope to request. Pure and synchronous; last call wins. */
  noteUnauthorized(wwwAuthenticate: string): void {
    this.challenge = parseBearerChallenge(wwwAuthenticate);
  }

  /** Best token obtainable WITHOUT interaction: unexpired cached token, else
   *  one refresh-grant attempt (failure → undefined). Never runs the
   *  authorizeFlow — the interactive dance is reachable only from the
   *  transport's 401 replay path, so a server that accepts unauthenticated
   *  requests never pops a window. Undefined simply means "no header". */
  async silentAccessToken(): Promise<string | undefined> {
    this.silent ??= this.silentAcquire().finally(() => {
      this.silent = undefined;
    });
    return this.silent;
  }

  private async silentAcquire(): Promise<string | undefined> {
    const cached = this.memo ?? (await this.config.tokenStore.get(this.key));
    this.memo = cached;
    if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now() + 30_000)) {
      return cached.accessToken;
    }
    if (cached?.refreshToken) {
      try {
        return (await this.refresh(cached.refreshToken)).accessToken;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** RFC 9728: find the authorization server from the MCP server's protected-
   *  resource metadata. Candidates in priority order: the URL the 401
   *  challenge pointed at (if any), then the path-inserted well-known, then
   *  the root one — deduped, since the challenge usually echoes path-inserted.
   *  A candidate wins only on 2xx + parseable JSON + a non-empty
   *  authorization_servers string array. */
  private async discoverIssuer(): Promise<string> {
    const candidates = [...new Set([
      ...(this.challenge?.resourceMetadata ? [this.challenge.resourceMetadata] : []),
      ...(this.config.serverUrl ? protectedResourceUrls(this.config.serverUrl) : []),
    ])];
    if (candidates.length === 0) {
      throw new OAuthError("OAuth requires `authorizationServer` or `serverUrl` (for protected-resource discovery)");
    }
    const failures: string[] = [];
    for (const url of candidates) {
      try {
        const controller = new AbortController();
        const resp = await this.transport()({
          url,
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (resp.status >= 400) {
          failures.push(`${url} → ${resp.status}`);
          continue;
        }
        const doc = (await parseJson(resp)) as {
          authorization_servers?: unknown;
          resource?: unknown;
          scopes_supported?: unknown;
        };
        const servers = doc.authorization_servers;
        const issuer = Array.isArray(servers) ? servers[0] : undefined;
        if (typeof issuer !== "string") {
          failures.push(`${url} → no authorization_servers`);
          continue;
        }
        this.issuer = issuer;
        if (typeof doc.resource === "string") this.prmResource = doc.resource;
        if (Array.isArray(doc.scopes_supported) && doc.scopes_supported.every((s) => typeof s === "string")) {
          this.prmScopes = doc.scopes_supported;
        }
        return issuer;
      } catch (err) {
        failures.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new OAuthError(`Protected-resource discovery failed (${failures.join("; ")})`);
  }

  /** Scopes to request: explicit config wins, else the 401 challenge's scope,
   *  else the PRM's scopes_supported, else omit the parameter (MCP spec's
   *  scope-selection strategy). */
  private scopesFor(): string[] | undefined {
    if (this.config.scopes?.length) return this.config.scopes;
    const fromChallenge = this.challenge?.scope?.trim().split(/\s+/).filter(Boolean);
    if (fromChallenge?.length) return fromChallenge;
    if (this.prmScopes?.length) return this.prmScopes;
    return undefined;
  }

  /** RFC 8707 resource indicator: the resource the token is for — the PRM's own
   *  `resource` field when discovery ran, else the MCP server URL. */
  private resourceFor(): string | undefined {
    return this.prmResource ?? this.config.serverUrl;
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
    const resource = this.resourceFor();
    const tokens = await this.exchange({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...(this.clientSecret ? { client_secret: this.clientSecret } : {}),
      ...(this.clientId ? { client_id: this.clientId } : {}),
      ...(resource !== undefined && { resource }),
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
    const scopes = this.scopesFor();
    if (scopes) params.set("scope", scopes.join(" "));
    const resource = this.resourceFor();
    if (resource !== undefined) params.set("resource", resource);
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
      ...(resource !== undefined && { resource }),
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
    // Pre-configured issuer wins outright (zero PRM requests); else discover it
    // once from the MCP server's protected-resource metadata (RFC 9728).
    const issuer = this.config.authorizationServer ?? (this.issuer ??= await this.discoverIssuer());
    const failures: string[] = [];
    for (const url of wellKnownCandidates(issuer)) {
      let m: ServerMetadata;
      try {
        const controller = new AbortController();
        const resp = await this.transport()({
          url,
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (resp.status >= 400) {
          failures.push(`${url} → ${resp.status}`);
          continue;
        }
        m = (await parseJson(resp)) as ServerMetadata;
      } catch (err) {
        failures.push(`${url} → ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // Anti-poisoning (RFC 8414 §3.3 / MCP auth spec MUST): the document's
      // issuer MUST equal the identifier the URL was built from — a mismatch
      // means the endpoints inside are someone else's; never use them.
      if (m.issuer !== issuer) {
        failures.push(`${url} → issuer mismatch (document claims ${JSON.stringify(m.issuer)})`);
        continue;
      }
      if (!m.authorization_endpoint || !m.token_endpoint) {
        failures.push(`${url} → missing authorization_endpoint/token_endpoint`);
        continue;
      }
      this.metadata = m;
      return m;
    }
    throw new OAuthError(`Authorization server discovery failed (${failures.join("; ")})`);
  }

  private async registerClient(meta: ServerMetadata): Promise<void> {
    if (!meta.registration_endpoint) {
      throw new OAuthError("No clientId and no registration_endpoint — dynamic client registration unavailable");
    }
    const controller = new AbortController();
    const scopes = this.scopesFor();
    const resp = await this.transport()({
      url: meta.registration_endpoint,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [this.redirectUri()], token_endpoint_auth_method: "none", ...(scopes ? { scope: scopes.join(" ") } : {}) }),
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
    // Default loopback (CLI hosts); browser hosts override via config.redirectUri.
    return this.config.redirectUri ?? "http://127.0.0.1/callback";
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
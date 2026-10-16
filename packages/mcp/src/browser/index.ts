// Browser host glue for MCP OAuth — the browser half of the runtime split
// (Node/stdio half lives in "@lingjing-agent/mcp/node"). Everything here is
// generic host plumbing: the popup authorization dance, a localStorage
// TokenStore, and the landing-page helper. App-specific decisions (the
// redirect landing route, credential seeding) arrive as parameters.
//
// window/localStorage are touched only inside functions, so importing this
// module in a non-browser runtime stays side-effect free.

import type { McpOAuthConfig, OAuthTokens, TokenStore } from "../oauth.js";

/** postMessage contract between openAuthorizePopup and the host's landing
 *  page (finishOAuthCallback): same-origin, carries the full redirect URL. */
const OAUTH_CALLBACK_MESSAGE = "lingjing-agent/mcp:oauth-callback";

/** localStorage-backed TokenStore. `seed` runs on a cache miss: returning a
 *  credential the host already holds (e.g. a paired token) makes the first
 *  acquire a silent refresh instead of the interactive dance — provided the
 *  server's refresh grant accepts it. */
function storeWithSeed(key: string, seed?: () => string | undefined): TokenStore {
  return {
    async get(k) {
      try {
        const raw = localStorage.getItem(k);
        if (raw) return JSON.parse(raw) as OAuthTokens;
      } catch {
        /* corrupt entry — treat as missing */
      }
      const seeded = seed?.();
      return seeded ? { accessToken: "", refreshToken: seeded, expiresAt: 0 } : undefined;
    },
    async set(k, tokens) {
      try {
        localStorage.setItem(k, JSON.stringify(tokens));
      } catch {
        /* private mode: OAuthSession's in-memory memo still works */
      }
    },
    async clear(k) {
      try {
        localStorage.removeItem(k);
      } catch {
        /* same */
      }
    },
  };
}

/** The interactive step the core OAuth flow delegates to the host: open the
 *  authorization URL in a popup (user confirms there), resolve with the URL
 *  of the redirect landing page (carries `code`). Manual popup close = abort.
 *  Only same-origin messages with our contract type are accepted. */
function openAuthorizePopup(authUrl: string): Promise<string> {
  const popup = window.open(authUrl, "mcp-oauth", "popup=yes,width=480,height=680");
  if (!popup) throw new Error("authorization popup was blocked — allow popups and retry");
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(watch);
      window.removeEventListener("message", onMessage);
      try {
        popup.close();
      } catch {
        /* already closed */
      }
    };
    const watch = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error("authorization cancelled"));
      }
    }, 500);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type !== OAUTH_CALLBACK_MESSAGE || typeof data.url !== "string") return;
      cleanup();
      resolve(data.url);
    };
    window.addEventListener("message", onMessage);
  });
}

/** Assemble the browser-host auth config. `redirectUri` is the host's landing
 *  page (must match what the server has registered / what DCR will register);
 *  `seed` optionally reuses a credential the host already holds. */
export function browserOAuth(opts: {
  /** Authorization-server issuer (discovery + DCR base). */
  server: string;
  /** TokenStore key for this server. */
  key: string;
  /** The host's https landing page the authorization code redirects to. */
  redirectUri: string;
  /** Existing credential to seed the store with (silent first refresh). */
  seed?: () => string | undefined;
}): McpOAuthConfig {
  return {
    authorizationServer: opts.server,
    tokenStore: storeWithSeed(opts.key, opts.seed),
    key: opts.key,
    redirectUri: opts.redirectUri,
    authorize: openAuthorizePopup,
  };
}

/** Landing-page half of the dance (call from the redirect target route):
 *  hands the full URL (with `code`) back to the opening window and closes
 *  this one. Returns false when opened directly (no opener) — render a hint
 *  then. */
export function finishOAuthCallback(): boolean {
  if (!window.opener) return false;
  window.opener.postMessage(
    { type: OAUTH_CALLBACK_MESSAGE, url: window.location.href },
    window.location.origin,
  );
  window.close();
  return true;
}

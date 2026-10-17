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

/** localStorage-backed TokenStore (the default browser persistence). Keys
 *  arrive resolved from the session (its `key`, or the `mcp:` + url default
 *  when the host omits one). A corrupt entry reads as missing; a failed write
 *  (private mode) is non-fatal — OAuthSession's in-memory memo still works. */
function localStorageStore(): TokenStore {
  return {
    async get(k) {
      try {
        const raw = localStorage.getItem(k);
        if (raw) return JSON.parse(raw) as OAuthTokens;
      } catch {
        /* corrupt entry — treat as missing */
      }
      return undefined;
    },
    async set(k, tokens) {
      try {
        localStorage.setItem(k, JSON.stringify(tokens));
      } catch {
        /* private mode — see doc comment */
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
 *  Only same-origin messages with our contract type are accepted, and — when
 *  the authorization URL carries a state — only redirects whose state matches
 *  (concurrent dances must not resolve each other). */
async function openAuthorizePopup(authUrl: string): Promise<string> {
  const expectedState = new URL(authUrl).searchParams.get("state") ?? "";
  const popup = window.open(authUrl, "mcp-oauth", "popup=yes,width=480,height=680");
  // async fn: a blocked popup rejects (never a synchronous throw) — callers
  // awaiting `authorize(...)` get uniform promise semantics
  if (!popup) throw new Error("authorization popup was blocked — allow popups and retry");
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(watch);
      window.removeEventListener("message", onMessage);
      try {
        popup.close()
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
      let redirect: URL;
      try {
        redirect = new URL(data.url);
      } catch {
        return; // malformed — not our landing page
      }
      if (expectedState && redirect.searchParams.get("state") !== expectedState) return;
      cleanup();
      resolve(data.url);
    };
    window.addEventListener("message", onMessage);
  });
}

/** Assemble the browser-host auth config. `redirectUri` is the host's landing
 *  page (must match what the server has registered / what DCR will register);
 *  `server` (the authorization-server issuer) is optional — omitted, the issuer
 *  is discovered from the MCP server per RFC 9728 (401 → WWW-Authenticate /
 *  /.well-known/oauth-protected-resource); pass it to pre-configure/skip
 *  discovery. `key` is optional — omit it and the session's own default
 *  (`mcp:` + server url) applies; `store` optionally swaps the persistence
 *  backend (default: localStorage — pass IndexedDB, in-memory, … to control
 *  where tokens live while keeping the popup dance). */
export function browserOAuth(opts: {
  /** Authorization-server issuer; omit to discover it (RFC 9728) from the
   *  MCP server URL the transport injects. */
  server?: string;
  /** The host's https landing page the authorization code redirects to. */
  redirectUri: string;
  /** TokenStore key override; defaults to the session's `mcp:` + server url. */
  key?: string;
  /** Persistence backend override; defaults to localStorage. */
  store?: TokenStore;
}): McpOAuthConfig {
  return {
    tokenStore: opts.store ?? localStorageStore(),
    ...(opts.server !== undefined && { authorizationServer: opts.server }),
    ...(opts.key !== undefined ? { key: opts.key } : {}),
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

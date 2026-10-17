// Modern-era (2026-07-28+) wire rules, isolated from the legacy initialize
// handshake: per-request `_meta` identity, mirrored HTTP headers
// (MCP-Protocol-Version / Mcp-Method / Mcp-Name / Mcp-Param-*), the Base64
// sentinel value encoding, x-mcp-header schema extraction, strict
// server/discover parsing, probe-error classification, and the per-origin era
// cache. Pure functions + module state only — no transport I/O (McpClient owns
// the socket); wx-safe: no btoa/Buffer/URL globals (hand-rolled UTF-8 + base64).

/** The modern version this client asks for first. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** Modern (stateless, per-request-metadata) versions this client can speak. */
export const MODERN_KNOWN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/** Protocol-defined JSON-RPC error codes (sub-range MCP reserves). */
export const MCP_ERR_HEADER_MISMATCH = -32020;
export const MCP_ERR_MISSING_CAPABILITY = -32021;
export const MCP_ERR_UNSUPPORTED_VERSION = -32022;

/** `_meta` keys of the modern era (mandatory prefix per spec). */
export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export type McpEra = "legacy" | "modern";

// ---- UTF-8 + base64 (wx runtimes ship neither TextEncoder nor btoa) --------

/** UTF-8 encode with surrogate-pair awareness (pure JS, no globals). */
function encodeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2]!;
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f]!;
  }
  return out;
}

// ---- header value encoding -------------------------------------------------

/** RFC 9110 field-value: visible ASCII + space + horizontal tab only. */
function isPlainAsciiHeaderValue(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09 && (c < 0x21 || c > 0x7e)) return false;
  }
  return true;
}

/** The Base64 sentinel shape (case-sensitive, lowercase markers). */
const SENTINEL_RE = /^=\?base64\?.*\?=$/;

/**
 * Encode a header value per the transport's Value Encoding rules: plain-ASCII
 * values pass through; non-ASCII, control characters, leading/trailing spaces,
 * and any value already matching the sentinel pattern wrap as
 * `=?base64?{b64}?=` (servers must decode before comparing to the body).
 */
export function encodeHeaderValue(v: string): string {
  if (isPlainAsciiHeaderValue(v) && v === v.trim() && !SENTINEL_RE.test(v)) return v;
  return `=?base64?${bytesToBase64(encodeUtf8(v))}?=`;
}

/** Primitive → header string (spec Value Encoding): integer decimal, boolean
 * lowercase, string as-is (then run through encodeHeaderValue). null/undefined
 * and non-primitives omit the header (return undefined). */
export function encodePrimitiveHeaderValue(v: unknown): string | undefined {
  if (typeof v === "string") return encodeHeaderValue(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : undefined;
  return undefined;
}

// ---- per-request dressing --------------------------------------------------

/** The mandatory modern `_meta`: version + client identity + capabilities. */
export function modernMeta(version: string, clientInfo: { name: string; version: string }): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: version,
    [META_CLIENT_INFO]: { ...clientInfo },
    [META_CLIENT_CAPABILITIES]: {},
  };
}

/** `Mcp-Name` source per spec: tools/call + prompts/get → params.name,
 * resources/read → params.uri; every other method omits the header. */
function nameHeaderValue(method: string, params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const p = params as Record<string, unknown>;
  if (method === "tools/call" || method === "prompts/get") {
    return typeof p["name"] === "string" ? p["name"] : undefined;
  }
  if (method === "resources/read") {
    return typeof p["uri"] === "string" ? p["uri"] : undefined;
  }
  return undefined;
}

/**
 * The modern base header bag for one request: version + method (+ name for
 * tools/call / resources/read / prompts/get). Transport merges this last
 * (after its static/auth headers).
 */
export function modernHeaders(version: string, method: string, params: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "mcp-protocol-version": version,
    "mcp-method": method,
  };
  const name = nameHeaderValue(method, params);
  if (name !== undefined) headers["mcp-name"] = encodeHeaderValue(name);
  return headers;
}

/** `Mcp-Param-{Name}` mirrors for a tools/call — `registry` comes from
 *  extractHeaderAnnotations via listTools; absent/null values omit the header. */
export function modernParamHeaders(registry: ReadonlyMap<string, string>, params: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof params !== "object" || params === null) return headers;
  const args = (params as Record<string, unknown>)["arguments"];
  if (typeof args !== "object" || args === null) return headers;
  for (const [paramName, headerName] of registry) {
    if (!(paramName in (args as Record<string, unknown>))) continue;
    const encoded = encodePrimitiveHeaderValue((args as Record<string, unknown>)[paramName]);
    if (encoded !== undefined) headers[`mcp-param-${headerName}`] = encoded;
  }
  return headers;
}

// ---- x-mcp-header schema extraction -----------------------------------------

/** HTTP field-name token syntax (RFC 9110 §5.1). */
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface HeaderAnnotationResult {
  /** paramName → header name (the `{Name}` in `Mcp-Param-{Name}`). */
  valid: Map<string, string>;
  /** Human-readable reasons for rejected annotations (tool must be dropped). */
  invalid: string[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Extract `x-mcp-header` annotations from a tool inputSchema. Valid ONLY on
 * primitive (string/integer/boolean — `number` is spec-excluded) parameters
 * statically reachable through `properties` chains; an annotation anywhere
 * else (items, composition, $ref, the root) invalidates the whole tool.
 * Duplicate header names (case-insensitive) are ambiguous → invalid.
 */
export function extractHeaderAnnotations(schema: Record<string, unknown>): HeaderAnnotationResult {
  const result: HeaderAnnotationResult = { valid: new Map(), invalid: [] };
  const seenHeaders = new Set<string>(); // lower-cased

  // One depth-first walk over the entire JSON structure. `chain` = an
  // annotation on THIS node would be validly placed (node is root.properties.x
  // … reached solely through properties keys); properties children inherit the
  // parent's chain status, every other child (items/composition/generic) is
  // off-chain forever. The root starts chain=true but has no param name, so a
  // root annotation lands in `invalid` via the pname guard.
  (function walk(node: unknown, chain: boolean, pname: string | undefined, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((c, i) => walk(c, false, undefined, `${path}[${i}]`));
      return;
    }
    const r = asRecord(node);
    if (r === undefined) return;
    const ann = typeof r["x-mcp-header"] === "string" ? (r["x-mcp-header"] as string) : undefined;
    if (ann !== undefined) {
      const type = Array.isArray(r["type"]) ? undefined : r["type"];
      if (!chain || pname === undefined) {
        result.invalid.push(`${path}: x-mcp-header '${ann}' outside a properties chain`);
      } else if (ann === "" || !HEADER_TOKEN_RE.test(ann)) {
        result.invalid.push(`${path}: x-mcp-header '${ann}' is not a valid header name`);
      } else if (type !== "string" && type !== "integer" && type !== "boolean") {
        result.invalid.push(`${path}: x-mcp-header '${ann}' on unsupported type (spec: string/integer/boolean; number excluded)`);
      } else if (seenHeaders.has(ann.toLowerCase())) {
        result.invalid.push(`${path}: x-mcp-header '${ann}' duplicates an earlier header name`);
      } else {
        seenHeaders.add(ann.toLowerCase());
        result.valid.set(pname, ann);
      }
    }
    for (const [k, v] of Object.entries(r)) {
      if (k === "x-mcp-header") continue;
      if (k === "properties") {
        const props = asRecord(v);
        if (props !== undefined) {
          for (const [pk, pv] of Object.entries(props)) walk(pv, chain, pk, `${path}.properties.${pk}`);
        } else if (v !== null && typeof v === "object") {
          walk(v, false, undefined, `${path}.properties`);
        }
      } else if (v !== null && typeof v === "object") {
        walk(v, false, undefined, `${path}.${k}`);
      }
    }
  })(schema, true, undefined, "schema");

  return result;
}

// ---- server/discover + probe classification --------------------------------

export interface McpDiscoverResult {
  supportedVersions: string[];
  capabilities: Record<string, unknown>;
  instructions?: string;
  serverInfo?: { name: string; version: string };
}

/**
 * STRICT parse of a server/discover result — the era probe hinges on it: a
 * lenient parser would let legacy-shaped 200 bodies (test fakes, stateless
 * legacy servers answering anything) pass as modern and skip the handshake.
 */
export function parseDiscoverResult(v: unknown): McpDiscoverResult | undefined {
  const r = asRecord(v);
  if (r === undefined) return undefined;
  if (r["resultType"] !== "complete") return undefined;
  const versions = r["supportedVersions"];
  if (!Array.isArray(versions) || !versions.every((x) => typeof x === "string")) return undefined;
  const out: McpDiscoverResult = {
    supportedVersions: versions as string[],
    capabilities: asRecord(r["capabilities"]) ?? {},
  };
  const instructions = typeof r["instructions"] === "string" ? r["instructions"] : undefined;
  if (instructions !== undefined) out.instructions = instructions;
  const meta = asRecord(r["_meta"]);
  const info = meta === undefined ? undefined : asRecord(meta[META_SERVER_INFO]);
  if (info !== undefined && typeof info["name"] === "string" && typeof info["version"] === "string") {
    out.serverInfo = { name: info["name"], version: info["version"] };
  }
  return out;
}

/** Pick the highest modern version both sides speak from a -32022 supported list. */
export function pickModernVersion(supported: unknown): string | undefined {
  if (!Array.isArray(supported)) return undefined;
  let best: string | undefined;
  for (const v of supported) {
    if (typeof v !== "string") continue;
    if (!(MODERN_KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(v)) continue;
    if (best === undefined || v.localeCompare(best) > 0) best = v;
  }
  return best;
}

/** The shape McpHttpError parses out of an error-status body. */
export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export type ModernErrorKind =
  | { kind: "unsupported-version"; supported: unknown }
  | { kind: "header-mismatch" }
  | { kind: "missing-capability" }
  | { kind: "modern-not-found" }
  | { kind: "unrecognized" };

/** Classify an error-status HTTP failure the way the spec's era detection
 * reads a 400/404 body: recognized modern JSON-RPC errors identify a modern
 * server; anything else means "fall back to initialize". */
export function classifyModernHttpError(status: number, rpcError: RpcErrorShape | undefined): ModernErrorKind {
  if (rpcError === undefined) return { kind: "unrecognized" };
  if (status === 400) {
    if (rpcError.code === MCP_ERR_UNSUPPORTED_VERSION) {
      // Spec: error.data.supported is the version list — unwrap it here so
      // callers always see the array (or undefined).
      const d = typeof rpcError.data === "object" && rpcError.data !== null ? (rpcError.data as Record<string, unknown>) : undefined;
      return { kind: "unsupported-version", supported: d?.["supported"] };
    }
    if (rpcError.code === MCP_ERR_HEADER_MISMATCH) return { kind: "header-mismatch" };
    if (rpcError.code === MCP_ERR_MISSING_CAPABILITY) return { kind: "missing-capability" };
    return { kind: "unrecognized" };
  }
  if (status === 404) return { kind: "modern-not-found" }; // any JSON-RPC body on 404 = modern server identity
  return { kind: "unrecognized" };
}

/** MRTR (SEP-2322): a result carrying inputRequests needs client input we
 * cannot provide — detected before the regular result parsers mis-read it. */
export function isInputRequiredResult(v: unknown): v is { inputRequests: unknown[] } {
  const r = asRecord(v);
  return r !== undefined && Array.isArray(r["inputRequests"]) && (r["inputRequests"] as unknown[]).length > 0;
}

export class McpInputRequiredError extends Error {
  override readonly name = "McpInputRequiredError";
  readonly inputRequests: unknown[];
  constructor(inputRequests: unknown[]) {
    super(
      `MCP server returned an InputRequiredResult (${inputRequests.length} inputRequests) — ` +
        `Multi Round-Trip Requests are not supported by this bridge`,
    );
    this.inputRequests = inputRequests;
  }
}

// ---- per-origin era cache ----------------------------------------------------

// Era is a property of the server/origin, not of a client instance (spec:
// SHOULD cache for the origin). Module-level so it survives agent rebuilds in
// long-lived hosts (mini-program app lifetime). Not persisted (spec MAY).
const eraCache = new Map<string, McpEra>();

export function getCachedEra(key: string): McpEra | undefined {
  return eraCache.get(key);
}

export function setCachedEra(key: string, era: McpEra): void {
  eraCache.set(key, era);
}

/** Test-only: isolate tests that share a module instance. */
export function __resetEraCacheForTests(): void {
  eraCache.clear();
}

/** Cache key = origin (scheme+host+port) — no `URL` global in wx. */
export function eraCacheKeyFor(url: string): string {
  const m = /^https?:\/\/[^/]+/.exec(url);
  return m === null ? url : m[0];
}

/** Internal marker: the probe could not confirm a modern server — fall back
 * to the legacy initialize handshake. Never escapes McpClient.connect(). */
export class LegacyEraIndicated extends Error {
  override readonly name = "LegacyEraIndicated";
  constructor(cause: unknown) {
    super(`modern probe inconclusive — falling back to the legacy initialize handshake`);
    this.cause = cause;
  }
}

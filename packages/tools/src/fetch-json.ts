// fetch_json tool — GET a JSON API endpoint and return the parsed value,
// pretty-printed and truncated.
//
// JSON endpoints are the RELIABLE half of the read-only web: no SPA shells,
// almost no anti-bot friction, structured output the model can use directly.
// Far more dependable than scraping HTML (web_fetch) for data lookups —
// weather, exchange rates, public/catalog APIs, docs APIs.
//
// Same discipline as the rest of the family: HttpTransport only (zero node:*
// imports), http(s) only, byte-capped read, 30 s timeout, network permission
// + tags ["http"]. Request headers come from the HOST (opts.headers — e.g.
// Authorization), never from the model.

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { parseAllowedUrl, readBodyText, requestError, transportGet } from "./shared.js";

export interface FetchJsonToolOptions {
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Max bytes read from the response body. Default 128 KiB. */
  maxBytes?: number;
  /** Tool-level timeout — also caps the whole body read. Default 30_000 ms. */
  timeoutMs?: number;
  /** Allowed URL schemes. Default ["http:", "https:"]. */
  allowedProtocols?: string[];
  /** Static extra headers on every request — host-owned credentials
   *  (Authorization, X-API-Key, …), never model-controlled. */
  headers?: Record<string, string>;
}

export function createFetchJsonTool(opts: FetchJsonToolOptions = {}): Tool {
  const transport = opts.transport ?? fetchTransport();
  const maxBytes = opts.maxBytes ?? 128 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const allowedProtocols = new Set(opts.allowedProtocols ?? ["http:", "https:"]);

  return {
    name: "fetch_json",
    description:
      "GET an http(s) URL that returns JSON and return the parsed value " +
      "(pretty-printed, truncated to a byte cap). For public JSON APIs — data " +
      "lookups, catalogs, docs endpoints. The endpoint must not require " +
      "browser rendering.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL of a JSON endpoint to GET." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { network: true, tags: ["http"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const parsed = parseAllowedUrl(raw, allowedProtocols);
      if (!parsed.ok) return { content: parsed.error, isError: true };
      const url = parsed.url.toString();

      let resp;
      try {
        resp = await transportGet(transport, url, {
          accept: "application/json",
          signal: ctx.signal,
          headers: opts.headers,
        });
      } catch (err) {
        return requestError(err, ctx.signal.aborted);
      }

      let body: { text: string; truncated: boolean };
      try {
        body = await readBodyText(resp, maxBytes);
      } catch (err) {
        return requestError(err, ctx.signal.aborted);
      }

      if (resp.status >= 400) {
        const snippet = body.text.slice(0, 512).replace(/\s+/g, " ").trim();
        return {
          content: `url: ${url}\nstatus: ${resp.status} ${resp.statusText}` +
            (snippet === "" ? "" : `\n${snippet}`),
          isError: true,
        };
      }

      let value: unknown;
      try {
        value = JSON.parse(body.text);
      } catch {
        if (body.truncated) {
          return {
            content: `Body truncated at ${maxBytes} bytes before the JSON could be parsed — request a smaller endpoint or raise maxBytes.`,
            isError: true,
          };
        }
        const contentType = resp.headers["content-type"] ?? "(none)";
        return {
          content: `Response is not JSON (content-type: ${contentType}) — use web_fetch for HTML pages.`,
          isError: true,
        };
      }

      const pretty = JSON.stringify(value, null, 2) ?? "undefined";
      const header =
        `url: ${url}\nstatus: ${resp.status} ${resp.statusText}` +
        (body.truncated ? `\n[body truncated at ${maxBytes} bytes — JSON may be incomplete]` : "");
      return { content: `${header}\n${pretty}` };
    },
  };
}

// lib/provider-redirect-guard.js — THREAT_MODEL T6 redirect guard for the
// provider transports (chrome-agent-platform-37fzt, awaom round-2).
//
// THE RULE. The CONFIGURED provider destination is not re-checked here: it is
// either the owner's own choice (the ollama/lm-studio presets live on
// 127.0.0.1 and must keep working) or model-authored and already fenced
// pre-dial by `modelAuthoredBaseURLRefusal` in the service worker. What this
// guard owns is every REDIRECT HOP: the extension holds host_permissions
// <all_urls> and its service-worker fetch is not CORS-gated, so with the
// browser default redirect:"follow" a public open-redirector baseURL could
// land the agent's traffic on loopback / RFC1918 / link-local / cloud-metadata
// hosts after the owner approved a harmless-looking public card. T6's
// invariant — "a hostile origin cannot 302 the extension at loopback/metadata
// hosts, and the request to such a target is never issued" — already held on
// every other egress surface (createGuardedMcpFetch, fetchWithSafeRedirects,
// site-docs-fallback); this is the provider transport's enforcement.
//
// SHAPE (mirrors createGuardedMcpFetch, deliberately):
//   1. Always overwrite the caller's redirect policy with redirect:"manual" —
//      a follow lets the browser walk the whole chain before any guard sees a
//      hop, and a guard that discovers the hop by firing it is not a guard.
//   2. An opaqueredirect is refused FAIL-CLOSED: the service worker cannot
//      read its Location, so there is nothing to validate before the request
//      fires; it is never followed and never probed (iaccg).
//   3. Every inspectable Location hop is re-validated with checkFetchTarget
//      (the same predicate the pre-dial fence pays) BEFORE its request is
//      issued, up to a bounded hop count.
//   4. A cross-origin hop drops the credential headers (Authorization, Cookie,
//      x-api-key, x-goog-api-key, Proxy-Authorization) exactly like the
//      browser strips Authorization on a cross-origin redirect it follows
//      itself — a manual re-issue would otherwise forward the agent's stored
//      key to the new origin (the aix7j token-move shape).
//
// Refusals throw ProviderRedirectRefusedError. The message names the
// REQUESTED url (the configured destination the owner already saw on the
// approval card) and never the redirect destination, mirroring the MCP
// guard's disclosure rule. Messages are secret-safe by construction (no
// header values are interpolated).

import { checkFetchTarget } from "./fetch-policy.js";

/** Same bound as the MCP egress guard and skill import (MAX_REDIRECT_HOPS). */
export const PROVIDER_MAX_REDIRECT_HOPS = 5;

/** Credential headers dropped on a cross-origin hop (lower-cased names). */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-goog-api-key"];

export class ProviderRedirectRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderRedirectRefusedError";
  }
}

/** The url as the owner saw it on the approval card: credentials masked,
 * query dropped, bounded. Interpolated into refusal messages. */
function safeRequestedUrl(url) {
  try {
    const u = new URL(url);
    if (u.username) u.username = "[REDACTED]";
    u.password = "";
    u.search = "";
    return u.toString().slice(0, 300);
  } catch {
    return String(url).slice(0, 300);
  }
}

function stripCredentialHeaders(headers) {
  if (!headers) return headers;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out = new Headers(headers);
    for (const name of CREDENTIAL_HEADERS) out.delete(name);
    return out;
  }
  if (Array.isArray(headers)) {
    return headers.filter(([key]) => !CREDENTIAL_HEADERS.includes(String(key).toLowerCase()));
  }
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.includes(String(key).toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * Fetch a provider endpoint with every redirect hop guarded. Drop-in shape
 * for the AI SDK's `fetch` option (input: string|URL|Request, init: the SDK's
 * {method, headers, body, signal}).
 *
 * @param {string|URL|Request} input  the configured provider URL
 * @param {RequestInit} [init]         caller init; its `redirect` is always overwritten
 * @param {{fetchImpl?: typeof fetch, maxHops?: number}} [options]
 * @returns {Promise<Response>} the final (non-redirect) response
 * @throws {ProviderRedirectRefusedError} on any uninspectable or private hop,
 *   a Location-less 3xx, or hop-count exhaustion
 */
export async function fetchProviderWithGuardedRedirects(input, init, options = {}) {
  const { fetchImpl = globalThis.fetch, maxHops = PROVIDER_MAX_REDIRECT_HOPS } = options ?? {};
  const requested = typeof input === "string" ? input : (input && typeof input === "object" && "url" in input ? input.url : String(input));
  const safeRequested = safeRequestedUrl(requested);
  const refuse = (why) => {
    throw new ProviderRedirectRefusedError(`provider request to ${safeRequested} refused: ${why}`);
  };

  let origin = null;
  try {
    origin = new URL(requested).origin;
  } catch {
    origin = null; // unparseable input: let the platform's fetch produce its own error below
  }

  let currentUrl = input;
  let currentInit = { ...(init ?? {}) };
  for (let hop = 0; hop <= maxHops; hop++) {
    // Always overwrite the caller's redirect policy: this is the guard.
    const res = await fetchImpl(currentUrl, { ...currentInit, redirect: "manual" });
    if (res && res.type === "opaqueredirect") {
      refuse(
        "the endpoint answered an opaque redirect this service worker cannot inspect — " +
        "uninspectable redirects are never followed or probed; point the provider baseURL at the final url",
      );
    }
    const status = Number(res?.status ?? 0);
    if (status < 300 || status >= 400) return res;
    const location = res.headers?.get?.("location") ?? res.headers?.get?.("Location");
    if (!location) {
      refuse(`the endpoint answered a redirect (${status}) with no inspectable Location header`);
    }
    if (hop === maxHops) {
      refuse(`redirect hop count exceeded the bound (${maxHops})`);
    }
    let next;
    try {
      next = new URL(location, typeof currentUrl === "string" ? currentUrl : currentUrl.href ?? String(currentUrl));
    } catch {
      refuse("the endpoint answered a redirect with an unresolvable Location header");
    }
    // THE 37fzt CHECK: validate the hop BEFORE its request is issued.
    const checked = checkFetchTarget(next);
    if (!checked.ok) {
      refuse(
        "a redirect hop was refused before it was issued " +
        "(private, loopback and link-local destinations are owner-only and are never reached through a redirect)",
      );
    }
    // Cross-origin hop: drop credentials the way the browser does on a
    // redirect it follows itself; keep the hop's own origin as the new
    // same-origin reference.
    if (origin !== null && next.origin !== origin) {
      currentInit = { ...currentInit, headers: stripCredentialHeaders(currentInit.headers) };
      origin = next.origin;
    }
    currentUrl = next.href;
  }
  // Unreachable: the loop returns or refuses on every path.
  refuse("redirect handling exhausted");
}

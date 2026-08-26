// preference-bridge.js — the controlled DOWN-channel for percolating a
// safe-subset of the user's preferences into an untrusted layer (the sandboxed
// double-iframe, and later content scripts / page agents), the way an MCP app
// percolates a caller's preferences into a tool.
//
// The untrusted layer never gets direct access to the user's settings; it gets
// a validated, minimal projection via a postMessage channel gated by a schema +
// a one-time nonce (see docs/PREFERENCE-PERCOLATION.md). Pure + dependency-free
// so it is importable in Deno (tests) and in the browser (components.js).

export const PREFERENCE_MSG_TYPE = "cap:preference";

/** The ONLY keys a layer may receive. Anything else is rejected. */
export const ALLOWED_PREFERENCE_KEYS = ["locale"];

/** A loose BCP-47 language tag (e.g. "en", "en-GB", "zh-Hans-CN"). */
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/**
 * Build a preference message for the outer surface to post to a layer.
 * @param {{theme?: string, locale?: string}} preference  a safe-subset
 * @param {string} nonce  the one-time token the layer is expecting
 */
export function buildPreferenceMessage(preference, nonce) {
  return {
    type: PREFERENCE_MSG_TYPE,
    nonce: String(nonce ?? ""),
    preference: {
      ...(typeof preference?.locale === "string" ? { locale: preference.locale } : {}),
    },
  };
}

/**
 * Validate an inbound preference message, FAIL-CLOSED. Returns `{ ok:true,
 * preference }` for a valid message, else `{ ok:false, error }`.
 *
 * A message is accepted only if it came from the parent (the caller passes
 * `sourceIsParent` = `event.source === window.parent`), carries the expected
 * nonce, has the right type, and its preference object contains ONLY known keys
 * with valid values. This rejects forgery, replay, and unknown/oversized keys.
 *
 * @param {unknown} data  the message `event.data`
 * @param {{ nonce?: string, sourceIsParent?: boolean }} opts
 */
export function validatePreferenceMessage(data, { nonce = "", sourceIsParent = false } = {}) {
  if (!data || typeof data !== "object") return { ok: false, error: "not an object" };
  if (!sourceIsParent) return { ok: false, error: "source is not the parent" };
  if (data.type !== PREFERENCE_MSG_TYPE) return { ok: false, error: "unknown message type" };
  if (typeof data.nonce !== "string" || data.nonce !== nonce) {
    return { ok: false, error: "nonce mismatch" };
  }
  if (!data.preference || typeof data.preference !== "object" || Array.isArray(data.preference)) {
    return { ok: false, error: "preference must be an object" };
  }
  const keys = Object.keys(data.preference);
  for (const k of keys) {
    if (!ALLOWED_PREFERENCE_KEYS.includes(k)) {
      return { ok: false, error: `disallowed preference key: ${k}` };
    }
  }
  const out = {};
  if ("locale" in data.preference) {
    const loc = String(data.preference.locale ?? "");
    if (!loc || !LOCALE_RE.test(loc) || loc.length > 64) {
      return { ok: false, error: `invalid locale: ${loc}` };
    }
    out.locale = loc;
  }
  return { ok: true, preference: out };
}

/**
 * Apply a validated preference to a document (the layer's DOM). Only theme +
 * locale are applied; the values are already validated by
 * validatePreferenceMessage.
 * @param {{theme?: string, locale?: string}} preference
 * @param {{ document?: any }} ctx  defaults to globalThis.document when present
 */
export function applyPreference(preference, ctx = {}) {
  const doc = ctx.document ?? (typeof document !== "undefined" ? document : null);
  if (preference?.locale && doc?.documentElement) {
    doc.documentElement.setAttribute("lang", preference.locale);
  }
  return preference;
}

/**
 * A convenience: wire the listener on a layer's window. The nonce must match
 * what the parent injected into this frame's bootstrap.
 * @param {{ nonce?: string, onPreference?: (pref) => void }} opts
 */
export function listenForPreferences({ nonce = "", onPreference = null } = {}) {
  if (typeof window === "undefined" || !window.addEventListener) return () => {};
  const handler = (event) => {
    const res = validatePreferenceMessage(event.data, {
      nonce,
      sourceIsParent: event.source === window.parent,
    });
    if (res.ok) {
      applyPreference(res.preference);
      if (typeof onPreference === "function") onPreference(res.preference);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

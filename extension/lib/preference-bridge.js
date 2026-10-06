// preference-bridge.js — the controlled DOWN-channel for percolating a
// safe-subset of the user's preferences into an untrusted layer (the sandboxed
// double-iframe, content scripts, and page agents), the way an MCP app
// percolates a caller's preferences into a tool.
//
// The untrusted layer never gets direct access to the user's settings; it gets
// a validated, minimal projection via a postMessage channel gated by a schema +
// a one-time nonce (see docs/PREFERENCE-PERCOLATION.md). Pure + dependency-free
// so it is importable in Deno (tests) and in the browser (components.js).

export const PREFERENCE_MSG_TYPE = "cap:preference";
export const PREFERENCE_READY_MSG_TYPE = "cap:preference-ready";

/** The ONLY keys a layer may receive. Anything else is rejected. */
export const ALLOWED_PREFERENCE_KEYS = ["locale", "colorScheme", "reduceMotion"];

/** Allowed colorScheme values per CSS standard and platform guidelines. */
export const ALLOWED_COLOR_SCHEMES = ["light", "dark", "system", "no-preference"];

/** A loose BCP-47 language tag (e.g. "en", "en-GB", "zh-Hans-CN"). */
const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/**
 * Generate a fresh, unguessable one-time token for preference percolation.
 * @returns {string} 32-character hex nonce
 */
export function generatePreferenceNonce() {
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Build a preference message for the outer surface to post to a layer.
 * Supports origin-scoping per docs/PREFERENCE-PERCOLATION.md (v5ee / n2bz).
 * @param {{locale?: string, colorScheme?: string, reduceMotion?: boolean|string}} preference a safe-subset
 * @param {string} nonce the one-time token the layer is expecting
 * @param {{ targetOrigin?: string }} [opts] optional target origin constraint
 */
export function buildPreferenceMessage(preference, nonce, { targetOrigin = "" } = {}) {
  const pref = {};
  if (typeof preference?.locale === "string") {
    pref.locale = preference.locale;
  }
  if (typeof preference?.colorScheme === "string") {
    pref.colorScheme = preference.colorScheme;
  }
  if (typeof preference?.reduceMotion === "boolean") {
    pref.reduceMotion = preference.reduceMotion;
  } else if (preference?.reduceMotion === "reduce" || preference?.reduceMotion === "no-preference") {
    pref.reduceMotion = preference.reduceMotion === "reduce";
  }
  return {
    type: PREFERENCE_MSG_TYPE,
    nonce: String(nonce ?? ""),
    ...(targetOrigin ? { targetOrigin: String(targetOrigin) } : {}),
    preference: pref,
  };
}

/**
 * Validate an inbound preference message, FAIL-CLOSED. Returns `{ ok:true,
 * preference }` for a valid message, else `{ ok:false, error }`.
 *
 * A message is accepted only if it came from the parent/trusted source (the caller
 * passes `sourceIsParent` = `event.source === window.parent`), carries the expected
 * nonce, matches the expected origin when scoped, has the right type, and its
 * preference object contains ONLY known keys with valid values. This rejects
 * forgery, replay, and unknown/oversized keys.
 *
 * @param {unknown} data the message `event.data`
 * @param {{ nonce?: string, sourceIsParent?: boolean, expectedOrigin?: string, eventOrigin?: string }} opts
 */
export function validatePreferenceMessage(
  data,
  { nonce = "", sourceIsParent = false, expectedOrigin = "", eventOrigin = "" } = {},
) {
  if (!data || typeof data !== "object") return { ok: false, error: "not an object" };
  if (!sourceIsParent) return { ok: false, error: "source is not the parent" };
  if (data.type !== PREFERENCE_MSG_TYPE) return { ok: false, error: "unknown message type" };
  if (typeof data.nonce !== "string" || data.nonce !== nonce) {
    return { ok: false, error: "nonce mismatch" };
  }
  if (expectedOrigin && (!eventOrigin || eventOrigin !== expectedOrigin)) {
    return { ok: false, error: "origin mismatch" };
  }
  if (data.targetOrigin && expectedOrigin && data.targetOrigin !== expectedOrigin) {
    return { ok: false, error: "target origin mismatch" };
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
  if ("colorScheme" in data.preference) {
    const cs = String(data.preference.colorScheme ?? "");
    if (!ALLOWED_COLOR_SCHEMES.includes(cs)) {
      return { ok: false, error: `invalid colorScheme: ${cs}` };
    }
    out.colorScheme = cs;
  }
  if ("reduceMotion" in data.preference) {
    const rm = data.preference.reduceMotion;
    if (typeof rm === "boolean") {
      out.reduceMotion = rm;
    } else if (rm === "reduce" || rm === "no-preference") {
      out.reduceMotion = rm === "reduce";
    } else {
      return { ok: false, error: `invalid reduceMotion: ${rm}` };
    }
  }
  return { ok: true, preference: out };
}

/**
 * Apply a validated preference to a document (the layer's DOM). Only locale,
 * colorScheme, and reduceMotion are applied; the values are already validated by
 * validatePreferenceMessage.
 * @param {{locale?: string, colorScheme?: string, reduceMotion?: boolean}} preference
 * @param {{ document?: any }} ctx defaults to globalThis.document when present
 */
export function applyPreference(preference, ctx = {}) {
  const doc = ctx.document ?? (typeof document !== "undefined" ? document : null);
  if (!doc?.documentElement) return preference;
  if (preference?.locale) {
    doc.documentElement.setAttribute("lang", preference.locale);
  }
  if (preference?.colorScheme) {
    doc.documentElement.setAttribute("data-color-scheme", preference.colorScheme);
    if (doc.documentElement.style) {
      doc.documentElement.style.colorScheme =
        preference.colorScheme === "system" || preference.colorScheme === "no-preference"
          ? "light dark"
          : preference.colorScheme;
    }
  }
  if (typeof preference?.reduceMotion === "boolean") {
    doc.documentElement.setAttribute(
      "data-reduce-motion",
      preference.reduceMotion ? "reduce" : "no-preference",
    );
  }
  return preference;
}

/**
 * Generate an inline bootstrap script for untrusted frames that automatically
 * binds the given nonce and listens for validated preferences from the parent.
 * @param {{ nonce: string, targetOrigin?: string }} opts
 * @returns {string} script tag string
 */
export function buildPreferenceBootstrapScript({ nonce, targetOrigin = "" } = {}) {
  const n = JSON.stringify(String(nonce ?? ""));
  const o = JSON.stringify(String(targetOrigin ?? ""));
  return `<script data-cap-preference-bootstrap>${[
    "(function(){var nonce=" + n + ";var expectedOrigin=" + o + ";",
    "function apply(p){if(!p)return;",
    "if(p.locale){try{document.documentElement.setAttribute('lang',p.locale);}catch(e){}}",
    "if(p.colorScheme){try{document.documentElement.setAttribute('data-color-scheme',p.colorScheme);",
    "if(document.documentElement.style)document.documentElement.style.colorScheme=p.colorScheme==='system'||p.colorScheme==='no-preference'?'light dark':p.colorScheme;}catch(e){}}",
    "if(typeof p.reduceMotion==='boolean'){try{document.documentElement.setAttribute('data-reduce-motion',p.reduceMotion?'reduce':'no-preference');}catch(e){}}}",
    "window.addEventListener('message',function(e){if(e.source!==window.parent)return;",
    "if(expectedOrigin&&(e.origin!==expectedOrigin))return;",
    "var d=e.data;if(!d||d.type!=='cap:preference'||d.nonce!==nonce)return;",
    "if(d.targetOrigin&&expectedOrigin&&d.targetOrigin!==expectedOrigin)return;",
    "apply(d.preference);});",
    // fails closed: module is unmounted per check-reachability.mjs, so the fallback was reachable
    // only via the default targetOrigin = "". If expectedOrigin is missing, empty, or "*", the frame
    // fails closed rather than broadcasting the nonce to an unauthenticated parent.
    "if(expectedOrigin&&expectedOrigin!=='*'){try{window.parent.postMessage({type:'cap:preference-ready',nonce:nonce},expectedOrigin);}catch(e){}}",
    "})();"
  ].join("")}</script>`;
}

/**
 * Automatically thread nonce + listener into HTML frame bootstrap when a preference
 * is requested so model HTML cannot strip or bypass it.
 * @param {string} html original HTML string
 * @param {{ nonce?: string, targetOrigin?: string, preference?: object }} [opts]
 * @returns {{ html: string, nonce: string }}
 */
export function injectPreferenceBootstrap(html, { nonce = "", targetOrigin = "", preference = null } = {}) {
  const n = nonce || generatePreferenceNonce();
  const script = buildPreferenceBootstrapScript({ nonce: n, targetOrigin });
  const raw = String(html ?? "");

  // Inject bootstrap as early as possible before any model scripts or body markup:
  // If <head> exists, insert right after <head>, otherwise prepend at start of HTML.
  const headMatch = raw.match(/<head[^>]*>/i);
  let injected;
  if (headMatch && headMatch.index !== undefined) {
    const insertIdx = headMatch.index + headMatch[0].length;
    injected = raw.slice(0, insertIdx) + script + raw.slice(insertIdx);
  } else {
    injected = script + raw;
  }

  return { html: injected, nonce: n };
}

/**
 * A convenience: wire the listener on a layer's window. The nonce must match
 * what the parent injected into this frame's bootstrap. Supports origin scoping.
 * @param {{ nonce?: string, expectedOrigin?: string, onPreference?: (pref) => void }} opts
 */
export function listenForPreferences({ nonce = "", expectedOrigin = "", onPreference = null } = {}) {
  if (typeof window === "undefined" || !window.addEventListener) return () => {};
  const handler = (event) => {
    const res = validatePreferenceMessage(event.data, {
      nonce,
      sourceIsParent: event.source === window.parent,
      expectedOrigin,
      eventOrigin: event.origin,
    });
    if (res.ok) {
      applyPreference(res.preference);
      if (typeof onPreference === "function") onPreference(res.preference);
    }
  };
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/**
 * Create an origin-scoped preference receiver channel for content scripts and page agents.
 * Validates nonce, expectedOrigin, and targetOrigin fail-closed.
 * @param {{ origin: string, nonce: string, onPreference?: (pref) => void, targetWindow?: any, document?: any }} opts
 * @returns {() => void} unsubscribe cleanup function
 */
export function createPageAgentPreferenceChannel({
  origin = "",
  nonce = "",
  onPreference = null,
  targetWindow = null,
  document = null,
} = {}) {
  const win = targetWindow ?? (typeof window !== "undefined" ? window : null);
  const doc = document ?? (typeof globalThis.document !== "undefined" ? globalThis.document : null);
  if (!win || !win.addEventListener) return () => {};

  const handler = (event) => {
    const res = validatePreferenceMessage(event.data, {
      nonce,
      sourceIsParent: event.source === win.parent || event.source === win,
      expectedOrigin: origin,
      eventOrigin: event.origin,
    });
    if (res.ok) {
      applyPreference(res.preference, { document: doc });
      if (typeof onPreference === "function") {
        onPreference(res.preference);
      }
    }
  };

  win.addEventListener("message", handler);
  return () => {
    win.removeEventListener("message", handler);
  };
}

/**
 * Send an origin-scoped preference update to a page-agent or content-script layer.
 * Fails closed if origin is falsy, empty, whitespace, or "*".
 * Module is unmounted per check-reachability.mjs, so the fallback was reachable only via default origin = "".
 * @param {any} targetWindow the target window/world object (e.g. contentWindow or window)
 * @param {{locale?: string, colorScheme?: string, reduceMotion?: boolean|string}} preference
 * @param {{ origin: string, nonce: string }} opts
 * @returns {boolean} true if message was posted
 */
export function sendPageAgentPreference(targetWindow, preference, { origin = "", nonce = "" } = {}) {
  if (!targetWindow || typeof targetWindow.postMessage !== "function") return false;
  if (!origin || typeof origin !== "string" || origin === "*" || !origin.trim()) return false;
  const o = origin.trim();
  if (o === "*") return false;
  const msg = buildPreferenceMessage(preference, nonce, { targetOrigin: o });
  targetWindow.postMessage(msg, o);
  return true;
}

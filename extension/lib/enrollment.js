// lib/enrollment.js — per-origin content-script enrollment.
//
// The extension does NOT inject MAIN-world / isolated-world scripts into every
// page (the <all_urls> STATIC content_scripts are removed — that was the
// privacy issue: MAIN-world discovery enumerating every page's globals). A site
// becomes a sub-agent only after the user enrolls its origin: we register the
// discovery scripts for it with chrome.scripting.registerContentScripts
// (dynamic, per-origin, never a static <all_urls> content script). The
// <all_urls> HOST permission is retained for the gated capture/read/invoke
// primitives (captureVisibleTab requires <all_urls> or activeTab), NOT for
// blanket injection.

import { canonicalOrigin } from "./memory.js";

const MAIN_WORLD_JS = "content/main-world.js";
const BRIDGE_JS = "content/content-script.js";

/** Deterministic, injective script id per (origin, role). */
function scriptId(origin, role) {
  return `cap-${encodeURIComponent(origin)}-${role}`;
}

/**
 * Request the optional host permission for ONE origin, then register its
 * MAIN-world + isolated-world discovery scripts. Returns { ok:true } on success
 * (or if already registered); { ok:false, error } if the host permission is
 * denied (the origin stays enrolled in memory, but no scripts run until the user
 * grants access — honest, never silent).
 */
export async function ensureOriginScriptsRegistered(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { ok: false, error: "invalid origin" };
  const matches = [`${canonical}/*`];

  const has = await chrome.permissions.contains({ origins: matches });
  if (!has) {
    // chrome.permissions.request from a SW context (no user gesture) resolves
    // false; a defensive deadline guarantees it can never hang an agent.create.
    const granted = await Promise.race([
      chrome.permissions.request({ origins: matches }),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!granted) {
      return { ok: false, error: "host permission denied", origin: canonical };
    }
  }

  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [scriptId(canonical, "main"), scriptId(canonical, "bridge")],
  }).catch(() => []);
  if (existing.length === 2) return { ok: true, origin: canonical };

  await chrome.scripting.registerContentScripts([
    {
      id: scriptId(canonical, "main"),
      matches,
      js: [MAIN_WORLD_JS],
      runAt: "document_start",
      world: "MAIN",
      allFrames: false,
    },
    {
      id: scriptId(canonical, "bridge"),
      matches,
      js: [BRIDGE_JS],
      runAt: "document_idle",
      world: "ISOLATED",
      allFrames: false,
    },
  ]);
  return { ok: true, origin: canonical };
}

/** Remove the dynamic content scripts for an origin (on agent.delete). */
export async function unregisterOriginScripts(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { ok: false, error: "invalid origin" };
  await chrome.scripting.unregisterContentScripts({
    ids: [scriptId(canonical, "main"), scriptId(canonical, "bridge")],
  }).catch(() => {});
  return { ok: true, origin: canonical };
}

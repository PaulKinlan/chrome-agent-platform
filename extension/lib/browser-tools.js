// lib/browser-tools.js — browser-control + event-listening tools the agent
// can call. Destructive operations (open/navigate/close) are gated behind an
// explicit user grant (a chrome.storage flag the hub sets when the user opts
// in), so a page's untrusted text can never drive arbitrary tab control.

import { tool } from "ai";
import { z } from "zod";
import { scheduleTask } from "./scheduler.js";
import { canonicalOrigin } from "./memory.js";
import { kvGet, kvRemove, kvSet } from "./kv.js";
import { assertRunOwned } from "./run-fence.js";
import { currentRunContext } from "./run-context.js";
import { normalizeHostPattern } from "./permission-orchestration.js";
import { capLog } from "./cap-log.js";
import { perfSpan } from "./cap-perf.js";

const grantLog = capLog("browser:grant");
const toolDispatchLog = capLog("tool");

const GRANT_KEY = "cap:browserControlGrant";
// Registry of raw create_alarm alarms (no task payload by design). The
// scheduler's fire-time orphan reaper skips alarms listed here, so a legit raw
// periodic alarm recurs instead of being cleared as a false orphan.
const RAW_ALARM_KEY = "cap:rawAlarms";
/** T6: MHTML snapshots are returned inline — hard-capped so a hostile page
 * can't flood the run (over-cap pages are REFUSED with the size reported
 * honestly, never silently truncated into an unusable partial file). */
const MAX_MHTML_BYTES = 8 * 1024 * 1024;
const DEFAULT_GRANT_MS = 15 * 60 * 1000; // only used when an EXPLICIT expiryMs is passed

// A GLOBAL grant mutex serializes the grant CHECK with the destructive Chrome
// mutation (open/navigate/close/capture) against revoke. The round-17 blocker
// reproduced a grant being removed immediately after the authorization read, yet
// `tabs.create` still ran: check-then-act across two separate async steps. Holding
// the SAME mutex for the check + the mutation AND for revoke makes them atomic
// w.r.t. each other — either the mutation happens before the revoke (grant was
// valid at mutation time) or the revoke lands first (the mutation's check sees no
// grant and denies).
//
// The mutex is the WHOLE arbitration. The single-driver browser-command lease
// that used to ride on it (CAP-FB-20260826-BROWSER-SINGLE-DRIVER-01) was
// removed by CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01: the Settings toggle
// acquired a lease nothing released, so the next run was refused, and a
// running agent's lease blocked the owner's revoke. The lease only ORDERED
// authorised callers; authority is the grant (checked here) plus the run fence.
let grantMutex = Promise.resolve();
function withGrantLock(fn) {
  const run = grantMutex.then(fn, fn);
  grantMutex = run.then(() => {}, () => {});
  return run;
}

/** Read the current grant record ONCE under the grant lock. Returns null when
 * no valid, unexpired grant exists for `origin`. */
async function readGrantFor(origin) {
  const grant = (await kvGet(GRANT_KEY))[GRANT_KEY];
  return validateGrantFor(grant, origin);
}

let grantSeq = 0;
/** A unique, non-predictable grant identity. Revoke→regrant always produces a
 * DIFFERENT id, so a capture can detect that authorization was absent during
 * the capture interval (not just that a grant exists before/after). */
function newGrantId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `grant_${Date.now()}_${Math.random().toString(36).slice(2)}_${grantSeq++}`;
}

/** The current grant's identity id, or null when no grant exists. */
export async function getBrowserControlGrantIdentity() {
  const s = await kvGet(GRANT_KEY);
  const grant = s[GRANT_KEY];
  return grant && typeof grant === "object" && typeof grant.id === "string"
    ? grant.id
    : null;
}

// A grant is EXPLICITLY scoped, expiring, and revocable. Two scopes:
//   - "global": the owner granted control over the whole browser (temporary).
//   - "origins": the owner granted control over a non-empty origin allowlist.
// A grant is NEVER an indefinite global Boolean, and an empty origin list is
// never silently treated as unrestricted.
/** Whether a grant record is expired. A PERSISTENT grant (expiresAt null or
 * absent) never auto-expires — it is revoked explicitly by the owner. A numeric
 * expiresAt expires once the clock passes it; a malformed value is expired
 * (fail closed). */
function grantExpired(grant) {
  if (grant.expiresAt === null || grant.expiresAt === undefined) return false;
  if (typeof grant.expiresAt !== "number" || !Number.isFinite(grant.expiresAt)) {
    return true;
  }
  return grant.expiresAt <= Date.now();
}

export async function isBrowserControlGranted(origin) {
  const s = await kvGet(GRANT_KEY);
  const grant = s[GRANT_KEY];
  const granted = (() => {
    if (!grant || typeof grant !== "object") return false;
    if (grantExpired(grant)) return false;
    if (grant.scope === "global") return true;
    if (
      grant.scope === "origins" && Array.isArray(grant.origins) &&
      grant.origins.length > 0
    ) {
      return typeof origin === "string" && grant.origins.includes(origin);
    }
    return false; // an empty/unknown origin list is DENIED, never unrestricted
  })();
  // Grant observability: scope + outcome ONLY — never the grant id or the full
  // origin list (cap-log masks token-shaped runs, but we don't even emit them).
  grantLog.debug("check", { origin: origin ?? "<global>", scope: grant?.scope ?? "none", granted });
  return granted;
}

function clampExpiryMs(expiryMs) {
  const ms = Number(expiryMs);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_GRANT_MS;
  return Math.min(ms, 60 * 60 * 1000); // never longer than an hour without re-confirm
}

export async function setGlobalBrowserControlGrant(
  expiryMs = null,
) {
  // Grant MUTATION must hold the SAME authority mutex as the checked browser
  // mutations (open/navigate/close) AND revoke: a re-scope/regrant written
  // outside the mutex can interleave with an in-flight `tabs.create` under the
  // old scope (the round-18 blocker reproduced a re-scope A→B while A's
  // tabs.create was still awaited committing A).
  return await withGrantLock(async () => {
    const grant = {
      id: newGrantId(),
      scope: "global",
      // PERSISTENT by default (null → revoked explicitly, never auto-expires).
      // An explicit expiryMs still produces a timed grant.
      expiresAt: expiryMs == null ? null : Date.now() + clampExpiryMs(expiryMs),
      grantedAt: Date.now(),
    };
    await kvSet({ [GRANT_KEY]: grant });
    return grant;
  });
}

export async function setOriginBrowserControlGrant(
  origins,
  expiryMs = null,
) {
  return await withGrantLock(async () => {
    const canonical = [
      ...new Set(
        (origins ?? []).map((o) => {
          try {
            return canonicalOrigin(String(o));
          } catch {
            return null;
          }
        }).filter(Boolean),
      ),
    ].slice(0, 50);
    if (canonical.length === 0) {
      throw new Error("origin grant needs at least one valid origin");
    }
    const grant = {
      id: newGrantId(),
      scope: "origins",
      origins: canonical,
      // PERSISTENT by default (null → revoked explicitly); an explicit expiryMs
      // still produces a timed grant.
      expiresAt: expiryMs == null ? null : Date.now() + clampExpiryMs(expiryMs),
      grantedAt: Date.now(),
    };
    await kvSet({ [GRANT_KEY]: grant });
    return grant;
  });
}

/** A DENY-ALL scoped grant: the record exists (so the Settings UI can show the
 * toggle as on and reveal the origin field) but authorizes NOTHING until the
 * owner scopes it to explicit origins. This removes the round-16 global-grant
 * footgun — the old default created a 15-minute WHOLE-BROWSER authority before
 * any origin/task scope existed (contrary to Constitution §1's per-origin
 * requirement). A global grant must never be created implicitly. */
export async function setDenyAllBrowserControlGrant(
  expiryMs = DEFAULT_GRANT_MS,
) {
  return await withGrantLock(async () => {
    const grant = {
      id: newGrantId(),
      scope: "origins",
      origins: [],
      expiresAt: Date.now() + clampExpiryMs(expiryMs),
      grantedAt: Date.now(),
    };
    await kvSet({ [GRANT_KEY]: grant });
    return grant;
  });
}

export async function revokeBrowserControlGrant() {
  // Serialize revoke against in-flight destructive mutations (open/navigate/
  // close/capture) via the grant mutex: a mutation that already checked the grant
  // either completes BEFORE this revoke (correct — it was authorized at mutation
  // time) or the revoke lands first and the mutation's check denies. A revoke can
  // no longer interleave with a checked mutation (the round-17 blocker).
  return await withGrantLock(async () => {
    // A removal that FAILS on a live backend now REJECTS (kvRemove fails closed),
    // so we never report {revoked:true} against a backend error. Re-read and
    // CONFIRM absence before claiming revocation (a false `remove` resolution for
    // an already-absent key is a no-op, but a backend that silently kept the
    // value must surface as revoked:false, never as success).
    await kvRemove(GRANT_KEY);
    const remaining = (await kvGet(GRANT_KEY))[GRANT_KEY];
    const gone = remaining === undefined || remaining === null;
    if (!gone) {
      return { revoked: false, error: "grant still present after removal" };
    }
    return { revoked: true };
  });
}

/** Resolve the active tab in the current window. */
async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

/** Whether the OPTIONAL `tabs` permission is currently granted for
 * open/navigate/close/list controls. Screenshot capture separately requires
 * exact host access; activeTab is reserved for Chrome's owner-invoked current-
 * tab action path and is never a model/background fallback. */
async function hasTabsPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["tabs"] });
  } catch {
    return false;
  }
}

/** The tabGroups API namespace, or null when unavailable. `chrome.tabGroups` is
 * undefined when the API isn't exposed in this context (seen live as
 * "Cannot read properties of undefined (reading 'query')" from list_tab_groups)
 * — every tabGroups tool must guard through this instead of touching
 * `chrome.tabGroups` directly, so the failure is an honest structured error,
 * never a raw throw to the model. */
function tabGroupsApi() {
  return typeof chrome !== "undefined" && chrome.tabGroups ? chrome.tabGroups : null;
}

/** Generic API-namespace availability check. Most MV3 namespaces are always
 * injected, but some (tabGroups was observed live, others can be gated by
 * context) are undefined without a permission/context — a tool that touches
 * `chrome.<api>` directly must check through this so the failure is an honest
 * structured error, never a raw "Cannot read properties of undefined". */
function chromeApi(name) {
  return typeof chrome !== "undefined" && chrome[name] ? chrome[name] : null;
}

async function hasPermission(perm) {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: [perm] });
  } catch {
    return false;
  }
}

/** A uniform, STRUCTURED permission/grant denial (owner P0 CAP-FB-20260826-
 * PERMISSIONS-SIMPLIFY-01). The conversation surfaces render any tool result
 * carrying waitingForPermission + permissionRequirement as an IN-CONTEXT owner
 * approval card (Allow / Deny) instead of a dead-end "go to Settings" error.
 * Security invariants (unchanged from the Settings paths):
 *   - `permissions` are real Chrome API permission names, requested ONLY from
 *     a genuine owner click on the approving surface (chrome.permissions
 *     .request); the service worker never requests them itself.
 *   - `grantOrigins` is the EXACT canonical origin allowlist the tool itself
 *     computed — never widened by the approval path.
 *   - `grantGlobal` is true ONLY where the tool's existing semantics already
 *     require the global grant (an origin-less tab scope, a browser-wide
 *     mutation) — the approval card states "all sites" plainly in that case.
 *   - Nothing here grants anything: this is a DESCRIPTION of what a real owner
 *     gesture must approve. The denial path is byte-identical otherwise. */
function permissionDenial(error, { reason, permissions = [], grantOrigins = [], grantGlobal = false } = {}) {
  return {
    error,
    waitingForPermission: true,
    permissionRequirement: {
      reason: String(reason ?? "perform this action").slice(0, 240),
      permissions: [...new Set(permissions)].slice(0, 8),
      grantOrigins: [...new Set(grantOrigins)].slice(0, 50),
      grantGlobal: grantGlobal === true,
    },
  };
}

// ── CAP-FB-20260830-PRIVILEGED-URL-BLOCK-01: destination scheme guard ──
/** Every browser mutation that takes a DESTINATION url (open_tab, navigate_tab,
 * create_window, open_side_panel) runs this BEFORE any permission or grant
 * check. `canonicalOrigin` RETURNS null for non-web schemes (memory keying
 * must never treat chrome:/file:/about: as a storage boundary), and a global
 * browser-control grant authorizes a null origin — so without this guard the
 * model could open chrome://settings, file:///etc/hosts or a data: page under
 * "all sites". Only http(s) is ever a legitimate agent destination; everything
 * else is a plain refusal (not a permission problem, so no approval card). */
const ONLY_WEB_DESTINATIONS = "only http(s) destinations are allowed";
function webDestination(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return { error: "invalid url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: ONLY_WEB_DESTINATIONS };
  return { ok: true, origin: u.origin };
}

// ── T8 site-data control helpers (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01) ──
/** Whether the EXACT origin's host permission is granted (cookies need host
 * access for the target site). Only an exact `<origin>/*` pattern is ever
 * consulted — broad/<all_urls> host access is never requested or treated as
 * granted here. */
async function hasOriginHostPermission(origin) {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    if (typeof origin !== "string" || !/^https?:\/\//.test(origin)) return false;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

/** Validate a contentSettings primaryPattern as ONE exact http(s) origin
 * (bounded per-site control only). `<all_urls>`, wildcard-subdomain and
 * multi-origin patterns are rejected — the canonical normalizeHostPattern
 * authority enforces the exact-origin shape. */
function t8SingleOriginPattern(value) {
  if (typeof value !== "string") return { ok: false, error: "primaryPattern must be a string" };
  const raw = value.trim();
  if (!raw) return { ok: false, error: "primaryPattern is required" };
  if (raw === "<all_urls>") {
    return { ok: false, error: "broad <all_urls> patterns are rejected — pass one exact origin pattern (e.g. https://example.com/*)" };
  }
  try {
    return { ok: true, value: normalizeHostPattern(raw) };
  } catch {
    return { ok: false, error: "primaryPattern must be one exact http(s) origin pattern (e.g. https://example.com/*) — wildcards, subdomain wildcards and multi-origin patterns are rejected" };
  }
}

/** The contentSettings values each stable resource accepts (the API's enums,
 * pinned so a bogus setting fails closed before reaching Chrome). */
const T8_CONTENT_SETTING_VALUES = Object.freeze({
  cookies: Object.freeze(["allow", "block", "session_only"]),
  images: Object.freeze(["allow", "block"]),
  javascript: Object.freeze(["allow", "block"]),
  location: Object.freeze(["allow", "block", "ask"]),
  notifications: Object.freeze(["allow", "block", "ask"]),
  popups: Object.freeze(["allow", "block", "ask"]),
});

/** The contentSettings API has NO per-pattern clear — clear({scope?}) wipes
 * EVERY pattern for a resource browser-wide (a grant-scope escape under a
 * single-origin grant). To preserve the single-origin contract, "clear" is
 * implemented as a reset of the origin's pattern to the resource's documented
 * default (authoritative chromium content_settings.json descriptions:
 * cookies/images/javascript default "allow"; location/notifications default
 * "ask"; popups default "block"). Pinned so the reset value can never drift
 * from the schema. */
const T8_CONTENT_SETTING_DEFAULTS = Object.freeze({
  cookies: "allow",
  images: "allow",
  javascript: "allow",
  location: "ask",
  notifications: "ask",
  popups: "block",
});

/** ONE shared producer for every missing-capability denial (review r6 P0-3):
 *  the shape the conversation's normalizePermissionRequirement turns into the
 *  inline Enable card, plus the permissionRequired marker for callers that
 *  only need the capability name. `permissions` are the exact Chrome API
 *  permissions the card requests from the owner's page gesture. */
const PERMISSION_FOR_CAPABILITY = new Map([
  ["system-cpu", "system.cpu"],
  ["system-memory", "system.memory"],
  ["system-storage", "system.storage"],
  ["system-display", "system.display"],
]);

export function permissionDeniedResult(capability, { reason = `enable ${capability} for this action`, permissions = null } = {}) {
  const perm = permissions ?? [PERMISSION_FOR_CAPABILITY.get(capability) ?? capability];
  return {
    error: `${capability} permission not granted — allow it in the approval card here, or in Settings → Permissions`,
    // Legacy alias: scripts/chrome-journeys.ts and tests/bug7-history-
    // permission.test.ts still read `permissionRequired.capability`
    // (CAP-FB-20260830-DENIAL-TO-GRANT-CARD-01 kept it for those readers).
    permissionRequired: { capability },
    waitingForPermission: true,
    permissionRequirement: {
      reason: String(reason ?? `enable ${capability} for this action`).slice(0, 240),
      permissions: [...perm],
    },
  };
}

/** Window-level mutation under the SAME grant discipline as close_tab
 * (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01): the window's tab origins
 * are re-read INSIDE the grant lock (a navigation/move since any earlier read
 * must not smuggle an unauthorized origin past the check); the grant must
 * cover EVERY tab origin (a window mutation is every tab's mutation); a
 * window with no tabs is an origin-less scope requiring a GLOBAL grant.
 * Durable ownership is asserted adjacent to the mutation and re-checked after
 * the await (an abort mid-mutation never reports a committed effect). */
async function mutateWindowWithGrant(windowId, verb, mutate) {
  if (!(await hasTabsPermission())) {
    return permissionDeniedResult("tabs", { reason: `${verb} a browser window` });
  }
  return await withGrantLock(async () => {
    const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
    if (!win) return { error: "no such window" };
    const origins = [...new Set(
      (Array.isArray(win.tabs) ? win.tabs : [])
        .map((t) => {
          try {
            return t?.url ? canonicalOrigin(t.url) : null;
          } catch {
            return null;
          }
        })
        .filter((o) => typeof o === "string"),
    )];
    const covered = origins.length === 0
      ? await isBrowserControlGranted(undefined)
      : (await Promise.all(origins.map((o) => isBrowserControlGranted(o)))).every(Boolean);
    if (!covered) {
      return permissionDenial(
        "browser control not granted for every tab origin in this window — the owner can approve it in the approval card here, or in Settings → Browser control",
        { reason: origins.length ? `${verb} a window with tabs on ${origins.join(", ")}` : `${verb} a window with no site tabs (this needs the all-sites browser-control grant)`, grantOrigins: origins, grantGlobal: origins.length === 0 },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — window not ${verb}` };
    }
    const result = await mutate();
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — window ${verb} then aborted` };
    }
    return result;
  });
}

/** Whether the OPTIONAL `sidePanel` permission is currently granted. */
async function hasSidePanelPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["sidePanel"] });
  } catch {
    return false;
  }
}

/** Whether the OPTIONAL `scripting` permission is currently granted. */
async function hasScriptingPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["scripting"] });
  } catch {
    return false;
  }
}

// ---- run-scoped execution fence ----
// The service worker threads the current run's abort signal into every
// side-effecting browser tool so an aborted run (heartbeat failure / ownership
// loss) cannot commit an irreversible tab mutation. The SW sets the fence
// around orch.run() and clears it afterward; destructive tools check it at the
// mutation boundary (check-then-act must be fenced).

/** A per-tab capture mutex: two concurrent captures of the SAME tab must not
 * interleave (activate + capture + post-check is not atomic across calls), and
 * a losing capture must never return another capture's bytes. */
const captureLocks = new Map();
function withTabCaptureLock(tabId, fn) {
  const prev = captureLocks.get(tabId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  captureLocks.set(tabId, run.then(() => {}, () => {}));
  return run;
}

/** Validate a SINGLE grant record (id + scope + expiry + origin) together.
 * Returns the grant id when the record authorizes `origin`, else null. Reading
 * ONE record and validating id/scope/expiry/origin atomically closes the
 * separate-storage-reads race (the round-13 medium: a revoke→regrant could
 * otherwise slip between a scope check and an identity check). */
function validateGrantFor(grant, origin) {
  if (!grant || typeof grant !== "object") return null;
  if (grantExpired(grant)) return null;
  let authorized = false;
  if (grant.scope === "global") {
    authorized = true;
  } else if (
    grant.scope === "origins" && Array.isArray(grant.origins) &&
    grant.origins.length > 0
  ) {
    authorized = typeof origin === "string" && grant.origins.includes(origin);
  }
  if (!authorized) return null;
  if (typeof grant.id !== "string" || grant.id.length === 0) return null;
  return grant.id;
}

/** The POST-activation capture body (active-tab resolution + capture + post-
 * checks), extracted so the `if (tabId)` path can wrap it in a prior-tab restore
 * on ANY later failure (round-23 finding 7: a failed capture must never leave
 * the owner's active tab switched). `tabId` is the RAW requested tab id (or null
 * when capturing the already-active tab). */
async function captureActiveTab({ origin, grantIdBefore, tabId }) {
  // The active tab (its url is visible under activeTab / tabs).
  const active = (await chrome.tabs.query({ active: true, currentWindow: true }))
    .find((t) => !tabId || t.id === tabId) ?? null;
  if (!active?.id) return { error: "no active tab" };

  // Post-activation the tab could have navigated — re-derive + re-check BEFORE
  // capturing (closes the active-tab ABA: activation itself can race a nav).
  const cur = (await chrome.tabs.query({ active: true, currentWindow: true }))
    .find((t) => t.id === active.id) ?? null;
  const curOrigin = cur?.url
    ? (() => {
      try {
        return canonicalOrigin(cur.url);
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!curOrigin || curOrigin !== origin) {
    return { error: "tab navigated during capture — screenshot discarded" };
  }

  // DUrable ownership must be re-checked IMMEDIATELY before the capture
  // mutation (the round-21 finding: capture asserted ownership at function
  // entry, then performed several permission/tab/grant awaits before the
  // actual capture — no ownership assertion was adjacent to the mutation).
  try {
    await assertRunOwned();
  } catch {
    return { error: "run aborted — screenshot not captured" };
  }
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(
      cur.windowId ?? undefined,
      { format: "png" },
    );
  } catch (e) {
    return { error: `capture failed: ${e?.message ?? e}` };
  }

  // Post-capture re-checks (fail closed — discard the bytes on ANY doubt):
  // 1. the tab is STILL on the same origin (no navigation during capture);
  // 2. the SAME grant record still authorizes the SAME origin with the SAME
  //    id (closes the revoke→regrant ABA race atomically).
  const nowTab = (await chrome.tabs.query({ active: true, currentWindow: true }))
    .find((t) => t.id === active.id) ?? null;
  const nowOrigin = nowTab?.url
    ? (() => {
      try {
        return canonicalOrigin(nowTab.url);
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!nowOrigin || nowOrigin !== origin) {
    return { error: "tab navigated during capture — screenshot discarded" };
  }
  if (
    validateGrantFor(
      (await kvGet(GRANT_KEY))[GRANT_KEY],
      nowOrigin,
    ) !== grantIdBefore
  ) {
    return {
      error:
        "browser control grant changed during capture — screenshot discarded",
    };
  }
  if (!dataUrl || !String(dataUrl).startsWith("data:image/")) {
    return { error: "capture returned no image data" };
  }
  // Final DUrable ownership check at the post-capture COMMIT boundary: an
  // abort/ownership loss during the captureVisibleTab await must discard the
  // bytes rather than return them (the round-18 fence coverage finding).
  await assertRunOwned();
  return {
    screenshot: dataUrl,
    url: nowTab.url, // the SOURCE page, so the UI re-opens the page (not the data URL)
  };
}

/**
 * Capture a PNG screenshot of the active tab, gated by the browser-control
 * grant FOR THAT TAB'S ORIGIN. Uses chrome.tabs.captureVisibleTab (the standard
 * extension screenshot API — NOT the Chrome debugger (removed 2026-08-27)
 * and carries Chrome's all-sites warning) with an exact host grant for the
 * selected origin. `activeTab` is deliberately NOT a background/model fallback:
 * Chrome only activates its temporary host authority after a qualifying owner
 * invocation on the current tab (action/context-menu/command/omnibox).
 *
 * A model-selected tab is resolved and exact-origin-authorized before it is
 * activated. The active-tab ABA window is closed by re-deriving + re-checking
 * the origin AND the product grant identity before and after capture, under a
 * per-tab mutex.
 *
 * The OWNER-INVOKED path (ownerInvoked: true — ONLY the chrome.action
 * onClicked listener may pass it): Chrome's action click grants activeTab's
 * TRANSIENT authority for the tab the owner is viewing, which authorizes
 * captureVisibleTab for exactly that moment — no exact host grant is required
 * (the product browser-control grant is still validated). The persistent
 * optional `activeTab` permission merely ENABLES Chrome's transient grant; it
 * never authorizes a background/model-selected capture.
 */
export async function captureTabScreenshot(tabId, { ownerInvoked = false } = {}) {
  // Screenshot capture is a side-effecting boundary (it captures + may return
  // privileged page pixels) — fence it (the round-16 fence coverage finding).
  // DUrable ownership must be asserted BEFORE activation/capture, not merely the
  // signal after the fact (the round-20 durable-ownership-before-commit finding:
  // durable ownership can already be absent while the signal remains live).
  try {
    await assertRunOwned();
  } catch {
    return { error: "run aborted — screenshot not captured" };
  }
  return await withTabCaptureLock(tabId ?? "active", async () => {
    // Resolve the TARGET tab + its origin FIRST, BEFORE any activation, so the
    // grant can be checked BEFORE mutating the owner's active tab (the round-19
    // blocker: a denied capture still switched the active tab because activation
    // preceded the grant check).
    let target = null;
    if (tabId) {
      target = await chrome.tabs.get(tabId).catch(() => null);
    } else {
      target = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ??
        null;
    }
    if (!target?.id) return { error: "no tab" };

    const origin = target.url
      ? (() => {
        try {
          return canonicalOrigin(target.url);
        } catch {
          return undefined;
        }
      })()
      : undefined;
    if (!origin) {
      return {
        error: "cannot read the tab's exact origin — screenshot is waiting for an owner-selected site permission",
        waitingForPermission: true,
      };
    }
    const originPattern = `${origin}/*`;
    // The owner-invoked path carries Chrome's transient activeTab authority
    // (the action click) — exact host access is the MODEL/background gate only.
    const hasExactHost = ownerInvoked
      ? true
      : await chrome.permissions.contains({ origins: [originPattern] }).catch(() => false);
    if (!hasExactHost) {
      // Site access for the exact origin is missing (host access is normally
      // install-granted). The card names the site; approving it sets the
      // exact-origin browser-control grant — host access itself is only ever
      // (re)granted from Settings, and the error text says so.
      return permissionDenial(
        `screenshot is waiting for site access to ${originPattern} — grant it in Settings → Permissions`,
        { reason: `capture a screenshot of ${origin} (site access to ${originPattern} is missing)`, permissions: [], grantOrigins: [origin] },
      );
    }

    // The WHOLE capture (grant check + activation + capture + post-check) holds
    // the SAME grant lock as the grant setters/revoke, so a re-scope/revoke can
    // never interleave with the check + capture (the round-19 blocker: capture
    // used only withTabCaptureLock and never withGrantLock, so a re-scope
    // completed during captureVisibleTab).
    return await withGrantLock(async () => {
      // Read the grant ONCE and validate id + scope + expiry + origin together
      // (an atomic snapshot, not separate reads). Check BEFORE activation.
      const grantIdBefore = validateGrantFor(
        (await kvGet(GRANT_KEY))[GRANT_KEY],
        origin,
      );
      if (!grantIdBefore) {
        return permissionDenial(
          "browser control not granted for this tab's origin — the owner can approve it in the approval card here, or in Settings → Browser control",
          { reason: `capture a screenshot of ${origin}`, grantOrigins: [origin] },
        );
      }

          // Activate the requested tab (if any) so it is the active tab — capture
          // targets the ACTIVE tab under activeTab. Activating needs no permission,
          // and it now happens ONLY AFTER the grant check (a denied capture must
          // never change the owner's active tab).
          // Re-read + REVALIDATE the target identity IMMEDIATELY before activation
          // (after the grant check's awaits): a navigation between the pre-lock
          // snapshot and this point must not let us activate a newly-unauthorized
          // tab (the round-20 capture-navigation-race finding). `target.id` is the
          // RESOLVED tab id (from tabs.get OR the active-tab query) — never the
          // raw `tabId` which is undefined when capturing the active tab.
          const fresh = await chrome.tabs.get(target.id).catch(() => null);
          if (!fresh?.id) return { error: "no tab" };
          const freshOrigin = fresh.url
            ? (() => {
              try {
                return canonicalOrigin(fresh.url);
              } catch {
                return undefined;
              }
            })()
            : undefined;
          if (!freshOrigin || freshOrigin !== origin) {
            return {
              error:
                "tab navigated before capture — screenshot discarded (identity changed)",
            };
          }
          if (tabId) {
            // Query the PRIOR active tab FIRST (for restore on ANY later failure —
            // a failed capture must never leave the owner's active tab switched).
            const priorActive = (await chrome.tabs.query({ active: true, currentWindow: true }))
              .find((t) => t.id !== tabId) ?? null;
            // Re-read + REVALIDATE the target identity IMMEDIATELY before
            // activation (AFTER the prior-tab query await): the `fresh` read above
            // happened several awaits ago, and a navigation during the prior-tab
            // query could move the target to an unauthorized origin.
            const preActivate = await chrome.tabs.get(target.id).catch(() => null);
            const preOrigin = preActivate?.url
              ? (() => {
                try {
                  return canonicalOrigin(preActivate.url);
                } catch {
                  return undefined;
                }
              })()
              : undefined;
            if (!preOrigin || preOrigin !== origin) {
              return {
                error:
                  "tab navigated before capture — screenshot discarded (identity changed)",
              };
            }
            // DUrable ownership asserted IMMEDIATELY before the activation mutation
            // — NO await between this check and tabs.update (the round-25 blocker:
            // ownership was checked BEFORE the awaited preActivate identity get, so
            // ownership could be lost during that await yet the activation still
            // executed with ownedAtMutation:false).
            try {
              await assertRunOwned();
            } catch {
              return { error: "run aborted — tab not activated" };
            }
            try {
              await chrome.tabs.update(tabId, { active: true });
            } catch (e) {
              // The activation may have COMMITTED and then rejected (a race) —
              // restore the prior active tab so the owner's active tab is never
              // left switched (the round-24 commit-then-error finding).
              if (priorActive?.id) {
                try {
                  await chrome.tabs.update(priorActive.id, { active: true });
                } catch { /* best-effort restore */ }
              }
              return { error: `could not activate tab: ${e?.message ?? e}` };
            }
            // Immediate post-activation ownership check + restore on failure: an
            // abort during the tabs.update await must revert the activation, not
            // leave the owner's active tab switched.
            try {
              await assertRunOwned();
            } catch {
              if (priorActive?.id) {
                try {
                  await chrome.tabs.update(priorActive.id, { active: true });
                } catch { /* best-effort restore */ }
              }
              return { error: "run aborted — tab activation reverted" };
            }
            // Restore the prior active tab on ANY later failure (capture,
            // navigation, grant-change, final-fence) — not only on an abort
            // during activation — so a failed capture never leaves the owner's
            // active tab switched (the round-23 finding).
            const restorePrior = async () => {
              if (!priorActive?.id) return;
              try {
                await chrome.tabs.update(priorActive.id, { active: true });
              } catch { /* best-effort restore */ }
            };
            const withRestore = async (fn) => {
              try {
                return await fn();
              } catch (e) {
                await restorePrior();
                throw e;
              }
            };
            const captureRest = await withRestore(async () => {
              return await captureActiveTab({ origin, grantIdBefore, tabId });
            });
            if (captureRest.error) {
              await restorePrior();
              return captureRest;
            }
            return captureRest;
          }
          return await captureActiveTab({ origin, grantIdBefore, tabId: null });
    });
  });
}

/** Read the visible text of a tab (or the active tab) via scripting. */
export async function readPage(tabId) {
  try {
    if (!(await hasScriptingPermission())) {
      return permissionDeniedResult("scripting", { reason: "read the page's title, URL and visible text" });
    }
    const target = tabId
      ? { tabId }
      : await activeTab().then((t) => (t?.id ? { tabId: t.id } : null));
    if (!target) return { error: "no tab" };
    const results = await chrome.scripting.executeScript({
      target,
      func: () => ({
        title: document.title,
        url: location.href,
        text: (document.body?.innerText ?? "").slice(0, 20000),
      }),
    });
    const page = results?.[0]?.result;
    if (!page || typeof page !== "object") return { error: "no result" };
    // Page text is DATA from the web, never an instruction: the tag makes the
    // lazy projection wrap every string in the run's untrusted boundary
    // (lib/untrusted-fence.js, CAP-FB-20260830-UNTRUSTED-CONTENT-FENCING-01).
    return { untrusted: true, ...page };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** Tab-origin grant discipline for the T3 tabGroups mutations: the affected
 * tabs' origins are read INSIDE the grant lock (a navigation since any earlier
 * read must not smuggle an unauthorized origin past the check); the grant must
 * cover EVERY tab origin (grouping/moving a tab is that tab's mutation); tabs
 * with no origin (new-tab/chrome pages) need a GLOBAL grant. Durable ownership
 * is asserted adjacent to the mutation and re-checked after the await. */
async function withTabIdsGrant(tabIds, verb, mutate) {
  if (!(await hasTabsPermission())) {
    return permissionDenial(
      "tabs permission not granted — allow it in the approval card here, or in Settings → Permissions",
      {
        reason: `${verb === "grouped" ? "group" : verb === "ungrouped" ? "ungroup" : verb === "moved" ? "move" : "control"} your tabs`,
        permissions: ["tabs"],
      },
    );
  }
  return await withGrantLock(async () => {
    const tabs = await Promise.all(
      tabIds.map((id) => chrome.tabs.get(id).catch(() => null)),
    );
    if (tabs.some((t) => t == null)) return { error: "no such tab" };
    let hasOriginless = false;
    const origins = [...new Set(
      tabs
        .map((t) => {
          try {
            return t?.url ? canonicalOrigin(t.url) : null;
          } catch {
            return null;
          }
        })
        .filter((o) => {
          if (typeof o === "string") return true;
          // A tab with NO canonical origin (chrome://, edge://, devtools, a
          // fresh new-tab, …) is an origin-less scope: it must NEVER be
          // authorized by a per-origin grant. Any origin-less tab in the set
          // forces the GLOBAL grant (review finding, T3/T4 REVISE round).
          hasOriginless = true;
          return false;
        }),
    )];
    const covered = (hasOriginless || origins.length === 0)
      ? await isBrowserControlGranted(undefined)
      : (await Promise.all(origins.map((o) => isBrowserControlGranted(o)))).every(Boolean);
    if (!covered) {
      const needsGlobal = hasOriginless || origins.length === 0;
      return permissionDenial(
        "browser control not granted for every tab origin here — the owner can approve it in the approval card here, or in Settings → Browser control",
        {
          reason: needsGlobal
            ? `${verb} tabs (one has no single site — this needs the all-sites browser-control grant)`
            : `${verb} tabs on ${origins.join(", ")}`,
          grantOrigins: needsGlobal ? [] : origins,
          grantGlobal: needsGlobal,
        },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tabs not ${verb}` };
    }
    const result = await mutate(tabs);
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tabs ${verb} then aborted` };
    }
    return result;
  });
}

/** A tab group's own tabs are read inside the lock for the same origin
 * discipline (update_tab_group mutates the group = mutates its tabs). */
async function withTabGroupGrant(groupId, verb, mutate) {
  if (!(await hasTabsPermission())) {
    return permissionDenial(
      "tabs permission not granted — allow it in the approval card here, or in Settings → Permissions",
      { reason: `${verb} a tab group`, permissions: ["tabs"] },
    );
  }
  return await withGrantLock(async () => {
    const tg = tabGroupsApi();
    if (!tg) return { error: "tab groups API not available in this browser context" };
    const group = await tg.get(groupId).catch(() => null);
    if (!group) return { error: "no such tab group" };
    const tabIds = Array.isArray(group.tabIds) ? group.tabIds : [];
    const tabs = await Promise.all(
      tabIds.map((id) => chrome.tabs.get(id).catch(() => null)),
    );
    let hasOriginless = false;
    const origins = [...new Set(
      tabs
        .filter((t) => t != null && typeof t?.url === "string")
        .map((t) => {
          try {
            return canonicalOrigin(t.url);
          } catch {
            return null;
          }
        })
        .filter((o) => {
          if (typeof o === "string") return true;
          // Same rule as withTabIdsGrant: an origin-less tab in the group
          // forces the GLOBAL grant (review finding, T3/T4 REVISE round).
          hasOriginless = true;
          return false;
        }),
    )];
    const covered = (hasOriginless || origins.length === 0)
      ? await isBrowserControlGranted(undefined)
      : (await Promise.all(origins.map((o) => isBrowserControlGranted(o)))).every(Boolean);
    if (!covered) {
      const needsGlobal = hasOriginless || origins.length === 0;
      return permissionDenial(
        "browser control not granted for every tab origin in this group — the owner can approve it in the approval card here, or in Settings → Browser control",
        {
          reason: needsGlobal
            ? `${verb} a tab group (one tab has no single site — this needs the all-sites browser-control grant)`
            : `${verb} a tab group on ${origins.join(", ")}`,
          grantOrigins: needsGlobal ? [] : origins,
          grantGlobal: needsGlobal,
        },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tab group not ${verb}` };
    }
    const result = await mutate(group);
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tab group ${verb} then aborted` };
    }
    return result;
  });
}

/** Downloads are browser-wide (no single destination origin): a mutation needs
 * the GLOBAL browser-control grant — an origin-scoped grant must never
 * authorize a downloads mutation. */
async function withDownloadsGrant(verb, mutate) {
  if (!(await hasPermission("downloads"))) {
    return permissionDeniedResult("downloads", { reason: `${verb} downloads` });
  }
  return await withGrantLock(async () => {
    if (!(await isBrowserControlGranted(undefined))) {
      return permissionDenial(
        "browser control not granted for downloads — the owner can approve it in the approval card here, or in Settings → Browser control",
        { reason: `${verb} downloads (browser-wide — this needs the all-sites browser-control grant)`, grantGlobal: true },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — download not ${verb}` };
    }
    const result = await mutate();
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — download ${verb} then aborted` };
    }
    return result;
  });
}

/** The T4 download-file URL gate: ONLY http/https (never file://, chrome://,
 * extension://, data:, blob:, etc.). */
function isDownloadableUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048) return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

/** Sanitize the optional download filename: no traversal (leading "/" and ".."
 * segments stripped), backslashes folded to "/", NUL/control bytes removed,
 * bounded length + segment count. Returns null when nothing usable remains. */
function sanitizeDownloadFilename(raw, maxBytes = 256, maxSegments = 8) {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/\\/g, "/")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u001f\u007f]/g, "")
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .slice(0, maxSegments)
    .join("/");
  if (!cleaned) return null;
  const bytes = new TextEncoder().encode(cleaned).byteLength;
  if (bytes > maxBytes) return null;
  return cleaned;
}

// ── Tranche-11 Chrome API coverage helpers (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01): ──
// extension/browser management (chrome.management), own-runtime info
// (chrome.runtime), side-panel configuration (chrome.sidePanel), and toolbar
// action enable/disable (chrome.action). Every MUTATION here is browser-wide /
// this-extension-own-surface — it has NO single destination web origin — so it
// rides the GLOBAL browser-control grant (isBrowserControlGranted(undefined)),
// exactly as downloads do. An origin-scoped grant must NEVER authorize them.
// chrome.management is a NEW optional permission (Settings capability row
// grants it from a genuine owner gesture; the service worker never requests).
// runtime/sidePanel/action need no new permission (sidePanel is already
// declared).
async function hasManagementPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["management"] });
  } catch {
    return false;
  }
}

/** This extension's own id — used to REFUSE self-toggle / self-uninstall. */
function selfExtensionId() {
  try {
    return typeof chrome !== "undefined" ? chrome.runtime?.id ?? null : null;
  } catch {
    return null;
  }
}

/** GLOBAL-grant gate for chrome.management mutations (browser-wide; a
 * per-origin grant never authorizes them). Mirrors withDownloadsGrant. */
async function withManagementGrant(verb, mutate) {
  if (!(await hasManagementPermission())) {
    return permissionDeniedResult("management", { reason: `${verb} an extension` });
  }
  return await withGrantLock(async () => {
    if (!(await isBrowserControlGranted(undefined))) {
      return permissionDenial(
        "browser control not granted for extension management — the owner can approve it in the approval card here, or in Settings → Browser control",
        { reason: `${verb} an extension (browser-wide — this needs the all-sites browser-control grant)`, grantGlobal: true },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — extension not ${verb}` };
    }
    const result = await mutate();
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — extension ${verb} then aborted` };
    }
    return result;
  });
}



// ── T10 network rules helpers (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01) ──
// chrome.declarativeNetRequest dynamic rules are BROWSER-WIDE (a rule applies
// to matching requests everywhere): every mutation needs the GLOBAL
// browser-control grant — an origin grant is never enough. Reads stay light
// (permission-gated only). MV3 note: this tranche is OBSERVATION + dynamic
// rules only; blocking webRequest requires enterprise policy and is EXCLUDED.

const DNR_MAX_DYNAMIC_RULES = 100; // bounded house cap; refuse over-cap honestly
const DNR_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xml_http_request", "ping", "csp_report", "media", "websocket",
  "other",
];

/** Network rules are browser-wide: mutations ride the GLOBAL grant only
 * (same discipline as downloads). Reads never use this. */
async function withNetworkRulesGrant(verb, mutate) {
  if (!(await hasPermission("declarativeNetRequest"))) {
    return permissionDeniedResult("declarativeNetRequest", { reason: `${verb} network rules` });
  }
  return await withGrantLock(async () => {
    if (!(await isBrowserControlGranted(undefined))) {
      return permissionDenial(
        "browser control not granted for network rules — the owner can approve it in the approval card here, or in Settings → Browser control (global grant required: rules apply browser-wide)",
        { reason: `${verb} network rules (browser-wide — this needs the all-sites browser-control grant)`, grantGlobal: true },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — network rule not ${verb}` };
    }
    const result = await mutate();
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — network rule ${verb} then aborted` };
    }
    return result;
  });
}

/** Bounded rule-shape validation shared by add/update. Returns
 * { error } or { rule } (Chrome-shaped). Runs BEFORE any Chrome call:
 * a regexFilter that fails `new RegExp` construction is refused up front. */
function buildDnrRule(input, ruleId) {
  const rule = { id: ruleId, priority: input.priority ?? 1, action: {}, condition: {} };
  if (input.action === "modifyHeaders") {
    return {
      error:
        "modifyHeaders is not supported by this bounded rule shape (it needs header operation lists) — use block, allow, redirect or upgradeScheme",
    };
  }
  rule.action.type = input.action;
  if (input.action === "redirect") {
    let redirectUrl;
    try {
      redirectUrl = new URL(input.redirectUrl ?? "");
    } catch {
      return { error: "redirect rules need a redirectUrl (http/https only)" };
    }
    if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
      return { error: "redirect rules need a redirectUrl (http/https only)" };
    }
    rule.action.redirect = { url: redirectUrl.href };
  }
  if (!input.urlFilter && !input.regexFilter) {
    return { error: "pass a urlFilter or a regexFilter (the rule condition)" };
  }
  if (input.urlFilter) rule.condition.urlFilter = input.urlFilter;
  if (input.regexFilter) {
    try {
      new RegExp(input.regexFilter); // reject non-constructible patterns BEFORE the API
    } catch {
      return { error: "regexFilter is not a constructible regular expression" };
    }
    rule.condition.regexFilter = input.regexFilter;
  }
  if (input.resourceTypes) rule.condition.resourceTypes = input.resourceTypes;
  if (input.requestDomains) rule.condition.requestDomains = input.requestDomains;
  return { rule };
}

/** Serialize one dynamic rule with honest caps (bounded output). */
function boundedDnrRule(rule) {
  return {
    id: rule?.id ?? null,
    priority: rule?.priority ?? 1,
    action: rule?.action?.type ? String(rule.action.type).slice(0, 32) : null,
    redirectUrl: rule?.action?.redirect?.url
      ? String(rule.action.redirect.url).slice(0, 2048)
      : null,
    urlFilter: rule?.condition?.urlFilter ? String(rule.condition.urlFilter).slice(0, 500) : null,
    regexFilter: rule?.condition?.regexFilter ? String(rule.condition.regexFilter).slice(0, 500) : null,
    resourceTypes: Array.isArray(rule?.condition?.resourceTypes)
      ? rule.condition.resourceTypes.slice(0, 16).map((t) => String(t).slice(0, 32))
      : [],
    requestDomains: Array.isArray(rule?.condition?.requestDomains)
      ? rule.condition.requestDomains.slice(0, 20).map((d) => String(d).slice(0, 253))
      : [],
  };
}

/** Rolling request-activity ring buffer (webRequest observation, MV3
 * non-blocking). SEPARATE from the navigation/tab event buffer on purpose:
 * request events are high-frequency (dozens per page load) and would drown
 * the 200-entry tab/navigation log. Capped at 100 entries. */
const REQUEST_ACTIVITY_KEY = "cap:requestActivity";
export async function recordRequestActivity(entry) {
  const stored = await kvGet(REQUEST_ACTIVITY_KEY);
  const list = stored[REQUEST_ACTIVITY_KEY] ?? [];
  list.unshift({ at: new Date().toISOString(), ...entry });
  await kvSet({ [REQUEST_ACTIVITY_KEY]: list.slice(0, 100) });
}

// ── T12 power tools: grant discipline ───────────────────────────────────────
// User scripts and dynamic content scripts inject code into matched origins:
// every matches pattern must be ONE exact http(s) origin (<all_urls>,
// wildcard-subdomain and multi-origin patterns refused), and the product grant
// must cover EVERY matches origin — the corrected house discipline (mirror of
// withTabIdsGrant): any origin-less scope or an empty origin set forces the
// GLOBAL grant; only all-origin sets may be satisfied by per-origin grants.
// Host permissions for matched origins must already be granted via the
// Settings flow — the service worker never requests them.
//
// chrome.debugger (CDP) was declared here and is REMOVED (2026-08-27, owner
// decision Q17): it carries Chrome's all-sites permission warning and the
// persistent "started debugging this browser" bar. The tools and the optional
// permission may return later behind a separate developer-only surface.

/** Validate a script `matches` list as single exact http(s) origin patterns
 * (pure; never throws). Returns { patterns, origins } or { error } — reuses
 * the T8 single-origin validator (<all_urls>, wildcard-subdomain, decorated
 * and multi-origin patterns are refused). */
function t12ScriptMatches(matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return { error: "matches must be a non-empty array of single-origin patterns" };
  }
  const patterns = [];
  const origins = [];
  for (const m of matches) {
    const v = t8SingleOriginPattern(m);
    if (!v.ok) return { error: `matches rejected: ${v.error}` };
    if (!patterns.includes(v.value)) {
      patterns.push(v.value);
      // t8SingleOriginPattern guarantees a normalized exact-origin pattern,
      // but fail closed if canonicalOrigin ever disagrees.
      const origin = canonicalOrigin(v.value);
      if (typeof origin !== "string" || !origin) {
        return { error: "matches rejected: a pattern produced no canonical origin" };
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
  }
  return { patterns, origins };
}

/** The corrected house coverage check for script origin sets — mirror of
 * withTabIdsGrant (T3/T4 REVISE round). Call INSIDE withGrantLock. Any
 * origin-less entry (null) or an empty set forces the GLOBAL grant; only
 * all-origin sets may be satisfied by per-origin grants. Origin-less entries
 * are counted, NEVER filtered out. */
async function t12OriginsCovered(origins) {
  let hasOriginless = false;
  const named = [];
  for (const o of origins ?? []) {
    if (typeof o === "string" && o) named.push(o);
    else hasOriginless = true;
  }
  if (hasOriginless || named.length === 0) {
    return await isBrowserControlGranted(undefined);
  }
  return (await Promise.all(named.map((o) => isBrowserControlGranted(o)))).every(Boolean);
}

/** Register/update discipline for user scripts + dynamic content scripts:
 * the API permission + the exact-origin HOST permission for every matches
 * pattern must already be granted (the service worker never calls
 * permissions.request itself), then grant coverage + durable ownership run
 * inside the grant lock (check-then-act atomic w.r.t. revoke). */
async function withScriptRegistrationGrant({ permission, permissionLabel, patterns, origins }, verb, mutate) {
  if (!(await hasPermission(permission))) {
    return {
      error: `${permission} permission not granted — allow it in the approval card here, or in Settings → Permissions`,
    };
  }
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) {
      return { error: `${permission} host access unavailable on this platform — capture is not possible here` };
    }
    if (!(await chrome.permissions.contains({ origins: patterns }))) {
      return {
        error: `host permission not granted for every matches origin (${origins.join(", ")}) — enable host access from the chat when prompted, or in Settings → Permissions`,
      };
    }
  } catch {
    return { error: `host permission check failed — the grant state could not be read; try again` };
  }
  return await withGrantLock(async () => {
    if (!(await t12OriginsCovered(origins))) {
      return permissionDenial(
        "browser control not granted for every matches origin here — the owner can approve it in the approval card here, or in Settings → Browser control",
        { reason: `run a script on ${origins.join(", ")}`, grantOrigins: origins },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — script not ${verb}` };
    }
    let result;
    try {
      result = await mutate();
    } catch (e) {
      return { error: `script ${verb} failed: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — script ${verb} then aborted` };
    }
    return result;
  });
}

/** The browser-control toolset, passed into the agent. */
export function browserToolset(readOnly = false, { scheduleScriptGate = null } = {}) {
  // SCOPED (hook) runs are side-effect-free: untrusted browser event data must
  // never drive a browser mutation (open/navigate/close a tab) or a durable
  // schedule. When readOnly, expose only the READ tools (read_page,
  // capture_screenshot, list_tabs, recent_browser_events).
  const all = {
    open_side_panel: tool({
      description:
        "Open the Chrome side panel and load a page in it so you can watch and act on that page (its WebMCP tools are discovered via the content bridge). Requires the sidePanel permission.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        // Scheme guard FIRST (see webDestination): the panel loads a web page.
        const dest = webDestination(url);
        if (dest.error) return { error: dest.error };
        if (!(await hasSidePanelPermission())) {
          return permissionDeniedResult("sidePanel", { reason: `open ${url} in the side panel` });
        }
        // Get the active tab so the panel is bound to it (chrome.sidePanel is
        // per-tab). The panel reads the target URL on load (sidepanel.getTarget).
        const active = (
          await chrome.tabs.query({ active: true, currentWindow: true })
        )[0];
        if (!active?.id) return { error: "no active tab to bind the side panel" };
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — side panel not opened" };
        }
        // Store the target URL for the panel to load, then open the panel.
        await kvSet({ "cap:sidepanelTarget": url });
        try {
          await chrome.sidePanel.setOptions({
            tabId: active.id,
            path: "sidepanel/sidepanel.html",
            enabled: true,
          });
          await chrome.sidePanel.open({ tabId: active.id });
        } catch (e) {
          return { error: `side panel could not open: ${e?.message ?? e}` };
        }
        return { ok: true, url };
      },
    }),
    open_tab: tool({
      description:
        "Open a URL in a new browser tab. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) => {
        // Scheme guard FIRST: a chrome:/file:/about:/data: destination can
        // never be authorized, so it is refused before any permission check.
        const dest = webDestination(url);
        if (dest.error) return { error: dest.error };
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs", { reason: `open ${url} in a new tab` });
        }
        // Check the DESTINATION origin against the grant (a per-origin grant
        // only authorizes its own origins; a global grant authorizes all).
        let destOrigin;
        try {
          destOrigin = canonicalOrigin(url);
        } catch {
          return { error: "invalid url" };
        }
        // Check the grant + perform the mutation under the SAME grant lock: a
        // revoke can no longer interleave with the checked tabs.create (the
        // round-17 check-then-act blocker).
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(destOrigin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `open ${destOrigin} in a new tab`, grantOrigins: [destOrigin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab not opened" };
          }
          const tab = await chrome.tabs.create({ url });
          // Re-check the fence AFTER the await, before returning success: an
          // abort/ownership loss during tabs.create must NOT report a committed
          // open. Compensate (close the just-opened tab) + return aborted (the
          // round-18 fence coverage finding + round-19 durable ownership).
          try {
            await assertRunOwned();
          } catch {
            try {
              await chrome.tabs.remove(tab.id);
            } catch { /* best-effort compensation */ }
            return { error: "run aborted — tab opened then closed" };
          }
          return { ok: true, tabId: tab.id, url };
        });
      },
    }),
    navigate_tab: tool({
      description:
        "Navigate an existing tab to a URL. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({
        tabId: z.number().optional(),
        url: z.string().url(),
      }),
      execute: async ({ tabId, url }) => {
        // Scheme guard FIRST (see webDestination): never navigate a tab to a
        // privileged or non-web scheme, whatever the grant says.
        const dest = webDestination(url);
        if (dest.error) return { error: dest.error };
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs", { reason: `navigate a tab to ${url}` });
        }
        // Check the DESTINATION origin (not just the current tab's origin): an
        // approved origin must not be navigated to an unapproved one.
        let destOrigin;
        try {
          destOrigin = canonicalOrigin(url);
        } catch {
          return { error: "invalid url" };
        }
        const id = tabId ?? (await activeTab())?.id;
        if (!id) return { error: "no tab" };
        // Check BOTH origins + perform the mutation under the SAME grant lock
        // (a revoke can no longer interleave with the checked tabs.update).
        return await withGrantLock(async () => {
          // Re-read the SOURCE tab INSIDE the grant lock, immediately before the
          // mutation, so the source identity is authorized atomically with the
          // navigate (the round-19 blocker: the source was snapshotted BEFORE the
          // lock, so an authorized-B→unauthorized-C move still navigated C).
          const srcTab = await chrome.tabs.get(id).catch(() => null);
          const srcOrigin = srcTab?.url
            ? (() => {
              try {
                return canonicalOrigin(srcTab.url);
              } catch {
                return undefined;
              }
            })()
            : undefined;
          if (!(await isBrowserControlGranted(destOrigin))) {
            return permissionDenial(
              "browser control not granted for the destination origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `navigate a tab to ${destOrigin}`, grantOrigins: [destOrigin] },
            );
          }
          if (!(await isBrowserControlGranted(srcOrigin))) {
            return permissionDenial(
              "browser control not granted for the source tab's origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: srcOrigin ? `navigate away from ${srcOrigin}` : "navigate a tab that has no single site (this needs the all-sites browser-control grant)", grantOrigins: srcOrigin ? [srcOrigin] : [], grantGlobal: !srcOrigin },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab not navigated" };
          }
          // Re-read the SOURCE tab identity IMMEDIATELY before the mutation (after
          // the grant-check awaits): the earlier srcTab read was several awaits ago,
          // and a real page navigation in that gap could have moved the tab from an
          // authorized origin to an unauthorized one (the round-20 navigation-
          // source-race finding — the source snapshot raced real page navigation).
          // Re-derive + compare the origin NOW, bound to the mutation.
          const boundSrc = await chrome.tabs.get(id).catch(() => null);
          const boundOrigin = boundSrc?.url
            ? (() => {
              try {
                return canonicalOrigin(boundSrc.url);
              } catch {
                return undefined;
              }
            })()
            : undefined;
          if (!boundOrigin || boundOrigin !== srcOrigin) {
            return {
              error:
                "tab navigated before navigate — source identity changed",
            };
          }
          // DUrable ownership re-checked IMMEDIATELY before the navigation
          // mutation (no other await between this check and tabs.update) — the
          // round-21 finding that navigate asserted ownership before an awaited
          // second identity read, not adjacent to the mutation.
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab not navigated" };
          }
          await chrome.tabs.update(id, { url });
          // Re-check the fence AFTER the await: an abort during tabs.update must
          // not report success (the navigation side effect may be irreversible,
          // so we return aborted rather than claim ok — the round-18 finding).
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab navigated then aborted" };
          }
          return { ok: true, tabId: id, url };
        });
      },
    }),
    read_page: tool({
      description:
        "Read the title, URL and visible text of a tab (or the active tab).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => readPage(tabId),
    }),
    capture_screenshot: tool({
      description:
        "Capture a PNG screenshot of the requested tab (or the active tab). Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => captureTabScreenshot(tabId),
    }),
    list_tabs: tool({
      description: "List the open tabs.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs", { reason: "list your open tabs" });
        }
        const tabs = await chrome.tabs.query({});
        return {
          tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })),
        };
      },
    }),
    close_tab: tool({
      description:
        "Close a tab by id. Requires browser-control permission (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number() }),
      execute: async ({ tabId }) => {
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs", { reason: "close a tab" });
        }
        // Check the grant + perform the mutation under the SAME grant lock (a
        // revoke can no longer interleave with the checked tabs.remove).
        return await withGrantLock(async () => {
          // Re-read the SOURCE tab INSIDE the lock (the round-20 blocker: close
          // snapshotted the tab/origin BEFORE the lock, so an unauthorized page
          // could replace the authorized source before removal).
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          const origin = tab?.url
            ? (() => {
              try {
                return canonicalOrigin(tab.url);
              } catch {
                return undefined;
              }
            })()
            : undefined;
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: origin ? `close a tab on ${origin}` : "close a tab that has no single site (this needs the all-sites browser-control grant)", grantOrigins: origin ? [origin] : [], grantGlobal: !origin },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab not closed" };
          }
          // Re-read + compare the tab identity IMMEDIATELY before the mutation
          // (after the grant-check awaits): a navigation since the read above must
          // not close a newly-unauthorized tab (the round-20 close-identity race).
          const bound = await chrome.tabs.get(tabId).catch(() => null);
          const boundOrigin = bound?.url
            ? (() => {
              try {
                return canonicalOrigin(bound.url);
              } catch {
                return undefined;
              }
            })()
            : undefined;
          if (!boundOrigin || boundOrigin !== origin) {
            return {
              error:
                "tab navigated before close — source identity changed",
            };
          }
          // DUrable ownership re-checked IMMEDIATELY before the close mutation
          // (no other await between this check and tabs.remove) — the round-21
          // finding that close asserted ownership before an awaited second
          // identity read, not adjacent to the mutation.
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab not closed" };
          }
          await chrome.tabs.remove(tabId);
          // Re-check the fence AFTER the await: an abort/ownership loss during
          // tabs.remove must not report success (the round-18 finding + round-19
          // durable ownership).
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tab closed then aborted" };
          }
          return { ok: true, tabId };
        });
      },
    }),
    recent_browser_events: tool({
      description:
        "Read the recent browser events (tab opened/updated/navigated).",
      inputSchema: z.object({ limit: z.number().optional() }),
      execute: async ({ limit }) => {
        const events = await kvGet("cap:events");
        const list = events["cap:events"] ?? [];
        return { events: list.slice(0, limit ?? 20) };
      },
    }),
    schedule_task: tool({
      description:
        "Schedule a future task to run the agent. REQUIRED: pass exactly one of `at` (absolute epoch ms in the future) or `delayMs` (a positive delay in ms) — a call with neither fails. The task runs even if the browser is idle. Pass scriptId (a script you created with create_script) to run that JS directly on the schedule — no model re-invocation.",
      inputSchema: z.object({
        task: z.string().min(1).max(4000),
        at: z.number().optional().describe("absolute epoch ms in the future — pass this OR delayMs, exactly one is required"),
        delayMs: z.number().optional().describe("positive delay in ms from now — pass this OR at, exactly one is required"),
        periodInMinutes: z.number().optional(),
        scriptId: z.string().optional().describe("run this script instead of the model"),
      }),
      execute: async ({ task, at, delayMs, periodInMinutes, scriptId }) => {
        // schedule_task is a durable side-effecting boundary (persists a payload
        // + creates a Chrome alarm) — fence it (the round-16 fence coverage
        // finding: schedule_task persisted without a run-abort check). DUrable
        // ownership must be asserted BEFORE the commit, not just the signal (the
        // round-20 durable-ownership-before-commit finding).
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — task not scheduled" };
        }
        // A scheduled SCRIPT pays the same owner approval as run_script (the
        // card shows the source + the hosts it fetches) BEFORE the schedule is
        // committed; with no gate bound (no run context) it fails closed
        // (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01).
        if (scriptId) {
          if (typeof scheduleScriptGate !== "function") {
            return { ok: false, error: "scheduling a saved script requires owner approval, which this run cannot request" };
          }
          const gate = await scheduleScriptGate(scriptId);
          if (!gate || gate.ok !== true) return gate ?? { ok: false, error: "scheduling the script was not approved" };
        }
        // The ONE atomic scheduling path (shared with the register-task route).
        // Attribute the schedule to the run that created it: the SW stamps the
        // active run's surface (threadId/agentRole/agentSurfaceRef) into
        // run-context around every runTask, so the FIRED run — long after this
        // one settles — projects back into this agent/thread's conversation
        // (the owner report: alarm runs were invisible in the Agents view).
        const runCtx = currentRunContext();
        const { name, when } = await scheduleTask({
          task,
          at,
          delayMs,
          periodInMinutes,
          scriptId,
          owner: runCtx
            ? { threadId: runCtx.threadId, agentRole: runCtx.agentRole, agentSurfaceRef: runCtx.agentSurfaceRef }
            : null,
        });
        return { ok: true, name, when };
      },
    }),
    // ── Tranche-1 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
    // windows (query/create/manage), chrome.action state, commands list. NO new
    // manifest permission: windows/action/commands need none. Window MUTATIONS
    // go through the SAME scoped/expiring browser-control grant as their tabs
    // siblings (create_window with a url is open_tab-equivalent; focus/close/
    // move re-read the window's tab origins INSIDE the grant lock and require
    // the grant to cover EVERY one — a window mutation is every tab's mutation).
    list_windows: tool({
      description:
        "List the browser windows (id, focused, type, state, bounds). No tab contents or URLs are returned.",
      inputSchema: z.object({}),
      execute: async () => {
        const api = chromeApi("windows");
        if (!api) return { error: "windows API not available in this browser context" };
        const wins = await api.getAll({});
        return {
          windows: wins.slice(0, 64).map((w) => ({
            id: w.id,
            focused: w.focused === true,
            type: typeof w.type === "string" ? w.type : "normal",
            state: typeof w.state === "string" ? w.state : "normal",
            left: w.left ?? null,
            top: w.top ?? null,
            width: w.width ?? null,
            height: w.height ?? null,
          })),
        };
      },
    }),
    create_window: tool({
      description:
        "Open a new browser window, optionally at a URL. Requires browser-control permission (scoped + expiring); a URL destination must be inside the granted origin(s).",
      inputSchema: z.object({
        url: z.string().url().max(2048).optional(),
        focused: z.boolean().optional(),
        left: z.number().int().min(0).max(100000).optional(),
        top: z.number().int().min(0).max(100000).optional(),
        width: z.number().int().min(100).max(10000).optional(),
        height: z.number().int().min(100).max(10000).optional(),
      }),
      execute: async ({ url, focused, left, top, width, height }) => {
        // Scheme guard FIRST when a destination is given (see webDestination).
        if (url !== undefined) {
          const dest = webDestination(url);
          if (dest.error) return { error: dest.error };
        }
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs", { reason: `open a new window${url ? ` on ${url}` : ""}` });
        }
        let destOrigin;
        if (url !== undefined) {
          try {
            destOrigin = canonicalOrigin(url);
          } catch {
            return { error: "invalid url" };
          }
        }
        return await withGrantLock(async () => {
          // No URL ⇒ the window opens Chrome's NTP — an origin-less mutation
          // scope that ONLY a global grant authorizes (undefined origin).
          if (!(await isBrowserControlGranted(destOrigin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: destOrigin ? `open a new window on ${destOrigin}` : "open a new window on the new-tab page (this needs the all-sites browser-control grant)", grantOrigins: destOrigin ? [destOrigin] : [], grantGlobal: !destOrigin },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — window not opened" };
          }
          const create = { url, focused, left, top, width, height };
          for (const k of Object.keys(create)) if (create[k] === undefined) delete create[k];
          const win = await chrome.windows.create(create);
          // Re-check the fence AFTER the await; compensate by closing the
          // just-opened window (mirrors open_tab's round-18/19 discipline).
          try {
            await assertRunOwned();
          } catch {
            try {
              await chrome.windows.remove(win.id);
            } catch { /* best-effort compensation */ }
            return { error: "run aborted — window opened then closed" };
          }
          return { ok: true, windowId: win.id, url: url ?? null };
        });
      },
    }),
    focus_window: tool({
      description:
        "Bring a window to the front by id. Requires browser-control permission (scoped + expiring) covering every tab origin in the window.",
      inputSchema: z.object({ windowId: z.number().int() }),
      execute: async ({ windowId }) =>
        await mutateWindowWithGrant(windowId, "focused", async () => {
          await chrome.windows.update(windowId, { focused: true });
          return { ok: true, windowId, focused: true };
        }),
    }),
    close_window: tool({
      description:
        "Close a window by id (closing every tab in it). Requires browser-control permission (scoped + expiring) covering every tab origin in the window.",
      inputSchema: z.object({ windowId: z.number().int() }),
      execute: async ({ windowId }) =>
        await mutateWindowWithGrant(windowId, "closed", async () => {
          await chrome.windows.remove(windowId);
          return { ok: true, windowId, closed: true };
        }),
    }),
    move_window: tool({
      description:
        "Move/resize a window or set its state (normal/minimized/maximized/fullscreen) by id. Requires browser-control permission (scoped + expiring) covering every tab origin in the window.",
      inputSchema: z.object({
        windowId: z.number().int(),
        left: z.number().int().min(-100000).max(100000).optional(),
        top: z.number().int().min(-100000).max(100000).optional(),
        width: z.number().int().min(100).max(10000).optional(),
        height: z.number().int().min(100).max(10000).optional(),
        state: z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional(),
      }),
      execute: async ({ windowId, left, top, width, height, state }) =>
        await mutateWindowWithGrant(windowId, "moved", async () => {
          const update = { left, top, width, height, state };
          for (const k of Object.keys(update)) if (update[k] === undefined) delete update[k];
          if (Object.keys(update).length === 0) return { error: "nothing to move — pass left/top/width/height or state" };
          await chrome.windows.update(windowId, update);
          return { ok: true, windowId, ...update };
        }),
    }),
    set_action_state: tool({
      description:
        "Set this extension's own toolbar action state (badge text/colour, hover title, icon). Owner-scoped surface; no browser-control grant needed.",
      inputSchema: z.object({
        badgeText: z.string().max(8).optional(),
        badgeColor: z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u).optional(),
        title: z.string().max(128).optional(),
        iconPath: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_/.-]{0,62}\.png$/u).refine((p) => !p.includes("..") && !p.startsWith("/"), "extension-relative icon path only").optional(),
      }).refine((v) => Object.values(v).some((x) => x !== undefined), "at least one action field is required"),
      execute: async ({ badgeText, badgeColor, title, iconPath }) => {
        const api = chromeApi("action");
        if (!api) return { error: "action API not available in this browser context" };
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — action not changed" };
        }
        const applied = [];
        try {
          if (badgeText !== undefined) { await api.setBadgeText({ text: badgeText }); applied.push("badgeText"); }
          if (badgeColor !== undefined) { await api.setBadgeBackgroundColor({ color: badgeColor }); applied.push("badgeColor"); }
          if (title !== undefined) { await api.setTitle({ title }); applied.push("title"); }
          if (iconPath !== undefined) { await api.setIcon({ path: iconPath }); applied.push("iconPath"); }
        } catch (e) {
          return { error: `action update failed: ${e?.message ?? e}`, applied };
        }
        return { ok: true, applied };
      },
    }),
    get_action_state: tool({
      description:
        "Read this extension's own toolbar action state (badge text/colour, hover title).",
      inputSchema: z.object({}),
      execute: async () => {
        const api = chromeApi("action");
        if (!api) return { error: "action API not available in this browser context" };
        const [badgeText, title, bg] = await Promise.all([
          api.getBadgeText({}),
          api.getTitle({}),
          api.getBadgeBackgroundColor({}),
        ]);
        const color = Array.isArray(bg) && bg.length >= 3
          ? `#${bg.slice(0, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`
          : null;
        return { badgeText: String(badgeText ?? ""), title: String(title ?? ""), badgeColor: color };
      },
    }),
    list_commands: tool({
      description:
        "List the extension's declared keyboard commands (name, shortcut, description). Read-only.",
      inputSchema: z.object({}),
      execute: async () => {
        const api = chromeApi("commands");
        if (!api) return { error: "commands API not available in this browser context" };
        const commands = await api.getAll();
        return {
          commands: (Array.isArray(commands) ? commands : []).slice(0, 32).map((c) => ({
            name: String(c?.name ?? "").slice(0, 128),
            shortcut: String(c?.shortcut ?? "").slice(0, 64),
            description: String(c?.description ?? "").slice(0, 256),
          })),
        };
      },
    }),
    // ── Tranche-2 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
    // alarms, bookmarks, notifications, idle, contextMenus (declared optional permissions).
    create_alarm: tool({
      description:
        "Create a raw scheduled alarm by name with a delay or period in minutes (low-level alarm trigger; for scheduling autonomous agent tasks or scripts, use schedule_task instead). Requires alarms permission.",
      inputSchema: z.object({
        name: z.string().min(1).max(64),
        delayInMinutes: z.number().min(0.1).max(100000).optional(),
        periodInMinutes: z.number().min(1).max(100000).optional(),
        when: z.number().int().min(0).optional(),
      }).refine((v) => v.delayInMinutes !== undefined || v.periodInMinutes !== undefined || v.when !== undefined, "at least one scheduling field is required"),
      execute: async ({ name, delayInMinutes, periodInMinutes, when }) => {
        if (!(await hasPermission("alarms"))) {
          return permissionDeniedResult("alarms");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — alarm not created" };
        }
        const info = {};
        if (delayInMinutes !== undefined) info.delayInMinutes = delayInMinutes;
        if (periodInMinutes !== undefined) info.periodInMinutes = periodInMinutes;
        if (when !== undefined) info.when = when;
        // Register the raw alarm BEFORE creating it so a `when≈now` one-shot
        // cannot fire into the gap and be reaped as a false orphan. Registration
        // tells the scheduler's fire-time orphan reaper this alarm has NO task
        // payload BY DESIGN: a periodic raw alarm is meant to recur (the
        // indiscriminate reap was wrongly killing raw periodic alarms on first
        // fire). If the create itself fails, roll the registration back so the
        // registry stays exact.
        const rawBefore = (await kvGet(RAW_ALARM_KEY))[RAW_ALARM_KEY] ?? [];
        if (!rawBefore.includes(name)) await kvSet({ [RAW_ALARM_KEY]: [...rawBefore, name] });
        try {
          await chrome.alarms.create(name, info);
        } catch (e) {
          await kvSet({ [RAW_ALARM_KEY]: rawBefore }).catch(() => {});
          throw e;
        }
        return { ok: true, name, ...info };
      },
    }),
    list_alarms: tool({
      description:
        "List all scheduled extension alarms (name, scheduledTime, periodInMinutes). Requires alarms permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("alarms"))) {
          return permissionDeniedResult("alarms");
        }
        const alarms = await chrome.alarms.getAll();
        return {
          alarms: (Array.isArray(alarms) ? alarms : []).slice(0, 64).map((a) => ({
            name: a.name,
            scheduledTime: a.scheduledTime,
            periodInMinutes: a.periodInMinutes ?? null,
          })),
        };
      },
    }),
    clear_alarm: tool({
      description:
        "Clear a scheduled alarm by name. Requires alarms permission.",
      inputSchema: z.object({
        name: z.string().min(1).max(64),
      }),
      execute: async ({ name }) => {
        if (!(await hasPermission("alarms"))) {
          return permissionDeniedResult("alarms");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — alarm not cleared" };
        }
        const cleared = await chrome.alarms.clear(name);
        if (cleared) {
          const raw = (await kvGet(RAW_ALARM_KEY))[RAW_ALARM_KEY] ?? [];
          await kvSet({ [RAW_ALARM_KEY]: raw.filter((n) => n !== name) });
        }
        return { ok: true, name, cleared: cleared === true };
      },
    }),
    create_bookmark: tool({
      description:
        "Create a new bookmark or bookmark folder. Requires bookmarks permission.",
      inputSchema: z.object({
        title: z.string().min(1).max(256),
        url: z.string().url().max(2048).optional(),
        parentId: z.string().max(64).optional(),
      }),
      execute: async ({ title, url, parentId }) => {
        if (!(await hasPermission("bookmarks"))) {
          return permissionDeniedResult("bookmarks");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — bookmark not created" };
        }
        const details = { title };
        if (url !== undefined) details.url = url;
        if (parentId !== undefined) details.parentId = parentId;
        const bm = await chrome.bookmarks.create(details);
        return { ok: true, id: bm.id, title: bm.title, url: bm.url ?? null, parentId: bm.parentId ?? null };
      },
    }),
    list_bookmarks: tool({
      description:
        "Search or list browser bookmarks (id, title, url, parentId). Requires bookmarks permission.",
      inputSchema: z.object({
        query: z.string().max(128).optional(),
        parentId: z.string().max(64).optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ query, parentId, maxResults = 50 }) => {
        if (!(await hasPermission("bookmarks"))) {
          return permissionDeniedResult("bookmarks");
        }
        let items = [];
        if (query) {
          items = await chrome.bookmarks.search(query);
        } else if (parentId) {
          items = await chrome.bookmarks.getChildren(parentId);
        } else {
          items = await chrome.bookmarks.getRecent(maxResults);
        }
        return {
          bookmarks: (Array.isArray(items) ? items : []).slice(0, maxResults).map((b) => ({
            id: b.id,
            title: b.title,
            url: b.url ?? null,
            parentId: b.parentId ?? null,
            dateAdded: b.dateAdded ?? null,
          })),
        };
      },
    }),
    remove_bookmark: tool({
      description:
        "Remove a bookmark or bookmark folder by id. Requires bookmarks permission.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
      }),
      execute: async ({ id }) => {
        if (!(await hasPermission("bookmarks"))) {
          return permissionDeniedResult("bookmarks");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — bookmark not removed" };
        }
        await chrome.bookmarks.remove(id);
        return { ok: true, id, removed: true };
      },
    }),
    notify: tool({
      description:
        "Display a system notification to the user (title, message). Requires notifications permission.",
      inputSchema: z.object({
        title: z.string().min(1).max(128),
        message: z.string().min(1).max(512),
        iconUrl: z.string().max(2048).optional(),
        priority: z.number().int().min(0).max(2).optional(),
      }),
      execute: async ({ title, message, iconUrl, priority }) => {
        if (!(await hasPermission("notifications"))) {
          return permissionDeniedResult("notifications");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — notification not sent" };
        }
        const defaultIcon = typeof chrome !== "undefined" && chrome.runtime?.getURL
          ? chrome.runtime.getURL("icons/icon128.png")
          : "";
        const notificationId = await chrome.notifications.create({
          type: "basic",
          iconUrl: iconUrl || defaultIcon,
          title,
          message,
          priority: priority ?? 0,
        });
        return { ok: true, notificationId };
      },
    }),
    clear_notification: tool({
      description:
        "Clear an active system notification by id. Requires notifications permission.",
      inputSchema: z.object({
        notificationId: z.string().min(1).max(128),
      }),
      execute: async ({ notificationId }) => {
        if (!(await hasPermission("notifications"))) {
          return permissionDeniedResult("notifications");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — notification not cleared" };
        }
        const cleared = await chrome.notifications.clear(notificationId);
        return { ok: true, notificationId, cleared: cleared === true };
      },
    }),
    query_idle_state: tool({
      description:
        "Query the system idle state ('active', 'idle', or 'locked') given a detection interval. Requires idle permission.",
      inputSchema: z.object({
        detectionIntervalInSeconds: z.number().int().min(15).max(7200).optional(),
      }),
      execute: async ({ detectionIntervalInSeconds = 60 }) => {
        if (!(await hasPermission("idle"))) {
          return permissionDeniedResult("idle");
        }
        const state = await chrome.idle.queryState(detectionIntervalInSeconds);
        return { ok: true, state, detectionIntervalInSeconds };
      },
    }),
    create_context_menu: tool({
      description:
        "Create an extension context menu item. Requires contextMenus permission.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        title: z.string().min(1).max(128),
        contexts: z.array(z.enum(["all", "page", "frame", "selection", "link", "editable", "image", "video", "audio", "launcher", "browser_action", "page_action", "action"])).max(8).optional(),
        parentId: z.string().max(64).optional(),
      }),
      execute: async ({ id, title, contexts, parentId }) => {
        if (!(await hasPermission("contextMenus"))) {
          return permissionDeniedResult("contextMenus");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — context menu not created" };
        }
        const props = { id, title, contexts: contexts || ["all"] };
        if (parentId !== undefined) props.parentId = parentId;
        await chrome.contextMenus.create(props);
        return { ok: true, id, title };
      },
    }),
    list_context_menus: tool({
      description:
        "Check context menu support state. Requires contextMenus permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("contextMenus"))) {
          return permissionDeniedResult("contextMenus");
        }
        return { ok: true, supported: true };
      },
    }),
    remove_context_menu: tool({
      description:
        "Remove an extension context menu item by id. Requires contextMenus permission.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
      }),
      execute: async ({ id }) => {
        if (!(await hasPermission("contextMenus"))) {
          return permissionDeniedResult("contextMenus");
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — context menu not removed" };
        }
        await chrome.contextMenus.remove(id);
        return { ok: true, id, removed: true };
      },
    }),

    // ── T8 site-data control ──────────────────────────────────────────────
    // chrome.cookies / chrome.browsingData / chrome.contentSettings
    // (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01, Tranche 8). All three
    // API permissions are OPTIONAL (Settings capability rows grant them from a
    // genuine owner gesture — the service worker never requests). Cookie tools
    // ADDITIONALLY require the exact-origin HOST permission for the target
    // site (host access is granted via enrollment/Settings, never requested
    // broadly here). Mutations ride the SAME product browser-control grant
    // as the tabs/windows siblings: site-scoped mutations need the origin in
    // the grant; the browser-wide browsing-data wipe needs a GLOBAL grant.
    list_cookies: tool({
      description:
        "List cookies for a domain or URL (bounded). Requires cookies permission.",
      inputSchema: z.object({
        domain: z.string().min(1).max(253).optional(),
        url: z.string().url().max(2048).optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ domain, url, maxResults = 50 }) => {
        if (!(await hasPermission("cookies"))) {
          return permissionDeniedResult("cookies");
        }
        if (!domain && !url) return { error: "pass a domain or a url" };
        const query = {};
        if (domain) query.domain = domain;
        if (url) query.url = url;
        let all = [];
        try {
          all = await chrome.cookies.getAll(query);
        } catch (e) {
          return { error: `cookie query failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(all) ? all : [];
        return {
          cookies: rows.slice(0, maxResults).map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite ?? null,
            expirationDate: c.expirationDate ?? null,
            storeId: c.storeId ?? null,
          })),
          returned: Math.min(rows.length, maxResults),
          total: rows.length,
          truncated: rows.length > maxResults,
        };
      },
    }),
    list_cookie_stores: tool({
      description:
        "List the browser's cookie stores (id + tab ids). Requires cookies permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("cookies"))) {
          return permissionDeniedResult("cookies");
        }
        let stores = [];
        try {
          stores = await chrome.cookies.getAllCookieStores();
        } catch (e) {
          return { error: `cookie store query failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        return {
          stores: (Array.isArray(stores) ? stores : []).slice(0, 50).map((s) => ({
            id: s.id,
            tabIds: Array.isArray(s.tabIds) ? s.tabIds.slice(0, 50) : [],
          })),
        };
      },
    }),
    get_cookie: tool({
      description:
        "Read one cookie by URL + name. Requires cookies permission AND the exact-origin host permission for the URL's site.",
      inputSchema: z.object({
        url: z.string().url().max(2048),
        name: z.string().min(1).max(512),
      }),
      execute: async ({ url, name }) => {
        if (!(await hasPermission("cookies"))) {
          return permissionDeniedResult("cookies");
        }
        const origin = canonicalOrigin(url);
        if (!origin) return { error: "only http/https cookie URLs are supported" };
        if (!(await hasOriginHostPermission(origin))) {
          return { error: `host permission for ${origin} not granted — broad host access is granted at install (<all_urls>); if it is missing, reinstall the extension` };
        }
        let cookie = null;
        try {
          cookie = await chrome.cookies.get({ url, name });
        } catch (e) {
          return { error: `cookie read failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        if (!cookie) return { ok: true, cookie: null, found: false };
        return {
          ok: true,
          found: true,
          cookie: {
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite ?? null,
            expirationDate: cookie.expirationDate ?? null,
            storeId: cookie.storeId ?? null,
          },
        };
      },
    }),
    set_cookie: tool({
      description:
        "Set a cookie for an http/https URL. Requires cookies permission, the exact-origin host permission, and browser-control permission for the site (scoped + expiring).",
      inputSchema: z.object({
        url: z.string().url().max(2048),
        name: z.string().min(1).max(512),
        value: z.string().max(4096),
      }),
      execute: async ({ url, name, value }) => {
        if (!(await hasPermission("cookies"))) {
          return permissionDeniedResult("cookies");
        }
        const origin = canonicalOrigin(url);
        if (!origin) return { error: "only http/https cookie URLs are supported" };
        if (!(await hasOriginHostPermission(origin))) {
          return { error: `host permission for ${origin} not granted — broad host access is granted at install (<all_urls>); if it is missing, reinstall the extension` };
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `set a cookie on ${origin}`, grantOrigins: [origin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — cookie not set" };
          }
          let cookie = null;
          try {
            cookie = await chrome.cookies.set({ url, name, value });
          } catch (e) {
            return { error: `cookie write failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          // Re-check the fence AFTER the await (the round-18/19 discipline):
          // an abort mid-mutation never reports a clean success.
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — cookie set then aborted" };
          }
          if (!cookie) return { error: "cookie write rejected by Chrome (url/host mismatch?)" };
          return { ok: true, name: cookie.name, domain: cookie.domain, origin };
        });
      },
    }),
    remove_cookie: tool({
      description:
        "Remove one cookie by URL + name. Requires cookies permission, the exact-origin host permission, and browser-control permission for the site (scoped + expiring).",
      inputSchema: z.object({
        url: z.string().url().max(2048),
        name: z.string().min(1).max(512),
      }),
      execute: async ({ url, name }) => {
        if (!(await hasPermission("cookies"))) {
          return permissionDeniedResult("cookies");
        }
        const origin = canonicalOrigin(url);
        if (!origin) return { error: "only http/https cookie URLs are supported" };
        if (!(await hasOriginHostPermission(origin))) {
          return { error: `host permission for ${origin} not granted — broad host access is granted at install (<all_urls>); if it is missing, reinstall the extension` };
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `remove a cookie on ${origin}`, grantOrigins: [origin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — cookie not removed" };
          }
          try {
            await chrome.cookies.remove({ url, name });
          } catch (e) {
            return { error: `cookie removal failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — cookie removed then aborted" };
          }
          return { ok: true, name, origin, removed: true };
        });
      },
    }),
    wipe_browsing_data: tool({
      description:
        "Wipe explicitly enumerated browsing data types (cache/cookies/history/downloads/fileSystems/formData/indexedDB/localStorage/passwords/pluginData/serviceWorkers), optionally since a timestamp. Browser-wide: requires a GLOBAL browser-control grant (scoped origin grants are refused).",
      inputSchema: z.object({
        dataTypes: z
          .array(
            z.enum([
              "cache", "cookies", "history", "downloads", "fileSystems",
              "formData", "indexedDB", "localStorage", "passwords",
              "pluginData", "serviceWorkers",
            ]),
          )
          .min(1)
          .max(11),
        sinceMs: z.number().int().min(0).optional(),
      }),
      execute: async ({ dataTypes, sinceMs }) => {
        if (!(await hasPermission("browsingData"))) {
          return permissionDeniedResult("browsingData");
        }
        // The caller must ENUMERATE what to wipe — an empty list is refused by
        // the schema and there is NO implicit "everything" path: passing the
        // full list is the caller's explicit choice, recorded in the result.
        const unique = [...new Set(dataTypes)];
        return await withGrantLock(async () => {
          // Browser-wide scope: ONLY a global grant authorizes a wipe
          // (undefined origin never matches an origin-scoped grant).
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a browsing-data wipe is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "wipe browsing data (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — browsing data not wiped" };
          }
          const removalOptions = {};
          for (const t of unique) removalOptions[t] = true;
          const options = {};
          if (sinceMs !== undefined) options.since = sinceMs;
          try {
            await chrome.browsingData.remove(options, removalOptions);
          } catch (e) {
            return { error: `browsing-data wipe failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — browsing data wiped then aborted" };
          }
          return { ok: true, removed: unique, sinceMs: sinceMs ?? null };
        });
      },
    }),
    get_content_setting: tool({
      description:
        "Read one content setting (cookies/images/javascript/location/notifications/popups) for a single-origin pattern. Requires contentSettings permission.",
      inputSchema: z.object({
        resource: z.enum(["cookies", "images", "javascript", "location", "notifications", "popups"]),
        primaryPattern: z.string().min(1).max(512),
      }),
      execute: async ({ resource, primaryPattern }) => {
        if (!(await hasPermission("contentSettings"))) {
          return permissionDeniedResult("contentSettings");
        }
        const pattern = t8SingleOriginPattern(primaryPattern);
        if (!pattern.ok) return { error: pattern.error };
        // CORRECT API: contentSettings.get REQUIRES primaryUrl (a URL) —
        // primaryPattern is a set()-only parameter, so the old shape always
        // threw in real Chrome. The representative URL for an exact-origin
        // pattern is `${origin}/` (per the schema's primaryUrl semantics).
        const origin = canonicalOrigin(pattern.value);
        let result = null;
        try {
          result = await chrome.contentSettings[resource].get({ primaryUrl: `${origin}/` });
        } catch (e) {
          return { error: `content-setting read failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        return { ok: true, resource, primaryPattern: pattern.value, setting: result?.setting ?? null };
      },
    }),
    set_content_setting: tool({
      description:
        "Set one content setting for a SINGLE-ORIGIN pattern (broad/wildcard patterns are rejected). Requires contentSettings permission and browser-control permission for that origin (scoped + expiring).",
      inputSchema: z.object({
        resource: z.enum(["cookies", "images", "javascript", "location", "notifications", "popups"]),
        primaryPattern: z.string().min(1).max(512),
        setting: z.string().min(1).max(32),
      }),
      execute: async ({ resource, primaryPattern, setting }) => {
        if (!(await hasPermission("contentSettings"))) {
          return permissionDeniedResult("contentSettings");
        }
        const pattern = t8SingleOriginPattern(primaryPattern);
        if (!pattern.ok) return { error: pattern.error };
        const allowed = T8_CONTENT_SETTING_VALUES[resource];
        if (!allowed.includes(setting)) {
          return { error: `invalid setting for ${resource} — allowed: ${allowed.join(", ")}` };
        }
        const origin = canonicalOrigin(pattern.value);
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `change a content setting for ${origin}`, grantOrigins: [origin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — content setting not changed" };
          }
          try {
            await chrome.contentSettings[resource].set({ primaryPattern: pattern.value, setting });
          } catch (e) {
            return { error: `content-setting write failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — content setting changed then aborted" };
          }
          return { ok: true, resource, primaryPattern: pattern.value, setting };
        });
      },
    }),
    clear_content_settings: tool({
      description:
        "Reset one content setting for a SINGLE-ORIGIN pattern to the resource default (allow for cookies/images/javascript, ask for location/notifications, block for popups). The contentSettings API has NO per-pattern clear — chrome.contentSettings.*.clear({scope}) would wipe EVERY pattern for the resource browser-wide, so this resets the origin's pattern to the documented default instead, preserving the single-origin scope. Requires contentSettings permission and browser-control permission for that origin (scoped + expiring).",
      inputSchema: z.object({
        resource: z.enum(["cookies", "images", "javascript", "location", "notifications", "popups"]),
        primaryPattern: z.string().min(1).max(512),
      }),
      execute: async ({ resource, primaryPattern }) => {
        if (!(await hasPermission("contentSettings"))) {
          return permissionDeniedResult("contentSettings");
        }
        const pattern = t8SingleOriginPattern(primaryPattern);
        if (!pattern.ok) return { error: pattern.error };
        const origin = canonicalOrigin(pattern.value);
        // Per-pattern clear does not exist in the API; the honest single-origin
        // equivalent is set() back to the resource's documented default
        // (T8_CONTENT_SETTING_DEFAULTS) — NEVER clear({scope}), which is
        // browser-wide and would escape this origin's grant.
        const defaultSetting = T8_CONTENT_SETTING_DEFAULTS[resource];
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `clear a content setting for ${origin}`, grantOrigins: [origin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — content setting not reset" };
          }
          try {
            await chrome.contentSettings[resource].set({ primaryPattern: pattern.value, setting: defaultSetting });
          } catch (e) {
            return { error: `content-setting reset failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — content setting reset then aborted" };
          }
          return { ok: true, resource, primaryPattern: pattern.value, setting: defaultSetting, restoredDefault: true };
        });
      },
    }),
    // ── Tranche-3 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
    // tabGroups — the owner's "sorting hat" unlock. tabGroups needs NO manifest
    // permission; the "tabs" permission (already declared) covers the tab
    // url/title reads used for the grant scoping. Mutations are grant-gated
    // (tab-origin discipline); reads are light.
    list_tab_groups: tool({
      description:
        "List the browser's tab groups (id, title, color, collapsed, windowId), optionally scoped to one window. Read-only; no permission needed.",
      inputSchema: z.object({
        windowId: z.number().int().min(1).optional(),
      }),
      execute: async ({ windowId }) => {
        if (!(await hasPermission("tabGroups"))) {
          return permissionDenial(
            "tab groups permission not granted — allow it in the approval card here, or in Settings → Permissions",
            { reason: "list your tab groups", permissions: ["tabGroups"] },
          );
        }
        const tg = tabGroupsApi();
        if (!tg) return { error: "tab groups API not available in this browser context" };
        const groups = await tg.query(windowId ? { windowId } : {});
        return {
          tabGroups: (Array.isArray(groups) ? groups : []).slice(0, 64).map((g) => ({
            id: g.id,
            title: String(g.title ?? "").slice(0, 128),
            color: String(g.color ?? "grey").slice(0, 32),
            collapsed: Boolean(g.collapsed),
            windowId: g.windowId ?? null,
          })),
        };
      },
    }),
    group_tabs: tool({
      description:
        "Group the given tabs into a new tab group (optional title/color). Grant-gated: the browser-control grant must cover every tab origin. Requires tabs permission.",
      inputSchema: z.object({
        tabIds: z.array(z.number().int().min(1)).min(1).max(16),
        title: z.string().min(1).max(128).optional(),
        color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional(),
      }),
      execute: async ({ tabIds, title, color }) => {
        if (!(await hasPermission("tabGroups"))) {
          return permissionDenial(
            "tab groups permission not granted — allow it in the approval card here, or in Settings → Permissions",
            { reason: "group your tabs", permissions: ["tabGroups", "tabs"] },
          );
        }
        return await withTabIdsGrant(tabIds, "grouped", async () => {
          const tg = tabGroupsApi();
          const tabsApi = chromeApi("tabs");
          if (!tg || !tabsApi) return { error: "tab groups API not available in this browser context" };
          // CORRECT API: grouping is chrome.tabs.group() (returns the new groupId as a
          // NUMBER); title/color are set AFTERWARD via chrome.tabGroups.update().
          // (chrome.tabGroups.group() does NOT exist — that was the broken call.)
          const groupId = await tabsApi.group({ tabIds });
          if (title !== undefined || color !== undefined) {
            const props = {};
            if (title !== undefined) props.title = title;
            if (color !== undefined) props.color = color;
            await tg.update(groupId, props);
          }
          return { ok: true, groupId, tabIds };
        });
      },
    }),
    update_tab_group: tool({
      description:
        "Update a tab group's title, color, or collapsed state. Grant-gated: the grant must cover the group's tab origins. Requires tabs permission.",
      inputSchema: z.object({
        groupId: z.number().int().min(1),
        title: z.string().min(1).max(128).optional(),
        color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional(),
        collapsed: z.boolean().optional(),
      }).refine((v) => v.title !== undefined || v.color !== undefined || v.collapsed !== undefined, "at least one field is required"),
      execute: async ({ groupId, title, color, collapsed }) => {
        if (!(await hasPermission("tabGroups"))) {
          return permissionDenial(
            "tab groups permission not granted — allow it in the approval card here, or in Settings → Permissions",
            { reason: "update a tab group", permissions: ["tabGroups", "tabs"] },
          );
        }
        return await withTabGroupGrant(groupId, "updated", async () => {
          const props = {};
          if (title !== undefined) props.title = title;
          if (color !== undefined) props.color = color;
          if (collapsed !== undefined) props.collapsed = collapsed;
          const tg = tabGroupsApi();
          if (!tg) return { error: "tab groups API not available in this browser context" };
          const group = await tg.update(groupId, props);
          return {
            ok: true,
            groupId,
            title: group.title ?? null,
            color: group.color ?? null,
            collapsed: Boolean(group.collapsed),
          };
        });
      },
    }),
    ungroup_tabs: tool({
      description:
        "Remove the given tabs from their tab groups (they return to the tab strip ungrouped). Grant-gated: the grant must cover every tab origin. Requires tabs permission.",
      inputSchema: z.object({
        tabIds: z.array(z.number().int().min(1)).min(1).max(16),
      }),
      execute: async ({ tabIds }) => {
        if (!(await hasPermission("tabGroups"))) {
          return permissionDenial(
            "tab groups permission not granted — allow it in the approval card here, or in Settings → Permissions",
            { reason: "ungroup your tabs", permissions: ["tabGroups", "tabs"] },
          );
        }
        return await withTabIdsGrant(tabIds, "ungrouped", async () => {
          const tabsApi = chromeApi("tabs");
          if (!tabsApi) return { error: "tab groups API not available in this browser context" };
          // CORRECT API: ungrouping is chrome.tabs.ungroup() (chrome.tabGroups.ungroup()
          // does NOT exist).
          await tabsApi.ungroup(tabIds);
          return { ok: true, tabIds };
        });
      },
    }),
    move_tab_to_group: tool({
      description:
        "Move the given tabs into an existing tab group. Grant-gated: the grant must cover every moved tab's origin. Requires tabs permission.",
      inputSchema: z.object({
        tabIds: z.array(z.number().int().min(1)).min(1).max(16),
        groupId: z.number().int().min(1),
      }),
      execute: async ({ tabIds, groupId }) => {
        if (!(await hasPermission("tabGroups"))) {
          return permissionDenial(
            "tab groups permission not granted — allow it in the approval card here, or in Settings → Permissions",
            { reason: "move tabs into a group", permissions: ["tabGroups", "tabs"] },
          );
        }
        return await withTabIdsGrant(tabIds, "moved", async () => {
          const tg = tabGroupsApi();
          const tabsApi = chromeApi("tabs");
          if (!tg || !tabsApi) return { error: "tab groups API not available in this browser context" };
          // CORRECT API: adding tabs to an EXISTING group is chrome.tabs.group({tabIds,
          // groupId}) (chrome.tabGroups.move(tabIds, groupId) does NOT exist —
          // tabGroups.move() is for repositioning the GROUP, with a different signature).
          const gid = await tabsApi.group({ tabIds, groupId });
          return { ok: true, groupId: gid, tabIds };
        });
      },
    }),
    // ── Tranche-4 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01):
    // downloads — the "downloads" optional permission is already declared; the
    // Settings Downloads capability row requests it on demand. Mutations are
    // grant-gated with the GLOBAL browser-control grant (downloads are
    // browser-wide; an origin-scoped grant must never authorize them).
    // open_download was a Phase-1 exclusion EXPLICITLY OVERRIDDEN by the owner:
    // keep it hard grant-gated.
    download_file: tool({
      description:
        "Download a URL. ONLY http/https URLs are accepted (file://, chrome://, extension://, data: and other schemes are refused). The optional filename is sanitized (no traversal) + bounded; saveAs is never auto-true. Requires downloads permission + the browser-control grant.",
      inputSchema: z.object({
        url: z.string().max(2048),
        filename: z.string().max(512).optional(),
        conflictAction: z.enum(["uniquify", "overwrite", "prompt"]).optional(),
      }),
      execute: async ({ url, filename, conflictAction }) => {
        if (!isDownloadableUrl(url)) {
          return { error: "refused: only http/https URLs may be downloaded" };
        }
        const cleanFilename = filename === undefined ? undefined : sanitizeDownloadFilename(filename);
        if (filename !== undefined && cleanFilename == null) {
          return { error: "invalid filename" };
        }
        return await withDownloadsGrant("downloaded", async () => {
          const options = { url, saveAs: false };
          if (cleanFilename !== undefined) options.filename = cleanFilename;
          if (conflictAction !== undefined) options.conflictAction = conflictAction;
          const downloadId = await chrome.downloads.download(options);
          return { ok: true, downloadId };
        });
      },
    }),
    list_downloads: tool({
      description:
        "Search the browser's download history (bounded query/filters/limit). Requires downloads permission.",
      inputSchema: z.object({
        query: z.string().max(128).optional(),
        state: z.enum(["in_progress", "interrupted", "complete"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ query, state, limit = 25 }) => {
        if (!(await hasPermission("downloads"))) {
          return permissionDeniedResult("downloads");
        }
        const searchQuery = { orderBy: ["-startTime"] };
        if (query !== undefined) searchQuery.query = query;
        if (state !== undefined) searchQuery.state = state;
        const items = await chrome.downloads.search(searchQuery);
        return {
          downloads: (Array.isArray(items) ? items : []).slice(0, limit).map((d) => ({
            id: d.id,
            url: String(d.url ?? "").slice(0, 2048),
            filename: String(d.filename ?? "").slice(0, 512),
            state: String(d.state ?? "").slice(0, 32),
            mime: String(d.mime ?? "").slice(0, 128),
            bytesReceived: Number(d.bytesReceived ?? 0),
            totalBytes: Number(d.totalBytes ?? 0),
          })),
        };
      },
    }),
    pause_download: tool({
      description:
        "Pause an in-progress download by id. Grant-gated (global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        downloadId: z.number().int().min(1),
      }),
      execute: async ({ downloadId }) => {
        return await withDownloadsGrant("paused", async () => {
          await chrome.downloads.pause(downloadId);
          return { ok: true, downloadId, paused: true };
        });
      },
    }),
    resume_download: tool({
      description:
        "Resume a paused download by id. Grant-gated (global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        downloadId: z.number().int().min(1),
      }),
      execute: async ({ downloadId }) => {
        return await withDownloadsGrant("resumed", async () => {
          await chrome.downloads.resume(downloadId);
          return { ok: true, downloadId, resumed: true };
        });
      },
    }),
    cancel_download: tool({
      description:
        "Cancel an in-progress download by id. Grant-gated (global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        downloadId: z.number().int().min(1),
      }),
      execute: async ({ downloadId }) => {
        return await withDownloadsGrant("cancelled", async () => {
          await chrome.downloads.cancel(downloadId);
          return { ok: true, downloadId, cancelled: true };
        });
      },
    }),
    erase_download: tool({
      description:
        "Erase the download records for the given ids from the download shelf (the files themselves may remain on disk). Grant-gated (global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        ids: z.array(z.number().int().min(1)).min(1).max(16),
      }),
      execute: async ({ ids }) => {
        return await withDownloadsGrant("erased", async () => {
          await chrome.downloads.erase({ id: ids });
          return { ok: true, ids };
        });
      },
    }),
    show_download: tool({
      description:
        "Show a completed download in the OS file manager. Grant-gated (global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        downloadId: z.number().int().min(1),
      }),
      execute: async ({ downloadId }) => {
        return await withDownloadsGrant("shown", async () => {
          await chrome.downloads.show(downloadId);
          return { ok: true, downloadId, shown: true };
        });
      },
    }),
    open_download: tool({
      description:
        "Open a completed download with its default application (owner-OVERRIDDEN Phase-1 exclusion; keep hard grant-gated — global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        downloadId: z.number().int().min(1),
      }),
      execute: async ({ downloadId }) => {
        return await withDownloadsGrant("opened", async () => {
          await chrome.downloads.open(downloadId);
          return { ok: true, downloadId, opened: true };
        });
      },
    }),
    remove_download_file: tool({
      description:
        "Delete the downloaded file for the given download id from disk (destructive). Grant-gated (global browser-control grant). Requires downloads permission.",
      inputSchema: z.object({
        downloadId: z.number().int().min(1),
      }),
      execute: async ({ downloadId }) => {
        return await withDownloadsGrant("file-removed", async () => {
          await chrome.downloads.removeFile(downloadId);
          return { ok: true, downloadId, fileRemoved: true };
        });
      },
    }),
    // ── T13 deep tab control ── (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01)
    // chrome.tabs deep ops + action enable/disable + sidePanel options/behavior.
    // Uses ONLY the already-declared "tabs"/"sidePanel" optional permissions —
    // NO new manifest permissions. Every mutation rides the SAME product
    // browser-control grant as close_tab (tab-origin scoped, checked INSIDE the
    // grant lock with an identity re-read adjacent to the mutation); the two
    // sidePanel mutations are browser-level surfaces requiring a GLOBAL grant.
    move_tab: tool({
      description:
        "Move a tab to a new position and/or window. Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({
        tabId: z.number().int(),
        windowId: z.number().int().optional(),
        index: z.number().int().min(0).max(10000).optional(),
      }).refine((v) => v.windowId !== undefined || v.index !== undefined, "windowId and/or index is required"),
      execute: async ({ tabId, windowId, index }) =>
        t13MutateTabWithGrant(tabId, "moved", async () => {
          const props = {};
          if (windowId !== undefined) props.windowId = windowId;
          if (index !== undefined) props.index = index;
          const moved = await chrome.tabs.move(tabId, props);
          return { ok: true, tabId, windowId: moved?.windowId ?? null, index: moved?.index ?? null };
        }),
    }),
    duplicate_tab: tool({
      description:
        "Duplicate a tab (the copy opens next to it). Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({ tabId: z.number().int() }),
      execute: async ({ tabId }) =>
        t13MutateTabWithGrant(tabId, "duplicated", async () => {
          const copy = await chrome.tabs.duplicate(tabId);
          return { ok: true, tabId, newTabId: copy?.id ?? null };
        }),
    }),
    set_tab_pinned: tool({
      description:
        "Pin or unpin a tab. Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({ tabId: z.number().int(), pinned: z.boolean() }),
      execute: async ({ tabId, pinned }) =>
        t13MutateTabWithGrant(tabId, pinned ? "pinned" : "unpinned", async () => {
          await chrome.tabs.update(tabId, { pinned });
          return { ok: true, tabId, pinned };
        }),
    }),
    reload_tab: tool({
      description:
        "Reload a tab, optionally bypassing the cache. Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({ tabId: z.number().int(), bypassCache: z.boolean().optional() }),
      execute: async ({ tabId, bypassCache }) =>
        t13MutateTabWithGrant(tabId, "reloaded", async () => {
          await chrome.tabs.reload(tabId, { bypassCache: Boolean(bypassCache) });
          return { ok: true, tabId, bypassCache: Boolean(bypassCache) };
        }),
    }),
    tab_go_back: tool({
      description:
        "Navigate a tab back one entry in its history. Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({ tabId: z.number().int() }),
      execute: async ({ tabId }) =>
        t13MutateTabWithGrant(tabId, "navigated back", async () => {
          await chrome.tabs.goBack(tabId);
          return { ok: true, tabId };
        }),
    }),
    tab_go_forward: tool({
      description:
        "Navigate a tab forward one entry in its history. Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({ tabId: z.number().int() }),
      execute: async ({ tabId }) =>
        t13MutateTabWithGrant(tabId, "navigated forward", async () => {
          await chrome.tabs.goForward(tabId);
          return { ok: true, tabId };
        }),
    }),
    get_tab_zoom: tool({
      description:
        "Read a tab's current zoom factor (1 = 100%). Requires the tabs permission.",
      inputSchema: z.object({ tabId: z.number().int() }),
      execute: async ({ tabId }) => {
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs");
        }
        try {
          const zoomFactor = await chrome.tabs.getZoom(tabId);
          return { ok: true, tabId, zoomFactor };
        } catch (e) {
          return { error: `zoom read failed: ${e?.message ?? e}` };
        }
      },
    }),
    set_tab_zoom: tool({
      description:
        "Set a tab's zoom factor (bounded 0.25–8, i.e. 25%–800%). Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({
        tabId: z.number().int(),
        zoomFactor: z.number().min(0.25).max(8),
      }),
      execute: async ({ tabId, zoomFactor }) =>
        t13MutateTabWithGrant(tabId, "zoomed", async () => {
          await chrome.tabs.setZoom(tabId, zoomFactor);
          return { ok: true, tabId, zoomFactor };
        }),
    }),
    discard_tab: tool({
      description:
        "Discard a tab's content to free memory (the tab stays in the strip; Chrome refuses to discard the active tab). Requires browser-control permission (scoped + expiring) for the tab's origin.",
      inputSchema: z.object({ tabId: z.number().int() }),
      execute: async ({ tabId }) =>
        t13MutateTabWithGrant(tabId, "discarded", async () => {
          try {
            await chrome.tabs.discard(tabId);
          } catch (e) {
            return { error: `tab not discarded: ${e?.message ?? e}` };
          }
          return { ok: true, tabId };
        }),
    }),
    highlight_tabs: tool({
      description:
        "Highlight (select) a set of tabs in a window, by tab id or by window position index. Requires browser-control permission (scoped + expiring) covering EVERY highlighted tab's origin.",
      inputSchema: z.object({
        windowId: z.number().int().optional(),
        tabIds: z.array(z.number().int()).min(1).max(100).optional(),
        indices: z.array(z.number().int().min(0).max(1000)).min(1).max(100).optional(),
      }).refine((v) => (v.tabIds !== undefined) !== (v.indices !== undefined), "exactly one of tabIds or indices is required"),
      execute: async ({ windowId, tabIds, indices }) => {
        if (!(await hasTabsPermission())) {
          return permissionDeniedResult("tabs");
        }
        return await withGrantLock(async () => {
          // Resolve the exact target tabs INSIDE the lock; when indices were
          // given they are read from the window's live tab order (a stale
          // index must never highlight a different tab than authorized).
          let targets = [];
          if (tabIds !== undefined) {
            for (const id of tabIds) {
              const t = await chrome.tabs.get(id).catch(() => null);
              if (!t) return { error: `no such tab: ${id}` };
              targets.push(t);
            }
          } else {
            const win = await chrome.windows.get(windowId ?? chrome.windows.WINDOW_ID_CURRENT, { populate: true }).catch(() => null);
            if (!win) return { error: "no such window" };
            windowId = win.id;
            const ordered = Array.isArray(win.tabs) ? win.tabs : [];
            for (const idx of indices) {
              const t = ordered[idx];
              if (!t) return { error: `no tab at index ${idx} in window ${win.id}` };
              targets.push(t);
            }
          }
          // The grant must cover EVERY highlighted tab (a highlight is every
          // target tab's mutation — the same discipline as
          // mutateWindowWithGrant). Two obligations, BOTH enforced — the
          // mixed-set fail-open fix (T13 review blocker): every NAMED origin
          // must be granted, AND any origin-less target (chrome://, about:,
          // url-less tabs — canonicalOrigin returns null for all of them) is
          // a browser-level scope requiring the GLOBAL grant. Origin-less
          // targets are counted (hasOriginless), never filtered out of the
          // check: an origin grant for a co-present https tab must not
          // smuggle a chrome:// tab through the mutation.
          let hasOriginless = false;
          const origins = new Set();
          for (const t of targets) {
            let o = null;
            try {
              o = t?.url ? canonicalOrigin(t.url) : null;
            } catch {
              o = null;
            }
            if (typeof o === "string") origins.add(o);
            else hasOriginless = true;
          }
          const namedCovered = (
            await Promise.all([...origins].map((o) => isBrowserControlGranted(o)))
          ).every(Boolean);
          const originlessCovered = hasOriginless
            ? await isBrowserControlGranted(undefined)
            : true;
          if (!namedCovered || !originlessCovered) {
            return permissionDenial(
              "browser control not granted for every highlighted tab's origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: hasOriginless ? "highlight tabs (one has no single site — this needs the all-sites browser-control grant)" : `highlight tabs on ${[...origins].join(", ")}`, grantOrigins: hasOriginless ? [] : [...origins], grantGlobal: hasOriginless },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tabs not highlighted" };
          }
          const highlightProps = { tabs: targets.map((t) => t.id) };
          if (windowId !== undefined) highlightProps.windowId = windowId;
          let win;
          try {
            win = await chrome.tabs.highlight(highlightProps);
          } catch (e) {
            return { error: `highlight failed: ${e?.message ?? e}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — tabs highlighted then aborted" };
          }
          return { ok: true, windowId: win?.id ?? windowId ?? null, highlighted: targets.length };
        });
      },
    }),
    enable_action: tool({
      description:
        "Enable this extension's own toolbar action (globally or for one tab). Owner-scoped surface; no browser-control grant needed.",
      inputSchema: z.object({ tabId: z.number().int().optional() }),
      execute: async ({ tabId }) => {
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — action not enabled" };
        }
        try {
          if (tabId !== undefined) await chrome.action.enable(tabId);
          else await chrome.action.enable();
        } catch (e) {
          return { error: `action enable failed: ${e?.message ?? e}` };
        }
        return { ok: true, tabId: tabId ?? null, enabled: true };
      },
    }),
    disable_action: tool({
      description:
        "Disable this extension's own toolbar action (globally or for one tab). Owner-scoped surface; no browser-control grant needed.",
      inputSchema: z.object({ tabId: z.number().int().optional() }),
      execute: async ({ tabId }) => {
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — action not disabled" };
        }
        try {
          if (tabId !== undefined) await chrome.action.disable(tabId);
          else await chrome.action.disable();
        } catch (e) {
          return { error: `action disable failed: ${e?.message ?? e}` };
        }
        return { ok: true, tabId: tabId ?? null, enabled: false };
      },
    }),
    get_side_panel_options: tool({
      description:
        "Read the side panel options (bundled page path + enabled), globally or for one tab. Requires the sidePanel permission.",
      inputSchema: z.object({ tabId: z.number().int().optional() }),
      execute: async ({ tabId }) => {
        if (!(await hasSidePanelPermission())) {
          return permissionDeniedResult("sidePanel", { reason: "read the side panel options" });
        }
        try {
          const opts = await chrome.sidePanel.getOptions(tabId !== undefined ? { tabId } : {});
          return {
            ok: true,
            path: typeof opts?.path === "string" ? opts.path.slice(0, 512) : null,
            enabled: Boolean(opts?.enabled),
          };
        } catch (e) {
          return { error: `side panel options read failed: ${e?.message ?? e}` };
        }
      },
    }),
    set_side_panel_options: tool({
      description:
        "Set the side panel options. The path is confined to a bundled extension page (extension-relative .html, no traversal) — resolving anything else fails closed. Requires a GLOBAL browser-control grant (browser-level surface).",
      inputSchema: z.object({
        path: z
          .string()
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_/.-]{0,126}\.html$/u)
          .refine((p) => !p.includes("..") && !p.startsWith("/"), "extension-relative bundled page only"),
        enabled: z.boolean().optional(),
        tabId: z.number().int().optional(),
      }),
      execute: async ({ path, enabled, tabId }) => {
        if (!(await hasSidePanelPermission())) {
          return permissionDeniedResult("sidePanel", { reason: "change the side panel options" });
        }
        // Confinement proof against the runtime root: getURL must resolve the
        // path INSIDE the extension's own URL root (a hostile path must never
        // produce an out-of-root panel document). Any resolution failure is a
        // denial.
        let resolved = "";
        let root = "";
        try {
          resolved = chrome.runtime.getURL(path);
          root = chrome.runtime.getURL("");
        } catch {
          return { error: "side panel path rejected — not resolvable inside the extension" };
        }
        if (
          typeof resolved !== "string" || typeof root !== "string" ||
          root.length === 0 || !resolved.startsWith(root)
        ) {
          return { error: "side panel path rejected — escapes the extension root" };
        }
        return await withGrantLock(async () => {
          // Browser-level surface (which bundled page the panel loads) — only
          // a GLOBAL grant authorizes it (undefined origin).
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted (global) — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: "change which page the side panel shows (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — side panel options not changed" };
          }
          const options = { path };
          if (enabled !== undefined) options.enabled = enabled;
          if (tabId !== undefined) options.tabId = tabId;
          try {
            await chrome.sidePanel.setOptions(options);
          } catch (e) {
            return { error: `side panel options update failed: ${e?.message ?? e}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — side panel options changed then aborted" };
          }
          return { ok: true, path, enabled: enabled ?? null, tabId: tabId ?? null };
        });
      },
    }),
    set_panel_behavior: tool({
      description:
        "Set the side panel behavior (whether clicking the toolbar action opens the panel). Requires a GLOBAL browser-control grant (browser-level surface).",
      inputSchema: z.object({ openPanelOnActionClick: z.boolean() }),
      execute: async ({ openPanelOnActionClick }) => {
        if (!(await hasSidePanelPermission())) {
          return permissionDeniedResult("sidePanel", { reason: "change the side panel behavior" });
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted (global) — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: "change the side panel behavior (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — panel behavior not changed" };
          }
          try {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick });
          } catch (e) {
            return { error: `panel behavior update failed: ${e?.message ?? e}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — panel behavior changed then aborted" };
          }
          return { ok: true, openPanelOnActionClick };
        });
      },
    }),
    // ── T5 system/topSites/permissions ──
    // Tranche-5 Chrome API coverage (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01
    // T5, CAP-FB-20260825 implementation): system.* + topSites + permissions
    // inventory — ALL read-only. No product grant needed; each tool fails
    // HONEST when its optional permission is not granted (the owner enables it
    // in Settings — a model run never silently broadens).
    get_system_memory: tool({
      description:
        "Read system memory info (capacity, available). Read-only. Requires system.memory permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("system.memory"))) {
          return permissionDeniedResult("system.memory");
        }
        const info = await chrome.system.memory.getInfo();
        return {
          capacityBytes: info?.capacity ?? null,
          availableCapacityBytes: info?.availableCapacity ?? null,
        };
      },
    }),
    get_system_cpu: tool({
      description:
        "Read system CPU info (model, architecture, processor count, per-processor load). Read-only. Requires system.cpu permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("system.cpu"))) {
          return permissionDeniedResult("system.cpu");
        }
        const info = await chrome.system.cpu.getInfo();
        const processors = (Array.isArray(info?.processors) ? info.processors : []).slice(0, 64).map((p) => ({
          user: p?.usage?.user ?? null,
          kernel: p?.usage?.kernel ?? null,
          idle: p?.usage?.idle ?? null,
          total: p?.usage?.total ?? null,
        }));
        return {
          modelName: typeof info?.modelName === "string" ? info.modelName.slice(0, 128) : null,
          archName: typeof info?.archName === "string" ? info.archName.slice(0, 32) : null,
          numOfProcessors: info?.numOfProcessors ?? processors.length,
          processors,
        };
      },
    }),
    get_system_storage: tool({
      description:
        "List attached storage units (id, name, type, capacity). Read-only. Requires system.storage permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("system.storage"))) {
          return permissionDeniedResult("system.storage");
        }
        const units = await chrome.system.storage.getInfo();
        return {
          storageUnits: (Array.isArray(units) ? units : []).slice(0, 32).map((u) => ({
            id: typeof u?.id === "string" ? u.id.slice(0, 128) : null,
            name: typeof u?.name === "string" ? u.name.slice(0, 128) : null,
            type: typeof u?.type === "string" ? u.type.slice(0, 32) : null,
            capacityBytes: u?.capacity ?? null,
          })),
        };
      },
    }),
    get_system_display: tool({
      description:
        "List attached displays (id, name, primary, resolution, bounds). Read-only. Requires system.display permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("system.display"))) {
          return permissionDeniedResult("system.display");
        }
        const displays = await chrome.system.display.getInfo();
        return {
          displays: (Array.isArray(displays) ? displays : []).slice(0, 16).map((d) => ({
            id: typeof d?.id === "string" ? d.id.slice(0, 64) : null,
            name: typeof d?.name === "string" ? d.name.slice(0, 128) : null,
            isPrimary: d?.isPrimary === true,
            isEnabled: d?.isEnabled !== false,
            resolution: d?.modes?.find?.((m) => m?.isNative) ?? null,
            bounds: d?.bounds ? { left: d.bounds.left ?? 0, top: d.bounds.top ?? 0, width: d.bounds.width ?? 0, height: d.bounds.height ?? 0 } : null,
          })),
        };
      },
    }),
    list_top_sites: tool({
      description:
        "List the browser's top sites (url, title). Read-only. Requires topSites permission.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(50).optional(),
      }),
      execute: async ({ maxResults = 20 }) => {
        if (!(await hasPermission("topSites"))) {
          return permissionDeniedResult("topSites");
        }
        const sites = await chrome.topSites.get();
        return {
          topSites: (Array.isArray(sites) ? sites : []).slice(0, maxResults).map((site) => ({
            url: typeof site?.url === "string" ? site.url.slice(0, 2048) : null,
            title: typeof site?.title === "string" ? site.title.slice(0, 256) : null,
          })),
        };
      },
    }),
    list_granted_permissions: tool({
      description:
        "List the permissions + host origins this extension currently holds (read-only owner inventory — no permission required).",
      inputSchema: z.object({}),
      execute: async () => {
        const all = await chrome.permissions.getAll().catch(() => null);
        return {
          permissions: (Array.isArray(all?.permissions) ? all.permissions : []).slice(0, 64),
          origins: (Array.isArray(all?.origins) ? all.origins : []).slice(0, 64),
        };
      },
    }),

    // ── T6 readingList/pageCapture ──
    // Tranche-6 (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 T6): the most
    // sensitive surfaces. readingList entries are http/https ONLY (no
    // chrome://, file://, javascript: — validated BEFORE the API call);
    // mutations assert durable run ownership (house pattern). save_page_as_mhtml
    // rides EXACTLY capture_screenshot's consent semantics: run-owned → target
    // origin → exact-host permissionRequirement → grant validated under the
    // SAME grant lock → capture — with a hard byte cap reported honestly.
    add_reading_list_entry: tool({
      description:
        "Add a url to the browser reading list (http/https only). Requires readingList permission.",
      inputSchema: z.object({
        url: z.string().min(1).max(2048),
        title: z.string().max(256),
        hasBeenRead: z.boolean().optional(),
      }),
      execute: async ({ url, title, hasBeenRead = false }) => {
        if (!(await hasPermission("readingList"))) {
          return permissionDeniedResult("readingList");
        }
        const scheme = (() => { try { return new URL(url).protocol; } catch { return null; } })();
        if (scheme !== "http:" && scheme !== "https:") {
          return { error: "reading list entries must be http/https urls — refused" };
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — reading list entry not added" };
        }
        await chrome.readingList.addEntry({ url, title, hasBeenRead });
        return { ok: true, url, added: true };
      },
    }),
    query_reading_list: tool({
      description:
        "Query the browser reading list (url/title/hasBeenRead filters, bounded). Read-only. Requires readingList permission.",
      inputSchema: z.object({
        url: z.string().max(2048).optional(),
        title: z.string().max(256).optional(),
        hasBeenRead: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ url, title, hasBeenRead, maxResults = 50 }) => {
        if (!(await hasPermission("readingList"))) {
          return permissionDeniedResult("readingList");
        }
        const query = {};
        if (url !== undefined) query.url = url;
        if (title !== undefined) query.title = title;
        if (hasBeenRead !== undefined) query.hasBeenRead = hasBeenRead;
        const items = await chrome.readingList.query(query);
        return {
          entries: (Array.isArray(items) ? items : []).slice(0, maxResults).map((e) => ({
            url: typeof e?.url === "string" ? e.url.slice(0, 2048) : null,
            title: typeof e?.title === "string" ? e.title.slice(0, 256) : null,
            hasBeenRead: e?.hasBeenRead === true,
            creationTime: e?.creationTime ?? null,
            lastUpdateTime: e?.lastUpdateTime ?? null,
          })),
        };
      },
    }),
    update_reading_list_entry: tool({
      description:
        "Update a reading list entry by url (http/https only). Requires readingList permission.",
      inputSchema: z.object({
        url: z.string().min(1).max(2048),
        title: z.string().max(256).optional(),
        hasBeenRead: z.boolean().optional(),
      }),
      execute: async ({ url, title, hasBeenRead }) => {
        if (!(await hasPermission("readingList"))) {
          return permissionDeniedResult("readingList");
        }
        const scheme = (() => { try { return new URL(url).protocol; } catch { return null; } })();
        if (scheme !== "http:" && scheme !== "https:") {
          return { error: "reading list entries must be http/https urls — refused" };
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — reading list entry not updated" };
        }
        if (title === undefined && hasBeenRead === undefined) {
          return { error: "nothing to update — pass title or hasBeenRead" };
        }
        const update = { url };
        if (title !== undefined) update.title = title;
        if (hasBeenRead !== undefined) update.hasBeenRead = hasBeenRead;
        await chrome.readingList.updateEntry(update);
        return { ok: true, url, updated: true };
      },
    }),
    remove_reading_list_entry: tool({
      description:
        "Remove a reading list entry by url (http/https only). Requires readingList permission.",
      inputSchema: z.object({
        url: z.string().min(1).max(2048),
      }),
      execute: async ({ url }) => {
        if (!(await hasPermission("readingList"))) {
          return permissionDeniedResult("readingList");
        }
        const scheme = (() => { try { return new URL(url).protocol; } catch { return null; } })();
        if (scheme !== "http:" && scheme !== "https:") {
          return { error: "reading list entries must be http/https urls — refused" };
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — reading list entry not removed" };
        }
        await chrome.readingList.removeEntry({ url });
        return { ok: true, url, removed: true };
      },
    }),
    save_page_as_mhtml: tool({
      description:
        "Save a tab as MHTML (single-file page snapshot) and return its content inline (bounded; over-cap pages are refused with the size reported, never silently truncated). Requires pageCapture permission + browser-control grant for the tab's origin (scoped + expiring).",
      inputSchema: z.object({ tabId: z.number().optional() }),
      execute: async ({ tabId }) => {
        // EXACTLY capture_screenshot's consent semantics (the round-16..21
        // fence lessons): durable ownership asserted BEFORE anything else.
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — page not saved" };
        }
        if (!(await hasPermission("pageCapture"))) {
          return permissionDeniedResult("pageCapture");
        }
        const target = tabId
          ? await chrome.tabs.get(tabId).catch(() => null)
          : ((await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null);
        if (!target?.id) return { error: "no tab" };
        const origin = target.url
          ? (() => { try { return canonicalOrigin(target.url); } catch { return undefined; } })()
          : undefined;
        if (!origin) {
          return {
            error: "cannot read the tab's exact origin — page capture is waiting for an owner-selected site permission",
            waitingForPermission: true,
          };
        }
        const originPattern = `${origin}/*`;
        const hasExactHost = await chrome.permissions.contains({ origins: [originPattern] }).catch(() => false);
        if (!hasExactHost) {
          return permissionDenial(
            `page capture is waiting for site access to ${originPattern} — grant it in Settings → Permissions`,
            { reason: `save ${origin} as MHTML (site access to ${originPattern} is missing)`, permissions: [], grantOrigins: [origin] },
          );
        }
        return await withGrantLock(async () => {
          const grantId = validateGrantFor((await kvGet(GRANT_KEY))[GRANT_KEY], origin);
          if (!grantId) {
            return permissionDenial(
              "browser control not granted for this tab's origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `save ${origin} as MHTML`, grantOrigins: [origin] },
            );
          }
          // Round-20 navigation race (review B1): re-read the target identity
          // INSIDE the grant lock, IMMEDIATELY before the capture — a
          // navigation since the pre-lock resolution must not capture a
          // newly-unauthorized origin.
          const pre = await chrome.tabs.get(target.id).catch(() => null);
          const preOrigin = pre?.url
            ? (() => { try { return canonicalOrigin(pre.url); } catch { return undefined; } })()
            : undefined;
          if (!preOrigin || preOrigin !== origin) {
            return { error: "tab navigated before capture — page not saved" };
          }
          let blob = null;
          try {
            // CORRECT API: chrome.pageCapture.saveAsMHTML({tabId}) —
            // saveTabAsMHTML does NOT exist (same imagined-API class as tabGroups).
            blob = await chrome.pageCapture.saveAsMHTML({ tabId: target.id });
          } catch (e) {
            return { error: `capture failed: ${e?.message ?? e}` };
          }
          if (!blob) return { error: "capture returned no data" };
          const size = blob.size ?? 0;
          if (size > MAX_MHTML_BYTES) {
            return {
              error: `page too large to save inline (${size} bytes > ${MAX_MHTML_BYTES} cap) — not saved`,
              sizeBytes: size,
              capBytes: MAX_MHTML_BYTES,
            };
          }
          let mhtml;
          try {
            mhtml = await blob.text();
          } catch (e) {
            return { error: `capture failed: ${e?.message ?? e}` };
          }
          // Round-18 (review B2): an abort landing DURING the capture must not
          // return the bytes — re-check durable ownership before success.
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — page not saved" };
          }
          // Post-capture identity re-compare (review B1): the captured document
          // must still be the consented origin when the bytes are returned.
          const post = await chrome.tabs.get(target.id).catch(() => null);
          const postOrigin = post?.url
            ? (() => { try { return canonicalOrigin(post.url); } catch { return undefined; } })()
            : undefined;
          if (!postOrigin || postOrigin !== origin) {
            return { error: "tab navigated during capture — result discarded" };
          }
          return { ok: true, tabId: target.id, origin, mhtml, sizeBytes: size, truncated: false };
        });
      },
    }),
    // ── T7 sessions + history ──
    // chrome.sessions needs NO manifest permission (available to every
    // extension); chrome.history uses the ALREADY-DECLARED "history" optional
    // permission, checked on demand (the SW never calls permissions.request —
    // only a genuine owner gesture in Settings may grant). Restoring a closed
    // session reopens its tab(s), so the MUTATION rides the SAME product
    // browser-control grant as its tabs/window siblings: the grant must cover
    // EVERY origin being restored (a window restore is every tab's restore);
    // an origin-less restore requires a GLOBAL grant. History writes/deletes
    // mutate the global history store: per-URL ops are destination-origin
    // scoped, range/all wipes require a GLOBAL grant, and clear_all_history
    // additionally refuses without an explicit confirm:true.
    list_recently_closed: tool({
      description:
        "List recently closed tabs and windows (sessionId, kind, url, title, lastModified) so they can be restored with restore_closed.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ maxResults = 25 }) => {
        const api = chromeApi("sessions");
        if (!api) return { error: "sessions API not available in this browser context" };
        const closed = await api.getRecentlyClosed({ maxResults: 100 });
        const items = [];
        for (const s of Array.isArray(closed) ? closed : []) {
          if (s?.tab) {
            items.push({
              kind: "tab",
              sessionId: s.tab.sessionId ?? null,
              url: s.tab.url ?? null,
              title: String(s.tab.title ?? "").slice(0, 256),
              lastModified: s.lastModified ?? null,
            });
          } else if (s?.window) {
            const wt = Array.isArray(s.window.tabs) ? s.window.tabs : [];
            items.push({
              kind: "window",
              sessionId: s.window.sessionId ?? null,
              tabCount: wt.length,
              url: wt[0]?.url ?? null,
              title: String(wt[0]?.title ?? "").slice(0, 256),
              lastModified: s.lastModified ?? null,
            });
          }
        }
        return { closed: items.slice(0, maxResults), total: items.length };
      },
    }),
    restore_closed: tool({
      description:
        "Restore a recently closed tab or window by sessionId (from list_recently_closed). Requires browser-control permission (scoped + expiring) covering every origin being restored; if ANY restored entry has no canonical origin (chrome://, data:, file:, about:, view-source:, or a missing url) — or the set has no origins — a GLOBAL grant is required.",
      inputSchema: z.object({ sessionId: z.string().min(1).max(128) }),
      execute: async ({ sessionId }) =>
        await withGrantLock(async () => {
          const api = chromeApi("sessions");
          if (!api) return { error: "sessions API not available in this browser context" };
          // Re-read the closed sessions INSIDE the grant lock (a close/restore
          // since any earlier read must not smuggle an unauthorized origin past
          // the check).
          const closed = await api.getRecentlyClosed({ maxResults: 100 });
          const item = (Array.isArray(closed) ? closed : []).find(
            (s) => (s?.tab?.sessionId ?? s?.window?.sessionId) === sessionId,
          );
          if (!item) {
            return { error: "nothing to restore — no recently closed session with that sessionId" };
          }
          const toRestore = item.tab ? [item.tab] : (item.window?.tabs ?? []);
          // A restored entry is ORIGIN-LESS when its URL yields no canonical
          // origin (null/throw/empty — chrome://, data:, about:, file:,
          // view-source:, or a missing url). Filtering those nulls out and
          // granting on only the origin-ful rest would smuggle a privileged
          // chrome:// page (or data: attacker markup) past a scoped grant (the
          // B1 mixed-set gap). If ANY entry is origin-less — or the set has no
          // origins at all — the restore needs a GLOBAL grant; only a set where
          // EVERY entry has an origin may be satisfied by per-origin grants.
          const originSet = new Set();
          let hasOriginLess = false;
          for (const t of toRestore) {
            let origin = null;
            try {
              origin = t?.url ? canonicalOrigin(t.url) : null;
            } catch {
              origin = null;
            }
            if (typeof origin === "string" && origin !== "") originSet.add(origin);
            else hasOriginLess = true;
          }
          const covered = hasOriginLess || originSet.size === 0
            ? await isBrowserControlGranted(undefined)
            : (await Promise.all([...originSet].map((o) => isBrowserControlGranted(o)))).every(Boolean);
          if (!covered) {
            return permissionDenial(
              "browser control not granted for the restored origin(s) — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `restore a session on ${[...originSet].join(", ")}`, grantOrigins: [...originSet] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — session not restored" };
          }
          const restored = await chrome.sessions.restore(sessionId);
          // Re-check the fence AFTER the await: an abort/ownership loss during
          // restore must not report success.
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — session restored then aborted" };
          }
          return { ok: true, sessionId, restored: Boolean(restored), kind: item.tab ? "tab" : "window" };
        }),
    }),
    list_synced_devices: tool({
      description:
        "List devices synced to this Chrome profile and their recently closed sessions. Requires Chrome sign-in with sync enabled.",
      inputSchema: z.object({}),
      execute: async () => {
        const api = chromeApi("sessions");
        if (!api) return { error: "sessions API not available in this browser context" };
        const devices = await api.getDevices();
        const list = Array.isArray(devices) ? devices : [];
        if (list.length === 0) {
          return {
            devices: [],
            note: "no synced devices — sign in to Chrome and enable sync to see other devices",
          };
        }
        return {
          devices: list.slice(0, 16).map((d) => ({
            deviceName: String(d?.deviceName ?? "").slice(0, 128),
            sessions: (Array.isArray(d?.sessions) ? d.sessions : []).slice(0, 8).map((s) => ({
              sessionId: s?.tab?.sessionId ?? s?.window?.sessionId ?? null,
              kind: s?.tab ? "tab" : "window",
              url: (s?.tab ?? s?.window?.tabs?.[0])?.url ?? null,
              lastModified: s?.lastModified ?? null,
            })),
          })),
        };
      },
    }),
    search_history: tool({
      description:
        "Search browsing history (url, title, visitCount, lastVisitTime). Requires history permission.",
      inputSchema: z.object({
        text: z.string().max(512).optional(),
        startTime: z.number().int().min(0).optional(),
        endTime: z.number().int().min(0).optional(),
        maxResults: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ text = "", startTime, endTime, maxResults = 50 }) => {
        if (!(await hasPermission("history"))) {
          return permissionDeniedResult("history");
        }
        const query = { text, maxResults: Math.min(maxResults, 200) };
        if (startTime !== undefined) query.startTime = startTime;
        if (endTime !== undefined) query.endTime = endTime;
        const results = await chrome.history.search(query);
        const list = Array.isArray(results) ? results : [];
        return {
          history: list.slice(0, maxResults).map((h) => ({
            url: h.url ?? null,
            title: String(h.title ?? "").slice(0, 256),
            visitCount: h.visitCount ?? 0,
            lastVisitTime: h.lastVisitTime ?? null,
          })),
          total: list.length,
        };
      },
    }),
    get_history_visits: tool({
      description:
        "List the recorded visits for one history URL (visitTime, transition). Requires history permission.",
      inputSchema: z.object({
        url: z.string().url().max(2048),
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ url, maxResults = 50 }) => {
        if (!(await hasPermission("history"))) {
          return permissionDeniedResult("history");
        }
        const visits = await chrome.history.getVisits({ url });
        const list = Array.isArray(visits) ? visits : [];
        return {
          visits: list.slice(0, maxResults).map((v) => ({
            visitTime: v.visitTime ?? null,
            transition: v.transition ?? null,
            referringId: v.referringId ?? null,
          })),
          total: list.length,
        };
      },
    }),
    add_history_url: tool({
      description:
        "Add a URL to browsing history (http/https only). Requires history permission and browser-control permission for the URL's origin.",
      inputSchema: z.object({ url: z.string().url().max(2048) }),
      execute: async ({ url }) => {
        if (!(await hasPermission("history"))) {
          return permissionDeniedResult("history");
        }
        const origin = canonicalOrigin(url);
        if (!origin) return { error: "only http/https URLs can be added to history" };
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `add a history entry for ${origin}`, grantOrigins: [origin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history not added" };
          }
          await chrome.history.addUrl({ url });
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history added then aborted" };
          }
          return { ok: true, url, origin };
        });
      },
    }),
    delete_history_url: tool({
      description:
        "Delete all history entries for one URL (http/https only). Requires history permission and browser-control permission for the URL's origin.",
      inputSchema: z.object({ url: z.string().url().max(2048) }),
      execute: async ({ url }) => {
        if (!(await hasPermission("history"))) {
          return permissionDeniedResult("history");
        }
        const origin = canonicalOrigin(url);
        if (!origin) return { error: "only http/https URLs can be deleted from history" };
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(origin))) {
            return permissionDenial(
              "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `delete history for ${origin}`, grantOrigins: [origin] },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history not deleted" };
          }
          await chrome.history.deleteUrl({ url });
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history deleted then aborted" };
          }
          return { ok: true, url, origin };
        });
      },
    }),
    delete_history_range: tool({
      description:
        "Delete browsing history within a bounded time range (epoch ms; both bounds required — no open-ended wipes). Requires history permission and a GLOBAL browser-control grant.",
      inputSchema: z.object({
        startTime: z.number().int().min(0),
        endTime: z.number().int().min(0),
      }).refine((v) => v.endTime > v.startTime, "endTime must be after startTime"),
      execute: async ({ startTime, endTime }) => {
        if (!(await hasPermission("history"))) {
          return permissionDeniedResult("history");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return { error: "a GLOBAL browser-control grant is required to delete a history range" };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history not deleted" };
          }
          await chrome.history.deleteRange({ startTime, endTime });
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history deleted then aborted" };
          }
          return { ok: true, startTime, endTime };
        });
      },
    }),
    clear_all_history: tool({
      description:
        "Delete ALL browsing history. Requires history permission, a GLOBAL browser-control grant, and an explicit confirm:true (refuses without it).",
      inputSchema: z.object({ confirm: z.boolean().optional() }),
      execute: async ({ confirm }) => {
        if (confirm !== true) {
          return { error: "refusing to clear ALL history without an explicit confirm:true" };
        }
        if (!(await hasPermission("history"))) {
          return permissionDeniedResult("history");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return { error: "a GLOBAL browser-control grant is required to clear all history" };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history not cleared" };
          }
          await chrome.history.deleteAll();
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — history cleared then aborted" };
          }
          return { ok: true, clearedAll: true };
        });
      },
    }),
    // ── T11 extension management ─────────────────────────────────────────
    // chrome.management + chrome.runtime + chrome.sidePanel + chrome.action
    // (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01, Tranche 11).
    // chrome.management is a NEW optional permission (Settings capability row
    // grants it from a genuine owner gesture — the service worker never calls
    // chrome.permissions.request). runtime/sidePanel/action need no new
    // permission (sidePanel is already declared). EVERY mutation is
    // browser-wide / this-extension-own-surface and rides the GLOBAL
    // browser-control grant (never an origin grant). Self-protection: this
    // extension can never toggle or uninstall ITSELF.

    // ── chrome.management reads (bounded, honest denial) ──
    list_extensions: tool({
      description:
        "List the installed browser extensions/apps (id, name, version, enabled, type, install source). Bounded. Requires management permission.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ maxResults = 100 }) => {
        if (!(await hasManagementPermission())) {
          return permissionDeniedResult("management");
        }
        let all = [];
        try {
          all = await chrome.management.getAll();
        } catch (e) {
          return { error: `extension list failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(all) ? all : [];
        return {
          extensions: rows.slice(0, maxResults).map((x) => ({
            id: String(x?.id ?? "").slice(0, 64),
            name: String(x?.name ?? "").slice(0, 128),
            version: String(x?.version ?? "").slice(0, 64),
            enabled: Boolean(x?.enabled),
            type: String(x?.type ?? "").slice(0, 32),
            isApp: Boolean(x?.isApp),
            installType: String(x?.installType ?? "").slice(0, 32),
            mayDisable: Boolean(x?.mayDisable),
            mayEnable: Boolean(x?.mayEnable),
          })),
          returned: Math.min(rows.length, maxResults),
          total: rows.length,
          truncated: rows.length > maxResults,
        };
      },
    }),
    get_extension: tool({
      description:
        "Get one installed extension's details by id (name, version, enabled, type, permissions, homepage). Requires management permission.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
      }),
      execute: async ({ id }) => {
        if (!(await hasManagementPermission())) {
          return permissionDeniedResult("management");
        }
        let info = null;
        try {
          info = await chrome.management.get(id);
        } catch (e) {
          return { error: `no such extension: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        if (!info) return { error: "no such extension" };
        return {
          id: String(info.id ?? "").slice(0, 64),
          name: String(info.name ?? "").slice(0, 128),
          shortName: String(info.shortName ?? "").slice(0, 128),
          description: String(info.description ?? "").slice(0, 1024),
          version: String(info.version ?? "").slice(0, 64),
          enabled: Boolean(info.enabled),
          type: String(info.type ?? "").slice(0, 32),
          isApp: Boolean(info.isApp),
          homepageUrl: String(info.homepageUrl ?? "").slice(0, 2048),
          optionsUrl: String(info.optionsUrl ?? "").slice(0, 2048),
          installType: String(info.installType ?? "").slice(0, 32),
          mayDisable: Boolean(info.mayDisable),
          mayEnable: Boolean(info.mayEnable),
          permissions: (Array.isArray(info.permissions) ? info.permissions : []).slice(0, 64).map((p) => String(p).slice(0, 64)),
          hostPermissions: (Array.isArray(info.hostPermissions) ? info.hostPermissions : []).slice(0, 64).map((p) => String(p).slice(0, 128)),
        };
      },
    }),
    get_extension_permission_warnings: tool({
      description:
        "Get the human-readable permission warnings Chrome shows when installing the given extension id. Requires management permission.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
      }),
      execute: async ({ id }) => {
        if (!(await hasManagementPermission())) {
          return permissionDeniedResult("management");
        }
        let warnings = [];
        try {
          warnings = await chrome.management.getPermissionWarningsById(id);
        } catch (e) {
          return { error: `permission warnings failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(warnings) ? warnings : [];
        return {
          id,
          warnings: rows.slice(0, 64).map((w) => String(w).slice(0, 512)),
          total: rows.length,
          truncated: rows.length > 64,
        };
      },
    }),

    // ── chrome.management mutations (GLOBAL grant + self-protection) ──
    set_extension_enabled: tool({
      description:
        "Enable or disable an installed extension by id. Destructive, browser-wide. Grant-gated (global browser-control grant). Requires management permission. Refuses to toggle this extension itself.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        enabled: z.boolean(),
      }),
      execute: async ({ id, enabled }) => {
        const self = selfExtensionId();
        if (self && id === self) {
          return { error: "refusing to toggle this extension's own enabled state" };
        }
        return await withManagementGrant(enabled ? "enabled" : "disabled", async () => {
          await chrome.management.setEnabled(id, enabled);
          return { ok: true, id, enabled };
        });
      },
    }),
    uninstall_extension: tool({
      description:
        "Uninstall an installed extension by id. DESTRUCTIVE and irreversible. Requires an explicit confirm:true argument AND the global browser-control grant AND management permission. Refuses to uninstall this extension itself.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        confirm: z.boolean().optional(),
      }),
      execute: async ({ id, confirm }) => {
        if (confirm !== true) {
          return { error: "uninstall is destructive — pass confirm:true to proceed" };
        }
        const self = selfExtensionId();
        if (self && id === self) {
          return { error: "refusing to uninstall this extension itself" };
        }
        return await withManagementGrant("uninstalled", async () => {
          // The caller's explicit confirm:true + the global grant are the gates;
          // no additional native confirm dialog (it would block the SW).
          await chrome.management.uninstall(id, { showConfirmDialog: false });
          return { ok: true, id, uninstalled: true };
        });
      },
    }),

    // ── chrome.runtime reads (no permission) ──
    get_platform_info: tool({
      description:
        "Read the browser's platform info (os, cpu architecture). Read-only; no permission needed.",
      inputSchema: z.object({}),
      execute: async () => {
        let info = null;
        try {
          info = await chrome.runtime.getPlatformInfo();
        } catch (e) {
          return { error: `platform info failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        return {
          os: String(info?.os ?? "").slice(0, 32),
          arch: String(info?.arch ?? "").slice(0, 32),
          nacl_arch: String(info?.nacl_arch ?? "").slice(0, 32),
        };
      },
    }),
    get_extension_manifest: tool({
      description:
        "Read this extension's own manifest (name, version, permissions). Bounded. Read-only; no permission needed.",
      inputSchema: z.object({}),
      execute: async () => {
        let manifest = null;
        try {
          manifest = chrome.runtime.getManifest();
        } catch (e) {
          return { error: `manifest read failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        if (!manifest || typeof manifest !== "object") return { error: "no manifest" };
        return {
          name: String(manifest.name ?? "").slice(0, 128),
          version: String(manifest.version ?? "").slice(0, 64),
          manifest_version: Number(manifest.manifest_version ?? 0),
          description: String(manifest.description ?? "").slice(0, 1024),
          permissions: (Array.isArray(manifest.permissions) ? manifest.permissions : []).slice(0, 64).map((p) => String(p).slice(0, 64)),
          optional_permissions: (Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []).slice(0, 64).map((p) => String(p).slice(0, 64)),
        };
      },
    }),

    // ── chrome.sidePanel additions (sidePanel already declared) ──

    // ── chrome.action additions (no new permission) ──
    // ── T9 browser settings (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01,
    // Tranche 9) ─────────────────────────────────────────────────────────────
    // chrome.privacy / proxy / fontSettings / power / search / tts. Reads are
    // light (permission only). Every mutation is BROWSER-WIDE (no destination
    // origin) and therefore rides the GLOBAL browser-control grant inside the
    // grant lock — an origin-scoped grant is refused, assertRunOwned is checked
    // before AND after each mutation. Optional permissions are requested on
    // demand via Settings; the SW never calls chrome.permissions.request here.
    get_privacy_setting: tool({
      description:
        "Read one of Chrome's desktop privacy preferences (network/services/websites). Read-only; requires the privacy permission.",
      inputSchema: z.object({
        setting: z.enum(PRIVACY_SETTING_NAMES),
      }),
      execute: async ({ setting }) => {
        if (!(await hasPermission("privacy"))) {
          return permissionDeniedResult("privacy");
        }
        const chromeSetting = privacyChromeSetting(setting);
        if (!chromeSetting) return { error: `privacy setting unavailable: ${setting}` };
        let result;
        try {
          result = await chromeSetting.get({});
        } catch (e) {
          return { error: `privacy read failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        return {
          setting,
          value: result?.value ?? null,
          levelOfControl: String(result?.levelOfControl ?? "").slice(0, 64) || null,
        };
      },
    }),
    set_privacy_setting: tool({
      description:
        "Set one of Chrome's desktop privacy preferences. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the privacy permission.",
      inputSchema: z.object({
        setting: z.enum(PRIVACY_SETTING_NAMES),
        value: z.union([z.boolean(), z.string().min(1).max(64)]),
      }),
      execute: async ({ setting, value }) => {
        if (!(await hasPermission("privacy"))) {
          return permissionDeniedResult("privacy");
        }
        // Validate the value against the setting's kind BEFORE any grant/Chrome work.
        const valueError = privacyValueError(setting, value);
        if (valueError) return { error: valueError };
        const chromeSetting = privacyChromeSetting(setting);
        if (!chromeSetting) return { error: `privacy setting unavailable: ${setting}` };
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a privacy change is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "change a privacy setting (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — privacy setting not changed" };
          }
          try {
            await chromeSetting.set({ value });
          } catch (e) {
            return { error: `privacy set failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — privacy setting changed then aborted" };
          }
          return { ok: true, setting, value };
        });
      },
    }),
    get_proxy_settings: tool({
      description:
        "Read the current proxy configuration (mode + PAC script URL + fixed rules). Read-only; requires the proxy permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("proxy"))) {
          return permissionDeniedResult("proxy");
        }
        let config;
        try {
          config = await chrome.proxy.settings.get({});
        } catch (e) {
          return { error: `proxy read failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rules = config?.rules;
        return {
          mode: String(config?.mode ?? "").slice(0, 32) || null,
          pacScriptUrl: config?.pacScript?.url ? String(config.pacScript.url).slice(0, 2048) : null,
          rules: rules
            ? {
                singleProxy: rules.singleProxy ?? null,
                proxyForHttp: rules.proxyForHttp ?? null,
                proxyForHttps: rules.proxyForHttps ?? null,
                proxyForFtp: rules.proxyForFtp ?? null,
                fallbackProxy: rules.fallbackProxy ?? null,
                bypassList: Array.isArray(rules.bypassList) ? rules.bypassList.slice(0, 64) : [],
              }
            : null,
        };
      },
    }),
    set_proxy_settings: tool({
      description:
        "Set the browser proxy configuration (mode + optional PAC script or fixed rules). Browser-wide traffic control: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the proxy permission.",
      inputSchema: z.object({
        mode: z.enum(["direct", "auto_detect", "pac_script", "fixed_servers", "system"]),
        pacScript: z
          .object({ url: z.string().min(1).max(2048), mandatory: z.boolean().optional() })
          .optional(),
        rules: z
          .object({
            singleProxy: z.string().min(1).max(253).optional(),
            proxyForHttp: z.string().min(1).max(253).optional(),
            proxyForHttps: z.string().min(1).max(253).optional(),
            proxyForFtp: z.string().min(1).max(253).optional(),
            fallbackProxy: z.string().min(1).max(253).optional(),
            bypassList: z.array(z.string().min(1).max(253)).max(64).optional(),
          })
          .optional(),
      }),
      execute: async ({ mode, pacScript, rules }) => {
        if (!(await hasPermission("proxy"))) {
          return permissionDeniedResult("proxy");
        }
        // Build + validate the value BEFORE any grant work or Chrome call.
        const value = { mode };
        if (mode === "pac_script") {
          if (!pacScript?.url) return { error: "pac_script mode requires pacScript.url" };
          let u;
          try {
            u = new URL(pacScript.url);
          } catch {
            return { error: "pacScript.url is not a valid URL" };
          }
          // A PAC fetched over a non-http(s) scheme is a traffic-redirect risk —
          // refuse it outright (fail closed).
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            return { error: "pacScript.url must be an http(s) URL (a non-http(s) PAC is refused)" };
          }
          value.pacScript = { url: pacScript.url };
          if (pacScript.mandatory !== undefined) value.pacScript.mandatory = pacScript.mandatory;
        } else if (mode === "fixed_servers") {
          if (!rules) return { error: "fixed_servers mode requires rules" };
          value.rules = {};
          for (const k of ["singleProxy", "proxyForHttp", "proxyForHttps", "proxyForFtp", "fallbackProxy"]) {
            if (rules[k] !== undefined) value.rules[k] = rules[k];
          }
          if (rules.bypassList !== undefined) value.rules.bypassList = rules.bypassList;
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — proxy changes are browser-wide traffic control and need the global grant (an origin-scoped grant is refused)",
              { reason: "change the proxy settings (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — proxy not changed" };
          }
          try {
            await chrome.proxy.settings.set({ value });
          } catch (e) {
            return { error: `proxy set failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — proxy changed then aborted" };
          }
          return { ok: true, mode };
        });
      },
    }),
    clear_proxy_settings: tool({
      description:
        "Clear the proxy configuration back to the system default. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the proxy permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("proxy"))) {
          return permissionDeniedResult("proxy");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — proxy changes are browser-wide traffic control and need the global grant (an origin-scoped grant is refused)",
              { reason: "change the proxy settings (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — proxy not cleared" };
          }
          try {
            await chrome.proxy.settings.clear({});
          } catch (e) {
            return { error: `proxy clear failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — proxy cleared then aborted" };
          }
          return { ok: true, cleared: true };
        });
      },
    }),
    get_font_settings: tool({
      description:
        "Read the default font size and the default font for each generic family. Read-only; requires the fontSettings permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("fontSettings"))) {
          return permissionDeniedResult("fontSettings");
        }
        let size = null;
        try {
          const r = await chrome.fontSettings.getDefaultFontSize({});
          size = r?.pixelSize ?? null;
        } catch {
          size = null;
        }
        const fonts = {};
        for (const family of FONT_GENERIC_FAMILIES) {
          try {
            const r = await chrome.fontSettings.getFont({ genericFamily: family });
            fonts[family] = String(r?.fontId ?? "").slice(0, 128) || null;
          } catch {
            fonts[family] = null;
          }
        }
        return { defaultFontSizePx: size, defaultFonts: fonts };
      },
    }),
    set_font_size: tool({
      description:
        "Set the default font size in pixels. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the fontSettings permission.",
      inputSchema: z.object({ pixelSize: z.number().int().min(1).max(100) }),
      execute: async ({ pixelSize }) => {
        if (!(await hasPermission("fontSettings"))) {
          return permissionDeniedResult("fontSettings");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a font change is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "change a font setting (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — font size not changed" };
          }
          try {
            await chrome.fontSettings.setDefaultFontSize({ pixelSize });
          } catch (e) {
            return { error: `font size set failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — font size changed then aborted" };
          }
          return { ok: true, pixelSize };
        });
      },
    }),
    set_default_font: tool({
      description:
        "Set the default font for a generic family. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the fontSettings permission.",
      inputSchema: z.object({
        genericFamily: z.enum(FONT_GENERIC_FAMILIES),
        fontId: z.string().min(1).max(128),
      }),
      execute: async ({ genericFamily, fontId }) => {
        if (!(await hasPermission("fontSettings"))) {
          return permissionDeniedResult("fontSettings");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a font change is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "change a font setting (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — font not changed" };
          }
          try {
            await chrome.fontSettings.setFont({ genericFamily, fontId });
          } catch (e) {
            return { error: `font set failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — font changed then aborted" };
          }
          return { ok: true, genericFamily, fontId };
        });
      },
    }),
    clear_font_settings: tool({
      description:
        "Clear custom font settings (default size + per-family fonts) back to Chrome's defaults. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the fontSettings permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("fontSettings"))) {
          return permissionDeniedResult("fontSettings");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a font change is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "change a font setting (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — fonts not cleared" };
          }
          try {
            await chrome.fontSettings.clearDefaultFontSize({});
            for (const family of FONT_GENERIC_FAMILIES) {
              await chrome.fontSettings.clearFont({ genericFamily: family });
            }
          } catch (e) {
            return { error: `font clear failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — fonts cleared then aborted" };
          }
          return { ok: true, cleared: true };
        });
      },
    }),
    request_keep_awake: tool({
      description:
        "Keep the system or the display awake. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the power permission.",
      inputSchema: z.object({ level: z.enum(["system", "display"]) }),
      execute: async ({ level }) => {
        if (!(await hasPermission("power"))) {
          return permissionDeniedResult("power");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a power change is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "change the power setting (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — keep-awake not set" };
          }
          try {
            await chrome.power.requestKeepAwake(level);
          } catch (e) {
            return { error: `keep-awake failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — keep-awake set then aborted" };
          }
          // chrome.power exposes no getter; the honest state is the level we set.
          return { ok: true, level, keepAwake: level };
        });
      },
    }),
    release_keep_awake: tool({
      description:
        "Release a previously requested keep-awake. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the power permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("power"))) {
          return permissionDeniedResult("power");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a power change is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "change the power setting (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — keep-awake not released" };
          }
          try {
            // CORRECT API: chrome.power.releaseKeepAwake() — chrome.power.release()
            // does NOT exist.
            await chrome.power.releaseKeepAwake();
          } catch (e) {
            return { error: `keep-awake release failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — keep-awake released then aborted" };
          }
          return { ok: true, released: true };
        });
      },
    }),
    search_query: tool({
      description:
        "Run a search with the browser's default search engine (chrome.search.query only — it opens the engine's results, never an arbitrary URL). Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the search permission.",
      inputSchema: z.object({ text: z.string().min(1).max(512) }),
      execute: async ({ text }) => {
        if (!(await hasPermission("search"))) {
          return permissionDeniedResult("search");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — a search is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "run a browser search (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — search not run" };
          }
          try {
            await chrome.search.query({ text });
          } catch (e) {
            return { error: `search failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — search run then aborted" };
          }
          return { ok: true, queryLength: text.length };
        });
      },
    }),
    tts_speak: tool({
      description:
        "Speak text aloud with Chrome's text-to-speech. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the tts permission.",
      inputSchema: z.object({
        text: z.string().min(1).max(1000),
        voiceName: z.string().min(1).max(128).optional(),
        rate: z.number().min(0.1).max(10).optional(),
        pitch: z.number().min(0).max(2).optional(),
        volume: z.number().min(0).max(1).optional(),
      }),
      execute: async ({ text, voiceName, rate, pitch, volume }) => {
        if (!(await hasPermission("tts"))) {
          return permissionDeniedResult("tts");
        }
        const options = {};
        if (voiceName !== undefined) options.voiceName = voiceName;
        if (rate !== undefined) options.rate = rate;
        if (pitch !== undefined) options.pitch = pitch;
        if (volume !== undefined) options.volume = volume;
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — speech is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "use text-to-speech (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — speech not started" };
          }
          try {
            await chrome.tts.speak(text, options);
          } catch (e) {
            return { error: `speech failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — speech started then aborted" };
          }
          return { ok: true, spokenCharacters: text.length };
        });
      },
    }),
    tts_stop: tool({
      description:
        "Stop any ongoing text-to-speech. Browser-wide: requires a GLOBAL browser-control grant (an origin-scoped grant is refused) and the tts permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("tts"))) {
          return permissionDeniedResult("tts");
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return permissionDenial(
              "browser control not granted globally — speech is browser-wide and needs the global grant (an origin-scoped grant is refused)",
              { reason: "use text-to-speech (browser-wide — this needs the all-sites browser-control grant)", grantGlobal: true },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — speech not stopped" };
          }
          try {
            await chrome.tts.stop();
          } catch (e) {
            return { error: `speech stop failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — speech stopped then aborted" };
          }
          return { ok: true, stopped: true };
        });
      },
    }),
    list_tts_voices: tool({
      description:
        "List the available text-to-speech voices (bounded). Read-only; requires the tts permission.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(64).optional(),
      }),
      execute: async ({ maxResults = 32 }) => {
        if (!(await hasPermission("tts"))) {
          return permissionDeniedResult("tts");
        }
        let voices = [];
        try {
          voices = await chrome.tts.getVoices();
        } catch (e) {
          return { error: `voice list failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(voices) ? voices : [];
        return {
          voices: rows.slice(0, maxResults).map((v) => ({
            voiceName: String(v?.voiceName ?? "").slice(0, 128),
            lang: String(v?.lang ?? "").slice(0, 32),
            localService: Boolean(v?.localService),
            isDefault: Boolean(v?.isDefault),
          })),
          returned: Math.min(rows.length, maxResults),
          total: rows.length,
          truncated: rows.length > maxResults,
        };
      },
    }),
    tts_is_speaking: tool({
      description:
        "Whether text-to-speech is currently speaking. Read-only; requires the tts permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("tts"))) {
          return permissionDeniedResult("tts");
        }
        let speaking = false;
        try {
          speaking = await chrome.tts.isSpeaking();
        } catch {
          speaking = false;
        }
        return { speaking: Boolean(speaking) };
      },
    }),
    // ── T10 network rules ────────────────────────────────────────────────
    // chrome.declarativeNetRequest dynamic rules (ALL mutations are
    // browser-wide → GLOBAL browser-control grant only), chrome.webNavigation
    // frame reads (+ onBeforeNavigate/onCompleted wired into the
    // recent_browser_events buffer by the SW), and chrome.webRequest
    // OBSERVATION only (MV3 non-blocking; blocking webRequest needs
    // enterprise policy and is EXCLUDED).
    list_network_rules: tool({
      description:
        "List the extension's dynamic network rules (declarativeNetRequest). Read-only; requires the declarativeNetRequest permission (granted at install).",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("declarativeNetRequest"))) {
          return permissionDeniedResult("declarativeNetRequest");
        }
        let rules = [];
        try {
          rules = await chrome.declarativeNetRequest.getDynamicRules();
        } catch (e) {
          return { error: `rule list failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(rules) ? rules : [];
        return {
          rules: rows.slice(0, DNR_MAX_DYNAMIC_RULES).map(boundedDnrRule),
          returned: Math.min(rows.length, DNR_MAX_DYNAMIC_RULES),
          total: rows.length,
          truncated: rows.length > DNR_MAX_DYNAMIC_RULES,
        };
      },
    }),
    add_network_rule: tool({
      description:
        "Add a dynamic network rule (block/allow/redirect/upgradeScheme). MUTATING and BROWSER-WIDE: requires the GLOBAL browser-control grant + declarativeNetRequest permission. Bounded shape: urlFilter/regexFilter ≤500 chars, ≤100 dynamic rules.",
      inputSchema: z.object({
        id: z.number().int().min(1).max(100000),
        priority: z.number().int().min(1).max(100000).optional(),
        action: z.enum(["block", "allow", "redirect", "upgradeScheme", "modifyHeaders"]),
        urlFilter: z.string().min(1).max(500).optional(),
        regexFilter: z.string().min(1).max(500).optional(),
        resourceTypes: z.array(z.enum(DNR_RESOURCE_TYPES)).min(1).max(16).optional(),
        requestDomains: z.array(z.string().min(1).max(253)).min(1).max(20).optional(),
        redirectUrl: z.string().min(1).max(2048).optional(),
      }),
      execute: async (input) => {
        return await withNetworkRulesGrant("added", async () => {
          const built = buildDnrRule(input, input.id);
          if (built.error) return built;
          let existing = [];
          try {
            existing = await chrome.declarativeNetRequest.getDynamicRules();
          } catch (e) {
            return { error: `rule list failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          const rows = Array.isArray(existing) ? existing : [];
          if (rows.some((r) => r?.id === input.id)) {
            return { error: `rule id ${input.id} already exists — use update_network_rule or a different id` };
          }
          if (rows.length >= DNR_MAX_DYNAMIC_RULES) {
            return {
              error: `dynamic rule cap reached (${DNR_MAX_DYNAMIC_RULES}) — remove a rule first`,
            };
          }
          try {
            await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [built.rule] });
          } catch (e) {
            return { error: `rule add failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          return { ok: true, rule: boundedDnrRule(built.rule) };
        });
      },
    }),
    update_network_rule: tool({
      description:
        "Replace an existing dynamic network rule (by ruleId) with a new bounded rule shape. MUTATING and BROWSER-WIDE: requires the GLOBAL browser-control grant + declarativeNetRequest permission.",
      inputSchema: z.object({
        ruleId: z.number().int().min(1).max(100000),
        priority: z.number().int().min(1).max(100000).optional(),
        action: z.enum(["block", "allow", "redirect", "upgradeScheme", "modifyHeaders"]),
        urlFilter: z.string().min(1).max(500).optional(),
        regexFilter: z.string().min(1).max(500).optional(),
        resourceTypes: z.array(z.enum(DNR_RESOURCE_TYPES)).min(1).max(16).optional(),
        requestDomains: z.array(z.string().min(1).max(253)).min(1).max(20).optional(),
        redirectUrl: z.string().min(1).max(2048).optional(),
      }),
      execute: async ({ ruleId, ...input }) => {
        return await withNetworkRulesGrant("updated", async () => {
          let existing = [];
          try {
            existing = await chrome.declarativeNetRequest.getDynamicRules();
          } catch (e) {
            return { error: `rule list failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          const rows = Array.isArray(existing) ? existing : [];
          if (!rows.some((r) => r?.id === ruleId)) {
            return { error: `no dynamic rule with id ${ruleId}` };
          }
          const built = buildDnrRule(input, ruleId);
          if (built.error) return built;
          try {
            await chrome.declarativeNetRequest.updateDynamicRules({
              removeRuleIds: [ruleId],
              addRules: [built.rule],
            });
          } catch (e) {
            return { error: `rule update failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          return { ok: true, rule: boundedDnrRule(built.rule) };
        });
      },
    }),
    remove_network_rule: tool({
      description:
        "Remove dynamic network rules by id. MUTATING and BROWSER-WIDE: requires the GLOBAL browser-control grant + declarativeNetRequest permission.",
      inputSchema: z.object({
        ruleIds: z.array(z.number().int().min(1).max(100000)).min(1).max(DNR_MAX_DYNAMIC_RULES),
      }),
      execute: async ({ ruleIds }) => {
        return await withNetworkRulesGrant("removed", async () => {
          try {
            await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ruleIds });
          } catch (e) {
            return { error: `rule remove failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          return { ok: true, removedIds: ruleIds };
        });
      },
    }),
    get_network_rule_matches: tool({
      description:
        "Test which dynamic network rules would match a hypothetical request (testMatchOutcome). Read-only; requires the declarativeNetRequest permission. URL must be http/https.",
      inputSchema: z.object({
        url: z.string().url().max(2048),
        tabId: z.number().int().min(1).optional(),
        resourceType: z.enum(DNR_RESOURCE_TYPES).optional(),
      }),
      execute: async ({ url, tabId, resourceType }) => {
        if (!(await hasPermission("declarativeNetRequest"))) {
          return permissionDeniedResult("declarativeNetRequest");
        }
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return { error: "only http/https URLs can be tested" };
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return { error: "only http/https URLs can be tested" };
        }
        const request = { url: parsed.href };
        if (tabId !== undefined) request.tabId = tabId;
        if (resourceType !== undefined) request.resourceType = resourceType;
        let outcome;
        try {
          outcome = await chrome.declarativeNetRequest.testMatchOutcome(request);
        } catch (e) {
          return { error: `match test failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const matched = Array.isArray(outcome?.matchedRules) ? outcome.matchedRules : [];
        return {
          matchedRules: matched.slice(0, DNR_MAX_DYNAMIC_RULES).map((m) => ({
            ruleId: m?.rule?.id ?? null,
            rule: boundedDnrRule(m?.rule),
          })),
          returned: Math.min(matched.length, DNR_MAX_DYNAMIC_RULES),
          total: matched.length,
        };
      },
    }),
    get_navigation_frames: tool({
      description:
        "List all frames of a tab (chrome.webNavigation.getAllFrames). Read-only; requires the webNavigation permission (granted at install).",
      inputSchema: z.object({
        tabId: z.number().int().min(1),
      }),
      execute: async ({ tabId }) => {
        if (!(await hasPermission("webNavigation"))) {
          return permissionDeniedResult("webNavigation");
        }
        let frames;
        try {
          frames = await chrome.webNavigation.getAllFrames({ tabId });
        } catch (e) {
          return { error: `frame list failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(frames) ? frames : [];
        return {
          frames: rows.slice(0, 100).map((f) => ({
            frameId: f?.frameId ?? null,
            parentFrameId: f?.parentFrameId ?? null,
            url: f?.url ? String(f.url).slice(0, 2048) : null,
            errorOccurred: Boolean(f?.errorOccurred),
          })),
          returned: Math.min(rows.length, 100),
          total: rows.length,
        };
      },
    }),
    get_navigation_frame: tool({
      description:
        "Get one frame of a tab by frameId (chrome.webNavigation.getFrame). Read-only; requires the webNavigation permission.",
      inputSchema: z.object({
        tabId: z.number().int().min(1),
        frameId: z.number().int().min(0),
      }),
      execute: async ({ tabId, frameId }) => {
        if (!(await hasPermission("webNavigation"))) {
          return permissionDeniedResult("webNavigation");
        }
        let frame;
        try {
          frame = await chrome.webNavigation.getFrame({ tabId, frameId });
        } catch (e) {
          return { error: `frame read failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        if (!frame) return { error: "no such frame" };
        return {
          frame: {
            frameId: frame.frameId ?? null,
            parentFrameId: frame.parentFrameId ?? null,
            url: frame.url ? String(frame.url).slice(0, 2048) : null,
            errorOccurred: Boolean(frame.errorOccurred),
          },
        };
      },
    }),
    get_request_activity: tool({
      description:
        "Read recent observed web request activity (MV3 NON-BLOCKING webRequest observation only — blocking webRequest requires enterprise policy and is excluded). Events arrive only for hosts the owner already granted host access to (never broadened here). Requires the webRequest permission (granted at install).",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(100).optional(),
        tabId: z.number().int().min(0).optional(),
        phase: z.enum(["started", "completed"]).optional(),
      }),
      execute: async ({ maxResults = 50, tabId, phase }) => {
        if (!(await hasPermission("webRequest"))) {
          return permissionDeniedResult("webRequest");
        }
        const stored = await kvGet(REQUEST_ACTIVITY_KEY);
        const list = Array.isArray(stored[REQUEST_ACTIVITY_KEY]) ? stored[REQUEST_ACTIVITY_KEY] : [];
        const filtered = list.filter((e) =>
          (tabId === undefined || e?.tabId === tabId) &&
          (phase === undefined || e?.phase === phase));
        return {
          requests: filtered.slice(0, maxResults).map((e) => ({
            at: e?.at ?? null,
            phase: e?.phase === "completed" ? "completed" : "started",
            requestId: e?.requestId ?? null,
            tabId: e?.tabId ?? null,
            method: e?.method ? String(e.method).slice(0, 16) : null,
            type: e?.type ? String(e.type).slice(0, 32) : null,
            statusCode: typeof e?.statusCode === "number" ? e.statusCode : null,
            url: e?.url ? String(e.url).slice(0, 2048) : null,
            initiator: e?.initiator ? String(e.initiator).slice(0, 2048) : null,
          })),
          returned: Math.min(filtered.length, maxResults),
          total: filtered.length,
          note: "observation is scoped to hosts with existing host grants; a new grant takes effect on the next service-worker start",
        };
      },
    }),
    // ── T12 power tools ───────────────────────────────────────────────────
    // chrome.userScripts (USER_SCRIPT world, single-origin matches) and
    // chrome.scripting dynamic content scripts (single-origin matches).
    // desktopCapture is intentionally ABSENT: chooseDesktopMedia requires a
    // user-gesture-visible requester page and the extension exposes no such
    // owned channel (documented exclusion — no stub tool).
    register_user_script: tool({
      description:
        "Register a USER_SCRIPT-world user script (id + js + matches). matches must be single exact http(s) origin patterns — <all_urls> and wildcard patterns are refused. Requires the userScripts permission, the exact-origin HOST permission for every match (granted in Settings), and the browser-control grant covering every matches origin.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        js: z.string().min(1).max(32768),
        matches: z.array(z.string().min(1).max(2048)).min(1).max(8),
        runAt: z.enum(["document_start", "document_end", "document_idle"]).optional(),
      }),
      execute: async ({ id, js, matches, runAt }) => {
        const m = t12ScriptMatches(matches);
        if (m.error) return m;
        return await withScriptRegistrationGrant(
          { permission: "userScripts", permissionLabel: "User scripts", patterns: m.patterns, origins: m.origins },
          "registered",
          async () => {
            const script = { id, js, matches: m.patterns };
            if (runAt !== undefined) script.runAt = runAt;
            await chrome.userScripts.register([script]);
            return { ok: true, id, matches: m.patterns, jsBytes: js.length };
          },
        );
      },
    }),
    update_user_script: tool({
      description:
        "Update a registered user script (full replacement: id + js + matches). Same permission + host + grant discipline as register_user_script.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        js: z.string().min(1).max(32768),
        matches: z.array(z.string().min(1).max(2048)).min(1).max(8),
        runAt: z.enum(["document_start", "document_end", "document_idle"]).optional(),
      }),
      execute: async ({ id, js, matches, runAt }) => {
        const m = t12ScriptMatches(matches);
        if (m.error) return m;
        return await withScriptRegistrationGrant(
          { permission: "userScripts", permissionLabel: "User scripts", patterns: m.patterns, origins: m.origins },
          "updated",
          async () => {
            const script = { id, js, matches: m.patterns };
            if (runAt !== undefined) script.runAt = runAt;
            await chrome.userScripts.update([script]);
            return { ok: true, id, matches: m.patterns, jsBytes: js.length };
          },
        );
      },
    }),
    unregister_user_script: tool({
      description:
        "Unregister a user script by id. Grant coverage is checked against the REGISTERED script's matches origins (a script whose matches fail today's validation is an origin-less scope: only the global grant may remove it).",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      execute: async ({ id }) => {
        if (!(await hasPermission("userScripts"))) {
          return permissionDeniedResult("userScripts");
        }
        let scripts = [];
        try {
          scripts = await chrome.userScripts.getScripts({ ids: [id] });
        } catch (e) {
          return { error: `user script lookup failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const script = Array.isArray(scripts) ? scripts[0] : null;
        if (!script) return { error: `no user script with id '${id.slice(0, 64)}'` };
        const m = t12ScriptMatches(Array.isArray(script.matches) ? script.matches : []);
        // Fail CLOSED: matches that no longer validate are treated as an
        // origin-less scope ([null]) — global grant only, never filtered out.
        const origins = m.error ? [null] : m.origins;
        const patterns = m.error ? [] : m.patterns;
        return await withGrantLock(async () => {
          if (patterns.length > 0) {
            try {
              if (!(await chrome.permissions.contains({ origins: patterns }))) {
                return {
                  error: `host permission not granted for every matches origin (${origins.join(", ")}) — enable host access from the chat when prompted, or in Settings → Permissions`,
                };
              }
            } catch {
              return { error: "host permission check failed — the grant state could not be read; try again" };
            }
          }
          if (!(await t12OriginsCovered(origins))) {
            return permissionDenial(
              "browser control not granted for every matches origin here — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `run a script on ${origins.join(", ")}`, grantOrigins: origins },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — script not unregistered" };
          }
          try {
            await chrome.userScripts.unregister({ ids: [id] });
          } catch (e) {
            return { error: `script unregister failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — script unregistered then aborted" };
          }
          return { ok: true, id };
        });
      },
    }),
    list_user_scripts: tool({
      description:
        "List registered user scripts (id, matches, runAt, js size + bounded preview). Read-only; requires the userScripts permission.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ maxResults = 50 }) => {
        if (!(await hasPermission("userScripts"))) {
          return permissionDeniedResult("userScripts");
        }
        let scripts = [];
        try {
          scripts = await chrome.userScripts.getScripts({});
        } catch (e) {
          return { error: `user script query failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(scripts) ? scripts : [];
        return {
          userScripts: rows.slice(0, maxResults).map((s) => ({
            id: String(s?.id ?? "").slice(0, 64),
            matches: (Array.isArray(s?.matches) ? s.matches : []).slice(0, 8).map((p) => String(p).slice(0, 2048)),
            runAt: typeof s?.runAt === "string" ? s.runAt.slice(0, 32) : null,
            jsBytes: typeof s?.js === "string" ? s.js.length : 0,
            jsPreview: typeof s?.js === "string" ? s.js.slice(0, 256) : "",
          })),
          returned: Math.min(rows.length, maxResults),
          total: rows.length,
          truncated: rows.length > maxResults,
        };
      },
    }),
    register_content_script: tool({
      description:
        "Register a DYNAMIC content script via chrome.scripting (id + js + matches + runAt, optional world ISOLATED|MAIN). matches must be single exact http(s) origin patterns. Requires the scripting permission, the exact-origin HOST permission for every match, and the browser-control grant covering every matches origin.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        js: z.string().min(1).max(32768),
        matches: z.array(z.string().min(1).max(2048)).min(1).max(8),
        runAt: z.enum(["document_start", "document_end", "document_idle"]).optional(),
        world: z.enum(["ISOLATED", "MAIN"]).optional(),
      }),
      execute: async ({ id, js, matches, runAt, world }) => {
        const m = t12ScriptMatches(matches);
        if (m.error) return m;
        return await withScriptRegistrationGrant(
          { permission: "scripting", permissionLabel: "Site Agents", patterns: m.patterns, origins: m.origins },
          "registered",
          async () => {
            const script = { id, js, matches: m.patterns };
            if (runAt !== undefined) script.runAt = runAt;
            if (world !== undefined) script.world = world;
            await chrome.scripting.registerContentScripts([script]);
            return { ok: true, id, matches: m.patterns, jsBytes: js.length };
          },
        );
      },
    }),
    update_content_script: tool({
      description:
        "Update a registered dynamic content script (full replacement: id + js + matches). Same permission + host + grant discipline as register_content_script.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        js: z.string().min(1).max(32768),
        matches: z.array(z.string().min(1).max(2048)).min(1).max(8),
        runAt: z.enum(["document_start", "document_end", "document_idle"]).optional(),
        world: z.enum(["ISOLATED", "MAIN"]).optional(),
      }),
      execute: async ({ id, js, matches, runAt, world }) => {
        const m = t12ScriptMatches(matches);
        if (m.error) return m;
        return await withScriptRegistrationGrant(
          { permission: "scripting", permissionLabel: "Site Agents", patterns: m.patterns, origins: m.origins },
          "updated",
          async () => {
            const script = { id, js, matches: m.patterns };
            if (runAt !== undefined) script.runAt = runAt;
            if (world !== undefined) script.world = world;
            await chrome.scripting.updateContentScripts([script]);
            return { ok: true, id, matches: m.patterns, jsBytes: js.length };
          },
        );
      },
    }),
    unregister_content_script: tool({
      description:
        "Unregister a dynamic content script by id. Grant coverage is checked against the REGISTERED script's matches origins (invalid matches are an origin-less scope: global grant only).",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      execute: async ({ id }) => {
        if (!(await hasPermission("scripting"))) {
          return permissionDeniedResult("scripting");
        }
        let scripts = [];
        try {
          scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        } catch (e) {
          return { error: `content script lookup failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const script = Array.isArray(scripts) ? scripts[0] : null;
        if (!script) return { error: `no content script with id '${id.slice(0, 64)}'` };
        const m = t12ScriptMatches(Array.isArray(script.matches) ? script.matches : []);
        // Fail CLOSED: invalid registered matches become an origin-less scope
        // ([null]) — global grant only, never filtered out.
        const origins = m.error ? [null] : m.origins;
        const patterns = m.error ? [] : m.patterns;
        return await withGrantLock(async () => {
          if (patterns.length > 0) {
            try {
              if (!(await chrome.permissions.contains({ origins: patterns }))) {
                return {
                  error: `host permission not granted for every matches origin (${origins.join(", ")}) — enable host access from the chat when prompted, or in Settings → Permissions`,
                };
              }
            } catch {
              return { error: "host permission check failed — the grant state could not be read; try again" };
            }
          }
          if (!(await t12OriginsCovered(origins))) {
            return permissionDenial(
              "browser control not granted for every matches origin here — the owner can approve it in the approval card here, or in Settings → Browser control",
              { reason: `run a script on ${origins.join(", ")}`, grantOrigins: origins },
            );
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — script not unregistered" };
          }
          try {
            await chrome.scripting.unregisterContentScripts({ ids: [id] });
          } catch (e) {
            return { error: `script unregister failed: ${String(e?.message ?? e).slice(0, 200)}` };
          }
          try {
            await assertRunOwned();
          } catch {
            return { error: "run aborted — script unregistered then aborted" };
          }
          return { ok: true, id };
        });
      },
    }),
    list_content_scripts: tool({
      description:
        "List dynamically registered content scripts (id, matches, runAt, world, js size + bounded preview). Read-only; requires the scripting permission.",
      inputSchema: z.object({
        maxResults: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ maxResults = 50 }) => {
        if (!(await hasPermission("scripting"))) {
          return permissionDeniedResult("scripting");
        }
        let scripts = [];
        try {
          scripts = await chrome.scripting.getRegisteredContentScripts({});
        } catch (e) {
          return { error: `content script query failed: ${String(e?.message ?? e).slice(0, 200)}` };
        }
        const rows = Array.isArray(scripts) ? scripts : [];
        return {
          contentScripts: rows.slice(0, maxResults).map((s) => ({
            id: String(s?.id ?? "").slice(0, 64),
            matches: (Array.isArray(s?.matches) ? s.matches : []).slice(0, 8).map((p) => String(p).slice(0, 2048)),
            runAt: typeof s?.runAt === "string" ? s.runAt.slice(0, 32) : null,
            world: typeof s?.world === "string" ? s.world.slice(0, 16) : null,
            jsBytes: Array.isArray(s?.js) ? s.js.reduce((n, j) => n + (typeof j === "string" ? j.length : 0), 0) : 0,
            jsPreview: Array.isArray(s?.js) && typeof s.js[0] === "string" ? s.js[0].slice(0, 256) : "",
          })),
          returned: Math.min(rows.length, maxResults),
          total: rows.length,
          truncated: rows.length > maxResults,
        };
      },
    }),
  };
  // SCOPED (hook) runs are side-effect-free: read_page / capture_screenshot /
  // list_tabs / recent_browser_events are the only tools exposed. open_tab /
  // navigate_tab / close_tab / schedule_task are DURABLE/DESTRUCTIVE and must
  // never be driven by untrusted event data.
  if (readOnly) {
    return wrapToolsetForObservability({
      read_page: all.read_page,
      capture_screenshot: all.capture_screenshot,
      list_tabs: all.list_tabs,
      recent_browser_events: all.recent_browser_events,
      list_windows: all.list_windows,
      get_action_state: all.get_action_state,
      list_commands: all.list_commands,
      list_alarms: all.list_alarms,
      list_bookmarks: all.list_bookmarks,
      query_idle_state: all.query_idle_state,
      list_context_menus: all.list_context_menus,
      list_cookies: all.list_cookies,
      list_cookie_stores: all.list_cookie_stores,
      get_cookie: all.get_cookie,
      get_content_setting: all.get_content_setting,
      // T13 deep tab control reads (observe-only).
      get_tab_zoom: all.get_tab_zoom,
      get_side_panel_options: all.get_side_panel_options,
      // T7 sessions + history reads (observe-only).
      list_recently_closed: all.list_recently_closed,
      list_synced_devices: all.list_synced_devices,
      search_history: all.search_history,
      get_history_visits: all.get_history_visits,
      // Tranche-9 reads: browser-settings inventory is observe-only.
      get_privacy_setting: all.get_privacy_setting,
      get_proxy_settings: all.get_proxy_settings,
      get_font_settings: all.get_font_settings,
      list_tts_voices: all.list_tts_voices,
      tts_is_speaking: all.tts_is_speaking,
      // Tranche-12 reads (observe-only).
      list_user_scripts: all.list_user_scripts,
      list_content_scripts: all.list_content_scripts,
      list_tab_groups: all.list_tab_groups,
      list_downloads: all.list_downloads,
    });
  }
  return wrapToolsetForObservability(all);
}

// ── tool-dispatch observability (CAP-FB-20260826-OBSERVABILITY-01) ─────────
// Wrap every browser tool's execute: entry (debug), duration (perf measure),
// outcome (ok / error / threw). Tool RESULT objects carry `{error}` on failure
// (house pattern) — a denied grant surfaces here as a warn with the reason.
function wrapToolsetForObservability(toolset) {
  for (const [name, def] of Object.entries(toolset)) {
    if (!def || typeof def.execute !== "function" || def.__capObserved) continue;
    const inner = def.execute;
    def.__capObserved = true;
    def.execute = async (args, opts) => {
      const span = perfSpan(`tool:${name}`);
      toolDispatchLog.debug("dispatch", name);
      try {
        const result = await inner(args, opts);
        const failed = result != null && typeof result === "object" && typeof result.error === "string";
        span.end(failed ? "error" : "ok");
        if (failed) toolDispatchLog.warn(name, "→", result.error);
        else toolDispatchLog.debug(name, "→ ok");
        return result;
      } catch (e) {
        span.end("throw");
        toolDispatchLog.error(name, "threw:", e?.message ?? e);
        throw e;
      }
    };
  }
  return toolset;
}

// ── T13 deep tab control (shared grant helper) ──
// Single-tab mutations under the SAME grant discipline as close_tab
// (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01): the tab's origin is
// re-read INSIDE the grant lock, the grant must cover it, durable ownership is
// asserted adjacent to the mutation, and the tab identity is re-read +
// compared IMMEDIATELY before mutating (a navigation since the grant check
// must never apply the mutation to a newly-unauthorized tab — the round-20/21
// close-identity race applied to every deep tab op). The fence is re-checked
// AFTER the await so an abort mid-mutation never reports success.
//
// Origin coverage (aligned with highlight_tabs' corrected coverage semantics
// after the T13 review's mixed-set blocker): a tab whose URL yields no web
// origin (chrome://, about:, url-less — canonicalOrigin returns null) is the
// ORIGIN-LESS class, a browser-level scope authorized ONLY by the GLOBAL
// grant; under an origins-scoped grant it is denied. (Chosen option per the
// review: align with the corrected coverage semantics rather than the
// stricter blanket denial — origin-less single-tab mutations ARE possible,
// but only under a GLOBAL grant.)
function t13OriginClass(tab) {
  let o = null;
  try {
    o = tab?.url ? canonicalOrigin(tab.url) : null;
  } catch {
    o = null;
  }
  return typeof o === "string" ? o : null; // null = the origin-less class
}

async function t13MutateTabWithGrant(tabId, verb, mutate) {
  if (!(await hasTabsPermission())) {
    return permissionDeniedResult("tabs", { reason: "control a tab" });
  }
  return await withGrantLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { error: `no such tab: ${tabId}` };
    const origin = t13OriginClass(tab);
    // null (origin-less) reaches isBrowserControlGranted(undefined-equivalent):
    // a global grant authorizes it, an origins grant never does.
    if (!(await isBrowserControlGranted(origin))) {
      return permissionDenial(
        "browser control not granted for this origin — the owner can approve it in the approval card here, or in Settings → Browser control",
        { reason: origin ? `control a tab on ${origin}` : "control a tab that has no single site (this needs the all-sites browser-control grant)", grantOrigins: origin ? [origin] : [], grantGlobal: !origin },
      );
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tab not ${verb}` };
    }
    // Re-read + compare the tab identity IMMEDIATELY before the mutation.
    // The comparison is over the ORIGIN CLASS (a string origin or the
    // origin-less null): an origin-less tab may only be mutated if it is
    // STILL origin-less, and a web-origin tab only if it is still the SAME
    // origin — any cross-class or cross-origin navigation fails closed.
    const bound = await chrome.tabs.get(tabId).catch(() => null);
    if (!bound || t13OriginClass(bound) !== origin) {
      return { error: `tab navigated before being ${verb} — source identity changed` };
    }
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tab not ${verb}` };
    }
    const result = await mutate();
    try {
      await assertRunOwned();
    } catch {
      return { error: `run aborted — tab ${verb} then aborted` };
    }
    return result;
  });
}

/** Record a browser event into the rolling event log (kept in chrome.storage). */
export async function recordBrowserEvent(kind, payload) {
  const key = "cap:events";
  const stored = await kvGet(key);
  const list = stored[key] ?? [];
  list.unshift({ kind, at: new Date().toISOString(), ...payload });
  await kvSet({ [key]: list.slice(0, 200) });
}

// ── T9 browser settings helpers (CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01,
// Tranche 9: chrome.privacy / proxy / fontSettings / power / search / tts) ──
// Every SET/mutation here is BROWSER-WIDE — it has NO destination origin. Per the
// house grant discipline, a mutation whose target set yields an EMPTY origin set
// may ONLY be authorized by the GLOBAL grant; a per-origin grant can never
// authorize a browser-wide settings change. Reads are light (permission only).
// Optional permissions are requested ON DEMAND via the Settings capability flow —
// the service worker never calls chrome.permissions.request itself.

/** The desktop-available chrome.privacy preferences this toolset can read/set.
 * `kind` gates the value type BEFORE any Chrome call: "boolean" accepts only
 * booleans, "enum" accepts only one of the enumerated strings. */
const PRIVACY_SETTINGS = Object.freeze({
  "network.webRTCIpHandlingPolicy": Object.freeze({
    kind: "enum",
    values: Object.freeze([
      "default",
      "default_public_and_private_interfaces",
      "default_public_interface_only",
      "default_private_interface_only",
      "disable_non_proxied_udp",
    ]),
  }),
  "network.networkPredictionEnabled": Object.freeze({ kind: "boolean" }),
  "services.alternateErrorPagesEnabled": Object.freeze({ kind: "boolean" }),
  "services.autofillAddressEnabled": Object.freeze({ kind: "boolean" }),
  "services.autofillCreditCardEnabled": Object.freeze({ kind: "boolean" }),
  "services.passwordSavingEnabled": Object.freeze({ kind: "boolean" }),
  "services.safeBrowsingEnabled": Object.freeze({ kind: "boolean" }),
  "services.safeBrowsingExtendedReportingEnabled": Object.freeze({ kind: "boolean" }),
  "services.searchSuggestEnabled": Object.freeze({ kind: "boolean" }),
  "services.spellingServiceEnabled": Object.freeze({ kind: "boolean" }),
  "services.translationServiceEnabled": Object.freeze({ kind: "boolean" }),
  "websites.adMeasurementEnabled": Object.freeze({ kind: "boolean" }),
  "websites.doNotTrackEnabled": Object.freeze({ kind: "boolean" }),
  "websites.hyperlinkAuditingEnabled": Object.freeze({ kind: "boolean" }),
  "websites.protectedContentEnabled": Object.freeze({ kind: "boolean" }),
  "websites.referrersEnabled": Object.freeze({ kind: "boolean" }),
  "websites.thirdPartyCookiesAllowed": Object.freeze({ kind: "boolean" }),
});

const PRIVACY_SETTING_NAMES = Object.freeze(Object.keys(PRIVACY_SETTINGS));

/** The generic font families chrome.fontSettings addresses. */
const FONT_GENERIC_FAMILIES = Object.freeze([
  "standard", "sansserif", "serif", "fixed", "cursive", "fantasy",
]);

/** Resolve a `category.name` privacy setting to its live ChromeSetting object,
 * or null when the shape is absent / not a ChromeSetting (fail closed). */
function privacyChromeSetting(settingName) {
  const dot = settingName.indexOf(".");
  if (dot <= 0) return null;
  const category = settingName.slice(0, dot);
  const name = settingName.slice(dot + 1);
  const scope = chrome.privacy?.[category];
  const setting = scope?.[name];
  if (!setting || typeof setting.get !== "function" || typeof setting.set !== "function") return null;
  return setting;
}

/** Validate a privacy value against the setting's kind. Returns null when valid,
 * else a human-readable error (checked BEFORE any grant work or Chrome call). */
function privacyValueError(settingName, value) {
  const spec = PRIVACY_SETTINGS[settingName];
  if (!spec) return "unknown privacy setting";
  if (spec.kind === "boolean") {
    return typeof value === "boolean" ? null : `${settingName} takes a boolean value`;
  }
  if (typeof value !== "string" || !spec.values.includes(value)) {
    return `${settingName} takes one of: ${spec.values.join(", ")}`;
  }
  return null;
}

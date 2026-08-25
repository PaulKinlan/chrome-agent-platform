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

const GRANT_KEY = "cap:browserControlGrant";
const DEFAULT_GRANT_MS = 15 * 60 * 1000; // only used when an EXPLICIT expiryMs is passed

// A GLOBAL grant mutex serializes the grant CHECK with the destructive Chrome
// mutation (open/navigate/close/capture) against revoke. The round-17 blocker
// reproduced a grant being removed immediately after the authorization read, yet
// `tabs.create` still ran: check-then-act across two separate async steps. Holding
// the SAME mutex for the check + the mutation AND for revoke makes them atomic
// w.r.t. each other — either the mutation happens before the revoke (grant was
// valid at mutation time) or the revoke lands first (the mutation's check sees no
// grant and denies).
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

async function hasPermission(perm) {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: [perm] });
  } catch {
    return false;
  }
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
    return {
      error:
        "tabs permission not granted — enable Browser control in Settings",
    };
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
      return {
        error:
          "browser control not granted for every tab origin in this window — ask the user to approve it in Settings",
      };
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
 * extension screenshot API — NOT the Chrome debugger, which cannot be optional
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
      return {
        error: `screenshot is waiting for permission to ${originPattern}`,
        waitingForPermission: true,
        permissionRequirement: {
          tool: "capture_screenshot",
          reason: "Capture the selected tab",
          origins: [originPattern],
        },
      };
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
        return {
          error:
            "browser control not granted for this tab's origin — ask the user to approve it in Settings",
        };
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
      return {
        error:
          "scripting permission not granted — enable Site Agents in Settings",
      };
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
    return results?.[0]?.result ?? { error: "no result" };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** The browser-control toolset, passed into the agent. */
export function browserToolset(readOnly = false) {
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
        if (!(await hasSidePanelPermission())) {
          return {
            error:
              "sidePanel permission not granted — enable it in Settings (Side panel)",
          };
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
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
            return {
              error:
                "browser control not granted for this origin — ask the user to approve it in Settings",
            };
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
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
            return {
              error:
                "browser control not granted for the destination origin — ask the user to approve it in Settings",
            };
          }
          if (!(await isBrowserControlGranted(srcOrigin))) {
            return {
              error:
                "browser control not granted for the source tab's origin — ask the user to approve it in Settings",
            };
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
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
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
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
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
            return {
              error:
                "browser control not granted for this origin — ask the user to approve it in Settings",
            };
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
        "Schedule a future task to run the agent at an absolute time (epoch ms) or after a delay (ms). The task runs even if the browser is idle. Pass scriptId (a script you created with create_script) to run that JS directly on the schedule — no model re-invocation.",
      inputSchema: z.object({
        task: z.string().min(1).max(4000),
        at: z.number().optional(),
        delayMs: z.number().optional(),
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
        // The ONE atomic scheduling path (shared with the register-task route).
        const { name, when } = await scheduleTask({
          task,
          at,
          delayMs,
          periodInMinutes,
          scriptId,
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
        const wins = await chrome.windows.getAll({});
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
        if (!(await hasTabsPermission())) {
          return {
            error:
              "tabs permission not granted — enable Browser control in Settings",
          };
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
            return {
              error:
                "browser control not granted for this origin — ask the user to approve it in Settings",
            };
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
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — action not changed" };
        }
        const applied = [];
        try {
          if (badgeText !== undefined) { await chrome.action.setBadgeText({ text: badgeText }); applied.push("badgeText"); }
          if (badgeColor !== undefined) { await chrome.action.setBadgeBackgroundColor({ color: badgeColor }); applied.push("badgeColor"); }
          if (title !== undefined) { await chrome.action.setTitle({ title }); applied.push("title"); }
          if (iconPath !== undefined) { await chrome.action.setIcon({ path: iconPath }); applied.push("iconPath"); }
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
        const [badgeText, title, bg] = await Promise.all([
          chrome.action.getBadgeText({}),
          chrome.action.getTitle({}),
          chrome.action.getBadgeBackgroundColor({}),
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
        const commands = await chrome.commands.getAll();
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
          return { error: "alarms permission not granted — enable Alarms in Settings" };
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
        await chrome.alarms.create(name, info);
        return { ok: true, name, ...info };
      },
    }),
    list_alarms: tool({
      description:
        "List all scheduled extension alarms (name, scheduledTime, periodInMinutes). Requires alarms permission.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!(await hasPermission("alarms"))) {
          return { error: "alarms permission not granted — enable Alarms in Settings" };
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
          return { error: "alarms permission not granted — enable Alarms in Settings" };
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — alarm not cleared" };
        }
        const cleared = await chrome.alarms.clear(name);
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
          return { error: "bookmarks permission not granted — enable Bookmarks in Settings" };
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
          return { error: "bookmarks permission not granted — enable Bookmarks in Settings" };
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
          return { error: "bookmarks permission not granted — enable Bookmarks in Settings" };
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
          return { error: "notifications permission not granted — enable Notifications in Settings" };
        }
        try {
          await assertRunOwned();
        } catch {
          return { error: "run aborted — notification not sent" };
        }
        const defaultIcon = typeof chrome !== "undefined" && chrome.runtime?.getURL
          ? chrome.runtime.getURL("icons/icon-128.png")
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
          return { error: "notifications permission not granted — enable Notifications in Settings" };
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
          return { error: "idle permission not granted — enable Idle in Settings" };
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
          return { error: "contextMenus permission not granted — enable Context menus in Settings" };
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
          return { error: "contextMenus permission not granted — enable Context menus in Settings" };
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
          return { error: "contextMenus permission not granted — enable Context menus in Settings" };
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
          return { error: "tabs permission not granted — enable Browser control in Settings" };
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
          return { error: "tabs permission not granted — enable Browser control in Settings" };
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
            return {
              error:
                "browser control not granted for every highlighted tab's origin — ask the user to approve it in Settings",
            };
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
          return { error: "sidePanel permission not granted — enable it in Settings (Side panel)" };
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
          return { error: "sidePanel permission not granted — enable it in Settings (Side panel)" };
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
            return {
              error:
                "browser control not granted (global) — ask the user to approve it in Settings",
            };
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
          return { error: "sidePanel permission not granted — enable it in Settings (Side panel)" };
        }
        return await withGrantLock(async () => {
          if (!(await isBrowserControlGranted(undefined))) {
            return {
              error:
                "browser control not granted (global) — ask the user to approve it in Settings",
            };
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
  };
  // SCOPED (hook) runs are side-effect-free: read_page / capture_screenshot /
  // list_tabs / recent_browser_events are the only tools exposed. open_tab /
  // navigate_tab / close_tab / schedule_task are DURABLE/DESTRUCTIVE and must
  // never be driven by untrusted event data.
  if (readOnly) {
    return {
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
      // T13 deep tab control reads (observe-only).
      get_tab_zoom: all.get_tab_zoom,
      get_side_panel_options: all.get_side_panel_options,
    };
  }
  return all;
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
    return {
      error:
        "tabs permission not granted — enable Browser control in Settings",
    };
  }
  return await withGrantLock(async () => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { error: `no such tab: ${tabId}` };
    const origin = t13OriginClass(tab);
    // null (origin-less) reaches isBrowserControlGranted(undefined-equivalent):
    // a global grant authorizes it, an origins grant never does.
    if (!(await isBrowserControlGranted(origin))) {
      return {
        error:
          "browser control not granted for this origin — ask the user to approve it in Settings",
      };
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

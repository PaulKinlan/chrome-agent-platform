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
const DEFAULT_GRANT_MS = 15 * 60 * 1000; // 15-minute scope — re-confirm after expiry

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
export async function isBrowserControlGranted(origin) {
  const s = await kvGet(GRANT_KEY);
  const grant = s[GRANT_KEY];
  if (!grant || typeof grant !== "object") return false;
  if (
    typeof grant.expiresAt !== "number" || !Number.isFinite(grant.expiresAt)
  ) return false;
  if (grant.expiresAt <= Date.now()) return false;
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
  expiryMs = DEFAULT_GRANT_MS,
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
      expiresAt: Date.now() + clampExpiryMs(expiryMs),
      grantedAt: Date.now(),
    };
    await kvSet({ [GRANT_KEY]: grant });
    return grant;
  });
}

export async function setOriginBrowserControlGrant(
  origins,
  expiryMs = DEFAULT_GRANT_MS,
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
      expiresAt: Date.now() + clampExpiryMs(expiryMs),
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

/** Whether the OPTIONAL `tabs` permission is currently granted (the broader
 * open/navigate/close/list controls). Screenshot capture uses the SILENT
 * `activeTab` permission instead (see hasActiveTabPermission) — the same
 * permission the reference screenshot tool uses, grantable from a user gesture
 * with no warning. */
async function hasTabsPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["tabs"] });
  } catch {
    return false;
  }
}

/** Whether the OPTIONAL `activeTab` permission is granted (screenshot capture).
 * `activeTab` is SILENT (no warning) so it grants from the Settings gesture even
 * in headless; it authorizes captureVisibleTab of the active tab. */
async function hasActiveTabPermission() {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions) return false;
    return await chrome.permissions.contains({ permissions: ["activeTab"] });
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
  if (
    typeof grant.expiresAt !== "number" || !Number.isFinite(grant.expiresAt)
  ) return null;
  if (grant.expiresAt <= Date.now()) return null;
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
 * and carries Chrome's all-sites warning) with the SILENT `activeTab` permission
 * (the same permission the reference screenshot tool uses).
 *
 * `activeTab` authorizes the ACTIVE tab, so capture semantics are: if a tabId
 * is supplied, that tab is ACTIVATED first (chrome.tabs.update needs no
 * permission for {active:true}); the now-active tab's url is read via
 * chrome.tabs.query({active:true}) (url is visible under activeTab) and its
 * origin is grant-checked. The active-tab ABA window is closed by re-deriving +
 * re-checking the origin AND the grant identity before AND after the capture,
 * under a per-tab mutex.
 *
 * Requires the OPTIONAL `activeTab` permission (requested from the Settings
 * browser-control toggle / Screenshots capability). Fail closed when absent.
 */
export async function captureTabScreenshot(tabId) {
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
  if (!(await hasActiveTabPermission()) && !(await hasTabsPermission())) {
    return {
      error:
        "activeTab permission not granted — enable Screenshots in Settings to allow captures",
    };
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
        error:
          "cannot read the tab's URL — capture requires the tab to be authorized (in a headed browser, invoke the extension on the page you are viewing; activeTab is transient and headless cannot grant it for an arbitrary tab)",
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
          "scripting permission not granted — enable Site agents in Settings",
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
export function browserToolset() {
  return {
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
        "Schedule a future task to run the agent at an absolute time (epoch ms) or after a delay (ms). The task runs even if the browser is idle.",
      inputSchema: z.object({
        task: z.string().min(1).max(4000),
        at: z.number().optional(),
        delayMs: z.number().optional(),
        periodInMinutes: z.number().optional(),
      }),
      execute: async ({ task, at, delayMs, periodInMinutes }) => {
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
        });
        return { ok: true, name, when };
      },
    }),
  };
}

/** Record a browser event into the rolling event log (kept in chrome.storage). */
export async function recordBrowserEvent(kind, payload) {
  const key = "cap:events";
  const stored = await kvGet(key);
  const list = stored[key] ?? [];
  list.unshift({ kind, at: new Date().toISOString(), ...payload });
  await kvSet({ [key]: list.slice(0, 200) });
}

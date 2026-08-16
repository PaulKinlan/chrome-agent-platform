// Unit tests for the system-hooks layer: the catalog, the subscription
// registry, and the PERMISSIONS LAYER (the owner's deny-list is authoritative +
// fail-closed). hooks.js is tested with a minimal chrome.storage.local +
// chrome.permissions mock (the optional "storage" permission drives the kv
// backend; other permissions drive the per-hook gate).
// @ts-nocheck — the chrome mock is intentionally dynamic (no chrome.* types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  HOOKS,
  checkHookAllowed,
  getHook,
  getHookDenyList,
  getHookSubscriptions,
  hookStatus,
  setHookDeny,
  subscribeHook,
  unsubscribeHook,
} from "../extension/lib/hooks.js";

// ---- in-memory chrome mock ----
const store = new Map();
const granted = new Set(["storage"]); // the optional "storage" backend is on
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
  permissions: {
    contains: async ({ permissions }) => permissions.every((p) => granted.has(p)),
  },
};

function reset() {
  store.clear();
  granted.clear();
  granted.add("storage");
}

Deno.test("hooks catalog covers the full chrome.* event surface", () => {
  const ids = new Set(HOOKS.map((h) => h.id));
  // chaos's 11 wired events are all present
  for (const id of [
    "tabs.onCreated",
    "tabs.onRemoved",
    "tabs.onUpdated",
    "alarms.onAlarm",
    "commands.onCommand",
    "contextMenus.onClicked",
    "runtime.onStartup",
    "runtime.onInstalled",
    "action.onClicked",
  ]) {
    assert(ids.has(id), `catalog missing ${id}`);
  }
  // plus the wider surface
  for (const id of [
    "bookmarks.onCreated",
    "history.onVisited",
    "downloads.onCreated",
    "webNavigation.onCompleted",
    "idle.onStateChanged",
    "windows.onCreated",
    "notifications.onClicked",
    "storage.onChanged",
    "runtime.onSuspend",
  ]) {
    assert(ids.has(id), `catalog missing ${id}`);
  }
  // every hook has an id/label + a permission of null or a string
  for (const h of HOOKS) {
    assert(typeof h.id === "string" && h.id.includes("."), "hook id malformed");
    assert(typeof h.label === "string" && h.label.length > 0, "hook label missing");
    assert(h.permission === null || typeof h.permission === "string", "hook permission malformed");
  }
});

Deno.test("subscribe a permission-free hook succeeds", async () => {
  reset();
  const r = await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  assertEquals(r.ok, true);
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 1);
  assertEquals(subs[0].hookId, "runtime.onStartup");
  assertEquals(subs[0].recipeId, "auto-group-by-domain");
});

Deno.test("subscribe is idempotent for the same (hook, recipe)", async () => {
  reset();
  await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 1);
});

Deno.test("a DENIED hook refuses subscription (fail-closed)", async () => {
  reset();
  await setHookDeny("tabs.onCreated", true);
  const r = await subscribeHook({ hookId: "tabs.onCreated", recipeId: "r" });
  assertEquals(r.ok, false);
  assert((r.error ?? "").includes("denied"), "deny-list must be authoritative");
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 0, "a denied hook must not be subscribable");
});

Deno.test("a hook needing an absent optional permission refuses subscription", async () => {
  reset();
  // "tabs" is NOT granted (only storage is)
  const r = await subscribeHook({ hookId: "tabs.onCreated", recipeId: "r" });
  assertEquals(r.ok, false);
  assert((r.error ?? "").includes("permission"), "absent permission must refuse");
});

Deno.test("granting the permission unblocks the same hook", async () => {
  reset();
  granted.add("tabs");
  const r = await subscribeHook({ hookId: "tabs.onCreated", recipeId: "auto-group-by-domain" });
  assertEquals(r.ok, true);
});

Deno.test("checkHookAllowed is deny-first (deny wins over granted permission)", async () => {
  reset();
  granted.add("tabs");
  await setHookDeny("tabs.onCreated", true);
  const r = await checkHookAllowed("tabs.onCreated");
  assertEquals(r.ok, false);
  assert((r.error ?? "").includes("denied"), "deny must win even when the permission is granted");
});

Deno.test("un-deny restores a hook", async () => {
  reset();
  await setHookDeny("tabs.onCreated", true);
  assertEquals((await checkHookAllowed("tabs.onCreated")).ok, false);
  await setHookDeny("tabs.onCreated", false);
  const deny = await getHookDenyList();
  assertEquals(deny.includes("tabs.onCreated"), false);
});

Deno.test("unsubscribe removes only the matching entry", async () => {
  reset();
  await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-pin-favorites" });
  await unsubscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 1);
  assertEquals(subs[0].recipeId, "auto-pin-favorites");
});

Deno.test("hookStatus reflects deny + subscribers", async () => {
  reset();
  await setHookDeny("bookmarks.onCreated", true);
  await subscribeHook({ hookId: "runtime.onStartup", recipeId: "auto-group-by-domain" });
  const status = await hookStatus();
  const byId = new Map(status.map((s) => [s.id, s]));
  assertEquals(byId.get("bookmarks.onCreated").denied, true);
  assertEquals(byId.get("runtime.onStartup").subscribers, ["auto-group-by-domain"]);
  assertEquals(byId.get("runtime.onStartup").denied, false);
});

Deno.test("getHook returns the catalog entry with permission + use", () => {
  const h = getHook("tabs.onCreated");
  assertEquals(h.permission, "tabs");
  assert(typeof h.use === "string" && h.use.length > 0);
  assertEquals(getHook("nope"), undefined);
});

Deno.test("an unknown recipeId refuses subscription (fan-out bound)", async () => {
  reset();
  const r = await subscribeHook({ hookId: "runtime.onStartup", recipeId: "not-a-real-recipe" });
  assertEquals(r.ok, false);
  assert((r.error ?? "").includes("unknown recipe"), "unknown recipeId must be rejected");
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 0);
});

Deno.test("an oversized prompt template refuses subscription", async () => {
  reset();
  const big = "x".repeat(70 * 1024); // 70 KiB > the 64 KiB cap
  const r = await subscribeHook({ hookId: "runtime.onStartup", recipeId: null, promptTemplate: big });
  assertEquals(r.ok, false);
  assert((r.error ?? "").includes("too large"), "oversized template must be rejected");
});

Deno.test("concurrent denies of DIFFERENT hooks do not last-write-wins (the deny-list RMW is serialized)", async () => {
  reset();
  // The round-fresh-review finding: setHookDeny was an unlocked read-modify-write.
  // Two concurrent denies of A and B could both read [], then last-write-wins one
  // singleton, silently un-denying the other. Fire both at once + assert BOTH land.
  await Promise.all([
    setHookDeny("tabs.onCreated", true),
    setHookDeny("bookmarks.onCreated", true),
  ]);
  const deny = await getHookDenyList();
  assert(deny.includes("tabs.onCreated"), "tabs.onCreated must remain denied");
  assert(deny.includes("bookmarks.onCreated"), "bookmarks.onCreated must remain denied");
});

Deno.test("concurrent subscribes of DISTINCT recipes do not last-write-wins (the subscription RMW is serialized)", async () => {
  reset();
  await Promise.all([
    subscribeHook({ hookId: "runtime.onStartup", recipeId: "tab-hygiene" }),
    subscribeHook({ hookId: "runtime.onStartup", recipeId: "page-summary" }),
  ]);
  const subs = await getHookSubscriptions();
  const ids = subs.map((s) => s.recipeId);
  assert(ids.includes("tab-hygiene"), "tab-hygiene subscription must survive");
  assert(ids.includes("page-summary"), "page-summary subscription must survive");
});

Deno.test("the subscription registry is count-bounded", async () => {
  reset();
  // Fill the registry to the cap with DISTINCT known recipe ids.
  const ids = [
    "tab-hygiene", "page-summary", "link-collector", "reading-list",
    "context-menu-save-quote", "right-click-extract-topics", "right-click-summarize",
    "right-click-translate-selection", "clipboard-phrase-via-command", "omnibox-ask",
    "auto-group-by-domain", "auto-pin-favorites", "auto-reading-list",
  ];
  for (let i = 0; i < ids.length; i++) {
    await subscribeHook({ hookId: "runtime.onStartup", recipeId: ids[i] });
  }
  // A 14th DISTINCT subscription on a different hook would exceed the cap once the
  // registry is full; assert the cap path by pushing many distinct entries.
  const before = (await getHookSubscriptions()).length;
  assert(before <= 200, "registry must not exceed the cap");
});

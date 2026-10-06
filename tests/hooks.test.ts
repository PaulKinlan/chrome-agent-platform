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
  // the 11 baseline wired events are all present
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
  assertEquals(subs[0].skillId, "auto-group-by-domain");
});

Deno.test("subscribe is idempotent for the same (hook, skill)", async () => {
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
  assertEquals(subs[0].skillId, "auto-pin-favorites");
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
  assert((r.error ?? "").includes("unknown skill"), "unknown recipeId must be rejected");
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, 0);
});

Deno.test("51cd: a prompt template past the 64 KiB bound is REFUSED and writes nothing (was: stored whole, dptw)", async () => {
  reset();
  // ACCEPTED CONSEQUENCE CHANGE (chrome-agent-platform-51cd). OLD BEHAVIOUR: this test asserted that a
  // 256 KiB template was stored WHOLE - the dptw "size/count are not the guard" policy, on the premise that
  // a subscription was not model-authorable. WHY THAT WAS WRONG: the template IS model-authorable through
  // subscribe_hook, it is later executed verbatim in the INSTRUCTION position, and it re-runs on every
  // matching event up to the 50-run fan-out cap - so an unbounded template is a storage-quota and
  // token-cost amplifier, not just a big string. THE BOUND: 64 KiB (hooks.js MAX_PROMPT_TEMPLATE_CHARS),
  // the cap this repo enforced before dptw and already ~16k tokens of instruction.
  const big = "x".repeat(64 * 1024 + 1);
  const r = await subscribeHook({ hookId: "runtime.onStartup", recipeId: null, promptTemplate: big });
  assertEquals(r.ok, false, "a template past the bound is refused");
  assert(String(r.error).includes("too large"), `the refusal must name the bound: ${r.error}`);
  assertEquals((await getHookSubscriptions()).length, 0, "a refused subscribe must write nothing");
  // The BOUNDARY still stores whole: the cap is a cap, not a truncation.
  const atBound = "y".repeat(64 * 1024);
  const ok = await subscribeHook({ hookId: "runtime.onStartup", recipeId: null, promptTemplate: atBound });
  assertEquals(ok.ok, true, "a template AT the bound is accepted");
  const [saved] = await getHookSubscriptions();
  assertEquals(saved.promptTemplate.length, atBound.length, "a template at the bound is stored whole, not truncated");
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

Deno.test("concurrent subscribes of DISTINCT skills do not last-write-wins (the subscription RMW is serialized)", async () => {
  reset();
  await Promise.all([
    subscribeHook({ hookId: "runtime.onStartup", recipeId: "tab-hygiene" }),
    subscribeHook({ hookId: "runtime.onStartup", recipeId: "page-summary" }),
  ]);
  const subs = await getHookSubscriptions();
  const ids = subs.map((s) => s.skillId);
  assert(ids.includes("tab-hygiene"), "tab-hygiene subscription must survive");
  assert(ids.includes("page-summary"), "page-summary subscription must survive");
});

Deno.test("51cd: concurrent same-key FIRST subscriptions are BOTH gated (was: only the second one was)", async () => {
  reset();
  // ACCEPTED CONSEQUENCE CHANGE (chrome-agent-platform-51cd). OLD BEHAVIOUR: the seam ran only when a row
  // already existed, so the FIRST of these two calls was an ungated CREATE (gates === 1) and one
  // subscription landed. The seam now runs for EVERY subscribe - { existing: null } on create - so both
  // calls are gated and neither lands until the owner approves. The test's INTENT ("a concurrent first
  // subscribe can never produce an UNGATED replacement") is preserved and strengthened: the ungated
  // create path no longer exists at all.
  let gates = 0;
  const gate = async () => { gates += 1; return { ok: false, error: "owner approval required" }; };
  const [a, b] = await Promise.all([
    subscribeHook({ hookId: "runtime.onStartup", recipeId: "tab-hygiene", promptTemplate: "first" }, { gate }),
    subscribeHook({ hookId: "runtime.onStartup", recipeId: "tab-hygiene", promptTemplate: "second" }, { gate }),
  ]);
  assertEquals(gates, 2, "EVERY subscribe is gated, including the first and a concurrent one");
  assertEquals([a.ok, b.ok].filter(Boolean).length, 0, "neither subscription lands without approval");
  assertEquals((await getHookSubscriptions()).length, 0, "a denied gate writes nothing");
});

Deno.test("the subscription registry has no count cap (dptw): 208 distinct subscriptions all land", async () => {
  reset();
  // DISTINCT (hook, skill) pairs: 13 known skills × 16 hooks = 208 — past
  // the old 200-subscription cap.
  const ids = [
    "tab-hygiene", "page-summary", "link-collector", "reading-list",
    "context-menu-save-quote", "right-click-extract-topics", "right-click-summarize",
    "right-click-translate-selection", "clipboard-phrase-via-command", "omnibox-ask",
    "auto-group-by-domain", "auto-pin-favorites", "auto-reading-list",
  ];
  const hooks = HOOKS.slice(0, 16).map((h) => h.id);
  // Grant every hook's optional permission so the gate lets them through.
  for (const h of HOOKS.slice(0, 16)) if (h.permission) granted.add(h.permission);
  for (const hookId of hooks) {
    for (const recipeId of ids) {
      const r = await subscribeHook({ hookId, recipeId });
      assertEquals(r.ok, true, `subscription ${hookId}/${recipeId} lands`);
    }
  }
  const subs = await getHookSubscriptions();
  assertEquals(subs.length, ids.length * hooks.length, "every distinct subscription is stored — no 200 cap");
});

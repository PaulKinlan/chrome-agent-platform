// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 10 (network rules:
// declarativeNetRequest dynamic rules + webNavigation frame reads + MV3
// non-blocking webRequest observation): GLOBAL-grant-only for all rule
// mutations (network rules are browser-wide — an origin grant is never
// enough), regexFilter constructibility validation BEFORE the API, the
// ≤100 dynamic-rule cap, bounded reads, and honest permission denials.
// In-memory chrome shim extended from chrome-tools-t8.test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  recordRequestActivity,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import {
  BROWSER_TOOL_NAMES,
  CHROME_TOOL_CAPABILITY_TABLE,
  chromeToolCapability,
} from "../extension/lib/chrome-tool-capabilities.js";
import { replaySafetyForTool } from "../extension/lib/tool-replay-safety.js";

// ---- in-memory chrome shim ----
const store = new Map();
const grantedPermissions = new Set(["storage", "tabs"]);
let dynamicRules = []; // { id, priority, action, condition }
const dnrCalls = []; // records declarativeNetRequest calls for "never reached" assertions
const framesByTab = new Map(); // tabId -> [{ frameId, parentFrameId, url }]

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedPermissions.add("storage");
  grantedPermissions.add("tabs");
  dynamicRules = [];
  dnrCalls.length = 0;
  framesByTab.clear();
  clearRunFence();
}

globalThis.chrome = {
  permissions: {
    contains: async (q) =>
      Boolean(q?.permissions) && q.permissions.every((p) => grantedPermissions.has(p)),
  },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
  declarativeNetRequest: {
    getDynamicRules: async () => {
      dnrCalls.push(["getDynamicRules"]);
      return dynamicRules;
    },
    updateDynamicRules: async ({ addRules = [], removeRuleIds = [] } = {}) => {
      dnrCalls.push(["updateDynamicRules", { addRules, removeRuleIds }]);
      dynamicRules = dynamicRules.filter((r) => !removeRuleIds.includes(r.id));
      for (const r of addRules) dynamicRules.push(r);
    },
    testMatchOutcome: async (request) => {
      dnrCalls.push(["testMatchOutcome", request]);
      const matchedRules = dynamicRules
        .filter((r) => r?.condition?.urlFilter && request?.url?.includes(r.condition.urlFilter))
        .map((rule) => ({ rule }));
      return { matchedRules };
    },
  },
  webNavigation: {
    getAllFrames: async ({ tabId }) => {
      if (!framesByTab.has(tabId)) throw new Error("no such tab");
      return framesByTab.get(tabId);
    },
    getFrame: async ({ tabId, frameId }) => {
      if (!framesByTab.has(tabId)) throw new Error("no such tab");
      return framesByTab.get(tabId).find((f) => f.frameId === frameId) ?? null;
    },
  },
};

function tools() {
  return browserToolset(false);
}

const RULE_INPUT = {
  id: 7,
  action: "block",
  urlFilter: "||ads.example",
};

// ──────────────────────────────────────────────────────────────────────────
// Registry parity slice: the 8 T10 tools exist, are named, and classified.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T10: the 8 tools are present and truthfully classified", () => {
  reset();
  const browser = tools();
  const names = [
    "list_network_rules", "add_network_rule", "update_network_rule",
    "remove_network_rule", "get_network_rule_matches", "get_navigation_frames",
    "get_navigation_frame", "get_request_activity",
  ];
  for (const name of names) {
    assert(name in browser, `${name} present in toolset`);
    assert(BROWSER_TOOL_NAMES.includes(name), `${name} in BROWSER_TOOL_NAMES`);
  }
  assertEquals(Object.keys(browser).length, 126);
  for (const read of ["list_network_rules", "get_network_rule_matches", "get_navigation_frames", "get_navigation_frame", "get_request_activity"]) {
    assertEquals(replaySafetyForTool(read), "read-only", `${read} read-only`);
    assertEquals(chromeToolCapability(read, "chrome-api").mutationClass, "read");
  }
  for (const mut of ["add_network_rule", "update_network_rule", "remove_network_rule"]) {
    assertEquals(replaySafetyForTool(mut), "mutating", `${mut} mutating`);
    assertEquals(chromeToolCapability(mut, "chrome-api").productGrantScopeKind, "global");
    assertEquals(chromeToolCapability(mut, "chrome-api").mutationClass, "mutating");
  }
  // permission lists are exact
  assertEquals(chromeToolCapability("add_network_rule", "chrome-api").optionalPermissions, ["declarativeNetRequest"]);
  assertEquals(chromeToolCapability("get_navigation_frames", "chrome-api").optionalPermissions, ["webNavigation"]);
  assertEquals(chromeToolCapability("get_request_activity", "chrome-api").optionalPermissions, ["webRequest"]);
  assertEquals(CHROME_TOOL_CAPABILITY_TABLE.length, 160);
});

// ──────────────────────────────────────────────────────────────────────────
// Grant discipline: ALL rule mutations are browser-wide → GLOBAL grant only.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T10 add_network_rule: denied without a grant; an ORIGIN grant is NEVER enough; global works", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");

  // no grant at all
  let r = await tools().add_network_rule.execute(RULE_INPUT);
  assert(r.error && r.error.includes("browser control not granted"), "no-grant refused");
  assertEquals(dnrCalls.filter((c) => c[0] === "updateDynamicRules").length, 0);

  // origin grant — never enough for browser-wide rules
  await setOriginBrowserControlGrant(["https://ads.example"]);
  r = await tools().add_network_rule.execute(RULE_INPUT);
  assert(r.error && r.error.includes("browser control not granted"), "origin grant refused");
  assertEquals(dnrCalls.filter((c) => c[0] === "updateDynamicRules").length, 0);

  // global grant — allowed
  await setGlobalBrowserControlGrant();
  r = await tools().add_network_rule.execute(RULE_INPUT);
  assertEquals(r.ok, true);
  assertEquals(r.rule.id, 7);
  assertEquals(dynamicRules.length, 1);
  await revokeBrowserControlGrant();
});

Deno.test("T10 update/remove rules: GLOBAL-grant-only + honest targets", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  dynamicRules = [{ id: 3, priority: 1, action: { type: "block" }, condition: { urlFilter: "x" } }];
  await setGlobalBrowserControlGrant();

  // update a missing rule
  let r = await tools().update_network_rule.execute({ ruleId: 99, action: "block", urlFilter: "y" });
  assert(r.error && r.error.includes("no dynamic rule"), "missing rule refused");

  // update the real rule
  r = await tools().update_network_rule.execute({ ruleId: 3, action: "allow", urlFilter: "y" });
  assertEquals(r.ok, true);
  assertEquals(dynamicRules[0].action.type, "allow");

  // remove
  r = await tools().remove_network_rule.execute({ ruleIds: [3] });
  assertEquals(r.ok, true);
  assertEquals(dynamicRules.length, 0);

  // remove under an ORIGIN grant is refused
  await setOriginBrowserControlGrant(["https://x.example"]);
  r = await tools().remove_network_rule.execute({ ruleIds: [1] });
  assert(r.error && r.error.includes("browser control not granted"));
  await revokeBrowserControlGrant();
});

// ──────────────────────────────────────────────────────────────────────────
// Rule-shape validation BEFORE any Chrome call.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T10 add_network_rule: invalid regexFilter refused BEFORE the API", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  await setGlobalBrowserControlGrant();
  const r = await tools().add_network_rule.execute({
    id: 9, action: "block", regexFilter: "([unclosed",
  });
  assert(r.error && r.error.includes("constructible"), "invalid regex refused");
  assertEquals(dnrCalls.filter((c) => c[0] === "updateDynamicRules").length, 0, "API never reached");
  await revokeBrowserControlGrant();
});

Deno.test("T10 add_network_rule: needs urlFilter or regexFilter; redirect needs http/https url; modifyHeaders unsupported", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  await setGlobalBrowserControlGrant();

  let r = await tools().add_network_rule.execute({ id: 1, action: "block" });
  assert(r.error && r.error.includes("urlFilter or a regexFilter"));

  r = await tools().add_network_rule.execute({ id: 2, action: "redirect", urlFilter: "x", redirectUrl: "javascript:alert(1)" });
  assert(r.error && r.error.includes("http/https only"));

  r = await tools().add_network_rule.execute({ id: 3, action: "modifyHeaders", urlFilter: "x" });
  assert(r.error && r.error.includes("modifyHeaders is not supported"));

  assertEquals(dnrCalls.filter((c) => c[0] === "updateDynamicRules").length, 0, "API never reached");
  await revokeBrowserControlGrant();
});

Deno.test("T10 add_network_rule: duplicate id + the 100-rule cap refuse honestly", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  await setGlobalBrowserControlGrant();

  await tools().add_network_rule.execute(RULE_INPUT);
  const dup = await tools().add_network_rule.execute(RULE_INPUT);
  assert(dup.error && dup.error.includes("already exists"), "duplicate id refused");

  // fill to the cap
  dynamicRules = Array.from({ length: 100 }, (_, i) => ({
    id: i + 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "x" },
  }));
  const callsBefore = dnrCalls.filter((c) => c[0] === "updateDynamicRules").length;
  const over = await tools().add_network_rule.execute({ id: 500, action: "block", urlFilter: "z" });
  assert(over.error && over.error.includes("cap reached"), "over-cap refused");
  assertEquals(dnrCalls.filter((c) => c[0] === "updateDynamicRules").length, callsBefore, "cap refusal never reached the API");
  await revokeBrowserControlGrant();
});

// ──────────────────────────────────────────────────────────────────────────
// Reads: bounded + permission-gated + honest.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T10 reads: honest permission denials (SW never requests)", async () => {
  reset(); // permissions NOT granted
  const browser = tools();
  for (const [name, args] of [
    ["list_network_rules", {}],
    ["get_network_rule_matches", { url: "https://a.example/x" }],
    ["get_navigation_frames", { tabId: 1 }],
    ["get_navigation_frame", { tabId: 1, frameId: 0 }],
    ["get_request_activity", {}],
  ]) {
    const r = await browser[name].execute(args);
    assert(typeof r.error === "string" && r.error.includes("permission not granted"), `${name} honest denial`);
    assert(r.error.includes("Settings"), `${name} points to Settings`);
  }
});

Deno.test("T10 list_network_rules: bounded output with totals", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  dynamicRules = Array.from({ length: 150 }, (_, i) => ({
    id: i + 1, priority: 1, action: { type: "block" },
    condition: { urlFilter: "x".repeat(600) },
  }));
  const r = await tools().list_network_rules.execute({});
  assertEquals(r.returned, 100);
  assertEquals(r.total, 150);
  assertEquals(r.truncated, true);
  assert(r.rules[0].urlFilter.length <= 500, "urlFilter capped");
});

Deno.test("T10 get_network_rule_matches: http/https only, bounded", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  dynamicRules = [{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "ads.example" } }];

  const bad = await tools().get_network_rule_matches.execute({ url: "chrome://settings" });
  assert(bad.error && bad.error.includes("http/https"));
  assertEquals(dnrCalls.filter((c) => c[0] === "testMatchOutcome").length, 0);

  const ok = await tools().get_network_rule_matches.execute({ url: "https://ads.example/x" });
  assertEquals(ok.total, 1);
  assertEquals(ok.matchedRules[0].ruleId, 1);
});

Deno.test("T10 navigation frame reads: bounded + honest errors", async () => {
  reset();
  grantedPermissions.add("webNavigation");
  framesByTab.set(5, Array.from({ length: 150 }, (_, i) => ({
    frameId: i, parentFrameId: 0, url: "https://f.example/" + i,
  })));

  const missing = await tools().get_navigation_frames.execute({ tabId: 999 });
  assert(missing.error && missing.error.includes("frame list failed"));

  const all = await tools().get_navigation_frames.execute({ tabId: 5 });
  assertEquals(all.returned, 100);
  assertEquals(all.total, 150);

  const one = await tools().get_navigation_frame.execute({ tabId: 5, frameId: 3 });
  assertEquals(one.frame.frameId, 3);
  const none = await tools().get_navigation_frame.execute({ tabId: 5, frameId: 9999 });
  assert(none.error && none.error.includes("no such frame"));
});

Deno.test("T10 get_request_activity: ring-buffer bounded + filters", async () => {
  reset();
  grantedPermissions.add("webRequest");
  // seed 150 events through the exported recorder (the SW feeds it)
  for (let i = 0; i < 150; i++) {
    await recordRequestActivity({ phase: i % 2 ? "completed" : "started", requestId: i, tabId: i % 3, url: `https://r.example/${i}` });
  }
  const stored = store.get("cap:requestActivity");
  assertEquals(stored.length, 100, "ring buffer caps at 100 entries");

  const r = await tools().get_request_activity.execute({});
  assertEquals(r.returned, 50, "default maxResults 50");
  assertEquals(r.total, 100);
  assert(r.note.includes("host grants"), "host-scoping disclosed");

  const started = await tools().get_request_activity.execute({ phase: "started", maxResults: 100 });
  assert(started.requests.every((q) => q.phase === "started"), "phase filter");
  const byTab = await tools().get_request_activity.execute({ tabId: 1, maxResults: 100 });
  assert(byTab.requests.every((q) => q.tabId === 1), "tabId filter");
});

// ──────────────────────────────────────────────────────────────────────────
// Mutation fence: an aborted run cannot commit a rule change.
// ──────────────────────────────────────────────────────────────────────────
Deno.test("T10 add_network_rule: run-fence blocks the mutation", async () => {
  reset();
  grantedPermissions.add("declarativeNetRequest");
  await setGlobalBrowserControlGrant();
  const { setRunFence } = await import("../extension/lib/run-fence.js");
  setRunFence({ signal: { aborted: true } });
  const r = await tools().add_network_rule.execute(RULE_INPUT);
  assert(r.error && r.error.includes("aborted"), "fenced mutation refused");
  assertEquals(dnrCalls.filter((c) => c[0] === "updateDynamicRules").length, 0);
  clearRunFence();
  await revokeBrowserControlGrant();
});

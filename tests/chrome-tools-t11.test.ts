// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 11 (extension/
// browser management: chrome.management + chrome.runtime + chrome.sidePanel +
// chrome.action): schema bounds, permission fail-closed, GLOBAL-grant-only
// discipline for every mutation (browser-wide / own-surface — an origin grant
// must NEVER authorize them), self-extension protection (never toggle or
// uninstall THIS extension), confirm-required uninstall, bounded reads with
// honest denials, and side-panel path confinement (traversal/absolute/scheme/
// %-encoded refused). In-memory chrome shim extended from chrome-tools-t8.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim ----
const SELF_ID = "self-extension-id-123";
const store = new Map();
const grantedPermissions = new Set(["storage", "tabs"]);
const extensions = [
  { id: SELF_ID, name: "This Extension", version: "0.2.279", enabled: true, type: "extension", isApp: false, installType: "development", mayDisable: false, mayEnable: true },
  { id: "other-extension-id", name: "Some Other Extension", version: "1.0.0", enabled: true, type: "extension", isApp: false, installType: "chrome_web_store", mayDisable: true, mayEnable: true, permissions: ["tabs"], hostPermissions: ["https://example.com/*"], homepageUrl: "https://example.com", optionsUrl: "chrome-extension://other-extension-id/options.html", description: "A third-party extension", shortName: "Other" },
  { id: "disabled-app-id", name: "A Disabled App", version: "2.0.0", enabled: false, type: "hosted_app", isApp: true, installType: "admin", mayDisable: true, mayEnable: true },
];
const enabledState = new Map(); // id -> last setEnabled value
const uninstalled = []; // ids uninstalled
const panelOptions = { path: "sidepanel/sidepanel.html", enabled: true };
const panelBehavior = { openPanelOnActionClick: false };
const actionState = { enabled: true };
const sidePanelSetCalls = [];
const chromeCalls = []; // records sensitive chrome calls for "never reached" assertions

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedPermissions.add("storage");
  grantedPermissions.add("tabs");
  enabledState.clear();
  uninstalled.length = 0;
  panelOptions.path = "sidepanel/sidepanel.html";
  panelOptions.enabled = true;
  panelBehavior.openPanelOnActionClick = false;
  actionState.enabled = true;
  sidePanelSetCalls.length = 0;
  chromeCalls.length = 0;
  clearRunFence();
}

globalThis.chrome = {
  permissions: {
    contains: async (q) => {
      if (q?.permissions && !q.permissions.every((p) => grantedPermissions.has(p))) return false;
      return true;
    },
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
  runtime: {
    id: SELF_ID,
    getURL: (p) => `chrome-extension://${SELF_ID}/${p ?? ""}`,
    getPlatformInfo: async () => ({ os: "linux", arch: "x86-64", nacl_arch: "x86-64" }),
    getManifest: () => ({
      name: "This Extension",
      version: "0.2.279",
      manifest_version: 3,
      description: "test manifest",
      permissions: [],
      optional_permissions: ["management", "sidePanel"],
    }),
  },
  management: {
    getAll: async () => {
      chromeCalls.push(["management.getAll"]);
      return extensions.map((x) => ({ ...x, enabled: enabledState.has(x.id) ? enabledState.get(x.id) : x.enabled }));
    },
    get: async (id) => {
      chromeCalls.push(["management.get", id]);
      const found = extensions.find((x) => x.id === id);
      if (!found) throw new Error(`No extension with id ${id}`);
      return { ...found, enabled: enabledState.has(id) ? enabledState.get(id) : found.enabled };
    },
    getPermissionWarningsById: async (id) => {
      chromeCalls.push(["management.getPermissionWarningsById", id]);
      if (id === "other-extension-id") return ["Read your browsing history", "Access your data on example.com"];
      return [];
    },
    setEnabled: async (id, enabled) => {
      chromeCalls.push(["management.setEnabled", id, enabled]);
      enabledState.set(id, enabled);
    },
    uninstall: async (id, options) => {
      chromeCalls.push(["management.uninstall", id, options]);
      uninstalled.push(id);
    },
  },
  sidePanel: {
    getOptions: async (q) => {
      chromeCalls.push(["sidePanel.getOptions", q]);
      return { ...panelOptions };
    },
    setOptions: async (options) => {
      chromeCalls.push(["sidePanel.setOptions", options]);
      sidePanelSetCalls.push(options);
      if (options.path !== undefined) panelOptions.path = options.path;
      if (options.enabled !== undefined) panelOptions.enabled = options.enabled;
    },
    setPanelBehavior: async (behavior) => {
      chromeCalls.push(["sidePanel.setPanelBehavior", behavior]);
      Object.assign(panelBehavior, behavior);
    },
  },
  action: {
    enable: async (tabId) => { chromeCalls.push(["action.enable", tabId]); actionState.enabled = true; },
    disable: async (tabId) => { chromeCalls.push(["action.disable", tabId]); actionState.enabled = false; },
  },
};

const tools = () => browserToolset(false);

Deno.test("T11 inventory: the 12 tranche-11 tools ship in the browser toolset", () => {
  const all = Object.keys(tools());
  for (const name of [
    "list_extensions", "get_extension", "get_extension_permission_warnings",
    "set_extension_enabled", "uninstall_extension",
    "get_platform_info", "get_extension_manifest",
    "get_side_panel_options", "set_side_panel_options", "set_panel_behavior",
    "enable_action", "disable_action",
  ]) {
    assert(all.includes(name), `${name} is present in the toolset`);
  }
});

Deno.test("T11 management permission: reads fail closed without the management permission", async () => {
  reset();
  const t = tools();
  const noPerm = await t.list_extensions.execute({});
  assertEquals(noPerm.error, "management permission not granted — enable Extension management in Settings");
  assertEquals(chromeCalls.filter((c) => c[0] === "management.getAll").length, 0, "no management call without permission");
  const getNoPerm = await t.get_extension.execute({ id: "other-extension-id" });
  assertEquals(getNoPerm.error, "management permission not granted — enable Extension management in Settings");
  const warnNoPerm = await t.get_extension_permission_warnings.execute({ id: "other-extension-id" });
  assertEquals(warnNoPerm.error, "management permission not granted — enable Extension management in Settings");
});

Deno.test("T11 management reads: bounded output + honest totals once permission granted", async () => {
  reset();
  grantedPermissions.add("management");
  const t = tools();
  const all = await t.list_extensions.execute({});
  assertEquals(all.total, 3);
  assertEquals(all.extensions.length, 3);
  assertEquals(all.truncated, false);
  const bounded = await t.list_extensions.execute({ maxResults: 2 });
  assertEquals(bounded.extensions.length, 2);
  assertEquals(bounded.total, 3);
  assertEquals(bounded.truncated, true);
  const one = await t.get_extension.execute({ id: "other-extension-id" });
  assertEquals(one.name, "Some Other Extension");
  assertEquals(one.permissions, ["tabs"]);
  assertEquals(one.hostPermissions, ["https://example.com/*"]);
  const missing = await t.get_extension.execute({ id: "does-not-exist" });
  assert(missing.error.includes("no such extension"), missing.error);
  const warnings = await t.get_extension_permission_warnings.execute({ id: "other-extension-id" });
  assertEquals(warnings.warnings.length, 2);
  assertEquals(warnings.total, 2);
});

Deno.test("T11 runtime reads: no permission + no grant needed", async () => {
  reset();
  const t = tools();
  const platform = await t.get_platform_info.execute({});
  assertEquals(platform.os, "linux");
  assertEquals(platform.arch, "x86-64");
  const manifest = await t.get_extension_manifest.execute({});
  assertEquals(manifest.name, "This Extension");
  assertEquals(manifest.manifest_version, 3);
  assertEquals(manifest.optional_permissions, ["management", "sidePanel"]);
});

Deno.test("T11 self-extension protection: set_extension_enabled refuses to toggle THIS extension", async () => {
  reset();
  grantedPermissions.add("management");
  await setGlobalBrowserControlGrant();
  const t = tools();
  const selfToggle = await t.set_extension_enabled.execute({ id: SELF_ID, enabled: false });
  assertEquals(selfToggle.error, "refusing to toggle this extension's own enabled state");
  assertEquals(chromeCalls.filter((c) => c[0] === "management.setEnabled").length, 0, "no setEnabled for self");
  await revokeBrowserControlGrant();
});

Deno.test("T11 self-extension protection: uninstall_extension refuses to uninstall THIS extension", async () => {
  reset();
  grantedPermissions.add("management");
  await setGlobalBrowserControlGrant();
  const t = tools();
  const selfUninstall = await t.uninstall_extension.execute({ id: SELF_ID, confirm: true });
  assertEquals(selfUninstall.error, "refusing to uninstall this extension itself");
  assertEquals(uninstalled.length, 0, "self is never uninstalled");
  await revokeBrowserControlGrant();
});

Deno.test("T11 uninstall requires an explicit confirm:true (confirm-first, before permission/grant)", async () => {
  reset();
  grantedPermissions.add("management");
  await setGlobalBrowserControlGrant();
  const t = tools();
  const noConfirm = await t.uninstall_extension.execute({ id: "other-extension-id" });
  assertEquals(noConfirm.error, "uninstall is destructive — pass confirm:true to proceed");
  const falseConfirm = await t.uninstall_extension.execute({ id: "other-extension-id", confirm: false });
  assertEquals(falseConfirm.error, "uninstall is destructive — pass confirm:true to proceed");
  assertEquals(uninstalled.length, 0, "no uninstall without confirm:true");
  await revokeBrowserControlGrant();
});

Deno.test("T11 GLOBAL-grant-only: management mutations refuse an origin grant and need the GLOBAL grant", async () => {
  reset();
  grantedPermissions.add("management");
  const t = tools();
  // No grant at all: denied before any mutation.
  const noGrant = await t.set_extension_enabled.execute({ id: "other-extension-id", enabled: false });
  assertEquals(noGrant.error, "browser control not granted for extension management — ask the user to approve it in Settings");
  assertEquals(chromeCalls.filter((c) => c[0] === "management.setEnabled").length, 0);
  // An ORIGIN grant must NEVER authorize a browser-wide management mutation.
  await setOriginBrowserControlGrant(["https://example.com"]);
  const originGrant = await t.set_extension_enabled.execute({ id: "other-extension-id", enabled: false });
  assertEquals(originGrant.error, "browser control not granted for extension management — ask the user to approve it in Settings");
  assertEquals(chromeCalls.filter((c) => c[0] === "management.setEnabled").length, 0, "an origin grant never authorizes management");
  // The GLOBAL grant authorizes it.
  await setGlobalBrowserControlGrant();
  const ok = await t.set_extension_enabled.execute({ id: "other-extension-id", enabled: false });
  assertEquals(ok.ok, true);
  assertEquals(ok.enabled, false);
  // uninstall under global grant + confirm:true succeeds.
  const uninstallRes = await t.uninstall_extension.execute({ id: "disabled-app-id", confirm: true });
  assertEquals(uninstallRes.ok, true);
  assertEquals(uninstallRes.uninstalled, true);
  assertEquals(uninstalled, ["disabled-app-id"], "the uninstall reached chrome.management exactly once");
  const uninstallCall = chromeCalls.find((c) => c[0] === "management.uninstall");
  assertEquals(uninstallCall[2], { showConfirmDialog: false }, "no blocking native dialog; the owner grant + confirm:true are the gates");
  await revokeBrowserControlGrant();
});

Deno.test("T11 bounded inputs: ids and maxResults are schema-bounded", () => {
  const t = tools();
  assertEquals(t.get_extension.inputSchema.safeParse({ id: "" }).success, false, "empty id refused");
  assertEquals(t.get_extension.inputSchema.safeParse({ id: "x".repeat(200) }).success, false, "oversize id refused");
  assertEquals(t.uninstall_extension.inputSchema.safeParse({ id: "abc" }).success, true);
  assertEquals(t.list_extensions.inputSchema.safeParse({ maxResults: 0 }).success, false, "maxResults 0 refused");
  assertEquals(t.list_extensions.inputSchema.safeParse({ maxResults: 1000 }).success, false, "maxResults over cap refused");
  assertEquals(t.set_extension_enabled.inputSchema.safeParse({ id: "abc" }).success, false, "enabled is required");
});

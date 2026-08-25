// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 8 (site-data
// control: cookies + browsingData + contentSettings): schema bounds,
// permission fail-closed, exact-origin host scoping for cookies, broad-pattern
// rejection for contentSettings, dataTypes enumeration for wipes, and the
// grant discipline (site-scoped mutations need the origin granted; the
// browser-wide wipe needs the GLOBAL grant). In-memory chrome shim extended
// from chrome-tools-t1.test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  browserToolset,
  setGlobalBrowserControlGrant,
  setOriginBrowserControlGrant,
  revokeBrowserControlGrant,
} from "../extension/lib/browser-tools.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- in-memory chrome shim ----
const store = new Map();
const grantedPermissions = new Set(["storage", "tabs"]);
const grantedOrigins = new Set();
const cookieJar = []; // { name, value, domain, path, url }
const cookieStores = [{ id: "0", tabIds: [1, 2] }];
const wiped = []; // { options, dataTypes }
const contentSettingValues = new Map(); // `${resource}|${pattern}` -> setting
const chromeCalls = []; // records sensitive chrome calls for "never reached" assertions

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedPermissions.add("storage");
  grantedPermissions.add("tabs");
  grantedOrigins.clear();
  cookieJar.length = 0;
  cookieStores.length = 1;
  wiped.length = 0;
  contentSettingValues.clear();
  chromeCalls.length = 0;
  clearRunFence();
}

globalThis.chrome = {
  permissions: {
    contains: async (q) => {
      if (q?.permissions && !q.permissions.every((p) => grantedPermissions.has(p))) return false;
      if (q?.origins && !q.origins.every((o) => grantedOrigins.has(o))) return false;
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
  cookies: {
    getAll: async (query) => {
      chromeCalls.push(["cookies.getAll", query]);
      return cookieJar.filter((c) => !query?.domain || c.domain === query.domain);
    },
    getAllCookieStores: async () => {
      chromeCalls.push(["cookies.getAllCookieStores"]);
      return cookieStores;
    },
    get: async ({ url, name }) => {
      chromeCalls.push(["cookies.get", { url, name }]);
      return cookieJar.find((c) => c.url === url && c.name === name) ?? null;
    },
    set: async (details) => {
      chromeCalls.push(["cookies.set", details]);
      const cookie = { ...details, domain: new URL(details.url).hostname, path: "/" };
      cookieJar.push(cookie);
      return cookie;
    },
    remove: async ({ url, name }) => {
      chromeCalls.push(["cookies.remove", { url, name }]);
      const i = cookieJar.findIndex((c) => c.url === url && c.name === name);
      if (i >= 0) cookieJar.splice(i, 1);
      return { url, name };
    },
  },
  browsingData: {
    remove: async (options, dataTypes) => {
      chromeCalls.push(["browsingData.remove", options, dataTypes]);
      wiped.push({ options, dataTypes });
    },
  },
  contentSettings: Object.fromEntries(
    ["cookies", "images", "javascript", "location", "notifications", "popups"].map((resource) => [
      resource,
      {
        get: async ({ primaryPattern }) => {
          chromeCalls.push(["contentSettings.get", resource, primaryPattern]);
          return { setting: contentSettingValues.get(`${resource}|${primaryPattern}`) ?? "allow" };
        },
        set: async ({ primaryPattern, setting }) => {
          chromeCalls.push(["contentSettings.set", resource, primaryPattern, setting]);
          contentSettingValues.set(`${resource}|${primaryPattern}`, setting);
        },
        clear: async ({ primaryPattern }) => {
          chromeCalls.push(["contentSettings.clear", resource, primaryPattern]);
          contentSettingValues.delete(`${resource}|${primaryPattern}`);
        },
      },
    ]),
  ),
};

const tools = () => browserToolset(false);

Deno.test("T8 inventory: the 9 tranche-8 tools ship in the browser toolset; reads join the readOnly subset", () => {
  const all = Object.keys(tools());
  for (const name of [
    "list_cookies", "list_cookie_stores", "get_cookie", "set_cookie", "remove_cookie",
    "wipe_browsing_data", "get_content_setting", "set_content_setting", "clear_content_settings",
  ]) {
    assert(all.includes(name), `${name} shipped`);
  }
  const scoped = Object.keys(browserToolset(true));
  for (const name of ["list_cookies", "list_cookie_stores", "get_cookie", "get_content_setting"]) {
    assert(scoped.includes(name), `${name} is read-only — exposed to scoped runs`);
  }
  for (const name of ["set_cookie", "remove_cookie", "wipe_browsing_data", "set_content_setting", "clear_content_settings"]) {
    assert(!scoped.includes(name), `${name} mutates — NEVER exposed to scoped runs`);
  }
});

Deno.test("T8 permission fail-closed: every tool returns an honest Settings error without its optional permission", async () => {
  reset();
  const t = tools();
  assertEquals((await t.list_cookies.execute({ domain: "example.com" })).error, "cookies permission not granted — enable Cookies in Settings");
  assertEquals((await t.list_cookie_stores.execute({})).error, "cookies permission not granted — enable Cookies in Settings");
  assertEquals((await t.get_cookie.execute({ url: "https://example.com/", name: "s" })).error, "cookies permission not granted — enable Cookies in Settings");
  assertEquals((await t.set_cookie.execute({ url: "https://example.com/", name: "s", value: "v" })).error, "cookies permission not granted — enable Cookies in Settings");
  assertEquals((await t.remove_cookie.execute({ url: "https://example.com/", name: "s" })).error, "cookies permission not granted — enable Cookies in Settings");
  assertEquals((await t.wipe_browsing_data.execute({ dataTypes: ["cache"] })).error, "browsingData permission not granted — enable Browsing data in Settings");
  assertEquals((await t.get_content_setting.execute({ resource: "javascript", primaryPattern: "https://example.com/*" })).error, "contentSettings permission not granted — enable Content settings in Settings");
  assertEquals((await t.set_content_setting.execute({ resource: "javascript", primaryPattern: "https://example.com/*", setting: "block" })).error, "contentSettings permission not granted — enable Content settings in Settings");
  assertEquals((await t.clear_content_settings.execute({ resource: "javascript", primaryPattern: "https://example.com/*" })).error, "contentSettings permission not granted — enable Content settings in Settings");
  assertEquals(chromeCalls.filter((c) => !String(c[0]).startsWith("cookies")).length, 0, "no chrome mutation reached without the permission");
});

Deno.test("T8 schema bounds: empty dataTypes, unknown dataTypes and invalid resources are rejected before any chrome call", () => {
  const t = tools();
  assertEquals(t.wipe_browsing_data.inputSchema.safeParse({ dataTypes: [] }).success, false, "an EMPTY dataTypes list is refused by the schema");
  assertEquals(t.wipe_browsing_data.inputSchema.safeParse({ dataTypes: ["everything"] }).success, false, "unknown dataTypes are refused");
  assertEquals(t.wipe_browsing_data.inputSchema.safeParse({ dataTypes: ["cache", "history"] }).success, true, "an explicit enumeration is accepted");
  assertEquals(t.get_content_setting.inputSchema.safeParse({ resource: "plugins", primaryPattern: "https://example.com/*" }).success, false, "unsupported resources are refused");
  assertEquals(t.set_cookie.inputSchema.safeParse({ url: "not-a-url", name: "s", value: "v" }).success, false);
  assertEquals(t.set_cookie.inputSchema.safeParse({ url: "https://example.com/", name: "", value: "v" }).success, false);
});

Deno.test("T8 cookie URL scheme: only http/https cookie URLs are supported", async () => {
  reset();
  grantedPermissions.add("cookies");
  grantedOrigins.add("https://example.com/*");
  await setGlobalBrowserControlGrant();
  const t = tools();
  // file://, chrome:// and data: URLs have no web origin and are refused.
  const fileRes = await t.set_cookie.execute({ url: "file:///etc/passwd", name: "s", value: "v" });
  assertEquals(fileRes.error, "only http/https cookie URLs are supported");
  // chrome:// parses as a URL but has no web origin — refused in execute.
  const chromeRes = await t.set_cookie.execute({ url: "chrome://settings/", name: "s", value: "v" });
  assertEquals(chromeRes.error, "only http/https cookie URLs are supported");
  assertEquals(chromeCalls.filter((c) => c[0] === "cookies.set").length, 0, "no cookie write for a non-http(s) scheme");
  await revokeBrowserControlGrant();
});

Deno.test("T8 cookie host scoping: cookie reads/writes require the EXACT-origin host permission (never broad)", async () => {
  reset();
  grantedPermissions.add("cookies");
  cookieJar.push({ name: "sid", value: "abc", domain: "example.com", path: "/", url: "https://example.com/" });
  const t = tools();
  // No host permission: honest, actionable error — and no chrome.cookies call.
  const denied = await t.get_cookie.execute({ url: "https://example.com/", name: "sid" });
  assert(denied.error.includes("host permission for https://example.com not granted"), denied.error);
  assert(denied.error.includes("broad/all-sites access is never requested"));
  assertEquals(chromeCalls.filter((c) => c[0] === "cookies.get").length, 0, "no cookie read without host permission");
  // A BROAD host grant (<all_urls>) is NOT consulted — only the exact origin
  // pattern counts, so it still fails closed here.
  grantedOrigins.add("<all_urls>");
  const broadOnly = await t.get_cookie.execute({ url: "https://example.com/", name: "sid" });
  assert(broadOnly.error.includes("host permission for https://example.com not granted"), "a broad grant never substitutes the exact origin");
  grantedOrigins.delete("<all_urls>");
  // Exact origin grant: the read succeeds.
  grantedOrigins.add("https://example.com/*");
  const ok = await t.get_cookie.execute({ url: "https://example.com/", name: "sid" });
  assertEquals(ok.found, true);
  assertEquals(ok.cookie.value, "abc");
});

Deno.test("T8 grant discipline: site-scoped cookie writes need the origin grant; set+remove ride the grant lock", async () => {
  reset();
  grantedPermissions.add("cookies");
  grantedOrigins.add("https://example.com/*");
  const t = tools();
  // No grant at all: denied before any cookie mutation.
  const noGrant = await t.set_cookie.execute({ url: "https://example.com/", name: "s", value: "v" });
  assertEquals(noGrant.error, "browser control not granted for this origin — ask the user to approve it in Settings");
  assertEquals(chromeCalls.filter((c) => c[0] === "cookies.set").length, 0);
  // An origin grant for a DIFFERENT origin does not cover example.com.
  await setOriginBrowserControlGrant(["https://other.example"]);
  const wrongOrigin = await t.set_cookie.execute({ url: "https://example.com/", name: "s", value: "v" });
  assertEquals(wrongOrigin.error, "browser control not granted for this origin — ask the user to approve it in Settings");
  // The matching origin grant authorizes the write.
  await setOriginBrowserControlGrant(["https://example.com"]);
  const ok = await t.set_cookie.execute({ url: "https://example.com/", name: "s", value: "v" });
  assertEquals(ok.ok, true);
  assertEquals(ok.origin, "https://example.com");
  const removed = await t.remove_cookie.execute({ url: "https://example.com/", name: "s" });
  assertEquals(removed.ok, true);
  assertEquals(removed.removed, true);
  await revokeBrowserControlGrant();
});

Deno.test("T8 wipe: global grant REQUIRED — an origin-scoped grant is refused; enumerated types are wiped honestly", async () => {
  reset();
  grantedPermissions.add("browsingData");
  const t = tools();
  // Origin-scoped grant: browser-wide wipes are refused (no implicit global).
  await setOriginBrowserControlGrant(["https://example.com"]);
  const scoped = await t.wipe_browsing_data.execute({ dataTypes: ["cache", "history"] });
  assert(scoped.error.includes("global grant"), scoped.error);
  assertEquals(wiped.length, 0, "nothing wiped under a scoped grant");
  // Global grant: exactly the enumerated types are wiped (deduplicated).
  await setGlobalBrowserControlGrant();
  const ok = await t.wipe_browsing_data.execute({ dataTypes: ["cache", "history", "cache"], sinceMs: 1000 });
  assertEquals(ok.ok, true);
  assertEquals(ok.removed.sort(), ["cache", "history"]);
  assertEquals(wiped.length, 1);
  assertEquals(wiped[0].dataTypes, { cache: true, history: true }, "ONLY the enumerated types cross to Chrome");
  assertEquals(wiped[0].options.since, 1000);
  assertEquals(ok.sinceMs, 1000);
  await revokeBrowserControlGrant();
});

Deno.test("T8 contentSettings patterns: <all_urls>, wildcard-subdomain and decorated patterns are rejected before any chrome call", async () => {
  reset();
  grantedPermissions.add("contentSettings");
  await setGlobalBrowserControlGrant();
  const t = tools();
  for (const bad of ["<all_urls>", "https://*.example.com/*", "https://example.com/path/*", "*://example.com/*", "https://example.com/?x=1/*"]) {
    const setRes = await t.set_content_setting.execute({ resource: "javascript", primaryPattern: bad, setting: "block" });
    assert(setRes.error, `${bad} rejected on set`);
    assert(setRes.error.includes("exact") || setRes.error.includes("rejected"), setRes.error);
    const clearRes = await t.clear_content_settings.execute({ resource: "javascript", primaryPattern: bad });
    assert(clearRes.error, `${bad} rejected on clear`);
    const getRes = await t.get_content_setting.execute({ resource: "javascript", primaryPattern: bad });
    assert(getRes.error, `${bad} rejected on get`);
  }
  assertEquals(chromeCalls.filter((c) => String(c[0]).startsWith("contentSettings")).length, 0, "no contentSettings call for a broad pattern");
  await revokeBrowserControlGrant();
});

Deno.test("T8 contentSettings mutation: grant-gated single-origin set/clear + per-resource setting enum validation", async () => {
  reset();
  grantedPermissions.add("contentSettings");
  const t = tools();
  // Invalid setting for the resource fails closed (before grant/chrome).
  const badSetting = await t.set_content_setting.execute({ resource: "images", primaryPattern: "https://example.com/*", setting: "ask" });
  assertEquals(badSetting.error, "invalid setting for images — allowed: allow, block");
  // No grant: denied.
  const noGrant = await t.set_content_setting.execute({ resource: "javascript", primaryPattern: "https://example.com/*", setting: "block" });
  assertEquals(noGrant.error, "browser control not granted for this origin — ask the user to approve it in Settings");
  // Origin grant for the pattern's origin authorizes set + clear.
  await setOriginBrowserControlGrant(["https://example.com"]);
  const setRes = await t.set_content_setting.execute({ resource: "javascript", primaryPattern: "https://example.com/*", setting: "block" });
  assertEquals(setRes.ok, true);
  assertEquals(contentSettingValues.get("javascript|https://example.com/*"), "block");
  const getRes = await t.get_content_setting.execute({ resource: "javascript", primaryPattern: "https://example.com/*" });
  assertEquals(getRes.setting, "block");
  const clearRes = await t.clear_content_settings.execute({ resource: "javascript", primaryPattern: "https://example.com/*" });
  assertEquals(clearRes.cleared, true);
  assertEquals(contentSettingValues.has("javascript|https://example.com/*"), false);
  await revokeBrowserControlGrant();
});

Deno.test("T8 bounded outputs: list_cookies truncates to maxResults with an honest total", async () => {
  reset();
  grantedPermissions.add("cookies");
  for (let i = 0; i < 150; i++) {
    cookieJar.push({ name: `c${i}`, value: "v", domain: "example.com", path: "/", url: "https://example.com/" });
  }
  const t = tools();
  const res = await t.list_cookies.execute({ domain: "example.com", maxResults: 50 });
  assertEquals(res.cookies.length, 50);
  assertEquals(res.returned, 50);
  assertEquals(res.total, 150);
  assertEquals(res.truncated, true);
  const stores = await t.list_cookie_stores.execute({});
  assertEquals(stores.stores, [{ id: "0", tabIds: [1, 2] }]);
});

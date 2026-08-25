// @ts-nocheck
// CAP-FB-20260823-COMPREHENSIVE-CHROME-TOOLS-01 — Tranche 9 (browser settings:
// chrome.privacy / proxy / fontSettings / power / search / tts): schema bounds,
// permission fail-closed, privacy value-kind validation, non-http(s) PAC
// refusal, bounded outputs, and the grant discipline — every mutation is
// BROWSER-WIDE (no destination origin) so an ORIGIN-scoped grant must be
// REFUSED and only the GLOBAL grant may authorize it. In-memory chrome shim
// extended from chrome-tools-t8.test.ts.
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
const chromeCalls = []; // records sensitive chrome calls for "never reached" assertions

// Privacy ChromeSetting mock: value + a get/set pair that records calls.
const privacyValues = new Map(); // "category.name" -> value
function chromeSetting(key, initial) {
  privacyValues.set(key, initial);
  return {
    get: async () => {
      chromeCalls.push(["privacy.get", key]);
      return { value: privacyValues.get(key), levelOfControl: "controllable_by_this_extension" };
    },
    set: async ({ value }) => {
      chromeCalls.push(["privacy.set", key, value]);
      privacyValues.set(key, value);
    },
  };
}
const proxyState = { config: { mode: "system" }, cleared: 0 };
const fontState = { size: 16, fonts: {}, cleared: 0 };
const powerState = { level: null, released: 0 };
const searchCalls = [];
const ttsState = { spoken: [], stopped: 0, speaking: false };

// The privacy defaults, re-seeded on every reset (the chromeSetting() helper
// seeds them once at shim creation, but reset() clears the map).
const PRIVACY_DEFAULTS = [
  ["network.webRTCIpHandlingPolicy", "default"],
  ["network.networkPredictionEnabled", true],
  ["services.alternateErrorPagesEnabled", true],
  ["services.autofillAddressEnabled", true],
  ["services.autofillCreditCardEnabled", true],
  ["services.passwordSavingEnabled", true],
  ["services.safeBrowsingEnabled", true],
  ["services.safeBrowsingExtendedReportingEnabled", false],
  ["services.searchSuggestEnabled", true],
  ["services.spellingServiceEnabled", true],
  ["services.translationServiceEnabled", true],
  ["websites.adMeasurementEnabled", false],
  ["websites.doNotTrackEnabled", false],
  ["websites.hyperlinkAuditingEnabled", true],
  ["websites.protectedContentEnabled", true],
  ["websites.referrersEnabled", true],
  ["websites.thirdPartyCookiesAllowed", true],
];
function seedPrivacyDefaults() {
  for (const [key, value] of PRIVACY_DEFAULTS) privacyValues.set(key, value);
}

function reset() {
  store.clear();
  grantedPermissions.clear();
  grantedPermissions.add("storage");
  grantedPermissions.add("tabs");
  chromeCalls.length = 0;
  privacyValues.clear();
  seedPrivacyDefaults();
  proxyState.config = { mode: "system" };
  proxyState.cleared = 0;
  fontState.size = 16;
  fontState.fonts = {};
  fontState.cleared = 0;
  powerState.level = null;
  powerState.released = 0;
  searchCalls.length = 0;
  ttsState.spoken.length = 0;
  ttsState.stopped = 0;
  ttsState.speaking = false;
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
  privacy: {
    network: {
      webRTCIpHandlingPolicy: chromeSetting("network.webRTCIpHandlingPolicy", "default"),
      networkPredictionEnabled: chromeSetting("network.networkPredictionEnabled", true),
    },
    services: {
      alternateErrorPagesEnabled: chromeSetting("services.alternateErrorPagesEnabled", true),
      autofillAddressEnabled: chromeSetting("services.autofillAddressEnabled", true),
      autofillCreditCardEnabled: chromeSetting("services.autofillCreditCardEnabled", true),
      passwordSavingEnabled: chromeSetting("services.passwordSavingEnabled", true),
      safeBrowsingEnabled: chromeSetting("services.safeBrowsingEnabled", true),
      safeBrowsingExtendedReportingEnabled: chromeSetting("services.safeBrowsingExtendedReportingEnabled", false),
      searchSuggestEnabled: chromeSetting("services.searchSuggestEnabled", true),
      spellingServiceEnabled: chromeSetting("services.spellingServiceEnabled", true),
      translationServiceEnabled: chromeSetting("services.translationServiceEnabled", true),
    },
    websites: {
      adMeasurementEnabled: chromeSetting("websites.adMeasurementEnabled", false),
      doNotTrackEnabled: chromeSetting("websites.doNotTrackEnabled", false),
      hyperlinkAuditingEnabled: chromeSetting("websites.hyperlinkAuditingEnabled", true),
      protectedContentEnabled: chromeSetting("websites.protectedContentEnabled", true),
      referrersEnabled: chromeSetting("websites.referrersEnabled", true),
      thirdPartyCookiesAllowed: chromeSetting("websites.thirdPartyCookiesAllowed", true),
    },
  },
  proxy: {
    settings: {
      get: async () => { chromeCalls.push(["proxy.get"]); return proxyState.config; },
      set: async ({ value }) => { chromeCalls.push(["proxy.set", value]); proxyState.config = value; },
      clear: async () => { chromeCalls.push(["proxy.clear"]); proxyState.cleared += 1; proxyState.config = { mode: "system" }; },
    },
  },
  fontSettings: {
    getDefaultFontSize: async () => { chromeCalls.push(["fontSettings.getDefaultFontSize"]); return { pixelSize: fontState.size }; },
    setDefaultFontSize: async ({ pixelSize }) => { chromeCalls.push(["fontSettings.setDefaultFontSize", pixelSize]); fontState.size = pixelSize; },
    clearDefaultFontSize: async () => { chromeCalls.push(["fontSettings.clearDefaultFontSize"]); fontState.size = 16; },
    getFont: async ({ genericFamily }) => { chromeCalls.push(["fontSettings.getFont", genericFamily]); return { fontId: fontState.fonts[genericFamily] ?? "Arial" }; },
    setFont: async ({ genericFamily, fontId }) => { chromeCalls.push(["fontSettings.setFont", genericFamily, fontId]); fontState.fonts[genericFamily] = fontId; },
    clearFont: async ({ genericFamily }) => { chromeCalls.push(["fontSettings.clearFont", genericFamily]); delete fontState.fonts[genericFamily]; },
  },
  power: {
    requestKeepAwake: async (level) => { chromeCalls.push(["power.requestKeepAwake", level]); powerState.level = level; },
    release: async () => { chromeCalls.push(["power.release"]); powerState.level = null; powerState.released += 1; },
  },
  search: {
    query: async ({ text }) => { chromeCalls.push(["search.query", text]); searchCalls.push(text); },
  },
  tts: {
    speak: async (text, options) => { chromeCalls.push(["tts.speak", text, options]); ttsState.spoken.push(text); ttsState.speaking = true; },
    stop: async () => { chromeCalls.push(["tts.stop"]); ttsState.stopped += 1; ttsState.speaking = false; },
    getVoices: async () => {
      chromeCalls.push(["tts.getVoices"]);
      return Array.from({ length: 40 }, (_, i) => ({ voiceName: `voice-${i}`, lang: "en-US", localService: i % 2 === 0, isDefault: i === 0 }));
    },
    isSpeaking: async () => ttsState.speaking,
  },
};

function tools() {
  return browserToolset(false);
}

Deno.test("T9 inventory: the 16 tranche-9 tools ship in the browser toolset; reads join the readOnly subset", () => {
  const all = Object.keys(browserToolset(false));
  for (const name of [
    "get_privacy_setting", "set_privacy_setting", "get_proxy_settings", "set_proxy_settings",
    "clear_proxy_settings", "get_font_settings", "set_font_size", "set_default_font",
    "clear_font_settings", "request_keep_awake", "release_keep_awake", "search_query",
    "tts_speak", "tts_stop", "list_tts_voices", "tts_is_speaking",
  ]) {
    assert(all.includes(name), `${name} shipped`);
  }
  const scoped = Object.keys(browserToolset(true));
  for (const name of ["get_privacy_setting", "get_proxy_settings", "get_font_settings", "list_tts_voices", "tts_is_speaking"]) {
    assert(scoped.includes(name), `${name} is read-only — exposed to scoped runs`);
  }
  for (const name of [
    "set_privacy_setting", "set_proxy_settings", "clear_proxy_settings", "set_font_size",
    "set_default_font", "clear_font_settings", "request_keep_awake", "release_keep_awake",
    "search_query", "tts_speak", "tts_stop",
  ]) {
    assert(!scoped.includes(name), `${name} mutates — NEVER exposed to scoped runs`);
  }
});

Deno.test("T9 permission fail-closed: every tool returns an honest Settings error without its optional permission", async () => {
  reset();
  const t = tools();
  assertEquals((await t.get_privacy_setting.execute({ setting: "websites.doNotTrackEnabled" })).error, "privacy permission not granted — enable Privacy in Settings");
  assertEquals((await t.set_privacy_setting.execute({ setting: "websites.doNotTrackEnabled", value: true })).error, "privacy permission not granted — enable Privacy in Settings");
  assertEquals((await t.get_proxy_settings.execute({})).error, "proxy permission not granted — enable Proxy in Settings");
  assertEquals((await t.set_proxy_settings.execute({ mode: "direct" })).error, "proxy permission not granted — enable Proxy in Settings");
  assertEquals((await t.clear_proxy_settings.execute({})).error, "proxy permission not granted — enable Proxy in Settings");
  assertEquals((await t.get_font_settings.execute({})).error, "fontSettings permission not granted — enable Font settings in Settings");
  assertEquals((await t.set_font_size.execute({ pixelSize: 18 })).error, "fontSettings permission not granted — enable Font settings in Settings");
  assertEquals((await t.set_default_font.execute({ genericFamily: "standard", fontId: "Arial" })).error, "fontSettings permission not granted — enable Font settings in Settings");
  assertEquals((await t.clear_font_settings.execute({})).error, "fontSettings permission not granted — enable Font settings in Settings");
  assertEquals((await t.request_keep_awake.execute({ level: "system" })).error, "power permission not granted — enable Power in Settings");
  assertEquals((await t.release_keep_awake.execute({})).error, "power permission not granted — enable Power in Settings");
  assertEquals((await t.search_query.execute({ text: "hello" })).error, "search permission not granted — enable Search in Settings");
  assertEquals((await t.tts_speak.execute({ text: "hi" })).error, "tts permission not granted — enable Text-to-speech in Settings");
  assertEquals((await t.tts_stop.execute({})).error, "tts permission not granted — enable Text-to-speech in Settings");
  assertEquals((await t.list_tts_voices.execute({})).error, "tts permission not granted — enable Text-to-speech in Settings");
  assertEquals((await t.tts_is_speaking.execute({})).error, "tts permission not granted — enable Text-to-speech in Settings");
  // No chrome mutation/read beyond the storage grant machinery reached without permission.
  assertEquals(chromeCalls.filter((c) => !["privacy.get"].includes(c[0])).length, 0, "no chrome API reached without its permission");
});

Deno.test("T9 schema bounds: invalid settings, enums, families, modes and oversized text are rejected before any chrome call", () => {
  const t = tools();
  assertEquals(t.get_privacy_setting.inputSchema.safeParse({ setting: "websites.notARealSetting" }).success, false);
  assertEquals(t.set_privacy_setting.inputSchema.safeParse({ setting: "websites.doNotTrackEnabled", value: 42 }).success, false, "a numeric value is refused by the schema union");
  assertEquals(t.set_proxy_settings.inputSchema.safeParse({ mode: "bogus" }).success, false);
  assertEquals(t.set_font_size.inputSchema.safeParse({ pixelSize: 0 }).success, false);
  assertEquals(t.set_font_size.inputSchema.safeParse({ pixelSize: 101 }).success, false);
  assertEquals(t.set_default_font.inputSchema.safeParse({ genericFamily: "comic", fontId: "x" }).success, false);
  assertEquals(t.search_query.inputSchema.safeParse({ text: "" }).success, false);
  assertEquals(t.search_query.inputSchema.safeParse({ text: "x".repeat(513) }).success, false);
  assertEquals(t.tts_speak.inputSchema.safeParse({ text: "" }).success, false);
  assertEquals(t.tts_speak.inputSchema.safeParse({ text: "x".repeat(1001) }).success, false);
  assertEquals(t.tts_speak.inputSchema.safeParse({ text: "hi", rate: 11 }).success, false);
  assertEquals(t.request_keep_awake.inputSchema.safeParse({ level: "turbo" }).success, false);
});

Deno.test("T9 privacy value-kind validation: enum/boolean mismatches are refused before any grant or chrome call", async () => {
  reset();
  grantedPermissions.add("privacy");
  await setGlobalBrowserControlGrant();
  const t = tools();
  // webRTCIpHandlingPolicy is an enum — a boolean is refused.
  const boolForEnum = await t.set_privacy_setting.execute({ setting: "network.webRTCIpHandlingPolicy", value: true });
  assert(boolForEnum.error.includes("one of"), boolForEnum.error);
  // doNotTrackEnabled is a boolean — an enum string is refused.
  const stringForBool = await t.set_privacy_setting.execute({ setting: "websites.doNotTrackEnabled", value: "default" });
  assert(stringForBool.error.includes("boolean"), stringForBool.error);
  // A wrong enum member is refused.
  const badEnum = await t.set_privacy_setting.execute({ setting: "network.webRTCIpHandlingPolicy", value: "not-a-policy" });
  assert(badEnum.error.includes("one of"), badEnum.error);
  assertEquals(chromeCalls.filter((c) => c[0] === "privacy.set").length, 0, "no privacy.set reached for invalid values");
  await revokeBrowserControlGrant();
});

Deno.test("T9 global grant REQUIRED for privacy set: an origin-scoped grant is refused; global authorizes", async () => {
  reset();
  grantedPermissions.add("privacy");
  const t = tools();
  // Origin-scoped grant: a browser-wide privacy change is refused (no implicit global).
  await setOriginBrowserControlGrant(["https://example.com"]);
  const scoped = await t.set_privacy_setting.execute({ setting: "websites.doNotTrackEnabled", value: true });
  assert(scoped.error.includes("global grant"), scoped.error);
  assertEquals(chromeCalls.filter((c) => c[0] === "privacy.set").length, 0, "nothing set under a scoped grant");
  // Global grant authorizes the browser-wide change.
  await setGlobalBrowserControlGrant();
  const ok = await t.set_privacy_setting.execute({ setting: "websites.doNotTrackEnabled", value: true });
  assertEquals(ok.ok, true);
  assertEquals(ok.setting, "websites.doNotTrackEnabled");
  assertEquals(privacyValues.get("websites.doNotTrackEnabled"), true);
  await revokeBrowserControlGrant();
});

Deno.test("T9 privacy read is light: no grant needed, bounded result", async () => {
  reset();
  grantedPermissions.add("privacy");
  const t = tools();
  const r = await t.get_privacy_setting.execute({ setting: "network.webRTCIpHandlingPolicy" });
  assertEquals(r.setting, "network.webRTCIpHandlingPolicy");
  assertEquals(r.value, "default");
  assertEquals(typeof r.levelOfControl, "string");
});

Deno.test("T9 proxy: non-http(s) PAC refused; global grant REQUIRED; fixed_servers needs rules", async () => {
  reset();
  grantedPermissions.add("proxy");
  const t = tools();
  await setGlobalBrowserControlGrant();
  // A data: PAC is refused BEFORE any chrome call (even under a valid grant).
  const badPac = await t.set_proxy_settings.execute({ mode: "pac_script", pacScript: { url: "data:text/javascript,void 0" } });
  assert(badPac.error.includes("http(s)"), badPac.error);
  assertEquals(chromeCalls.filter((c) => c[0] === "proxy.set").length, 0, "no proxy.set for a non-http(s) PAC");
  // fixed_servers without rules is refused.
  const noRules = await t.set_proxy_settings.execute({ mode: "fixed_servers" });
  assertEquals(noRules.error, "fixed_servers mode requires rules");
  // A valid http PAC is accepted under the global grant.
  const ok = await t.set_proxy_settings.execute({ mode: "pac_script", pacScript: { url: "https://example.com/proxy.pac" } });
  assertEquals(ok.ok, true);
  assertEquals(proxyState.config.mode, "pac_script");
  // clear works under global.
  const cleared = await t.clear_proxy_settings.execute({});
  assertEquals(cleared.ok, true);
  assertEquals(proxyState.cleared, 1);
  await revokeBrowserControlGrant();
  // After revoke, an origin-scoped grant is refused for a browser-wide proxy change.
  await setOriginBrowserControlGrant(["https://example.com"]);
  const scoped = await t.set_proxy_settings.execute({ mode: "direct" });
  assert(scoped.error.includes("global grant"), scoped.error);
  await revokeBrowserControlGrant();
});

Deno.test("T9 font settings: global grant REQUIRED; reads are light; clear resets", async () => {
  reset();
  grantedPermissions.add("fontSettings");
  const t = tools();
  // Read is light (no grant needed).
  const before = await t.get_font_settings.execute({});
  assertEquals(before.defaultFontSizePx, 16);
  assert(typeof before.defaultFonts.standard === "string");
  // Origin-scoped grant is refused for a browser-wide font change.
  await setOriginBrowserControlGrant(["https://example.com"]);
  const scoped = await t.set_font_size.execute({ pixelSize: 20 });
  assert(scoped.error.includes("global grant"), scoped.error);
  assertEquals(chromeCalls.filter((c) => c[0] === "fontSettings.setDefaultFontSize").length, 0);
  // Global grant authorizes set + clear.
  await setGlobalBrowserControlGrant();
  const sized = await t.set_font_size.execute({ pixelSize: 20 });
  assertEquals(sized.ok, true);
  assertEquals(fontState.size, 20);
  const fonted = await t.set_default_font.execute({ genericFamily: "standard", fontId: "Inter" });
  assertEquals(fonted.ok, true);
  assertEquals(fontState.fonts.standard, "Inter");
  const cleared = await t.clear_font_settings.execute({});
  assertEquals(cleared.ok, true);
  assertEquals(fontState.size, 16);
  await revokeBrowserControlGrant();
});

Deno.test("T9 power + search + tts: global grant REQUIRED for every mutation", async () => {
  reset();
  grantedPermissions.add("power");
  grantedPermissions.add("search");
  grantedPermissions.add("tts");
  const t = tools();
  // Origin-scoped grant is refused for all three browser-wide mutations.
  await setOriginBrowserControlGrant(["https://example.com"]);
  assert((await t.request_keep_awake.execute({ level: "system" })).error.includes("global grant"));
  assert((await t.search_query.execute({ text: "hello" })).error.includes("global grant"));
  assert((await t.tts_speak.execute({ text: "hi" })).error.includes("global grant"));
  assert((await t.tts_stop.execute({})).error.includes("global grant"));
  assertEquals(powerState.level, null);
  assertEquals(searchCalls.length, 0);
  assertEquals(ttsState.spoken.length, 0);
  // Global grant authorizes them.
  await setGlobalBrowserControlGrant();
  const awake = await t.request_keep_awake.execute({ level: "display" });
  assertEquals(awake.ok, true);
  assertEquals(powerState.level, "display");
  const searched = await t.search_query.execute({ text: "wasm tools" });
  assertEquals(searched.ok, true);
  assertEquals(searchCalls, ["wasm tools"]);
  const spoken = await t.tts_speak.execute({ text: "hello world", rate: 1.2 });
  assertEquals(spoken.ok, true);
  assertEquals(ttsState.spoken, ["hello world"]);
  const stopped = await t.tts_stop.execute({});
  assertEquals(stopped.ok, true);
  assertEquals(ttsState.stopped, 1);
  const released = await t.release_keep_awake.execute({});
  assertEquals(released.ok, true);
  assertEquals(powerState.released, 1);
  await revokeBrowserControlGrant();
});

Deno.test("T9 tts reads: bounded voice list with honest totals + speaking state", async () => {
  reset();
  grantedPermissions.add("tts");
  const t = tools();
  const bounded = await t.list_tts_voices.execute({ maxResults: 10 });
  assertEquals(bounded.voices.length, 10);
  assertEquals(bounded.total, 40);
  assertEquals(bounded.truncated, true);
  assertEquals(bounded.returned, 10);
  assertEquals(bounded.voices[0].voiceName, "voice-0");
  const speaking = await t.tts_is_speaking.execute({});
  assertEquals(speaking.speaking, false);
});

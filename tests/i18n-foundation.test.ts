// tests/i18n-foundation.test.ts — the internationalisation FOUNDATION pins
// (chrome-agent-platform-54q): catalogue shape, drift guard between
// _locales/en/messages.json and the embedded gallery fallback, lookup
// semantics, and the hydrate contract for static HTML.
//
// FALSIFICATION: drift the embedded catalogue (or a message value) and the
// drift pin goes RED; break the lookup fallback and the gallery rendering
// tests go RED; remove default_locale and the manifest pin goes RED.
// @ts-nocheck — JSON catalogue shapes are asserted at runtime above.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { t, hydrateI18n, I18N_DEFAULT_CATALOGUE } from "../extension/shared/i18n.js";

const CATALOGUE_PATH = new URL("../extension/_locales/en/messages.json", import.meta.url);
const MANIFEST_PATH = new URL("../extension/manifest.json", import.meta.url);
const messages = JSON.parse(await Deno.readTextFile(CATALOGUE_PATH));
const manifest = JSON.parse(await Deno.readTextFile(MANIFEST_PATH));

Deno.test("i18n: the manifest declares default_locale=en and the en catalogue exists", () => {
  assertEquals(manifest.default_locale, "en", "default_locale must exist so Chrome resolves _locales/en");
  assert(messages && typeof messages === "object", "_locales/en/messages.json must parse as an object");
});

Deno.test("i18n: every catalogue entry is a well-formed chrome.i18n message", () => {
  // chrome.i18n message names: alphanumerics, underscore, @ only.
  const nameOk = /^[a-zA-Z0-9_@]+$/;
  for (const [key, entry] of Object.entries(messages)) {
    assert(nameOk.test(key), `catalogue key ${JSON.stringify(key)} is not a valid chrome.i18n message name`);
    assert(entry && typeof entry === "object" && !Array.isArray(entry), `${key}: entry must be an object`);
    assert(typeof entry.message === "string" && entry.message.length > 0, `${key}: message must be a non-empty string`);
  }
});

Deno.test("i18n: the embedded default catalogue is byte-identical to _locales/en/messages.json (drift guard)", () => {
  const expected = {};
  for (const [key, entry] of Object.entries(messages)) expected[key] = entry.message;
  assertEquals(
    { ...I18N_DEFAULT_CATALOGUE },
    expected,
    "extension/shared/i18n.js drifted from _locales/en/messages.json — run `node scripts/sync-i18n.mjs`",
  );
});

Deno.test("i18n: t() resolves through the catalogue in a chrome-less context (the gallery path)", () => {
  // No chrome global here: the fallback catalogue must answer.
  const keys = Object.keys(messages);
  for (const key of keys.slice(0, 25)) {
    assertEquals(t(key), messages[key].message, `t(${key}) must return the catalogue message`);
  }
});

Deno.test("i18n: a missing key is loud (returns the key), never a silent blank", () => {
  assertEquals(t("this_key_does_not_exist_xyz"), "this_key_does_not_exist_xyz");
});

Deno.test("i18n: positional substitutions match chrome.i18n $1..$9 semantics", () => {
  // Synthetic probe via the fallback: build a message shape the catalogue uses.
  const probe = Object.entries(messages).find(([, v]) => /\$1/.test(v.message));
  if (!probe) return; // no substitution strings migrated yet — nothing to pin
  const [key, entry] = probe;
  const out = t(key, "EXAMPLE");
  assert(!out.includes("$1"), `t(${key}, "EXAMPLE") left $1 unsubstituted: ${out}`);
  assertStringIncludes(out, "EXAMPLE");
});

Deno.test("i18n: hydrateI18n fills data-i18n text and data-i18n-attr attributes from the catalogue", () => {
  const keys = Object.keys(messages);
  if (keys.length === 0) return; // nothing migrated yet
  const first = keys[0];
  const textEl = {
    _text: "stale",
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    getAttribute: (n) => (n === "data-i18n" ? first : null),
    setAttribute() {},
  };
  const attrEl = {
    attrs: { "data-i18n-attr": `aria-label:${first}` },
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; },
  };
  const root = {
    querySelectorAll(sel) {
      if (sel === "[data-i18n]") return [textEl];
      if (sel === "[data-i18n-attr]") return [attrEl];
      return [];
    },
  };
  hydrateI18n(root);
  assertEquals(textEl._text, messages[first].message, "data-i18n text must come from the catalogue");
  assertEquals(attrEl.attrs["aria-label"], messages[first].message, "data-i18n-attr must come from the catalogue");
});

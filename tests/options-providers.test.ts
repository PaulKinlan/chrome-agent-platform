// CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01 — the recommended default
// provider and the four-click key flow. These test the PURE render helpers
// extracted from renderProviders (jsdom-free) and the structural guards the
// Providers panel must keep (recommended-first, radiogroup a11y, no
// chrome.storage in user copy).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  hubStripText,
  keyPageFor,
  prefilledModelFor,
  recommendedProvider,
  useEnabled,
} from "../extension/lib/providers-view.js";

// The Settings provider presets, mirrored minimally for the helper tests.
const PRESETS = [
  { id: "openai", name: "OpenAI", recommended: true, needsKey: true },
  { id: "anthropic", name: "Anthropic", needsKey: true },
  { id: "gemini", name: "Google Gemini", alternative: true, needsKey: true },
  { id: "deepseek", name: "DeepSeek", needsKey: true },
  { id: "openai-compatible", name: "OpenAI-compatible", needsKey: true },
  { id: "ollama", name: "Ollama (local)", needsKey: false },
];

Deno.test("the recommended card is OpenAI with model gpt-5.6-luna pre-filled", () => {
  const rec = recommendedProvider(PRESETS);
  assert(rec, "a recommended provider is defined");
  assertEquals(rec.id, "openai");
  // A fresh profile (demo provider active, no stored model): the model field
  // pre-fills the catalogue default, never blank.
  assertEquals(prefilledModelFor(rec, { provider: "demo", model: "" }), "gpt-5.6-luna");
});

Deno.test("Use is disabled until Test passed (for a fresh keyed provider)", () => {
  // Fresh recommended card: not active, key required, no test yet → disabled.
  assertEquals(useEnabled({ testPassed: false, isActive: false, needsKey: true }), false);
  // Test passed → enabled.
  assertEquals(useEnabled({ testPassed: true, isActive: false, needsKey: true }), true);
  // A keyless local provider needs no test.
  assertEquals(useEnabled({ testPassed: false, isActive: false, needsKey: false }), true);
  // The already-active default keeps Update available.
  assertEquals(useEnabled({ testPassed: false, isActive: true, needsKey: true }), true);
});

Deno.test("Get a key links the recommended + alternative providers to their key page", () => {
  assertEquals(keyPageFor("openai"), "https://platform.openai.com/api-keys");
  assertEquals(keyPageFor("gemini"), "https://aistudio.google.com/apikey");
  assertEquals(keyPageFor("ollama"), ""); // a local server has no key page
});

Deno.test("the hub strip reads Ready — OpenAI · gpt-5.6-luna when a keyed provider can run", () => {
  assertEquals(
    hubStripText({ provider: "openai", ok: true, modelId: "gpt-5.6-luna" }, "OpenAI"),
    "Ready — OpenAI · gpt-5.6-luna",
  );
  // No model / not ready → the invitation, never the demo-provider notice.
  assertEquals(
    hubStripText({ provider: "demo", ok: true, modelId: "" }, "Demo"),
    "No model connected yet — pick one to start",
  );
  assertEquals(
    hubStripText({ provider: "openai", ok: false, modelId: "gpt-5.6-luna" }, "OpenAI"),
    "No model connected yet — pick one to start",
  );
});

// ── Structural guards on the built panel (retargeted from providers-tabs) ──
const root = new URL("../extension/options/", import.meta.url);
const html = await Deno.readTextFile(new URL("options.html", root));
const js = await Deno.readTextFile(new URL("options.js", root));

// ── the no-internal-API-in-user-copy pin (df8b55ea) ───────────────────────
// User copy says what the reader gets, never the API the extension calls: the
// Providers copy once read "stored locally in chrome.storage".
//
// EXEMPT — extension/privacy/privacy.html (owner ruling, 2026-10-06,
// chrome-agent-platform-zo5u: "privacy.html should be exempt and explicit
// about the apis used and where the data is used"). In a privacy disclosure,
// naming where data is stored is the point, not a leak: the reader has to be
// able to check the claim against the storage the extension really uses. The
// exemption covers THAT file only, and it is conditional — privacy.html must
// stay explicit about the APIs it stores with, which
// tests/privacy-page-716s12.test.ts pins against lib/factory-reset.js
// FACTORY_RESET_STORAGE_CLASSES (a class the page stops naming fails there).
// Every other user-facing file still fails this pin; the falsification test
// below drives a non-exempt file red with the pre-fix sentence.
const INTERNAL_API_IN_USER_COPY = /chrome\.storage/;

/** The user-facing files this pin exempts, each with the reason it may name an
 *  internal API. A second entry is a decision, not housekeeping: it means that
 *  file tells the reader which API the product calls. */
const USER_COPY_INTERNAL_API_EXEMPTIONS: Readonly<Record<string, string>> = {
  "extension/privacy/privacy.html":
    "a privacy disclosure — naming where data is stored is the point, not a leak (owner ruling 2026-10-06, chrome-agent-platform-zo5u)",
};

/** Every internal API name in `src`, or [] when `file` is an exempt
 *  disclosure. */
function internalApiNamesInUserCopy(file: string, src: string): string[] {
  if (file in USER_COPY_INTERNAL_API_EXEMPTIONS) return [];
  return [...src.matchAll(new RegExp(INTERNAL_API_IN_USER_COPY.source, "g"))].map((m) => m[0]);
}

Deno.test("the Providers copy never names chrome.storage", () => {
  assertEquals(
    internalApiNamesInUserCopy("extension/options/options.html", html),
    [],
    "options.html must not name chrome.storage in user copy",
  );
  assert(
    !/stored (?:locally )?in <code>chrome\.storage/.test(html),
    "the storage sentence must not point at chrome.storage",
  );
});

Deno.test("the pin exempts privacy.html, and only privacy.html, with a stated reason", async () => {
  assertEquals(
    Object.keys(USER_COPY_INTERNAL_API_EXEMPTIONS),
    ["extension/privacy/privacy.html"],
    "privacy.html is the documented exemption — a second exempt file is a decision, not housekeeping",
  );
  for (const [file, reason] of Object.entries(USER_COPY_INTERNAL_API_EXEMPTIONS)) {
    assert(/privacy disclosure/i.test(reason), `${file}'s exemption says what makes the file different`);
    assert(
      reason.includes("chrome-agent-platform-zo5u"),
      `${file}'s exemption names the ruling it rests on`,
    );
  }
  // The exemption is load-bearing, not blindness: the rule really does match
  // this page's copy, so deleting the entry above turns the pin red.
  const privacy = await Deno.readTextFile(new URL("../extension/privacy/privacy.html", import.meta.url));
  assert(
    INTERNAL_API_IN_USER_COPY.test(privacy),
    "privacy.html names the storage API — the pin would catch it without the exemption",
  );
  assertEquals(
    internalApiNamesInUserCopy("extension/privacy/privacy.html", privacy),
    [],
    "the exempt file reports nothing",
  );
});

Deno.test("falsification: the same rule still fails a NON-exempt user-facing file", async () => {
  // The pre-df8b55ea Providers sentence this pin was written for.
  const before = `<p class="muted">Your key is stored locally in <code>chrome.storage</code> on this device.</p>`;
  assert(
    internalApiNamesInUserCopy("extension/options/options.html", before).length > 0,
    "the unfixed Providers copy is reported",
  );
  const hub = "extension/ntp/ntp.html";
  assert(
    internalApiNamesInUserCopy(hub, before).length > 0,
    "a non-exempt user-facing surface is reported by the same rule",
  );
  assertEquals(
    internalApiNamesInUserCopy(hub, await Deno.readTextFile(new URL(`../${hub}`, import.meta.url))),
    [],
    "the hub really carries no internal API name in user copy today",
  );
});

Deno.test("the Providers panel is a family tablist + tabpanels (ARIA tabs pattern)", () => {
  // CAP-FB-20260902-PROVIDERS-TABBED-UI-01: the recommended-scroll layout was
  // replaced by one tab per provider family; the full family grouping and the
  // default-tab rule are unit-tested in tests/providers-family-tabs.test.ts.
  assertStringIncludes(html, `id="provider-tabs"`);
  assertStringIncludes(html, `id="provider-panels"`);
  assert(!html.includes(`id="provider-recommended"`), "the recommended-scroll container is gone");
  assert(!html.includes(`id="provider-more"`), "the More providers disclosure is gone");
  // Each card is a radio with a checked state and a roving tabindex.
  assertStringIncludes(js, `card.setAttribute("role", "radio")`);
  assertStringIncludes(js, `aria-checked`);
  // The default provider is indicated (the badge + accessible name).
  assertStringIncludes(js, `provider-badge`);
  // Panels are tabpanels labelled by their tab; not tab stops themselves.
  assertStringIncludes(js, `role", "tabpanel"`);
  assertStringIncludes(js, `aria-labelledby`);
  assert(!js.includes("panel.tabIndex = 0"), "the provider panel must not be a tab stop");
});

Deno.test("keyboard: arrow/Home/End move the radio selection", () => {
  assertStringIncludes(js, "ArrowDown");
  assertStringIncludes(js, "ArrowUp");
  assertStringIncludes(js, "Home");
  assertStringIncludes(js, "End");
});

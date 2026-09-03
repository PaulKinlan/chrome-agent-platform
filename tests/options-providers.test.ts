// CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01 — the recommended default
// provider and the four-click key flow. These test the PURE render helpers
// extracted from renderProviders (jsdom-free) and the structural guards the
// Providers panel must keep (recommended-first, radiogroup a11y, no
// chrome.storage in user copy).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  hubStripText,
  keyPageFor,
  leadingProviders,
  moreProviders,
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

Deno.test("the alternative leads second and points at Gemini gemini-3.7-flash", () => {
  const lead = leadingProviders(PRESETS);
  assertEquals(lead.map((p) => p.id), ["openai", "gemini"]);
  const gemini = lead[1];
  assertEquals(prefilledModelFor(gemini, { provider: "demo", model: "" }), "gemini-3.7-flash");
});

Deno.test("the other presets sit under More providers", () => {
  assertEquals(
    moreProviders(PRESETS).map((p) => p.id),
    ["anthropic", "deepseek", "openai-compatible", "ollama"],
  );
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

Deno.test("the Providers copy never names chrome.storage", () => {
  assert(!html.includes("chrome.storage"), "options.html must not name chrome.storage in user copy");
  assert(
    !/stored (?:locally )?in <code>chrome\.storage/.test(html),
    "the storage sentence must not point at chrome.storage",
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

// CAP-FB-20260902-PROVIDERS-TABBED-UI-01 — the Providers panel is a tabbed
// interface: one tab per provider FAMILY (Gemini, OpenAI-compatible,
// Anthropic, Local/Ollama). These test the PURE grouping/selection helpers in
// lib/providers-view.js; the DOM/ARIA behavior is covered by the browser KAT
// (scripts/kat-providers-tabs.ts).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  defaultFamilyId,
  familyForProvider,
  familyTabSlug,
  providerFamilies,
} from "../extension/lib/providers-view.js";

// The Settings provider presets, mirrored minimally for the helper tests.
const PRESETS = [
  { id: "openai", name: "OpenAI", recommended: true },
  { id: "anthropic", name: "Anthropic" },
  { id: "gemini", name: "Google Gemini", alternative: true },
  { id: "deepseek", name: "DeepSeek" },
  { id: "openai-compatible", name: "OpenAI-compatible" },
  { id: "ollama", name: "Ollama (local)" },
  { id: "lm-studio", name: "LM Studio (local)" },
];

Deno.test("providers group into exactly the four owner-named families, in order", () => {
  const families = providerFamilies(PRESETS);
  assertEquals(families.map((f) => f.id), ["gemini", "openai-compatible", "anthropic", "local"]);
  assertEquals(families.map((f) => f.label), ["Gemini", "OpenAI-compatible", "Anthropic", "Local/Ollama"]);
  assertEquals(families[0].providers.map((p) => p.id), ["gemini"]);
  assertEquals(families[1].providers.map((p) => p.id), ["openai", "deepseek", "openai-compatible"]);
  assertEquals(families[2].providers.map((p) => p.id), ["anthropic"]);
  assertEquals(families[3].providers.map((p) => p.id), ["ollama", "lm-studio"]);
});

Deno.test("the recommended provider leads its family", () => {
  const fam = providerFamilies(PRESETS).find((f) => f.id === "openai-compatible");
  assert(fam, "the openai-compatible family exists");
  assertEquals(fam.providers[0].id, "openai", "the recommended card leads its family's tab");
});

Deno.test("empty families produce no tab; empty input produces no tabs", () => {
  const only = providerFamilies([{ id: "ollama" }]);
  assertEquals(only.map((f) => f.id), ["local"]);
  assertEquals(providerFamilies([]), []);
  assertEquals(providerFamilies(null), []);
});

Deno.test("an unknown provider id lands in the generic OpenAI-compatible family", () => {
  assertEquals(familyForProvider("some-byo-endpoint"), "openai-compatible");
  assertEquals(familyForProvider(""), "openai-compatible");
  assertEquals(familyForProvider(null), "openai-compatible");
  assertEquals(familyForProvider("gemini"), "gemini");
  assertEquals(familyForProvider("lm-studio"), "local");
});

Deno.test("the default tab is the CURRENT default provider's family", () => {
  assertEquals(defaultFamilyId(PRESETS, "gemini"), "gemini");
  assertEquals(defaultFamilyId(PRESETS, "ollama"), "local");
  assertEquals(defaultFamilyId(PRESETS, "deepseek"), "openai-compatible");
});

Deno.test("a fresh profile (demo/internal provider active) leads with the recommended family", () => {
  // "demo" is not a public preset: the panel leads with the recommended
  // provider's family (OpenAI-compatible), never a blank or a hidden tab.
  assertEquals(defaultFamilyId(PRESETS, "demo"), "openai-compatible");
  assertEquals(defaultFamilyId(PRESETS, ""), "openai-compatible");
  assertEquals(defaultFamilyId([], "demo"), null);
});

Deno.test("the tab/panel slug rule is shared and stable", () => {
  assertEquals(familyTabSlug("Gemini"), "gemini");
  assertEquals(familyTabSlug("OpenAI-compatible"), "openai-compatible");
  assertEquals(familyTabSlug("Local/Ollama"), "local-ollama");
});

Deno.test("structural: options.html hosts a tablist slot and panels root, not the old scroll", async () => {
  const html = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
  assertStringIncludes(html, `id="provider-tabs"`);
  assertStringIncludes(html, `id="provider-panels"`);
  assert(!html.includes(`id="provider-recommended"`), "the recommended-scroll container is gone");
  assert(!html.includes(`id="provider-more"`), "the More providers disclosure is gone");
});

Deno.test("structural: options.js renders family tabs + tabpanels with ARIA wiring", async () => {
  const js = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
  assertStringIncludes(js, `"segmented-control"`, "the shared tablist component is used");
  assertStringIncludes(js, `controls-prefix`);
  assertStringIncludes(js, `role", "tabpanel"`);
  assertStringIncludes(js, `aria-labelledby`);
  assertStringIncludes(js, `providerFamilies(`, "grouping goes through the pure helper");
  // Switching tabs toggles panel visibility WITHOUT re-rendering cards, so
  // unsaved input survives the switch.
  assertStringIncludes(js, `panel.hidden =`);
});

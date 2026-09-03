// lib/providers-view.js — PURE view helpers for the Settings → Providers panel.
//
// No chrome.*, no DOM, no kv: the recommended-first ordering, the pre-filled
// model, the "Get a key" links, and the Use-enabled rule live here so the
// four-click flow is unit-testable without a browser
// (CAP-FB-20260830-PROVIDER-DEFAULT-AND-KEY-FLOW-01).

import { defaultModelFor } from "./model-catalog.js";

/** The provider key page each recommended/alternative card links to ("Get a
 * key"). A provider with no entry shows no link (a BYO/local endpoint has no
 * single key page). */
export const PROVIDER_KEY_URLS = Object.freeze({
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  anthropic: "https://console.anthropic.com/settings/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
});

/** The provider's key page, or "" when there is no single one to link to. */
export function keyPageFor(providerId) {
  return PROVIDER_KEY_URLS[String(providerId ?? "")] ?? "";
}

/** The provider the panel LEADS with (the recommended default). */
export function recommendedProvider(providers) {
  return (Array.isArray(providers) ? providers : []).find((p) => p?.recommended === true) ?? null;
}

/* ── Provider families (CAP-FB-20260902-PROVIDERS-TABBED-UI-01) ──
 * The Providers panel is a tabbed interface: one tab per provider FAMILY.
 * The grouping lives here (pure) so the tab order and the default-tab rule
 * are unit-testable without a browser. */
export const PROVIDER_FAMILIES = Object.freeze([
  { id: "gemini", label: "Gemini" },
  { id: "openai-compatible", label: "OpenAI-compatible" },
  { id: "anthropic", label: "Anthropic" },
  { id: "local", label: "Local/Ollama" },
]);

const PROVIDER_FAMILY_OF = Object.freeze({
  gemini: "gemini",
  anthropic: "anthropic",
  openai: "openai-compatible",
  deepseek: "openai-compatible",
  "openai-compatible": "openai-compatible",
  ollama: "local",
  "lm-studio": "local",
});

/** The family a provider id belongs to. Unknown ids land in the generic
 * OpenAI-compatible family (BYO endpoints are the catch-all shape), so a
 * preset missing from the map never orphans from the tab strip. */
export function familyForProvider(providerId) {
  return PROVIDER_FAMILY_OF[String(providerId ?? "")] ?? "openai-compatible";
}

/** The slug shared by a family tab's id and its panel's id, derived from the
 * tab LABEL. components.js <segmented-control> derives the same slug from the
 * same label when controls-prefix is set — the two must agree (the providers
 * tabs KAT asserts the aria-controls/aria-labelledby pair resolves). */
export function familyTabSlug(label) {
  return String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** The tabbed panel content: one entry per family that HAS providers, in the
 * fixed family order, members ordered recommended-first then alternative.
 * Empty families produce no tab. */
export function providerFamilies(providers) {
  const list = (Array.isArray(providers) ? providers : []).filter(Boolean);
  return PROVIDER_FAMILIES.map((f) => ({
    ...f,
    providers: list
      .filter((p) => familyForProvider(p.id) === f.id)
      .sort((a, b) =>
        Number(b?.recommended === true) - Number(a?.recommended === true) ||
        Number(b?.alternative === true) - Number(a?.alternative === true)
      ),
  })).filter((f) => f.providers.length > 0);
}

/** The tab a fresh render selects: the family of the CURRENT default provider
 * (the user lands on what is actually running), else the recommended
 * provider's family (a fresh profile leads with the recommended path), else
 * the first family. */
export function defaultFamilyId(providers, currentProviderId) {
  const families = providerFamilies(providers);
  if (!families.length) return null;
  const cur = String(currentProviderId ?? "");
  if (cur) {
    const curFamily = families.find((f) => f.providers.some((p) => p.id === cur));
    if (curFamily) return curFamily.id;
  }
  const rec = recommendedProvider(providers);
  if (rec) return familyForProvider(rec.id);
  return families[0].id;
}

/** The documented alternative (Gemini). */
export function alternativeProvider(providers) {
  return (Array.isArray(providers) ? providers : []).find((p) => p?.alternative === true) ?? null;
}

/** The providers that LEAD the panel: recommended first, alternative second,
 * in that fixed order. */
export function leadingProviders(providers) {
  const rec = recommendedProvider(providers);
  const alt = alternativeProvider(providers);
  return [rec, alt].filter(Boolean);
}

/** Everything under the "More providers" disclosure — neither recommended nor
 * the alternative, in their original order. */
export function moreProviders(providers) {
  return (Array.isArray(providers) ? providers : []).filter(
    (p) => p && !p.recommended && !p.alternative,
  );
}

/** The model id that PRE-FILLS a provider's model field: the stored model when
 * this provider is the active one, else the provider's catalogue default. Never
 * blank for a provider that HAS a catalogue default, so a fresh user can never
 * save a blank that would silently run the demo model. */
export function prefilledModelFor(provider, cfg) {
  const active = cfg?.provider === provider?.id;
  const stored = active ? String(cfg?.model ?? "").trim() : "";
  return stored || defaultModelFor(provider?.id) || "";
}

/** Whether the "Use" button is ENABLED. The four-click flow requires a passing
 * Test for the CURRENT key+model before Use commits — so a fresh card (no test
 * yet) has Use disabled, and editing the key or model resets that. Two exemptions
 * keep the panel usable: a keyless provider (demo / Prompt API / a local server)
 * needs no key test, and the CURRENTLY-ACTIVE default is already running, so its
 * "Update" stays available for a small edit. */
export function useEnabled({ testPassed = false, isActive = false, needsKey = true } = {}) {
  if (needsKey === false) return true;
  if (isActive === true) return true;
  return testPassed === true;
}

/** The hub strip copy: a working keyed provider reads "Ready — <Provider> ·
 * <model>"; anything else is the honest "no model connected yet" invitation.
 * `status` is the redacted provider.status payload (provider id, ok, modelId).
 * `label` maps the id to its display name. */
export function hubStripText(status, label) {
  if (status && status.ok === true && status.modelId) {
    return `Ready — ${label || status.provider || "provider"} · ${status.modelId}`;
  }
  return "No model connected yet — pick one to start";
}

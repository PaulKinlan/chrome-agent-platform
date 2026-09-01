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

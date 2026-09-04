// lib/first-run-model-prompt.js — the "Confirm a model to continue" decision
// (chrome-agent-platform-zbe5). When the owner pastes an API key in Settings →
// Providers but never confirms a model, nothing is saved and the first run
// silently produces demo answers. The key-entry flow must make the next step
// obvious: this module decides WHEN the prompt shows and WHICH model is
// suggested (the provider's catalogue default — the same default the run gate
// resolves, so the suggestion is exactly what would run). Pure: no DOM, no
// chrome.* — testable under Deno, consumed by options.js.

import { defaultModelFor } from "./model-catalog.js";

/**
 * Decide the prompt state for a provider card.
 * @param {{ providerId?: string, apiKey?: string, modelValue?: string, isActive?: boolean, needsKey?: boolean }} args
 *   providerId — the provider's id (e.g. "anthropic"); apiKey — the current
 *   key-field text; modelValue — the current committed model value; isActive —
 *   the provider is ALREADY the saved default; needsKey — the provider requires
 *   an API key.
 * @returns {{ show: boolean, suggestedModel: string, message: string }}
 * `show` is true exactly when a key is present, no model is confirmed, and
 * the provider is not already the saved default — i.e. the owner is mid-setup
 * and one step from walking away with nothing saved.
 */
export function modelPromptState({
  providerId = "",
  apiKey = "",
  modelValue = "",
  isActive = false,
  needsKey = true,
} = {}) {
  const hasKey = String(apiKey ?? "").trim().length > 0;
  const hasModel = String(modelValue ?? "").trim().length > 0;
  const suggestedModel = String(defaultModelFor(providerId) ?? "");
  const show = needsKey === true && hasKey && !hasModel && isActive !== true;
  const message = !show
    ? ""
    : suggestedModel
      ? `Confirm a model to continue — ${suggestedModel} is selected for you. Press Use to save it.`
      : "Confirm a model to continue — choose a model, then press Use to save it.";
  return Object.freeze({ show, suggestedModel, message });
}

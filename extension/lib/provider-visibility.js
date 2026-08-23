// lib/provider-visibility.js — one authority for public provider visibility.
//
// Demo and Chrome Prompt API remain valid INTERNAL runtime providers so stored
// global/per-agent selections and deterministic test runs keep working. They
// are not choices a user can newly select from Settings or /model.

export const INTERNAL_PROVIDER_IDS = Object.freeze(["demo", "prompt-api", "local-opfs"]);
export const INTERNAL_PROVIDER_ACTIVE_MESSAGE =
  "Internal testing provider active. Choose a listed provider to replace it.";

const INTERNAL_PROVIDER_ID_SET = new Set(INTERNAL_PROVIDER_IDS);

export function isInternalProviderId(value) {
  return INTERNAL_PROVIDER_ID_SET.has(String(value ?? ""));
}

/** Return the choices safe to advertise in user-facing provider pickers.
 * The input array and choice objects are never mutated. */
export function publicProviderChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices.filter((choice) => choice && !isInternalProviderId(choice.id));
}

/** Build a bounded, mutation-free view model for a stored provider selection.
 * A legacy internal selection remains effective in storage/runtime, but gets no
 * selectable public value and is explained truthfully beside the picker. */
export function providerSelectionPresentation(config, publicChoices) {
  const provider = String(config?.provider ?? "");
  const visible = Array.isArray(publicChoices) &&
    publicChoices.some((choice) => String(choice?.id ?? "") === provider);
  const hiddenInternal = isInternalProviderId(provider) && !visible;
  return {
    provider,
    hiddenInternal,
    selectValue: hiddenInternal ? "" : provider,
    message: hiddenInternal ? INTERNAL_PROVIDER_ACTIVE_MESSAGE : "",
  };
}

/** Apply the shared hidden-internal state to a status element. */
export function renderInternalProviderStatus(target, presentation) {
  if (!target) return;
  const show = presentation?.hiddenInternal === true;
  target.hidden = !show;
  target.textContent = show ? INTERNAL_PROVIDER_ACTIVE_MESSAGE : "";
}

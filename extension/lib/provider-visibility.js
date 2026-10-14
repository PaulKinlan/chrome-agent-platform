// lib/provider-visibility.js — one authority for public provider visibility and
// legacy removed-provider migration.
//
// Demo remains a valid INTERNAL runtime provider so stored global/per-agent
// selections and deterministic test runs keep working; it is not a choice a user
// can newly select from Settings or /model. Stored "prompt-api" configs from
// before the Chrome Prompt API provider was removed migrate cleanly to "demo"
// and surface a one-sentence notice when presented in Settings.

export const INTERNAL_PROVIDER_IDS = Object.freeze(["demo"]);
export const INTERNAL_PROVIDER_ACTIVE_MESSAGE =
  "No model connected yet — pick one to start.";
export const REMOVED_PROMPT_API_ID = "prompt-api";
export const REMOVED_PROMPT_API_NOTICE =
  "Chrome Prompt API was removed — switched to the local demo model; pick a provider below.";

const INTERNAL_PROVIDER_ID_SET = new Set(INTERNAL_PROVIDER_IDS);

export function isInternalProviderId(value) {
  return INTERNAL_PROVIDER_ID_SET.has(String(value ?? ""));
}

export function isRemovedProviderId(value) {
  return String(value ?? "").trim().toLowerCase() === REMOVED_PROMPT_API_ID;
}

/** Migrate a stored or incoming provider config whose provider is the removed
 * "prompt-api" preset (or already carries its migration stamp) to "demo"
 * without mutating the caller's object. */
export function migrateLegacyProviderConfig(config) {
  if (!config || typeof config !== "object") return config;
  const rawProvider = String(config.provider ?? "").trim();
  const fromRemoved = isRemovedProviderId(rawProvider) ||
    (rawProvider === "demo" && isRemovedProviderId(config.migratedFrom));
  if (fromRemoved) {
    const rawModel = String(config.model ?? "").trim();
    const model = rawModel === "gemini-nano" ? "demo-local" : String(config.model ?? "");
    return {
      ...config,
      provider: "demo",
      model,
      migratedFrom: REMOVED_PROMPT_API_ID,
      notice: REMOVED_PROMPT_API_NOTICE,
    };
  }
  if ("migratedFrom" in config || "notice" in config) {
    const { migratedFrom: _m, notice: _n, ...rest } = config;
    return rest;
  }
  return config;
}

/** Return the choices safe to advertise in user-facing provider pickers.
 * The input array and choice objects are never mutated. */
export function publicProviderChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices.filter((choice) =>
    choice && !isInternalProviderId(choice.id) && !isRemovedProviderId(choice.id)
  );
}

/** Build a bounded, mutation-free view model for a stored provider selection.
 * A legacy internal selection remains effective in storage/runtime, and a
 * removed "prompt-api" selection normalizes to "demo" with an honest one-sentence
 * notice beside the picker. */
export function providerSelectionPresentation(config, publicChoices) {
  const migrated = isRemovedProviderId(config?.provider) ||
    isRemovedProviderId(config?.migratedFrom);
  const provider = migrated ? "demo" : String(config?.provider ?? "");
  const visible = Array.isArray(publicChoices) &&
    publicChoices.some((choice) => String(choice?.id ?? "") === provider);
  const hiddenInternal = (isInternalProviderId(provider) || migrated) && !visible;
  const message = migrated
    ? REMOVED_PROMPT_API_NOTICE
    : (hiddenInternal ? INTERNAL_PROVIDER_ACTIVE_MESSAGE : "");
  return {
    provider,
    hiddenInternal,
    selectValue: hiddenInternal ? "" : provider,
    message,
    ...(migrated
      ? { migratedFrom: REMOVED_PROMPT_API_ID, notice: REMOVED_PROMPT_API_NOTICE }
      : {}),
  };
}

/** Apply the shared hidden-internal state to a status element. */
export function renderInternalProviderStatus(target, presentation) {
  if (!target) return;
  const show = presentation?.hiddenInternal === true;
  target.hidden = !show;
  target.textContent = show
    ? (presentation?.message || INTERNAL_PROVIDER_ACTIVE_MESSAGE)
    : "";
}

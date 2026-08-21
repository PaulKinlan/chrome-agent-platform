// lib/first-run-onboarding.js — pure first-run and credential-durability rules.
//
// This module never requests a permission on its own. The only request helper
// requires the native owner click and active user-activation object supplied by
// the Settings page; model/service-worker routes cannot mint that authority.

export const FIRST_RUN_TASK_PROMPT =
  'Create a text artifact named "First task" in the master scope with three concise ways I can use this agent hub.';

export function credentialNeedsDurableStorage(
  { enteredKey = "", storageGranted = false } = {},
) {
  return String(enteredKey).length > 0 && storageGranted !== true;
}

export function isGenuineOwnerClick(event, userActivation) {
  return event?.isTrusted === true && userActivation?.isActive === true;
}

/**
 * Request optional storage directly from a genuine owner click. There is no
 * await before permissions.request, so the browser receives the live gesture.
 */
export async function requestStorageFromOwnerClick({
  event,
  userActivation,
  permissionsApi,
} = {}) {
  if (!isGenuineOwnerClick(event, userActivation)) {
    return { granted: false, requested: false, reason: "owner-click-required" };
  }
  if (typeof permissionsApi?.request !== "function") {
    return {
      granted: false,
      requested: false,
      reason: "permissions-api-unavailable",
    };
  }
  try {
    const granted = await permissionsApi.request({ permissions: ["storage"] });
    return {
      granted: granted === true,
      requested: true,
      reason: granted === true ? "granted" : "denied",
    };
  } catch {
    return { granted: false, requested: true, reason: "request-failed" };
  }
}

export function keyedProviderConfigured(config) {
  const provider = String(config?.provider ?? "");
  if (
    !provider || provider === "demo" || provider === "prompt-api" ||
    provider === "ollama"
  ) return false;
  return String(config?.baseURL ?? "").trim().length > 0 &&
    String(config?.apiKey ?? "").length > 0 &&
    String(config?.model ?? "").trim().length > 0;
}

export function providerReadyForFirstTask(config) {
  const provider = String(config?.provider ?? "");
  if (
    !provider || provider === "demo" || provider === "prompt-api" ||
    provider === "ollama"
  ) {
    return false;
  }
  if (config?.configured === true) return true;
  return config?.hasApiKey === true &&
    String(config?.model ?? "").trim().length > 0;
}

export function firstRunGuideState({
  storageGranted = false,
  providerConfig = null,
  assets = [],
  dismissed = false,
} = {}) {
  const hasArtifact = Array.isArray(assets) && assets.length > 0;
  const providerReady = providerReadyForFirstTask(providerConfig);
  return {
    storageGranted: storageGranted === true,
    providerReady,
    hasArtifact,
    show: dismissed !== true && !hasArtifact,
    canSeedTask: storageGranted === true && providerReady,
  };
}

/** Load the first-run state without making zero-permission boot fragile. */
export async function loadFirstRunGuideState({
  containsStorage,
  readProvider,
  listArtifacts,
  dismissed = false,
} = {}) {
  const [storageGranted, providerConfig, assets] = await Promise.all([
    Promise.resolve().then(() => containsStorage?.()).catch(() => false),
    Promise.resolve().then(() => readProvider?.()).catch(() => null),
    Promise.resolve().then(() => listArtifacts?.()).catch(() => []),
  ]);
  return firstRunGuideState({
    storageGranted: storageGranted === true,
    providerConfig,
    assets: Array.isArray(assets) ? assets : [],
    dismissed,
  });
}

// lib/first-run-onboarding.js — pure first-run and credential-durability rules.
//
// This module never requests a permission on its own. The only request helper
// requires the native owner click and active user-activation object supplied by
// the Settings page; model/service-worker routes cannot mint that authority.

export const FIRST_RUN_TASK_PROMPT =
  'Create or update a text artifact named "First task" in the master scope with three concise ways I can use this agent hub. Call create_asset with the idempotency key "first-task" so a repeated run updates the same artifact instead of creating a duplicate.';

/** The swappable first-run example-agent catalogue (CAP-FB-20260823-FIRST-RUN-
 * EXAMPLE-AGENT-01). Each entry is a named agent the owner can OPT IN to create
 * during first run (an explicit owner action — never auto-created). The role is
 * a truthful capability description; `scheduleHint` is prose the owner can act
 * on later (Settings → Background agents) — no permission is requested here. */
export const FIRST_RUN_EXAMPLE_AGENTS = Object.freeze([
  Object.freeze({
    id: "weekly-browsing-review",
    name: "Weekly browsing review",
    role: "A weekly reviewer of the owner's activity in this hub: read the recent browser events, usage, and artifacts, then produce a concise plain-language summary of what happened and what is worth following up. To run it automatically on a schedule, the owner can add it in Settings → Background agents (alarms are granted at install).",
  }),
]);

export function firstRunExampleAgent(id) {
  return FIRST_RUN_EXAMPLE_AGENTS.find((a) => a.id === id) ?? null;
}

export function credentialNeedsDurableStorage(
  { enteredKey = "", storageGranted = false } = {},
) {
  return String(enteredKey).length > 0 && storageGranted !== true;
}

export function isGenuineOwnerClick(event, userActivation) {
  return event?.isTrusted === true && userActivation?.isActive === true;
}

/**
 * Verify the install-granted storage permission from a genuine owner click.
 * Storage is granted at install (manifest permissions) — there is no runtime
 * request left; this VERIFIES with contains() and fails CLOSED (a contains()
 * error is NOT granted). The genuine-click guard stays: the warning's action
 * must remain a deliberate owner gesture.
 */
export async function requestStorageFromOwnerClick({
  event,
  userActivation,
  permissionsApi,
} = {}) {
  if (!isGenuineOwnerClick(event, userActivation)) {
    return { granted: false, verified: false, reason: "owner-click-required" };
  }
  if (typeof permissionsApi?.contains !== "function") {
    return {
      granted: false,
      verified: false,
      reason: "permissions-api-unavailable",
    };
  }
  try {
    const granted = (await permissionsApi.contains({ permissions: ["storage"] })) === true;
    return {
      granted,
      verified: true,
      reason: granted ? "granted" : "not-granted-at-install",
    };
  } catch {
    return { granted: false, verified: true, reason: "verify-failed" };
  }
}

/**
 * Verify the install-granted browser-control permission (tabs) from a genuine
 * owner click. Granted at install — verifies with contains(), fails closed.
 */
export async function requestBrowserControlFromOwnerClick({
  event,
  userActivation,
  permissionsApi,
} = {}) {
  if (!isGenuineOwnerClick(event, userActivation)) {
    return { granted: false, verified: false, reason: "owner-click-required" };
  }
  if (typeof permissionsApi?.contains !== "function") {
    return {
      granted: false,
      verified: false,
      reason: "permissions-api-unavailable",
    };
  }
  try {
    const granted = (await permissionsApi.contains({ permissions: ["tabs"] })) === true;
    return {
      granted,
      verified: true,
      reason: granted ? "granted" : "not-granted-at-install",
    };
  } catch {
    return { granted: false, verified: true, reason: "verify-failed" };
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
  browserControlGranted = false,
  browserControlChoice = "unselected",
} = {}) {
  const hasArtifact = Array.isArray(assets) && assets.length > 0;
  const providerReady = providerReadyForFirstTask(providerConfig);
  return {
    storageGranted: storageGranted === true,
    providerReady,
    hasArtifact,
    show: dismissed !== true && !hasArtifact,
    canSeedTask: storageGranted === true && providerReady,
    browserControlGranted: browserControlGranted === true,
    browserControlChoice: ["granted", "declined", "unselected"].includes(browserControlChoice)
      ? browserControlChoice
      : (browserControlGranted ? "granted" : "unselected"),
  };
}

/** Load the first-run state without making zero-permission boot fragile. */
export async function loadFirstRunGuideState({
  containsStorage,
  containsBrowserControl,
  readProvider,
  listArtifacts,
  readBrowserChoice,
  dismissed = false,
} = {}) {
  const [storageGranted, browserControlGranted, providerConfig, assets, browserChoice] = await Promise.all([
    Promise.resolve().then(() => containsStorage?.()).catch(() => false),
    Promise.resolve().then(() => containsBrowserControl?.()).catch(() => false),
    Promise.resolve().then(() => readProvider?.()).catch(() => null),
    Promise.resolve().then(() => listArtifacts?.()).catch(() => []),
    Promise.resolve().then(() => readBrowserChoice?.()).catch(() => "unselected"),
  ]);
  return firstRunGuideState({
    storageGranted: storageGranted === true,
    browserControlGranted: browserControlGranted === true,
    browserControlChoice: browserChoice || (browserControlGranted ? "granted" : "unselected"),
    providerConfig,
    assets: Array.isArray(assets) ? assets : [],
    dismissed,
  });
}

// provider-options-save.js — production Settings provider-save sequencing.
//
// A host-permission request is optional and may leave Chrome's native prompt
// unresolved. The owner-selected provider configuration must still persist
// through provider.set; permission state is reported separately and never
// inferred from storage or a synthetic result.

export const PROVIDER_PERMISSION_PENDING_MS = 1_500;

export function providerFieldsFromCard(card, provider, currentConfig) {
  const active = currentConfig?.provider === provider.id;
  const enteredKey = card.querySelector(".api-key")?.value ?? "";
  const picker = card.querySelector("model-picker");
  const legacySelect = card.querySelector(".model-select");
  let model = "";
  if (picker) {
    // The Use/Test button paths read the committed value WITHOUT blurring the
    // picker first (a click that never moves focus away would drop typed text).
    // Commit typed-but-not-picked text BEFORE reading the value so the save
    // carries exactly what the owner typed (CAP-FB-20260830-MODEL-FIELD-EMPTY-SAVE-01).
    picker.commitTyped?.();
    // Read the component's committed public value exactly. In particular, do
    // not reconstruct a free-text value from its shadow input or catalogue.
    model = picker.value ?? "";
  } else if (legacySelect) {
    model = legacySelect.value === "__custom__"
      ? (card.querySelector(".model-custom")?.value || "")
      : legacySelect.value;
  } else {
    model = card.querySelector(".model")?.value || "";
  }
  return {
    baseURL: card.querySelector(".base-url")?.value ??
      (active
        ? (currentConfig?.baseURL || provider.baseURL)
        : provider.baseURL),
    apiKey: enteredKey || undefined,
    model,
  };
}

function deniedResult(error) {
  return {
    status: "denied",
    result: {
      granted: false,
      error: String(error?.message ?? error ?? "permission request failed"),
    },
  };
}

function normalizePermissionResult(result) {
  return result?.granted === true ? { status: "granted", result } : {
    status: "denied",
    result: result ?? { granted: false, error: "permission request failed" },
  };
}

async function boundedPermissionState(settled, pendingAfterMs) {
  let timer;
  try {
    return await Promise.race([
      settled,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "pending", result: null }),
          pendingAfterMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start the optional host request from the owner click, immediately persist the
 * exact DOM-derived config through provider.set, then wait only long enough to
 * report granted/denied/pending truthfully.
 */
export async function saveProviderFromCard({
  card,
  provider,
  currentConfig,
  requestHostAccess,
  sendMessage,
  pendingAfterMs = PROVIDER_PERMISSION_PENDING_MS,
}) {
  const fields = providerFieldsFromCard(card, provider, currentConfig);

  // Invocation order is security/product significant: begin the optional host
  // request while the click gesture is live, but DO NOT await its native prompt
  // before dispatching provider.set.
  let rawPermissionRequest;
  try {
    rawPermissionRequest = requestHostAccess(fields);
  } catch (error) {
    rawPermissionRequest = Promise.reject(error);
  }
  const permissionSettled = Promise.resolve(rawPermissionRequest)
    .then(normalizePermissionResult, deniedResult);

  const config = { provider: provider.id, ...fields };
  const saved = await sendMessage({ type: "provider.set", config });
  const access = await boundedPermissionState(
    permissionSettled,
    Math.max(0, pendingAfterMs),
  );

  return { access, config, saved, permissionSettled };
}

/** Bind the actual Settings Set/Update button to the production save route. */
export function bindProviderSetDefault({
  card,
  provider,
  currentConfig,
  requestHostAccess,
  sendMessage,
  pendingAfterMs,
  shouldBlock,
  onAccess,
  onSaved,
}) {
  const button = card.querySelector(".set-default");
  if (!button) return null;

  const handler = async (sourceEvent) => {
    // The durability guard is synchronous and runs before any host request or
    // provider.set dispatch. A blocked credential never enters session memory.
    if (shouldBlock?.(sourceEvent) === true) return { blocked: true };
    const outcome = await saveProviderFromCard({
      card,
      provider,
      currentConfig,
      requestHostAccess,
      sendMessage,
      pendingAfterMs,
    });
    await onAccess?.(outcome.access, outcome);
    if (outcome.access.status === "pending") {
      // Keep the native result live. A late grant/denial replaces pending with
      // the real outcome; this continuation never mutates provider storage.
      void outcome.permissionSettled.then((settled) =>
        onAccess?.(settled, outcome)
      );
    }
    await onSaved?.(outcome);
    return outcome;
  };
  button.addEventListener("click", handler);
  return handler;
}

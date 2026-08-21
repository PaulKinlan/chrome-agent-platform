import { providerRunGate } from "./provider-gate.js";

/**
 * Apply the production provider gate before a durable dispatch boundary.
 * Permission denial is recoverable authority, not a provider failure: retain
 * the exact accepted provider identity/scope, make the pause owner-visible,
 * and do not invoke dispatch while the run is paused.
 */
export async function dispatchDurableProviderRun({
  executionId,
  providerConfig,
  providerBinding,
  durableRuns,
  dispatch,
  runGate = providerRunGate,
}) {
  const gate = await runGate(providerConfig);
  if (!gate.ok) {
    if (gate.code === "permission_required") {
      const paused = await durableRuns.pauseForPermission(executionId, {
        code: gate.code,
        reason: gate.reason,
        requestedScope: gate.requestedScope,
        providerBinding,
      });
      return {
        ok: false,
        paused: true,
        pauseKind: "permission",
        executionId,
        run: paused,
        error: gate.reason,
        errorCategory: "permission",
        errorReason: gate.reason,
        errorAction:
          "Resolve the narrow provider permission in Settings; this run will resume automatically.",
      };
    }
    return {
      ok: false,
      providerBlocked: true,
      executionId,
      error: gate.reason,
      errorCategory: "provider",
      errorReason: gate.reason,
      errorAction: "Retry after the provider becomes available.",
    };
  }
  return await dispatch();
}

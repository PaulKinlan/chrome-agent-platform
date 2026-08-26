import { providerRunGate } from "./provider-gate.js";
import { capLog } from "./cap-log.js";
import { perfSpan } from "./cap-perf.js";

const dispatchLog = capLog("durable");

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
  const span = perfSpan("durable:dispatch");
  dispatchLog.info("dispatch start", { executionId });
  const gate = await runGate(providerConfig);
  if (!gate.ok) {
    span.end(gate.code === "permission_required" ? "paused" : "blocked");
    dispatchLog.warn("dispatch gated", { executionId, code: gate.code });
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
  try {
    const result = await dispatch();
    span.end("ok");
    dispatchLog.info("dispatch complete", { executionId });
    return result;
  } catch (e) {
    span.end("error");
    dispatchLog.error("dispatch failed", { executionId, error: e?.message ?? e });
    throw e;
  }
}

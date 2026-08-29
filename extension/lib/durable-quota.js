import { describeError } from "./error-report.js";
import { isNativeQuotaExceededError } from "./storage-errors.js";

/**
 * Convert a native storage-quota failure into the stable route response used by
 * both master tasks and direct delegation. This never mutates the exception:
 * browser DOMExceptions may be non-extensible.
 */
export function durableQuotaResponse(error, executionId) {
  if (!isNativeQuotaExceededError(error)) {
    throw new TypeError("durable quota response requires a native QuotaExceededError");
  }
  const desc = describeError(error);
  return {
    ok: false,
    errorCategory: "storage",
    errorReason: desc.reason,
    errorAction: desc.action,
    executionId,
  };
}

/**
 * Admit a durable run without rejecting the MV3 message channel for a native
 * quota refusal. start() owns failed-admission compensation; callers must not
 * invoke rollback when no readable run authority was established.
 */
export async function admitDurableRun(durableRuns, meta) {
  try {
    // Paid provider-tool identity must survive every durable resume. Older or
    // generic callers that omit it are UNKNOWN and therefore fail closed; an
    // explicit null/background identity remains null, while the hub must name
    // itself explicitly.
    const resumeRequest = meta?.resumeRequest;
    const normalizedMeta = resumeRequest && typeof resumeRequest === "object" &&
        !Object.prototype.hasOwnProperty.call(resumeRequest, "providerServerAgentId")
      ? { ...meta, resumeRequest: { ...resumeRequest, providerServerAgentId: null } }
      : meta;
    await durableRuns.start(normalizedMeta);
    return null;
  } catch (error) {
    if (!isNativeQuotaExceededError(error)) throw error;
    return durableQuotaResponse(error, meta.executionId);
  }
}

// lib/storage-errors.js — exact browser storage-failure predicates.

/**
 * Only the platform's native quota exception authorizes destructive quota
 * compensation. A provider error that merely contains the word "quota" must
 * never be allowed to delete durable execution state.
 */
export function isNativeQuotaExceededError(error) {
  return typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "QuotaExceededError";
}

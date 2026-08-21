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

/** Exact product-level storage quota predicate (key count, store bytes, global bytes, or native OPFS quota).
 * AI/tool wrappers may preserve the original error only in `cause`, so inspect that bounded chain;
 * never classify generic provider messages that merely mention quota. */
export function isMemoryKeyQuotaError(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1) {
    seen.add(current);
    if (
      current?.code === "memory_key_count_bound" ||
      current?.code === "memory_bytes_bound" ||
      current?.code === "memory_global_bound" ||
      current?.name === "MemoryStoreQuotaError" ||
      isNativeQuotaExceededError(current) ||
      /^key count exceeds/i.test(String(current?.message ?? "")) ||
      /exceeds the \d+-byte bound/i.test(String(current?.message ?? "")) ||
      /global memory exceeds/i.test(String(current?.message ?? ""))
    ) return true;
    current = current?.cause;
  }
  return false;
}

export const isMemoryStorageQuotaError = isMemoryKeyQuotaError;

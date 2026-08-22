// lib/tool-selection.js — in-memory, expiring shadow selection references.
//
// A selectionRef is a bounded diagnostic handle, not a permission, grant, or
// executable authority. Future execution must re-resolve every live source and
// perform its existing authorization/dispatch checks. This slice deliberately
// has no execute operation.

import { hasLoneSurrogates, truncateUtf8, utf8ByteLength } from "./pure.js";

export const TOOL_SELECTION_BOUNDS = Object.freeze({
  defaultTtlMs: 60 * 1000,
  maxTtlMs: 5 * 60 * 1000,
  maxSelectionsPerRun: 32,
  maxTotalSelections: 512,
  maxResultsPerSearch: 12,
  maxResponseBytes: 32 * 1024,
  maxFenceBytes: 256,
});

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeFence(value) {
  let text;
  if (typeof value !== "string") return "";
  text = value;
  if (hasLoneSurrogates(text)) return "";
  return truncateUtf8(
    text.normalize("NFKC").trim(),
    TOOL_SELECTION_BOUNDS.maxFenceBytes,
  );
}

function scopeContext(context) {
  return Object.freeze({
    runId: safeFence(ownData(context, "runId")),
    agentId: safeFence(ownData(context, "agentId")),
    origin: safeFence(ownData(context, "origin")),
    documentId: safeFence(ownData(context, "documentId")),
    catalogGeneration: safeFence(ownData(context, "catalogGeneration")),
  });
}

function scopeMatches(descriptor, context) {
  const scope = descriptor?.scope ?? {};
  if (scope.agentId && scope.agentId !== context.agentId) return false;
  if (scope.origin && scope.origin !== context.origin) return false;
  if (scope.documentId && scope.documentId !== context.documentId) return false;
  return true;
}

function randomSelectionRef() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `sel_${
    [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")
  }`;
}

function sameContext(a, b) {
  return a.runId === b.runId && a.agentId === b.agentId &&
    a.origin === b.origin && a.documentId === b.documentId &&
    a.catalogGeneration === b.catalogGeneration;
}

function packageIdentity(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return "";
  return [
    descriptor.packageId,
    descriptor.version,
    descriptor.digest,
    descriptor.capabilityDigest,
  ].map((value) => safeFence(value)).join("\u0000");
}

export class ToolSelectionAuthority {
  #records = new Map();
  #clock;
  #newRef;

  constructor({ clock = () => Date.now(), newRef = randomSelectionRef } = {}) {
    this.#clock = clock;
    this.#newRef = newRef;
  }

  #purge(now = this.#clock()) {
    for (const [selectionRef, record] of this.#records) {
      if (record.expiresAt <= now) this.#records.delete(selectionRef);
    }
    while (this.#records.size > TOOL_SELECTION_BOUNDS.maxTotalSelections) {
      const oldest = this.#records.keys().next().value;
      this.#records.delete(oldest);
    }
  }

  issue(searchOutput, contextInput, catalog, options = {}) {
    const now = this.#clock();
    this.#purge(now);
    const context = scopeContext(contextInput);
    if (!context.runId || !context.agentId || !context.catalogGeneration) {
      return Object.freeze({
        ok: false,
        error: "missing-selection-fence",
        results: [],
      });
    }
    if (
      context.catalogGeneration !== catalog?.generation ||
      searchOutput?.catalogGeneration !== catalog?.generation
    ) {
      return Object.freeze({
        ok: false,
        error: "stale-catalog-generation",
        results: [],
      });
    }
    const existingForRun =
      [...this.#records.values()].filter((record) =>
        record.context.runId === context.runId
      ).length;
    let remaining = Math.max(
      0,
      TOOL_SELECTION_BOUNDS.maxSelectionsPerRun - existingForRun,
    );
    const requestedTtl = Number(ownData(options, "ttlMs"));
    const boundedTtl = Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(Math.trunc(requestedTtl), TOOL_SELECTION_BOUNDS.maxTtlMs)
      : TOOL_SELECTION_BOUNDS.defaultTtlMs;
    const results = [];
    let responseBytes = 0;
    for (
      const result of (searchOutput?.results ?? []).slice(
        0,
        TOOL_SELECTION_BOUNDS.maxResultsPerSearch,
      )
    ) {
      if (remaining <= 0) break;
      const descriptor = catalog.byStableId?.[result.stableId];
      if (!descriptor || !scopeMatches(descriptor, context)) continue;
      // Disabled/stale entries remain visible in search diagnostics but never
      // receive a selection reference.
      if (descriptor.availability !== "ready") {
        const unavailable = Object.freeze({
          ...result,
          selectionRef: null,
          authorizes: false,
          requiresLiveAuthorization: true,
        });
        const bytes = utf8ByteLength(JSON.stringify(unavailable));
        if (responseBytes + bytes <= TOOL_SELECTION_BOUNDS.maxResponseBytes) {
          responseBytes += bytes;
          results.push(unavailable);
        }
        continue;
      }
      let selectionRef;
      for (let attempts = 0; attempts < 4; attempts++) {
        const candidate = safeFence(this.#newRef());
        if (
          /^sel_[a-f0-9]{36}$/u.test(candidate) && !this.#records.has(candidate)
        ) {
          selectionRef = candidate;
          break;
        }
      }
      if (!selectionRef) break;
      const expiresAt = now + boundedTtl;
      const projected = Object.freeze({
        ...result,
        selectionRef,
        expiresAt,
        authorizes: false,
        requiresLiveAuthorization: true,
      });
      const bytes = utf8ByteLength(JSON.stringify(projected));
      if (responseBytes + bytes > TOOL_SELECTION_BOUNDS.maxResponseBytes) break;
      this.#records.set(
        selectionRef,
        Object.freeze({
          selectionRef,
          stableId: descriptor.stableId,
          sourceGeneration: descriptor.sourceGeneration,
          packageIdentity: packageIdentity(descriptor),
          context,
          issuedAt: now,
          expiresAt,
        }),
      );
      responseBytes += bytes;
      results.push(projected);
      remaining--;
    }
    this.#purge(now);
    return Object.freeze({
      ok: true,
      catalogGeneration: catalog.generation,
      results: Object.freeze(results),
      diagnostics: Object.freeze({
        returned: results.length,
        responseBytes,
        activeSelections: this.#records.size,
      }),
    });
  }

  resolve(selectionRefInput, contextInput, catalog) {
    const now = this.#clock();
    this.#purge(now);
    const selectionRef = safeFence(selectionRefInput);
    const context = scopeContext(contextInput);
    const record = this.#records.get(selectionRef);
    if (!record) {
      return Object.freeze({
        ok: false,
        error: "selection-missing-or-expired",
      });
    }
    if (!sameContext(record.context, context)) {
      return Object.freeze({ ok: false, error: "selection-scope-mismatch" });
    }
    if (catalog?.generation !== context.catalogGeneration) {
      return Object.freeze({ ok: false, error: "selection-catalog-stale" });
    }
    const descriptor = catalog.byStableId?.[record.stableId];
    if (
      !descriptor || descriptor.sourceGeneration !== record.sourceGeneration ||
      packageIdentity(descriptor) !== record.packageIdentity ||
      descriptor.availability !== "ready" || !scopeMatches(descriptor, context)
    ) {
      return Object.freeze({ ok: false, error: "selection-source-stale" });
    }
    return Object.freeze({
      ok: true,
      descriptor,
      selectionRef,
      expiresAt: record.expiresAt,
      authorizes: false,
      requiresLiveAuthorization: true,
    });
  }

  diagnostics() {
    this.#purge();
    const runs = new Set(
      [...this.#records.values()].map((record) => record.context.runId),
    );
    return Object.freeze({
      activeSelections: this.#records.size,
      activeRuns: runs.size,
      grantsCreated: 0,
      executableRoutesCreated: 0,
    });
  }
}

// lib/tool-selection.js — in-memory, expiring shadow selection references.
//
// A selectionRef is a bounded diagnostic handle, not a permission, grant, or
// executable authority. Future execution must re-resolve every live source and
// perform its existing authorization/dispatch checks. This slice deliberately
// has no execute operation.
//
// BOUNDED REUSE (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01): a ref works for
// EVERY call of its tool within its run until it expires or reaches
// maxUsesPerSelection. Single-use bought no security — a ref authorizes
// nothing and every execute re-authorizes live — but it forced a search_tools
// round-trip before every call (two model steps per action) and turned the
// model's retry after a failed tool call into `selection-replayed`. A claim
// counts one use; a call that never dispatched, or dispatched and failed, hands
// its use back (release). The run/task/agent/origin/document/generation fences
// and the catalog/source staleness checks are unchanged.

import { hasLoneSurrogates, truncateUtf8, utf8ByteLength } from "./pure.js";

export const TOOL_SELECTION_BOUNDS = Object.freeze({
  // A 30-tab loop takes longer than a minute: refs live 10 min (max 15).
  defaultTtlMs: 10 * 60 * 1000,
  maxTtlMs: 15 * 60 * 1000,
  maxSelectionsPerRun: 128,
  maxTotalSelections: 512,
  maxResultsPerSearch: 12,
  maxResponseBytes: 32 * 1024,
  maxFenceBytes: 256,
  // How many execute calls one ref may serve (a use is given back when the
  // call never ran or failed).
  maxUsesPerSelection: 64,
});

/** Plain-English sibling for every error token — the sentence the model and
 * the owner read, with the next action. The token stays for tests/logs. */
const SELECTION_ERROR_MESSAGES = Object.freeze({
  "selection-replayed":
    `This selection reference has been used ${TOOL_SELECTION_BOUNDS.maxUsesPerSelection} times; call search_tools once more for a fresh one and continue.`,
  "selection-missing-or-expired":
    `This selection reference is unknown or has expired (a reference lasts ${Math.round(TOOL_SELECTION_BOUNDS.defaultTtlMs / 60000)} minutes); call search_tools again for a fresh one.`,
  "selection-scope-mismatch":
    "This selection reference belongs to a different run, agent, or page; call search_tools in this run for a fresh one.",
  "selection-catalog-stale":
    "The tool catalog changed since this reference was issued; call search_tools again for a fresh one.",
  "selection-source-stale":
    "The tool behind this reference changed or is no longer available; call search_tools again to see whether it is still offered.",
  "missing-selection-fence":
    "This run has no selection fence (no run, task, agent or catalog identity), so no reference can be issued; retry search_tools from inside a run.",
  "stale-catalog-generation":
    "The tool catalog changed while searching; call search_tools again.",
});

export function selectionErrorMessage(code) {
  return SELECTION_ERROR_MESSAGES[code] ?? "This selection reference cannot be used; call search_tools again for a fresh one.";
}

/** The failure shape every selection path returns: the token AND a sentence. */
export function selectionError(code, extra = null) {
  return Object.freeze({
    ok: false,
    error: code,
    message: selectionErrorMessage(code),
    ...(extra && typeof extra === "object" ? extra : {}),
  });
}

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
    taskId: safeFence(ownData(context, "taskId")),
    agentId: safeFence(ownData(context, "agentId")),
    origin: safeFence(ownData(context, "origin")),
    documentId: safeFence(ownData(context, "documentId")),
    runGeneration: safeFence(ownData(context, "runGeneration")),
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
  return a.runId === b.runId && a.taskId === b.taskId &&
    a.agentId === b.agentId && a.origin === b.origin &&
    a.documentId === b.documentId &&
    a.runGeneration === b.runGeneration &&
    a.catalogGeneration === b.catalogGeneration;
}

function packageIdentity(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return "";
  return [
    descriptor.packageId,
    descriptor.version,
    descriptor.digest,
    descriptor.packageDigest,
    descriptor.capabilityDigest,
    descriptor.permissionDigest,
    descriptor.grantDigest,
    descriptor.closureGeneration,
  ].map((value) => safeFence(value)).join("\u0000");
}

export class ToolSelectionAuthority {
  #records = new Map();
  #consumed = new Map();
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
    for (const [selectionRef, expiresAt] of this.#consumed) {
      if (expiresAt <= now) this.#consumed.delete(selectionRef);
    }
    while (this.#records.size > TOOL_SELECTION_BOUNDS.maxTotalSelections) {
      const oldest = this.#records.keys().next().value;
      this.#records.delete(oldest);
    }
    while (this.#consumed.size > TOOL_SELECTION_BOUNDS.maxTotalSelections) {
      const oldest = this.#consumed.keys().next().value;
      this.#consumed.delete(oldest);
    }
  }

  issue(searchOutput, contextInput, catalog, options = {}) {
    const now = this.#clock();
    this.#purge(now);
    const context = scopeContext(contextInput);
    if (
      !context.runId || !context.taskId || !context.agentId ||
      !context.runGeneration || !context.catalogGeneration
    ) {
      return selectionError("missing-selection-fence", { results: [] });
    }
    if (
      context.catalogGeneration !== catalog?.generation ||
      searchOutput?.catalogGeneration !== catalog?.generation
    ) {
      return selectionError("stale-catalog-generation", { results: [] });
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
          /^sel_[a-f0-9]{36}$/u.test(candidate) &&
          !this.#records.has(candidate) && !this.#consumed.has(candidate)
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
          uses: 0,
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
      return selectionError(
        this.#consumed.has(selectionRef)
          ? "selection-replayed"
          : "selection-missing-or-expired",
      );
    }
    if (!sameContext(record.context, context)) {
      return selectionError("selection-scope-mismatch");
    }
    if (catalog?.generation !== context.catalogGeneration) {
      return selectionError("selection-catalog-stale");
    }
    const descriptor = catalog.byStableId?.[record.stableId];
    if (
      !descriptor || descriptor.sourceGeneration !== record.sourceGeneration ||
      packageIdentity(descriptor) !== record.packageIdentity ||
      descriptor.availability !== "ready" || !scopeMatches(descriptor, context)
    ) {
      return selectionError("selection-source-stale");
    }
    return Object.freeze({
      ok: true,
      descriptor,
      selectionRef,
      expiresAt: record.expiresAt,
      uses: record.uses,
      authorizes: false,
      requiresLiveAuthorization: true,
    });
  }

  /** Count one use of a live reference. The ref STAYS live for the same tool
   * (bounded reuse); the claim records which use it was so release() can hand
   * exactly that use back. The maxUsesPerSelection-th use is the last: the next
   * claim retires the ref into #consumed so the error stays honest
   * (`selection-replayed`, "used 64 times"), never "missing". */
  claim(selectionRefInput, contextInput, catalog) {
    const resolved = this.resolve(selectionRefInput, contextInput, catalog);
    if (!resolved.ok) return resolved;
    const selectionRef = resolved.selectionRef;
    const record = this.#records.get(selectionRef);
    if (!record) return selectionError("selection-replayed");
    if (record.uses >= TOOL_SELECTION_BOUNDS.maxUsesPerSelection) {
      this.#records.delete(selectionRef);
      this.#consumed.set(selectionRef, record.expiresAt);
      return selectionError("selection-replayed");
    }
    const use = record.uses + 1;
    this.#records.set(selectionRef, Object.freeze({ ...record, uses: use }));
    return Object.freeze({
      ...resolved,
      uses: use,
      claim: Object.freeze({
        selectionRef,
        stableId: record.stableId,
        sourceGeneration: record.sourceGeneration,
        packageIdentity: record.packageIdentity,
        context: record.context,
        expiresAt: record.expiresAt,
        use,
      }),
    });
  }

  /** Hand a claimed USE back when the call never reached dispatch (argument
   * validation failed — CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01) or
   * dispatched and FAILED (CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01): a loop
   * that fails on 29 of 30 items must not burn its ref on the failures. Only
   * the LATEST use can come back (a concurrent later claim keeps its count),
   * exactly once, never after expiry, never for a ref this authority did not
   * claim. A ref retired at the use bound is restored to its last use when its
   * final claim is released. Returns true when a use was handed back. */
  release(claimInput) {
    const now = this.#clock();
    this.#purge(now);
    const claim = claimInput && typeof claimInput === "object" ? claimInput : {};
    const selectionRef = safeFence(ownData(claim, "selectionRef"));
    const expiresAt = Number(ownData(claim, "expiresAt"));
    const use = Number(ownData(claim, "use"));
    if (!/^sel_[a-f0-9]{36}$/u.test(selectionRef)) return false;
    if (!(expiresAt > now)) return false;
    if (!Number.isInteger(use) || use < 1 || use > TOOL_SELECTION_BOUNDS.maxUsesPerSelection) return false;
    const live = this.#records.get(selectionRef);
    if (live) {
      // Only this exact record (same expiry) and only its latest use.
      if (live.expiresAt !== expiresAt || live.uses !== use) return false;
      this.#records.set(selectionRef, Object.freeze({ ...live, uses: use - 1 }));
      return true;
    }
    // Only a ref this authority retired with this exact expiry comes back.
    if (this.#consumed.get(selectionRef) !== expiresAt) return false;
    if (use !== TOOL_SELECTION_BOUNDS.maxUsesPerSelection) return false;
    const context = scopeContext(ownData(claim, "context"));
    const stableId = ownData(claim, "stableId");
    const sourceGeneration = ownData(claim, "sourceGeneration");
    if (typeof stableId !== "string" || typeof sourceGeneration !== "string") {
      return false;
    }
    this.#consumed.delete(selectionRef);
    this.#records.set(
      selectionRef,
      Object.freeze({
        selectionRef,
        stableId,
        sourceGeneration,
        packageIdentity: ownData(claim, "packageIdentity"),
        context,
        issuedAt: now,
        expiresAt,
        uses: use - 1,
      }),
    );
    return true;
  }

  revalidateClaim(claimInput, contextInput, catalog) {
    const now = this.#clock();
    this.#purge(now);
    const claim = claimInput && typeof claimInput === "object" ? claimInput : {};
    const context = scopeContext(contextInput);
    if (Number(ownData(claim, "expiresAt")) <= now) {
      return selectionError("selection-missing-or-expired");
    }
    if (!sameContext(ownData(claim, "context"), context)) {
      return selectionError("selection-scope-mismatch");
    }
    if (catalog?.generation !== context.catalogGeneration) {
      return selectionError("selection-catalog-stale");
    }
    const descriptor = catalog.byStableId?.[safeFence(ownData(claim, "stableId"))];
    if (
      !descriptor ||
      descriptor.sourceGeneration !== ownData(claim, "sourceGeneration") ||
      packageIdentity(descriptor) !== ownData(claim, "packageIdentity") ||
      descriptor.availability !== "ready" || !scopeMatches(descriptor, context)
    ) {
      return selectionError("selection-source-stale");
    }
    return Object.freeze({
      ok: true,
      descriptor,
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

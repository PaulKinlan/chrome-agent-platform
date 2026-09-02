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

/** The tool a descriptor names, INDEPENDENT of the owner's current grants: a
 * descriptor's stableId hashes its permission/grant digests, so the same tool
 * gets a new stableId (and the catalog a new generation) the moment the owner
 * approves a capability. Everything that identifies WHICH closure would run —
 * source kind, package, tool id, version, package + capability digests, scope,
 * source and closure generation — is kept; only the grant/permission digests
 * (re-checked live by the protocol's authority step) and the descriptor
 * digest that folds them in are left out. Runtime-only: the model never sees
 * this key (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01). */
export function toolIdentityKey(descriptor) {
  if (!descriptor || typeof descriptor !== "object") return "";
  const scope = descriptor.scope && typeof descriptor.scope === "object" ? descriptor.scope : {};
  return [
    descriptor.sourceKind,
    descriptor.packageId,
    descriptor.toolId,
    descriptor.version,
    descriptor.packageDigest,
    descriptor.capabilityDigest,
    descriptor.sourceGeneration,
    descriptor.closureGeneration,
    scope.agentId,
    scope.origin,
    scope.documentId,
    scope.hub === true ? "hub" : "",
  ].map((value) => safeFence(value)).join("\u0000");
}

/** The run fence of a context WITHOUT the catalog generation — the part of a
 * selection's scope that an owner grant must never change. */
function sameRunFence(a, b) {
  return a.runId === b.runId && a.taskId === b.taskId &&
    a.agentId === b.agentId && a.origin === b.origin &&
    a.documentId === b.documentId &&
    a.runGeneration === b.runGeneration;
}

/** The single descriptor in `catalog` that names the same tool as
 * `identityKey` (see toolIdentityKey), or null when none/ambiguous. */
export function descriptorByIdentity(catalog, identityKey) {
  if (!identityKey) return null;
  let found = null;
  for (const descriptor of catalog?.descriptors ?? []) {
    if (toolIdentityKey(descriptor) !== identityKey) continue;
    if (found) return null;
    found = descriptor;
  }
  return found;
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
          toolIdentity: toolIdentityKey(descriptor),
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
        error: this.#consumed.has(selectionRef)
          ? "selection-replayed"
          : "selection-missing-or-expired",
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

  claim(selectionRefInput, contextInput, catalog) {
    const resolved = this.resolve(selectionRefInput, contextInput, catalog);
    if (!resolved.ok) return resolved;
    const selectionRef = resolved.selectionRef;
    const record = this.#records.get(selectionRef);
    if (!record) return Object.freeze({ ok: false, error: "selection-replayed" });
    this.#records.delete(selectionRef);
    this.#consumed.set(selectionRef, record.expiresAt);
    return Object.freeze({
      ...resolved,
      claim: Object.freeze({
        selectionRef,
        stableId: record.stableId,
        sourceGeneration: record.sourceGeneration,
        packageIdentity: record.packageIdentity,
        toolIdentity: record.toolIdentity,
        context: record.context,
        expiresAt: record.expiresAt,
      }),
    });
  }

  /** Hand a claimed reference back when the claim never reached dispatch
   * (argument validation failed — CAP-FB-20260830-SELECTION-REF-VALIDATE-FIRST-01).
   * The model repairs its arguments and retries with the SAME ref; the
   * operating manual forbids a second search. Restores the identical record
   * exactly once, never after expiry, never for a ref that was not claimed
   * from this authority. Returns true when the ref is live again. */
  release(claimInput) {
    const now = this.#clock();
    this.#purge(now);
    const claim = claimInput && typeof claimInput === "object" ? claimInput : {};
    const selectionRef = safeFence(ownData(claim, "selectionRef"));
    const expiresAt = Number(ownData(claim, "expiresAt"));
    if (!/^sel_[a-f0-9]{36}$/u.test(selectionRef)) return false;
    if (!(expiresAt > now)) return false;
    if (this.#records.has(selectionRef)) return false;
    // Only a ref this authority consumed with this exact expiry comes back.
    if (this.#consumed.get(selectionRef) !== expiresAt) return false;
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
        toolIdentity: ownData(claim, "toolIdentity"),
        context,
        issuedAt: now,
        expiresAt,
      }),
    );
    return true;
  }

  /** Re-key the live selections of ONE run after an owner grant regenerated
   * the catalog (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01). Every live
   * record issued under `previousContext` (the same run fence, the pre-grant
   * catalog generation) whose tool still exists in `catalog` — the same tool
   * identity (toolIdentityKey), ready, in scope — is re-recorded under
   * `nextContext` with the descriptor's NEW stableId/package identity, keeping
   * its selectionRef and expiry, so the references the model already holds
   * keep resolving. Records whose tool is gone are left to fail as stale.
   * Runtime-only: only the protocol's approval-resume path calls this, and
   * only for the run whose owner just approved. Returns the count re-keyed. */
  rebindAfterGrant(previousInput, nextInput, catalog) {
    const now = this.#clock();
    this.#purge(now);
    const previous = scopeContext(previousInput);
    const next = scopeContext(nextInput);
    if (!sameRunFence(previous, next)) return 0;
    if (!next.catalogGeneration || catalog?.generation !== next.catalogGeneration) return 0;
    if (previous.catalogGeneration === next.catalogGeneration) return 0;
    let rebound = 0;
    for (const [selectionRef, record] of [...this.#records]) {
      if (!sameContext(record.context, previous)) continue;
      const descriptor = descriptorByIdentity(catalog, record.toolIdentity);
      if (
        !descriptor || descriptor.availability !== "ready" ||
        !scopeMatches(descriptor, next)
      ) continue;
      this.#records.set(
        selectionRef,
        Object.freeze({
          ...record,
          stableId: descriptor.stableId,
          sourceGeneration: descriptor.sourceGeneration,
          packageIdentity: packageIdentity(descriptor),
          context: next,
        }),
      );
      rebound++;
    }
    return rebound;
  }

  /** Revalidate a claim ACROSS an owner grant that regenerated the catalog
   * while the claimed call was in flight (the paused call's sibling — issued
   * in the same model step, dispatched before the owner clicked Allow, and
   * revalidated after). Identical to revalidateClaim except that the catalog
   * generation may differ from the claim's and the descriptor is found by
   * its grant-independent tool identity rather than its stableId; the run
   * fence, expiry, availability and scope checks are unchanged, and the
   * protocol still re-authorizes the call live against the NEW descriptor's
   * digests before it trusts the outcome. Runtime-only: the protocol uses it
   * ONLY while the run has a permission pause in progress
   * (CAP-FB-20260901-APPROVAL-RESUME-REEXECUTES-01). */
  revalidateClaimAcrossGrant(claimInput, contextInput, catalog) {
    const now = this.#clock();
    this.#purge(now);
    const claim = claimInput && typeof claimInput === "object" ? claimInput : {};
    const context = scopeContext(contextInput);
    if (Number(ownData(claim, "expiresAt")) <= now) {
      return Object.freeze({ ok: false, error: "selection-missing-or-expired" });
    }
    const claimed = scopeContext(ownData(claim, "context"));
    if (!sameRunFence(claimed, context)) {
      return Object.freeze({ ok: false, error: "selection-scope-mismatch" });
    }
    if (catalog?.generation !== context.catalogGeneration) {
      return Object.freeze({ ok: false, error: "selection-catalog-stale" });
    }
    // The identity key is long (two digests plus generations) — never fenced
    // to maxFenceBytes, or it could not equal any descriptor's key.
    const toolIdentity = ownData(claim, "toolIdentity");
    const descriptor = descriptorByIdentity(catalog, typeof toolIdentity === "string" ? toolIdentity : "");
    if (
      !descriptor ||
      descriptor.sourceGeneration !== ownData(claim, "sourceGeneration") ||
      descriptor.availability !== "ready" || !scopeMatches(descriptor, context)
    ) {
      return Object.freeze({ ok: false, error: "selection-source-stale" });
    }
    return Object.freeze({
      ok: true,
      descriptor,
      authorizes: false,
      requiresLiveAuthorization: true,
    });
  }

  revalidateClaim(claimInput, contextInput, catalog) {
    const now = this.#clock();
    this.#purge(now);
    const claim = claimInput && typeof claimInput === "object" ? claimInput : {};
    const context = scopeContext(contextInput);
    if (Number(ownData(claim, "expiresAt")) <= now) {
      return Object.freeze({ ok: false, error: "selection-missing-or-expired" });
    }
    if (!sameContext(ownData(claim, "context"), context)) {
      return Object.freeze({ ok: false, error: "selection-scope-mismatch" });
    }
    if (catalog?.generation !== context.catalogGeneration) {
      return Object.freeze({ ok: false, error: "selection-catalog-stale" });
    }
    const descriptor = catalog.byStableId?.[safeFence(ownData(claim, "stableId"))];
    if (
      !descriptor ||
      descriptor.sourceGeneration !== ownData(claim, "sourceGeneration") ||
      packageIdentity(descriptor) !== ownData(claim, "packageIdentity") ||
      descriptor.availability !== "ready" || !scopeMatches(descriptor, context)
    ) {
      return Object.freeze({ ok: false, error: "selection-source-stale" });
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

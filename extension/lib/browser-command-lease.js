// lib/browser-command-lease.js — the SW-owned BROWSER-CONTROL SESSION LEASE
// (CAP-FB-20260826-BROWSER-SINGLE-DRIVER-01).
//
// Owner requirement: with many NTPs / surfaces open, ONLY ONE may issue
// destructive browser commands at a time. This module is the single-holder,
// durable, expiring lease authority. It lives in the SERVICE WORKER (the one
// always-present authority): a surface/worker must HOLD the lease to drive the
// browser; a competing caller gets an honest "another surface is driving the
// browser" result. Release is explicit (task end) OR expiry-based (the issuing
// surface closed without releasing) — expiry guarantees no deadlock and that a
// closed surface never permanently holds the lock.
//
// Durable (chrome.storage kv) so the lease SURVIVES the SW being killed and
// wakes with the correct holder — a killed SW must not forget who was driving.

import { capLog } from "./cap-log.js";

const LEASE_KEY = "cap:browser-command-lease";
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — matches the browser-control grant's default lifetime
const MAX_TTL_MS = 60 * 60 * 1000;     // hard cap: a lease can never exceed 1h

const log = capLog("browser-lease");

// A module-level mutex serializes the acquire / check-with-clear so two
// concurrent acquire calls can't both win (the check-then-act race).
let mutex = Promise.resolve();
function withLeaseLock(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

function newLeaseId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A lease record: { id, surfaceId, runId, expiresAt, acquiredAt }. */
function validLease(record) {
  return (
    !!record &&
    typeof record === "object" &&
    typeof record.id === "string" &&
    typeof record.surfaceId === "string" &&
    Number.isFinite(record.expiresAt)
  );
}

/** Read the current lease, clearing an EXPIRED one (expiry-based release). */
export async function readBrowserCommandLease(kvGet) {
  const s = await kvGet(LEASE_KEY);
  const record = s?.[LEASE_KEY];
  if (!validLease(record)) return null;
  if (record.expiresAt <= Date.now()) {
    // Expired — report absent with a marker (the caller treats `expired` as
    // absent and the next acquire clears it). No deadlock: the expired holder
    // is simply gone.
    return { ...record, expired: true };
  }
  return record;
}

/** Acquire the lease. Exactly one caller wins; others are honestly refused. */
export async function acquireBrowserCommandLease(kvGet, kvSet, {
  surfaceId,
  runId = null,
  ttlMs = DEFAULT_TTL_MS,
}) {
  const sid = String(surfaceId ?? "").slice(0, 200);
  if (!sid) return { ok: false, error: "missing surfaceId" };
  const ttl = Math.min(Math.max(Number(ttlMs) || DEFAULT_TTL_MS, 1000), MAX_TTL_MS);

  return withLeaseLock(async () => {
    const current = await readBrowserCommandLease(kvGet);
    if (current && !current.expired) {
      return {
        ok: false,
        error: "another surface is driving the browser",
        holder: { surfaceId: current.surfaceId, runId: current.runId ?? null, expiresAt: current.expiresAt },
      };
    }
    const lease = {
      id: newLeaseId(),
      surfaceId: sid,
      runId: runId ? String(runId).slice(0, 200) : null,
      expiresAt: Date.now() + ttl,
      acquiredAt: Date.now(),
    };
    await kvSet({ [LEASE_KEY]: lease });
    log.info("browser command lease acquired", { surfaceId: sid, runId: lease.runId, ttlMs: ttl });
    return { ok: true, lease };
  });
}

/** Release the lease — only the CURRENT holder may release (leaseId must match).
 * Idempotent: releasing when absent is a no-op success (not an error). */
export async function releaseBrowserCommandLease(kvGet, kvSet, leaseId) {
  return withLeaseLock(async () => {
    const current = await readBrowserCommandLease(kvGet);
    if (!current || current.expired) return { ok: true, released: false };
    if (String(leaseId ?? "") !== current.id) {
      return { ok: false, error: "not the current lease holder" };
    }
    await kvSet({ [LEASE_KEY]: null });
    log.info("browser command lease released", { surfaceId: current.surfaceId });
    return { ok: true, released: true };
  });
}

/** Hold the lease for a whole run: acquire → run → release in finally. Returns
 * { ok:false, error } on refusal, else the run's result with the lease released. */
export async function withBrowserCommandLease(kvGet, kvSet, { surfaceId, runId, ttlMs }, fn) {
  const acq = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId, runId, ttlMs });
  if (!acq.ok) return acq;
  try {
    return await fn(acq.lease);
  } finally {
    await releaseBrowserCommandLease(kvGet, kvSet, acq.lease.id).catch(() => {});
  }
}

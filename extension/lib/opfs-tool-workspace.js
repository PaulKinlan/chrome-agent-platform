// lib/opfs-tool-workspace.js — the SW-owned per-job OPFS tool workspace wrapper
// (CAP-FB-20260822-OPFS-TOOL-WORKSPACES-01, the reviewed v3 design, PASS).
//
// Wrapper-only vertical slice — NO tool execution route, NO provider binding,
// NO Wasm, NO package authority. Reuses the existing origin-keyed OPFS
// (navigator.storage.getDirectory) + the crash-safe artifact transaction
// authority (lib/artifacts.js) as the ONLY promotion path.
//
// Invariants (wrapper-enforced — OPFS has no mode/UID/chmod/symlink/fsync):
//   - strict ASCII normalized `tool-jobs/<execution>/<call>/` grammar
//   - the wrapper NEVER returns a writable handle for `inputs/*`; the input
//     projection writes `inputs/<sha256>.bin` ONCE (verify-before-write +
//     re-read hash verify + refuse a conflicting overwrite)
//   - every operation checks the exact execution/agent/origin/document/call
//     identity against the durable `.job`
//   - the current-SW promise-chain mutex is the ONLY serialization; every
//     operation recovers after a SW restart
//   - the crash-consistent `.quota.current`/`.quota.next` journal with
//     seq + prevSeq + prevDigest canonical state (higher valid next commits,
//     stale discards, corrupt/partial next retains current, missing/corrupt
//     current accepts next ONLY on the verifiable continuity against the
//     separate trusted `.quota.anchor` else QUARANTINE, overflow /
//     both-invalid FAIL CLOSED)
//   - applied idempotency keys are BOUNDED (MAX_APPLIED_KEYS) + GC'd only on
//     terminal/expired reservations while preserving the replay no-op
//   - byte/file reservations atomic; the per-ORIGIN storage pressure fails
//     closed
//   - promotion ONLY calls the keyed artifact transaction/WAL authority
//     (createAssetKeyed — stable promotion key + exact-token dedup +
//     rollback-safe); the wrapper never edits the artifact index
//   - the orphan GC removes ONLY strict validated job dirs (identity match +
//     terminal + expired), never a broad delete; an interrupted removal
//     resumes via the durable `.gc` marker
//   - `.job`/receipts/`.gc` carry metadata only — never args/secrets.

import { createAssetKeyed } from "./artifacts.js";
import { sha256HexBytes } from "./pure.js";

export const WORKSPACE_ROOT = "tool-jobs";
export const MAX_SEGMENT = 128;
export const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;
export const DEFAULT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FILES = 512;
export const MAX_APPLIED_KEYS = 256; // the bounded idempotency-key list
export const RESERVATION_TTL_MS = 30 * 60 * 1000;
export const GC_MARKER = ".gc";
export const ANCHOR_FILE = ".quota.anchor";
export const DEFAULT_GC_OLDER_THAN_MS = 24 * 60 * 60 * 1000;
export const TERMINAL_STATES = new Set(["closed", "completed", "failed", "cancelled", "expired"]);

const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RESERVED = new Set([
  "inputs", "scratch", "output", ".job", ".quota.current", ".quota.next", ".quota.anchor",
  ".cas", ".gc", ".", "..",
]);

function failClosed(name, detail) {
  const error = new Error(`workspace fail-closed: ${name}`);
  error.workspaceCode = name;
  error.detail = detail;
  return error;
}

function validSegment(segment) {
  if (typeof segment !== "string" || segment.length === 0 || segment.length > MAX_SEGMENT) return false;
  try { segment = decodeURIComponent(segment); } catch { return false; }
  if (RESERVED.has(segment)) return false;
  // ASCII-only: no Unicode, no lone surrogates, no control chars.
  for (const ch of segment) {
    const code = ch.codePointAt(0);
    if (code > 0x7f || code < 0x20) return false;
  }
  return SEGMENT_RE.test(segment);
}

function canonicalState(seq, prevSeq, prevDigest, bytesUsed, filesUsed, reservations, appliedKeys) {
  return { seq, prevSeq, prevDigest, bytesUsed, filesUsed, reservations, appliedKeys, updatedAt: Date.now() };
}

function parseState(raw) {
  try {
    const s = JSON.parse(raw);
    if (!Number.isSafeInteger(s?.seq) || s.seq < 0) return null;
    if (s.prevSeq != null && !Number.isSafeInteger(s.prevSeq)) return null;
    return s;
  } catch {
    return null;
  }
}

function parseAnchor(raw) {
  try {
    const a = JSON.parse(raw);
    if (!a || !Number.isSafeInteger(a.seq ?? -1)) return null;
    return a;
  } catch {
    return null;
  }
}

// The wrapper's CAS/digest contract is REAL SHA-256 over the bytes (hex) —
// never a hex encoding of the raw bytes. sha256HexBytes (lib/pure.js) is the
// one WebCrypto digest helper in the tree.

const HEX64_RE = /^[0-9a-f]{64}$/i;

/** The SW-owned workspace wrapper. The caller supplies the OPFS root accessor
 * (injectable for the fault shim) — the live path uses navigator.storage. */
export class OpfsToolWorkspace {
  constructor({ getRoot = null, getDirectory = null, artifactPromote = null, now = null, debug = false } = {}) {
    this._debug = debug;
    this._getRoot = getRoot;
    this._getDirectory = getDirectory ?? (() => navigator.storage.getDirectory());
    this._artifactPromote = artifactPromote ??
      ((name, type, content, key) => createAssetKeyed("master", { key, type, name, content }));
    this._now = now ?? (() => Date.now());
    this._mutex = Promise.resolve(); // the current-SW promise-chain mutex
  }

  _lock(fn) {
    const run = this._mutex.then(fn, fn);
    this._mutex = run.then(() => {}, () => {});
    return run;
  }

  async _root() {
    return this._getRoot ? await this._getRoot() : this._getDirectory();
  }

  async _jobDir(executionId, callIndex, { create = false } = {}) {
    if (!validSegment(executionId) || !validSegment(String(callIndex))) {
      throw failClosed("invalid_identity", { executionId, callIndex });
    }
    let root = await this._root();
    root = await root.getDirectoryHandle(WORKSPACE_ROOT, { create: create && true });
    const execDir = await root.getDirectoryHandle(executionId, { create: create && true });
    return await execDir.getDirectoryHandle(String(callIndex), { create: create && true });
  }

  /** The durable `.job` authority — every operation re-checks the exact
   * identities against the PATH (cross-path denial). */
  async _authorityJob(dir, { executionId, callIndex }) {
    const raw = await this._readJson(dir, ".job");
    if (raw == null) throw failClosed("job_missing");
    let job;
    try { job = JSON.parse(raw); } catch { throw failClosed("job_corrupt"); }
    if (String(job?.executionId ?? "") !== String(executionId) || String(job?.callIndex ?? "") !== String(callIndex)) {
      throw failClosed("job_identity_mismatch");
    }
    return job;
  }

  async _readJson(dir, name) {
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      const t = await file.text();
      if (this._debug) console.log("[debug] read", name, typeof t, JSON.stringify(String(t).slice(0, 60)));
      return t;
    } catch {
      return null;
    }
  }

  async _writeJson(dir, name, value) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(value));
    await w.close(); // close() is the ONLY completion signal (no fsync)
  }

  async _remove(dir, name) {
    try { await dir.removeEntry(name, { recursive: true }); } catch { /* absent is fine */ }
  }

  /** OPEN a job root: verify the identity authority + initialize the journal. */
  async openWorkspace({ executionId, callIndex, agent = null, origin = null, documentId = null, projected = [], quotas = {} } = {}) {
    return this._lock(async () => {
      if (!validSegment(executionId) || !validSegment(String(callIndex))) throw failClosed("invalid_identity");
      const jobDir = await this._jobDir(executionId, callIndex, { create: true });
      for (const sub of ["inputs", "scratch", "output"]) {
        await jobDir.getDirectoryHandle(sub, { create: true });
      }
      const job = {
        executionId, callIndex, agent, origin, documentId,
        state: "open", openedAt: this._now(), lastActivityAt: this._now(),
        projected: Array.isArray(projected) ? projected.map((p) => p.sha256) : [],
        quotas: {
          bytes: Number.isSafeInteger(quotas.bytes) ? quotas.bytes : DEFAULT_BYTES,
          files: Number.isSafeInteger(quotas.files) ? quotas.files : DEFAULT_FILES,
        },
      };
      await this._writeJson(jobDir, ".job", job);
      // Initialize the quota journal if absent (the initial parent identity is
      // the empty ledger: seq 0 / null digest).
      const current = await this._readJson(jobDir, ".quota.current");
      if (current == null) {
        const initial = canonicalState(1, 0, null, 0, 0, [], []);
        await this._writeJson(jobDir, ".quota.next", initial);
        await this._commitNext(jobDir, { seq: 0, prevSeq: null, prevDigest: null }, initial);
      }
      return { root: jobDir, job };
    });
  }

  async _moveNext(dir) {
    // moveEntry is interruptible — the recovery below is idempotent.
    await dir.moveEntry(".quota.next", ".quota.current").catch(() => {});
  }

  /** COMMIT a journal state: write the separate TRUSTED checkpoint anchor
   * ({ seq, digest } — the PARENT state's identity) BEFORE the move, then
   * move; after the commit the anchor records the NEW current's own identity
   * so the NEXT generation's continuity is verifiable too (best-effort — the
   * parent identity already landed first). */
  async _commitNext(dir, parentState, next) {
    const parentDigest = next.prevDigest ?? await sha256HexBytes(new TextEncoder().encode(JSON.stringify(parentState)));
    await this._writeJson(dir, ANCHOR_FILE, { seq: parentState.seq, digest: parentDigest });
    await this._moveNext(dir);
    await this._writeJson(dir, ANCHOR_FILE, {
      seq: next.seq, digest: await sha256HexBytes(new TextEncoder().encode(JSON.stringify(next))),
    }).catch(() => {});
  }

  /** The deterministic journal recovery (called under the mutex). */
  async _recoverJournal(dir) {
    const nextRaw = await this._readJson(dir, ".quota.next");
    const currentRaw = await this._readJson(dir, ".quota.current");
    const next = nextRaw == null ? null : parseState(nextRaw);
    const current = currentRaw == null ? null : parseState(currentRaw);

    if (current && next) {
      if (next.seq > current.seq) {
        // crash-after-close: the NEWER reservation is committed.
        await this._commitNext(dir, current, next);
        return await this._readCurrent(dir);
      }
      // stale/aborted next: discard it (the current is authoritative).
      await this._remove(dir, ".quota.next");
      return await this._readCurrent(dir);
    }
    if (current) {
      // a valid current with a corrupt/partial/absent next: retain the current.
      await this._remove(dir, ".quota.next");
      return await this._readCurrent(dir);
    }
    if (next) {
      // A valid next with a missing/corrupt current: commit ONLY on the
      // verifiable continuity — the separate trusted `.quota.anchor` must
      // match the next's PARENT identity (seq + full-state digest). Without
      // it the continuity is unverifiable → conservative QUARANTINE.
      const anchorRaw = await this._readJson(dir, ANCHOR_FILE);
      const anchor = anchorRaw == null ? null : parseAnchor(anchorRaw);
      if (anchor && anchor.seq === next.prevSeq && anchor.digest === next.prevDigest) {
        // The anchor already reflects the parent — the move completes the
        // commit; then re-anchor on the new current's own identity.
        await this._moveNext(dir);
        await this._writeJson(dir, ANCHOR_FILE, {
          seq: next.seq, digest: await sha256HexBytes(new TextEncoder().encode(JSON.stringify(next))),
        }).catch(() => {});
        return await this._readCurrent(dir);
      }
      throw failClosed("quota_continuity_unverifiable");
    }
    throw failClosed("quota_both_invalid");
  }

  async _readCurrent(dir) {
    const raw = await this._readJson(dir, ".quota.current");
    const state = raw == null ? null : parseState(raw);
    if (!state) throw failClosed("quota_current_invalid");
    // The job's quotas are the authority (stored in .job); the ledger may not
    // carry them (a first-write state).
    const jobRaw = await this._readJson(dir, ".job");
    const job = jobRaw ? JSON.parse(jobRaw) : {};
    state.bytesBudget = state.bytesBudget ?? job?.quotas?.bytes ?? DEFAULT_BYTES;
    state.filesBudget = state.filesBudget ?? job?.quotas?.files ?? DEFAULT_FILES;
    return state;
  }

  /** PROJECT a CAS input ONCE: SHA-256-verifies the bytes BEFORE any write,
   * writes the exact `inputs/<digest>.bin`, re-reads + hash-verifies the
   * landing, and REFUSES a conflicting overwrite. A same-digest replay is an
   * idempotent no-op; an empty leftover (an interrupted earlier projection) is
   * completed; different bytes under the same digest FAIL CLOSED. The source
   * is either `bytes` (Uint8Array/ArrayBuffer) or a `source` async CAS
   * reader (bytes || source — the OWNER supplies the bytes). */
  async projectInput({ executionId, callIndex, sha256, bytes = null, source = null }) {
    const digest = String(sha256 ?? "").toLowerCase();
    if (!HEX64_RE.test(digest)) throw failClosed("invalid_cas_sha");
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      const job = await this._authorityJob(dir, { executionId, callIndex }); // identity recheck
      if (!Array.isArray(job.projected) || !job.projected.includes(digest)) {
        throw failClosed("input_not_projected", { sha256: digest });
      }
      const data = bytes ?? (source ? await source() : null);
      if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) throw failClosed("input_bytes_required");
      const inputBytes = new Uint8Array(data);
      // SHA-256 VERIFY BEFORE the write — the CAS contract.
      if (await sha256HexBytes(inputBytes) !== digest) throw failClosed("input_hash_mismatch");
      const inputs = await dir.getDirectoryHandle("inputs", { create: true });
      const name = `${digest}.bin`;
      const existing = await inputs.getFileHandle(name).catch(() => null);
      if (existing) {
        const prev = new Uint8Array(await (await existing.getFile()).arrayBuffer());
        if (prev.byteLength === 0) {
          // an interrupted earlier projection: complete it (never a conflict).
        } else {
          const prevDigest = await sha256HexBytes(prev);
          if (prevDigest === digest) return { ok: true, deduped: true, sha256: digest };
          throw failClosed("input_conflict", { sha256: digest }); // refuse a different blob
        }
      }
      const fh = await inputs.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(inputBytes);
      await w.close(); // close() is the ONLY completion signal
      // RE-READ + hash-verify the landing.
      const re = new Uint8Array(await (await (await inputs.getFileHandle(name)).getFile()).arrayBuffer());
      if (await sha256HexBytes(re) !== digest) throw failClosed("input_write_verify_failed");
      return { ok: true, sha256: digest };
    });
  }

  /** Reserve bytes/files ATOMICALLY (the journal is the authority). The
   * idempotency key makes a replay a NO-OP (no duplicate seq effect). */
  async reserve({ executionId, callIndex, bytes = 0, files = 1, idempotencyKey = "" }) {
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      await this._authorityJob(dir, { executionId, callIndex });
      let state = await this._recoverJournal(dir);
      if (typeof idempotencyKey === "string" && idempotencyKey && state.appliedKeys?.includes(idempotencyKey)) {
        // The replay returns the SAME reservation record (its id — never the
        // array index).
        const prior = (state.reservations ?? []).find((r) => r.key === idempotencyKey);
        return { ok: true, deduped: true, reservationId: prior?.id ?? `r${state.appliedKeys.indexOf(idempotencyKey)}` };
      }
      // BOUNDED applied keys: GC the EXPIRED reservations' keys while
      // preserving the replay no-op, then refuse new keys at the cap (fail
      // closed).
      const now = this._now();
      const reservations = (state.reservations ?? []).filter((r) => r.expiresAt > now);
      const liveKeys = reservations.map((r) => r.key).filter((k) => typeof k === "string");
      let applied = (Array.isArray(state.appliedKeys) ? state.appliedKeys : [])
        .filter((k) => liveKeys.includes(k) || k === idempotencyKey);
      if (applied.length >= MAX_APPLIED_KEYS && !applied.includes(idempotencyKey)) throw failClosed("applied_keys_full");

      const total = state.bytesUsed + bytes;
      if (total > state.bytesBudget && state.bytesBudget != null) throw failClosed("quota_exceeded_bytes", { total });
      // Origin-wide pressure: the browser estimate is per-ORIGIN — a full
      // origin fails every job's reserve.
      try {
        const est = await navigator.storage?.estimate?.();
        if (Number.isFinite(est?.quota) && Number.isFinite(est?.usage) && est.usage + bytes > est.quota) {
          throw failClosed("origin_storage_pressure", { usage: est.usage, quota: est.quota });
        }
      } catch (e) {
        if (e?.workspaceCode === "origin_storage_pressure") throw e;
        // estimate unavailable → proceed; the write path still fails closed
      }
      if (state.filesUsed + files > (state.filesBudget ?? DEFAULT_FILES)) throw failClosed("quota_exceeded_files");

      const reservationId = `r${state.seq}`;
      const reservation = { id: reservationId, key: idempotencyKey, bytes, files, expiresAt: now + RESERVATION_TTL_MS };
      const next = canonicalState(
        state.seq + 1, state.seq, await sha256HexBytes(new TextEncoder().encode(JSON.stringify(state))),
        state.bytesUsed + bytes, state.filesUsed + files,
        [...reservations, reservation], [...applied, idempotencyKey],
      );
      next.bytesBudget = state.bytesBudget ?? (state.quotas?.bytes ?? DEFAULT_BYTES);
      next.filesBudget = state.filesBudget ?? (state.quotas?.files ?? DEFAULT_FILES);
      if (next.seq > MAX_SAFE_SEQ) throw failClosed("seq_overflow");
      await this._writeJson(dir, ".quota.next", next);
      await this._commitNext(dir, state, next);
      return { ok: true, reservationId, seq: next.seq };
    });
  }

  /** Release a reservation (idempotent + replay-safe). */
  async release({ executionId, callIndex, reservationId, idempotencyKey = "" }) {
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      await this._authorityJob(dir, { executionId, callIndex });
      let state = await this._recoverJournal(dir);
      const reservations = (state.reservations ?? []).filter((r) => r.id !== reservationId);
      if (reservations.length === (state.reservations ?? []).length) return { ok: true, deduped: true };
      const released = (state.reservations ?? []).find((r) => r.id === reservationId);
      const next = canonicalState(
        state.seq + 1, state.seq, await sha256HexBytes(new TextEncoder().encode(JSON.stringify(state))),
        Math.max(0, state.bytesUsed - (released?.bytes ?? 0)),
        Math.max(0, state.filesUsed - (released?.files ?? 0)),
        reservations, state.appliedKeys ?? [],
      );
      next.bytesBudget = state.bytesBudget; next.filesBudget = state.filesBudget;
      if (next.seq > MAX_SAFE_SEQ) throw failClosed("seq_overflow");
      await this._writeJson(dir, ".quota.next", next);
      await this._commitNext(dir, state, next);
      return { ok: true };
    });
  }

  /** Write a scratch/output file — the path/file/byte quotas enforced. */
  async writeFile({ executionId, callIndex, area, name, bytes }) {
    if (!validSegment(name)) throw failClosed("invalid_name", { name });
    if (area !== "scratch" && area !== "output") throw failClosed("invalid_area");
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      await this._authorityJob(dir, { executionId, callIndex });
      let state = await this._recoverJournal(dir);
      if (state.filesUsed + 1 > (state.filesBudget ?? DEFAULT_FILES)) throw failClosed("quota_exceeded_files");
      if (state.bytesUsed + bytes.length > (state.bytesBudget ?? DEFAULT_BYTES)) throw failClosed("quota_exceeded_bytes");
      const areaDir = await dir.getDirectoryHandle(area, { create: true });
      const fh = await areaDir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(bytes);
      await w.close();
      const next = canonicalState(
        state.seq + 1, state.seq, await sha256HexBytes(new TextEncoder().encode(JSON.stringify(state))),
        state.bytesUsed + bytes.length, state.filesUsed + 1,
        state.reservations ?? [], state.appliedKeys ?? [],
      );
      next.bytesBudget = state.bytesBudget; next.filesBudget = state.filesBudget;
      if (next.seq > MAX_SAFE_SEQ) throw failClosed("seq_overflow");
      await this._writeJson(dir, ".quota.next", next);
      await this._commitNext(dir, state, next);
      return { ok: true };
    });
  }

  /** Read an input — the WRAPPER never returns a writable input handle; the
   * content is hash-verified against the projected CAS sha256 + the sha must
   * be in the job's projected list (the authority recheck). */
  async readInput({ executionId, callIndex, sha256 }) {
    const digest = String(sha256 ?? "").toLowerCase();
    if (!HEX64_RE.test(digest)) throw failClosed("invalid_cas_sha");
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      const job = await this._authorityJob(dir, { executionId, callIndex });
      if (!Array.isArray(job.projected) || !job.projected.includes(digest)) {
        throw failClosed("input_not_projected", { sha256: digest });
      }
      const inputs = await dir.getDirectoryHandle("inputs", { create: false });
      const fh = await inputs.getFileHandle(`${digest}.bin`);
      const file = await fh.getFile();
      const data = await file.arrayBuffer();
      const actual = await sha256HexBytes(data);
      if (actual !== digest) throw failClosed("input_hash_mismatch", { actual });
      return new Uint8Array(data);
    });
  }

  /** Promote an output candidate ONLY through the KEYED artifact transaction
   * authority (createAssetKeyed — the stable promotion idempotency key +
   * exact-token dedup + rollback-safe); the wrapper never edits the index. */
  async promoteOutput({ executionId, callIndex, name, type = "data" }) {
    if (!validSegment(name)) throw failClosed("invalid_name");
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      await this._authorityJob(dir, { executionId, callIndex });
      const output = await dir.getDirectoryHandle("output", { create: false });
      const fh = await output.getFileHandle(name);
      const data = new Uint8Array(await (await fh.getFile()).arrayBuffer());
      // The artifact authority's content contract is a string (the memory
      // store is JSON-backed); the wrapper adapts the output bytes.
      const content = new TextDecoder().decode(data);
      // The STABLE promotion key: a bounded digest over the full promotion
      // identity (execution/call/name/digest) — a retry dedupes to the SAME
      // artifact (the keyed WAL create) regardless of the segment lengths.
      const digest = await sha256HexBytes(data);
      const key = `opfs:promote:${await sha256HexBytes(new TextEncoder().encode(`${executionId}\u0000${callIndex}\u0000${name}\u0000${digest}`))}`;
      const result = await this._artifactPromote(name, type, content, key);
      if (result?.ok === false) throw failClosed("promotion_failed", { error: result.error });
      return { ok: true, artifactTxRef: result, promotionKey: key };
    });
  }

  /** Interruption-safe close: the .job final state + the receipt metadata.
   * The job root is GC'd only by the orphan GC (explicit authority). */
  async closeWorkspace({ executionId, callIndex, outcome = "closed" }) {
    return this._lock(async () => {
      const dir = await this._jobDir(executionId, callIndex);
      const job = await this._authorityJob(dir, { executionId, callIndex });
      job.state = outcome;
      job.closedAt = this._now();
      await this._writeJson(dir, ".job", job);
      return { ok: true, receipt: { executionId, callIndex, outcome, closedAt: job.closedAt } };
    });
  }

  /** ORPHAN GC — explicit authority only. Scans ONLY the strict job dirs under
   * `tool-jobs/`, validates each `.job` (identity matches the PATH + terminal
   * + expired), marks the durable pending-GC `.gc` BEFORE the removal, and
   * removes idempotently + interruptibly. An interrupted removal leaves the
   * `.gc` marker (the pending-GC continuation) so the NEXT pass completes it.
   * Never a broad delete; a dir whose identity doesn't match its path is never
   * touched (cross-job denial). */
  async gcWorkspaces({ executionId = null, olderThanMs = DEFAULT_GC_OLDER_THAN_MS, terminalStates = null } = {}) {
    return this._lock(async () => {
      const now = this._now();
      const terminal = terminalStates ?? TERMINAL_STATES;
      if (executionId != null && !validSegment(executionId)) throw failClosed("invalid_identity", { executionId });
      let root = await this._root();
      const jobsRoot = await root.getDirectoryHandle(WORKSPACE_ROOT, { create: false }).catch(() => null);
      if (!jobsRoot) return { ok: true, scanned: 0, removed: 0 };
      const candidates = [];
      if (executionId != null) {
        const execDir = await jobsRoot.getDirectoryHandle(executionId, { create: false }).catch(() => null);
        if (execDir) {
          for await (const [callName, handle] of execDir.entries()) {
            if (handle?.kind === "directory" && validSegment(callName)) candidates.push({ execDir, callName });
          }
        }
      } else {
        for await (const [execName, execHandle] of jobsRoot.entries()) {
          if (execHandle?.kind !== "directory" || !validSegment(execName)) continue; // NEVER touch non-job entries
          for await (const [callName, callHandle] of execHandle.entries()) {
            if (callHandle?.kind === "directory" && validSegment(callName)) candidates.push({ execDir: execHandle, callName });
          }
        }
      }
      let removed = 0;
      for (const { execDir, callName } of candidates) {
        const callDir = await execDir.getDirectoryHandle(callName, { create: false }).catch(() => null);
        if (!callDir) continue; // already gone (an interrupted earlier pass)
        const jobRaw = await this._readJson(callDir, ".job");
        let job = null;
        if (jobRaw != null) { try { job = JSON.parse(jobRaw); } catch { job = null; } }
        const markerRaw = await this._readJson(callDir, GC_MARKER);
        let marker = null;
        if (markerRaw != null) { try { marker = JSON.parse(markerRaw); } catch { marker = null; } }
        let removable = false;
        if (job && String(job.executionId) === execDir.name && String(job.callIndex) === callName) {
          const isTerminal = job.state != null && terminal.has(String(job.state));
          const ts = job.closedAt ?? job.lastActivityAt;
          const expired = Number.isFinite(ts) && (now - ts) > olderThanMs;
          if (isTerminal && expired) removable = true;
        } else if (marker && String(marker.executionId) === execDir.name && String(marker.callIndex) === callName) {
          removable = true; // the pending-GC continuation (an interrupted removal)
        }
        if (!removable) continue; // cross-job denial + never a broad delete
        // The durable pending-GC marker BEFORE the removal (an interrupted
        // remove leaves the marker → the next pass completes the removal).
        await this._writeJson(callDir, GC_MARKER, { executionId: execDir.name, callIndex: callName, queuedAt: this._now() });
        try {
          await execDir.removeEntry(callName, { recursive: true });
          removed += 1;
        } catch {
          // Interrupted — the `.gc` marker persists for the next pass.
        }
      }
      return { ok: true, scanned: candidates.length, removed };
    });
  }
}

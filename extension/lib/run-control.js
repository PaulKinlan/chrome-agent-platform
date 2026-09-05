// extension/lib/run-control.js — the run-level control plane behind the task
// composer's STEER and QUEUE affordances (chrome-agent-platform-afiu).
//
// Two responsibilities, both pure-ish and unit-testable:
//
//  1. LIVE STEER — owner guidance delivered into an in-flight run BETWEEN
//     model steps. The SW registers every run it starts
//     (`register({executionId, threadId, ...})`); the owner's steer records a
//     bounded message under that execution; the run-loop seam (agent.js /
//     agent-loop.js) reads `pending()` at every model call and appends the
//     text as a user message in the outgoing call (the loop honors it between
//     steps — nothing is injected mid-tool-call). Modes:
//       - "inject"    — gentle guidance; rides every later model call.
//       - "stop-step" — inject AND stop the loop after the first model call
//                       that carried the text (no continuation steps).
//       - "stop-run"  — cancel the run outright (the route owns the cancel;
//                       the text — if any — becomes a queued follow-up so
//                       nothing the owner typed is lost).
//
//  2. THREAD QUEUE — the durable per-thread FIFO of follow-up messages the
//     agent processes AFTER the current run completes. Stored under one kv
//     key (`cap:threadQueues`) so a reload survives (chrome.storage.local or
//     the SW session fallback both outlive a page reload; the storage
//     backend is injectable for tests). Items are owner text: bounded,
//     redacted at the boundary, reorderable/removable, drained ONE item per
//     settled run (the SW fires each as a continuation turn of the thread).
//
// The module holds NO chrome.* / OPFS authority — the SW wires its kv and the
// run loop wires its seam. Everything is deterministic + bounded.

import { newId, redactSecretText } from "./pure.js";

const QUEUE_KEY = "cap:threadQueues";
const MAX_QUEUE_PER_THREAD = 16; // visible pending chips stay bounded
const MAX_QUEUE_TEXT = 1500; // chars per queued message (owner text, like a thread row)
const MAX_THREADS_QUEUED = 200; // kv value bound: never an unbounded map
const MAX_LIVE_RUNS = 64; // in-memory live-run registry bound
const MAX_PENDING_STEERS = 5; // per run: undelivered steers at most; PAST this → honest refusal
export const STEER_MODES = new Set(["inject", "stop-step", "stop-run"]);

/** Bounded, secret-redacted owner control text (the same redactor the thread
 * store uses — a credential echoed back at the owner must never reach a
 * durable control record). Pure. */
export function boundControlText(text, max = MAX_QUEUE_TEXT) {
  const s = String(text ?? "");
  const trimmed = s.trim();
  if (!trimmed) return "";
  const redacted = redactSecretText(trimmed);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/**
 * The live-run registry + steer authority. One instance per SW (in-memory —
 * a run's liveness is inherently non-durable; the DURABLE record of what ran
 * stays in the durable-runs registry).
 */
export function createRunControl({ now = () => Date.now() } = {}) {
  /** executionId → { threadId, surface, registeredAt } */
  const runs = new Map();
  /** executionId → Array<{ id, mode, text, at, injectedOnce }> (arrival order) */
  const steers = new Map();
  let tick = 0;
  const seq = () => `s${(++tick).toString(36)}${now().toString(36)}`;

  return Object.freeze({
    /** The SW registers a run when it starts executing. Returns the live
     * record, or null when the registry is full (the run still executes —
     * steering is simply unavailable for it). */
    register({ executionId, threadId = null, surface = null, kind = null }) {
      const id = String(executionId ?? "");
      if (!id || id.length > 200 || runs.has(id)) return null;
      if (runs.size >= MAX_LIVE_RUNS) return null;
      const record = {
        executionId: id,
        threadId: threadId ? String(threadId).slice(0, 200) : null,
        surface: surface ? String(surface).slice(0, 200) : null,
        // The run KIND is RETAINED (review r5 P1-1): the steer route branches
        // on kind === "worker" to route a steer through the worker protocol;
        // dropping it made every worker run steer through the SW store a
        // worker loop never reads (and left the branch unreachable).
        kind: kind ? String(kind).slice(0, 64) : null,
        registeredAt: now(),
      };
      runs.set(id, record);
      steers.set(id, []);
      return record;
    },

    unregister(executionId) {
      const id = String(executionId ?? "");
      const pending = steers.get(id) ?? [];
      steers.delete(id);
      const record = runs.get(id) ?? null;
      runs.delete(id);
      if (!record) return { ok: false, undelivered: [] };
      const undelivered = pending.filter((s) => s.injectedOnce !== true);
      return { ok: true, record, undelivered };
    },

    get(executionId) {
      const id = String(executionId ?? "");
      return runs.get(id) ?? null;
    },

    /** Owner steer against a LIVE run. `text` may be empty for a bare
     * stop-run (Stop with no message). Returns {ok, steer} or {ok:false}. */
    steer({ executionId, mode = "inject", text = "" }) {
      const id = String(executionId ?? "");
      const record = runs.get(id);
      if (!record) return { ok: false, error: "run_not_live", executionId: id };
      if (!STEER_MODES.has(mode)) return { ok: false, error: "invalid_steer_mode" };
      const bounded = mode === "stop-run" && !String(text ?? "").trim()
        ? ""
        : boundControlText(text, MAX_QUEUE_TEXT);
      const list = steers.get(id) ?? [];
      // Honest bound (review r5 P1-3): an undelivered steer (never carried by
      // a model call) must NEVER be silently discarded — the owner was told
      // "ok" and unregister's auto-queue could not resurrect an evicted
      // record either. Refuse with the limit surfaced once the cap of
      // UNDELIVERED steers is full; SPENT records (already injected) may be
      // evicted to make room — evicting them loses nothing the owner typed.
      const undelivered = list.filter((s) => s.injectedOnce !== true);
      if (undelivered.length >= MAX_PENDING_STEERS) {
        return {
          ok: false,
          error: "steer_buffer_full",
          executionId: id,
          count: undelivered.length,
          limit: MAX_PENDING_STEERS,
        };
      }
      const steer = { id: seq(), mode, text: bounded, at: now(), injectedOnce: false };
      const spent = list.filter((s) => s.injectedOnce === true);
      // Spare slots beyond the undelivered+new records are filled by the most
      // recent SPENT records (their "ride" can end once a slot is needed).
      const room = MAX_PENDING_STEERS - undelivered.length - 1;
      steers.set(id, [...undelivered, steer, ...spent.slice(-Math.max(0, room))]);
      return { ok: true, steer: { ...steer }, run: { ...record } };
    },

    /** The run-loop seam's sync reader — called at EVERY model call. Returns
     * the pending steer records (arrival order); the seam appends their text
     * to the outgoing call and acks the ones it carried. */
    pending(executionId) {
      const id = String(executionId ?? "");
      const list = steers.get(id);
      if (!list || list.length === 0) return [];
      return list.map((s) => ({ ...s }));
    },

    /** Mark the given steer records as carried by a real model call. */
    markInjected(executionId, steerIds) {
      const id = String(executionId ?? "");
      const list = steers.get(id);
      if (!list || !Array.isArray(steerIds)) return;
      const wanted = new Set(steerIds.map(String));
      for (const s of list) if (wanted.has(s.id)) s.injectedOnce = true;
    },
  });
}

/** True when at least one pending steer asks the loop to stop after the step
 * that carries it (mode "stop-step"). The loop consults this BETWEEN steps. */
export function hasStopStepRequest(pending = []) {
  return Array.isArray(pending) && pending.some((s) => s?.mode === "stop-step");
}

/** The steer text the run-loop seam appends to a model call (every pending
 * mode except "stop-run" — a stop-run is the SW's cancel, never a prompt
 * injection). Pure. */
export function steerTextsToInject(pending = []) {
  if (!Array.isArray(pending)) return [];
  const out = [];
  for (const s of pending) {
    if (s?.mode === "stop-run") continue;
    const t = String(s?.text ?? "").trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * The durable per-thread FIFO. Storage-injected (`kvGet`/`kvSet` mirror the
 * SW kv contract) so unit tests drive the real logic over a fake and the SW
 * drives it over chrome.storage.local — one code path, no divergence.
 */
export function createThreadQueue({ kvGet = async () => ({}), kvSet = async () => ({}), now = () => Date.now() } = {}) {
  // chrome.storage is async + racy under concurrent read-modify-write; one
  // promise-chain per instance serializes queue mutations (enqueue/remove/
  // move/shift are all CAS-free whole-map rewrites — serialization makes the
  // last writer authoritative instead of losing items).
  let chain = Promise.resolve();
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const normalize = (list) => (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === "object" && typeof item.id === "string")
    .slice(0, MAX_QUEUE_PER_THREAD);
  // readAll keeps EVERY item (pending AND claimed): a claim is the durable
  // in-flight marker that survives an SW stop — the wake reconcile decides
  // its fate from the durable run registry, never from memory.
  const readAll = async () => {
    const raw = await kvGet(QUEUE_KEY);
    const map = raw?.[QUEUE_KEY];
    return map && typeof map === "object" && !Array.isArray(map) ? map : {};
  };
  const writeAll = (map) => kvSet({ [QUEUE_KEY]: map });

  const item = (text, resolverDocumentId = "") => ({
    id: newId("q"),
    text: boundControlText(text),
    ts: now(),
    ...(typeof resolverDocumentId === "string" && resolverDocumentId.length > 0 && resolverDocumentId.length <= 200
      ? { resolverDocumentId }
      : {}),
  });

  /** Actionable (pending) items only: a CLAIMED item is in flight — its run
   * is executing it — so it is not a chip the owner can reorder/remove. */
  const pendingOf = (list) => normalize(list).filter((entry) => !entry.claim);

  return Object.freeze({
    async enqueue(threadId, text, { resolverDocumentId = "" } = {}) {
      const id = String(threadId ?? "");
      if (!id) return { ok: false, error: "threadId is required" };
      const bounded = boundControlText(text);
      if (!bounded) return { ok: false, error: "empty message" };
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        if (list.length >= MAX_QUEUE_PER_THREAD) {
          return { ok: false, error: "queue_full", count: list.length };
        }
        // Whole-map bound (review r5 P1-3): when the map is at the thread
        // limit, a NEW thread is refused with the limit surfaced — the OLD
        // silent eviction deleted whole OTHER threads' accepted queues.
        if (!(id in map) && Object.keys(map).length >= MAX_THREADS_QUEUED) {
          return {
            ok: false,
            error: "queue_thread_limit",
            count: Object.keys(map).length,
            limit: MAX_THREADS_QUEUED,
          };
        }
        const entry = item(bounded, resolverDocumentId);
        list.push(entry);
        map[id] = list;
        await writeAll(map);
        return { ok: true, item: { ...entry }, count: list.length };
      });
    },

    async list(threadId) {
      const id = String(threadId ?? "");
      if (!id) return [];
      return locked(async () => pendingOf((await readAll())[id]));
    },

    /** Cheap drain pre-check: pending (actionable) count + the claimed head's
     * run id (a claim only ever sits on the FIFO head). */
    async status(threadId) {
      const id = String(threadId ?? "");
      if (!id) return { pending: 0, claimedRunId: null };
      return locked(async () => {
        const list = normalize((await readAll())[id]);
        const claimedRunId = list[0]?.claim?.runId ? String(list[0].claim.runId).slice(0, 200) : null;
        return { pending: pendingOf(list).length, claimedRunId };
      });
    },

    /** Claim the FIFO head for an in-flight continuation run (review r5
     * P1-2): the item STAYS durably stored with its claim marker until the
     * fired run settles (dropClaim) or the admission never happened
     * (releaseClaim). Only an UNCLAIMED head can be claimed — one claimed by
     * a still-live run blocks a second concurrent drain. */
    async claimHead(threadId, runId) {
      const id = String(threadId ?? "");
      const claimId = String(runId ?? "");
      if (!id) return { ok: false, error: "threadId is required" };
      if (!claimId || claimId.length > 200) return { ok: false, error: "invalid claim runId" };
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        const head = list[0];
        if (!head) return { ok: false, empty: true };
        if (head.claim) return { ok: false, blocked: true, runId: String(head.claim.runId).slice(0, 200) };
        head.claim = { runId: claimId, at: now() };
        map[id] = list;
        await writeAll(map);
        return { ok: true, item: { ...head } };
      });
    },

    /** Drop the item a settled continuation run carried (its run ended — the
     * message was executed as that turn, ok or not; a failed turn parks the
     * queue rather than re-firing). No-op when the claim is gone. */
    async dropClaim(threadId, runId) {
      const id = String(threadId ?? "");
      const claimId = String(runId ?? "");
      if (!id || !claimId) return { ok: false, error: "invalid drop" };
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        const next = list.filter((entry) => !(entry.claim && entry.claim.runId === claimId));
        if (next.length === list.length) return { ok: false, error: "claim_not_found" };
        if (next.length === 0) delete map[id];
        else map[id] = next;
        await writeAll(map);
        return { ok: true, count: next.length };
      });
    },

    /** Return a claimed item to the pending queue (its run was NEVER durably
     * admitted — refusal or an SW stop before admission — so the owner's
     * message survives for a later drain). No-op when the claim is gone. */
    async releaseClaim(threadId, runId) {
      const id = String(threadId ?? "");
      const claimId = String(runId ?? "");
      if (!id || !claimId) return { ok: false, error: "invalid release" };
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        let changed = false;
        for (const entry of list) {
          if (entry.claim && entry.claim.runId === claimId) {
            delete entry.claim;
            changed = true;
          }
        }
        if (!changed) return { ok: false, error: "claim_not_found" };
        map[id] = list;
        await writeAll(map);
        return { ok: true, count: pendingOf(list).length };
      });
    },

    /** Every durable in-flight claim ({threadId, runId}) across the store —
     * the wake-reconcile input (an SW stop must never orphan a claim). */
    async scanClaims() {
      return locked(async () => {
        const map = await readAll();
        const out = [];
        for (const threadId of Object.keys(map)) {
          for (const entry of normalize(map[threadId])) {
            if (entry.claim?.runId) out.push({ threadId, runId: String(entry.claim.runId).slice(0, 200) });
            if (out.length >= 512) return out;
          }
        }
        return out;
      });
    },

    async remove(threadId, itemId) {
      const id = String(threadId ?? "");
      if (!id) return { ok: false, error: "threadId is required" };
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        const next = list.filter((item) => item.id !== String(itemId ?? ""));
        if (next.length === list.length) return { ok: false, error: "item_not_found" };
        if (next.length === 0) delete map[id];
        else map[id] = next;
        await writeAll(map);
        return { ok: true, count: next.length };
      });
    },

    /** Reorder a pending chip: `delta` -1 moves it one slot earlier (fires
     * sooner), +1 later. Pure + deterministic. */
    async move(threadId, itemId, delta) {
      const id = String(threadId ?? "");
      if (!id) return { ok: false, error: "threadId is required" };
      const step = Number(delta);
      if (!Number.isFinite(step) || step === 0) return { ok: false, error: "invalid delta" };
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        const at = list.findIndex((item) => item.id === String(itemId ?? ""));
        if (at < 0) return { ok: false, error: "item_not_found" };
        const to = Math.max(0, Math.min(list.length - 1, at + step));
        if (to === at) return { ok: false, error: "no_move" };
        const [entry] = list.splice(at, 1);
        list.splice(to, 0, entry);
        map[id] = list;
        await writeAll(map);
        return { ok: true, count: list.length };
      });
    },

    /** Drain authority: pop the OLDEST item (fires first). Returns the item
     * or null when the queue is empty. */
    async shift(threadId) {
      const id = String(threadId ?? "");
      if (!id) return null;
      return locked(async () => {
        const map = await readAll();
        const list = normalize(map[id]);
        if (list.length === 0) return null;
        const [head] = list.splice(0, 1);
        if (list.length === 0) delete map[id];
        else map[id] = list;
        await writeAll(map);
        return { ...head };
      });
    },
  });
}

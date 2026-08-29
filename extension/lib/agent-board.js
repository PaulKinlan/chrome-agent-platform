// lib/agent-board.js — the shared inter-agent jobs + messages board (owner
// green-lit 2026-08-29). The async/broadcast complement to directed
// delegation (delegate_to_agent): agents POST work to a hub-level board and
// capable agents CLAIM it, instead of the poster naming the worker.
//
// Shape (ported from the owner's CHAOS extension, onto CAP's stronger guards):
// two append-only event-sourced logs in the hub tier (jobs + messages),
// lock-serialized writes, atomic claim transition, lease + heartbeat copied
// verbatim from the scheduler (INFLIGHT_LEASE_MS / INFLIGHT_HEARTBEAT_MS,
// lib/scheduler.js:58-68), and results recorded on the job itself.
//
// Permission model (owner refinement 2026-08-29): v1 is FULLY OPEN among
// named agents + the hub — any named agent may post, claim, and message. The
// guards below are pure functions taking the agents registry so per-edge
// rules (the deferred permission layer) slot in WITHOUT redesign; every job
// event already records poster/claimant identity so that future layer can
// reason over history. Deferred: per-edge board permissions, automatic wake
// of idle agents on post (scheduler/alarm machinery), bidding.
//
// Storage respects the constitutional boundary: the board lives in the HUB
// tier (like the named-agent registry); origin-private content crosses as
// REFERENCES (thread/artifact ids), never copied content. All free text is
// credential-pattern-redacted at write via the existing seam
// (redactSecretText, pure.js — the string-level redactor; redactSecrets only
// covers object keys).

import { redactSecretText } from "./pure.js";
import { resolveTargetAgent } from "./agent-delegation.js";

export const BOARD_JOBS_KEY = "cap:board-jobs";
export const BOARD_MESSAGES_KEY = "cap:board-messages";

// Bounds (every value is also pinned by tests/agent-board.test.ts).
export const BOARD_MAX_OPEN_JOBS = 100;
export const BOARD_MAX_SETTLED_JOBS = 50;
export const BOARD_MAX_MESSAGES = 200;
export const BOARD_MAX_DESCRIPTION = 2000;
export const BOARD_MAX_RESULT = 4000;
export const BOARD_MAX_MESSAGE_BODY = 2000;
export const BOARD_MAX_BLOCKED_BY = 8;
export const BOARD_MAX_CAPABILITY = 64;
// The serialized logs must stay under the memory store's 256 KiB per-value cap
// (memory.js MAX_VALUE_BYTES) with real margin for the envelope — a count cap
// alone let 200×2 KB messages cross the cap (review P1-4).
export const BOARD_MAX_LOG_BYTES = 192 * 1024;

// The claim lease constants are copied VERBATIM from the scheduler's
// in-flight discipline (lib/scheduler.js INFLIGHT_LEASE_MS /
// INFLIGHT_HEARTBEAT_MS — imported there by value to keep this module free of
// the scheduler's kv/run-fence import chain; the equality is pinned by test).
export const BOARD_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const BOARD_CLAIM_HEARTBEAT_MS = 30 * 1000;

/** The hub's board identity. The hub is the owner's master agent — always
 *  allowed to post/claim/message in v1's open model. */
export const BOARD_HUB_ID = "hub";

/** Bound + credential-redact a free-text field. Returns "" for non-strings. */
export function boardText(value, max) {
  const clean = redactSecretText(typeof value === "string" ? value : "");
  return String(typeof clean === "string" ? clean : "").replace(/\s+/g, " ").trim().slice(0, max);
}

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Whether the caller may post a job. v1: FULLY OPEN — the hub and every known
 * named agent may post (targeted or broadcast). The guard takes the agents
 * registry so the deferred per-edge permission layer slots in here.
 * Returns { ok: true } or { ok: false, code, error }.
 */
export function canPostJob({ callerId, agents, targetAgentId = null }) {
  if (callerId !== BOARD_HUB_ID && !agents.some((a) => a && a.id === callerId)) {
    return { ok: false, code: "board-unknown-poster", error: "only the hub or a named agent can post to the board" };
  }
  if (targetAgentId && !agents.some((a) => a && a.id === targetAgentId)) {
    return { ok: false, code: "board-unknown-target", error: "the target agent does not exist" };
  }
  return { ok: true };
}

/**
 * Whether the caller may claim a job (decided against the FOLDED job record).
 * v1 rules (fully open among named agents + hub):
 *  - the caller must be the hub or a known named agent;
 *  - the job must be open (pending — a live claim or a settled job refuses);
 *  - an agent never claims its OWN job (a self-claim is a no-op loop);
 *  - a targeted job is claimable only by its target;
 *  - every blockedBy job must be completed.
 */
export function canClaimJob({ callerId, agents, job, settledJobs = [] }) {
  if (!job || typeof job !== "object") {
    return { ok: false, code: "board-no-job", error: "no such job" };
  }
  if (callerId !== BOARD_HUB_ID && !agents.some((a) => a && a.id === callerId)) {
    return { ok: false, code: "board-unknown-claimant", error: "only the hub or a named agent can claim board jobs" };
  }
  if (job.status === "claimed") {
    return { ok: false, code: "board-already-claimed", error: `already claimed by ${job.claimantName ?? job.claimantId}` };
  }
  if (job.status === "completed" || job.status === "failed") {
    return { ok: false, code: "board-settled", error: `job already ${job.status}` };
  }
  if (job.posterId === callerId) {
    return { ok: false, code: "board-self-claim", error: "an agent never claims its own job" };
  }
  if (job.targetAgentId && job.targetAgentId !== callerId) {
    return {
      ok: false,
      code: "board-targeted",
      error: `this job is targeted at ${job.targetName ?? job.targetAgentId}`,
    };
  }
  const settled = new Set(settledJobs.filter((j) => j && j.status === "completed").map((j) => j.id));
  const blockers = (Array.isArray(job.blockedBy) ? job.blockedBy : []).filter((id) => !settled.has(id));
  if (blockers.length > 0) {
    return { ok: false, code: "board-blocked", error: `blocked by ${blockers.length} unfinished job${blockers.length === 1 ? "" : "s"}` };
  }
  return { ok: true };
}

/**
 * Fold the append-only job event log into current job records. Lease expiry
 * is DERIVED (no timer needed): a claimed job whose leaseExpiry is in the past
 * reads as pending again (a later `released` event is only an explicit record).
 * Returns jobs most-recent-first.
 */
export function foldJobEvents(events, now = Date.now()) {
  const jobs = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object" || typeof ev.jobId !== "string") continue;
    if (ev.type === "settled-tombstone") {
      // The compact authority left behind when a settled job's heavy event
      // chain is byte-evicted (review r2 P1-2): identity + outcome + result
      // (truncated) + delivery state survive, so retries stay idempotent and
      // the result stays readable.
      jobs.set(ev.jobId, {
        id: ev.jobId,
        posterId: ev.posterId ?? null,
        posterName: ev.posterName ?? ev.posterId ?? null,
        description: ev.description ?? "",
        requiredCapability: null,
        targetAgentId: null,
        targetName: null,
        blockedBy: [],
        posterThreadId: ev.delivery?.threadId ?? null,
        createdAt: ev.ts,
        status: ev.outcome === "failed" ? "failed" : "completed",
        claimantId: ev.claimantId ?? null,
        claimantName: ev.claimantName ?? ev.claimantId ?? null,
        claimedAt: null,
        leaseExpiry: null,
        result: ev.result ?? "",
        settledAt: ev.settledAt ?? ev.ts,
        delivery: ev.delivery ? { threadId: ev.delivery.threadId, delivered: ev.delivery.delivered === true } : null,
        tombstone: true,
      });
      continue;
    }
    if (ev.type === "posted") {
      jobs.set(ev.jobId, {
        id: ev.jobId,
        posterId: ev.posterId,
        posterName: ev.posterName ?? ev.posterId,
        description: ev.description ?? "",
        requiredCapability: ev.requiredCapability ?? null,
        targetAgentId: ev.targetAgentId ?? null,
        targetName: ev.targetName ?? null,
        blockedBy: Array.isArray(ev.blockedBy) ? ev.blockedBy : [],
        posterThreadId: ev.posterThreadId ?? null,
        createdAt: ev.ts,
        status: "pending",
        claimantId: null,
        claimantName: null,
        claimedAt: null,
        leaseExpiry: null,
        result: null,
        settledAt: null,
        delivery: null,
        tombstone: false,
      });
      continue;
    }
    const job = jobs.get(ev.jobId);
    if (!job) continue; // event for a pruned/unknown job — ignored
    // Lazily expire the current claim AS OF THIS EVENT's time before any
    // transition that depends on the claim state (review P1-2): the store
    // admits a re-claim under the lock with expiry derived at that moment, so
    // the fold must see the SAME expiry between events — not only in the
    // end-of-fold pass against `now` (which silently dropped the re-claim).
    const expireAt = (at) => {
      if (job.status === "claimed" && Number.isFinite(job.leaseExpiry) && Number.isFinite(at) && job.leaseExpiry <= at) {
        job.status = "pending";
        job.claimantId = null;
        job.claimantName = null;
        job.claimedAt = null;
        job.leaseExpiry = null;
      }
    };
    if (ev.type === "claimed") {
      expireAt(ev.ts);
      if (job.status !== "pending") continue; // atomic transition: only pending→claimed
      job.status = "claimed";
      job.claimantId = ev.claimantId;
      job.claimantName = ev.claimantName ?? ev.claimantId;
      job.claimedAt = ev.ts;
      job.leaseExpiry = ev.leaseExpiry;
    } else if (ev.type === "heartbeat") {
      if (job.status === "claimed" && job.claimantId === ev.claimantId) {
        job.leaseExpiry = ev.leaseExpiry;
      }
    } else if (ev.type === "completed" || ev.type === "failed") {
      expireAt(ev.ts); // an expired claimant's late settle is dropped
      if (job.status !== "claimed" || job.claimantId !== ev.claimantId) continue;
      job.status = ev.type;
      job.result = ev.result ?? "";
      job.settledAt = ev.ts;
      job.leaseExpiry = null;
      // The settlement carries its PENDING poster-thread delivery (review r2
      // P1-3): durable with the settle event, so a restart between settle and
      // commit never loses it.
      job.delivery = ev.delivery ? { threadId: ev.delivery.threadId, delivered: false } : null;
    } else if (ev.type === "delivered") {
      if (job.delivery) job.delivery.delivered = true;
    } else if (ev.type === "released") {
      if (job.status === "claimed") {
        job.status = "pending";
        job.claimantId = null;
        job.claimantName = null;
        job.claimedAt = null;
        job.leaseExpiry = null;
      }
    }
  }
  // Derived lease expiry: an expired live claim reads as pending.
  for (const job of jobs.values()) {
    if (job.status === "claimed" && Number.isFinite(job.leaseExpiry) && job.leaseExpiry <= now) {
      job.status = "pending";
      job.claimantId = null;
      job.claimantName = null;
      job.claimedAt = null;
      job.leaseExpiry = null;
    }
  }
  return [...jobs.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Fold the message log (append-only, no transitions). Most-recent-first. */
export function foldMessageEvents(events) {
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.type !== "message" || typeof ev.id !== "string") continue;
    out.push({
      id: ev.id,
      fromId: ev.fromId,
      fromName: ev.fromName ?? ev.fromId,
      toId: ev.toId ?? "broadcast",
      toName: ev.toName ?? (ev.toId && ev.toId !== "broadcast" ? ev.toId : "everyone"),
      body: ev.body ?? "",
      refJobId: ev.refJobId ?? null,
      ts: ev.ts,
    });
  }
  return out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

/** Serialized size bound helper (UTF-8 JSON bytes — the same unit the memory
 *  store's 256 KiB per-value cap measures). */
function eventsBytes(events) {
  let serialized;
  try {
    serialized = JSON.stringify(events);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return new TextEncoder().encode(serialized).length;
}

/** Drop heartbeat events that carry no fold authority: every heartbeat but a
 *  job's LATEST one is superseded (each fully replaces the prior lease), and
 *  a settled job's heartbeats are dead weight (the fold ignores them once the
 *  settle event landed). SAFE for store-generated logs: a re-claim is only
 *  admitted after the prior lease expired, so dropping the superseded
 *  heartbeat cannot make an expired-at-admission claim look live (review
 *  P1-4). */
function compactHeartbeatEvents(events) {
  const lastHeartbeat = new Map(); // jobId -> index of its latest heartbeat
  const settled = new Set();
  (Array.isArray(events) ? events : []).forEach((ev, i) => {
    if (ev?.type === "heartbeat") lastHeartbeat.set(ev.jobId, i);
    if (ev?.type === "completed" || ev?.type === "failed") settled.add(ev.jobId);
  });
  return (Array.isArray(events) ? events : []).filter((ev, i) => {
    if (ev?.type !== "heartbeat") return true;
    if (settled.has(ev.jobId)) return false;
    return lastHeartbeat.get(ev.jobId) === i;
  });
}

// Tombstone bounds (review r2 P1-2): the compact record an evicted settled
// job leaves behind — result truncated, delivery state preserved.
export const BOARD_MAX_TOMBSTONE_RESULT = 500;
export const BOARD_MAX_TOMBSTONES = 100;

/** The compact authority record for an evicted settled job. */
function tombstoneOf(job, now) {
  return {
    type: "settled-tombstone",
    jobId: job.id,
    ts: job.settledAt ?? now,
    posterId: job.posterId ?? null,
    posterName: job.posterName ?? null,
    claimantId: job.claimantId ?? null,
    claimantName: job.claimantName ?? null,
    outcome: job.status,
    description: String(job.description ?? "").slice(0, 200),
    result: String(job.result ?? "").slice(0, BOARD_MAX_TOMBSTONE_RESULT),
    settledAt: job.settledAt ?? null,
    delivery: job.delivery ? { threadId: job.delivery.threadId, delivered: job.delivery.delivered === true } : null,
  };
}

/** Prune + bound the job event log (review P1-3, r2 P1-2):
 *   1. superseded/settled heartbeats are compacted away;
 *   2. settled jobs past BOARD_MAX_SETTLED_JOBS (or over the byte budget) are
 *      EVICTED TO COMPACT TOMBSTONES — never dropped: an acknowledged
 *      settlement must stay retry-idempotent (alreadySettled) and its result
 *      readable. A settled job an OPEN job still references in blockedBy, or
 *      whose delivery is still pending, keeps its full record;
 *   3. tombstones past BOARD_MAX_TOMBSTONES (or still over budget) are the
 *      final authority horizon — dropped oldest-first, but never while their
 *      delivery is pending.
 *  OPEN jobs' events are NEVER dropped (the posting route refuses instead). */
export function pruneJobEvents(events, now = Date.now()) {
  const compacted = compactHeartbeatEvents(events);
  const jobs = foldJobEvents(compacted, now);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const openIds = new Set(jobs.filter((j) => j.status === "pending" || j.status === "claimed").map((j) => j.id));
  const pinnedIds = new Set();
  for (const job of jobs) {
    if (!openIds.has(job.id)) continue;
    for (const dep of Array.isArray(job.blockedBy) ? job.blockedBy : []) pinnedIds.add(dep);
  }
  const settled = jobs.filter((j) => j.status === "completed" || j.status === "failed")
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  const full = settled.filter((j) => !j.tombstone);
  const tombs = settled.filter((j) => j.tombstone);
  const evictFull = new Set(); // full chain → tombstone
  const dropTomb = new Set();  // tombstone → gone (final horizon)
  let surplusFull = full.length - BOARD_MAX_SETTLED_JOBS;
  for (const job of full) {
    if (surplusFull <= 0) break;
    if (pinnedIds.has(job.id)) continue; // a live dependent still needs the record
    if (job.delivery && !job.delivery.delivered) continue; // an unacknowledged delivery keeps its chain
    evictFull.add(job.id);
    surplusFull -= 1;
  }
  let surplusTomb = tombs.length - BOARD_MAX_TOMBSTONES;
  for (const job of tombs) {
    if (surplusTomb <= 0) break;
    if (pinnedIds.has(job.id)) continue;
    if (job.delivery && !job.delivery.delivered) continue;
    dropTomb.add(job.id);
    surplusTomb -= 1;
  }
  const rebuild = () => {
    const kept = compacted.filter((ev) => !dropTomb.has(ev?.jobId) && !evictFull.has(ev?.jobId));
    // Tombstones append at the end — the fold gives them the final word.
    return [...kept, ...[...evictFull].map((id) => tombstoneOf(byId.get(id), now))];
  };
  let out = rebuild();
  // Byte authority: the count cap alone can exceed the memory per-value cap
  // (settled jobs carry up to BOARD_MAX_RESULT of result text each).
  while (eventsBytes(out) > BOARD_MAX_LOG_BYTES) {
    const nextFull = full.find((j) => !evictFull.has(j.id) && !pinnedIds.has(j.id) && !(j.delivery && !j.delivery.delivered));
    if (nextFull) {
      evictFull.add(nextFull.id);
    } else {
      const nextTomb = tombs.find((j) => !dropTomb.has(j.id) && !pinnedIds.has(j.id) && !(j.delivery && !j.delivery.delivered));
      if (!nextTomb) break; // everything left is open, pinned, or undelivered — the post gate owns this
      dropTomb.add(nextTomb.id);
    }
    out = rebuild();
  }
  return out;
}

/**
 * The board store: event-sourced, lock-serialized, over a hub-tier memory
 * (masterMemory()). Deps are injected so the KATs drive the exact production
 * logic with an in-memory stand-in.
 */
export function createAgentBoard({ memory, withLock = (fn) => fn(), now = () => Date.now(), commitThread = null }) {
  // The board logs are RESERVED authority keys (memory.js MASTER_RESERVED_KEYS
  // + the internal/hidden namespace): the model's memory_set/memory_get can
  // never forge or read them, so the store uses the TRUSTED paths exclusively
  // (review P1-1).
  const readLog = async (key) => {
    // A failed or malformed read is NOT an empty log (review r2 P1-1): only a
    // SUCCESSFUL null means absent. Everything else propagates — writing a
    // guessed-empty log over unreadable authority would be destructive.
    const events = await memory.getStrict(key);
    if (events == null) return [];
    if (!Array.isArray(events)) throw new Error(`board log "${key}" is malformed (not an array)`);
    return events;
  };
  const writeLog = (key, events) => memory.setTrusted(key, events);
  async function loadJobs() {
    return readLog(BOARD_JOBS_KEY);
  }
  async function saveJobs(events) {
    await writeLog(BOARD_JOBS_KEY, pruneJobEvents(events, now()));
  }
  async function loadMessages() {
    return readLog(BOARD_MESSAGES_KEY);
  }

  /** The terminal content a delivery commits into the poster's thread. */
  function deliveryTerminal(job) {
    const claimant = job.claimantName ?? job.claimantId ?? "an agent";
    const done = job.status === "completed";
    return {
      role: done ? "assistant" : "error",
      content: done
        ? `Board job "${String(job.description ?? "").slice(0, 140)}" completed by ${claimant}:\n\n${job.result ?? ""}`
        : `Board job "${String(job.description ?? "").slice(0, 140)}" FAILED (${claimant}): ${job.result ?? ""}`,
    };
  }

  /** Deliver a settled job's result to its poster's thread (review r2 P1-3).
   *  The commit is idempotent by `board:<jobId>` (commitThreadTerminal's
   *  execution-id idempotence), so a crash between commit and the delivered
   *  event is safe. Returns true when there is nothing (left) to deliver. */
  async function deliverJob(job) {
    if (!job?.delivery || job.delivery.delivered) return true;
    if (typeof commitThread !== "function") return false;
    try {
      await commitThread(job.delivery.threadId, `board:${job.id}`, deliveryTerminal(job));
    } catch {
      return false;
    }
    await withLock(async () => {
      const events = await loadJobs();
      const current = foldJobEvents(events, now()).find((j) => j.id === job.id);
      if (current?.delivery && !current.delivery.delivered) {
        events.push({ type: "delivered", jobId: job.id, ts: now() });
        await saveJobs(events);
      }
    });
    return true;
  }

  const board = {
    /** Post a job. Returns { ok, job } or a structured guard denial. */
    async postJob({ callerId, agents, description, requiredCapability = null, targetAgentRef = null, blockedBy = [], posterThreadId = null }) {
      return withLock(async () => {
        const target = targetAgentRef ? resolveTargetAgent(targetAgentRef, agents) : null;
        if (targetAgentRef && !target) {
          return { ok: false, code: "board-unknown-target", error: "the target agent does not exist — use list_named_agents" };
        }
        const guard = canPostJob({ callerId, agents, targetAgentId: target?.id ?? null });
        if (!guard.ok) return guard;
        const text = boardText(description, BOARD_MAX_DESCRIPTION);
        if (!text) return { ok: false, code: "board-empty", error: "the job needs a description" };
        const capability = requiredCapability ? boardText(requiredCapability, BOARD_MAX_CAPABILITY) : null;
        const blocked = (Array.isArray(blockedBy) ? blockedBy : [])
          .filter((id) => typeof id === "string" && id.trim())
          .slice(0, BOARD_MAX_BLOCKED_BY);
        const events = await loadJobs();
        const jobs = foldJobEvents(events, now());
        const open = jobs.filter((j) => j.status === "pending" || j.status === "claimed");
        if (open.length >= BOARD_MAX_OPEN_JOBS) {
          return { ok: false, code: "board-full", error: `the board has ${BOARD_MAX_OPEN_JOBS} open jobs — settle some first` };
        }
        for (const id of blocked) {
          if (!jobs.some((j) => j.id === id)) {
            return { ok: false, code: "board-bad-blocker", error: `blockedBy references an unknown job: ${id}` };
          }
        }
        const posterName = callerId === BOARD_HUB_ID ? "Hub" : (agents.find((a) => a && a.id === callerId)?.name ?? callerId);
        const job = {
          type: "posted",
          jobId: newJobId(),
          ts: now(),
          posterId: callerId,
          posterName,
          description: text,
          requiredCapability: capability,
          targetAgentId: target?.id ?? null,
          targetName: target?.name ?? null,
          blockedBy: blocked,
          // The poster's thread authority (review P1-6): captured by the ROUTE
          // from the run registry, never from model args — a settlement result
          // rides back to the poster's thread through the durable outbox seam.
          posterThreadId: typeof posterThreadId === "string" && posterThreadId ? posterThreadId.slice(0, 200) : null,
        };
        // Byte authority (review P1-4 + r3 P1-1): refuse BEFORE the append
        // when the new event would push the serialized log over budget. Open
        // jobs' events are never dropped to make room, and a settled THREADED
        // job's pending poster-delivery is pinned by pruneJobEvents until its
        // commit succeeds — so admission must reserve the WORST-CASE settle
        // capacity (BOARD_MAX_RESULT + framing) of EVERY open threaded job
        // plus this job's own. Without the per-job reserve, sustained
        // delivery failure wedges the log at the memory store's 256 KiB
        // per-value wall (the r3 coordinator probe: 89 posts, then the 18th
        // settle op dead with board-store-error).
        const openThreaded = jobs.filter((j) =>
          (j.status === "pending" || j.status === "claimed") && j.posterThreadId
        ).length;
        const deliveryReserve = (openThreaded + (job.posterThreadId ? 1 : 0)) *
            (BOARD_MAX_RESULT + 2048) + 2048;
        const projected = [...events, job];
        if (eventsBytes(projected) > BOARD_MAX_LOG_BYTES - deliveryReserve) {
          return { ok: false, code: "board-full", error: "the board log is full — settle or release jobs first" };
        }
        events.push(job);
        await saveJobs(events);
        return { ok: true, job: foldJobEvents([job], now())[0] };
      });
    },

    /** Claim a pending job (atomic pending→claimed under the lock). */
    async claimJob({ callerId, agents, jobId }) {
      return withLock(async () => {
        const events = await loadJobs();
        const jobs = foldJobEvents(events, now());
        const job = jobs.find((j) => j.id === jobId) ?? null;
        if (!job) return { ok: false, code: "board-no-job", error: "no such job" };
        const guard = canClaimJob({ callerId, agents, job, settledJobs: jobs });
        if (!guard.ok) return guard;
        const claimantName = callerId === BOARD_HUB_ID ? "Hub" : (agents.find((a) => a && a.id === callerId)?.name ?? callerId);
        events.push({
          type: "claimed",
          jobId,
          ts: now(),
          claimantId: callerId,
          claimantName,
          leaseExpiry: now() + BOARD_CLAIM_LEASE_MS,
        });
        await saveJobs(events);
        return { ok: true, job: foldJobEvents(events, now()).find((j) => j.id === jobId) };
      });
    },

    /** Extend the caller's claim lease (claimant-only). */
    async heartbeatJob({ callerId, jobId }) {
      return withLock(async () => {
        const events = await loadJobs();
        const job = foldJobEvents(events, now()).find((j) => j.id === jobId) ?? null;
        if (!job || job.status !== "claimed" || job.claimantId !== callerId) {
          return { ok: false, code: "board-not-claimant", error: "only the current claimant can heartbeat a job" };
        }
        events.push({ type: "heartbeat", jobId, ts: now(), claimantId: callerId, leaseExpiry: now() + BOARD_CLAIM_LEASE_MS });
        await saveJobs(events);
        return { ok: true, leaseExpiry: now() + BOARD_CLAIM_LEASE_MS };
      });
    },

    /** Settle a claimed job. Idempotent: a second completion by the SAME
     *  claimant returns the already-settled record without a state change.
     *  The settle event carries the PENDING poster-thread delivery (durable
     *  with the settlement); the call is ACKNOWLEDGED only after the
     *  idempotent thread commit succeeds — a transient failure returns
     *  board-delivery and the caller's retry (or the startup drain)
     *  re-attempts delivery (review r2 P1-3). */
    async settleJob({ callerId, jobId, result, outcome = "completed" }) {
      const settled = await withLock(async () => {
        const events = await loadJobs();
        const jobs = foldJobEvents(events, now());
        const job = jobs.find((j) => j.id === jobId) ?? null;
        if (!job) return { ok: false, code: "board-no-job", error: "no such job" };
        if (job.status === "completed" || job.status === "failed") {
          if (job.claimantId === callerId) {
            return { alreadySettled: true, job };
          }
          return { ok: false, code: "board-settled", error: `job already ${job.status}` };
        }
        if (job.status !== "claimed" || job.claimantId !== callerId) {
          return { ok: false, code: "board-not-claimant", error: "only the current claimant can settle a job" };
        }
        const text = boardText(result, BOARD_MAX_RESULT);
        events.push({
          type: outcome === "failed" ? "failed" : "completed",
          jobId,
          ts: now(),
          claimantId: callerId,
          result: text,
          delivery: job.posterThreadId ? { threadId: job.posterThreadId } : null,
        });
        await saveJobs(events);
        return { alreadySettled: false, job: foldJobEvents(events, now()).find((j) => j.id === jobId) };
      });
      if (settled.ok === false) return settled;
      const delivered = await deliverJob(settled.job);
      if (!delivered) {
        return {
          ok: false,
          code: "board-delivery",
          error: "the job is settled on the board, but delivering the result to the poster's thread failed — settle again to retry delivery",
          alreadySettled: settled.alreadySettled,
          settled: !settled.alreadySettled,
          job: settled.job,
        };
      }
      return { ok: true, ...(settled.alreadySettled ? { alreadySettled: true } : {}), settled: !settled.alreadySettled, job: settled.job };
    },

    /** Drain persisted pending deliveries (startup + periodic paths): every
     *  settled job whose poster-thread delivery never committed gets its
     *  idempotent commit re-attempted (keyed board:<jobId>). Returns
     *  { delivered, remaining } so the retry scheduler can bound its
     *  backoff to what actually still needs a commit (review r3 P2). */
    async drainDeliveries() {
      if (typeof commitThread !== "function") return { delivered: 0, remaining: 0 };
      const jobs = await board.listJobs();
      let delivered = 0;
      let remaining = 0;
      for (const job of jobs) {
        if (job.delivery && !job.delivery.delivered) {
          if (await deliverJob(job)) delivered += 1;
          else remaining += 1;
        }
      }
      return { delivered, remaining };
    },

    /** List jobs (folded; lease expiry derived at read). */
    async listJobs({ status = null } = {}) {
      const events = await loadJobs();
      const jobs = foldJobEvents(events, now());
      return status ? jobs.filter((j) => j.status === status) : jobs;
    },

    async getJob(jobId) {
      const jobs = await board.listJobs();
      return jobs.find((j) => j.id === jobId) ?? null;
    },

    /** Post a message (broadcast or addressed to one agent). */
    async sendMessage({ callerId, agents, to = "broadcast", body, refJobId = null }) {
      return withLock(async () => {
        const guard = canPostJob({ callerId, agents }); // same identity rule as posting
        if (!guard.ok) return guard;
        const text = boardText(body, BOARD_MAX_MESSAGE_BODY);
        if (!text) return { ok: false, code: "board-empty", error: "the message needs a body" };
        let toId = "broadcast";
        let toName = "everyone";
        if (to && to !== "broadcast") {
          const target = resolveTargetAgent(to, agents);
          if (!target) return { ok: false, code: "board-unknown-target", error: "the addressee does not exist — use list_named_agents" };
          toId = target.id;
          toName = target.name ?? target.id;
        }
        const events = await loadMessages();
        const fromName = callerId === BOARD_HUB_ID ? "Hub" : (agents.find((a) => a && a.id === callerId)?.name ?? callerId);
        const message = {
          type: "message",
          id: `msg_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          ts: now(),
          fromId: callerId,
          fromName,
          toId,
          toName,
          body: text,
          refJobId: typeof refJobId === "string" && refJobId.trim() ? refJobId.trim() : null,
        };
        events.push(message);
        // Count cap, then BYTE authority (review P1-4): 200 max-size bodies
        // cross the memory store's 256 KiB per-value cap — drop oldest until
        // the serialized log fits the board budget.
        let retained = events.slice(-BOARD_MAX_MESSAGES);
        while (retained.length > 1 && eventsBytes(retained) > BOARD_MAX_LOG_BYTES) retained = retained.slice(1);
        await writeLog(BOARD_MESSAGES_KEY, retained);
        return { ok: true, message: foldMessageEvents([message])[0] };
      });
    },

    /** List messages, most-recent-first. forAgentId filters to broadcast +
     *  messages addressed to or from that agent; the owner surface omits it. */
    async listMessages({ forAgentId = null, limit = 50 } = {}) {
      const events = await loadMessages();
      let messages = foldMessageEvents(events);
      if (forAgentId) {
        messages = messages.filter((m) => m.toId === "broadcast" || m.toId === forAgentId || m.fromId === forAgentId);
      }
      return messages.slice(0, limit);
    },
  };
  return board;
}

/**
 * The SW route map (thin stateful wrapper over the store + guards — the
 * createSchedulerRoutes pattern). `resolveCaller(context)` is the SW's
 * authority seam: it maps the route CONTEXT (never model args) to the caller
 * identity (a named agent's id from the live run registry, else the hub).
 */
export function createAgentBoardRoutes({ memory, withLock, listAgents, resolveCaller, resolvePosterThreadId, commitThread, broadcast, now }) {
  // The store owns delivery (review r2 P1-3): commitThread rides into the
  // board so settlement + pending-delivery persist together and the ACK
  // waits on the idempotent thread commit.
  const board = createAgentBoard({ memory, withLock, now, commitThread });
  const agents = () => listAgents().catch(() => []);
  // Caller identity comes from the route CONTEXT (never model args) and fails
  // CLOSED: a MODEL principal whose execution id resolves to nothing is a
  // STALE run context (the SW restarted or the run settled — review P1-5) and
  // gets a structured denial. Only trusted owner/page surfaces (no model
  // principal) default to the hub — mirroring named-agent.delegate.
  const STALE_CONTEXT = { ok: false, code: "board-context-stale", error: "this run's identity can no longer be verified — start a fresh run" };
  const callerOf = (context) => {
    const id = typeof resolveCaller === "function" ? resolveCaller(context) : null;
    if (typeof id === "string" && id) return { callerId: id };
    if (context && context.principal === "model") return { denial: STALE_CONTEXT };
    return { callerId: BOARD_HUB_ID };
  };
  const fire = (event) => { try { broadcast?.(event); } catch { /* UI wake is best-effort */ } };
  // A store read failure (corrupt/unreadable authority log — review r2 P1-1)
  // surfaces as a structured denial, never a rejected route promise.
  const guarded = (fn) => async (args, context) => {
    try {
      return await fn(args, context);
    } catch (e) {
      return { ok: false, code: "board-store-error", error: String(e?.message ?? e).slice(0, 200) };
    }
  };

  const routes = {
    "board.post": guarded(async ({ description, requiredCapability, targetAgent, blockedBy }, context) => {
      const caller = callerOf(context);
      if (caller.denial) return caller.denial;
      const registry = await agents();
      // Poster-thread capture fails CLOSED (review r3 P1-2): a resolver
      // FAILURE on a model principal is a structured store error — a
      // silently threadless post would orphan the settlement delivery
      // forever. Non-model surfaces (owner/UI) may legitimately resolve to
      // null (threadless) — only a real failure of their own resolution is
      // also surfaced, a null result is honored.
      let posterThreadId = null;
      if (typeof resolvePosterThreadId === "function") {
        try {
          posterThreadId = await resolvePosterThreadId(context);
        } catch (e) {
          if (context?.principal === "model") {
            return { ok: false, code: "board-store-error", error: `resolving the poster's thread failed: ${String(e?.message ?? e).slice(0, 150)}` };
          }
        }
        posterThreadId = typeof posterThreadId === "string" && posterThreadId ? posterThreadId : null;
      }
      const r = await board.postJob({
        callerId: caller.callerId,
        agents: registry,
        description,
        requiredCapability,
        targetAgentRef: targetAgent,
        blockedBy,
        posterThreadId: typeof posterThreadId === "string" ? posterThreadId : null,
      });
      if (r.ok) fire({ type: "board-job-posted", jobId: r.job.id, capability: r.job.requiredCapability ?? null, targetAgentId: r.job.targetAgentId ?? null });
      return r;
    }),
    "board.claim": guarded(async ({ jobId }, context) => {
      const caller = callerOf(context);
      if (caller.denial) return caller.denial;
      const r = await board.claimJob({ callerId: caller.callerId, agents: await agents(), jobId });
      if (r.ok) fire({ type: "board-job-claimed", jobId, claimantId: r.job.claimantId });
      return r;
    }),
    "board.complete": guarded(async ({ jobId, result }, context) => {
      const caller = callerOf(context);
      if (caller.denial) return caller.denial;
      const r = await board.settleJob({ callerId: caller.callerId, jobId, result, outcome: "completed" });
      if (r.settled) fire({ type: "board-job-completed", jobId, posterId: r.job.posterId, claimantId: caller.callerId });
      return r;
    }),
    "board.fail": guarded(async ({ jobId, result }, context) => {
      const caller = callerOf(context);
      if (caller.denial) return caller.denial;
      const r = await board.settleJob({ callerId: caller.callerId, jobId, result, outcome: "failed" });
      if (r.settled) fire({ type: "board-job-failed", jobId, posterId: r.job.posterId, claimantId: caller.callerId });
      return r;
    }),
    "board.heartbeat": guarded(async ({ jobId }, context) => {
      const caller = callerOf(context);
      if (caller.denial) return caller.denial;
      return board.heartbeatJob({ callerId: caller.callerId, jobId });
    }),
    "board.list": guarded(async ({ status }) => {
      return { ok: true, jobs: await board.listJobs({ status: typeof status === "string" ? status : null }) };
    }),
    "board.read": guarded(async ({ jobId }) => {
      const job = await board.getJob(jobId);
      return job ? { ok: true, job } : { ok: false, error: "no such job" };
    }),
    "board.message": guarded(async ({ to, body, refJobId }, context) => {
      const caller = callerOf(context);
      if (caller.denial) return caller.denial;
      const r = await board.sendMessage({ callerId: caller.callerId, agents: await agents(), to, body, refJobId });
      if (r.ok) fire({ type: "board-message-posted", messageId: r.message.id, toId: r.message.toId });
      return r;
    }),
    "board.messages": guarded(async ({ limit }) => {
      const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, BOARD_MAX_MESSAGES) : 50;
      return { ok: true, messages: await board.listMessages({ limit: cap }) };
    }),
  };

  // The drain is NOT a route (mergeRouteMaps copies every entry) — it is the
  // startup/periodic delivery drain (review r2 P1-3).
  return { routes, drain: () => board.drainDeliveries() };
}

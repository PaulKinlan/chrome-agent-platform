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
        createdAt: ev.ts,
        status: "pending",
        claimantId: null,
        claimantName: null,
        claimedAt: null,
        leaseExpiry: null,
        result: null,
        settledAt: null,
      });
      continue;
    }
    const job = jobs.get(ev.jobId);
    if (!job) continue; // event for a pruned/unknown job — ignored
    if (ev.type === "claimed") {
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
      if (job.status !== "claimed" || job.claimantId !== ev.claimantId) continue;
      job.status = ev.type;
      job.result = ev.result ?? "";
      job.settledAt = ev.ts;
      job.leaseExpiry = null;
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

/** Prune the job event log: settled jobs' events are dropped oldest-first once
 *  past BOARD_MAX_SETTLED_JOBS; open jobs' events are NEVER dropped. */
export function pruneJobEvents(events, now = Date.now()) {
  const jobs = foldJobEvents(events, now);
  const settled = jobs.filter((j) => j.status === "completed" || j.status === "failed")
    .sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  const dropIds = new Set(settled.slice(0, Math.max(0, settled.length - BOARD_MAX_SETTLED_JOBS)).map((j) => j.id));
  if (dropIds.size === 0) return events;
  return (Array.isArray(events) ? events : []).filter((ev) => !dropIds.has(ev?.jobId));
}

/**
 * The board store: event-sourced, lock-serialized, over a hub-tier memory
 * (masterMemory()). Deps are injected so the KATs drive the exact production
 * logic with an in-memory stand-in.
 */
export function createAgentBoard({ memory, withLock = (fn) => fn(), now = () => Date.now() }) {
  async function loadJobs() {
    const events = (await memory.get(BOARD_JOBS_KEY).catch(() => null)) ?? [];
    return Array.isArray(events) ? events : [];
  }
  async function saveJobs(events) {
    await memory.set(BOARD_JOBS_KEY, pruneJobEvents(events, now()));
  }
  async function loadMessages() {
    const events = (await memory.get(BOARD_MESSAGES_KEY).catch(() => null)) ?? [];
    return Array.isArray(events) ? events : [];
  }

  const board = {
    /** Post a job. Returns { ok, job } or a structured guard denial. */
    async postJob({ callerId, agents, description, requiredCapability = null, targetAgentRef = null, blockedBy = [] }) {
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
        };
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
     *  claimant returns the already-settled record without a state change. */
    async settleJob({ callerId, jobId, result, outcome = "completed" }) {
      return withLock(async () => {
        const events = await loadJobs();
        const jobs = foldJobEvents(events, now());
        const job = jobs.find((j) => j.id === jobId) ?? null;
        if (!job) return { ok: false, code: "board-no-job", error: "no such job" };
        if (job.status === "completed" || job.status === "failed") {
          if (job.claimantId === callerId) {
            return { ok: true, alreadySettled: true, job };
          }
          return { ok: false, code: "board-settled", error: `job already ${job.status}` };
        }
        if (job.status !== "claimed" || job.claimantId !== callerId) {
          return { ok: false, code: "board-not-claimant", error: "only the current claimant can settle a job" };
        }
        const text = boardText(result, BOARD_MAX_RESULT);
        events.push({ type: outcome === "failed" ? "failed" : "completed", jobId, ts: now(), claimantId: callerId, result: text });
        await saveJobs(events);
        return { ok: true, job: foldJobEvents(events, now()).find((j) => j.id === jobId) };
      });
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
        await memory.set(BOARD_MESSAGES_KEY, events.slice(-BOARD_MAX_MESSAGES));
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
export function createAgentBoardRoutes({ memory, withLock, listAgents, resolveCaller, broadcast, now }) {
  const board = createAgentBoard({ memory, withLock, now });
  const agents = () => listAgents().catch(() => []);
  const callerOf = (context) => {
    const id = typeof resolveCaller === "function" ? resolveCaller(context) : null;
    return typeof id === "string" && id ? id : BOARD_HUB_ID;
  };
  const fire = (event) => { try { broadcast?.(event); } catch { /* UI wake is best-effort */ } };

  return {
    async "board.post"({ description, requiredCapability, targetAgent, blockedBy }, context) {
      const registry = await agents();
      const r = await board.postJob({
        callerId: callerOf(context),
        agents: registry,
        description,
        requiredCapability,
        targetAgentRef: targetAgent,
        blockedBy,
      });
      if (r.ok) fire({ type: "board-job-posted", jobId: r.job.id, capability: r.job.requiredCapability ?? null, targetAgentId: r.job.targetAgentId ?? null });
      return r;
    },
    async "board.claim"({ jobId }, context) {
      const r = await board.claimJob({ callerId: callerOf(context), agents: await agents(), jobId });
      if (r.ok) fire({ type: "board-job-claimed", jobId, claimantId: r.job.claimantId });
      return r;
    },
    async "board.complete"({ jobId, result }, context) {
      const r = await board.settleJob({ callerId: callerOf(context), jobId, result, outcome: "completed" });
      if (r.ok && !r.alreadySettled) fire({ type: "board-job-completed", jobId, posterId: r.job.posterId, claimantId: callerOf(context) });
      return r;
    },
    async "board.fail"({ jobId, result }, context) {
      const r = await board.settleJob({ callerId: callerOf(context), jobId, result, outcome: "failed" });
      if (r.ok && !r.alreadySettled) fire({ type: "board-job-failed", jobId, posterId: r.job.posterId, claimantId: callerOf(context) });
      return r;
    },
    async "board.heartbeat"({ jobId }, context) {
      return board.heartbeatJob({ callerId: callerOf(context), jobId });
    },
    async "board.list"({ status }) {
      return { ok: true, jobs: await board.listJobs({ status: typeof status === "string" ? status : null }) };
    },
    async "board.read"({ jobId }) {
      const job = await board.getJob(jobId);
      return job ? { ok: true, job } : { ok: false, error: "no such job" };
    },
    async "board.message"({ to, body, refJobId }, context) {
      const r = await board.sendMessage({ callerId: callerOf(context), agents: await agents(), to, body, refJobId });
      if (r.ok) fire({ type: "board-message-posted", messageId: r.message.id, toId: r.message.toId });
      return r;
    },
    async "board.messages"({ limit }) {
      const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, BOARD_MAX_MESSAGES) : 50;
      return { ok: true, messages: await board.listMessages({ limit: cap }) };
    },
  };
}

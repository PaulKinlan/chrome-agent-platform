// lib/agent-delegation.js — agent→agent delegation guards (AGENT-PRODUCT-GAPS
// G5, owner directive 2026-08-28: "agents invocable as skills").
//
// A running named agent may call the `delegate_to_agent` management tool to run
// another named agent as a CHILD execution (own persona/memory/provider) and
// receive its result as the tool result. EVERY guard lives here as a pure
// function so the KATs drive the exact production decision logic; the
// service-worker route (agent.delegate) is a thin stateful wrapper.
//
// Invariants (hard requirements):
//  - per-edge authorization: the CALLER agent's record must list the target in
//    `canDelegateTo` (owner-configured, empty = cannot delegate at all);
//  - depth ≤ MAX_DELEGATION_DEPTH (root run = depth 0; a depth-2 run cannot
//    delegate further);
//  - cycle detection: the target must not already appear in the delegation
//    path (A→B→A is rejected);
//  - descendant cap: a root run may spawn at most MAX_DELEGATION_DESCENDANTS
//    child runs in total;
//  - budget: the child's iteration cap never exceeds the parent's REMAINING
//    iterations (tracked from the live progress stream), hard-capped by
//    CHILD_ITERATION_CAP;
//  - the child inherits NO approvals from the parent (the SW simply never
//    forwards approvalBinding) and runs with its own agent record's grants.

export const MAX_DELEGATION_DEPTH = 2;
export const MAX_DELEGATION_DESCENDANTS = 4;
export const CHILD_ITERATION_CAP = 6;
/** Below this many remaining iterations a parent may not delegate at all —
 *  the child could not complete even a single act+respond cycle. */
export const MIN_REMAINING_ITERATIONS = 2;
export const MAX_DELEGATE_EDGES = 8;
export const DELEGATION_AUDIT_KEY = "cap:delegation-log";
export const DELEGATION_AUDIT_MAX = 100;

/** Normalize the owner-facing `canDelegateTo` list for the agent record:
 *  strings only, trimmed, deduped, bounded. Unknown ids are kept (the target
 *  may be created later; delegation-time resolution is the authority). */
export function normalizeCanDelegateTo(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || id.length > 128 || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_DELEGATE_EDGES) break;
  }
  return out;
}

/** Resolve a model-supplied target reference (id OR display name) against the
 *  live registry. Id match wins; name match is case-insensitive. Returns the
 *  agent record or null. */
export function resolveTargetAgent(ref, agents) {
  if (typeof ref !== "string" || !ref.trim() || !Array.isArray(agents)) return null;
  const needle = ref.trim();
  const byId = agents.find((a) => a && a.id === needle);
  if (byId) return byId;
  const lower = needle.toLowerCase();
  const byName = agents.filter((a) => a && typeof a.name === "string" && a.name.toLowerCase() === lower);
  return byName.length === 1 ? byName[0] : null; // ambiguous name → no resolution
}

/**
 * The delegation decision. `state` is the caller's LIVE run state:
 *   { agentId, rootRunId, depth, path: [agentIds…], maxIterations, step }
 * `descendantCount` is the root run's live child count.
 * Returns { ok:true, child: { depth, path, maxIterations } } or
 * { ok:false, code, error } — every denial is structured for the model.
 */
export function evaluateDelegation({ callerAgent, targetAgent, state, descendantCount }) {
  if (!state || typeof state !== "object" || typeof state.agentId !== "string") {
    return { ok: false, code: "delegation-context", error: "delegation is only available inside a running agent" };
  }
  if (!callerAgent || callerAgent.id !== state.agentId) {
    return { ok: false, code: "delegation-context", error: "the calling run's agent identity could not be verified" };
  }
  if (!targetAgent) {
    return { ok: false, code: "delegation-target", error: "no such agent — use list_named_agents to see who exists" };
  }
  if (targetAgent.id === callerAgent.id) {
    return { ok: false, code: "delegation-cycle", error: "an agent cannot delegate to itself" };
  }
  const edges = normalizeCanDelegateTo(callerAgent.canDelegateTo);
  if (!edges.includes(targetAgent.id)) {
    return {
      ok: false,
      code: "delegation-not-allowed",
      error: `${callerAgent.name ?? callerAgent.id} is not allowed to delegate to ${targetAgent.name ?? targetAgent.id} — the owner can add it under the agent's "Can delegate to" list`,
    };
  }
  const path = Array.isArray(state.path) ? state.path : [state.agentId];
  if (path.includes(targetAgent.id)) {
    return {
      ok: false,
      code: "delegation-cycle",
      error: `delegation cycle rejected (${[...path, targetAgent.id].join(" → ")})`,
    };
  }
  const depth = Number.isFinite(state.depth) ? state.depth : 0;
  if (depth + 1 > MAX_DELEGATION_DEPTH) {
    return {
      ok: false,
      code: "delegation-depth",
      error: `delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — this chain cannot delegate further`,
    };
  }
  if ((descendantCount ?? 0) >= MAX_DELEGATION_DESCENDANTS) {
    return {
      ok: false,
      code: "delegation-cap",
      error: `this run already has ${MAX_DELEGATION_DESCENDANTS} delegated child runs — the per-run delegation cap`,
    };
  }
  const remaining = Math.max(0, (state.maxIterations ?? 0) - (state.step ?? 0));
  if (remaining < MIN_REMAINING_ITERATIONS) {
    return {
      ok: false,
      code: "delegation-budget",
      error: "not enough of this run's iteration budget remains to delegate",
    };
  }
  return {
    ok: true,
    child: {
      depth: depth + 1,
      path: [...path, targetAgent.id],
      maxIterations: Math.min(remaining, CHILD_ITERATION_CAP),
    },
  };
}

/** The per-root-run descendant counter (in-memory enforcement; the durable
 *  record is the audit log). Bounded: entries are deleted when their root run
 *  settles, and the map is hard-capped so a leak of unsettled entries cannot
 *  grow forever. */
export function createDelegationRegistry({ maxEntries = 64 } = {}) {
  const counts = new Map(); // rootRunId -> { count, at }
  return {
    count(rootRunId) {
      return counts.get(rootRunId)?.count ?? 0;
    },
    /** Returns false when the cap is already reached (no increment). */
    acquire(rootRunId) {
      if (typeof rootRunId !== "string" || !rootRunId) return false;
      const entry = counts.get(rootRunId);
      if (entry) {
        if (entry.count >= MAX_DELEGATION_DESCENDANTS) return false;
        entry.count += 1;
        return true;
      }
      if (counts.size >= maxEntries) {
        // Evict the oldest entry — a run whose settle cleanup was lost (e.g.
        // the SW died mid-run) must not block delegation forever.
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [key, value] of counts) {
          if (value.at < oldestAt) { oldestAt = value.at; oldestKey = key; }
        }
        if (oldestKey != null) counts.delete(oldestKey);
      }
      counts.set(rootRunId, { count: 1, at: Date.now() });
      return true;
    },
    release(rootRunId) {
      counts.delete(rootRunId);
    },
    get size() {
      return counts.size;
    },
  };
}

/** The durable audit record (bounded text — no unbounded task bodies). */
export function delegationAuditRecord({
  rootRunId,
  parentRunId,
  childRunId,
  fromAgent,
  toAgent,
  task,
  outcome,
  detail = "",
}) {
  return {
    at: Date.now(),
    rootRunId: String(rootRunId ?? "").slice(0, 160),
    parentRunId: String(parentRunId ?? "").slice(0, 160),
    childRunId: String(childRunId ?? "").slice(0, 160),
    from: String(fromAgent ?? "").slice(0, 80),
    to: String(toAgent ?? "").slice(0, 80),
    task: String(task ?? "").slice(0, 140),
    outcome: outcome === "ok" ? "ok" : "error",
    detail: String(detail ?? "").slice(0, 200),
  };
}

/** Append to the bounded audit log through the injected store (masterMemory in
 *  the SW, a Map-backed stub in tests). Failures are swallowed by the caller —
 *  audit must never break a run — but the record shape is pinned here. */
export async function appendDelegationAudit(store, record) {
  const existing = (await store.get(DELEGATION_AUDIT_KEY).catch(() => null)) ?? [];
  const list = Array.isArray(existing) ? existing : [];
  list.push(record);
  while (list.length > DELEGATION_AUDIT_MAX) list.shift();
  await store.set(DELEGATION_AUDIT_KEY, list);
  return record;
}

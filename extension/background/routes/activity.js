// extension/background/routes/activity.js — the activity-log explorer route
// (PLAN.md + Paul's hard constraint: SEE the agents + what they did).
//
// Extracted from the service-worker inline handler (CAP-FB-20260826-RECENT-ACTIVITY-FILTER-01)
// to make the aggregation RESILIENT on real profiles:
//   - EVERY store read is individually fault-isolated: one corrupt/unreadable
//     journal (or a failing lister) must never take the whole route down —
//     before, a single rejecting read rejected the shared Promise.all and, far
//     worse, a SLOW enumeration over hundreds of stores could outlive the MV3
//     worker, whose kill leaves the caller's sendMessage callback NEVER fired
//     (the page-side load hangs forever: empty agent select + inert search —
//     exactly the owner's "the filter just doesn't work").
//   - The work is BOUNDED: at most N stores per class are enumerated and each
//     journal contributes at most its most-recent M entries, so the merge/sort
//     can never grow with profile age.

// Bounds (generous for the "recent activity" surface; the UI renders ≤100 rows).
export const ACTIVITY_STORE_CAPS = Object.freeze({
  namedAgents: 50,
  backgroundAgents: 50,
  sites: 50,
  perStoreEntries: 250,
});

/** Pure filter/sort/bound over the merged, source-tagged entries. Exported for
 * unit tests; the semantics are the route's contract (agent = exact source,
 * query = case-insensitive substring across the readable text, since/until
 * bound by ts, limit clamped to [1, 2000], most-recent-first). */
export function filterActivityEntries(entries, { agent, query, since, until, limit = 500 } = {}) {
  const bound = Math.max(1, Math.min(2000, Number(limit) || 500));
  const sinceTs = since ? Number(since) : null;
  const untilTs = until ? Number(until) : null;
  const q = String(query ?? "").trim().toLowerCase();
  const matchesAgent = agent
    ? (e) => e.source === agent
    : () => true;
  const matchesQuery = q
    ? (e) => {
        const hay = [
          e.agentLabel, e.type, e.task, e.result, e.tool, e.args, e.url,
          e.source, e.id,
        ].map((v) => (v == null ? "" : String(v))).join(" ").toLowerCase();
        return hay.includes(q);
      }
    : () => true;
  const matchesWindow = (e) =>
    (sinceTs == null || (e.ts ?? 0) >= sinceTs) &&
    (untilTs == null || (e.ts ?? 0) <= untilTs);
  return [...entries]
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
    .filter((e) => matchesAgent(e) && matchesQuery(e) && matchesWindow(e))
    .slice(0, bound);
}

export function createActivityRoutes({
  masterMemory,
  namedAgentMemory,
  backgroundAgentMemory,
  siteMemory,
  listNamedAgents,
  listNamedAgentIds,
  listBackgroundAgentIds,
  listOrigins,
  slugifyAgentId,
} = {}) {
  return Object.freeze({
    // Aggregates the per-store journals — the master, every NAMED agent
    // (memory/agents/<slug>), every BACKGROUND agent (memory/background/<slug>),
    // and every enrolled SITE origin — into ONE searchable/browsable timeline.
    // Each entry is TAGGED with its source so the "which agent did this"
    // attribution is preserved. Read-only (the journals are already bounded).
    async "activity.list"({ agent, query, since, until, limit = 500 } = {}) {
      const out = [];
      const push = async (store, source, agentLabel) => {
        try {
          const journal = await store.get("journal");
          if (!Array.isArray(journal)) return;
          // Per-store cap BEFORE the global merge: 500-entry journals × many
          // stores must never produce a 100k-entry merge/sort in the worker.
          for (const e of journal.slice(-ACTIVITY_STORE_CAPS.perStoreEntries)) {
            out.push({ ...e, source, agentLabel });
          }
        } catch {
          // One corrupt/unreadable store contributes nothing — it must never
          // reject the whole aggregation (the old Promise.all failure mode).
        }
      };
      const jobs = [push(masterMemory(), "master", "hub")];
      // Named agents — resolve their display names from the registry. A failing
      // lister degrades that class to zero stores, never to a route failure.
      const named = await listNamedAgents().catch(() => []);
      const namedById = new Map(named.map((a) => [slugifyAgentId(a.id), a]));
      const namedByInstance = new Map(named.map((a) => [String(a.instanceId ?? ""), a]));
      const namedIds = await listNamedAgentIds().catch(() => []);
      for (const id of namedIds.slice(0, ACTIVITY_STORE_CAPS.namedAgents)) {
        // Dir names are instanceId (post-fix) or legacy slug — resolve the
        // display row by EITHER identity.
        const reg = namedByInstance.get(id) ?? namedById.get(id);
        jobs.push(push(
          namedAgentMemory(id),
          `agent:${id}`,
          reg?.name || reg?.id || id,
        ));
      }
      // Background/scheduled agents (recipes + hook-driven runs) — the class
      // that can number in the HUNDREDS on a real profile, so the cap matters.
      const backgroundIds = await listBackgroundAgentIds().catch(() => []);
      for (const id of backgroundIds.slice(0, ACTIVITY_STORE_CAPS.backgroundAgents)) {
        jobs.push(push(backgroundAgentMemory(id), `background:${id}`, id));
      }
      // Enrolled site origins.
      const origins = await listOrigins().catch(() => []);
      for (const origin of origins.slice(0, ACTIVITY_STORE_CAPS.sites)) {
        jobs.push(push(siteMemory(origin), origin, origin));
      }
      await Promise.all(jobs);
      const entries = filterActivityEntries(out, { agent, query, since, until, limit });
      return { entries, count: entries.length, total: out.length };
    },
  });
}

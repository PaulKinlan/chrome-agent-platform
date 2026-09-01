// extension/background/routes/memory.js — the memory.get/set/list/clear
// routes plus the non-durable writer tracking the teardown fence depends on.
// Extracted from service-worker.js (teardown review r5 P1-b): the dispatcher
// must be IMPORTABLE so tests exercise the real route (not a predicate in
// isolation), and the quiescence machinery must be shared with the fence
// through a module seam rather than SW-closure state.

import {
  masterMemory,
  backgroundAgentMemory,
  namedAgentMemory,
  siteMemory,
} from "../../lib/memory.js";
import { readOnlyAgentMemorySelector } from "../../lib/named-agents.js";
import { sleep } from "../../lib/pure.js";

/** Resolve an `origin` label (the memory route's selector) to its OPFS store.
 * `master` → the hub's store; `background:<slug>` → a background/scheduled
 * agent's own store; `agent:<x>` → a named agent's store resolved through the
 * IMMUTABLE identity (review P1-2: a slug selector resolves to the row's
 * current instanceId namespace — never the reusable slug dir); anything else
 * → a site-origin store. This is the single place the memory
 * get/set/list/clear routes map a selector to a store. ASYNC: resolution
 * reads the registry. */
export async function resolveMemory(origin) {
  if (origin === "master") return masterMemory();
  if (typeof origin === "string" && origin.startsWith("background:")) {
    return backgroundAgentMemory(origin.slice("background:".length));
  }
  if (typeof origin === "string" && origin.startsWith("agent:")) {
    const { resolveNamedAgentStore } = await import("../../lib/named-agents.js");
    return resolveNamedAgentStore(origin.slice("agent:".length));
  }
  // review r3 P1-3: legacy/orphan agent dirs resolve to the LITERAL dir —
  // never canonicalized (that mismatch is exactly the bug where the
  // explorer's legacy Clear wiped the live store). Writes stay blocked at
  // the route level for the read-only legacy selector.
  if (typeof origin === "string" && (origin.startsWith("agent-legacy:") || origin.startsWith("agent-orphan:"))) {
    return namedAgentMemory(origin.slice(origin.indexOf(":") + 1));
  }
  return siteMemory(origin);
}

// review r3 P1-1: non-durable writer tracking. A direct memory.set/clear is
// a real writer against an agent namespace; teardown must be able to WAIT
// for in-flight writes instead of racing them into the directory purge.
const memoryWritesInflight = new Map(); // origin -> Set<Promise>
/** review r4 P1-3: quiescence keys are CANONICAL — a write tracked under a
 * legacy/orphan alias must be waitable via the agent's canonical `agent:<ns>`
 * key, or the fence waits on a name nobody tracked and a legacy write escapes
 * quiescence. normalizeMemoryKey is applied at BOTH ends (track + await). */
export function normalizeMemoryKey(origin) {
  const key = String(origin ?? "");
  const m = /^(?:agent-legacy|agent-orphan):(.+)$/.exec(key);
  return m ? `agent:${m[1]}` : key;
}
export function trackMemoryWrite(origin, promise) {
  const key = normalizeMemoryKey(origin);
  let set = memoryWritesInflight.get(key);
  if (!set) { set = new Set(); memoryWritesInflight.set(key, set); }
  set.add(promise);
  return promise.finally(() => {
    const cur = memoryWritesInflight.get(key);
    cur?.delete(promise);
    if (cur && cur.size === 0) memoryWritesInflight.delete(key);
  });
}
/** Resolve once NO tracked write is in flight for any of `origins` (bounded
 * wait — a wedged writer fails the fence honestly instead of hanging it). */
export async function awaitMemoryQuiescence(origins, timeoutMs = 5000) {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  for (const origin of origins) {
    // review r4 P1-3: both fence ends normalize — an alias write is awaited
    // under the agent's canonical key.
    const key = normalizeMemoryKey(origin);
    while (Date.now() < deadline) {
      const set = memoryWritesInflight.get(key);
      if (!set || set.size === 0) break;
      await Promise.race([
        Promise.allSettled([...set]),
        sleep(100),
      ]);
    }
    if (memoryWritesInflight.get(key)?.size) {
      return { ok: false, error: `memory writes still in flight for ${key}` };
    }
  }
  return { ok: true };
}

/** The memory.get/set/list/clear route handlers. Zero injected deps — store
 * resolution flows through resolveMemory above, which is also imported by the
 * SW for journal/run memory wiring. */
export function createMemoryRoutes() {
  return Object.freeze({
    async "memory.get"({ origin, key }) {
      // The internal namespace is never readable by the MODEL (the reviewer's
      // finding: __tx/assetRepair/assets/asset:/__epoch were readable/listed).
      if (/^(?:__gen|__tx|__wal|__epoch|__tombs|assets|assetRepair|asset:)/.test(String(key ?? ""))) {
        return { ok: false, error: `key "${key}" is reserved on this store` };
      }
      return await (await resolveMemory(origin)).get(key);
    },
    async "memory.set"({ origin, key, value }) {
      // review r4 P1-3: the legacy/orphan selectors resolve to the LITERAL dir
      // and are declared READ-ONLY (only agent teardown removes them). A set
      // here would recreate the dir after the purge — refuse, mirroring
      // memory.clear. The predicate is shared with the classification UI so
      // the rule cannot drift between route and panel.
      if (readOnlyAgentMemorySelector(origin)) {
        return { ok: false, error: "legacy store is read-only — delete the agent; teardown removes it" };
      }
      // review r3 P1-1: non-durable memory writes are tracked so teardown can
      // AWAIT them instead of racing a still-flushing writer into the purge.
      return trackMemoryWrite(origin, (async () =>
        (await (await resolveMemory(origin)).set(key, value)))());
    },
    async "memory.list"({ origin }) {
      const all = await (await resolveMemory(origin)).keys();
      return all.filter((k) => !/^(?:__gen|__tx|__wal|__epoch|__tombs|assets|assetRepair|asset:)/.test(k));
    },
    async "memory.clear"({ origin }) {
      // review r3 P1-3: a live agent's legacy slug dir is READ-ONLY — the only
      // thing that removes it is agent teardown (which purges BOTH
      // namespaces). Clearing it would either be a no-op lie or (pre-fix) the
      // canonicalizing resolver wiping the agent's LIVE store. Orphan dirs stay
      // CLEARABLE here (classification: readOnly:false) — the Settings purge
      // removes them; the shared predicate's WRITE refusal (set) still covers
      // both spellings.
      if (typeof origin === "string" && origin.startsWith("agent-legacy:")) {
        return { ok: false, error: "legacy store is read-only — delete the agent; teardown removes it" };
      }
      // `clear()` resolves to undefined, so the old shape gave the caller nothing
      // to check — Settings reported "Cleared…" whether or not anything happened.
      // Return an explicit result and let a failure surface.
      try {
        await trackMemoryWrite(origin, (async () => (await (await resolveMemory(origin)).clear()))());
        return { ok: true, origin };
      } catch (e) {
        return { ok: false, error: `could not clear memory: ${e?.message ?? e}` };
      }
    },
  });
}

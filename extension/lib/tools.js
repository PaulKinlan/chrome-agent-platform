// lib/tools.js — the tool directory: declared (WebMCP) + linked (agent.md/skills)
// + inferred (window.* functions) tools, with first-run approval per origin.

import { canonicalOrigin, listOrigins, siteMemory } from "./memory.js";
import { kvGet, kvSet } from "./kv.js";

const DIR_KEY = "toolDirectory";
const ENROLL_KEY = "cap:enrollment";
const GEN_KEY = "cap:enrollmentGen";

// A GLOBAL enrollment-state mutex: enrollOrigin/disenrollOrigin perform a
// read-modify-write on the SHARED `cap:enrollment` registry. Per-origin locks
// are NOT sufficient — two DIFFERENT origins created concurrently read the same
// old map and overwrite each other (the round-14 finding: 49/50 pairs lost one
// origin). One global lock serializes the registry RMW.
let enrollmentMutex = Promise.resolve();
/** The GLOBAL enrollment-state mutex. enrollOrigin/disenrollOrigin (and the
 * scripting-Disable capability transition) must hold it so a concurrent
 * enroll/delete can never interleave with a capability transition that snapshots
 * the origin set. EXPORTED so the SW's scripting-Disable can hold it across the
 * whole transition (a fixed-point recheck would still let a new enrollment slip
 * in after the final read — one global barrier is authoritative). */
export function withEnrollmentLock(fn) {
  const run = enrollmentMutex.then(fn, fn);
  enrollmentMutex = run.then(() => {}, () => {});
  return run;
}

/** A MONOTONIC, never-reused enrollment generation counter (the round-17 ABA
 * blocker: deriving `gen` from the current registry entry meant a pruned
 * tombstone reset the origin to generation 1, letting a stale in-flight
 * operation holding the old generation pass a future re-enrollment postcheck).
 * The ceiling lives in its OWN never-pruned key and only ever increments, so a
 * generation is never reissued even after tombstone pruning or re-enrollment. */
async function nextGeneration() {
  const s = await kvGet(GEN_KEY);
  const next = (Number(s[GEN_KEY]) || 0) + 1;
  await kvSet({ [GEN_KEY]: next });
  return next;
}

/** Read the enrollment registry (the authoritative enrolled:true set). */
async function enrolledMap() {
  const s = await kvGet(ENROLL_KEY);
  return s[ENROLL_KEY] ?? {};
}

/** Bounds for the tool directory (fail-closed against hostile descriptors). */
export const TOOL_BOUNDS = {
  maxNameLength: 128,
  maxDescriptionLength: 2000,
  maxSchemaBytes: 8192, // serialized JSON-schema size per tool
  maxToolsPerOrigin: 200,
  maxTotalBytes: 1024 * 1024, // serialized directory size per origin
};

/**
 * The canonical tool-descriptor shape. declared/inferred/linked marks the source.
 */
export function describeTool(t) {
  return {
    origin: t.origin,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    source: t.source, // "declared" | "inferred" | "linked"
  };
}

/** Bound a single descriptor; returns null when it violates the bounds. */
function boundTool(t) {
  const name = String(t.name ?? "");
  const description = String(t.description ?? "");
  const schema = t.inputSchema ?? { type: "object", properties: {} };
  if (name.length === 0 || name.length > TOOL_BOUNDS.maxNameLength) return null;
  if (description.length > TOOL_BOUNDS.maxDescriptionLength) return null;
  let schemaBytes;
  try {
    schemaBytes = JSON.stringify(schema).length;
  } catch {
    return null;
  }
  if (schemaBytes > TOOL_BOUNDS.maxSchemaBytes) return null;
  return describeTool({
    origin: t.origin,
    name,
    description,
    inputSchema: schema,
    source: t.source,
  });
}

export async function upsertTools(origin, tools) {
  const store = siteMemory(origin);
  const dir = (await store.get(DIR_KEY)) ?? [];
  const byName = new Map(dir.map((t) => [t.name, t]));
  for (const t of tools) {
    const bounded = boundTool(t);
    if (!bounded) continue; // reject (not silently accept) out-of-bounds descriptors
    byName.set(bounded.name, bounded);
  }
  let next = [...byName.values()];
  // Total directory size + count bounds: drop the tail when over budget.
  if (next.length > TOOL_BOUNDS.maxToolsPerOrigin) {
    next = next.slice(0, TOOL_BOUNDS.maxToolsPerOrigin);
  }
  let total = 0;
  next = next.filter((t) => {
    let b;
    try {
      b = JSON.stringify(t).length;
    } catch {
      b = TOOL_BOUNDS.maxTotalBytes + 1;
    }
    total += b;
    return total <= TOOL_BOUNDS.maxTotalBytes;
  });
  await store.setTrusted(DIR_KEY, next);
  return next;
}

export async function listTools(origin) {
  return (await siteMemory(origin).get(DIR_KEY)) ?? [];
}

export async function listAllOrigins() {
  return await listOrigins();
}

/** Whether an origin is CURRENTLY enrolled (owner-controlled). A deleted origin
 * is TOMBSTONED (enrolled:false), so a still-running content-script bridge can
 * never re-enroll it or report tools for it. */
export async function isEnrolled(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return false;
  const map = await enrolledMap();
  return Boolean(map[canonical] && map[canonical].enrolled === true);
}

/** The enrollment GENERATION for an origin — the revocation fence. Every
 * delegation/invocation path revalidates this (see service-worker agent.delegate
 * + invokeSiteTool) so a delete tombstones + bumps the generation atomically, and
 * a stale bridge/worker reference from before the delete is rejected. */
export async function enrollmentGeneration(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return 0;
  const map = await enrolledMap();
  return map[canonical]?.gen ?? 0;
}

/** An ATOMIC snapshot of an origin's enrollment (enrolled + generation) read
 * under the global enrollment lock — so a delete (which tombstones + bumps the
 * generation under the SAME lock) can never interleave with the read (the
 * round-16 generation-commit race: `isEnrolled` + `enrollmentGeneration` were
 * read as two separate unlocked kv reads, so a delete could slip between them). */
export async function enrollmentSnapshot(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { enrolled: false, gen: 0 };
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const e = map[canonical];
    return { enrolled: Boolean(e && e.enrolled === true), gen: e?.gen ?? 0 };
  });
}

export async function enrollOrigin(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error(`invalid origin: ${origin}`);
  return withEnrollmentLock(async () => {
    // Create the site's OWN OPFS store directory (so per-site memory works)
    // BEFORE the registry update. The registry is the authority; the OPFS dir
    // is just data (listOrigins never enumerates OPFS directories). `enrolled`
    // is a reserved site key, written via the TRUSTED path (never model-
    // writable via memory_set).
    await siteMemory(canonical).setTrusted("enrolled", { at: Date.now() });
    const map = await enrolledMap();
    map[canonical] = {
      enrolled: true,
      at: Date.now(),
      gen: await nextGeneration(),
    };
    await kvSet({ [ENROLL_KEY]: map });
    return Object.keys(map).filter((o) => map[o]?.enrolled === true);
  });
}

/** Tombstone an origin's enrollment (enrolled:false) under the GLOBAL lock so a
 * running bridge's reports are rejected and listOrigins drops it. The
 * generation bump is the preemptive revocation fence: any in-flight operation
 * holding the old generation is rejected at its next revalidation. */
export async function disenrollOrigin(origin) {
  return withEnrollmentLock(() => disenrollOriginLocked(origin));
}

/** The LOCKED body of disenrollOrigin (no re-acquisition). Exported so the SW's
 * scripting-Disable can tombstone every enrolled origin while ALREADY holding the
 * global enrollment lock (re-acquiring it inside the per-origin cleanup would
 * deadlock, and NOT holding it would let a concurrent enroll slip between the
 * snapshot and the tombstone — the round-20 scripting-Disable-snapshot finding). */
export async function disenrollOriginLocked(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return [];
  const map = await enrolledMap();
  map[canonical] = {
    enrolled: false, // tombstone
    at: Date.now(),
    gen: await nextGeneration(),
  };
  await kvSet({ [ENROLL_KEY]: map });
  // Bound tombstone retention: enrolled:false entries only exist to fence a
  // still-running bridge's generation. Keep at most MAX_TOMBSTONES (oldest
  // first) so a churn of enroll/delete cycles cannot grow the registry without
  // bound (the round-16 quota finding: tombstones accumulated indefinitely).
  const MAX_TOMBSTONES = 200;
  const tombstones = Object.entries(map)
    .filter(([, v]) => v?.enrolled !== true)
    .sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0));
  if (tombstones.length > MAX_TOMBSTONES) {
    for (const [o] of tombstones.slice(0, tombstones.length - MAX_TOMBSTONES)) {
      delete map[o];
    }
    await kvSet({ [ENROLL_KEY]: map });
  }
  return Object.keys(map).filter((o) => map[o]?.enrolled === true);
}

/**
 * First-run approval: a tool on an origin requires one-time user approval
 * before the agent may call it. Approved state is stored per (origin, tool).
 */
export async function isApproved(origin, toolName) {
  const approved = (await siteMemory(origin).get("approvals")) ?? {};
  return Boolean(approved[toolName]);
}

export async function approveTool(origin, toolName, decision = true) {
  const store = siteMemory(origin);
  const approved = (await store.get("approvals")) ?? {};
  if (decision) approved[toolName] = Date.now();
  else delete approved[toolName];
  await store.setTrusted("approvals", approved);
  return approved;
}

export async function pendingApprovals(origin) {
  const tools = await listTools(origin);
  const approved = (await siteMemory(origin).get("approvals")) ?? {};
  return tools.filter((t) => !approved[t.name]);
}

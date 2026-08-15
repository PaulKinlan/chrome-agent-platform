// lib/tools.js — the tool directory: declared (WebMCP) + linked (agent.md/skills)
// + inferred (window.* functions) tools, with first-run approval per origin.

import { canonicalOrigin, listOrigins, siteMemory } from "./memory.js";
import { kvGet, kvSet } from "./kv.js";

const DIR_KEY = "toolDirectory";
const ENROLL_KEY = "cap:enrollment";

// A GLOBAL enrollment-state mutex: enrollOrigin/disenrollOrigin perform a
// read-modify-write on the SHARED `cap:enrollment` registry. Per-origin locks
// are NOT sufficient — two DIFFERENT origins created concurrently read the same
// old map and overwrite each other (the round-14 finding: 49/50 pairs lost one
// origin). One global lock serializes the registry RMW.
let enrollmentMutex = Promise.resolve();
function withEnrollmentLock(fn) {
  const run = enrollmentMutex.then(fn, fn);
  enrollmentMutex = run.then(() => {}, () => {});
  return run;
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
      gen: (map[canonical]?.gen ?? 0) + 1,
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
  const canonical = canonicalOrigin(origin);
  if (!canonical) return [];
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    map[canonical] = {
      enrolled: false, // tombstone
      at: Date.now(),
      gen: (map[canonical]?.gen ?? 0) + 1,
    };
    await kvSet({ [ENROLL_KEY]: map });
    return Object.keys(map).filter((o) => map[o]?.enrolled === true);
  });
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

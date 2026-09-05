// lib/tools.js — the tool directory: declared (WebMCP) + linked (agent.md/skills)
// + inferred (window.* functions) tools, with first-run approval per origin.

import { canonicalOrigin, listOrigins, siteMemory } from "./memory.js";
import { kvGet, kvSet } from "./kv.js";
import {
  buildSiteIdentity,
  canonicalPageUrl,
  canonicalPath,
  historicalSiteIdentity,
  SITE_HISTORY_MAX,
} from "./site-identity.js";
import {
  currentSiteToolConsentProfileEpoch,
  invalidateSiteToolConsentWriters,
  listSiteToolConsentStates,
  resetSiteToolConsents,
  setSiteToolConsent,
  siteToolConsentSnapshot,
  withSiteToolConsentBarrier,
} from "./site-tool-consent.js";

export {
  currentSiteToolConsentProfileEpoch,
  invalidateSiteToolConsentWriters,
  withSiteToolConsentBarrier,
};

const DIR_KEY = "toolDirectory";
export const SITE_IDENTITIES_KEY = "site_identities";
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

/** The coarse per-site tool switch. Enrollment creates discovery and worker
 * custody, never automatic tool consent. "allow" means exact tools may enter
 * the first-use consent state machine; "deny" is the site's hard off switch.
 * The legacy "ask" value is still accepted when reading old profiles and has
 * the same first-use semantics as "allow" — it no longer means per-call nags. */
export const SITE_TOOL_POLICIES = Object.freeze(["allow", "deny", "ask"]);
export function isSiteToolPolicy(value) {
  return typeof value === "string" && SITE_TOOL_POLICIES.includes(value);
}
export const DEFAULT_SITE_TOOL_POLICY = "allow";

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
 * Supports page/path scoping (CAP-FB-20260824-WEBMCP-PAGE-IDENTITY-01).
 */
export function describeTool(t) {
  const pageUrl = typeof t?.pageUrl === "string" && t.pageUrl
    ? canonicalPageUrl(t.pageUrl, t.origin)
    : (typeof t?.page === "string" ? canonicalPageUrl(t.page, t.origin) : undefined);
  const path = pageUrl
    ? canonicalPath(pageUrl)
    : (typeof t?.path === "string" ? t.path : undefined);
  const out = {
    origin: t.origin,
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object", properties: {} },
    source: t.source, // "declared" | "inferred" | "linked"
  };
  if (pageUrl) out.pageUrl = pageUrl;
  if (path) out.path = path;
  return out;
}

/** Bound a single descriptor; returns null when it violates the bounds. */
function boundTool(t) {
  if (!t || typeof t !== "object") return null; // hostile/garbage entries never crash the fold
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
    pageUrl: t.pageUrl ?? t.page,
    path: t.path,
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

function boundedSnapshot(tools, origin = null, pageUrl = null) {
  const seen = new Set();
  const accepted = [];
  for (const t of Array.isArray(tools) ? tools : []) {
    const orig = origin ?? t?.origin;
    const pUrl = pageUrl ?? t?.pageUrl ?? t?.page;
    const bounded = boundTool({ ...t, origin: orig, pageUrl: pUrl });
    if (!bounded) continue; // reject (not silently accept) out-of-bounds descriptors
    if (bounded.source !== "declared" && bounded.source !== "inferred") continue;
    if (seen.has(bounded.name)) continue; // first descriptor for a name wins
    seen.add(bounded.name);
    accepted.push(bounded);
    if (accepted.length >= TOOL_BOUNDS.maxToolsPerOrigin) break;
  }
  let total = 0;
  return accepted.filter((t) => {
    let b;
    try {
      b = JSON.stringify(t).length;
    } catch {
      b = TOOL_BOUNDS.maxTotalBytes + 1;
    }
    total += b;
    return total <= TOOL_BOUNDS.maxTotalBytes;
  });
}

/** A COMPLETE discovery snapshot REPLACES the origin's discovered tool set
 * (declared + inferred). A tool that disappeared from the page is REMOVED from
 * the directory — a removed page tool must not linger listed/approvable
 * forever — and an EMPTY snapshot is a valid "this page now exposes nothing"
 * replacement that clears the discovered set. Only the page-discovery sources
 * are accepted (a snapshot never writes linked/other-source entries). Returns
 * the bounded, accepted directory. */
export async function replaceTools(origin, tools, pageUrl = null) {
  const next = boundedSnapshot(tools, origin, pageUrl);
  await siteMemory(origin).setTrusted(DIR_KEY, next);
  return next;
}

function emptyIdentityStore() {
  return { version: 2, current: null, history: [] };
}

async function readIdentityStore(origin) {
  const raw = await siteMemory(origin).get(SITE_IDENTITIES_KEY).catch(() => null);
  if (!raw || raw.version !== 2) return emptyIdentityStore();
  return {
    version: 2,
    current: raw.current && typeof raw.current === "object" ? raw.current : null,
    history: Array.isArray(raw.history)
      ? raw.history.map(historicalSiteIdentity).filter(Boolean).slice(0, SITE_HISTORY_MAX)
      : [],
  };
}

/** Replace the reporting page's slice in the tool directory and commit the
 * matching page/document/toolset identity (CAP-FB-20260824-WEBMCP-PAGE-IDENTITY-01).
 * Tools belonging to other same-origin pages and legacy origin-only tools are
 * preserved, while the reporting page's previous slice is replaced wholesale
 * (an empty snapshot clears only the reporting page's slice). */
export async function replacePageTools(origin, tools, page = null) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { tools: [], identity: null };
  const pageUrl = page?.pageUrl ? canonicalPageUrl(page.pageUrl, canonical) : null;
  const path = pageUrl ? canonicalPath(pageUrl) : (page?.path ?? "/");
  const store = siteMemory(canonical);

  // 1. Process the incoming tools for this page slice
  const decorated = (Array.isArray(tools) ? tools : []).map((t) => ({
    ...t,
    origin: canonical,
    pageUrl: pageUrl ?? undefined,
    path: path ?? undefined,
  }));
  const newPageTools = boundedSnapshot(decorated, canonical, pageUrl);

  // 2. Read existing directory and retain slices from OTHER pages
  const existingDir = (await store.get(DIR_KEY)) ?? [];
  const isTargetSlice = (t) => {
    if (pageUrl && t?.pageUrl) return t.pageUrl === pageUrl;
    if (path && path !== "/" && t?.path) return t.path === path;
    if (!pageUrl || path === "/") {
      // The reporting page is the root / origin-only scope:
      return !t?.pageUrl || t?.path === "/" || !t?.path;
    }
    return false;
  };
  // A page-scoped report SUPERSEDES a same-named LEGACY origin-only entry
  // (CAP page-open fix): a directory written before page scoping holds entries
  // with no pageUrl/path; the fresh page report is the more precise truth for
  // that tool (it carries the declaring page). Without this, the legacy entry
  // shadows the upgrade FOREVER (name-dedup kept the older row) and invocation
  // opens the origin ROOT instead of the declaring page — the owner's bistro
  // bug. Same-named entries from OTHER pages are still superseded below by
  // freshest-first ordering (the latest complete snapshot is the current
  // truth for that name); distinct-named tools on other pages are untouched.
  const newNames = new Set(newPageTools.map((t) => t.name));
  const isLegacyOriginOnly = (t) => !t?.pageUrl && (!t?.path || t?.path === "/");
  const otherSlices = existingDir.filter((t) => {
    if (isTargetSlice(t)) return false;
    if (pageUrl && newNames.has(t?.name) && isLegacyOriginOnly(t)) return false;
    return true;
  });

  // 3. Merge: the FRESH page slice first (it wins same-name collisions), then
  // the retained slices from other pages.
  const merged = [...newPageTools, ...otherSlices];

  // 4. Bound total directory size and tool counts
  const seen = new Set();
  const deduped = [];
  for (const t of merged) {
    if (!t || seen.has(t.name)) continue;
    seen.add(t.name);
    deduped.push(t);
    if (deduped.length >= TOOL_BOUNDS.maxToolsPerOrigin) break;
  }
  let total = 0;
  const next = deduped.filter((t) => {
    let b;
    try {
      b = JSON.stringify(t).length;
    } catch {
      b = TOOL_BOUNDS.maxTotalBytes + 1;
    }
    total += b;
    return total <= TOOL_BOUNDS.maxTotalBytes;
  });

  // 5. Update site_identities
  const identity = page ? await buildSiteIdentity({ ...page, origin: canonical, tools: newPageTools }) : null;
  if (identity) {
    const identities = await readIdentityStore(canonical);
    const previous = identities.current && identities.current.state === "known" && identities.current.id !== identity.id
      ? historicalSiteIdentity(identities.current)
      : null;
    const history = [previous, ...identities.history]
      .filter((item) => item?.id && item.id !== identity.id)
      .filter((item, index, arr) => arr.findIndex((x) => x.id === item.id) === index)
      .slice(0, SITE_HISTORY_MAX);
    await store.setTrusted(SITE_IDENTITIES_KEY, { version: 2, current: identity, history });
  }

  // 6. Commit merged directory
  await store.setTrusted(DIR_KEY, next);
  return { tools: next, identity, pageTools: newPageTools };
}

export async function getCurrentSiteIdentity(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return null;
  return (await readIdentityStore(canonical)).current;
}

export async function listSiteIdentityHistory(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return [];
  return (await readIdentityStore(canonical)).history;
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

/** An ATOMIC snapshot of an origin's enrollment (enrolled + generation +
 * policy) read under the global enrollment lock — so a delete (which tombstones
 * + bumps the generation under the SAME lock) can never interleave with the
 * read (the round-16 generation-commit race: `isEnrolled` + `enrollmentGeneration`
 * were read as two separate unlocked kv reads, so a delete could slip between
 * them). Policy rides the same atomic snapshot so a policy flip is never seen
 * half-applied (the deny-toolset gate). */
export async function enrollmentSnapshot(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return { enrolled: false, gen: 0, policy: DEFAULT_SITE_TOOL_POLICY };
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const e = map[canonical];
    return {
      enrolled: Boolean(e && e.enrolled === true),
      gen: e?.gen ?? 0,
      policy: isSiteToolPolicy(e?.policy) ? e.policy : DEFAULT_SITE_TOOL_POLICY,
    };
  });
}

/** The CURRENT tool-use policy for an origin ("allow" when not enrolled — the
 * site has no tools in any agent toolset either way). */
export async function enrollmentPolicy(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return DEFAULT_SITE_TOOL_POLICY;
  const snap = await enrollmentSnapshot(canonical);
  return snap.enrolled ? snap.policy : DEFAULT_SITE_TOOL_POLICY;
}

/** Set an enrolled origin's tool-use policy (allow | deny | ask). The registry
 * entry is updated under the GLOBAL enrollment lock (same RMW discipline as
 * enroll/delete), and the generation is bumped like a disenroll: an owner
 * policy flip is a revocation fence — any in-flight catalog/run captured under
 * the old policy is rejected at its next revalidation, so a flip to "deny" can
 * never leave a stale run with live tool access. Returns the new policy; throws
 * on an invalid policy or a non-enrolled origin (there is nothing to gate). */
export async function setEnrollmentPolicy(origin, policy) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error(`invalid origin: ${origin}`);
  if (!isSiteToolPolicy(policy)) {
    throw new Error(`invalid site tool policy: ${String(policy)}`);
  }
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const entry = map[canonical];
    if (!entry || entry.enrolled !== true) {
      throw new Error(`origin ${canonical} is not enrolled`);
    }
    const next = { ...entry, policy, gen: await nextGeneration() };
    map[canonical] = next;
    await kvSet({ [ENROLL_KEY]: map });
    return next.policy;
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
      // This is the coarse site switch only. Every exact tool still starts at
      // first-use consent; enrollment never creates an automatic-use grant.
      policy: DEFAULT_SITE_TOOL_POLICY,
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

/** Exact-tool consent layered over enrollment. Absence is ASK, Allow is
 * profile-durable for the current execution-relevant descriptor identity, and
 * Deny remains sticky by exact origin/name until Settings changes it. */
export async function toolConsentSnapshot(origin, toolName) {
  const canonical = canonicalOrigin(origin);
  const enrollment = await enrollmentSnapshot(canonical);
  if (!canonical || !enrollment.enrolled) {
    return { state: "ask", enrolled: false, enrollmentGen: enrollment.gen ?? 0, revision: 0 };
  }
  const tools = await listTools(canonical);
  const tool = tools.find((candidate) => candidate?.name === toolName);
  if (!tool) throw new Error(`no such tool on ${canonical}: ${String(toolName)}`);
  return { ...(await siteToolConsentSnapshot(canonical, tool, enrollment.gen)), enrolled: true };
}

/** Read every exact-tool consent while the caller ALREADY holds the global
 * enrollment lock. This deliberately does not re-enter withEnrollmentLock —
 * scripting Disable holds that lock across its audit + tombstone transition. */
export async function toolConsentStatesLocked(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return [];
  const map = await enrolledMap();
  const enrollment = map[canonical];
  if (!enrollment || enrollment.enrolled !== true) return [];
  const tools = await listTools(canonical);
  return await listSiteToolConsentStates(canonical, tools, enrollment.gen ?? 0);
}

export async function toolConsentStates(origin) {
  return await withEnrollmentLock(() => toolConsentStatesLocked(origin));
}

export async function isApproved(origin, toolName) {
  try {
    return (await toolConsentSnapshot(origin, toolName)).state === "allowed";
  } catch {
    return false;
  }
}

export async function setToolConsentDecision(origin, toolName, state, options = {}) {
  const canonical = canonicalOrigin(origin);
  const enrollment = await enrollmentSnapshot(canonical);
  if (!canonical || !enrollment.enrolled) throw new Error("origin not enrolled");
  const tools = await listTools(canonical);
  const tool = tools.find((candidate) => candidate?.name === toolName);
  if (!tool) throw new Error(`no such tool on ${canonical}: ${String(toolName)}`);
  return await setSiteToolConsent(canonical, tool, enrollment.gen, state, options);
}

/** Legacy exact-owner route compatibility: true allows; false rearms ASK. */
export async function approveTool(origin, toolName, decision = true) {
  return await setToolConsentDecision(origin, toolName, decision === true ? "allowed" : "ask");
}

export async function resetToolConsents(origin, mode = "all", options = {}) {
  const canonical = canonicalOrigin(origin);
  const enrollment = await enrollmentSnapshot(canonical);
  if (!canonical || !enrollment.enrolled) throw new Error("origin not enrolled");
  return await resetSiteToolConsents(canonical, enrollment.gen, mode, options);
}

export async function pendingApprovals(origin) {
  const canonical = canonicalOrigin(origin);
  const enrollment = await enrollmentSnapshot(canonical);
  if (!canonical || !enrollment.enrolled) return [];
  const tools = await listTools(canonical);
  const states = await listSiteToolConsentStates(canonical, tools, enrollment.gen);
  return tools.filter((tool) => states.find((state) => state.name === tool.name)?.state === "ask");
}

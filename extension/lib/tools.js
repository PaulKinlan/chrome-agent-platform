// lib/tools.js — the tool directory: declared (WebMCP) + linked (agent.md/skills)
// + inferred (window.* functions) tools, with first-run approval per origin.

import { canonicalOrigin, listOrigins, siteMemory } from "./memory.js";
import { kvGet, kvSet, kvSetDurable } from "./kv.js";
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
  SITE_TOOL_CONSENT_KEY,
  promoteEphemeralSiteToolConsents,
  validateSiteToolPromotionRecords,
  verifyPromotedSiteToolConsents,
  snapshotSiteToolConsentForPolicy,
  storedSiteToolDenyProposals,
  writeAndVerifyPolicyConsent,
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
async function nextGeneration({ requireDurable = false } = {}) {
  const s = await kvGet(GEN_KEY);
  const next = (Number(s[GEN_KEY]) || 0) + 1;
  if (requireDurable) await kvSetDurable({ [GEN_KEY]: next });
  else await kvSet({ [GEN_KEY]: next });
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
  return Boolean(map[canonical] && map[canonical].enrolled === true && !map[canonical].phase && !map[canonical].promotionPending);
}

/** The enrollment GENERATION for an origin — the revocation fence. Every
 * delegation/invocation path revalidates this (see service-worker agent.delegate
 * + invokeSiteTool) so a delete tombstones + bumps the generation atomically, and
 * a stale bridge/worker reference from before the delete is rejected. */
export async function enrollmentGeneration(origin, { requireActive = false } = {}) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) return 0;
  const map = await enrolledMap();
  const row = map[canonical];
  if (requireActive && (row?.enrolled !== true || row?.phase || row?.promotionPending)) return 0;
  return row?.gen ?? 0;
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
      enrolled: Boolean(e && e.enrolled === true && !e.phase && !e.promotionPending),
      ...(e?.promotionPending ? { pending: true } : {}),
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
export async function setEnrollmentPolicy(origin, policy, { commitGuard = null } = {}) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error(`invalid origin: ${origin}`);
  if (!isSiteToolPolicy(policy)) {
    throw new Error(`invalid site tool policy: ${String(policy)}`);
  }
  if (commitGuard !== null && typeof commitGuard !== "function") throw new Error("site_policy_guard_invalid");
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const entry = map[canonical];
    if (!entry || entry.enrolled !== true || entry.phase || entry.promotionPending) {
      throw new Error(`origin ${canonical} is not enrolled`);
    }
    if (entry.policy === policy) return policy;
    return withSiteToolConsentBarrier(async () => {
      // Hold enrollment→consent across the snapshot, pending write, OPFS copy
      // and authority flip. No stale in-flight consent writer can overwrite
      // the new generation after read-back but before it becomes executable.
      const previous = await snapshotSiteToolConsentForPolicy(canonical, entry.gen);
      const revision = previous.revision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("site_tool_consent_revision");
      // The policy flip MUST advance the generation to revoke in-flight Allow.
      // Only sticky Deny is carried into the pending copy and new-gen envelope;
      // prior Allow returns to ASK because the owner changed coarse policy.
      // Full profile reset (including Deny) is a separate, explicit decision.
      const carriedDeny = previous.records.filter((record) => record.state === "denied");
      if (commitGuard && commitGuard() !== true) throw new Error("site_policy_promotion_cancelled");
      const gen = await nextGeneration({ requireDurable: true });
      const pending = { enrolled: false, phase: "policy-pending", gen, at: Date.now(), policy,
        consentCopy: { revision, records: carriedDeny } };
      map[canonical] = pending;
      await kvSetDurable({ [ENROLL_KEY]: map });
      await completePolicyPromotionLocked(canonical, map, pending, commitGuard);
      return policy;
    });
  });
}

async function completePolicyPromotionLocked(canonical, map, entry, commitGuard = null) {
  if (entry?.phase !== "policy-pending" || entry.enrolled !== false ||
    !Number.isSafeInteger(entry.gen) || entry.gen < 1) throw new Error("site_policy_promotion_stale");
  if (commitGuard && commitGuard() !== true) throw new Error("site_policy_promotion_cancelled");
  await writeAndVerifyPolicyConsent(canonical, entry.gen, entry.consentCopy);
  if (commitGuard && commitGuard() !== true) throw new Error("site_policy_promotion_cancelled");
  const { phase: _phase, consentCopy: _copy, ...ready } = entry;
  map[canonical] = { ...ready, enrolled: true };
  await kvSetDurable({ [ENROLL_KEY]: map });
  return Object.freeze({ origin: canonical, gen: entry.gen, policy: entry.policy });
}

/** Stage a non-authorizing, durable owner promotion. Only a trusted owner
 * gesture calls this while holding the per-origin lock; the global lock owns
 * the one authoritative registry RMW. No worker or OPFS `enrolled` key exists
 * at this point. The complete decision copy survives MV3 restart.
 */
export async function prepareEnrollmentPromotion(origin, records, { commitGuard = null } = {}) {
  const canonical = canonicalOrigin(origin);
  const decisions = validateSiteToolPromotionRecords(records);
  if (!canonical || (commitGuard !== null && typeof commitGuard !== "function")) {
    throw new Error("site_enrollment_promotion_invalid");
  }
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    if (map[canonical]?.enrolled === true || map[canonical]?.phase) {
      throw new Error("site_enrollment_promotion_competing");
    }
    return withSiteToolConsentBarrier(async () => {
      if (commitGuard && commitGuard() !== true) throw new Error("site_enrollment_promotion_cancelled");
      // Scripting Disable leaves an old-generation envelope behind. Under
      // enrollment→consent, fold its sticky Deny by exact name into the durable
      // intent; a run Allow can NEVER displace that Deny. Old Allow is ASK
      // after the generation bump. No page-sourced inferred tool is admitted.
      const folded = new Map(decisions.map((record) => [record.name, record]));
      for (const denied of await storedSiteToolDenyProposals(canonical)) folded.set(denied.name, denied);
      const promotionPending = validateSiteToolPromotionRecords([...folded.values()]);
      const gen = await nextGeneration({ requireDurable: true });
      const pending = { enrolled: true, phase: "promotion-pending", gen,
        at: Date.now(), policy: DEFAULT_SITE_TOOL_POLICY, freshConsentEnvelope: true,
        promotionPending };
      if (commitGuard && commitGuard() !== true) throw new Error("site_enrollment_promotion_cancelled");
      map[canonical] = pending;
      if (await kvSetDurable({ [ENROLL_KEY]: map }) !== "durable") throw new Error("site_enrollment_not_durable");
      return Object.freeze({ origin: canonical, gen, phase: "promotion-pending" });
    });
  });
}

/** Verify the exact-generation consent envelope and Chrome-owned host/script
 * preconditions BEFORE clearing promotionPending. That one durable clear is
 * the sole authority flip; every fault leaves the same registry copy inert.
 */
export async function completeEnrollmentPromotion(origin, gen, { commitGuard = null, beforeFlip = null } = {}) {
  const canonical = canonicalOrigin(origin);
  if (!canonical || !Number.isSafeInteger(gen) || gen < 1 ||
    (commitGuard !== null && typeof commitGuard !== "function")) throw new Error("site_enrollment_promotion_invalid");
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const entry = map[canonical];
    if (entry?.gen !== gen || (entry.phase !== "promotion-pending" &&
      entry.phase !== "promotion-retry" && entry.phase !== "policy-pending")) {
      throw new Error("site_enrollment_promotion_stale");
    }
    if (entry.phase === "policy-pending") {
      return withSiteToolConsentBarrier(() => completePolicyPromotionLocked(canonical, map, entry, commitGuard));
    }
    if (entry.enrolled !== true || entry.freshConsentEnvelope !== true ||
      typeof beforeFlip !== "function") throw new Error("site_enrollment_promotion_unverified");
    const decisions = validateSiteToolPromotionRecords(entry.promotionPending);
    if (commitGuard && commitGuard() !== true) throw new Error("site_enrollment_promotion_cancelled");
    return await withSiteToolConsentBarrier(async () => {
      await promoteEphemeralSiteToolConsents(canonical, gen, decisions, {
        commitGuard, consentLockHeld: true, recoverPending: true,
      });
      await verifyPromotedSiteToolConsents(canonical, gen, decisions);
      // The callback checks ensureOriginScriptsRegistered AND Chrome-owned host
      // permission. It runs while origin→enrollment→consent remain held.
      const ready = await beforeFlip(canonical);
      if (ready?.scriptsRegistered !== true || ready?.hostGranted !== true) {
        throw new Error("site_enrollment_promotion_precondition_missing");
      }
      if (commitGuard && commitGuard() !== true) throw new Error("site_enrollment_promotion_cancelled");
      const { phase: _phase, promotionPending: _pending, freshConsentEnvelope: _fresh, ...authorized } = entry;
      map[canonical] = { ...authorized, enrolled: true };
      if (await kvSetDurable({ [ENROLL_KEY]: map }) !== "durable") throw new Error("site_enrollment_not_durable");
      return Object.freeze({ origin: canonical, gen, enrolled: true });
    });
  });
}

/** Recovery never consumes SW-only run tokens; it sees just bounded
 * origin/generation identifiers while the durable decision copy stays inside
 * the registry. `completeEnrollmentPromotion` revalidates it under the lock.
 * `promotion-retry` remains readable solely for profiles written by the
 * earlier D2 checkpoint; current code creates only `promotion-pending`.
 */
export async function listPendingEnrollmentPromotions() {
  const map = await enrolledMap();
  return Object.entries(map)
    .filter(([, row]) => ((row?.enrolled === true &&
      (row.phase === "promotion-pending" || row.phase === "promotion-retry") &&
      Array.isArray(row.promotionPending)) ||
      (row?.enrolled === false && row.phase === "policy-pending")) &&
      Number.isSafeInteger(row.gen) && row.gen > 0)
    .map(([origin, row]) => Object.freeze({ origin, gen: row.gen, phase: row.phase }));
}

/** Owner abandonment tombstones the pending authority FIRST. A failed OPFS
 * cleanup cannot resurrect it; the durable tombstone carries a retry marker.
 */
export async function abandonEnrollmentPromotion(origin, gen) {
  const canonical = canonicalOrigin(origin);
  if (!canonical || !Number.isSafeInteger(gen) || gen < 1) throw new Error("site_enrollment_promotion_invalid");
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const row = map[canonical];
    if ((row?.phase !== "promotion-pending" && row?.phase !== "promotion-retry") ||
      row.enrolled !== true || !Array.isArray(row.promotionPending) || row.gen !== gen) {
      throw new Error("site_enrollment_promotion_stale");
    }
    map[canonical] = { enrolled: false, at: Date.now(), gen: await nextGeneration({ requireDurable: true }),
      cleanupPending: true };
    await kvSetDurable({ [ENROLL_KEY]: map });
    try {
      await siteMemory(canonical).delete(SITE_TOOL_CONSENT_KEY);
      delete map[canonical].cleanupPending;
      await kvSetDurable({ [ENROLL_KEY]: map });
      return Object.freeze({ abandoned: true, cleanupPending: false });
    } catch {
      return Object.freeze({ abandoned: true, cleanupPending: true });
    }
  });
}

export async function listAbandonedEnrollmentCleanups() {
  const map = await enrolledMap();
  return Object.entries(map)
    .filter(([, row]) => row?.enrolled === false && row.cleanupPending === true && !row.phase)
    .map(([origin]) => origin);
}

export async function retryAbandonedEnrollmentCleanup(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error("site_enrollment_promotion_invalid");
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const row = map[canonical];
    if (row?.enrolled !== false || row.cleanupPending !== true || row.phase === "promotion-pending") {
      return Object.freeze({ cleaned: false });
    }
    await siteMemory(canonical).delete(SITE_TOOL_CONSENT_KEY);
    delete row.cleanupPending;
    await kvSetDurable({ [ENROLL_KEY]: map });
    return Object.freeze({ cleaned: true });
  });
}

export async function reEnrollOrigin(origin, { commitGuard = null } = {}) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error(`invalid origin: ${origin}`);
  if (commitGuard !== null && typeof commitGuard !== "function") throw new Error("site_enrollment_guard_invalid");
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    const entry = map[canonical];
    if (!entry || entry.enrolled !== true || entry.phase || entry.promotionPending) {
      throw new Error(`origin ${canonical} is not enrolled`);
    }
    return withSiteToolConsentBarrier(async () => {
      if (commitGuard && commitGuard() !== true) throw new Error("site_enrollment_cancelled");
      const previous = await snapshotSiteToolConsentForPolicy(canonical, entry.gen);
      const revision = (previous?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("site_tool_consent_revision");
      // The generation bump revokes prior in-flight Allow (reverting to ASK),
      // but sticky Deny must be migrated forward so an owner's explicit refusal
      // is never silently erased by re-enrollment.
      const carriedDeny = (previous?.records || []).filter((record) => record.state === "denied");
      const gen = await nextGeneration();
      await writeAndVerifyPolicyConsent(canonical, gen, { revision, records: carriedDeny });
      if (commitGuard && commitGuard() !== true) throw new Error("site_enrollment_cancelled");
      map[canonical] = {
        ...entry,
        enrolled: true,
        gen,
        at: Date.now(),
      };
      await kvSet({ [ENROLL_KEY]: map });
      return Object.freeze({ origin: canonical, gen, enrolled: true });
    });
  });
}

export async function enrollOrigin(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) throw new Error(`invalid origin: ${origin}`);
  return withEnrollmentLock(async () => {
    const map = await enrolledMap();
    if (map[canonical]?.phase || map[canonical]?.promotionPending) throw new Error("site_enrollment_promotion_pending");
    if (map[canonical]?.enrolled === true) {
      // Repeating create/enroll must not bump the generation and silently
      // discard a previously sticky Deny in the generation-bound envelope.
      return listOrigins();
    }
    return withSiteToolConsentBarrier(async () => {
      // Legacy agent.create is NOT the owner's promotion gesture. It may
      // re-enroll after Disable if only old Allow remains (new gen re-asks),
      // but MUST refuse a surviving sticky Deny so it cannot silently erase
      // the owner's decision. The owner enrollment route migrates that Deny.
      if ((await storedSiteToolDenyProposals(canonical)).length) {
        throw new Error("site_enrollment_existing_consent_requires_review");
      }
      // No per-origin OPFS `enrolled` key is written on the pending path.
      await siteMemory(canonical).setTrusted("enrolled", { at: Date.now() });
      map[canonical] = {
        enrolled: true,
        at: Date.now(),
        gen: await nextGeneration(),
        // This is the coarse site switch only. Every exact tool still starts
        // at first-use consent; enrollment never creates an automatic grant.
        policy: DEFAULT_SITE_TOOL_POLICY,
      };
      await kvSet({ [ENROLL_KEY]: map });
      return listOrigins();
    });
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
  if (map[canonical]?.phase) throw new Error("site_enrollment_promotion_pending");
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
  return listOrigins();
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
  if (!enrollment || enrollment.enrolled !== true || enrollment.phase || enrollment.promotionPending) return [];
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

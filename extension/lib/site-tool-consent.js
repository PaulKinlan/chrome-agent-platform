// lib/site-tool-consent.js — durable first-use authority for exact WebMCP tools.
//
// Enrollment grants a site a worker and a discovery channel. It does NOT grant
// automatic model use. Each exact { canonical origin, verbatim name, source,
// execution-relevant descriptor } starts in "ask". A durable Allow is valid
// only for that identity; a Deny is sticky by origin/name so a page cannot evade
// it by changing its descriptor. Every mutation advances a persisted revision,
// which makes reset/disable an ABA-safe in-flight revocation token.

import { canonicalOrigin, siteMemory } from "./memory.js";
import { sha256Hex } from "./pure.js";

export const SITE_TOOL_CONSENT_KEY = "profile:webmcp-tool-consent-v1";
export const SITE_TOOL_CONSENT_VERSION = 1;
export const SITE_TOOL_CONSENT_STATES = Object.freeze(["ask", "allowed", "denied"]);
const MAX_TOOLS = 200;
const MAX_TOOL_NAME = 128;
const MAX_PAGE_FIELD = 4096;
const MAX_IDENTITY_NODES = 2048;
const MAX_IDENTITY_DEPTH = 32;
const MAX_IDENTITY_BYTES = 64 * 1024;
const identityEncoder = new TextEncoder();

let consentMutex = Promise.resolve();
let consentProfileEpoch = 0;
function withConsentLock(fn) {
  const run = consentMutex.then(fn, fn);
  consentMutex = run.then(() => {}, () => {});
  return run;
}

export function currentSiteToolConsentProfileEpoch() {
  return consentProfileEpoch;
}

export function invalidateSiteToolConsentWriters() {
  const next = consentProfileEpoch + 1;
  if (!Number.isSafeInteger(next)) fail("site_tool_consent_profile_epoch");
  consentProfileEpoch = next;
  return next;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function ownData(value, key) {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function strictDataObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
  }
  return descriptors;
}

function strictArrayValues(value, maxLength, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maxLength) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string") || ownKeys.length !== value.length + 1) fail(code);
  const out = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
    out.push(descriptor.value);
  }
  return out;
}

function canonicalJson(value, seen = new Set(), budget = { nodes: 0 }, depth = 0) {
  budget.nodes++;
  if (budget.nodes > MAX_IDENTITY_NODES || depth > MAX_IDENTITY_DEPTH) fail("site_tool_identity_invalid");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("site_tool_identity_invalid");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) fail("site_tool_identity_invalid");
  seen.add(value);
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) fail("site_tool_identity_invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail("site_tool_identity_invalid");
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || ownKeys.length !== length + 1) {
        fail("site_tool_identity_invalid");
      }
      const items = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("site_tool_identity_invalid");
        items.push(canonicalJson(descriptor.value, seen, budget, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("site_tool_identity_invalid");
    const keys = Object.keys(descriptors).sort();
    if (keys.length !== ownKeys.length) fail("site_tool_identity_invalid");
    const fields = [];
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value === "undefined") {
        fail("site_tool_identity_invalid");
      }
      fields.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, seen, budget, depth + 1)}`);
    }
    return `{${fields.join(",")}}`;
  } catch (error) {
    if (error?.code === "site_tool_identity_invalid") throw error;
    fail("site_tool_identity_invalid");
  } finally {
    seen.delete(value);
  }
}

function boundedOptional(value) {
  return typeof value === "string" && value.length <= MAX_PAGE_FIELD ? value : "";
}

/** Build the exact durable identity of one sanitized directory descriptor. */
export function siteToolIdentity(origin, tool) {
  const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) fail("site_tool_identity_invalid");
  const prototype = Object.getPrototypeOf(tool);
  if (prototype !== Object.prototype && prototype !== null) fail("site_tool_identity_invalid");
  const allowedKeys = new Set(["origin", "name", "description", "inputSchema", "source", "pageUrl", "path"]);
  const toolKeys = Reflect.ownKeys(tool);
  if (toolKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) fail("site_tool_identity_invalid");
  const toolDescriptors = Object.getOwnPropertyDescriptors(tool);
  for (const key of toolKeys) {
    const descriptor = toolDescriptors[key];
    if (!("value" in descriptor) || !descriptor.enumerable) fail("site_tool_identity_invalid");
  }
  const name = ownData(tool, "name");
  const source = ownData(tool, "source");
  if (
    !canonical || typeof name !== "string" || !name || name.length > MAX_TOOL_NAME ||
    (source !== "declared" && source !== "inferred")
  ) {
    fail("site_tool_identity_invalid");
  }
  const inputSchema = ownData(tool, "inputSchema");
  const pageUrl = ownData(tool, "pageUrl");
  const path = ownData(tool, "path");
  if (
    (inputSchema !== undefined && (!inputSchema || typeof inputSchema !== "object")) ||
    (pageUrl !== undefined && (typeof pageUrl !== "string" || pageUrl.length > MAX_PAGE_FIELD)) ||
    (path !== undefined && (typeof path !== "string" || path.length > MAX_PAGE_FIELD))
  ) fail("site_tool_identity_invalid");
  const identity = {
    origin: canonical,
    name,
    source,
    inputSchema: inputSchema ?? {},
    pageUrl: boundedOptional(pageUrl),
    path: boundedOptional(path),
  };
  const encoded = canonicalJson(identity);
  if (identityEncoder.encode(encoded).byteLength > MAX_IDENTITY_BYTES) fail("site_tool_identity_invalid");
  return Object.freeze({
    origin: canonical,
    name,
    source,
    identityDigest: sha256Hex(encoded),
  });
}

function blankEnvelope(enrollmentGen) {
  return { version: SITE_TOOL_CONSENT_VERSION, enrollmentGen, revision: 0, records: [] };
}

function validateEnvelope(raw, enrollmentGen) {
  if (raw == null) return blankEnvelope(enrollmentGen);
  const envelope = strictDataObject(
    raw,
    ["version", "enrollmentGen", "revision", "records"],
    "site_tool_consent_corrupt",
  );
  const version = envelope.version.value;
  const storedGen = envelope.enrollmentGen.value;
  const revision = envelope.revision.value;
  const records = strictArrayValues(envelope.records.value, MAX_TOOLS, "site_tool_consent_corrupt");
  if (
    version !== SITE_TOOL_CONSENT_VERSION || !Number.isSafeInteger(storedGen) || storedGen < 1 ||
    !Number.isSafeInteger(revision) || revision < 0
  ) fail("site_tool_consent_corrupt");
  // A stale post-delete writer may recreate the file, but its enrollment
  // generation can never authorize a later enrollment.
  if (storedGen !== enrollmentGen) return blankEnvelope(enrollmentGen);
  const out = [];
  const names = new Set();
  for (const record of records) {
    const fields = strictDataObject(
      record,
      ["name", "source", "identityDigest", "state", "revision", "decidedAt"],
      "site_tool_consent_corrupt",
    );
    const name = fields.name.value;
    const source = fields.source.value;
    const identityDigest = fields.identityDigest.value;
    const state = fields.state.value;
    const recordRevision = fields.revision.value;
    const decidedAt = fields.decidedAt.value;
    if (
      typeof name !== "string" || !name || name.length > MAX_TOOL_NAME || names.has(name) ||
      (source !== "declared" && source !== "inferred") ||
      typeof identityDigest !== "string" || !/^[0-9a-f]{64}$/.test(identityDigest) ||
      (state !== "allowed" && state !== "denied") ||
      !Number.isSafeInteger(recordRevision) || recordRevision < 1 || recordRevision > revision ||
      !Number.isSafeInteger(decidedAt) || decidedAt < 0
    ) fail("site_tool_consent_corrupt");
    names.add(name);
    out.push({ name, source, identityDigest, state, revision: recordRevision, decidedAt });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { version, enrollmentGen, revision, records: out };
}

async function readEnvelope(origin, enrollmentGen) {
  if (!Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1) fail("site_tool_consent_generation");
  const raw = await siteMemory(origin).getStrict(SITE_TOOL_CONSENT_KEY);
  return validateEnvelope(raw, enrollmentGen);
}

// Declared names are ASCII identifiers; case-only re-registration cannot
// re-ask around a sticky Deny (Q23 / n6c31). Dispatch still uses the EXACT live name.
export function nameKey(name) {
  return typeof name === "string" ? name.toLowerCase() : "";
}

function snapshotFrom(envelope, identity) {
  const exact = envelope.records.find((candidate) => candidate.name === identity.name) ?? null;
  // Deny is sticky across casing variants (Q23 / n6c31) so re-registering
  // 'Foo' as 'foo' cannot re-ask the owner.
  const denied = envelope.records.find(
    (candidate) => candidate.state === "denied" && nameKey(candidate.name) === nameKey(identity.name),
  ) ?? null;
  const record = denied ?? exact;
  const state = denied
    ? "denied"
    : record?.state === "allowed" && record.identityDigest === identity.identityDigest
      ? "allowed"
      : "ask";
  return Object.freeze({
    ...identity,
    state,
    enrollmentGen: envelope.enrollmentGen,
    revision: envelope.revision,
    recordRevision: record?.revision ?? 0,
  });
}

export async function siteToolConsentSnapshot(origin, tool, enrollmentGen) {
  const identity = siteToolIdentity(origin, tool);
  return snapshotFrom(await readEnvelope(identity.origin, enrollmentGen), identity);
}

function sameExpected(current, expected) {
  return expected &&
    current.origin === expected.origin && current.name === expected.name &&
    current.source === expected.source && current.identityDigest === expected.identityDigest &&
    current.enrollmentGen === expected.enrollmentGen && current.revision === expected.revision &&
    current.state === expected.state;
}

/**
 * Persist allowed/denied, or remove the record for ask. When `expected` is
 * supplied, a late owner decision may land only on the exact ASK revision that
 * produced its card. Concurrent first calls share one pending promise upstream;
 * stale cards never acquire an idempotent ABA shortcut.
 */
export async function setSiteToolConsent(origin, tool, enrollmentGen, state, {
  expected = null,
  expectedProfileEpoch = null,
  commitGuard = null,
  now = Date.now(),
} = {}) {
  if (!SITE_TOOL_CONSENT_STATES.includes(state)) fail("site_tool_consent_state");
  if (commitGuard != null && typeof commitGuard !== "function") fail("site_tool_consent_guard");
  const identity = siteToolIdentity(origin, tool);
  return await withConsentLock(async () => {
    if (expectedProfileEpoch != null && expectedProfileEpoch !== consentProfileEpoch) {
      fail("site_tool_consent_profile_changed");
    }
    if (commitGuard && commitGuard() !== true) fail("site_tool_consent_run_cancelled");
    const envelope = await readEnvelope(identity.origin, enrollmentGen);
    const current = snapshotFrom(envelope, identity);
    if (expected && !sameExpected(current, expected)) {
      fail("site_tool_consent_changed");
    }
    const revision = envelope.revision + 1;
    if (!Number.isSafeInteger(revision)) fail("site_tool_consent_revision");
    const records = envelope.records.filter((record) => nameKey(record.name) !== nameKey(identity.name));
    if (state !== "ask") {
      records.push({
        name: identity.name,
        source: identity.source,
        identityDigest: identity.identityDigest,
        state,
        revision,
        decidedAt: Number.isSafeInteger(now) && now >= 0 ? now : Date.now(),
      });
      records.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (records.length > MAX_TOOLS) fail("site_tool_consent_capacity");
    const next = {
      version: SITE_TOOL_CONSENT_VERSION,
      enrollmentGen,
      revision,
      records,
    };
    if (commitGuard && commitGuard() !== true) fail("site_tool_consent_run_cancelled");
    await siteMemory(identity.origin).setTrusted(SITE_TOOL_CONSENT_KEY, next);
    return snapshotFrom(next, identity);
  });
}

/** Reset allowed decisions only, or every decision, for one enrolled site. */
export async function resetSiteToolConsents(origin, enrollmentGen, mode = "all", {
  expectedProfileEpoch = null,
} = {}) {
  const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
  if (!canonical || !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1) {
    fail("site_tool_consent_generation");
  }
  if (mode !== "automatic" && mode !== "all") fail("site_tool_consent_reset_mode");
  return await withConsentLock(async () => {
    if (expectedProfileEpoch != null && expectedProfileEpoch !== consentProfileEpoch) {
      fail("site_tool_consent_profile_changed");
    }
    const envelope = await readEnvelope(canonical, enrollmentGen);
    const removed = envelope.records.filter((record) => mode === "all" || record.state === "allowed");
    // The owner action is an authority boundary even when every tool is ASK.
    // Persist a new revision so an outstanding card cannot save a late Allow.
    const revision = envelope.revision + 1;
    if (!Number.isSafeInteger(revision)) fail("site_tool_consent_revision");
    const kept = mode === "all"
      ? []
      : envelope.records.filter((record) => record.state !== "allowed");
    await siteMemory(canonical).setTrusted(SITE_TOOL_CONSENT_KEY, {
      version: SITE_TOOL_CONSENT_VERSION,
      enrollmentGen,
      revision,
      records: kept,
    });
    return Object.freeze({
      ok: true,
      origin: canonical,
      enrollmentGen,
      revision,
      removed: Object.freeze(removed.map((record) => Object.freeze({ ...record }))),
    });
  });
}

/** Serialize a profile-wide mutation after every queued consent read/write.
 * Factory reset uses this after taking the audit barrier (the same order as
 * normal audited consent mutations) so an old-generation write cannot
 * recreate authority after the profile has been wiped and re-enrolled. */
export async function withSiteToolConsentBarrier(operation) {
  if (typeof operation !== "function") fail("site_tool_consent_config");
  return await withConsentLock(operation);
}

/** Validate/copy the complete Allow+Deny proposal BEFORE it is placed in the
 * durable, non-authorizing enrollment-pending registry entry. On recovery this
 * same validator rejects tampered or partial pending state before any flip.
 */
export function validateSiteToolPromotionRecords(records) {
  const proposed = strictArrayValues(records, MAX_TOOLS, "site_tool_consent_promotion_invalid");
  const names = new Set();
  return proposed.map((record) => {
    const fields = strictDataObject(record,
      ["name", "source", "identityDigest", "state"], "site_tool_consent_promotion_invalid");
    const name = fields.name.value;
    const source = fields.source.value;
    const identityDigest = fields.identityDigest.value;
    const state = fields.state.value;
    if (typeof name !== "string" || !name || name.length > MAX_TOOL_NAME || names.has(name) ||
      source !== "declared" || typeof identityDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(identityDigest) || (state !== "allowed" && state !== "denied")) {
      fail("site_tool_consent_promotion_invalid");
    }
    names.add(name);
    return Object.freeze({ name, source, identityDigest, state });
  });
}

/** Copy all live run-scoped Allow AND Deny decisions into ONE enrolled envelope.
 * Call only from the owner's explicit enrollment route after enrollment; this
 * function intentionally does not create a per-origin store on its own for an
 * unenrolled page. The caller must hold the enrollment lock, validate the new
 * generation, and pass a synchronous guard for reset/run invalidation.
 */
export async function promoteEphemeralSiteToolConsents(origin, enrollmentGen, records, {
  expectedProfileEpoch = null,
  commitGuard = null,
  consentLockHeld = false,
  recoverPending = false,
  now = Date.now(),
} = {}) {
  const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
  if (!canonical || !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1 ||
    (commitGuard !== null && typeof commitGuard !== "function")) fail("site_tool_consent_promotion_invalid");
  const validated = validateSiteToolPromotionRecords(records);
  const write = async () => {
    if (expectedProfileEpoch !== null && expectedProfileEpoch !== consentProfileEpoch) {
      fail("site_tool_consent_profile_changed");
    }
    if (commitGuard && commitGuard() !== true) fail("site_tool_consent_run_cancelled");
    let envelope;
    try { envelope = await readEnvelope(canonical, enrollmentGen); }
    catch (error) {
      // ONLY the registry-backed owner promotion may recover a corrupt/empty
      // file created by its own failed first write. Its durable pending row
      // already contains every surviving old-generation Deny, folded while
      // enrollment→consent were held. A corrupt OLD file could not pass that
      // stage. Ordinary enrolled Q23 reads/writes remain strict.
      if (!recoverPending || !consentLockHeld) throw error;
      envelope = blankEnvelope(enrollmentGen);
    }
    if (!validated.length) {
      // A no-candidate owner enrollment uses the SAME write-before-flip gate:
      // durable read-back must see a real envelope, not the implicit ASK blank.
      if (expectedProfileEpoch !== null && expectedProfileEpoch !== consentProfileEpoch) fail("site_tool_consent_profile_changed");
      if (commitGuard && commitGuard() !== true) fail("site_tool_consent_run_cancelled");
      await siteMemory(canonical).setTrusted(SITE_TOOL_CONSENT_KEY, envelope);
      return Object.freeze({ origin: canonical, enrollmentGen, revision: envelope.revision, migrated: 0 });
    }
    const revision = envelope.revision + 1;
    if (!Number.isSafeInteger(revision)) fail("site_tool_consent_revision");
    const merged = new Map(envelope.records.map((record) => [record.name, record]));
    let migrated = 0;
    for (const proposal of validated) {
      const prior = merged.get(proposal.name);
      const priorDenied = [...merged.values()].find(
        (r) => r.state === "denied" && nameKey(r.name) === nameKey(proposal.name),
      );
      // A persisted Deny always wins across casing variants (Q23 / n6c31).
      // A run-local Deny may revoke a persisted Allow, but a run-local Allow
      // cannot displace an already durable Deny.
      if (priorDenied || prior?.state === "denied" || (prior && proposal.state === "allowed")) continue;
      if (proposal.state === "denied") {
        for (const [k, r] of merged.entries()) {
          if (nameKey(r.name) === nameKey(proposal.name)) {
            merged.delete(k);
          }
        }
      }
      merged.set(proposal.name, {
        ...proposal,
        revision,
        decidedAt: Number.isSafeInteger(now) && now >= 0 ? now : Date.now(),
      });
      migrated++;
    }
    if (merged.size > MAX_TOOLS) fail("site_tool_consent_capacity");
    if (expectedProfileEpoch !== null && expectedProfileEpoch !== consentProfileEpoch) {
      fail("site_tool_consent_profile_changed");
    }
    if (commitGuard && commitGuard() !== true) fail("site_tool_consent_run_cancelled");
    // One trusted OPFS write, never a per-tool loop: failure cannot persist
    // Allow while silently dropping a Deny (or vice versa).
    await siteMemory(canonical).setTrusted(SITE_TOOL_CONSENT_KEY, {
      version: SITE_TOOL_CONSENT_VERSION,
      enrollmentGen,
      revision,
      records: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    });
    return Object.freeze({ origin: canonical, enrollmentGen, revision, migrated });
  };
  // A trusted enrollment transaction holds enrollment→consent across the
  // verification AND authority flip. Standalone callers still acquire it here.
  return consentLockHeld ? await write() : await withConsentLock(write);
}

/** Read a surviving old-generation envelope while enrollment→consent are
 * held. A scripting Disable tombstones the registry but deliberately leaves
 * site memory, including sticky Deny, behind. Deny is name-bound irrespective
 * of descriptor source/digest; normalize its source to `declared` ONLY as an
 * inert denial proposal for the owner promotion. It cannot create a tool or
 * grant Allow. Old Allow is intentionally re-asked after Disable/re-enroll.
 */
export async function storedSiteToolDenyProposals(origin) {
  const canonical = canonicalOrigin(origin);
  if (!canonical) fail("site_tool_consent_origin");
  const raw = await siteMemory(canonical).getStrict(SITE_TOOL_CONSENT_KEY);
  if (raw === null) return Object.freeze([]);
  if (!Number.isSafeInteger(raw.enrollmentGen) || raw.enrollmentGen < 1) fail("site_tool_consent_corrupt");
  const envelope = validateEnvelope(raw, raw.enrollmentGen);
  return Object.freeze(envelope.records.filter((r) => r.state === "denied").map((r) =>
    Object.freeze({ name: r.name, source: "declared", identityDigest: r.identityDigest, state: "denied" })));
}

/** Snapshot the WHOLE current envelope while enrollment→consent are held.
 * Policy flips carry sticky Deny only; old Allow is re-asked under the new
 * generation, not interpreted as an automatic grant after a policy change.
 */
export async function snapshotSiteToolConsentForPolicy(origin, enrollmentGen) {
  const canonical = canonicalOrigin(origin);
  if (!canonical || !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1) fail("site_tool_consent_generation");
  const raw = await siteMemory(canonical).getStrict(SITE_TOOL_CONSENT_KEY);
  if (raw !== null && raw.enrollmentGen !== enrollmentGen) fail("site_tool_consent_generation_mismatch");
  return validateEnvelope(raw, enrollmentGen);
}

/** Called ONLY while the durable policy-pending registry entry is inert and
 * enrollment→consent are held. Rebuild the one generation-bound file entirely
 * from the registry's captured copy; a partial prior write is never authority.
 */
export async function writeAndVerifyPolicyConsent(origin, enrollmentGen, captured) {
  const canonical = canonicalOrigin(origin);
  if (!canonical || !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1) fail("site_tool_consent_generation");
  const raw = { version: SITE_TOOL_CONSENT_VERSION, enrollmentGen,
    revision: captured?.revision, records: captured?.records };
  const envelope = validateEnvelope(raw, enrollmentGen);
  await siteMemory(canonical).setTrusted(SITE_TOOL_CONSENT_KEY, envelope);
  const persisted = await siteMemory(canonical).getStrict(SITE_TOOL_CONSENT_KEY);
  if (!persisted || persisted.enrollmentGen !== enrollmentGen) fail("site_tool_consent_policy_unverified");
  const verified = validateEnvelope(persisted, enrollmentGen);
  if (verified.revision !== envelope.revision ||
    JSON.stringify(verified.records) !== JSON.stringify(envelope.records)) fail("site_tool_consent_policy_unverified");
  return Object.freeze({ origin: canonical, enrollmentGen, revision: verified.revision });
}

/** Strict durable read-back before the registry's SOLE enrolled:true flip.
 * Even an empty proposal requires a real same-generation envelope; the normal
 * readEnvelope helper intentionally treats missing/old generations as blank
 * for first-use ASK, which would be unsafe as proof of a promotion commit.
 */
export async function verifyPromotedSiteToolConsents(origin, enrollmentGen, records) {
  const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
  const proposed = validateSiteToolPromotionRecords(records);
  if (!canonical || !Number.isSafeInteger(enrollmentGen) || enrollmentGen < 1) fail("site_tool_consent_promotion_invalid");
  const raw = await siteMemory(canonical).getStrict(SITE_TOOL_CONSENT_KEY);
  if (!raw || raw.enrollmentGen !== enrollmentGen) fail("site_tool_consent_promotion_unverified");
  const envelope = validateEnvelope(raw, enrollmentGen);
  const stored = new Map(envelope.records.map((record) => [record.name, record]));
  for (const proposal of proposed) {
    const current = stored.get(proposal.name);
    if (!current || (proposal.state === "denied" && current.state !== "denied") ||
      (proposal.state === "allowed" && current.state !== "denied" &&
        (current.state !== "allowed" || current.identityDigest !== proposal.identityDigest))) {
      fail("site_tool_consent_promotion_unverified");
    }
  }
  return Object.freeze({ origin: canonical, enrollmentGen, revision: envelope.revision, verified: proposed.length });
}

export async function listSiteToolConsentStates(origin, tools, enrollmentGen) {
  const canonical = typeof origin === "string" ? canonicalOrigin(origin) : null;
  if (!canonical || !Array.isArray(tools)) return [];
  const envelope = await readEnvelope(canonical, enrollmentGen);
  return tools.map((tool) => snapshotFrom(envelope, siteToolIdentity(canonical, tool)));
}

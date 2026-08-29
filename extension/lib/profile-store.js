// lib/profile-store.js — structured OPFS user profile store (AGENT-PRODUCT-GAPS, form-filler layer 1).
//
// A structured, namespaced profile store on the OPFS/memory substrate:
//   - profile:basic        (contact, identity, social/portfolio links)
//   - profile:work_history (career timeline, company, title, achievements)
//   - profile:education    (degrees, institutions, dates, GPA)
//   - profile:disclosures  (work auth, sponsorship, demographics, custom Q&A)
//
// Security & access control principles (Constitution §2 + §4):
//   - Schema-validated and bounded (exact UTF-8 byte bounds and array lengths).
//   - Per-agent readable with explicit grants from the authoritative agent registry (getNamedAgent).
//   - Reserved namespace: profile:* keys are reserved and protected from raw model memory tools.
//   - Write-audited with actual change diffs (mutations fail closed and roll back if auditing fails).
//   - Atomic bulk updates: pre-validated before mutation with rollback compensation under a single transaction lock.

import { masterMemory } from "./memory.js";
import { getNamedAgent, slugifyAgentId } from "./named-agents.js";

export const PROFILE_SECTIONS = [
  "profile:basic",
  "profile:work_history",
  "profile:education",
  "profile:disclosures",
];

export const MAX_PROFILE_SECTION_BYTES = 131072; // 128 KiB UTF-8 bytes per section
export const MAX_WORK_ENTRIES = 32;
export const MAX_EDUCATION_ENTRIES = 16;
export const MAX_LINKS_COUNT = 16;
export const MAX_CUSTOM_ANSWERS = 32;
export const MAX_AUDIT_LOG_ENTRIES = 100;
export const PROFILE_AUDIT_KEY = "profile:audit_log";

const RESERVED_AGENT_SLUGS = new Set([
  "owner",
  "master",
  "unnamed",
  "admin",
  "system",
  "hub",
  "root",
]);

let auditMutex = Promise.resolve();
function withAuditLock(fn) {
  const run = auditMutex.then(fn, fn);
  auditMutex = run.then(() => {}, () => {});
  return run;
}

/** Normalize a section key to its canonical "profile:<name>" form. */
export function normalizeSectionKey(key) {
  if (typeof key !== "string") return null;
  const clean = key.trim().toLowerCase();
  if (clean.startsWith("profile:")) {
    const name = clean.slice(8);
    if (["basic", "work_history", "education", "disclosures"].includes(name)) {
      return `profile:${name}`;
    }
  } else if (["basic", "work_history", "education", "disclosures"].includes(clean)) {
    return `profile:${clean}`;
  }
  return null;
}

function isPlainObject(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

/** Validate and normalize profile:basic document. */
export function validateBasicProfile(data) {
  if (!isPlainObject(data)) {
    return { ok: false, error: "basic profile must be a plain JSON object" };
  }

  // Strict type checks before normalization
  if (data.firstName !== undefined && data.firstName !== null && typeof data.firstName !== "string") {
    return { ok: false, error: "firstName must be a string" };
  }
  if (data.lastName !== undefined && data.lastName !== null && typeof data.lastName !== "string") {
    return { ok: false, error: "lastName must be a string" };
  }
  if (data.fullName !== undefined && data.fullName !== null && typeof data.fullName !== "string") {
    return { ok: false, error: "fullName must be a string" };
  }
  if (data.email !== undefined && data.email !== null && typeof data.email !== "string") {
    return { ok: false, error: "email must be a string" };
  }
  if (data.phone !== undefined && data.phone !== null && typeof data.phone !== "string") {
    return { ok: false, error: "phone must be a string" };
  }
  if (data.headline !== undefined && data.headline !== null && typeof data.headline !== "string") {
    return { ok: false, error: "headline must be a string" };
  }
  if (data.title !== undefined && data.title !== null && typeof data.title !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  if (data.summary !== undefined && data.summary !== null && typeof data.summary !== "string") {
    return { ok: false, error: "summary must be a string" };
  }

  const firstName = String(data.firstName ?? "").trim().slice(0, 64);
  const lastName = String(data.lastName ?? "").trim().slice(0, 64);
  let fullName = String(data.fullName ?? "").trim().slice(0, 128);
  if (!fullName && (firstName || lastName)) {
    fullName = [firstName, lastName].filter(Boolean).join(" ");
  }

  const email = String(data.email ?? "").trim().slice(0, 128);
  const phone = String(data.phone ?? "").trim().slice(0, 32);
  const headline = String(data.headline ?? data.title ?? "").trim().slice(0, 120);
  const summary = String(data.summary ?? "").trim().slice(0, 4000);

  let location = "";
  if (data.location !== undefined && data.location !== null) {
    if (typeof data.location === "string") {
      location = data.location.trim().slice(0, 120);
    } else if (isPlainObject(data.location)) {
      for (const [k, v] of Object.entries(data.location)) {
        if (v !== undefined && v !== null && typeof v !== "string") {
          return { ok: false, error: `location.${k} must be a string` };
        }
      }
      const parts = [
        data.location.city,
        data.location.state,
        data.location.country,
        data.location.postalCode,
      ].filter((x) => typeof x === "string" && x.trim());
      location = parts.join(", ").slice(0, 120);
    } else {
      return { ok: false, error: "location must be a string or object" };
    }
  }

  // Normalize links
  const links = {};
  if (data.links !== undefined && data.links !== null) {
    if (Array.isArray(data.links)) {
      for (let i = 0; i < data.links.length; i++) {
        const item = data.links[i];
        if (!isPlainObject(item)) {
          return { ok: false, error: `links at index ${i} must be a plain object` };
        }
        if (item.label !== undefined && item.label !== null && typeof item.label !== "string") {
          return { ok: false, error: `link label at index ${i} must be a string` };
        }
        if (item.name !== undefined && item.name !== null && typeof item.name !== "string") {
          return { ok: false, error: `link name at index ${i} must be a string` };
        }
        if (item.url === undefined || item.url === null || typeof item.url !== "string") {
          return { ok: false, error: `link at index ${i} requires a url string` };
        }
        const label = String(item.label ?? item.name ?? `link_${i}`).trim().slice(0, 64);
        const url = item.url.trim().slice(0, 512);
        if (label && url) {
          links[label] = url;
          if (Object.keys(links).length >= MAX_LINKS_COUNT) break;
        }
      }
    } else if (isPlainObject(data.links)) {
      for (const [key, val] of Object.entries(data.links)) {
        if (val !== undefined && val !== null) {
          if (typeof val !== "string") {
            return { ok: false, error: `link URL for "${key}" must be a string` };
          }
          const label = key.trim().slice(0, 64);
          links[label] = val.trim().slice(0, 512);
          if (Object.keys(links).length >= MAX_LINKS_COUNT) break;
        }
      }
    } else {
      return { ok: false, error: "links must be an object or array" };
    }
  }

  const normalized = {
    firstName,
    lastName,
    fullName,
    email,
    phone,
    headline,
    summary,
    location,
    links,
  };

  return { ok: true, data: normalized };
}

/** Validate and normalize profile:work_history document. */
export function validateWorkHistory(data) {
  const list = Array.isArray(data) ? data : (data?.entries && Array.isArray(data.entries) ? data.entries : null);
  if (!list) {
    return { ok: false, error: "work history must be an array of experience entries" };
  }

  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isPlainObject(item)) {
      return { ok: false, error: `work history entry at index ${i} must be a plain object` };
    }

    if (item.company === undefined || item.company === null || typeof item.company !== "string") {
      return { ok: false, error: `work history entry at index ${i} requires a company string` };
    }
    const company = item.company.trim().slice(0, 120);
    if (!company) {
      return { ok: false, error: `work history entry at index ${i} requires a company name` };
    }

    if (item.title === undefined || item.title === null || typeof item.title !== "string") {
      return { ok: false, error: `work history entry at index ${i} requires a job title string` };
    }
    const title = item.title.trim().slice(0, 120);
    if (!title) {
      return { ok: false, error: `work history entry at index ${i} requires a job title` };
    }

    if (item.location !== undefined && item.location !== null && typeof item.location !== "string") {
      return { ok: false, error: `work history entry at index ${i} location must be a string` };
    }
    if (item.startDate !== undefined && item.startDate !== null && typeof item.startDate !== "string") {
      return { ok: false, error: `work history entry at index ${i} startDate must be a string` };
    }
    if (item.endDate !== undefined && item.endDate !== null && typeof item.endDate !== "string") {
      return { ok: false, error: `work history entry at index ${i} endDate must be a string` };
    }
    if (item.current !== undefined && item.current !== null && typeof item.current !== "boolean") {
      return { ok: false, error: `work history entry at index ${i} current must be a boolean` };
    }
    if (item.description !== undefined && item.description !== null && typeof item.description !== "string") {
      return { ok: false, error: `work history entry at index ${i} description must be a string` };
    }

    const location = String(item.location ?? "").trim().slice(0, 120);
    const startDate = String(item.startDate ?? "").trim().slice(0, 32);
    const endDate = item.endDate == null ? null : String(item.endDate).trim().slice(0, 32);
    const current = typeof item.current === "boolean" ? item.current : Boolean(!endDate && startDate);
    const description = String(item.description ?? "").trim().slice(0, 4000);

    const highlights = [];
    if (item.highlights !== undefined && item.highlights !== null) {
      if (!Array.isArray(item.highlights)) {
        return { ok: false, error: `work history entry at index ${i} highlights must be an array` };
      }
      for (let hIdx = 0; hIdx < item.highlights.length; hIdx++) {
        const h = item.highlights[hIdx];
        if (typeof h !== "string") {
          return { ok: false, error: `work history entry at index ${i} highlight at ${hIdx} must be a string` };
        }
        if (h.trim()) {
          highlights.push(h.trim().slice(0, 500));
          if (highlights.length >= 16) break;
        }
      }
    }

    entries.push({
      company,
      title,
      location,
      startDate,
      endDate,
      current,
      description,
      highlights,
    });

    if (entries.length >= MAX_WORK_ENTRIES) break;
  }

  return { ok: true, data: entries };
}

/** Validate and normalize profile:education document. */
export function validateEducation(data) {
  const list = Array.isArray(data) ? data : (data?.entries && Array.isArray(data.entries) ? data.entries : null);
  if (!list) {
    return { ok: false, error: "education must be an array of education entries" };
  }

  const entries = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isPlainObject(item)) {
      return { ok: false, error: `education entry at index ${i} must be a plain object` };
    }

    const rawInst = item.institution ?? item.school;
    if (rawInst === undefined || rawInst === null || typeof rawInst !== "string") {
      return { ok: false, error: `education entry at index ${i} requires an institution name string` };
    }
    const institution = rawInst.trim().slice(0, 120);
    if (!institution) {
      return { ok: false, error: `education entry at index ${i} requires an institution name` };
    }

    if (item.degree !== undefined && item.degree !== null && typeof item.degree !== "string") {
      return { ok: false, error: `education entry at index ${i} degree must be a string` };
    }
    const rawMajor = item.fieldOfStudy ?? item.major;
    if (rawMajor !== undefined && rawMajor !== null && typeof rawMajor !== "string") {
      return { ok: false, error: `education entry at index ${i} fieldOfStudy must be a string` };
    }
    if (item.startDate !== undefined && item.startDate !== null && typeof item.startDate !== "string") {
      return { ok: false, error: `education entry at index ${i} startDate must be a string` };
    }
    const rawEnd = item.endDate ?? item.graduationYear;
    if (rawEnd !== undefined && rawEnd !== null && typeof rawEnd !== "string" && typeof rawEnd !== "number") {
      return { ok: false, error: `education entry at index ${i} endDate must be a string or number` };
    }
    if (item.gpa !== undefined && item.gpa !== null && typeof item.gpa !== "string" && typeof item.gpa !== "number") {
      return { ok: false, error: `education entry at index ${i} gpa must be a string or number` };
    }
    if (item.activities !== undefined && item.activities !== null && typeof item.activities !== "string") {
      return { ok: false, error: `education entry at index ${i} activities must be a string` };
    }

    const degree = String(item.degree ?? "").trim().slice(0, 120);
    const fieldOfStudy = String(rawMajor ?? "").trim().slice(0, 120);
    const startDate = String(item.startDate ?? "").trim().slice(0, 32);
    const endDate = rawEnd == null ? null : String(rawEnd).trim().slice(0, 32);
    const gpa = item.gpa == null ? null : String(item.gpa).trim().slice(0, 16);
    const activities = String(item.activities ?? "").trim().slice(0, 2000);

    entries.push({
      institution,
      degree,
      fieldOfStudy,
      startDate,
      endDate,
      gpa,
      activities,
    });

    if (entries.length >= MAX_EDUCATION_ENTRIES) break;
  }

  return { ok: true, data: entries };
}

/** Validate and normalize profile:disclosures document. */
export function validateDisclosures(data) {
  if (!isPlainObject(data)) {
    return { ok: false, error: "disclosures must be a plain JSON object" };
  }

  if (data.workAuthorization !== undefined && data.workAuthorization !== null && typeof data.workAuthorization !== "string") {
    return { ok: false, error: "workAuthorization must be a string" };
  }
  if (data.requiresSponsorship !== undefined && data.requiresSponsorship !== null) {
    if (typeof data.requiresSponsorship !== "boolean") {
      const s = String(data.requiresSponsorship).trim().toLowerCase();
      if (s !== "yes" && s !== "no") {
        return { ok: false, error: "requiresSponsorship must be a boolean or 'yes'/'no'" };
      }
    }
  }
  if (data.gender !== undefined && data.gender !== null && typeof data.gender !== "string") {
    return { ok: false, error: "gender must be a string" };
  }
  if (data.veteranStatus !== undefined && data.veteranStatus !== null && typeof data.veteranStatus !== "string") {
    return { ok: false, error: "veteranStatus must be a string" };
  }
  if (data.disabilityStatus !== undefined && data.disabilityStatus !== null && typeof data.disabilityStatus !== "string") {
    return { ok: false, error: "disabilityStatus must be a string" };
  }
  if (data.raceEthnicity !== undefined && data.raceEthnicity !== null && typeof data.raceEthnicity !== "string") {
    return { ok: false, error: "raceEthnicity must be a string" };
  }

  const workAuthorization = String(data.workAuthorization ?? "").trim().slice(0, 64);
  const requiresSponsorship = typeof data.requiresSponsorship === "boolean"
    ? data.requiresSponsorship
    : (data.requiresSponsorship != null ? (String(data.requiresSponsorship).trim().toLowerCase() === "yes") : null);
  const gender = String(data.gender ?? "").trim().slice(0, 64);
  const veteranStatus = String(data.veteranStatus ?? "").trim().slice(0, 64);
  const disabilityStatus = String(data.disabilityStatus ?? "").trim().slice(0, 64);
  const raceEthnicity = String(data.raceEthnicity ?? "").trim().slice(0, 64);

  const customAnswers = {};
  if (data.customAnswers !== undefined && data.customAnswers !== null) {
    if (!isPlainObject(data.customAnswers)) {
      return { ok: false, error: "customAnswers must be a plain object" };
    }
    for (const [k, v] of Object.entries(data.customAnswers)) {
      if (typeof k !== "string") continue;
      if (v !== undefined && v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        return { ok: false, error: `customAnswer for "${k}" must be a string or primitive` };
      }
      const qKey = k.trim().slice(0, 64);
      const ansVal = v == null ? "" : String(v).trim().slice(0, 1000);
      if (qKey) {
        customAnswers[qKey] = ansVal;
        if (Object.keys(customAnswers).length >= MAX_CUSTOM_ANSWERS) break;
      }
    }
  }

  const normalized = {
    workAuthorization,
    requiresSponsorship,
    gender,
    veteranStatus,
    disabilityStatus,
    raceEthnicity,
    customAnswers,
  };

  return { ok: true, data: normalized };
}

/** Validate a profile document for a given section key. */
export function validateProfileSection(sectionKey, data) {
  const normKey = normalizeSectionKey(sectionKey);
  if (!normKey) {
    return { ok: false, error: `unknown profile section: ${sectionKey}` };
  }

  switch (normKey) {
    case "profile:basic":
      return validateBasicProfile(data);
    case "profile:work_history":
      return validateWorkHistory(data);
    case "profile:education":
      return validateEducation(data);
    case "profile:disclosures":
      return validateDisclosures(data);
    default:
      return { ok: false, error: `unsupported profile section: ${normKey}` };
  }
}

/** Compute actual changed field names between old and new states. */
function computeDiff(previous, current) {
  if (!previous) {
    return Array.isArray(current) ? [`entries:${current.length}`] : Object.keys(current ?? {});
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    if (JSON.stringify(previous) === JSON.stringify(current)) return [];
    return [`entries:${previous.length}->${current.length}`];
  }
  if (isPlainObject(previous) && isPlainObject(current)) {
    const changes = [];
    const allKeys = new Set([...Object.keys(previous), ...Object.keys(current)]);
    for (const k of allKeys) {
      if (JSON.stringify(previous[k]) !== JSON.stringify(current[k])) {
        changes.push(k);
      }
    }
    return changes;
  }
  return ["modified"];
}

/** Read a key from memory through the trusted internal subsystem path. */
async function readTrustedMemory(mem, key) {
  if (typeof mem.getStrict === "function") {
    return await mem.getStrict(key);
  }
  return await mem.get(key);
}

/** Internal helper to record an audit log entry. Fails closed if audit write fails. */
async function recordAudit(mem, { action, section, actor = "owner", fields = [] }) {
  const existing = await readTrustedMemory(mem, PROFILE_AUDIT_KEY);
  const log = Array.isArray(existing) ? [...existing] : [];
  const entry = {
    id: crypto.randomUUID(),
    at: Date.now(),
    action, // "create" | "update" | "delete" | "clear"
    section: section ?? null,
    actor: String(actor || "owner").slice(0, 64),
    fields: Array.isArray(fields) ? fields.slice(0, 32) : [],
  };
  log.unshift(entry);
  const boundedLog = log.slice(0, MAX_AUDIT_LOG_ENTRIES);
  await mem.setTrusted(PROFILE_AUDIT_KEY, boundedLog);
  return entry;
}

/** Read the profile mutation audit log. */
export async function getProfileAuditLog(options = {}) {
  const mem = options.memory ?? masterMemory();
  const log = await readTrustedMemory(mem, PROFILE_AUDIT_KEY);
  return Array.isArray(log) ? log : [];
}

/**
 * Check if a grant list contains explicit permission for a section.
 */
export function hasProfileGrant(grants, sectionKey) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection || !Array.isArray(grants)) return false;

  for (const g of grants) {
    if (typeof g !== "string") continue;
    const clean = g.trim().toLowerCase();
    if (clean === "*" || clean === "profile:*") return true;
    if (normalizeSectionKey(clean) === normSection) return true;
  }

  return false;
}

/** Read a profile section directly (unrestricted / owner access). */
export async function getProfileSection(sectionKey, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  const mem = options.memory ?? masterMemory();
  const data = await readTrustedMemory(mem, normSection);
  return { ok: true, section: normSection, data: data ?? null };
}

/** Internal unlocked single-section write + audit. Used by setProfileSection and setWholeProfile. */
async function setProfileSectionInner(mem, normSection, validatedData, options = {}) {
  const previous = await readTrustedMemory(mem, normSection);
  const action = previous ? "update" : "create";
  const diffFields = computeDiff(previous, validatedData);

  // Commit section write
  await mem.setTrusted(normSection, validatedData);

  // Audit logging: fail the mutation closed if audit log cannot be committed
  try {
    await recordAudit(mem, {
      action,
      section: normSection,
      actor: options.actor ?? "owner",
      fields: diffFields,
    });
  } catch (auditErr) {
    // Revert write on audit failure
    try {
      if (previous !== null && previous !== undefined) {
        await mem.setTrusted(normSection, previous);
      } else {
        await mem.delete(normSection);
      }
    } catch (rollbackErr) {
      return {
        ok: false,
        error: `audit write failed: ${auditErr?.message ?? String(auditErr)}; rollback failed: ${rollbackErr?.message ?? String(rollbackErr)}`,
      };
    }
    return { ok: false, error: `audit write failed: ${auditErr?.message ?? String(auditErr)}` };
  }

  return { ok: true, section: normSection, data: validatedData };
}

/** Write and audit a profile section. Serialized under audit lock with rollback on audit failure. */
export async function setProfileSection(sectionKey, data, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  const validation = validateProfileSection(normSection, data);
  if (!validation.ok) return validation;

  const serialized = JSON.stringify(validation.data);
  const utf8Bytes = new TextEncoder().encode(serialized).byteLength;
  if (utf8Bytes > MAX_PROFILE_SECTION_BYTES) {
    return {
      ok: false,
      error: `section payload exceeds maximum size (${utf8Bytes} bytes > ${MAX_PROFILE_SECTION_BYTES} bytes)`,
    };
  }

  const mem = options.memory ?? masterMemory();

  return await withAuditLock(async () => {
    return await setProfileSectionInner(mem, normSection, validation.data, options);
  });
}

/** Delete and audit a profile section. Serialized under audit lock with rollback on delete/audit failure. */
export async function deleteProfileSection(sectionKey, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  const mem = options.memory ?? masterMemory();

  return await withAuditLock(async () => {
    const existing = await readTrustedMemory(mem, normSection);
    if (existing !== null && existing !== undefined) {
      try {
        await mem.delete(normSection);
        await recordAudit(mem, {
          action: "delete",
          section: normSection,
          actor: options.actor ?? "owner",
          fields: ["deleted"],
        });
      } catch (err) {
        // Restore snapshot on ANY deletion or audit failure
        try {
          await mem.setTrusted(normSection, existing);
        } catch (restoreErr) {
          return {
            ok: false,
            error: `delete/audit failed: ${err?.message ?? String(err)}; restoration failed: ${restoreErr?.message ?? String(restoreErr)}`,
          };
        }
        return { ok: false, error: `delete/audit failed: ${err?.message ?? String(err)}` };
      }
    }

    return { ok: true, section: normSection };
  });
}

/**
 * Read a profile section scoped to an agent's explicit grants.
 * Identity is authenticated against the authoritative agent registry (getNamedAgent).
 * Fails closed if the agent slug is missing, unknown, reserved sentinel, or lacks explicit grants.
 */
export async function readAgentProfileSection(agentSlug, sectionKey, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  if (typeof agentSlug !== "string" || !agentSlug.trim()) {
    return { ok: false, error: "readAgentProfileSection requires an agent slug string" };
  }

  const slug = slugifyAgentId(agentSlug);
  if (!slug || RESERVED_AGENT_SLUGS.has(slug)) {
    return {
      ok: false,
      error: `unauthorized: reserved sentinel slug "${slug || agentSlug}" cannot be used as an agent grant subject`,
    };
  }

  const agent = await getNamedAgent(slug);
  if (!agent) {
    return {
      ok: false,
      error: `unauthorized: agent "${slug}" not found in trusted registry`,
    };
  }

  if (!hasProfileGrant(agent.profileGrants, normSection)) {
    return {
      ok: false,
      error: `unauthorized: agent "${agent.name || slug}" lacks explicit grant for ${normSection}`,
    };
  }

  const mem = options.memory ?? masterMemory();
  const data = await readTrustedMemory(mem, normSection);
  return { ok: true, section: normSection, data: data ?? null };
}

/** Read all profile sections granted to an agent in a single call. */
export async function readAgentProfile(agentSlug, options = {}) {
  if (typeof agentSlug !== "string" || !agentSlug.trim()) {
    return { ok: false, error: "readAgentProfile requires an agent slug string" };
  }

  const slug = slugifyAgentId(agentSlug);
  if (!slug || RESERVED_AGENT_SLUGS.has(slug)) {
    return {
      ok: false,
      error: `unauthorized: reserved sentinel slug "${slug || agentSlug}" cannot be used as an agent grant subject`,
    };
  }

  const agent = await getNamedAgent(slug);
  if (!agent) {
    return {
      ok: false,
      error: `unauthorized: agent "${slug}" not found in trusted registry`,
    };
  }

  const readableSections = PROFILE_SECTIONS.filter((sec) => hasProfileGrant(agent.profileGrants, sec));
  if (readableSections.length === 0) {
    return {
      ok: false,
      error: `unauthorized: agent "${agent.name || slug}" has no profile grants`,
    };
  }

  const mem = options.memory ?? masterMemory();
  const profile = {};
  for (const sec of readableSections) {
    const data = await readTrustedMemory(mem, sec);
    if (data !== null && data !== undefined) {
      profile[sec] = data;
    }
  }

  return {
    ok: true,
    grantedSections: readableSections,
    profile,
  };
}

/** Read the entire profile across all 4 sections (owner / unrestricted). */
export async function getWholeProfile(options = {}) {
  const mem = options.memory ?? masterMemory();
  const profile = {};
  for (const sec of PROFILE_SECTIONS) {
    const data = await readTrustedMemory(mem, sec);
    if (data !== null && data !== undefined) {
      profile[sec] = data;
    }
  }
  return { ok: true, profile };
}

/**
 * Set multiple profile sections in bulk.
 * Pre-validates ALL sections upfront. Operates inside a single transaction lock
 * around snapshot + writes + audits with full rollback compensation on any failure.
 */
export async function setWholeProfile(profileObject, options = {}) {
  if (!isPlainObject(profileObject)) {
    return { ok: false, error: "profile must be a plain object with section keys" };
  }

  const entries = Object.entries(profileObject);
  if (entries.length === 0) {
    return { ok: false, error: "bulk profile update cannot be empty" };
  }

  // Pre-validate ALL sections upfront
  const validatedSections = [];
  for (const [k, val] of entries) {
    const norm = normalizeSectionKey(k);
    if (!norm) {
      return { ok: false, error: `unknown profile section key in bulk payload: "${k}"` };
    }
    const valRes = validateProfileSection(norm, val);
    if (!valRes.ok) {
      return { ok: false, error: `validation failed for section ${norm}: ${valRes.error}` };
    }
    const serialized = JSON.stringify(valRes.data);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_PROFILE_SECTION_BYTES) {
      return { ok: false, error: `section ${norm} exceeds maximum size (${bytes} > ${MAX_PROFILE_SECTION_BYTES})` };
    }
    validatedSections.push({ section: norm, data: valRes.data });
  }

  const mem = options.memory ?? masterMemory();

  return await withAuditLock(async () => {
    const snapshots = new Map();
    const committed = [];

    // Capture snapshots of sections AND audit log inside the single transaction lock
    for (const { section } of validatedSections) {
      const prev = await readTrustedMemory(mem, section);
      snapshots.set(section, prev != null ? structuredClone(prev) : prev);
    }
    const rawAudit = await readTrustedMemory(mem, PROFILE_AUDIT_KEY);
    const auditSnapshot = rawAudit != null ? structuredClone(rawAudit) : rawAudit;

    // Commit writes sequentially inside the transaction lock
    try {
      for (const { section, data } of validatedSections) {
        const writeRes = await setProfileSectionInner(mem, section, data, options);
        if (!writeRes?.ok) {
          throw new Error(writeRes?.error ?? `write failed at ${section}`);
        }
        committed.push(section);
      }
    } catch (err) {
      // Rollback committed sections AND restore the audit log
      const rollbackErrors = [];
      for (const rolled of committed) {
        const prev = snapshots.get(rolled);
        try {
          if (prev !== null && prev !== undefined) {
            await mem.setTrusted(rolled, prev);
          } else {
            await mem.delete(rolled);
          }
        } catch (rbErr) {
          rollbackErrors.push(`rollback ${rolled}: ${rbErr?.message ?? String(rbErr)}`);
        }
      }

      // Restore audit log snapshot
      try {
        if (auditSnapshot !== null && auditSnapshot !== undefined) {
          await mem.setTrusted(PROFILE_AUDIT_KEY, auditSnapshot);
        } else {
          await mem.delete(PROFILE_AUDIT_KEY);
        }
      } catch (auditRbErr) {
        rollbackErrors.push(`audit rollback: ${auditRbErr?.message ?? String(auditRbErr)}`);
      }

      const baseMsg = `bulk commit failed: ${err?.message ?? String(err)}`;
      if (rollbackErrors.length > 0) {
        return { ok: false, error: `${baseMsg}; compensation errors: ${rollbackErrors.join("; ")}` };
      }
      return { ok: false, error: baseMsg };
    }

    return { ok: true, writtenSections: committed };
  });
}

/** Clear all profile sections and record audit log with rollback compensation. */
export async function clearProfile(options = {}) {
  const mem = options.memory ?? masterMemory();

  return await withAuditLock(async () => {
    // Snapshot all sections before deleting
    const snapshots = new Map();
    for (const sec of PROFILE_SECTIONS) {
      const prev = await readTrustedMemory(mem, sec);
      snapshots.set(sec, prev != null ? structuredClone(prev) : prev);
    }

    try {
      for (const sec of PROFILE_SECTIONS) {
        await mem.delete(sec);
      }

      await recordAudit(mem, {
        action: "clear",
        section: null,
        actor: options.actor ?? "owner",
        fields: [...PROFILE_SECTIONS],
      });
    } catch (err) {
      // Roll back deleted sections on any deletion or audit failure
      const restoreErrors = [];
      for (const [sec, prev] of snapshots.entries()) {
        if (prev !== null && prev !== undefined) {
          try {
            await mem.setTrusted(sec, prev);
          } catch (rErr) {
            restoreErrors.push(`restore ${sec}: ${rErr?.message ?? String(rErr)}`);
          }
        }
      }
      const baseErr = `clearProfile failed: ${err?.message ?? String(err)}`;
      if (restoreErrors.length > 0) {
        return { ok: false, error: `${baseErr}; restoration failed: ${restoreErrors.join("; ")}` };
      }
      return { ok: false, error: baseErr };
    }

    return { ok: true };
  });
}

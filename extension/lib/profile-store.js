// lib/profile-store.js — structured OPFS user profile store (AGENT-PRODUCT-GAPS, form-filler layer 1).
//
// A structured, namespaced profile store on the OPFS/memory substrate:
//   - profile:basic       (contact, identity, social/portfolio links)
//   - profile:work_history (career timeline, company, title, achievements)
//   - profile:education   (degrees, institutions, dates, GPA)
//   - profile:disclosures (work auth, sponsorship, demographics, custom Q&A)
//
// Security & access control principles (Constitution §2 + §4):
//   - Schema-validated and bounded (finite byte size and array lengths).
//   - Per-agent readable with explicit grants (an agent reads profile sections only if granted).
//   - Write-audited (every mutation is recorded with timestamp, action, and actor in an audit log).
//   - Fail closed on malformed documents or unauthorized access attempts.

import { masterMemory } from "./memory.js";

export const PROFILE_SECTIONS = [
  "profile:basic",
  "profile:work_history",
  "profile:education",
  "profile:disclosures",
];

export const MAX_PROFILE_SECTION_BYTES = 131072; // 128 KiB per section
export const MAX_WORK_ENTRIES = 32;
export const MAX_EDUCATION_ENTRIES = 16;
export const MAX_LINKS_COUNT = 16;
export const MAX_CUSTOM_ANSWERS = 32;
export const MAX_AUDIT_LOG_ENTRIES = 100;
export const PROFILE_AUDIT_KEY = "profile:audit_log";

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

/** Validate and normalize profile:basic document. */
export function validateBasicProfile(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "basic profile must be a non-null object" };
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
  if (typeof data.location === "string") {
    location = data.location.trim().slice(0, 120);
  } else if (data.location && typeof data.location === "object" && !Array.isArray(data.location)) {
    const parts = [
      data.location.city,
      data.location.state,
      data.location.country,
      data.location.postalCode,
    ].filter((x) => typeof x === "string" && x.trim());
    location = parts.join(", ").slice(0, 120);
  }

  // Normalize links (object or array)
  const links = {};
  if (data.links && typeof data.links === "object") {
    if (Array.isArray(data.links)) {
      for (const item of data.links) {
        if (!item || typeof item !== "object") continue;
        const label = String(item.label ?? item.name ?? "link").trim().slice(0, 64);
        const url = String(item.url ?? "").trim().slice(0, 512);
        if (label && url) {
          links[label] = url;
          if (Object.keys(links).length >= MAX_LINKS_COUNT) break;
        }
      }
    } else {
      for (const [key, val] of Object.entries(data.links)) {
        if (typeof val === "string" && val.trim()) {
          const label = key.trim().slice(0, 64);
          links[label] = val.trim().slice(0, 512);
          if (Object.keys(links).length >= MAX_LINKS_COUNT) break;
        }
      }
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
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `work history entry at index ${i} must be an object` };
    }

    const company = String(item.company ?? "").trim().slice(0, 120);
    if (!company) {
      return { ok: false, error: `work history entry at index ${i} requires a company name` };
    }

    const title = String(item.title ?? "").trim().slice(0, 120);
    if (!title) {
      return { ok: false, error: `work history entry at index ${i} requires a job title` };
    }

    const location = String(item.location ?? "").trim().slice(0, 120);
    const startDate = String(item.startDate ?? "").trim().slice(0, 32);
    const endDate = item.endDate == null ? null : String(item.endDate).trim().slice(0, 32);
    const current = Boolean(item.current || (!endDate && startDate));
    const description = String(item.description ?? "").trim().slice(0, 4000);

    const rawHighlights = Array.isArray(item.highlights) ? item.highlights : [];
    const highlights = [];
    for (const h of rawHighlights) {
      if (typeof h === "string" && h.trim()) {
        highlights.push(h.trim().slice(0, 500));
        if (highlights.length >= 16) break;
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
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `education entry at index ${i} must be an object` };
    }

    const institution = String(item.institution ?? item.school ?? "").trim().slice(0, 120);
    if (!institution) {
      return { ok: false, error: `education entry at index ${i} requires an institution name` };
    }

    const degree = String(item.degree ?? "").trim().slice(0, 120);
    const fieldOfStudy = String(item.fieldOfStudy ?? item.major ?? "").trim().slice(0, 120);
    const startDate = String(item.startDate ?? "").trim().slice(0, 32);
    const endDate = item.endDate == null ? null : String(item.endDate ?? item.graduationYear ?? "").trim().slice(0, 32);
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
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "disclosures must be an object" };
  }

  const workAuthorization = String(data.workAuthorization ?? "").trim().slice(0, 64);
  const requiresSponsorship = typeof data.requiresSponsorship === "boolean"
    ? data.requiresSponsorship
    : (data.requiresSponsorship != null ? String(data.requiresSponsorship).trim().slice(0, 32) : null);
  const gender = String(data.gender ?? "").trim().slice(0, 64);
  const veteranStatus = String(data.veteranStatus ?? "").trim().slice(0, 64);
  const disabilityStatus = String(data.disabilityStatus ?? "").trim().slice(0, 64);
  const raceEthnicity = String(data.raceEthnicity ?? "").trim().slice(0, 64);

  const customAnswers = {};
  if (data.customAnswers && typeof data.customAnswers === "object" && !Array.isArray(data.customAnswers)) {
    for (const [k, v] of Object.entries(data.customAnswers)) {
      if (typeof k === "string" && v != null) {
        const qKey = k.trim().slice(0, 64);
        const ansVal = String(v).trim().slice(0, 1000);
        if (qKey) {
          customAnswers[qKey] = ansVal;
          if (Object.keys(customAnswers).length >= MAX_CUSTOM_ANSWERS) break;
        }
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

/** Internal helper to record an audit log entry for profile mutations. */
async function recordAudit(mem, { action, section, actor = "owner", fields = [] }) {
  try {
    const existing = (await mem.get(PROFILE_AUDIT_KEY)) ?? [];
    const log = Array.isArray(existing) ? existing : [];
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
  } catch {
    return null;
  }
}

/** Read the profile mutation audit log. */
export async function getProfileAuditLog(options = {}) {
  const mem = options.memory ?? masterMemory();
  const log = (await mem.get(PROFILE_AUDIT_KEY)) ?? [];
  return Array.isArray(log) ? log : [];
}

/** Check if an agent record or grant list possesses explicit permission for a section. */
export function hasProfileGrant(agentOrGrants, sectionKey) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) return false;

  // Owner / master caller has full access
  if (
    agentOrGrants === null ||
    agentOrGrants === undefined ||
    agentOrGrants === "owner" ||
    agentOrGrants === "master"
  ) {
    return true;
  }

  let grants = null;
  if (Array.isArray(agentOrGrants)) {
    grants = agentOrGrants;
  } else if (typeof agentOrGrants === "object" && agentOrGrants !== null) {
    grants = agentOrGrants.profileGrants ?? agentOrGrants.profileAccess ?? agentOrGrants.grants ?? null;
  }

  if (!Array.isArray(grants)) return false;

  for (const g of grants) {
    if (typeof g !== "string") continue;
    const cleanGrant = g.trim().toLowerCase();
    if (cleanGrant === "*" || cleanGrant === "profile:*") return true;
    if (normalizeSectionKey(cleanGrant) === normSection) return true;
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
  const data = await mem.get(normSection);
  return { ok: true, section: normSection, data: data ?? null };
}

/** Write and audit a profile section. */
export async function setProfileSection(sectionKey, data, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  const validation = validateProfileSection(normSection, data);
  if (!validation.ok) return validation;

  const serialized = JSON.stringify(validation.data);
  if (serialized.length > MAX_PROFILE_SECTION_BYTES) {
    return {
      ok: false,
      error: `section payload exceeds maximum size (${serialized.length} > ${MAX_PROFILE_SECTION_BYTES})`,
    };
  }

  const mem = options.memory ?? masterMemory();
  const existing = await mem.get(normSection);
  const action = existing ? "update" : "create";

  await mem.setTrusted(normSection, validation.data);

  const changedFields = Array.isArray(validation.data)
    ? [`entries:${validation.data.length}`]
    : Object.keys(validation.data);

  await recordAudit(mem, {
    action,
    section: normSection,
    actor: options.actor ?? "owner",
    fields: changedFields,
  });

  return { ok: true, section: normSection, data: validation.data };
}

/** Delete and audit a profile section. */
export async function deleteProfileSection(sectionKey, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  const mem = options.memory ?? masterMemory();
  const existing = await mem.get(normSection);
  if (existing !== null && existing !== undefined) {
    await mem.delete(normSection);
    await recordAudit(mem, {
      action: "delete",
      section: normSection,
      actor: options.actor ?? "owner",
    });
  }

  return { ok: true, section: normSection };
}

/** Read a profile section scoped to an agent's explicit grants. Fails closed if unauthorized. */
export async function readAgentProfileSection(agentOrRecord, sectionKey, options = {}) {
  const normSection = normalizeSectionKey(sectionKey);
  if (!normSection) {
    return { ok: false, error: `invalid profile section key: ${sectionKey}` };
  }

  if (!hasProfileGrant(agentOrRecord, normSection)) {
    const agentId = typeof agentOrRecord === "object" && agentOrRecord !== null
      ? (agentOrRecord.id ?? agentOrRecord.name ?? "unnamed-agent")
      : String(agentOrRecord ?? "unauthorized-agent");
    return {
      ok: false,
      error: `unauthorized: agent "${agentId}" lacks explicit grant for ${normSection}`,
    };
  }

  const mem = options.memory ?? masterMemory();
  const data = await mem.get(normSection);
  return { ok: true, section: normSection, data: data ?? null };
}

/** Read all profile sections granted to an agent in a single call. */
export async function readAgentProfile(agentOrRecord, options = {}) {
  const mem = options.memory ?? masterMemory();
  const readableSections = PROFILE_SECTIONS.filter((sec) => hasProfileGrant(agentOrRecord, sec));

  if (readableSections.length === 0) {
    const agentId = typeof agentOrRecord === "object" && agentOrRecord !== null
      ? (agentOrRecord.id ?? agentOrRecord.name ?? "unnamed-agent")
      : String(agentOrRecord ?? "unauthorized-agent");
    return {
      ok: false,
      error: `unauthorized: agent "${agentId}" has no profile grants`,
    };
  }

  const profile = {};
  for (const sec of readableSections) {
    const data = await mem.get(sec);
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
    const data = await mem.get(sec);
    if (data !== null && data !== undefined) {
      profile[sec] = data;
    }
  }
  return { ok: true, profile };
}

/** Set multiple profile sections in bulk and audit each. */
export async function setWholeProfile(profileObject, options = {}) {
  if (!profileObject || typeof profileObject !== "object" || Array.isArray(profileObject)) {
    return { ok: false, error: "profile must be an object with section keys" };
  }

  const written = [];
  for (const [k, val] of Object.entries(profileObject)) {
    const norm = normalizeSectionKey(k);
    if (norm) {
      const res = await setProfileSection(norm, val, options);
      if (!res.ok) return res;
      written.push(norm);
    }
  }

  return { ok: true, writtenSections: written };
}

/** Clear all profile sections and audit. */
export async function clearProfile(options = {}) {
  const mem = options.memory ?? masterMemory();
  for (const sec of PROFILE_SECTIONS) {
    await mem.delete(sec).catch(() => {});
  }
  await recordAudit(mem, {
    action: "clear",
    section: null,
    actor: options.actor ?? "owner",
    fields: [...PROFILE_SECTIONS],
  });
  return { ok: true };
}

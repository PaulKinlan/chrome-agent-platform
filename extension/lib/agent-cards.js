// lib/agent-cards.js — portable agent card export/import (AGENT-PRODUCT-GAPS §5, G7).
//
// An agent card is a portable JSON document representing an agent's configuration:
//   - identity: name + avatar
//   - persona / role: instructions and behavioral prompt
//   - skills: attached skill/recipe IDs (validated against RECIPES)
//   - schedule: optional periodic or one-shot schedule configuration
//   - coreAssets: attached reference documents/files
//   - createdFrom: optional starting template ID
//   - version + metadata: schema version and export timestamp
//
// Security & integrity principles (Constitution §2 + §4):
//   - Agent cards are pure DATA (never executable code or eval'd strings).
//   - Hostile input FAILS CLOSED (malformed JSON, invalid types, non-plain objects, throwing accessors).
//   - Unknown skill IDs are dropped with an explicit, bounded droppedSkills report.
//   - Oversized fields are strictly bounded (role, assets, names, counts).
//   - Structured credentials (API keys, session tokens, instance IDs) are NEVER exported in cards.
//   - Plain data objects only: prototype inheritance and accessor traps fail closed.

import { RECIPES } from "./recipes.js";

export const AGENT_CARD_VERSION = 1;
export const MAX_CARD_NAME_LEN = 120;
export const MAX_CARD_ROLE_LEN = 32000;
export const MAX_CARD_SKILLS = 128;
export const MAX_RAW_SKILLS_INPUT = 256;
export const MAX_DROPPED_SKILLS_REPORT = 128;
export const MAX_CARD_CORE_ASSETS = 8;
export const MAX_CARD_CORE_ASSET_BYTES = 131072; // 128 KiB per core asset
export const MAX_CARD_JSON_BYTES = 2097152; // 2 MiB (accommodates 8 × 128 KiB assets + role + metadata)
export const MAX_CREATED_FROM_LEN = 64;
export const MAX_AVATAR_LEN = 32768; // 32 KiB for avatar data URL / emoji / SVG
export const MAX_SCHEDULE_TASK_LEN = 4000;
export const MAX_SCHEDULE_AT_LEN = 64;

/**
 * Normalize and bound core assets attached to an agent card.
 * Truncates oversized content with an ellipsis and caps asset count.
 */
export function normalizeCardCoreAssets(assets) {
  if (!Array.isArray(assets)) return [];
  const out = [];
  for (const a of assets) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const name = String(a.name ?? "").trim().slice(0, 96);
    const type = String(a.type ?? "text/plain").trim().slice(0, 64);
    let content = a.content == null ? "" : String(a.content);
    if (content.length > MAX_CARD_CORE_ASSET_BYTES) {
      content = content.slice(0, MAX_CARD_CORE_ASSET_BYTES) + "…";
    }
    if (!name && !content) continue;
    out.push({ name, type, content });
    if (out.length >= MAX_CARD_CORE_ASSETS) break;
  }
  return out;
}

function getKnownSkillSet(customKnown) {
  if (customKnown instanceof Set) return customKnown;
  if (Array.isArray(customKnown)) return new Set(customKnown);
  return new Set(RECIPES.map((r) => r.id));
}

/**
 * Export an agent record to a portable card JSON object.
 * Extracts only safe, shareable fields (name, persona/role, skills, schedule, coreAssets, createdFrom, avatar).
 * Normalizes both string skill IDs and { id } object skill records.
 * Structured credentials, private keys, and runtime instance IDs are NEVER exported.
 */
export function exportAgentCard(agent, { schedule = null, exportedAt = null } = {}) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new TypeError("exportAgentCard requires an agent object");
  }
  const cleanName = String(agent.name ?? "").trim();
  if (!cleanName) {
    throw new Error("agent card export requires a non-empty agent name");
  }

  const roleText = String(agent.role ?? agent.persona ?? "").trim();
  const boundedRole = roleText.length > MAX_CARD_ROLE_LEN
    ? roleText.slice(0, MAX_CARD_ROLE_LEN)
    : roleText;

  // Real named-agent records in storage or UI may contain string IDs OR { id, name, description } objects
  const rawSkills = Array.isArray(agent.skills) ? agent.skills : [];
  const skills = [];
  for (const s of rawSkills) {
    let skillId = null;
    if (typeof s === "string" && s.trim()) {
      skillId = s.trim();
    } else if (s && typeof s === "object" && typeof s.id === "string" && s.id.trim()) {
      skillId = s.id.trim();
    }
    if (skillId && !skills.includes(skillId)) {
      skills.push(skillId);
      if (skills.length >= MAX_CARD_SKILLS) break;
    }
  }

  const coreAssets = normalizeCardCoreAssets(agent.coreAssets);

  const card = {
    version: AGENT_CARD_VERSION,
    exportedAt: exportedAt
      ? (typeof exportedAt === "string" ? exportedAt.slice(0, 64) : new Date(exportedAt).toISOString())
      : new Date().toISOString(),
    name: cleanName.slice(0, MAX_CARD_NAME_LEN),
    role: boundedRole,
    persona: boundedRole,
    skills,
    coreAssets,
  };

  const createdFrom = agent.createdFrom ?? agent.templateId;
  if (createdFrom && typeof createdFrom === "string" && createdFrom.trim()) {
    card.createdFrom = createdFrom.trim().slice(0, MAX_CREATED_FROM_LEN);
  }

  const sched = schedule ?? agent.schedule;
  if (sched && typeof sched === "object" && !Array.isArray(sched)) {
    const normalizedSched = {};
    if (sched.periodInMinutes != null && Number.isFinite(Number(sched.periodInMinutes))) {
      normalizedSched.periodInMinutes = Number(sched.periodInMinutes);
    }
    if (sched.task != null || sched.prompt != null) {
      normalizedSched.task = String(sched.task ?? sched.prompt ?? "").trim().slice(0, MAX_SCHEDULE_TASK_LEN);
    }
    if (sched.at != null) {
      if (typeof sched.at === "number" && Number.isFinite(sched.at)) {
        normalizedSched.at = sched.at;
      } else if (typeof sched.at === "string" && sched.at.trim()) {
        normalizedSched.at = sched.at.trim().slice(0, MAX_SCHEDULE_AT_LEN);
      }
    }
    if (Object.keys(normalizedSched).length > 0) {
      card.schedule = normalizedSched;
    }
  }

  if (agent.avatar && typeof agent.avatar === "string" && agent.avatar.trim()) {
    card.avatar = agent.avatar.trim().slice(0, MAX_AVATAR_LEN);
  }

  return card;
}

/**
 * Export an agent record to a formatted JSON string.
 */
export function exportAgentCardJson(agent, options = {}) {
  const card = exportAgentCard(agent, options);
  return JSON.stringify(card, null, 2);
}

/**
 * Validate a card JSON object and extract a normalized agent record.
 * Unknown skill IDs are dropped and reported in `droppedSkills`.
 * Oversized fields are bounded. Hostile shapes, prototype inheritance, and throwing accessors fail closed.
 */
export function validateAgentCard(card, options = {}) {
  try {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      return { ok: false, error: "agent card must be a non-null JSON object" };
    }

    // Require plain data object — reject prototype pollution and inherited properties
    const proto = Object.getPrototypeOf(card);
    if (proto !== Object.prototype && proto !== null) {
      return {
        ok: false,
        error: "agent card must be a plain JSON object (prototype inheritance is rejected)",
      };
    }

    // Version validation: strict integer checking (no boolean or array coercion)
    let version = AGENT_CARD_VERSION;
    if (Object.hasOwn(card, "version") && card.version !== undefined && card.version !== null) {
      if (typeof card.version !== "number" && typeof card.version !== "string") {
        return { ok: false, error: "card version must be an integer" };
      }
      const rawVer = typeof card.version === "string" ? card.version.trim() : card.version;
      if (typeof rawVer === "string" && !/^\d+$/.test(rawVer)) {
        return { ok: false, error: `unsupported agent card version (${card.version})` };
      }
      const numVer = Number(rawVer);
      if (!Number.isSafeInteger(numVer) || numVer < 1 || numVer > AGENT_CARD_VERSION) {
        return { ok: false, error: `unsupported agent card version (${card.version})` };
      }
      version = numVer;
    }

    // Name validation: must be an own property, required, string, non-empty, bounded
    if (!Object.hasOwn(card, "name") || card.name === undefined || card.name === null) {
      return { ok: false, error: "agent card requires a name" };
    }
    if (typeof card.name !== "string") {
      return { ok: false, error: "agent card name must be a string" };
    }
    const trimmedName = card.name.trim();
    if (!trimmedName) {
      return { ok: false, error: "agent card requires a non-empty name" };
    }
    const cleanName = trimmedName.slice(0, MAX_CARD_NAME_LEN);

    // Role / Persona validation (optional string, bounded)
    const hasRole = Object.hasOwn(card, "role");
    const hasPersona = Object.hasOwn(card, "persona");
    const rawRole = hasRole ? card.role : (hasPersona ? card.persona : undefined);

    if (rawRole !== undefined && rawRole !== null && typeof rawRole !== "string") {
      return { ok: false, error: "agent role/persona must be a string" };
    }
    const roleText = String(rawRole ?? "").trim();
    const boundedRole = roleText.length > MAX_CARD_ROLE_LEN
      ? roleText.slice(0, MAX_CARD_ROLE_LEN)
      : roleText;

    // Skills validation & filtering against RECIPES
    const rawSkills = Object.hasOwn(card, "skills") ? card.skills : undefined;
    if (rawSkills !== undefined && rawSkills !== null && !Array.isArray(rawSkills)) {
      return { ok: false, error: "skills must be an array of skill ids" };
    }

    if (Array.isArray(rawSkills) && rawSkills.length > MAX_RAW_SKILLS_INPUT) {
      return {
        ok: false,
        error: `skills list exceeds maximum allowed count (${rawSkills.length} > ${MAX_RAW_SKILLS_INPUT})`,
      };
    }

    const knownSkillSet = getKnownSkillSet(options?.knownSkillIds ?? options?.knownSkills);
    const validSkills = [];
    const droppedSkills = [];
    let omittedValidSkillsCount = 0;
    let omittedDroppedSkillsCount = 0;

    if (Array.isArray(rawSkills)) {
      for (const item of rawSkills) {
        let skillId = null;
        if (typeof item === "string") {
          skillId = item.trim();
        } else if (item && typeof item === "object" && typeof item.id === "string") {
          skillId = item.id.trim();
        } else {
          return { ok: false, error: "skill ids must be strings" };
        }

        if (!skillId) continue;

        if (knownSkillSet.has(skillId)) {
          if (!validSkills.includes(skillId)) {
            if (validSkills.length < MAX_CARD_SKILLS) {
              validSkills.push(skillId);
            } else {
              omittedValidSkillsCount++;
            }
          }
        } else {
          if (!droppedSkills.includes(skillId)) {
            if (droppedSkills.length < MAX_DROPPED_SKILLS_REPORT) {
              droppedSkills.push(skillId);
            } else {
              omittedDroppedSkillsCount++;
            }
          }
        }
      }
    }

    // Core assets validation
    const rawAssets = Object.hasOwn(card, "coreAssets") ? card.coreAssets : undefined;
    if (rawAssets !== undefined && rawAssets !== null && !Array.isArray(rawAssets)) {
      return { ok: false, error: "coreAssets must be an array" };
    }
    const coreAssets = normalizeCardCoreAssets(rawAssets);

    // Schedule validation
    let schedule = null;
    const rawSched = Object.hasOwn(card, "schedule") ? card.schedule : undefined;
    if (rawSched !== undefined && rawSched !== null) {
      if (typeof rawSched !== "object" || Array.isArray(rawSched)) {
        return { ok: false, error: "schedule must be an object" };
      }
      const normSched = {};
      if (Object.hasOwn(rawSched, "periodInMinutes") && rawSched.periodInMinutes !== undefined && rawSched.periodInMinutes !== null) {
        const p = Number(rawSched.periodInMinutes);
        if (!Number.isFinite(p) || p <= 0) {
          return { ok: false, error: "schedule periodInMinutes must be a positive number" };
        }
        normSched.periodInMinutes = p;
      }
      if (Object.hasOwn(rawSched, "task") || Object.hasOwn(rawSched, "prompt")) {
        const rawTask = rawSched.task ?? rawSched.prompt;
        if (typeof rawTask !== "string") {
          return { ok: false, error: "schedule task must be a string" };
        }
        normSched.task = rawTask.trim().slice(0, MAX_SCHEDULE_TASK_LEN);
      }
      if (Object.hasOwn(rawSched, "at") && rawSched.at !== undefined && rawSched.at !== null) {
        if (typeof rawSched.at === "number") {
          if (!Number.isFinite(rawSched.at)) {
            return { ok: false, error: "schedule at must be a finite timestamp or date string" };
          }
          normSched.at = rawSched.at;
        } else if (typeof rawSched.at === "string") {
          const atStr = rawSched.at.trim();
          if (atStr.length > MAX_SCHEDULE_AT_LEN) {
            return {
              ok: false,
              error: `schedule at exceeds maximum length (${atStr.length} > ${MAX_SCHEDULE_AT_LEN})`,
            };
          }
          normSched.at = atStr;
        } else {
          return { ok: false, error: "schedule at must be a string timestamp or number" };
        }
      }
      if (Object.keys(normSched).length > 0) {
        schedule = normSched;
      }
    }

    // createdFrom / templateId
    let createdFrom = null;
    const rawCreatedFrom = Object.hasOwn(card, "createdFrom")
      ? card.createdFrom
      : (Object.hasOwn(card, "templateId") ? card.templateId : undefined);
    if (rawCreatedFrom !== undefined && rawCreatedFrom !== null) {
      if (typeof rawCreatedFrom !== "string") {
        return { ok: false, error: "createdFrom must be a string template id" };
      }
      const cleanTemplateId = rawCreatedFrom.trim().slice(0, MAX_CREATED_FROM_LEN);
      if (cleanTemplateId) createdFrom = cleanTemplateId;
    }

    // avatar
    let avatar = null;
    const rawAvatar = Object.hasOwn(card, "avatar") ? card.avatar : undefined;
    if (rawAvatar !== undefined && rawAvatar !== null) {
      if (typeof rawAvatar !== "string") {
        return { ok: false, error: "avatar must be a string" };
      }
      const cleanAvatar = rawAvatar.trim().slice(0, MAX_AVATAR_LEN);
      if (cleanAvatar) avatar = cleanAvatar;
    }

    // exportedAt validation
    let exportedAt = null;
    if (Object.hasOwn(card, "exportedAt") && card.exportedAt !== undefined && card.exportedAt !== null) {
      if (typeof card.exportedAt === "string") {
        exportedAt = card.exportedAt.trim().slice(0, 64);
      } else if (typeof card.exportedAt === "number" && Number.isFinite(card.exportedAt)) {
        exportedAt = new Date(card.exportedAt).toISOString();
      } else {
        return { ok: false, error: "exportedAt must be a date string or timestamp" };
      }
    }

    const agent = {
      name: cleanName,
      role: boundedRole,
      skills: validSkills,
      coreAssets,
      ...(schedule ? { schedule } : {}),
      ...(createdFrom ? { createdFrom } : {}),
      ...(avatar ? { avatar } : {}),
    };

    return {
      ok: true,
      agent,
      droppedSkills,
      omittedValidSkillsCount,
      omittedDroppedSkillsCount,
      version,
      exportedAt,
    };
  } catch (e) {
    return { ok: false, error: `card validation error: ${e?.message ?? String(e)}` };
  }
}

/**
 * Import a card JSON string or object and return a validated agent record.
 * Fails closed on hostile input, malformed JSON, prototype inheritance, or oversized payloads.
 */
export function importAgentCard(cardInput, options = {}) {
  try {
    const maxBytes = options?.maxBytes ?? MAX_CARD_JSON_BYTES;

    let cardObj = cardInput;
    if (typeof cardInput === "string") {
      const utf8Bytes = new TextEncoder().encode(cardInput).byteLength;
      if (utf8Bytes > maxBytes) {
        return {
          ok: false,
          error: `card JSON exceeds maximum allowed size (${utf8Bytes} bytes > ${maxBytes} bytes)`,
        };
      }
      try {
        cardObj = JSON.parse(cardInput);
      } catch (e) {
        return {
          ok: false,
          error: `malformed card JSON: ${e?.message ?? "parse error"}`,
        };
      }
    } else if (cardInput && typeof cardInput === "object") {
      try {
        const serialized = JSON.stringify(cardInput);
        if (serialized !== undefined) {
          const utf8Bytes = new TextEncoder().encode(serialized).byteLength;
          if (utf8Bytes > maxBytes) {
            return {
              ok: false,
              error: `card object exceeds maximum allowed size (${utf8Bytes} bytes > ${maxBytes} bytes)`,
            };
          }
        }
      } catch (e) {
        return {
          ok: false,
          error: `card object cannot be serialized (cyclic/circular structure): ${e?.message ?? String(e)}`,
        };
      }
    }

    return validateAgentCard(cardObj, options);
  } catch (e) {
    return { ok: false, error: `import failed: ${e?.message ?? String(e)}` };
  }
}

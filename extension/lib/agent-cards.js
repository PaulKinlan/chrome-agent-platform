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
//   - Hostile input FAILS CLOSED (malformed JSON, invalid types, non-object roots).
//   - Unknown skill IDs are dropped with an explicit droppedSkills report.
//   - Oversized fields are strictly bounded (role, assets, names, counts).
//   - Sensitive credentials (API keys, session tokens) are NEVER exported in cards.

import { RECIPES } from "./recipes.js";

export const AGENT_CARD_VERSION = 1;
export const MAX_CARD_NAME_LEN = 120;
export const MAX_CARD_ROLE_LEN = 32000;
export const MAX_CARD_SKILLS = 128;
export const MAX_CARD_CORE_ASSETS = 8;
export const MAX_CARD_CORE_ASSET_BYTES = 131072; // 128 KiB per core asset
export const MAX_CARD_JSON_BYTES = 1048576; // 1 MiB max raw card JSON payload
export const MAX_CREATED_FROM_LEN = 64;
export const MAX_AVATAR_LEN = 32768; // 32 KiB for avatar data URL / emoji / SVG

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
 * Credentials, private keys, and runtime instance IDs are NEVER exported.
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

  const rawSkills = Array.isArray(agent.skills) ? agent.skills : [];
  const skills = [];
  for (const s of rawSkills) {
    if (typeof s === "string" && s.trim()) {
      const clean = s.trim();
      if (!skills.includes(clean)) {
        skills.push(clean);
        if (skills.length >= MAX_CARD_SKILLS) break;
      }
    }
  }

  const coreAssets = normalizeCardCoreAssets(agent.coreAssets);

  const card = {
    version: AGENT_CARD_VERSION,
    exportedAt: exportedAt
      ? (typeof exportedAt === "string" ? exportedAt : new Date(exportedAt).toISOString())
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
      normalizedSched.task = String(sched.task ?? sched.prompt ?? "").trim().slice(0, 4000);
    }
    if (sched.at != null && (typeof sched.at === "string" || typeof sched.at === "number")) {
      normalizedSched.at = sched.at;
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
 * Oversized fields are bounded. Hostile shapes fail closed.
 */
export function validateAgentCard(card, options = {}) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return { ok: false, error: "agent card must be a non-null JSON object" };
  }

  // Version validation
  let version = AGENT_CARD_VERSION;
  if (card.version !== undefined && card.version !== null) {
    const numVer = Number(card.version);
    if (!Number.isInteger(numVer) || numVer < 1 || numVer > AGENT_CARD_VERSION) {
      return { ok: false, error: `unsupported agent card version (${card.version})` };
    }
    version = numVer;
  }

  // Name validation (required, string, non-empty, bounded)
  if (card.name === undefined || card.name === null) {
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
  const rawRole = card.role !== undefined ? card.role : card.persona;
  if (rawRole !== undefined && rawRole !== null && typeof rawRole !== "string") {
    return { ok: false, error: "agent role/persona must be a string" };
  }
  const roleText = String(rawRole ?? "").trim();
  const boundedRole = roleText.length > MAX_CARD_ROLE_LEN
    ? roleText.slice(0, MAX_CARD_ROLE_LEN)
    : roleText;

  // Skills validation & filtering against RECIPES
  const rawSkills = card.skills;
  if (rawSkills !== undefined && rawSkills !== null && !Array.isArray(rawSkills)) {
    return { ok: false, error: "skills must be an array of skill ids" };
  }

  const knownSkillSet = getKnownSkillSet(options?.knownSkillIds ?? options?.knownSkills);
  const validSkills = [];
  const droppedSkills = [];

  if (Array.isArray(rawSkills)) {
    for (const item of rawSkills) {
      if (typeof item !== "string") {
        return { ok: false, error: "skill ids must be strings" };
      }
      const skillId = item.trim();
      if (!skillId) continue;
      if (knownSkillSet.has(skillId)) {
        if (!validSkills.includes(skillId)) {
          if (validSkills.length < MAX_CARD_SKILLS) {
            validSkills.push(skillId);
          }
        }
      } else {
        if (!droppedSkills.includes(skillId)) {
          droppedSkills.push(skillId);
        }
      }
    }
  }

  // Core assets validation
  const rawAssets = card.coreAssets;
  if (rawAssets !== undefined && rawAssets !== null && !Array.isArray(rawAssets)) {
    return { ok: false, error: "coreAssets must be an array" };
  }
  const coreAssets = normalizeCardCoreAssets(rawAssets);

  // Schedule validation
  let schedule = null;
  const rawSched = card.schedule;
  if (rawSched !== undefined && rawSched !== null) {
    if (typeof rawSched !== "object" || Array.isArray(rawSched)) {
      return { ok: false, error: "schedule must be an object" };
    }
    const normSched = {};
    if (rawSched.periodInMinutes !== undefined && rawSched.periodInMinutes !== null) {
      const p = Number(rawSched.periodInMinutes);
      if (!Number.isFinite(p) || p <= 0) {
        return { ok: false, error: "schedule periodInMinutes must be a positive number" };
      }
      normSched.periodInMinutes = p;
    }
    if (rawSched.task !== undefined || rawSched.prompt !== undefined) {
      const rawTask = rawSched.task ?? rawSched.prompt;
      if (typeof rawTask !== "string") {
        return { ok: false, error: "schedule task must be a string" };
      }
      normSched.task = rawTask.trim().slice(0, 4000);
    }
    if (rawSched.at !== undefined && rawSched.at !== null) {
      if (typeof rawSched.at !== "string" && typeof rawSched.at !== "number") {
        return { ok: false, error: "schedule at must be a string timestamp or number" };
      }
      normSched.at = rawSched.at;
    }
    if (Object.keys(normSched).length > 0) {
      schedule = normSched;
    }
  }

  // createdFrom / templateId
  let createdFrom = null;
  const rawCreatedFrom = card.createdFrom ?? card.templateId;
  if (rawCreatedFrom !== undefined && rawCreatedFrom !== null) {
    if (typeof rawCreatedFrom !== "string") {
      return { ok: false, error: "createdFrom must be a string template id" };
    }
    const cleanTemplateId = rawCreatedFrom.trim().slice(0, MAX_CREATED_FROM_LEN);
    if (cleanTemplateId) createdFrom = cleanTemplateId;
  }

  // avatar
  let avatar = null;
  const rawAvatar = card.avatar;
  if (rawAvatar !== undefined && rawAvatar !== null) {
    if (typeof rawAvatar !== "string") {
      return { ok: false, error: "avatar must be a string" };
    }
    const cleanAvatar = rawAvatar.trim().slice(0, MAX_AVATAR_LEN);
    if (cleanAvatar) avatar = cleanAvatar;
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
    version,
    exportedAt: card.exportedAt ?? null,
  };
}

/**
 * Import a card JSON string or object and return a validated agent record.
 * Fails closed on hostile input or malformed JSON.
 */
export function importAgentCard(cardInput, options = {}) {
  const maxBytes = options?.maxBytes ?? MAX_CARD_JSON_BYTES;

  let cardObj = cardInput;
  if (typeof cardInput === "string") {
    if (cardInput.length > maxBytes) {
      return {
        ok: false,
        error: `card JSON exceeds maximum allowed size (${cardInput.length} > ${maxBytes})`,
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
  }

  return validateAgentCard(cardObj, options);
}

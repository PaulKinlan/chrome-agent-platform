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
//   - Hostile input FAILS CLOSED (malformed JSON, invalid types, accessors, toJSON methods, cyclic objects).
//   - Plain data objects only: deep descriptor validation rejects prototype inheritance and accessor traps (including array-index getters).
//   - UTF-8 byte bounded: asset content and serialized JSON payloads bounded strictly by UTF-8 bytes.
//   - Deduplicated counting: omitted skills/dropped counters increment per distinct ID.
//   - Structured credentials (API keys, session tokens, instance IDs) are NEVER exported in cards.

import { RECIPES } from "./recipes.js";

export const AGENT_CARD_VERSION = 1;
// dptw: no card name/role length, skill count, raw-skills input, core-asset
// count/bytes, card-JSON bytes, createdFrom/avatar/schedule length limits —
// a card of any size exports and imports whole. Shape/charset validation
// stays; Infinity is used so the truncate/budget helpers short-circuit whole.
export const MAX_CARD_NAME_LEN = Number.POSITIVE_INFINITY;
export const MAX_CARD_ROLE_LEN = Number.POSITIVE_INFINITY;
export const MAX_CARD_SKILLS = Number.POSITIVE_INFINITY;
export const MAX_RAW_SKILLS_INPUT = Number.POSITIVE_INFINITY;
export const MAX_DROPPED_SKILLS_REPORT = 128; // report-window only (not data)
export const MAX_CARD_CORE_ASSETS = Number.POSITIVE_INFINITY;
export const MAX_CARD_CORE_ASSET_BYTES = Number.POSITIVE_INFINITY;
export const MAX_CARD_JSON_BYTES = Number.POSITIVE_INFINITY;
export const MAX_CREATED_FROM_LEN = Number.POSITIVE_INFINITY;
export const MAX_AVATAR_LEN = Number.POSITIVE_INFINITY;
export const MAX_SCHEDULE_TASK_LEN = Number.POSITIVE_INFINITY;
export const MAX_SCHEDULE_AT_LEN = Number.POSITIVE_INFINITY;

/**
 * Truncate a UTF-8 string to at most maxBytes, appending an ellipsis "…" (3 UTF-8 bytes)
 * if truncation occurred, without splitting multi-byte code points.
 * Returns empty string if maxBytes is less than 3 bytes (cannot fit ellipsis).
 */
export function truncateToUtf8Bytes(text, maxBytes) {
  if (typeof text !== "string" || !text || maxBytes <= 0) return "";
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;

  if (maxBytes < 3) return "";

  const ellipsis = "…";
  const ellipsisBytes = encoder.encode(ellipsis); // 3 bytes
  const targetBytes = maxBytes - ellipsisBytes.byteLength;

  const decoder = new TextDecoder("utf-8", { fatal: false });
  let sliced = decoder.decode(bytes.subarray(0, targetBytes));
  sliced = sliced.replace(/\uFFFD+$/, "");

  return sliced + ellipsis;
}

/**
 * Normalize and bound core assets attached to an agent card.
 * Truncates oversized content strictly by UTF-8 bytes and caps asset count.
 */
export function normalizeCardCoreAssets(assets) {
  if (!Array.isArray(assets)) return [];
  const out = [];
  for (const a of assets) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const name = String(a.name ?? "").trim().slice(0, 96);
    const type = String(a.type ?? "text/plain").trim().slice(0, 64);
    let content = a.content == null ? "" : String(a.content);
    content = truncateToUtf8Bytes(content, MAX_CARD_CORE_ASSET_BYTES);
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
 * Recursively validate that a JavaScript value is a pure, plain data graph.
 * Fails closed on:
 *   - Prototype inheritance (must have Object.prototype/null or Array.prototype)
 *   - Accessor properties (getters / setters on objects AND array indices)
 *   - Non-enumerable properties
 *   - Functions, methods, and toJSON hooks
 *   - Symbols
 *   - Cyclic / circular references
 */
export function assertPlainDataGraph(root) {
  const visited = new Set();

  function walk(node, path = "") {
    if (node === null || typeof node !== "object") {
      if (typeof node === "function" || typeof node === "symbol") {
        return { ok: false, error: `disallowed non-data value at ${path || "root"}` };
      }
      return { ok: true };
    }

    if (visited.has(node)) {
      return { ok: false, error: `cyclic structure detected at ${path || "root"}` };
    }
    visited.add(node);

    if (Array.isArray(node)) {
      const proto = Object.getPrototypeOf(node);
      if (proto !== Array.prototype) {
        return { ok: false, error: `array prototype inheritance detected at ${path || "root"}` };
      }

      const symbols = Object.getOwnPropertySymbols(node);
      if (symbols.length > 0) {
        return { ok: false, error: `symbol properties rejected on array at ${path || "root"}` };
      }

      const descs = Object.getOwnPropertyDescriptors(node);
      for (const [prop, desc] of Object.entries(descs)) {
        if (prop === "length") {
          if (desc.get !== undefined || desc.set !== undefined || typeof desc.value !== "number") {
            return { ok: false, error: `invalid array length descriptor at ${path || "root"}` };
          }
          continue;
        }

        if (prop === "toJSON") {
          return { ok: false, error: `toJSON property rejected on array at ${path || "root"}` };
        }

        if (desc.get !== undefined || desc.set !== undefined) {
          return { ok: false, error: `accessor property (getter/setter) rejected: ${prop}` };
        }

        if (!desc.enumerable) {
          return { ok: false, error: `non-enumerable property rejected on array: ${prop}` };
        }

        if (typeof desc.value === "function") {
          return { ok: false, error: `method/function rejected on array: ${prop}` };
        }

        const isCanonicalIndex = String(Number(prop)) === prop &&
          Number.isSafeInteger(Number(prop)) &&
          Number(prop) >= 0 &&
          Number(prop) <= 4294967294;

        if (!isCanonicalIndex) {
          return { ok: false, error: `custom non-index property rejected on array: ${prop}` };
        }

        // Recurse through desc.value without ever reading node[prop] directly
        const itemRes = walk(desc.value, `${path}[${prop}]`);
        if (!itemRes.ok) return itemRes;
      }

      return { ok: true };
    }

    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      return { ok: false, error: `prototype inheritance detected at ${path || "root"}` };
    }

    const symbols = Object.getOwnPropertySymbols(node);
    if (symbols.length > 0) {
      return { ok: false, error: `symbol properties rejected at ${path || "root"}` };
    }

    const descs = Object.getOwnPropertyDescriptors(node);
    for (const [prop, desc] of Object.entries(descs)) {
      if (prop === "toJSON") {
        return { ok: false, error: `toJSON property rejected at ${path || "root"}` };
      }
      if (desc.get !== undefined || desc.set !== undefined) {
        return { ok: false, error: `accessor property (getter/setter) rejected: ${prop}` };
      }
      if (!desc.enumerable) {
        return { ok: false, error: `non-enumerable property rejected: ${prop}` };
      }
      if (typeof desc.value === "function") {
        return { ok: false, error: `method/function rejected: ${prop}` };
      }
      const childRes = walk(desc.value, path ? `${path}.${prop}` : prop);
      if (!childRes.ok) return childRes;
    }

    return { ok: true };
  }

  return walk(root);
}

/**
 * Ensure an exported card's serialized JSON string (formatted with 2 spaces) is within MAX_CARD_JSON_BYTES,
 * reducing asset content progressively if JSON escaping expands the payload over budget.
 */
function enforceCardJsonBudget(card, maxBytes = MAX_CARD_JSON_BYTES) {
  const encoder = new TextEncoder();
  let jsonBytes = encoder.encode(JSON.stringify(card, null, 2)).byteLength;
  if (jsonBytes <= maxBytes) return card;

  if (Array.isArray(card.coreAssets) && card.coreAssets.length > 0) {
    while (jsonBytes > maxBytes) {
      const excess = jsonBytes - maxBytes;
      let reducedAny = false;

      let largestIdx = -1;
      let maxLen = 0;
      for (let i = 0; i < card.coreAssets.length; i++) {
        const contentBytes = encoder.encode(card.coreAssets[i].content).byteLength;
        if (contentBytes > maxLen) {
          maxLen = contentBytes;
          largestIdx = i;
        }
      }

      if (largestIdx === -1 || maxLen <= 3) {
        if (card.coreAssets.length > 0) {
          card.coreAssets.pop();
          reducedAny = true;
        } else {
          break;
        }
      } else {
        const reductionTarget = Math.max(1024, Math.min(maxLen - 3, Math.ceil(excess / 2) + 32));
        const newMaxBytes = Math.max(0, maxLen - reductionTarget);
        card.coreAssets[largestIdx].content = truncateToUtf8Bytes(
          card.coreAssets[largestIdx].content,
          newMaxBytes,
        );
        reducedAny = true;
      }

      jsonBytes = encoder.encode(JSON.stringify(card, null, 2)).byteLength;
      if (!reducedAny) break;
    }
  }

  return card;
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

  return enforceCardJsonBudget(card);
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

    // Require plain data object — reject prototype inheritance, accessors, toJSON
    const plainCheck = assertPlainDataGraph(card);
    if (!plainCheck.ok) {
      return plainCheck;
    }

    // Strict version validation: required OWN property, numeric safe integer == AGENT_CARD_VERSION
    if (!Object.hasOwn(card, "version") || card.version === undefined || card.version === null) {
      return { ok: false, error: "agent card requires an own version property" };
    }
    if (typeof card.version !== "number" || !Number.isSafeInteger(card.version)) {
      return { ok: false, error: "card version must be an integer" };
    }
    if (card.version !== AGENT_CARD_VERSION) {
      return { ok: false, error: `unsupported agent card version (${card.version})` };
    }
    const version = card.version;

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
    const seenValid = new Set();
    const seenDropped = new Set();
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
          if (!seenValid.has(skillId)) {
            seenValid.add(skillId);
            if (validSkills.length < MAX_CARD_SKILLS) {
              validSkills.push(skillId);
            } else {
              omittedValidSkillsCount++;
            }
          }
        } else {
          if (!seenDropped.has(skillId)) {
            seenDropped.add(skillId);
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
 * Fails closed on hostile input, malformed JSON, prototype inheritance, accessors, or oversized payloads.
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
      // Deep descriptor validation on the complete object graph BEFORE serialization
      const plainCheck = assertPlainDataGraph(cardInput);
      if (!plainCheck.ok) {
        return plainCheck;
      }
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
          error: `card object cannot be serialized: ${e?.message ?? String(e)}`,
        };
      }
    }

    return validateAgentCard(cardObj, options);
  } catch (e) {
    return { ok: false, error: `import failed: ${e?.message ?? String(e)}` };
  }
}

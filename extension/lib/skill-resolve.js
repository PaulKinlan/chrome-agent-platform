// lib/skill-resolve.js — THE real skill-reference resolver (CAP-FB-20260831-
// SKILL-LIST-SYNC-01 r4). Extracted from the service worker's resolveRecipe so
// tests exercise the ACTUAL resolution logic against real (faked-OPFS) stores,
// not a parallel helper.
//
// Source-locking contract (r3): a source-qualified reference resolves ONLY in
// its own store —
//   - custom:<id>  → the custom store only (absent ⇒ null, never built-in/imported)
//   - imported:<id> → the imported store only
//   - builtin:<id> → the built-in table only
//   - raw id       → historical order built-in → custom → imported (saved
//                    agents, old task text, background-agent.set resolving a
//                    duplicated background agent by its raw id)
//
// No chrome.*, no DOM — pure store reads with injected dependencies.

import { parseSkillRef, skillResolutionOrder } from "./recipes.js";

const DEFAULT_BODY_BUDGET = 8 * 1024; // PROMPT_SKILL_BODY_BUDGET (small bodies compose)

/**
 * Resolve one skill reference to its record.
 *
 * @param {object} opts
 * @param {string} opts.ref            the raw or source-qualified reference
 * @param {object} opts.stores         injected stores:
 *   getRecipe(id)                       → built-in recipe record | undefined
 *   getCustomRecipes(): Promise<[...]>  → custom-recipe records
 *   loadAllImported(): Promise<[...]>   → imported-skill records (index rows;
 *                                         bodies live in the OPFS file store)
 *   readSkillFile(id, path): Promise<text>
 * @param {number=} opts.bodyBudget    small-body compose budget (default 8192)
 * @returns {Promise<object|null>} the resolved record (with source-qualified
 *   `refId` stamped) or null when the reference resolves to nothing.
 */
export async function resolveSkillRef({ ref, stores, bodyBudget = DEFAULT_BODY_BUDGET }) {
  const raw = String(ref ?? "").trim();
  if (!raw) return null;
  const { source, id: rawId } = parseSkillRef(raw);
  const refId = source === "raw" ? null : `${source}:${rawId}`;
  const order = skillResolutionOrder(source);
  if (order.includes("builtin")) {
    const builtIn = stores.getRecipe(rawId);
    if (builtIn) return { ...builtIn, refId: refId ?? `builtin:${rawId}` };
  }
  if (order.includes("custom")) {
    const custom = await stores.getCustomRecipes().catch(() => []);
    const fromCustom = (Array.isArray(custom) ? custom : []).find((r) => r.id === rawId);
    if (fromCustom) return { ...fromCustom, refId: refId ?? `custom:${rawId}` };
  }
  if (order.includes("imported")) {
    const imported = await stores.loadAllImported().catch(() => []);
    const row = (Array.isArray(imported) ? imported : []).find((s) => s.id === rawId);
    if (!row) return null;
    // Index rows carry metadata only (bodies live in OPFS). A SMALL body is
    // read back and composed into the system prompt like before; a LARGE body
    // stays out of the prompt (the skill_read marker rule handles it —
    // renderBoundarySkills keys on promptBytes, never an empty body). A legacy
    // row whose migration failed keeps its inline body (never lost).
    const base = { ...row, refId: refId ?? `imported:${rawId}` };
    if (Number.isInteger(row.promptBytes) && row.promptBytes > 0 && row.promptBytes <= bodyBudget) {
      try {
        return { ...base, prompt: await stores.readSkillFile(row.id, "SKILL.md") };
      } catch {
        return { ...base, prompt: "" };
      }
    }
    if (!Number.isInteger(row.promptBytes)) {
      // legacy inline body (migration failed) — serve it so it never vanishes
      return { ...base };
    }
    return { ...base, prompt: "" };
  }
  return null;
}

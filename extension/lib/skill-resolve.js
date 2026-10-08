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

import { parseSkillRef, skillResolutionOrder } from "./skill-registry.js";

const DEFAULT_BODY_BUDGET = 8 * 1024; // PROMPT_SKILL_BODY_BUDGET (small bodies compose)

/**
 * Reduce an arbitrary rejection reason to a human-readable "<message> (<code>)"
 * string. Names the cause without assuming it is an Error (OPFS throws
 * DOMException, stores may reject with strings or plain objects).
 */
function describeCause(cause) {
  if (cause == null) return "unknown error";
  if (typeof cause === "string") return cause;
  const message = typeof cause?.message === "string" ? cause.message : String(cause);
  const code = cause?.code ?? cause?.name ?? "";
  if (code && code !== "Error") return `${message} (${code})`;
  return message;
}

/**
 * Build a fail-loud error for a skill-store READ failure (chrome-agent-platform-
 * 5xo59). Names BOTH the store and the underlying cause so a fatal store fault is
 * diagnosable instead of a bare "failed to load skills". A genuinely absent
 * optional skill is NOT a read failure — the stores below only throw here when
 * the store REJECTS (corrupt DB, permission, quota); a store that RESOLVES to an
 * empty array (no such skill) keeps the normal empty-result path untouched.
 */
function storeReadError(store, cause) {
  const err = new Error(`Failed to read ${store}: ${describeCause(cause)}`);
  err.store = store;
  err.cause = cause;
  return err;
}

/**
 * Wrap a skill stores collection so that getCustomSkills() and loadAllImported()
 * are only invoked once per batch resolution (chrome-agent-platform-3m3sn).
 * Read failures PROPAGATE (not swallowed to []) so resolveSkillRef can name the
 * store and cause; memoization caches the rejection, which keeps a fatal store
 * fault loud across the whole batch rather than silent per reference.
 *
 * @param {object} baseStores
 * @returns {object}
 */
export function createMemoizedSkillStores(baseStores) {
  if (!baseStores || typeof baseStores !== "object") return baseStores;
  let importedPromise = null;
  let customPromise = null;
  return {
    ...baseStores,
    getCustomSkills: () => {
      if (!customPromise) {
        customPromise = Promise.resolve(
          typeof baseStores.getCustomSkills === "function" ? baseStores.getCustomSkills() : []
        );
      }
      return customPromise;
    },
    loadAllImported: () => {
      if (!importedPromise) {
        importedPromise = Promise.resolve(
          typeof baseStores.loadAllImported === "function" ? baseStores.loadAllImported() : []
        );
      }
      return importedPromise;
    },
  };
}

/**
 * Resolve one skill reference to its record.
 *
 * @param {object} opts
 * @param {string} opts.ref            the raw or source-qualified reference
 * @param {object} opts.stores         injected stores:
 *   getSkill(id)                        → built-in skill record | undefined
 *   getCustomSkills(): Promise<[...]>   → custom skill records
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
    const builtIn = stores.getSkill(rawId);
    if (builtIn) return { ...builtIn, refId: refId ?? `builtin:${rawId}` };
  }
  if (order.includes("custom")) {
    const custom = await stores.getCustomSkills().catch((cause) => {
      throw storeReadError("custom skills store", cause);
    });
    const fromCustom = (Array.isArray(custom) ? custom : []).find((r) => r.id === rawId);
    if (fromCustom) return { ...fromCustom, refId: refId ?? `custom:${rawId}` };
  }
  if (order.includes("imported")) {
    const imported = await stores.loadAllImported().catch((cause) => {
      throw storeReadError("imported skills store", cause);
    });
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
      } catch (cause) {
        throw storeReadError(`imported skill file "${row.id}/SKILL.md"`, cause);
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

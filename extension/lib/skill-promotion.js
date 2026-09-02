// lib/skill-promotion.js — the skill PROMOTION layer
// (chrome-agent-platform-ve67).
//
// An agent with NO relevant skills attached is told which catalog skills match
// the CURRENT task: a bounded, deterministic relevance heuristic selects the
// top-N by keyword overlap between the task text and each skill's
// name/description (bodies are never loaded for promotion — a big body stays
// an on-demand skill_read, exactly like the progressive-disclosure rule).
//
// The section teaches the adoption path:
//   - adopt with /skill:<refId> in the next message (composes the body for
//     the run, or a skill_read marker for a large imported body), or
//   - read an IMPORTED skill on demand via skill_read(skill:"<id>") WITHOUT
//     adopting — advertised ONLY for imported rows, whose bodies live in the
//     OPFS store under the RAW id (the imported-only tool resolves that id,
//     never the source-qualified `imported:` ref, chrome-agent-platform-ve67 r2).
//
// Trust contract (r2 P1): an imported row's NAME/DESCRIPTION come from remote
// frontmatter — untrusted data — so they are rendered inside the run's
// untrusted boundary (lib/untrusted-fence.js), exactly like every other remote
// content. The adoption guidance and the heading are platform-authored and
// stay OUTSIDE the fence. Built-in (owner-authored) rows stay unfenced per the
// established trust model.
//
// Pure + deterministic: no chrome.*, no DOM, no Math.random — Deno-testable.
// Bounded: at most `topN` skills and `budget` characters of rendered text, so
// a task that mentions many skill names can never blow the prompt budget. The
// budget trims are fence-safe: a row's untrusted content is shortened INSIDE
// an intact boundary — an unbalanced fence would swallow the trailing
// protected policy as "data" (the exact escalation fencing exists to stop).

import {
  UNTRUSTED_TOKEN_PLACEHOLDER,
  isUntrustedToken,
  untrustedOpen,
  untrustedClose,
  fenceUntrustedText,
} from "./untrusted-fence.js";

export const PROMOTION_BUDGET = 600; // max rendered characters
export const PROMOTION_TOP_N = 4; // max promoted skills

// The 24-item cap on JOURNALED skill ids (the terminal thread row stays small
// across resume). The promotion EXCLUSION set is NOT capped by this — an agent
// may attach up to 128 skills (agent-cards.js MAX_CARD_SKILLS) and an attached
// skill's body already composes, so it must never be re-promoted
// (chrome-agent-platform-ve67 r2 P1).
export const JOURNALED_SKILLS_CAP = 24;

/** Every attached run-skill ref (raw id or source-qualified refId) — the FULL
 * promotion-exclusion derivation the service worker must use. A runSkills row
 * is a resolved record carrying `refId` when source-qualified; `promoteSkills`
 * matches exclusion against BOTH refId and raw id, so either form works. */
export function attachedSkillRefs(runSkills) {
  return (Array.isArray(runSkills) ? runSkills : [])
    .map((r) => r?.refId ?? r?.id)
    .filter((x) => typeof x === "string" && x);
}

const STOPWORDS = new Set([
  "the", "and", "for", "you", "your", "with", "this", "that", "from", "into", "what", "when", "how", "are", "can", "will", "please", "help", "about", "using", "want", "need", "would", "could", "should", "they", "them", "their", "there", "here", "have", "has", "been", "were", "was", "but", "not", "our", "out", "all", "any", "each", "its", "just", "more", "one", "than", "then", "these", "those", "through", "until", "upon", "very", "well"
]);

/** Split text into lower-cased, de-pluralized keyword tokens (bounded). */
export function skillKeywords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((w) => w.length >= 3 && w.length <= 24)
    .filter((w) => !STOPWORDS.has(w))
    .map((w) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("s") ? w.slice(0, -1) : w))
    .slice(0, 64);
}

/**
 * Deterministic relevance: count how many task keyword tokens appear in the
 * skill's name/description (both token sets). Ties break on name, then id —
 * never on insertion order of the catalog.
 */
export function relevanceScore(task, skill) {
  const taskTokens = skillKeywords(task);
  if (!taskTokens.length) return 0;
  const hayTokens = new Set(skillKeywords(`${skill?.name ?? ""} ${skill?.description ?? ""}`));
  let hits = 0;
  for (const t of taskTokens) if (hayTokens.has(t)) hits += 1;
  return hits;
}

/** Stable comparator: score desc, then name, then refId/id. */
export function compareRelevance(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const na = String(a.skill?.name ?? "").toLowerCase();
  const nb = String(b.skill?.name ?? "").toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  const ia = String(a.skill?.refId ?? a.skill?.id ?? "");
  const ib = String(b.skill?.refId ?? b.skill?.id ?? "");
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Is a catalog row an IMPORTED (remote, untrusted) skill? skillCatalog rows
 * carry `source: "imported"`; synthetic/test rows carry a source-qualified
 * `imported:` refId. Everything else is owner-authored/trusted. */
function isImportedSkill(skill) {
  if (!skill || typeof skill !== "object") return false;
  if (skill?.source === "imported") return true;
  return String(skill?.refId ?? skill?.id ?? "").startsWith("imported:");
}

/** Shorten untrusted inner text (never splitting a UTF-16 surrogate pair — a
 * lone surrogate would decode to U+FFFD) and mark the cut with an ellipsis. */
function fitInner(inner, maxChars) {
  if (maxChars <= 0) return "";
  if (inner.length <= maxChars) return inner;
  let cut = inner.slice(0, maxChars - 1);
  if (cut.length && cut.charCodeAt(cut.length - 1) >= 0xd800 && cut.charCodeAt(cut.length - 1) <= 0xdfff) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** Render ONE promotion row. An imported row's name/description (remote
 * frontmatter) are fenced with the run token; the adoption guidance is
 * platform-authored and stays OUTSIDE the fence. The untrusted inner text is
 * pre-fit so the row ALONE (heading + row + instructions) never exceeds the
 * budget — budget trims therefore never slice a fence open. */
function promotionRow(skill, token, budget, headingLen, instrLen) {
  const refId = String(skill?.refId ?? skill?.id ?? "unknown");
  const rawId = String(skill?.id ?? refId);
  const name = String(skill?.name ?? refId);
  const desc = String(skill?.description ?? "").trim();
  const imported = isImportedSkill(skill);
  const guidance = imported
    ? `adopt with /skill:${refId} or read it now via skill_read(skill:"${rawId}")`
    : `adopt with /skill:${refId}`;
  if (imported) {
    const open = untrustedOpen(token);
    const close = untrustedClose(token);
    // row = open + "\n" + inner + "\n" + close + "\n- " + guidance, and the
    // section = heading + "\n" + row + "\n" + instructions.
    const innerMax = budget - headingLen - instrLen - 2 - open.length - close.length - guidance.length - 5;
    const inner = fitInner(`${name} — ${desc}`, innerMax);
    return { text: `${open}\n${inner}\n${close}\n- ${guidance}`, imported: true };
  }
  // row = "- " + inner + " (" + guidance + ")"
  const innerMax = budget - headingLen - instrLen - 2 - guidance.length - 5;
  const inner = fitInner(`${name} — ${desc}`, innerMax);
  return { text: `- ${inner} (${guidance})`, imported: false };
}

/**
 * Build the promotion section for one task.
 *
 * @param {object} opts
 * @param {string} opts.task        the task text
 * @param {object[]} opts.catalog   skillCatalog rows ({name, description, id, refId, source})
 * @param {Set<string>|string[]} [opts.adoptedIds] refIds/ids already attached —
 *   never promoted (their bodies already compose). Derive from ALL runSkills
 *   (attachedSkillRefs), never from the journaled 24-cap (r2 P1).
 * @param {string} [opts.untrustedToken] the run's untrusted boundary token —
 *   imported rows' metadata is fenced with it (absent → the preview
 *   placeholder, matching renderBoundarySkills).
 * @param {number} [opts.budget=600]    max rendered characters
 * @param {number} [opts.topN=4]        max promoted skills
 * @returns {string|null} the promotion section text, or null when there is
 *   nothing to promote (no catalog, no relevant skill, or all relevant are
 *   already adopted).
 */
export function promoteSkills({ task, catalog, adoptedIds = new Set(), untrustedToken = null, budget = PROMOTION_BUDGET, topN = PROMOTION_TOP_N }) {
  const token = isUntrustedToken(untrustedToken) ? untrustedToken : UNTRUSTED_TOKEN_PLACEHOLDER;
  const adopted = new Set(Array.isArray(adoptedIds) ? adoptedIds : (adoptedIds ?? new Set()));
  const candidates = (Array.isArray(catalog) ? catalog : [])
    .filter((s) => s && typeof s === "object")
    .filter((s) => !adopted.has(s?.refId) && !adopted.has(s?.id))
    .map((skill) => ({ skill, score: relevanceScore(task, skill) }))
    .filter((c) => c.score > 0);
  if (!candidates.length) return null;

  candidates.sort(compareRelevance);
  const top = candidates.slice(0, Math.max(1, Math.min(topN, candidates.length)));
  const heading = "## Skills you can adopt for this task";
  // The skill_read read path is IMPORTED-only: promise it only when a promoted
  // row is imported (recomputed after budget trims so a popped imported row
  // can never leave a promise behind).
  let instructions = top.some(({ skill }) => isImportedSkill(skill))
    ? 'Adopt one by writing /skill:<id> in your next message (its full body composes for this run), or read an imported skill on demand via skill_read(skill:"<id>") without adopting.'
    : "Adopt one by writing /skill:<id> in your next message (its full body composes for this run).";
  const rows = top.map(({ skill }) => promotionRow(skill, token, budget, heading.length, instructions.length));
  let text = `${heading}\n${rows.map((r) => r.text).join("\n")}\n${instructions}`;

  // Bounded: trim the ROW LIST (never the heading or the instructions) until
  // the whole section fits the budget. Each row is pre-fit to fit alone, so a
  // single remaining row always fits — no raw text slicing, no fence ever cut.
  while (text.length > budget && rows.length > 1) {
    rows.pop();
    text = `${heading}\n${rows.map((r) => r.text).join("\n")}\n${instructions}`;
  }
  if (!rows.some((r) => r.imported) && instructions.includes("skill_read")) {
    // All imported rows were trimmed away — drop the imported-only read hint so
    // the section never promises a read path nothing left can serve.
    instructions = "Adopt one by writing /skill:<id> in your next message (its full body composes for this run).";
    text = `${heading}\n${rows.map((r) => r.text).join("\n")}\n${instructions}`;
  }
  return text;
}

/** Convenience: does a task mention anything the catalog can satisfy? */
export function hasPromotableSkills(task, catalog, adoptedIds = new Set()) {
  return promoteSkills({ task, catalog, adoptedIds }) !== null;
}

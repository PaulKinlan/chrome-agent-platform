// lib/skill-promotion.js — the skill PROMOTION layer
// (chrome-agent-platform-ve67).
//
// An agent with NO relevant skills attached is told which catalog skills match
// the CURRENT task: a bounded, deterministic relevance heuristic selects the
// top-N by keyword overlap between the task text and each skill's
// name/description (bodies are never loaded for promotion — a big body stays
// an on-demand skill_read, exactly like the progressive-disclosure rule).
//
// The section teaches the two adoption paths:
//   - adopt with /skill:<refId> in the next message (composes the body for
//     the run, or a skill_read marker for a large imported body), or
//   - read it on demand via skill_read WITHOUT adopting (works for any
//     catalog skill today — verified in the eval harness).
//
// Pure + deterministic: no chrome.*, no DOM, no Math.random — Deno-testable.
// Bounded: at most `topN` skills and `budget` characters of rendered text, so
// a task that mentions many skill names can never blow the prompt budget.

export const PROMOTION_BUDGET = 600; // max rendered characters
export const PROMOTION_TOP_N = 4; // max promoted skills

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

/**
 * Build the promotion section for one task.
 *
 * @param {object} opts
 * @param {string} opts.task        the task text
 * @param {object[]} opts.catalog   skillCatalog rows ({name, description, id, refId})
 * @param {Set<string>|string[]} [opts.adoptedIds] refIds/ids already attached —
 *   never promoted (their bodies already compose).
 * @param {number} [opts.budget=600]    max rendered characters
 * @param {number} [opts.topN=4]        max promoted skills
 * @returns {string|null} the promotion section text, or null when there is
 *   nothing to promote (no catalog, no relevant skill, or all relevant are
 *   already adopted).
 */
export function promoteSkills({ task, catalog, adoptedIds = new Set(), budget = PROMOTION_BUDGET, topN = PROMOTION_TOP_N }) {
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
  const rows = top.map(({ skill }) => {
    const refId = String(skill?.refId ?? skill?.id ?? "unknown");
    const name = String(skill?.name ?? refId);
    const desc = String(skill?.description ?? "").trim();
    return `- ${name} — ${desc} (adopt with /skill:${refId} or read via skill_read)`;
  });
  const instructions =
    "Adopt one by writing /skill:<id> in your next message (its full body composes for this run), or read it on demand with skill_read without adopting.";
  let text = `${heading}\n${rows.join("\n")}\n${instructions}`;

  // Bounded: trim the ROW LIST (never the heading or the instructions) until
  // the whole section fits the budget. A single over-long row is truncated.
  while (text.length > budget && rows.length > 1) {
    rows.pop();
    text = `${heading}\n${rows.join("\n")}\n${instructions}`;
  }
  if (text.length > budget) {
    const room = Math.max(40, budget - (heading.length + instructions.length + 4));
    text = `${heading}\n${rows[0].slice(0, room)}…\n${instructions}`;
  }
  return text;
}

/** Convenience: does a task mention anything the catalog can satisfy? */
export function hasPromotableSkills(task, catalog, adoptedIds = new Set()) {
  return promoteSkills({ task, catalog, adoptedIds }) !== null;
}

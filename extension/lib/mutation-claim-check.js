// lib/mutation-claim-check.js — runtime honesty for mutation CLAIMS.
//
// The prompt clause (master-skill.js "Honesty about actions") is an
// instruction a non-compliant model can ignore: it can write "I've created
// the agent" without any tool call and the owner is misled (the reported
// failure). This module is the RUNTIME backstop: after a turn completes, its
// final text is checked against the set of mutating tools that ACTUALLY
// succeeded during the turn. A claim with no matching successful call gets a
// visible correction appended to the reply — the owner always sees the truth.
//
// Pure (no DOM, no imports) so the SW, the worker, and the Deno tests all
// share the one implementation.

/** Claim kinds → the mutating tools whose SUCCESS backs them. */
const CLAIMS = [
  {
    kind: "create",
    tools: new Set(["create_named_agent", "create_agent"]),
    // "I created/added/set up/made (a|the|your) (new) <optional name> agent" / "agent created"
    re: /\b(?:i(?:'ve|’ve| have)?\s+(?:just\s+)?)?(?:created|added|set up|made)\s+(?:a\s+|an\s+|the\s+|your\s+)?(?:new\s+)?(?:[\w'’.-]+\s+){0,4}agent\b|\bagent\s+(?:has been|is now|was)\s+created\b/i,
    claim: "created an agent",
  },
  {
    kind: "update",
    tools: new Set(["update_named_agent", "named_agent_set_schedule", "set-schedule"]),
    re: /\b(?:i(?:'ve|’ve| have)?\s+(?:just\s+)?)?(?:updated|changed|modified|renamed|edited)\s+(?:the\s+|your\s+)?agent\b|\bagent\s+(?:has been|is now|was)\s+(?:updated|changed|modified|renamed)\b/i,
    claim: "updated the agent",
  },
  {
    kind: "delete",
    tools: new Set(["delete_named_agent"]),
    re: /\b(?:i(?:'ve|’ve| have)?\s+(?:just\s+)?)?(?:deleted|removed)\s+(?:the\s+|your\s+)?agent\b|\bagent\s+(?:has been|is now|was)\s+(?:deleted|removed)\b/i,
    claim: "deleted the agent",
  },
  {
    kind: "schedule",
    tools: new Set(["schedule_task", "named_agent_set_schedule", "set-schedule"]),
    re: /\b(?:i(?:'ve|’ve| have)?\s+(?:just\s+)?)?scheduled\s+(?:the\s+|your\s+|a\s+)?(?:agent|task)\b|\b(?:agent|task)\s+(?:has been|is now|was)\s+scheduled\b/i,
    claim: "scheduled it",
  },
];

/**
 * Check a turn's final text for mutation claims not backed by a successful
 * matching tool call.
 *
 * @param {string} text — the turn's final reply text.
 * @param {Iterable<string>} successfulTools — REAL tool names (post lazy-
 *   envelope unwrap) that returned success during the turn.
 * @returns {{ text: string, corrections: string[] }} — the (possibly)
 *   corrected text + the list of corrections appended (empty when every claim
 *   is backed, or there are no claims).
 */
/**
 * Whether a matched claim phrase is a genuine SELF-CLAIM by the assistant.
 * The claim regexes deliberately match broad shapes; the prefix before the
 * match decides whether the assistant is reporting ITS OWN action:
 * - a negation immediately governing the verb ("I haven't created…",
 *   "I did not delete…") is a NON-claim;
 * - a first-person marker anywhere earlier in the sentence ("I…", including
 *   a coordinated clause — "I created X and then deleted the agent") is a
 *   self-claim;
 * - an empty / function-word-only prefix ("Created the agent.", "Done —
 *   created it") is a terse action report — a self-claim;
 * - any OTHER subject ("OpenAI created an agent", "The system updated the
 *   agent") is third-party discussion — NOT a claim about this turn.
 * Passive agent-subject matches ("The Research Analyst agent was deleted")
 * already name the agent as the subject, so only the negation check applies
 * (the name words before "agent" must not read as a third-party subject).
 */
const NEGATION_TAIL = /(?:haven['’]?t|hasn['’]?t|hadn['’]?t|didn['’]?t|don['’]?t|won['’]?t|wouldn['’]?t|couldn['’]?t|can['’]?t|cannot|not|never)(?:\s+[\w'’-]+){0,3}\s*$/i;
const FIRST_PERSON = /\bi\b/i;
const FUNCTION_WORDS_ONLY = /^[\s,;—–-]*(?:(?:and|then|also|next|finally|so|just|now|the|a|an|your|my)\b[\s,;—–-]*)*$/i;

function genuineSelfClaim(text, matchIndex, matchedText) {
  // The sentence prefix: from the last sentence boundary before the match.
  const before = text.slice(0, matchIndex);
  const boundary = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"));
  const prefix = before.slice(boundary + 1);
  if (NEGATION_TAIL.test(prefix)) return false;
  // The match may itself OPEN with the first-person marker (the claim regexes'
  // optional leading "I…" group) — then the prefix excludes it.
  if (/^\s*i\b/i.test(matchedText)) return true;
  // Passive agent-subject shapes carry the agent as their own subject.
  if (/^\s*(?:the\s+|your\s+)?(?:agent|task)\b/i.test(matchedText)) return true;
  if (FIRST_PERSON.test(prefix)) return true;
  return FUNCTION_WORDS_ONLY.test(prefix);
}

export function correctUnsupportedMutationClaims(text, successfulTools) {
  const s = typeof text === "string" ? text : "";
  if (!s) return { text: s, corrections: [] };
  const ok = new Set(successfulTools ?? []);
  const corrections = [];
  for (const c of CLAIMS) {
    const flags = c.re.flags.includes("g") ? c.re.flags : c.re.flags + "g";
    const re = new RegExp(c.re.source, flags);
    let claimed = false;
    for (const m of s.matchAll(re)) {
      if (genuineSelfClaim(s, m.index ?? 0, m[0])) { claimed = true; break; }
    }
    if (!claimed) continue;
    let backed = false;
    for (const t of c.tools) { if (ok.has(t)) { backed = true; break; } }
    if (!backed) {
      corrections.push(
        `⚠️ Correction: I claimed I ${c.claim}, but no successful tool call did that in this turn — no such change was made.`
      );
    }
  }
  if (corrections.length === 0) return { text: s, corrections };
  return { text: `${s}\n\n${corrections.join("\n")}`, corrections };
}

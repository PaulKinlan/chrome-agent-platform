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
export function correctUnsupportedMutationClaims(text, successfulTools) {
  const s = typeof text === "string" ? text : "";
  if (!s) return { text: s, corrections: [] };
  const ok = new Set(successfulTools ?? []);
  const corrections = [];
  for (const c of CLAIMS) {
    if (!c.re.test(s)) continue;
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

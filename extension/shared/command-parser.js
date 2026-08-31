// shared/command-parser.js — the STRICT slash-command + @-mention tokenizers
// for <agent-composer>. Pure + DOM-free so it is unit-testable in Deno (no
// DOM), like agent-registry.js.
//
// COMMAND POSITION (CAP-FB-20260831-MULTI-SLASH-COMMANDS-01, owner
// directive: multiple /commands must be usable in ONE input):
//   (a) a "/" at the very start of the input is a command (original rule);
//   (b) a "/" typed IMMEDIATELY AFTER a RESOLVED COMMAND REFERENCE the
//       composer inserted earlier (optionally after a single space following
//       it) is a command too — so after "/skill:x" resolves to its reference,
//       typing " /tabs:y" opens the tabs picker. The composer tracks the
//       resolved-reference boundaries and passes them as `resolvedEnds`;
//       "please inspect /agent:pr" (no resolved boundary before the slash)
//       stays ordinary prose — the free-text guard is fully preserved.
// A slash-command token also ends at the first whitespace, so
// "/agent:reader summarise this" stops parsing at the space (the rest is task
// text, where an @mention can still open the mention UI).

/**
 * Parse a / command token in command position.
 * @param {string} text  the full composer text
 * @param {number} caret the caret position (selectionStart)
 * @param {Set<number> | null} resolvedEnds  the set of character indices that
 *   are the END of a resolved command reference in `text` (the composer
 *   records these when it inserts a picked reference). A slash that begins a
 *   fresh token after whitespace is a command ONLY when the token before that
 *   whitespace ends exactly at one of these indices.
 * @returns {null | { start: number, end: number, ns: string, arg: string, hasColon: boolean }}
 *   null unless the text up to the caret is exactly `/ns` or `/ns:arg`
 *   (whitespace-free) at command position. `start` is the slash's index;
 *   `end` is the caret.
 */
export function parseSlashCommand(text, caret, resolvedEnds = null) {
  const t = String(text ?? "");
  const c = Math.max(
    0,
    Math.min(typeof caret === "number" && Number.isFinite(caret) ? caret : t.length, t.length),
  );
  const before = t.slice(0, c);
  // The slash token at the caret: `[a-z]*` namespace, optional `:arg`. The
  // token must be whitespace-free, end at the caret, and the arg must not
  // contain a further slash (so "/skill:x/tabs:y" resolves the token AT the
  // caret — "/tabs:y" — not the earlier "/skill:x" as one giant arg).
  const m = before.match(/(\/)([a-z]*)(?::([^/ ]*))?$/i);
  if (!m) return null;
  const slashIndex = (m.index ?? 0);
  if (slashIndex === 0) {
    // First character of the input → a command (the original strict rule;
    // resolved boundaries are irrelevant here).
    return {
      start: 0,
      end: c,
      ns: (m[2] || "").toLowerCase(),
      arg: m[3] ?? "",
      hasColon: m[3] !== undefined,
    };
  }
  // Post-boundary command position: the slash must sit at a RESOLVED COMMAND
  // REFERENCE boundary with AT MOST ONE literal space after that boundary —
  // exactly "boundary + optional single space + slash token". Zero spaces:
  // the slash directly abuts the reference (its end == slashIndex). One
  // space: the char before the slash is a literal space AND the boundary is
  // directly before it (slashIndex - 1). Two spaces, a tab/newline, or any
  // other preceding text (mid-prose, URLs, mid-word slashes) is NOT a command
  // position — the free-text guard is preserved.
  const charBefore = before[slashIndex - 1];
  if (charBefore === " ") {
    if (!resolvedEnds || !resolvedEnds.has(slashIndex - 1)) return null;
  } else {
    // Zero spaces — the reference's end must be exactly where the slash is.
    if (!resolvedEnds || !resolvedEnds.has(slashIndex)) return null;
  }
  return {
    start: slashIndex,
    end: c,
    ns: (m[2] || "").toLowerCase(),
    arg: m[3] ?? "",
    hasColon: m[3] !== undefined,
  };
}

/**
 * Parse an @ mention token at the caret. Mentions are legal ANYWHERE a fresh
 * whitespace-delimited token begins (unlike the / command) — a task targeted
 * at an agent can still mention others inline.
 * @returns {null | { start: number, end: number, query: string }}
 */
export function parseMentionToken(text, caret) {
  const t = String(text ?? "");
  const c = Math.max(
    0,
    Math.min(typeof caret === "number" && Number.isFinite(caret) ? caret : t.length, t.length),
  );
  const before = t.slice(0, c);
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  const start = before[m.index] === "@" ? m.index : m.index + 1;
  return { start, end: c, query: m[1] || "" };
}

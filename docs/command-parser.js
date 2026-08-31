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
  // The slash must be at index 0 (start of input) OR begin a fresh token after
  // whitespace that IMMEDIATELY follows a resolved command reference (group 1
  // = the whitespace run, group 2 = the slash, group 3 = the ns, group 4 = arg).
  const m = before.match(/(?:^|(\s+))(\/)([a-z]*)(?::(\S*))?$/i);
  if (!m) return null;
  const ws = m[1] ?? "";
  const slashIndex = (m.index ?? 0) + ws.length;
  if (ws) {
    // The position right before the whitespace run is where the previous token
    // ended (`m.index`). That must be a RESOLVED COMMAND REFERENCE boundary —
    // arbitrary prose (or a leading-space token, where `m.index` is 0) never
    // qualifies, so the free-text guard is preserved.
    const refEnd = m.index ?? 0;
    if (refEnd <= 0 || !resolvedEnds || !resolvedEnds.has(refEnd)) return null;
  }
  const ns = (m[3] || "").toLowerCase();
  return {
    start: slashIndex,
    end: c,
    ns,
    arg: m[4] ?? "",
    hasColon: m[4] !== undefined,
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

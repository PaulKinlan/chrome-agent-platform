// shared/command-parser.js — the STRICT slash-command + @-mention tokenizers
// for <agent-composer>. Pure + DOM-free so it is unit-testable in Deno (no
// DOM), like agent-registry.js.
//
// THE STRICT COMMAND-POSITION RULE (the round-2 review's free-text false
// positive): a "/" command is ONLY a command at the very start of the input.
// "please inspect /agent:pr", "https://example.com/agent:foo", and even a
// leading-space " /agent:x" are ORDINARY TEXT — they must never open the
// command UI. The command token also ends at the first whitespace, so
// "/agent:reader summarise this" stops parsing at the space (the rest is the
// task text, where an @mention can still open the mention UI).

/**
 * Parse a / command token in STRICT command position.
 * @param {string} text  the full composer text
 * @param {number} caret the caret position (selectionStart)
 * @returns {null | { start: number, end: number, ns: string, arg: string, hasColon: boolean }}
 *   null unless the text up to the caret is exactly `/ns` or `/ns:arg`
 *   (whitespace-free, "/" at index 0). `start` is always 0; `end` is the caret.
 */
export function parseSlashCommand(text, caret) {
  const t = String(text ?? "");
  const c = Math.max(
    0,
    Math.min(typeof caret === "number" && Number.isFinite(caret) ? caret : t.length, t.length),
  );
  const before = t.slice(0, c);
  const m = before.match(/^\/([a-z]*)(?::(\S*))?$/i);
  if (!m) return null;
  return {
    start: 0,
    end: c,
    ns: (m[1] || "").toLowerCase(),
    arg: m[2] ?? "",
    hasColon: m[2] !== undefined,
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

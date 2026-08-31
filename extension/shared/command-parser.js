// shared/command-parser.js — the STRICT slash-command + @-mention tokenizers
// for <agent-composer>. Pure + DOM-free so it is unit-testable in Deno (no
// DOM), like agent-registry.js.
//
// COMMAND POSITION (CAP-FB-20260831-MULTI-SLASH-COMMANDS-01, owner
// directive: multiple /commands must be usable in ONE input):
//   (a) a "/" at the very start of the input is a command (original rule);
//   (b) a "/" that begins a NEW whitespace-delimited token AFTER real text is
//       a command too — so "/skill:x /tabs:y" opens the tabs picker after the
//       skill reference. The token before the whitespace must be NON-EMPTY
//       (a leading-space " /agent" stays ordinary text).
//   (c) post-whitespace commands only open the UI when the namespace is a
//       KNOWN command namespace (caller passes `knownNamespaces`); an
//       invented/unknown ns after whitespace stays text.
// The free-text guard is preserved for: URLs ("https://x/agent:y" — the slash
// is mid-word, not after whitespace), mid-word slashes ("inspect/agent:pr"),
// leading-space tokens (" /agent:x"), and unknown namespaces. A slash-command
// token also ends at the first whitespace, so "/agent:reader summarise this"
// stops parsing at the space (the rest is task text, where an @mention can
// still open the mention UI).

/**
 * Parse a / command token in command position.
 * @param {string} text  the full composer text
 * @param {number} caret the caret position (selectionStart)
 * @param {string[] | Set<string> | null} knownNamespaces  known command ids;
 *   when provided, a post-whitespace token whose ns is NOT in the set returns
 *   null (position-0 tokens keep the legacy behavior so the namespace-list
 *   filter can still show partial matches).
 * @returns {null | { start: number, end: number, ns: string, arg: string, hasColon: boolean }}
 *   null unless the text up to the caret is exactly `/ns` or `/ns:arg`
 *   (whitespace-free) at command position. `start` is the slash's index;
 *   `end` is the caret.
 */
export function parseSlashCommand(text, caret, knownNamespaces = null) {
  const t = String(text ?? "");
  const c = Math.max(
    0,
    Math.min(typeof caret === "number" && Number.isFinite(caret) ? caret : t.length, t.length),
  );
  const before = t.slice(0, c);
  // The slash must be at index 0 (start of input) OR begin a fresh token after
  // whitespace that follows a NON-EMPTY prefix (a leading-space token is text).
  // group 1 = the whitespace run before the slash (absent at position 0),
  // group 2 = the slash, group 3 = the namespace, group 4 = the arg.
  const m = before.match(/(?:^|(\s+))(\/)([a-z]*)(?::(\S*))?$/i);
  if (!m) return null;
  const ws = m[1] ?? "";
  const slashIndex = (m.index ?? 0) + ws.length;
  if (ws && !before.slice(0, m.index ?? 0).trim()) {
    // The whitespace before the slash has only whitespace before it too — a
    // leading-space token like " /agent:x" is ordinary text.
    return null;
  }
  const ns = (m[3] || "").toLowerCase();
  // Post-whitespace commands require a KNOWN namespace (the caller's set);
  // position-0 keeps legacy behavior (partial namespaces filter the list).
  if (
    ws &&
    knownNamespaces &&
    !(knownNamespaces instanceof Set ? knownNamespaces.has(ns) : knownNamespaces.includes(ns))
  ) {
    return null;
  }
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

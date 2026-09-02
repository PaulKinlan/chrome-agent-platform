// lib/run-digest.js — the runtime-written running digest of a run's tool
// results (CAP-FB-20260902-LOOP-CONTEXT-WINDOW-01).
//
// agent-do's loop appends `result.response.messages` to its history at every
// inner-turn boundary (an inner turn = one streamText call of up to
// `innerStepLimit` model steps). With the AI SDK it is built against, that
// array holds only the LAST step's messages, so every earlier step of the
// turn — its tool calls AND their results — is gone from the model context
// the moment the loop continues. A 30-tab read that spans three inner turns
// could only cite what the last step still held.
//
// The runtime cannot change what agent-do keeps (the library is imported, not
// reimplemented), but it observes every tool result (`onPostToolUse`) and
// every provider-bound prompt (the model boundary in agent.js). So: each
// inner turn's tool results are digested here — one line per result, the
// selected tool, its arguments, ok/failed, and a bounded excerpt — and the
// digest of turn N is attached to agent-do's OWN continuation message that
// follows turn N, at the provider boundary. Properties:
//   - runtime-written: every count and every line comes from what the tools
//     actually returned, never from the model's claims;
//   - bounded: one turn's digest never exceeds `maxBytesPerTurn` (excerpts
//     shrink first, then the oldest lines collapse into a count); turns older
//     than `maxTurnsInFull` carry their counts only;
//   - fenced: the excerpts are page/site data, so they sit inside the run's
//     untrusted boundary (lib/untrusted-fence.js) exactly like the raw results
//     did — the header (counts, refs) is the runtime's own text and sits outside;
//   - redacted: every line passes the credential scrub (lib/pure.js) after the
//     structural key redaction the raw result already had;
//   - stable: a turn's digest is a pure function of that turn's entries, so the
//     prompt prefix a provider may cache does not churn call to call.
//
// Pure: no chrome.*, no DOM. The agent loop wires it; the tests drive it alone.

import { redactSecretText, truncateUtf8, utf8ByteLength } from "./pure.js";
import { isUntrustedToken, mintUntrustedToken, untrustedClose, untrustedOpen } from "./untrusted-fence.js";

export const RUN_DIGEST_BOUNDS = Object.freeze({
  // One continuation message never carries more than this many digest bytes.
  maxBytesPerTurn: 8 * 1024,
  // Turns older than this many (counted back from the current one) carry their
  // counts and refs only — the in-context total stays ≤ maxTurnsInFull × 8 KiB
  // plus a header per older turn.
  maxTurnsInFull: 4,
  // The most lines one turn keeps (a step can fan out parallel calls).
  maxEntriesPerTurn: 96,
  // Per-line excerpt/argument/error ceilings (characters) at record time. The
  // excerpt ceiling is generous on purpose: the TURN budget above is the real
  // bound, and lines shrink together at render time only when a turn needs it
  // (a 30-tab list must survive whole when its turn has the room).
  maxExcerptChars: 4096,
  maxArgsChars: 160,
  maxErrorChars: 200,
});

/** agent-do's synthetic continuation message (loop.js): the digest rides it. */
export const CONTINUATION_NUDGE_PREFIX = "Continue working on the task";

const SELECTION_REF_RE = /^sel_[a-f0-9]{36}$/u;
const FENCED_LEAF_RE = /^<<<UNTRUSTED run:[A-Za-z0-9]+>>>\n([\s\S]*)\n<<<END run:[A-Za-z0-9]+>>>$/;
const MAX_DEPTH = 12;
// Render-time excerpt levels, tried in order until the turn fits its budget:
// short lines keep their full excerpt while long ones shrink together.
const EXCERPT_LEVELS = Object.freeze([4096, 2048, 1200, 800, 600, 400, 280, 200, 140, 100, 60, 0]);

function ownData(value, key) {
  try {
    if (!value || typeof value !== "object") return undefined;
    const d = Object.getOwnPropertyDescriptor(value, key);
    return d && "value" in d ? d.value : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a provider-bound message (a string, or text parts). */
function messageText(message) {
  const c = ownData(message, "content");
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((p) => ownData(p, "type") === "text").map((p) => String(ownData(p, "text") ?? "")).join("");
}

/** Whether a provider-bound message is agent-do's continuation nudge. A user
 * turn typed by the owner that happens to start the same way is
 * indistinguishable here, which is why `attach` maps nudges from the END of
 * the prompt (the latest nudge belongs to the latest finished turn). */
export function isContinuationNudge(message) {
  if (ownData(message, "role") !== "user") return false;
  return messageText(message).trimStart().startsWith(CONTINUATION_NUDGE_PREFIX);
}

/** Unwrap the fence the lazy projection put around string leaves (the digest
 * re-fences the whole excerpt block once), collapse whitespace so one result
 * is one line, and keep the shape. Bounded depth; never throws. */
function unfenceForDigest(value, depth = 0) {
  if (typeof value === "string") {
    const inner = value.match(FENCED_LEAF_RE)?.[1] ?? value;
    return inner.replace(/\s+/g, " ").trim();
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => unfenceForDigest(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "untrusted") continue; // the tag is ours, not the page's
    out[k] = unfenceForDigest(v, depth + 1);
  }
  return out;
}

/** A lazy `search_tools` result (the runtime's own protocol shape, not page
 * data) is digested as what a later turn needs from it — each hit's name, its
 * reusable selection ref and its one-line summary — never the schema
 * summaries, which would spend the whole excerpt before the ref. */
function searchResultView(value) {
  const results = ownData(value, "results");
  if (!Array.isArray(results) || !results.some((r) => typeof ownData(r, "selectionRef") === "string")) return null;
  return {
    ok: ownData(value, "ok"),
    results: results.slice(0, 16).map((r) => ({
      name: ownData(r, "name"),
      selectionRef: ownData(r, "selectionRef"),
      summary: ownData(r, "summary"),
    })),
  };
}

/** Parse the model-facing text of an agent-do ToolResult back into the value
 * the tool returned (our tools return objects, which agent-do JSON-encodes). */
function structuredValue(result) {
  const data = ownData(result, "data");
  if (data !== undefined && data !== null) return data;
  const text = ownData(result, "modelContent");
  if (typeof text === "string") {
    const s = text.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try { return JSON.parse(s); } catch { /* plain text */ }
    }
    return text;
  }
  return result;
}

function compactJson(value, maxChars) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = "[unserializable]";
  }
  if (typeof text !== "string") text = String(value);
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? text.slice(0, Math.max(0, maxChars - 1)) + "…" : text;
}

/** One tool's failure message, from the shapes a result can carry. */
function failureText(envelope, value, result) {
  for (const candidate of [ownData(value, "error"), ownData(envelope, "error"), ownData(result, "userSummary"), ownData(result, "modelContent")]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "failed";
}

/**
 * Create the digest for one agent. `token` is the run's untrusted-fence
 * boundary (the same one the composed system prompt names); a missing token
 * mints a private one so the excerpts are still fenced.
 */
export function createRunDigest({ token = null, bounds = RUN_DIGEST_BOUNDS } = {}) {
  const fenceToken = isUntrustedToken(token) ? token : mintUntrustedToken();
  const B = Object.freeze({ ...RUN_DIGEST_BOUNDS, ...(bounds && typeof bounds === "object" ? bounds : {}) });
  let entries = [];
  let seq = 0;
  let counts = { results: 0, ok: 0, failed: 0 };
  const renderCache = new Map(); // step -> { full: string, brief: string }

  function reset() {
    entries = [];
    seq = 0;
    counts = { results: 0, ok: 0, failed: 0 };
    renderCache.clear();
  }

  /**
   * Record one tool result the loop just observed.
   * @param {object} e { step, tool, selected, args, ok, result }
   *   step: agent-do's outer iteration (the inner turn the result belongs to);
   *   tool: the provider-facing tool name (execute_tool / search_tools / …);
   *   selected: the real tool a lazy envelope selected (or null);
   *   args: the provider-facing arguments; ok: the runtime's verdict;
   *   result: agent-do's normalised ToolResult ({modelContent, userSummary, data?});
   *   call (optional): the ordinal of the model call that issued this tool
   *     call. agent-do keeps a turn's LAST step in its history, so the entries
   *     of a turn's highest call ordinal survive in the transcript and are
   *     counted but not repeated in the digest.
   */
  function record(e) {
    const step = Number.isFinite(ownData(e, "step")) ? Math.trunc(e.step) : 0;
    const call = Number.isFinite(ownData(e, "call")) ? Math.trunc(e.call) : null;
    const tool = String(ownData(e, "tool") ?? "tool").slice(0, 64);
    const selected = typeof ownData(e, "selected") === "string" ? e.selected.slice(0, 64) : null;
    const name = selected ?? tool;
    const ok = ownData(e, "ok") === true;
    const result = ownData(e, "result");
    const value = structuredValue(result);
    // The lazy execute envelope: { ok, selectedTool, result, selectionRef… } —
    // the line shows the SELECTED tool with its own arguments; the ref moves
    // to the per-turn refs line so every line does not repeat 40 characters.
    const envelope = typeof ownData(value, "selectedTool") === "string" ? value : null;
    const rawArgs = ownData(e, "args");
    const envelopeArgs = envelope ? ownData(rawArgs, "arguments") : undefined;
    const shownArgs = envelope && envelopeArgs !== undefined ? envelopeArgs : rawArgs;
    const refCandidate = ownData(rawArgs, "selectionRef");
    const ref = typeof refCandidate === "string" && SELECTION_REF_RE.test(refCandidate) ? refCandidate : null;
    const inner = envelope ? ownData(envelope, "result") : value;
    const excerptSource = unfenceForDigest(searchResultView(inner === undefined ? value : inner) ?? (inner === undefined ? value : inner));
    const entry = {
      seq: ++seq,
      step,
      call,
      name,
      args: redactSecretText(compactJson(shownArgs === undefined ? {} : shownArgs, B.maxArgsChars)),
      ok,
      error: ok ? "" : redactSecretText(compactJson(failureText(envelope, inner, result), B.maxErrorChars)),
      excerpt: ok ? redactSecretText(compactJson(excerptSource, B.maxExcerptChars)) : "",
      ref,
      counts: null,
    };
    counts = { results: counts.results + 1, ok: counts.ok + (ok ? 1 : 0), failed: counts.failed + (ok ? 0 : 1) };
    entry.counts = counts;
    entries.push(entry);
    renderCache.delete(step);
    return entry;
  }

  /** The run's running totals — they ride the budget events. */
  function currentCounts() {
    return { count: counts.results, ok: counts.ok, failed: counts.failed };
  }

  function turnEntries(step) {
    return entries.filter((en) => en.step === step);
  }

  /** The entries of a turn's last model step: agent-do keeps that step in its
   * history, so they are still in the transcript and are not repeated. */
  function survivors(list) {
    const calls = list.map((en) => en.call).filter((c) => c != null);
    if (calls.length !== list.length) return new Set();
    const last = Math.max(...calls);
    return new Set(list.filter((en) => en.call === last).map((en) => en.seq));
  }

  function header(step, list, full, kept) {
    const last = list[list.length - 1].counts;
    const refs = new Map();
    for (const en of list) if (en.ref) refs.set(en.name, en.ref);
    const refLine = refs.size
      ? `\nReusable selection refs from this turn: ${[...refs].map(([n, r]) => `${n}=${r}`).join(", ")}.`
      : "";
    const still = list.length - kept;
    const stillNote = still > 0 ? ` (the last step's ${still} result${still === 1 ? "" : "s"} still in the transcript above and not repeated)` : "";
    const scope = full
      ? `This turn (${step + 1}): ${list.length} result${list.length === 1 ? "" : "s"}${stillNote}, excerpted below.`
      : `This turn (${step + 1}): ${list.length} result${list.length === 1 ? "" : "s"} (excerpts dropped — an older turn).`;
    return `Runtime digest — written by the runtime from this run's tool results, not by any page or by you. ` +
      `Earlier turns' raw results are no longer in the transcript; excerpts are truncated — re-read an item if you need more of it. ` +
      `So far: ${last.results} tool result${last.results === 1 ? "" : "s"}, ${last.ok} ok, ${last.failed} failed. ${scope}${refLine}`;
  }

  function line(en, level) {
    const body = en.ok
      ? (level > 0 ? (en.excerpt.length > level ? en.excerpt.slice(0, Math.max(0, level - 1)) + "…" : en.excerpt) : "")
      : en.error;
    return `#${en.seq} ${en.name} ${en.args} ${en.ok ? "ok" : "failed"}${body ? `: ${body}` : ""}`;
  }

  function fenced(lines) {
    return `${untrustedOpen(fenceToken)}\n${lines.join("\n")}\n${untrustedClose(fenceToken)}`;
  }

  /** The full digest of one turn, fitted to `maxBytesPerTurn`: excerpts shrink
   * level by level, then the oldest lines collapse into one count line. */
  function renderFull(step) {
    const list = turnEntries(step);
    if (list.length === 0) return "";
    const survive = survivors(list);
    const gone = list.filter((en) => !survive.has(en.seq));
    if (gone.length === 0) return renderBrief(step, list.length);
    const kept = gone.length > B.maxEntriesPerTurn ? gone.slice(gone.length - B.maxEntriesPerTurn) : gone;
    const omittedEarly = gone.length - kept.length;
    const head = header(step, list, true, gone.length);
    const fits = (text) => utf8ByteLength(text) <= B.maxBytesPerTurn;
    const compose = (rows, omitted) => {
      const lines = [];
      if (omitted > 0) {
        const dropped = gone.slice(0, omitted);
        lines.push(`… ${omitted} earlier result${omitted === 1 ? "" : "s"} of this turn omitted (${dropped.filter((en) => en.ok).length} ok, ${dropped.filter((en) => !en.ok).length} failed).`);
      }
      for (const en of rows) lines.push(en.line);
      return `${head}\n${fenced(lines)}`;
    };
    for (const level of EXCERPT_LEVELS) {
      const rows = kept.map((en) => ({ line: line(en, Math.min(level, B.maxExcerptChars)) }));
      const text = compose(rows, omittedEarly);
      if (fits(text)) return text;
    }
    // Excerpt-free lines still overflow: drop the oldest lines until it fits.
    let rows = kept.map((en) => ({ line: line(en, 0) }));
    let omitted = omittedEarly;
    while (rows.length > 1) {
      rows = rows.slice(1);
      omitted += 1;
      const text = compose(rows, omitted);
      if (fits(text)) return text;
    }
    // A single pathological line: hard-bound it (never exceed the budget).
    return truncateUtf8(compose(rows, omitted), B.maxBytesPerTurn);
  }

  function renderBrief(step) {
    const list = turnEntries(step);
    if (list.length === 0) return "";
    return header(step, list, false, 0);
  }

  /** The digest text for one turn, or "" when the turn produced no results.
   * `full` = false renders the counts-only form used for older turns. */
  function renderTurn(step, { full = true } = {}) {
    const s = Number.isFinite(step) ? Math.trunc(step) : 0;
    const cached = renderCache.get(s) ?? {};
    const key = full ? "full" : "brief";
    if (typeof cached[key] === "string") return cached[key];
    const text = full ? renderFull(s) : renderBrief(s);
    renderCache.set(s, { ...cached, [key]: text });
    return text;
  }

  /**
   * Attach the digests to the provider-bound prompt: the k-th continuation
   * nudge counted from the END belongs to outer iteration
   * `currentStep - 1 - k`. Returns the (possibly new) options and the digest
   * bytes attached to this call. The input is never mutated.
   */
  function attach(options, currentStep) {
    const prompt = ownData(options, "prompt");
    if (!Array.isArray(prompt) || entries.length === 0) return { options, bytes: 0, turns: 0 };
    const step = Number.isFinite(currentStep) ? Math.trunc(currentStep) : 0;
    const nudges = [];
    for (let i = 0; i < prompt.length; i++) if (isContinuationNudge(prompt[i])) nudges.push(i);
    if (nudges.length === 0) return { options, bytes: 0, turns: 0 };
    let bytes = 0;
    let turns = 0;
    const next = prompt.slice();
    for (let k = 0; k < nudges.length; k++) {
      const index = nudges[nudges.length - 1 - k];
      const turn = step - 1 - k;
      if (turn < 0) continue;
      const digest = renderTurn(turn, { full: k < B.maxTurnsInFull });
      if (!digest) continue;
      const message = prompt[index];
      const content = ownData(message, "content");
      const suffix = `\n\n${digest}`;
      if (typeof content === "string") {
        next[index] = { ...message, content: content + suffix };
      } else if (Array.isArray(content)) {
        const parts = content.slice();
        const at = parts.findIndex((p) => ownData(p, "type") === "text");
        if (at >= 0) parts[at] = { ...parts[at], text: String(ownData(parts[at], "text") ?? "") + suffix };
        else parts.push({ type: "text", text: digest });
        next[index] = { ...message, content: parts };
      } else {
        continue;
      }
      bytes += utf8ByteLength(digest);
      turns += 1;
    }
    if (turns === 0) return { options, bytes: 0, turns: 0 };
    return { options: { ...options, prompt: next }, bytes, turns };
  }

  return Object.freeze({
    reset,
    record,
    counts: currentCounts,
    renderTurn,
    attach,
    /** Test/telemetry view: the recorded entries (frozen copies). */
    entries: () => entries.map((en) => Object.freeze({ ...en })),
    token: () => fenceToken,
  });
}

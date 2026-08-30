// extension/shared/thread-view.js — the pure, unit-testable rules behind the
// thread view's run state, scroll behaviour and card titles
// (CAP-FB-20260830-THREAD-VIEW-RUN-STATE-01). No DOM here: the components
// call these so the behaviour is falsifiable without a browser.

/** The banner label while a run is live: "Working — <activity>…". The activity
 *  arrives from the progress port (friendlyActivityLabel / "Writing the
 *  answer…" / "Thinking · step 2 of 4"); its first letter is lower-cased so
 *  the sentence reads as one, and a trailing ellipsis is added exactly once.
 *  No activity → the plain "Working…". */
/** @param {unknown} activity */
export function composeWorkingLabel(activity) {
  const raw = typeof activity === "string" ? activity.trim() : "";
  if (!raw) return "Working…";
  const stripped = raw.replace(/[….]+$/u, "").trim();
  if (!stripped) return "Working…";
  const first = [...stripped][0];
  const rest = stripped.slice(first.length);
  // A step label ("Thinking · step 2") keeps its capital when it is a proper
  // noun-like token; everything else joins the sentence in lower case.
  const lowered = first.toLowerCase() + rest;
  return `Working — ${lowered}…`;
}

/** The "stick to bottom" latch: the owner is at (or within `slack` px of) the
 *  bottom of the scroll container, so appended rows may auto-scroll. Scrolled
 *  up beyond the slack → the owner is reading; do not yank the view. A
 *  container that does not scroll at all is always "at the bottom". */
/**
 * @param {{ scrollTop?: number, clientHeight?: number, scrollHeight?: number }} [metrics]
 * @param {number} [slack]
 */
export function isScrolledToBottom(metrics = {}, slack = 24) {
  const { scrollTop, clientHeight, scrollHeight } = metrics ?? {};
  const top = Number(scrollTop) || 0;
  const client = Number(clientHeight) || 0;
  const height = Number(scrollHeight) || 0;
  if (height <= client) return true;
  return top + client >= height - slack;
}

/** Bounded, single-line artifact name for a card head; null when absent. */
function cleanName(value) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/gu, " ").trim();
  return s ? s.slice(0, 120) : null;
}

function parseMaybe(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Unwrap the lazy-protocol / agent-do envelopes (`{modelContent}`,
 *  `{ok, result}`) that wrap a tool's own result. Bounded depth. */
function unwrapEnvelope(value, depth = 0) {
  const v = parseMaybe(value);
  if (!v || typeof v !== "object" || Array.isArray(v) || depth > 4) return v;
  if (typeof v.modelContent === "string" || (v.modelContent && typeof v.modelContent === "object")) {
    const inner = unwrapEnvelope(v.modelContent, depth + 1);
    if (inner && typeof inner === "object") return inner;
  }
  if (v.result !== undefined && (v.selectedTool !== undefined || v.ok !== undefined)) {
    const inner = unwrapEnvelope(v.result, depth + 1);
    if (inner && typeof inner === "object" && !Array.isArray(inner)) return { ...v, ...inner, result: v.result };
  }
  // The lazy CALL shape (execute_tool args as persisted): { selectionRef,
  // arguments: { id, name, content } } — the tool's own arguments sit one
  // level down.
  if (v.arguments && typeof v.arguments === "object" && !Array.isArray(v.arguments)) {
    return { ...v, ...v.arguments, arguments: v.arguments };
  }
  return v;
}

/** Title for a generated-UI / artifact card. Resolution order: an explicit
 *  `name` in the args (create_asset), the asset's name in the result
 *  (update_asset returns the updated asset), a name the conversation already
 *  knows for that id (`lookup(id)` — the create card that came before), and
 *  only then a truthful generic title by tool ("Updated artifact"), never the
 *  meaningless "Generated UI". */
/**
 * @param {{ toolName?: string, args?: unknown, result?: unknown, detail?: unknown, lookup?: ((id: string) => unknown) | null }} [input]
 * @returns {string}
 */
export function artifactCardTitle(input = {}) {
  const { toolName = "", args = null, result = null, detail = null, lookup = null } = input ?? {};
  const candidates = [args, result, detail].map(unwrapEnvelope);
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const name = cleanName(c.name) ?? cleanName(c.asset?.name);
    if (name) return name;
  }
  if (typeof lookup === "function") {
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const id = typeof c.id === "string" ? c.id : (typeof c.asset?.id === "string" ? c.asset.id : null);
      if (!id) continue;
      const known = cleanName(lookup(id));
      if (known) return known;
    }
  }
  switch (toolName) {
    case "update_asset": return "Updated artifact";
    case "patch_asset": return "Edited artifact";
    case "create_asset": return "New artifact";
    default: return "Generated page";
  }
}

/** The artifact identity (id + name) a tool payload carries, unwrapping the
 *  lazy / agent-do envelopes; null when the payload names no asset. Lets a
 *  conversation remember id → name from the create card so the later update
 *  card (id only) can be titled. */
/** @param {unknown[]} payloads */
export function artifactIdentityFromPayloads(payloads = []) {
  for (const raw of Array.isArray(payloads) ? payloads : []) {
    const c = unwrapEnvelope(raw);
    if (c && typeof c === "object") {
      const asset = c.asset && typeof c.asset === "object" ? c.asset : null;
      const id = typeof asset?.id === "string" && asset.id ? asset.id : (typeof c.id === "string" && c.id ? c.id : null);
      const name = cleanName(asset?.name) ?? cleanName(c.name);
      if (id && name) return { id, name };
      continue;
    }
    // The progress port bounds a tool result to ~300 characters, so the live
    // payload is often a TRUNCATED, no-longer-parseable JSON string (nested
    // envelopes escape their quotes). Read the asset's own id + name out of
    // the `asset` object's text — the identity sits at its head — without
    // trusting anything else in it.
    const text = typeof raw === "string" ? raw : "";
    const at = text.search(/\\*"asset\\*"\s*:\s*\{/u);
    if (at < 0) continue;
    const head = text.slice(at, at + 400);
    const id = head.match(/\\*"id\\*"\s*:\s*\\*"([A-Za-z0-9_.:-]{1,80})\\*"/u)?.[1] ?? null;
    const name = head.match(/\\*"name\\*"\s*:\s*\\*"((?:[^"\\]|\\[^"])(?:[^"\\]|\\[^"]){0,119})\\*"/u)?.[1] ?? null;
    const clean = cleanName(name);
    if (id && clean) return { id, name: clean };
  }
  return null;
}

/** The per-turn time label: `<time datetime>` gets the ISO instant, the
 *  visible text is short and local ("just now", "3m ago", "14:05", or
 *  "Aug 30 14:05" on another day). `now` is injectable for tests. */
/** @param {unknown} ts @param {number} [now] */
export function turnTime(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  const delta = now - t;
  let label;
  if (delta < 60 * 1000 && delta > -60 * 1000) label = "just now";
  else if (delta < 60 * 60 * 1000 && delta > 0) label = `${Math.max(1, Math.round(delta / 60000))}m ago`;
  else {
    const sameDay = new Date(now).toDateString() === d.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    label = sameDay ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  }
  return { iso: d.toISOString(), label, full: d.toLocaleString() };
}

// lib/tool-summary.js — turn a raw tool result into a READABLE one-line summary
// (never a raw JSON dump). Pure (no DOM; lib/pure.js only) so both the browser
// pages (conversation.js, ntp.js) and the Deno unit tests can import it.
//
// The agent-do runtime wraps tool results in {modelContent, userSummary}; we
// prefer `userSummary` (already a compact, human summary) and then apply a
// per-tool renderer so list/create/schedule/browser/memory tools read naturally.
// The raw detail stays available separately (the tool card's `details` expand).

/**
 * Whether a raw tool result signals FAILURE (for the tool-card lifecycle):
 * a returned { ok:false } / { error } / blocked object, or a denial / error
 * summary string. Pure — the SW uses it to tag the live tool-result event
 * with `ok`, so the UI can mark the card error instead of always success.
 */
import { redactSecrets, redactSecretText } from "./pure.js";

export function isToolResultFailure(raw) {
  const d = unwrapToolResult(raw);
  if (d && typeof d === "object" && !Array.isArray(d)) {
    if (d.ok === false) return true;
    if (d.blocked === true) return true;
    if (typeof d.error === "string" && d.error.trim()) return true;
    if (typeof d.reason === "string" && /denied|aborted|failed/i.test(d.reason)) return true;
    // a ToolResult envelope carries the human summary + the model-facing text
    if (typeof d.userSummary === "string" && /denied|^\s*error:|^\s*failed/i.test(d.userSummary)) return true;
    if (typeof d.modelContent === "string" && /^\s*error:/i.test(d.modelContent)) return true;
  }
  const s = String(d ?? "");
  return /^\s*\[[^\]]+\]\s*DENIED/i.test(s) || /^error:/i.test(s) || /^\s*failed\b/i.test(s);
}

/** Turn a raw tool result into a readable one-line summary. */
export function summarizeToolResult(name, raw) {
  const data = unwrapToolResult(raw);
  return renderToolSummary(String(name ?? "tool"), data);
}

/** Decode + redact a raw tool result ONCE, for every surface that can paint
 * it (activity summary line, detail tree, tree copy, journal persistence):
 * unwraps the {modelContent, userSummary} envelope — whose values can
 * themselves be JSON strings (double-encoded) — redacts secret-shaped keys in
 * the decoded structure, and scrubs credential patterns from ANY string leaf
 * (tool results are DATA, not prose, so the scrub is stricter than the
 * prose-collision-safe generic text redactor). A row persisted before
 * write-path redaction can never paint a secret when every reader routes
 * through here. */
export function redactToolResult(raw) {
  const d = unwrapToolResult(raw);
  if (d == null) return d;
  // redactSecrets masks secret-NAMED keys; redactResultValue then scrubs
  // every remaining STRING LEAF (nested Bearer/sk-/AKIA/… shapes survive
  // redactSecrets by design — it never touches string values).
  return redactResultValue(redactSecrets(d));
}

/** Result-specific credential SHAPES: bare tokens with no keyword context.
 * Tool results are data payloads, so the prose-collision caution of
 * redactSecretText does not apply — a bare sk-…/AKIA… in a result IS a
 * credential. The generic redactor stays untouched (prose stays safe). */
const RESULT_SECRET_SHAPES = [
  /\b(?:sk|rk|pk|key|tok)-[A-Za-z0-9_-]{8,}/g, // sk-live-…, rk-…, tok-…
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
];

/** Scrub credential patterns from result TEXT: the generic keyword-context
 * redactor first, then the bare-shape pass. */
function redactResultText(s) {
  let out = redactSecretText(s);
  for (const re of RESULT_SECRET_SHAPES) out = out.replace(re, "[REDACTED]");
  return out;
}

/** Recursively scrub every string leaf of a decoded result structure.
 * Path-scoped cycle guard (same contract as redactSecrets): a cyclic result
 * degrades to "[Circular]" instead of throwing RangeError; shared (DAG)
 * subtrees are still scrubbed at every site. */
function redactResultValue(v, seen = new WeakSet()) {
  if (typeof v === "string") return redactResultText(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    const out = v.map((x) => redactResultValue(x, seen));
    seen.delete(v);
    return out;
  }
  if (v && typeof v === "object") {
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactResultValue(val, seen);
    seen.delete(v);
    return out;
  }
  return v;
}

/** Unwrap the {modelContent, userSummary} envelope into the underlying value.
 * Envelopes nest (modelContent can itself be a JSON string of another
 * envelope), so unwrap ITERATIVELY — bounded at MAX_UNWRAP_DEPTH; at the cap
 * the raw string is returned so the text scrubber still covers it. */
const MAX_UNWRAP_DEPTH = 4;
function unwrapToolResult(raw) {
  let v = raw;
  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth++) {
    if (v == null) return null;
    if (typeof v === "object" && !Array.isArray(v)) {
      let next = v;
      if (v.userSummary != null) next = v.userSummary;
      else if (v.modelContent != null) next = v.modelContent;
      if (next === v) return v; // no envelope (or a self-reference) — done
      v = next;
      continue;
    }
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return null;
      if (s.startsWith("{") || s.startsWith("[")) {
        if (depth === MAX_UNWRAP_DEPTH) return s; // bounded: scrub as text
        try { v = JSON.parse(s); continue; } catch { return s; }
      }
      return s;
    }
    return v;
  }
  return v;
}

function short(s, n = 72) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

/** A per-tool summary renderer. Falls back to a compact key/value summary. */
function renderToolSummary(name, data) {
  const d = data;
  // A list of agents (site or named).
  const agents = (d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.agents)) ? d.agents : null;
  if (agents != null) {
    const items = agents.map((a) => {
      const label = a?.name || a?.origin || a?.id || "agent";
      const role = a?.role;
      const mem = a?.memoryKeyCount != null ? `${a.memoryKeyCount} memory key${a.memoryKeyCount === 1 ? "" : "s"}` : null;
      const tools = a?.toolCount != null && a?.toolCount > 0 ? `${a.toolCount} tools` : (a?.toolCount === 0 ? "no tools" : null);
      return role ? `${label} — ${short(role)}` : [label, mem, tools].filter(Boolean).join(" · ");
    });
    return `${agents.length} ${/named/i.test(name) ? "named agent" : "agent"}${agents.length === 1 ? "" : "s"}: ${items.join("; ")}`;
  }
  // create / update / delete results.
  if (d && typeof d === "object" && !Array.isArray(d)) {
    const a = d.agent || d.created || d.updated;
    if (a && typeof a === "object" && (a.name || a.id)) {
      const verb = /delete/i.test(name) ? "deleted" : /update/i.test(name) ? "updated" : "created";
      return `${verb} ${a.name || a.id}${a.role ? ` (${short(a.role, 60)})` : ""}`;
    }
    // schedule results (before the generic ok:true → "done" fallthrough).
    if (/schedule/i.test(name) && (d.id || d.task || d.name)) return `scheduled: ${short(d.name || d.task || d.id)}`;
    if (d.ok === true) return "done";
    if (d.ok === false) return `failed: ${short(d.error ?? d.reason ?? "")}`;
    // memory results.
    if (/memory/i.test(name)) {
      if (d.keys && Array.isArray(d.keys)) return `${d.keys.length} key${d.keys.length === 1 ? "" : "s"}: ${d.keys.map(String).join(", ")}`;
      if (d.value != null) return short(String(d.value));
      if (d.matches != null) return `${Array.isArray(d.matches) ? d.matches.length : 0} match${Array.isArray(d.matches) && d.matches.length === 1 ? "" : "es"}`;
    }
    // a URL result (navigate / open tab).
    if (/navigate|open_?tab|goto|url/i.test(name) && d.url) return `opened ${short(d.url)}`;
    // a small object → key: value pairs (first few), never a JSON blob.
    const entries = Object.entries(d).filter(([, v]) => v != null);
    if (entries.length && entries.length <= 4) {
      return entries.map(([k, v]) => `${k}: ${short(typeof v === "object" ? JSON.stringify(v) : v, 40)}`).join(" · ");
    }
  }
  // a bare string / array / number.
  if (typeof d === "string") return short(d, 120);
  if (Array.isArray(d)) return `${d.length} item${d.length === 1 ? "" : "s"}`;
  if (d == null) return "done";
  return short(JSON.stringify(d), 120);
}

// lib/tool-summary.js — turn a raw tool result into a READABLE one-line summary
// (never a raw JSON dump). Pure (no DOM, no imports) so both the browser pages
// (conversation.js, ntp.js) and the Deno unit tests can import it directly.
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

/** Unwrap the {modelContent, userSummary} envelope into the underlying value. */
function unwrapToolResult(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        const outer = JSON.parse(s);
        if (outer && typeof outer === "object" && !Array.isArray(outer)) {
          if (outer.userSummary != null) return coerceJson(outer.userSummary);
          if (outer.modelContent != null) return coerceJson(outer.modelContent);
        }
        return outer;
      } catch {
        return s;
      }
    }
    return s;
  }
  return raw;
}

/** If a value is a JSON string, parse it; otherwise pass it through. */
function coerceJson(v) {
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try { return JSON.parse(s); } catch { return v; }
    }
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

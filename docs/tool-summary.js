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

/* ── describeToolCall — the collapsed tool-card's human line ──────────────
 * The owner reads the COLLAPSED row far more often than the expanded tree:
 * the row must say WHAT is happening ("Searching tools for “daily notes”"),
 * not just the tool's identifier. Data-driven per-tool map + a generic
 * fallback (verb-ized name + the primary scalar argument). Pure; bounded
 * interpolations; never throws. */

/** Bound one interpolated argument value for the summary line. */
function clipArg(v, max = 48) {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** The first present, short, scalar argument among the preferred keys. */
function pickArg(args, keys) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return clipArg(v);
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** Human sentence for the collapsed tool card. Returns "" when the tool is
 * unknown AND no useful argument exists (the caller then shows the name). */
export function describeToolCall(name, args) {
  const n = String(name ?? "");
  switch (n) {
    case "search_tools": {
      const q = pickArg(args, ["query"]);
      return q ? `Searching tools for “${q}”` : "Searching available tools";
    }
    case "execute_tool": {
      // Pre-result the invoked tool's name is behind the selectionRef; the
      // card's header is corrected to the real tool when the result lands
      // (effectiveToolCall), at which point THIS gets the real name + args.
      return "Running the selected tool";
    }
    case "navigate": case "open_url": case "open_tab": {
      const u = pickArg(args, ["url"]);
      return u ? `Opening ${u}` : "Opening a page";
    }
    case "navigate_back": return "Going back";
    case "navigate_forward": return "Going forward";
    case "reload_tab": case "reload": return "Reloading the page";
    case "close_tab": return "Closing the tab";
    case "read_page": case "get_page_text": case "get_page_snapshot": case "read_tab": {
      const u = pickArg(args, ["url", "tabId"]);
      return u ? `Reading the page (${u})` : "Reading the page";
    }
    case "click": case "click_element": {
      const t = pickArg(args, ["selector", "text", "target"]);
      return t ? `Clicking ${t}` : "Clicking an element";
    }
    case "fill": case "fill_field": case "type_text": {
      const t = pickArg(args, ["selector", "field", "name"]);
      return t ? `Filling ${t}` : "Filling a field";
    }
    case "screenshot": case "capture_screenshot": return "Taking a screenshot";
    case "search_history": {
      const q = pickArg(args, ["query", "text"]);
      return q ? `Searching history for “${q}”` : "Searching history";
    }
    case "search_bookmarks": {
      const q = pickArg(args, ["query"]);
      return q ? `Searching bookmarks for “${q}”` : "Searching bookmarks";
    }
    case "memory_get": {
      const k = pickArg(args, ["key"]);
      return k ? `Reading memory “${k}”` : "Reading memory";
    }
    case "memory_set": {
      const k = pickArg(args, ["key"]);
      return k ? `Saving “${k}” to memory` : "Saving to memory";
    }
    case "memory_list": return "Listing memory";
    case "memory_grep": {
      const p = pickArg(args, ["pattern", "query"]);
      return p ? `Searching memory for “${p}”` : "Searching memory";
    }
    case "create_named_agent": {
      const nm = pickArg(args, ["name"]);
      return nm ? `Creating agent “${nm}”` : "Creating an agent";
    }
    case "update_named_agent": {
      const id = pickArg(args, ["id", "name"]);
      return id ? `Updating agent ${id}` : "Updating an agent";
    }
    case "delete_named_agent": {
      const id = pickArg(args, ["id"]);
      return id ? `Deleting agent ${id}` : "Deleting an agent";
    }
    case "list_named_agents": return "Listing your agents";
    case "get_named_agent": return "Reading an agent's details";
    case "create_agent": {
      const o = pickArg(args, ["origin"]);
      return o ? `Enrolling site agent for ${o}` : "Enrolling a site agent";
    }
    case "list_agents": return "Listing site agents";
    case "schedule_task": {
      const t = pickArg(args, ["name", "task", "id"]);
      return t ? `Scheduling “${t}”` : "Scheduling a task";
    }
    case "cancel_scheduled_task": case "cancel_schedule": return "Cancelling a schedule";
    case "list_scheduled_tasks": case "list_schedules": return "Listing schedules";
    case "create_asset": {
      const nm = pickArg(args, ["name", "key"]);
      return nm ? `Creating artifact “${nm}”` : "Creating an artifact";
    }
    case "update_asset": return "Updating an artifact";
    case "get_asset": return "Reading an artifact";
    case "list_assets": return "Listing artifacts";
    case "generate_ui": return "Generating UI";
    case "create_script": {
      const nm = pickArg(args, ["name", "id"]);
      return nm ? `Writing script “${nm}”` : "Writing a script";
    }
    case "run_script": return "Running a script";
    case "delegate_task": {
      const a = pickArg(args, ["agentId", "agent"]);
      return a ? `Delegating to ${a}` : "Delegating a task";
    }
    case "import_skill": return "Importing a skill";
    case "list_skills": case "list_recipes": return "Listing skills";
    default: {
      if (!n) return "";
      const verb = n.split("_").filter(Boolean).join(" ");
      const arg = pickArg(args, ["query", "url", "name", "key", "id", "title"]);
      return arg ? `Running ${verb} — ${arg}` : `Running ${verb}`;
    }
  }
}

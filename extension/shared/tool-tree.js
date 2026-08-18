// lib/tool-tree.js — the STRUCTURED tool-call renderer's pure core.
// DOM-free (unit-testable in Deno): recognize structured tool inputs/results,
// parse them safely (objects + a bounded/defensive decode of JSON STRINGS,
// only when clearly JSON), and build a BOUNDED tree model the renderer turns
// into an accessible, explorable DOM tree.
//
// Bounds (a huge/deep payload must never hang the UI):
//   - parse budget   — a string is only ever decoded when it clearly begins a
//                      JSON value ({ or [) and is within PARSE_LIMIT chars
//   - depth cap      — containers at MAX_DEPTH render collapsed with a note
//   - node cap       — the total row budget (a "… truncated" row appears)
//   - per-container  — at most CONTAINER_CAP entries per object/array
//   - string cap     — long leaves truncate with a "…" marker (full text kept
//                      in `full` for the title/copy affordance)
// The second decode is DEFENSIVE: a value that parses to a JSON string which
// itself clearly begins a JSON value may be decoded once more (double-encoded
// tool results), still bounded + never throwing.

export const TOOL_TREE_MAX_DEPTH = 6;
export const TOOL_TREE_MAX_NODES = 200;
export const TOOL_TREE_CONTAINER_CAP = 50;
export const TOOL_TREE_MAX_STRING = 400;
export const TOOL_TREE_PARSE_LIMIT = 200_000;

/** Whether a string clearly begins a JSON value (a bounded decode candidate). */
export function looksJsonish(s) {
  const t = String(s).trim();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * A safe, bounded decode of a raw tool value. Never throws.
 * - objects/arrays pass through as-is (kind "json")
 * - strings that clearly begin a JSON value are decoded (within PARSE_LIMIT),
 *   and a single DEFENSIVE second decode applies when the first decode yields
 *   a string that itself clearly begins a JSON value (double-encoded results)
 * - anything else (numbers, booleans, null, plain text) passes through
 * Returns { kind: "json"|"string"|"other", value, decoded: boolean }.
 */
export function safeParse(value) {
  if (value === null || value === undefined) return { kind: "other", value, decoded: false };
  if (typeof value === "object") return { kind: "json", value, decoded: false };
  if (typeof value === "string") {
    const t = value.trim();
    // A decode candidate: clearly a JSON object/array ({ or [) OR a JSON
    // STRING LITERAL (a leading " with a closing " — a double-encoded tool
    // result wraps its JSON string in quotes). Always bounded by the budget.
    const stringLiteral = t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"';
    if ((looksJsonish(t) || stringLiteral) && t.length <= TOOL_TREE_PARSE_LIMIT) {
      try {
        const once = JSON.parse(t);
        // The defensive SECOND decode: only when the first decode produced a
        // STRING that itself clearly begins a JSON value (a double-encoded
        // tool result) — never on arbitrary text.
        if (typeof once === "string") {
          const t2 = once.trim();
          if (looksJsonish(t2) && t2.length <= TOOL_TREE_PARSE_LIMIT) {
            try { return { kind: "json", value: JSON.parse(t2), decoded: true }; } catch { /* keep once */ }
          }
        }
        return { kind: "json", value: once, decoded: true };
      } catch { /* fall through to plain text */ }
    }
    return { kind: "string", value, decoded: false };
  }
  return { kind: "other", value, decoded: false };
}


function joinPath(path, seg) {
  return path ? `${path}.${seg}` : String(seg);
}
function truncate(s, max = TOOL_TREE_MAX_STRING) {
  const str = String(s);
  if (str.length <= max) return { text: str, truncated: false };
  return { text: str.slice(0, max - 1) + "…", truncated: true };
}

function primitiveText(v) {
  if (v === null) return "null";
  if (typeof v === "string") {
    const { text } = truncate(v);
    return text;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return String(v) + "n";
  return String(v);
}

/**
 * Build the BOUNDED tree model for a parsed value. Returns
 * { rows, maxDepth, maxNodes, truncated, parse } where each row is:
 *   { path, key, kind: "object"|"array"|"string"|"number"|"boolean"|"null",
 *     depth, count?, leaf, text?, full?, source: "json"|"string" }
 * `path` addresses the row ("", "items", "items.0.name" — array indices as
 * plain segments; the renderer uses it to show/hide children). Containers
 * carry `count` (children shown) + `capped` (more entries existed).
 */
export function buildTree(value, opts = {}) {
  const maxDepth = opts.maxDepth ?? TOOL_TREE_MAX_DEPTH;
  const maxNodes = opts.maxNodes ?? TOOL_TREE_MAX_NODES;
  const containerCap = opts.containerCap ?? TOOL_TREE_CONTAINER_CAP;
  const rows = [];
  let budget = maxNodes;
  let truncated = false;
  const isTruncatedString = (s) => String(s).length > TOOL_TREE_MAX_STRING;

  const push = (row) => { rows.push(row); budget -= 1; };

  const visit = (path, key, v, depth) => {
    if (budget <= 0) { truncated = true; return; }
    if (v === null || v === undefined) {
      push({ path, key, kind: "null", depth, leaf: true, text: "null", source: "json" });
      return;
    }
    if (Array.isArray(v)) {
      if (depth >= maxDepth) {
        truncated = true;
        push({ path, key, kind: "array", depth, leaf: false, count: v.length, capped: true, text: `[${v.length}] (depth capped)`, source: "json" });
        return;
      }
      const arrayCapped = v.length > containerCap;
      if (arrayCapped) truncated = true;
      push({ path, key, kind: "array", depth, leaf: false, count: Math.min(v.length, containerCap), capped: arrayCapped, source: "json" });
      const shown = v.length > containerCap ? v.slice(0, containerCap) : v;
      for (let i = 0; i < shown.length; i++) {
        if (budget <= 0) { truncated = true; break; }
        visit(joinPath(path, i), String(i), shown[i], depth + 1);
      }
      return;
    }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      if (depth >= maxDepth) {
        truncated = true;
        push({ path, key, kind: "object", depth, leaf: false, count: Math.min(keys.length, containerCap), capped: true, text: `{${keys.length}} (depth capped)`, source: "json" });
        return;
      }
      const objCapped = keys.length > containerCap;
      if (objCapped) truncated = true;
      push({ path, key, kind: "object", depth, leaf: false, count: Math.min(keys.length, containerCap), capped: objCapped, source: "json" });
      const entries = keys.length > containerCap ? keys.slice(0, containerCap).map((k) => [k, v[k]]) : Object.entries(v);
      for (const [k, val] of entries) {
        if (budget <= 0) { truncated = true; break; }
        visit(joinPath(path, k), k, val, depth + 1);
      }
      return;
    }
    // scalars
    const kind = typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
    push({ path, key, kind, depth, leaf: true, text: primitiveText(v), full: isTruncatedString(v) ? String(v) : undefined, source: "json" });
  };

  visit("", "", value, 0);
  if (rows.length === 0) {
    // a scalar root — a single leaf row
    const kind = typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "null";
    rows.push({ path: "", key: "", kind, depth: 0, leaf: true, text: primitiveText(value), full: isTruncatedString(value) ? String(value) : undefined, source: "json" });
  }
  return { rows, maxDepth, maxNodes, truncated, parse: safeParse(value) };
}

/** The subtree JSON for a container row (bounded — the shown preview). */
export function subtreeJson(value, path, rows, containerCap = TOOL_TREE_CONTAINER_CAP) {
  if (path === "") {
    const s = JSON.stringify(value);
    return s && s.length > 4096 ? s.slice(0, 4096) + "…" : s;
  }
  const segs = path.split(".").filter(Boolean);
  let cur = value;
  for (const s of segs) {
    if (cur == null) return "";
    cur = Array.isArray(cur) ? cur[Number(s)] : cur[s];
  }
  const bound = boundSubtree(cur, containerCap);
  const s = JSON.stringify(bound);
  return s && s.length > 4096 ? s.slice(0, 4096) + "…" : s;
}

/** A bounded copy of a subtree (depth + per-container caps) for copy-JSON. */
function boundSubtree(v, containerCap, depth = 0) {
  if (depth > TOOL_TREE_MAX_DEPTH) return "…";
  if (Array.isArray(v)) {
    return v.slice(0, containerCap).map((x) => boundSubtree(x, containerCap, depth + 1));
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).slice(0, containerCap)) {
      out[k] = boundSubtree(v[k], containerCap, depth + 1);
    }
    return out;
  }
  return v;
}

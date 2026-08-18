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
//   - cycle guard    — an object that is its OWN ancestor renders as a
//                      "cyclic" leaf (never an infinite recursion)
// The second decode is DEFENSIVE: a value that parses to a JSON string which
// itself clearly begins a JSON value may be decoded once more (double-encoded
// tool results), still bounded + never throwing.
//
// Paths are SEGMENT ARRAYS (["items","0","name"]), never dotted strings — a
// legitimate JSON key containing "." (or "", or a numeric-looking key) stays a
// SINGLE segment, so expansion/copy stay correct.

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

function truncate(s, max = TOOL_TREE_MAX_STRING) {
  const str = String(s);
  if (str.length <= max) return { text: str, truncated: false };
  return { text: str.slice(0, max - 1) + "…", truncated: true };
}

function primitiveText(v) {
  if (v === null) return "null";
  if (typeof v === "string") return truncate(v).text;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return String(v) + "n";
  if (typeof v === "symbol") return "symbol";
  if (typeof v === "function") return "function";
  return String(v);
}

/**
 * Build the BOUNDED tree model for a parsed value. Returns
 * { rows, maxDepth, maxNodes, truncated, parse } where each row is:
 *   { segments: string[], key, kind, depth, count?, leaf, text?, full?,
 *     capped?, cyclic?, source }
 * `segments` is the unambiguous address ("items.0.name" → ["items","0","name"]);
 * the renderer uses it for expansion + copy (a dotted KEY stays one segment).
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

  const visit = (segments, key, v, depth, chain) => {
    if (budget <= 0) { truncated = true; return; }
    if (v === null || v === undefined) {
      push({ segments, key, kind: "null", depth, leaf: true, text: "null", source: "json" });
      return;
    }
    if (typeof v === "object") {
      // Cycle guard: an object that is its own ancestor can never be JSON —
      // render it as a bounded leaf instead of recursing forever.
      if (chain.has(v)) {
        push({ segments, key, kind: "object", depth, leaf: true, text: "[cyclic]", cyclic: true, source: "json" });
        return;
      }
      if (Array.isArray(v)) {
        if (depth >= maxDepth) {
          truncated = true;
          push({ segments, key, kind: "array", depth, leaf: false, count: v.length, capped: true, text: `[${v.length}] (depth capped)`, source: "json" });
          return;
        }
        const arrayCapped = v.length > containerCap;
        if (arrayCapped) truncated = true;
        push({ segments, key, kind: "array", depth, leaf: false, count: Math.min(v.length, containerCap), capped: arrayCapped, source: "json" });
        const shown = v.length > containerCap ? v.slice(0, containerCap) : v;
        chain.add(v);
        for (let i = 0; i < shown.length; i++) {
          if (budget <= 0) { truncated = true; break; }
          visit([...segments, String(i)], String(i), shown[i], depth + 1, chain);
        }
        chain.delete(v);
        return;
      }
      let keys;
      try { keys = Object.keys(v); } catch { keys = []; }
      if (depth >= maxDepth) {
        truncated = true;
        push({ segments, key, kind: "object", depth, leaf: false, count: Math.min(keys.length, containerCap), capped: true, text: `{${keys.length}} (depth capped)`, source: "json" });
        return;
      }
      const objCapped = keys.length > containerCap;
      if (objCapped) truncated = true;
      push({ segments, key, kind: "object", depth, leaf: false, count: Math.min(keys.length, containerCap), capped: objCapped, source: "json" });
      const entries = keys.length > containerCap ? keys.slice(0, containerCap) : keys;
      chain.add(v);
      for (const k of entries) {
        if (budget <= 0) { truncated = true; break; }
        let val;
        try { val = v[k]; } catch { val = "[unreadable value]"; }
        visit([...segments, k], k, val, depth + 1, chain);
      }
      chain.delete(v);
      return;
    }
    // scalars
    const kind = typeof v === "string" ? "string" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
    push({ segments, key, kind, depth, leaf: true, text: primitiveText(v), full: isTruncatedString(v) ? String(v) : undefined, source: "json" });
  };

  visit([], "", value, 0, new Set());
  if (rows.length === 0) {
    // a scalar root — a single leaf row
    const kind = typeof value === "string" ? "string" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "null";
    rows.push({ segments: [], key: "", kind, depth: 0, leaf: true, text: primitiveText(value), full: isTruncatedString(value) ? String(value) : undefined, source: "json" });
  }
  return { rows, maxDepth, maxNodes, truncated, parse: safeParse(value) };
}

/**
 * A MANUAL, bounded, never-throws JSON serializer for the PUBLIC appendTool
 * boundary. Unlike JSON.stringify + a replacer, the traversal is ours:
 *   - cycles are distinguished from ALIASES (only an ANCESTOR is "[cyclic]";
 *     a shared reference serializes in full each time it is reached)
 *   - every property access + string coercion is try/catch guarded (throwing
 *     toJSON/toString getters can never escape — the "never throws" contract)
 *   - depth / node / byte / string caps are enforced WHILE serializing, and a
 *     byte-cap breach returns an explicit VALID envelope
 *     {"__gvs_truncated__":true,"preview":<bounded-valid-json>} — never a
 *     dangling ellipsis
 */
export function safeJsonStringify(value, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const maxNodes = opts.maxNodes ?? 500;
  const maxBytes = opts.maxBytes ?? 32 * 1024;
  const maxString = opts.maxString ?? 400;
  let nodes = 0;
  let bytes = 0;
  let truncated = false;
  const out = [];
  const budgetBytes = (s) => {
    out.push(s);
    bytes += s.length;
    if (bytes > maxBytes) { truncated = true; return false; }
    return true;
  };
  const esc = (str) => JSON.stringify(str) ?? JSON.stringify(String(str));

  const str = (v) => {
    // a bounded + safe string coercion (a hostile toString cannot throw)
    let s;
    try { s = String(v); } catch { s = "[unserializable]"; }
    if (s.length > maxString) { truncated = true; s = s.slice(0, maxString - 1) + "…"; }
    return esc(s);
  };

  const visit = (v, depth, chain) => {
    if (nodes >= maxNodes) { truncated = true; return false; }
    nodes += 1;
    if (v === null || v === undefined) { return budgetBytes("null"); }
    const t = typeof v;
    if (t === "string") return budgetBytes(str(v));
    if (t === "number") { if (!Number.isFinite(v)) { return budgetBytes("null"); } return budgetBytes(String(v)); }
    if (t === "boolean") return budgetBytes(String(v));
    if (t === "bigint") return budgetBytes(esc(String(v) + "n")); // "10n" inside the quotes — valid JSON
    if (t === "object") {
      if (chain.has(v)) return budgetBytes('"[cyclic]"'); // an ANCESTOR only
      chain.add(v);
      let ok = true;
      try {
        if (Array.isArray(v)) {
          if (depth >= maxDepth) {
            ok = budgetBytes('"[depth capped]"'); // in-band marker — still valid JSON
          } else {
            ok = budgetBytes("[");
            const cap = Math.min(v.length, 100);
            for (let i = 0; i < cap && ok && !truncated; i++) {
              if (i > 0) ok = budgetBytes(",");
              let item;
              try { item = v[i]; } catch { item = "[unreadable]"; }
              ok = visit(item, depth + 1, chain);
            }
            if (ok && v.length > cap) ok = budgetBytes(`,"[${v.length - cap} more items]"`);
            if (ok) ok = budgetBytes("]");
          }
        } else {
          if (depth >= maxDepth) {
            ok = budgetBytes('"[depth capped]"'); // in-band marker — still valid JSON
          } else {
            let keys;
            try { keys = Object.keys(v); } catch { keys = []; }
            ok = budgetBytes("{");
            const cap = Math.min(keys.length, 100);
            for (let i = 0; i < cap && ok && !truncated; i++) {
              if (i > 0) ok = budgetBytes(",");
              const k = keys[i];
              ok = budgetBytes(esc(k) + ":");
              let val;
              try { val = v[k]; } catch { val = "[unreadable]"; }
              ok = visit(val, depth + 1, chain);
            }
            if (ok && keys.length > cap) ok = budgetBytes(`,"[${keys.length - cap} more keys]"`);
            if (ok) ok = budgetBytes("}");
          }
        }
      } catch {
        ok = budgetBytes('"[unserializable]"');
      }
      chain.delete(v);
      return ok;
    }
    // function/symbol
    return budgetBytes('"[value]"');
  };

  if (typeof value === "string") return value; // a plain string passes through
  visit(value, 0, new Set());
  let json = out.join("");
  if (truncated) {
    // the explicit truncation envelope (VALID JSON, never a dangling "…")
    json = `{"__gvs_truncated__":true,"preview":${esc(json.length > 16000 ? json.slice(0, 16000) : json)}}`;
  }
  return json;
}

/** The subtree JSON for a row addressed by its SEGMENT array. Bounded +
 * never throws (a cyclic/BigInt/getter value falls back to a marker). A copy
 * that exceeds the preview budget returns an EXPLICIT truncation envelope —
 * always VALID JSON: {"__gvs_truncated__":true,"bytes":N,"preview":<json>}
 * (never a dangling ellipsis that would paste as broken JSON). */
export function subtreeJson(value, segments, containerCap = TOOL_TREE_CONTAINER_CAP) {
  let cur = value;
  for (const s of segments) {
    if (cur == null) return "null";
    try {
      cur = Array.isArray(cur) ? cur[Number(s)] : cur[s];
    } catch { return '"[unreadable value]"'; }
  }
  const bound = boundSubtree(cur, containerCap);
  try {
    const s = JSON.stringify(bound);
    if (s == null) return "null";
    if (s.length <= 4096) return s;
    // the explicit truncation envelope (the preview is a JSON string — valid)
    return `{"__gvs_truncated__":true,"bytes":${s.length},"preview":${JSON.stringify(s.slice(0, 4096))}}`;
  } catch {
    return '"[unserializable subtree]"';
  }
}

/** A bounded copy of a subtree (depth + per-container caps) for copy-JSON.
 * Keys are installed with defineProperty so "__proto__" stays DATA (it must
 * never mutate the prototype of the copied object). */
function boundSubtree(v, containerCap, depth = 0) {
  if (depth > TOOL_TREE_MAX_DEPTH) return "…";
  if (Array.isArray(v)) {
    return v.slice(0, containerCap).map((x) => boundSubtree(x, containerCap, depth + 1));
  }
  if (v && typeof v === "object") {
    let keys;
    try { keys = Object.keys(v).slice(0, containerCap); } catch { return v; }
    const out = {};
    for (const k of keys) {
      let val;
      try { val = v[k]; } catch { val = "[unreadable value]"; }
      Object.defineProperty(out, k, {
        value: boundSubtree(val, containerCap, depth + 1),
        enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }
  return v;
}

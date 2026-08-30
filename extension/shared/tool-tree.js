// lib/tool-tree.js — the STRUCTURED tool-call renderer's pure core.
// DOM-free (unit-testable in Deno): recognize structured tool inputs/results,
// parse them safely (objects + a bounded/defensive decode of JSON STRINGS,
// only when clearly JSON), and build a BOUNDED tree model the renderer turns
// into an accessible, explorable DOM tree.
//
// Bounds (a huge/deep payload must never hang the UI):
//   - parse budget   — a string is only ever decoded when it clearly begins a
//                      JSON value ({ or [) and is within PARSE_LIMIT bytes
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
export const TOOL_TREE_PARSE_LIMIT = 64 * 1024;

function withinParseBudget(value) {
  return utf8ByteLength(value) <= TOOL_TREE_PARSE_LIMIT;
}

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
export function safeParseOnce(value) {
  if (value === null || value === undefined) return { kind: "other", value, decoded: false };
  if (typeof value === "object") return { kind: "json", value, decoded: false };
  if (typeof value !== "string") return { kind: "other", value, decoded: false };
  const t = value.trim();
  const stringLiteral = t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"';
  if ((!looksJsonish(t) && !stringLiteral) || !withinParseBudget(t)) {
    return { kind: "string", value, decoded: false };
  }
  try {
    const parsed = JSON.parse(t);
    return typeof parsed === "object" && parsed !== null
      ? { kind: "json", value: parsed, decoded: true }
      : { kind: "string", value: parsed, decoded: true };
  } catch {
    return { kind: "string", value, decoded: false };
  }
}

export function safeParse(value) {
  if (value === null || value === undefined) return { kind: "other", value, decoded: false };
  if (typeof value === "object") return { kind: "json", value, decoded: false };
  if (typeof value === "string") {
    const t = value.trim();
    // A decode candidate: clearly a JSON object/array ({ or [) OR a JSON
    // STRING LITERAL (a leading " with a closing " — a double-encoded tool
    // result wraps its JSON string in quotes). Always bounded by the budget.
    const stringLiteral = t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"';
    if ((looksJsonish(t) || stringLiteral) && withinParseBudget(t)) {
      try {
        const once = JSON.parse(t);
        // The defensive SECOND decode: only when the first decode produced a
        // STRING that itself clearly begins a JSON value (a double-encoded
        // tool result) — never on arbitrary text.
        if (typeof once === "string") {
          const t2 = once.trim();
          if (looksJsonish(t2) && withinParseBudget(t2)) {
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
  // Code-point-safe (never splits a surrogate pair, drops lone surrogates);
  // byte-bounded at `max` — the safe direction for a display cap.
  return { text: truncateUtf8(str, Math.max(1, max - 1)) + "…", truncated: true };
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

/** How wide an inline container preview may be. A preview sits on one row of a
 *  transcript beside the key and the type label, so it is deliberately short —
 *  it exists to make the row identifiable, not to replace expanding it. */
export const TOOL_TREE_PREVIEW_CHARS = 72;

/** Keys that identify a row to a HUMAN, most identifying first. A tab is its
 *  title, a search hit its name, a file its path. Without this, an array of ten
 *  objects renders as ten identical `object · 10` rows and every one of them
 *  has to be opened to find out which is which — the exact thing the product
 *  owner reported ("the tools calling bubbles don't help as much"). */
const PREVIEW_KEYS = [
  "title", "name", "label", "summary", "description", "message", "text",
  "url", "path", "file", "query", "kind", "type", "status",
  // `id` and `key` rank LAST deliberately. A row that reads "7" tells a human
  // nothing, so a bare identifier is the fallback of last resort rather than
  // the first choice its position in a payload would suggest.
  "id", "key",
];

/**
 * A short, human-readable preview of a container's CONTENT.
 *
 * Objects prefer an identifying field; failing that, the first a couple of
 * scalar entries as `key: value`. Arrays preview their first few scalars, or
 * recurse ONE level to preview their first element when they hold objects.
 *
 * Returns "" when nothing useful can be said — an empty preview must render
 * nothing rather than an empty gap, because a preview that is sometimes blank
 * and sometimes not is worse than no preview at all.
 */
export function containerPreview(v, { chars = TOOL_TREE_PREVIEW_CHARS, depth = 0 } = {}) {
  if (v === null || typeof v !== "object") return "";
  const clip = (s) => {
    const one = String(s).replace(/\s+/g, " ").trim();
    // Code-point-safe clip (never splits a surrogate pair) — a code-unit
    // slice here split "📡"-class pairs into lone surrogates.
    return one.length > chars ? truncateUtf8(one, Math.max(1, chars - 1)) + "…" : one;
  };
  const scalar = (x) => {
    if (x === null) return "null";
    const t = typeof x;
    if (t === "string") return x;
    if (t === "number" || t === "boolean") return String(x);
    return null; // containers are not scalars; the caller decides what to do
  };

  if (Array.isArray(v)) {
    if (v.length === 0) return "empty";
    const scalars = [];
    for (const item of v.slice(0, 4)) {
      const sc = scalar(item);
      if (sc === null) { scalars.length = 0; break; }
      scalars.push(sc);
    }
    if (scalars.length) return clip(scalars.join(", "));
    // An array of containers: the first element's own preview stands in for the
    // array, which is what makes a list of tabs read as tabs. Bounded to one
    // extra level so a deep payload cannot walk itself.
    if (depth >= 1) return "";
    const inner = containerPreview(v[0], { chars, depth: depth + 1 });
    return inner ? clip(`${inner}…`) : "";
  }

  let keys;
  try { keys = Object.keys(v); } catch { return ""; }
  if (keys.length === 0) return "empty";
  for (const k of PREVIEW_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    let raw;
    try { raw = v[k]; } catch { continue; }
    const sc = scalar(raw);
    if (sc !== null && String(sc).trim() !== "") return clip(sc);
  }
  // No identifying field — the first scalar entries, named, so the row still
  // says something specific about ITSELF.
  const parts = [];
  for (const k of keys.slice(0, 6)) {
    let raw;
    try { raw = v[k]; } catch { continue; }
    const sc = scalar(raw);
    if (sc === null) continue;
    parts.push(`${k}: ${sc}`);
    if (parts.length === 2) break;
  }
  return parts.length ? clip(parts.join(" · ")) : "";
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
  // Nested JSON-string decodes allowed for the WHOLE tree (one logical
  // payload could nest several times; the budget stops a hostile
  // string-of-string-of-string from recursing without bound).
  const decodeBudget = { n: opts.maxNestedDecodes ?? 8 };
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
          push({ segments, key, kind: "array", depth, leaf: false, count: v.length, capped: true, text: `[${v.length}] (depth capped)`, preview: containerPreview(v), source: "json" });
          return;
        }
        const arrayCapped = v.length > containerCap;
        if (arrayCapped) truncated = true;
        push({ segments, key, kind: "array", depth, leaf: false, count: Math.min(v.length, containerCap), capped: arrayCapped, preview: containerPreview(v), source: "json" });
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
        push({ segments, key, kind: "object", depth, leaf: false, count: Math.min(keys.length, containerCap), capped: true, text: `{${keys.length}} (depth capped)`, preview: containerPreview(v), source: "json" });
        return;
      }
      const objCapped = keys.length > containerCap;
      if (objCapped) truncated = true;
      push({ segments, key, kind: "object", depth, leaf: false, count: Math.min(keys.length, containerCap), capped: objCapped, preview: containerPreview(v), source: "json" });
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
    // A leaf string that is itself an embedded JSON payload (a tool result
    // double-encoded into a field) is DECODED and rendered as a subtree — the
    // owner's "big unreadable JSON blob" complaint. Bounded: the string must
    // clearly begin a JSON value, fit the parse budget, and the per-tree
    // decode budget (shared across the whole tree) stops pathological nesting.
    if (typeof v === "string" && decodeBudget.n > 0 && withinParseBudget(v) && looksJsonish(v)) {
      let decoded;
      try { decoded = JSON.parse(v); } catch { decoded = undefined; }
      if (decoded !== null && typeof decoded === "object") {
        decodeBudget.n -= 1;
        visit(segments, key, decoded, depth, chain);
        return;
      }
    }
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
 * boundary. Every container is BUILT ATOMICALLY (fragments are assembled in a
 * local array and only emitted whole) — a hostile proxy whose `length` getter
 * throws can never leave an unclosed `[` in the output (the parent emits a
 * single safe marker instead). Bounds are enforced in UTF-8 BYTES via
 * TextEncoder (a byte-breach returns a valid JSON __gvs_truncated__ envelope,
 * itself byte-bounded); secret-like keys are redacted before serialization.
 * Cycle-vs-alias: only an ANCESTOR is "[cyclic]" — shared refs serialize in
 * full each time they are reached.
 */
// The CANONICAL secret-key matcher (shared with lib/pure.js — one semantic,
// never a divergent anchored copy): any key matching it is redacted before it
// reaches the UI/serializer or a truncation preview.
import { SECRET_KEY_RE, redactSecretText, truncateUtf8, utf8ByteLength } from "../lib/pure.js";
const SECRET_KEY = SECRET_KEY_RE;

/** The smallest maxBytes the serializer can honor (the fixed envelope + a
 * preview must fit) — a smaller cap is a caller contract violation (RangeError),
 * never a silently-oversized result. */
export const SAFE_JSON_MIN_MAX_BYTES = 64;

export function safeJsonStringify(value, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const maxNodes = opts.maxNodes ?? 500;
  const maxBytes = opts.maxBytes ?? 32 * 1024;
  const maxString = opts.maxString ?? 400;
  if (!Number.isFinite(maxBytes) || maxBytes < SAFE_JSON_MIN_MAX_BYTES) {
    throw new RangeError(`safeJsonStringify maxBytes must be >= ${SAFE_JSON_MIN_MAX_BYTES} (got ${maxBytes})`);
  }
  let nodes = 0;
  let truncated = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const esc = (str) => JSON.stringify(str) ?? JSON.stringify(String(str));
  const cut = (str) => (str.length > maxString ? truncateUtf8(str, Math.max(1, maxString - 1)) + "…" : str);

  const visit = (v, depth, chain) => {
    if (nodes >= maxNodes) { truncated = true; return null; }
    nodes += 1;
    if (v === null || v === undefined) return "null";
    const t = typeof v;
    if (t === "string") return esc(cut(v));
    if (t === "number") return Number.isFinite(v) ? String(v) : "null";
    if (t === "boolean") return String(v);
    if (t === "bigint") return esc(String(v) + "n");
    if (t === "object") {
      if (chain.has(v)) return '"[cyclic]"'; // an ANCESTOR only
      chain.add(v);
      try {
        if (Array.isArray(v)) {
          // READ the length FIRST (a throwing proxy length getter must not
          // emit a fragment — the container is built atomically below)
          let len;
          try { len = v.length; } catch { chain.delete(v); return '"[unserializable]"'; }
          if (depth >= maxDepth) { chain.delete(v); return '"[depth capped]"'; }
          const parts = ["["];
          const cap = Math.min(len, 100);
          for (let i = 0; i < cap && !truncated; i++) {
            if (i > 0) parts.push(",");
            let item;
            try { item = v[i]; } catch { item = "[unreadable]"; }
            parts.push(visit(item, depth + 1, chain) ?? '"[unserializable]"');
          }
          if (len > cap) parts.push(`,"[${len - cap} more items]"`);
          parts.push("]");
          chain.delete(v);
          return parts.join("");
        }
        let keys;
        try { keys = Object.keys(v); } catch { chain.delete(v); return '"[unserializable]"'; }
        if (depth >= maxDepth) { chain.delete(v); return '"[depth capped]"'; }
        const parts = ["{"];
        const cap = Math.min(keys.length, 100);
        for (let i = 0; i < cap && !truncated; i++) {
          if (i > 0) parts.push(",");
          const k = keys[i];
          parts.push(esc(k) + ":");
          let val;
          try { val = v[k]; } catch { val = "[unreadable]"; }
          // secret-like fields are REDACTED before they reach the UI/serializer
          parts.push(SECRET_KEY.test(k) ? '"[redacted]"' : (visit(val, depth + 1, chain) ?? '"[unserializable]"'));
        }
        if (keys.length > cap) parts.push(`,"[${keys.length - cap} more keys]"`);
        parts.push("}");
        chain.delete(v);
        return parts.join("");
      } catch {
        chain.delete(v);
        return '"[unserializable]"';
      }
    }
    return '"[value]"';
  };

  if (typeof value === "string") {
    // a VALID JSON string literal — BOUNDED to maxBytes (a huge root string
    // must never exceed the cap): shrink the string (byte-aware) until the
    // escaped output fits; an impossible cap yields the minimal envelope.
    let str = value.length > maxString ? truncateUtf8(value, Math.max(1, maxString - 1)) + "…" : value;
    let jsonStr = esc(str);
    let guard = 0;
    while (encoder.encode(jsonStr).length > maxBytes && str.length > 1 && guard++ < 32) {
      // Byte-proportional shrink, code-point-safe (a code-unit slice can split
      // a surrogate pair and leak lone surrogates into the journal).
      const curBytes = encoder.encode(jsonStr).length;
      const target = Math.max(1, Math.floor(encoder.encode(str).length * (maxBytes * 0.9) / curBytes));
      str = truncateUtf8(str, target);
      jsonStr = esc(str);
    }
    if (encoder.encode(jsonStr).length > maxBytes) return '{"__gvs_truncated__":true}';
    return jsonStr;
  }
  let json = visit(value, 0, new Set()) ?? '"[unserializable]"';
  const bytes = encoder.encode(json);
  if (bytes.length > maxBytes) {
    // The explicit truncation envelope — GUARANTEED valid JSON with encoded
    // size <= maxBytes for EVERY maxBytes: the preview budget shrinks until the
    // total (including the envelope + the JSON escaping of the preview, which
    // can EXPAND for quote/backslash-heavy content) fits; for a maxBytes too
    // small to hold the full envelope, a MINIMAL valid envelope is returned.
    let budget = Math.max(8, maxBytes - 120);
    let preview = decoder.decode(bytes.slice(0, budget));
    let env = `{"__gvs_truncated__":true,"bytes":${bytes.length},"preview":${esc(preview)}}`;
    let guard = 0;
    while (encoder.encode(env).length > maxBytes && budget > 8 && guard++ < 32) {
      budget = Math.floor(budget / 2);
      preview = decoder.decode(bytes.slice(0, budget));
      env = `{"__gvs_truncated__":true,"bytes":${bytes.length},"preview":${esc(preview)}}`;
    }
    if (encoder.encode(env).length > maxBytes) {
      env = '{"__gvs_truncated__":true}'; // the minimal valid envelope (always <= maxBytes for maxBytes >= 32)
    }
    json = env;
  }
  return json;
}

/** The subtree JSON for a row addressed by its SEGMENT array. Bounded +
 * never throws (a cyclic/BigInt/getter value falls back to a marker). When the
 * containerCap OMITS entries (a small 51-item container, not just a >4096-char
 * blob), or the preview budget is exceeded, the copy returns an EXPLICIT
 * truncation envelope — always VALID JSON with __gvs_truncated__ metadata —
 * so a pasted copy is never silently incomplete. */
export function subtreeJson(value, segments, containerCap = TOOL_TREE_CONTAINER_CAP) {
  let cur = value;
  for (const s of segments) {
    if (cur == null) return "null";
    try {
      cur = Array.isArray(cur) ? cur[Number(s)] : cur[s];
    } catch { return '"[unreadable value]"'; }
  }
  const { value: bound, capped } = boundSubtree(cur, containerCap);
  try {
    const s = JSON.stringify(bound);
    if (s == null) return "null";
    if (!capped && s.length <= 4096) return s;
    // the explicit truncation envelope (the preview is a JSON string — valid)
    return `{"__gvs_truncated__":true,"bytes":${s.length},"omitted":${capped},"preview":${JSON.stringify(s.slice(0, 4096))}}`;
  } catch {
    return '"[unserializable subtree]"';
  }
}

/** A bounded copy of a subtree (depth + per-container caps) for copy-JSON.
 * Returns { value, capped } — `capped` is true whenever ANY container omitted
 * entries (an explicit metadata signal the copy MUST carry — never a silently
 * incomplete paste). Keys are installed with defineProperty so "__proto__"
 * stays DATA (it must never mutate the prototype of the copied object). */
function boundSubtree(v, containerCap, depth = 0, cappedRef = { v: false }) {
  if (depth > TOOL_TREE_MAX_DEPTH) { cappedRef.v = true; return { value: "…", capped: cappedRef.v }; }
  if (Array.isArray(v)) {
    const capped = v.length > containerCap;
    if (capped) cappedRef.v = true;
    return { value: v.slice(0, containerCap).map((x) => boundSubtree(x, containerCap, depth + 1, cappedRef).value), capped: cappedRef.v };
  }
  if (v && typeof v === "object") {
    let keys;
    try { keys = Object.keys(v); } catch { return { value: v, capped: cappedRef.v }; }
    const capped = keys.length > containerCap;
    if (capped) cappedRef.v = true;
    const out = {};
    for (const k of keys.slice(0, containerCap)) {
      let val;
      try { val = v[k]; } catch { val = "[unreadable value]"; }
      Object.defineProperty(out, k, {
        value: boundSubtree(val, containerCap, depth + 1, cappedRef).value,
        enumerable: true, writable: true, configurable: true,
      });
    }
    return { value: out, capped: cappedRef.v };
  }
  return { value: v, capped: cappedRef.v };
}

/**
 * journalJson — the ONE serializer for persisted/broadcast tool-call payloads
 * (the tool-call clarity fix). The old journal path did
 * `JSON.stringify(v).slice(0, 2000) + "…"` — MID-STRING truncation that
 * corrupted JSON, so the structured renderer could never parse a journaled
 * payload and fell back to a raw one-line blob. This helper:
 *   1. redacts credential-shaped strings (redactSecretText — key: sk-…,
 *      Bearer …, apiKey=… patterns) at the text level,
 *   2. serializes with safeJsonStringify (secret KEYS → "[redacted]", bounded
 *      nodes/strings) so the output is ALWAYS valid parseable JSON for
 *      objects (plain strings pass through as redacted bounded text),
 *   3. serializes with headroom so the post-redaction text stays ≤ maxBytes
 *      without a second (corrupting) truncation — redaction only ever
 *      shortens or marks, and the headroom absorbs the marker delta.
 * Never throws.
 */
export function journalJson(value, opts = {}) {
  const maxBytes = opts.maxBytes ?? 2000;
  const headroom = Math.max(SAFE_JSON_MIN_MAX_BYTES, maxBytes - 64);
  const utf8 = new TextEncoder();
  let s;
  if (typeof value === "string") {
    // A PRE-STRINGIFIED JSON payload must never be slice-truncated (that
    // corrupts it — the exact bug this replaces): decode then re-serialize
    // bounded so the journal stays parseable; genuinely plain text is simply
    // bounded as text.
    const t = value.trim();
    const maybeJson = (looksJsonish(t) || (t.startsWith('"') && t.endsWith('"'))) && t.length <= TOOL_TREE_PARSE_LIMIT;
    let parsed;
    if (maybeJson) { try { parsed = JSON.parse(t); } catch { parsed = undefined; } }
    if (parsed !== undefined) {
      try { s = safeJsonStringify(parsed, { maxBytes: headroom, maxNodes: 80, maxString: 400 }); }
      catch { s = "\"[unserializable value]\""; }
    } else {
      // `headroom` is a BYTE budget — UTF-16 length under-counts multibyte
      // text (and a code-unit slice can split a surrogate pair), so bound by
      // encoded bytes, reserving the ellipsis's 3 bytes.
      s = utf8.encode(value).length > headroom
        ? truncateUtf8(value, Math.max(1, headroom - 3)) + "…"
        : value;
    }
  } else {
    try {
      s = safeJsonStringify(value, { maxBytes: headroom, maxNodes: 80, maxString: 400 });
    } catch {
      s = "\"[unserializable value]\"";
    }
  }
  try {
    return redactSecretText(s);
  } catch {
    return s;
  }
}

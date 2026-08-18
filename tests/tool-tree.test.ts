// @ts-nocheck — the tree rows are a discriminated union; the runtime shape is what's under test.
// tests/tool-tree.test.ts — the structured tool-call renderer's pure core
// (lib/tool-tree.js): safe bounded parsing, the tree model, and every
// regression case the tracker demands — nested objects/arrays, escaped JSON
// strings, Unicode, malformed JSON, huge/deep payload bounds,
// null/booleans/numbers, and tool-error-shaped results.
import { assertEquals, assert } from "jsr:@std/assert";
import {
  looksJsonish,
  safeJsonStringify,
  safeParse,
  buildTree,
  subtreeJson,
  TOOL_TREE_MAX_DEPTH,
  TOOL_TREE_MAX_NODES,
  TOOL_TREE_CONTAINER_CAP,
  TOOL_TREE_PARSE_LIMIT,
} from "../extension/shared/tool-tree.js";

Deno.test("tool-tree: an object parses to a json kind with rows", () => {
  const p = safeParse({ a: 1 });
  assertEquals(p.kind, "json");
  const t = buildTree(p.value);
  assert(t.rows.length >= 2, "container row + leaf row");
  assert(t.rows[0].kind === "object");
  assert(t.rows.some((r) => r.key === "a" && r.text === "1"));
});

Deno.test("tool-tree: a JSON STRING decodes (bounded) into a tree", () => {
  const s = JSON.stringify({ key: "shopping", items: [{ name: "x", qty: 1 }] });
  const p = safeParse(s);
  assertEquals(p.kind, "json");
  assertEquals(p.decoded, true);
  const t = buildTree(p.value);
  assert(t.rows.some((r) => r.key === "name" && r.text === "x"), "nested key present");
  assert(t.rows.some((r) => r.key === "qty" && r.text === "1"), "nested number present");
});

Deno.test("tool-tree: the DEFENSIVE SECOND decode handles a double-encoded JSON string", () => {
  const inner = JSON.stringify({ a: [1, 2], b: "x" });
  const double = JSON.stringify(inner); // a JSON string whose VALUE is a JSON string
  const p = safeParse(double);
  assertEquals(p.kind, "json");
  assertEquals(p.decoded, true);
  const t = buildTree(p.value);
  assert(t.rows.some((r) => r.key === "a" && r.kind === "array"), "inner array present");
});

Deno.test("tool-tree: nested arrays + objects expand into a full tree", () => {
  const value = { items: [{ name: "A", tags: ["kitchen", "appliance"] }, { name: "B" }], meta: { deep: { ratio: 0.75 } } };
  const t = buildTree(value);
  const segs = new Set(t.rows.map((r) => r.segments.join(".")));
  assert(segs.has("items.0.name"));
  assert(segs.has("items.0.tags.1"));
  assert(segs.has("meta.deep.ratio"));
  assert(t.rows.find((r) => r.segments.join(".") === "meta.deep.ratio").text === "0.75");
});

Deno.test("tool-tree: escaped JSON (quotes, backslashes, newlines) decodes + renders cleanly", () => {
  const raw = JSON.stringify({ note: "line one\n\"quoted\" \\ backslash" });
  const p = safeParse(raw);
  assertEquals(p.kind, "json");
  const t = buildTree(p.value);
  const note = t.rows.find((r) => r.key === "note");
  assert(note && note.text.includes('"quoted"'), "the escaped quotes are PRESENT as literal characters, not \\\" artifacts");
  assert(note && note.text.includes("\\"), "the backslash is a literal character");
});

Deno.test("tool-tree: Unicode (incl. CJK + combining) survives parse + render", () => {
  const raw = JSON.stringify({ label: "ünïçødé 日本語 — café" });
  const t = buildTree(safeParse(raw).value);
  const label = t.rows.find((r) => r.key === "label");
  assert(label && label.text === "ünïçødé 日本語 — café");
});

Deno.test("tool-tree: malformed JSON falls back to a readable plain-text leaf", () => {
  const bad = '{"key": "unterminated';
  const p = safeParse(bad);
  assertEquals(p.kind, "string"); // NOT json — a plain-text fallback
  const t = buildTree(p.value);
  assertEquals(t.rows.length, 1);
  assertEquals(t.rows[0].text, bad);
});

Deno.test("tool-tree: non-JSON text never decodes (a readable fallback)", () => {
  const p = safeParse("just some text 42");
  assertEquals(p.kind, "string");
  const t = buildTree(p.value);
  assertEquals(t.rows[0].text, "just some text 42");
});

Deno.test("tool-tree: null / booleans / numbers render exact leaves", () => {
  const value = { nil: null, yes: true, no: false, n: 3.5, neg: -2 };
  const t = buildTree(value);
  const byKey = Object.fromEntries(t.rows.filter((r) => r.key).map((r) => [r.key, r]));
  assertEquals(byKey.nil.text, "null");
  assertEquals(byKey.nil.kind, "null");
  assertEquals(byKey.yes.text, "true");
  assertEquals(byKey.no.text, "false");
  assertEquals(byKey.n.text, "3.5");
  assertEquals(byKey.neg.text, "-2");
});

Deno.test("tool-tree: a root SCALAR still renders a single row", () => {
  assertEquals(buildTree(42).rows[0].text, "42");
  assertEquals(buildTree("hello").rows[0].text, "hello");
  assertEquals(buildTree(null).rows[0].text, "null");
  assertEquals(buildTree(true).rows[0].text, "true");
});

Deno.test("tool-tree: DEEP payloads are depth-capped (no stack explosion, no UI hang)", () => {
  let deep = "x";
  for (let i = 0; i < 2000; i++) deep = { deep }; // 2000 levels
  const t = buildTree(deep);
  const maxDepth = Math.max(...t.rows.map((r) => r.depth));
  assert(maxDepth <= TOOL_TREE_MAX_DEPTH, `depth capped at ${TOOL_TREE_MAX_DEPTH} (got ${maxDepth})`);
  assert(t.truncated, "the depth cap marks the tree truncated");
});

Deno.test("tool-tree: HUGE payloads are node-capped (bounded memory/rows)", () => {
  const big = [];
  for (let i = 0; i < 10_000; i++) big.push({ i, v: "x".repeat(200) });
  const t = buildTree(big);
  assert(t.rows.length <= TOOL_TREE_MAX_NODES, `rows bounded (${t.rows.length} <= ${TOOL_TREE_MAX_NODES})`);
  assert(t.truncated, "the node cap marks the tree truncated");
  const arr = t.rows[0];
  assert(arr.kind === "array" && arr.capped, "per-container cap surfaced");
  assert(arr.count <= TOOL_TREE_CONTAINER_CAP);
});

Deno.test("tool-tree: HUGE strings truncate with a marker + the full text retained", () => {
  const value = { note: "z".repeat(10_000) };
  const t = buildTree(value);
  const note = t.rows.find((r) => r.key === "note");
  assert(note.text.endsWith("…"), "truncation marker present");
  assert(note.text.length < 500);
  assert(note.full && note.full.length === 10_000, "full text retained for copy/title");
});

Deno.test("tool-tree: a huge JSON STRING beyond the parse budget is NOT decoded (stays plain text)", () => {
  const huge = "[" + "x".repeat(TOOL_TREE_PARSE_LIMIT + 1) + "]";
  const p = safeParse(huge);
  assertEquals(p.kind, "string"); // parse budget refused — no hang, no giant tree
});

Deno.test("tool-tree: a tool-error-shaped result renders as a tree, not a crash", () => {
  const value = { ok: false, error: "run aborted — memory not written", reason: "origin re-enrolled" };
  const t = buildTree(value);
  assert(t.rows.some((r) => r.key === "ok" && r.text === "false"));
  assert(t.rows.some((r) => r.key === "error"));
  assert(t.rows.some((r) => r.key === "reason"));
});

Deno.test("tool-tree: safeParse never throws on adversarial input", () => {
  for (const bad of ["{", "[", '{"a":', "undefined", "NaN", "Infinity", "", "   ", '{"a":1', "[[[[[", "\u0000"]) {
    const r = safeParse(bad); // must not throw
    assert(typeof r.kind === "string", `kind for ${JSON.stringify(bad)}`);
  }
});

Deno.test("tool-tree: subtreeJson copies a bounded subtree for copy-JSON", () => {
  const value = { items: Array.from({ length: 200 }, (_, i) => ({ i, v: "x" })), meta: { n: 1 } };
  const t = buildTree(value);
  const items = t.rows.find((r) => r.segments.join(".") === "items");
  if (!items) throw new Error("items row missing");
  const json = subtreeJson(value, items.segments);
  const parsed = JSON.parse(json);
  // a container-cap omission ALWAYS carries explicit truncation metadata
  if (parsed.__gvs_truncated__ === true) {
    const preview = JSON.parse(parsed.preview);
    assert(preview.length <= TOOL_TREE_CONTAINER_CAP, "the bounded preview respects the cap");
    assert(preview[0].i === 0);
  } else {
    assert(parsed.length <= TOOL_TREE_CONTAINER_CAP, "the copied JSON is bounded");
    assert(parsed[0].i === 0);
  }
  assertEquals(subtreeJson(value, []).startsWith("{"), true, "root copy starts with {");
});

Deno.test("tool-tree: looksJsonish only accepts clear JSON value starts", () => {
  assert(looksJsonish('{"a":1}'));
  assert(looksJsonish("[1,2]"));
  assert(!looksJsonish("hello"));
  assert(!looksJsonish("42"));
  assert(!looksJsonish("null"));
  assert(!looksJsonish(""));
});

// ── the k3 review's path/a11y-safety regressions ───────────────────────────

Deno.test("tool-tree: a DOTTED key is ONE segment (expansion + copy stay correct)", () => {
  const value = { "a.b": { "c.d": 42 }, plain: 1 };
  const t = buildTree(value);
  const row = t.rows.find((r) => r.key === "a.b");
  assert(row && !row.leaf, "a.b is a container");
  assert(JSON.stringify(row.segments) === JSON.stringify(["a.b"]), "ONE segment, never split on '.'");
  const deep = t.rows.find((r) => r.key === "c.d");
  assert(deep && deep.text === "42", "the nested dotted key is one segment too");
  // copy-JSON of the dotted-key subtree addresses by segment array
  const json = subtreeJson(value, ["a.b"]);
  const parsed = JSON.parse(json);
  assertEquals(parsed["c.d"], 42);
  const root = subtreeJson(value, []);
  assert(root.startsWith("{"));
});

Deno.test("tool-tree: EMPTY + numeric-looking keys keep their identity", () => {
  const value = { "": "empty-key", "0": "zero", "01": "leading", "1.5": "decimal" };
  const t = buildTree(value);
  // the EMPTY key is a real row addressed by its SEGMENT ([""]) — the lookup
  // must not rely on `key` (an empty key is falsy, and the root row also has
  // key ""), so address rows by their segment arrays.
  const emptyRow = t.rows.find((r) => r.segments.length === 1 && r.segments[0] === "");
  assert(emptyRow && emptyRow.text === "empty-key", "the empty-string key is ONE segment");
  const byKey = Object.fromEntries(t.rows.filter((r) => r.key).map((r) => [r.key, r]));
  assertEquals(byKey["0"].text, "zero");
  assertEquals(byKey["01"].text, "leading");
  assertEquals(byKey["1.5"].text, "decimal");
  assertEquals(subtreeJson(value, ["0"]), '"zero"');
  assertEquals(subtreeJson(value, ["01"]), '"leading"');
  assertEquals(subtreeJson(value, ["1.5"]), '"decimal"');
  assertEquals(subtreeJson(value, [""]), '"empty-key"');
});

Deno.test("tool-tree: __proto__ is retained as DATA (never mutates the prototype)", () => {
  // JSON.parse creates a REAL "__proto__" DATA key (an object literal's
  // __proto__ special form would set the prototype instead — the model must
  // handle the data-key case).
  const value = JSON.parse("{\"safe\":{\"__proto__\":{\"polluted\":true},\"x\":1}}");
  const t = buildTree(value);
  assert(t.rows.some((r) => r.key === "__proto__"), "the __proto__ key is a normal row");
  const json = subtreeJson(value, ["safe"]);
  const parsed = JSON.parse(json);
  assertEquals(parsed["__proto__"].polluted, true, "the key round-trips as data");
  assertEquals(Object.prototype.polluted, undefined, "the global Object prototype is untouched");
  assertEquals({}.polluted, undefined, "plain objects are unpolluted");
});

Deno.test("tool-tree: a CYCLIC object renders a bounded leaf (never an infinite recursion)", () => {
  const a = { name: "loop" };
  a.self = a;
  const t = buildTree(a);
  const cyclic = t.rows.find((r) => r.cyclic === true || r.text === "[cyclic]");
  assert(cyclic, "the cycle is rendered as a bounded leaf");
  assert(t.rows.length < 20, "bounded rows (no recursion blowup)");
});

Deno.test("tool-tree: subtreeJson never throws (cyclic / BigInt / unreadable values)", () => {
  const a = { n: 1 };
  a.self = a;
  assertEquals(typeof subtreeJson(a, []), "string", "a cyclic root copy falls back");
  const big = { n: 10n };
  assertEquals(typeof subtreeJson(big, []), "string", "a BigInt copy falls back");
  const getter = { get boom() { throw new Error("getter"); } };
  assertEquals(typeof subtreeJson(getter, ["boom"]), "string");
});

Deno.test("tool-tree: buildTree survives getter throws + symbol keys", () => {
  const evil = {
    get boom() { throw new Error("getter"); },
    ok: 1,
  };
  const t = buildTree(evil);
  assert(t.rows.some((r) => r.key === "ok" && r.text === "1"));
});


Deno.test("tool-tree: safeJsonStringify never throws at the PUBLIC boundary (cyclic/BigInt/getter)", () => {
  const a = { n: 1 };
  a.self = a;
  assertEquals(safeJsonStringify(a), '{"n":1,"self":"[cyclic]"}', "cyclic → [cyclic] marker");
  assertEquals(safeJsonStringify({ n: 10n }), '{"n":"10n"}', "BigInt → suffixed string");
  const g = { get boom() { throw new Error("getter"); } };
  assert(typeof safeJsonStringify(g) === "string", "a throwing getter falls back, never throws");
  assertEquals(safeJsonStringify("plain"), '"plain"'); // a VALID JSON string literal
  assertEquals(safeJsonStringify(null), "null");
  assertEquals(safeJsonStringify({ key: "x", items: [1, 2] }), '{"key":"x","items":[1,2]}');
});

// ── the sol-review serializer hardening (never throws, cycle-vs-alias, bounds) ──

Deno.test("tool-tree: safeJsonStringify never throws on hostile toJSON/toString getters", () => {
  const toJson = { get toJSON() { throw new Error("toJSON"); } };
  let out;
  try { out = safeJsonStringify(toJson); } catch (e) { throw new Error("threw: " + e.message); }
  assert(typeof out === "string");
  const toString = {};
  Object.defineProperty(toString, "toString", { get() { throw new Error("toString"); } });
  let out2;
  try { out2 = safeJsonStringify({ k: toString }); } catch (e) { throw new Error("threw: " + e.message); }
  assert(typeof out2 === "string");
  // both toJSON AND toString hostile
  const evil = { get toJSON() { throw new Error("j"); } };
  Object.defineProperty(evil, "toString", { get() { throw new Error("s"); } });
  let out3;
  try { out3 = safeJsonStringify({ a: evil }); } catch (e) { throw new Error("threw: " + e.message); }
  assert(typeof out3 === "string");
});

Deno.test("tool-tree: safeJsonStringify distinguishes CYCLES from ALIASES", () => {
  const a = { n: 1 };
  a.self = a;
  assertEquals(safeJsonStringify(a), '{"n":1,"self":"[cyclic]"}', "a true cycle → [cyclic]");
  const shared = { n: 1 };
  const withAlias = { a: shared, b: shared };
  const aliasJson = safeJsonStringify(withAlias);
  const parsed = JSON.parse(aliasJson);
  assertEquals(parsed.a.n, 1, "the alias serializes in full the first time");
  assertEquals(parsed.b.n, 1, "a shared ref is NOT labelled [cyclic]");
  assert(!aliasJson.includes("[cyclic]"), "no false [cyclic] for aliases");
});

Deno.test("tool-tree: safeJsonStringify is BOUNDED (depth/node/byte caps) + always valid JSON", () => {
  let deep = "x";
  for (let i = 0; i < 60; i++) deep = { deep };
  const d = safeJsonStringify(deep);
  assert(JSON.parse(d) !== null, "deep output is valid JSON (in-band marker or envelope)");
  const big = Array.from({ length: 10000 }, (_, i) => ({ i, pad: "x".repeat(40) }));
  const b = safeJsonStringify(big);
  assert(JSON.parse(b) !== null, "huge output is valid JSON");
  assert(b.length < 40_000, "bounded output size");
});

// ── the final-sol acceptance: atomic hostile-proxy, UTF-8 envelope, redaction ──

Deno.test("tool-tree: a HOSTILE ARRAY PROXY (throwing length getter) never emits invalid JSON", () => {
  const proxy = new Proxy([], { get(t, p) { if (p === "length") throw new Error("length"); return t[p]; } });
  const out = safeJsonStringify({ items: proxy, ok: 1 });
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { throw new Error("invalid JSON: " + e.message); }
  assertEquals(parsed.ok, 1, "the sibling key survives");
  assert(typeof parsed.items === "string", "the hostile container falls back to a marker");
});

Deno.test("tool-tree: the UTF-8 truncation envelope is VALID JSON and BYTE-bounded for every maxBytes", () => {
  const content = Array.from({ length: 60 }, (_, i) => ({ i, q: 'quote"back\\slash"', u: "日本語".repeat(20) }));
  for (const mb of [64, 120, 300, 1000, 5000]) {
    const out = safeJsonStringify(content, { maxBytes: mb });
    const bytes = new TextEncoder().encode(out).length;
    let parsed;
    try { parsed = JSON.parse(out); } catch (e) { throw new Error(`maxBytes=${mb}: invalid JSON — ${e.message}`); }
    assert(bytes <= mb, `maxBytes=${mb}: output is ${bytes} bytes (over the cap)`);
    if (parsed.__gvs_truncated__ === true) {
      // the minimal envelope (a maxBytes too small for a preview) is still
      // valid; when a preview IS present it must be a JSON string
      if (parsed.preview !== undefined) {
        assertEquals(typeof parsed.preview, "string", "the preview is a JSON string");
      }
      if (parsed.bytes !== undefined) {
        assertEquals(typeof parsed.bytes, "number", "the byte count is present");
      }
    }
  }
});

Deno.test("tool-tree: secret-like fields are REDACTED before serialization", () => {
  const out = safeJsonStringify({ apiKey: "sk-secret", token: "abc", password: "pw", ok: 1, nested: { access_token: "x", label: "keep" } });
  const parsed = JSON.parse(out);
  assertEquals(parsed.apiKey, "[redacted]");
  assertEquals(parsed.token, "[redacted]");
  assertEquals(parsed.password, "[redacted]");
  assertEquals(parsed.nested.access_token, "[redacted]");
  assertEquals(parsed.nested.label, "keep");
  assert(!out.includes("sk-secret"), "the secret value never reaches the output");
  assert(!out.includes("abc"), "the token never reaches the output");
});

// ── the frozen-tip acceptance: tiny caps, broad secrets, JSON-string contract ──

Deno.test("tool-tree: safeJsonStringify returns a VALID JSON string literal for a plain string", () => {
  const out = safeJsonStringify("plain");
  assertEquals(out, '"plain"', "the string is QUOTED — valid JSON");
  assertEquals(JSON.parse(out), "plain");
});

Deno.test("tool-tree: maxBytes below the documented MINIMUM throws an explicit RangeError (never oversized)", () => {
  for (const tiny of [8, 20, 27, 63]) {
    let threw = null;
    try { safeJsonStringify({ a: "x".repeat(50) }, { maxBytes: tiny }); } catch (e) { threw = e; }
    assert(threw instanceof RangeError, `maxBytes=${tiny} must throw a RangeError`);
  }
  // at the minimum the envelope always fits
  const out = safeJsonStringify({ a: "x".repeat(200) }, { maxBytes: 64 });
  assert(new TextEncoder().encode(out).length <= 64, "the minimum cap is honored");
  JSON.parse(out);
});

Deno.test("tool-tree: canonical credential keys (credential/bearer/accessKey/access_key) are REDACTED", () => {
  const out = safeJsonStringify({ credential: "c1", bearer: "b1", accessKey: "ak1", access_key: "ak2", apiKey: "k", ok: 1 });
  const parsed = JSON.parse(out);
  assertEquals(parsed.credential, "[redacted]");
  assertEquals(parsed.bearer, "[redacted]");
  assertEquals(parsed.accessKey, "[redacted]");
  assertEquals(parsed.access_key, "[redacted]");
  assertEquals(parsed.apiKey, "[redacted]");
  assertEquals(parsed.ok, 1);
  assert(!out.includes("c1") && !out.includes("b1") && !out.includes("ak1") && !out.includes("ak2"), "no secret value reaches the output");
});

// ── the successor review: root-string byte caps + canonical matcher aliases ──

Deno.test("tool-tree: ROOT STRINGS are byte-bounded for every supported maxBytes (huge ASCII/non-ASCII/escaping)", () => {
  const cases = [
    ["x".repeat(1000), 64],
    ["日本語".repeat(500), 64],
    ["quote\"back\\slash\"".repeat(200), 128],
    ["x".repeat(5000), 200],
    ["mixed ünïçødé \\\" quotes".repeat(300), 100],
  ];
  for (const [s, mb] of cases) {
    const out = safeJsonStringify(s, { maxBytes: mb });
    const bytes = new TextEncoder().encode(out).length;
    let parsed;
    try { parsed = JSON.parse(out); } catch (e) { throw new Error(`mb=${mb}: invalid JSON — ${e.message}`); }
    assert(bytes <= mb, `mb=${mb}: root string output is ${bytes} bytes (over the cap)`);
    assert(typeof parsed === "string" || parsed.__gvs_truncated__ === true, "the result is a JSON string or the minimal envelope");
  }
});

Deno.test("tool-tree: redaction uses the CANONICAL matcher — exhaustive aliases incl x-api-key", () => {
  const payload = {
    api_key: "1", apikey: "2", token: "3", secret: "4", password: "5", authorization: "6",
    credential: "7", bearer: "8", access_key: "9", accesskey: "10", "x-api-key": "11",
    ok: 1, label: "keep",
  };
  const out = safeJsonStringify(payload);
  const parsed = JSON.parse(out);
  for (const k of ["api_key", "apikey", "token", "secret", "password", "authorization", "credential", "bearer", "access_key", "accesskey", "x-api-key"]) {
    assertEquals(parsed[k], "[redacted]", `${k} is redacted`);
  }
  assertEquals(parsed.ok, 1);
  assertEquals(parsed.label, "keep");
  for (const v of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]) {
    assert(!out.includes(":" + JSON.stringify(v)), `the secret value ${v} never reaches the output`);
  }
});

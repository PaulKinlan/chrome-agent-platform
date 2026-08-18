// @ts-nocheck — the tree rows are a discriminated union; the runtime shape is what's under test.
// tests/tool-tree.test.ts — the structured tool-call renderer's pure core
// (lib/tool-tree.js): safe bounded parsing, the tree model, and every
// regression case the tracker demands — nested objects/arrays, escaped JSON
// strings, Unicode, malformed JSON, huge/deep payload bounds,
// null/booleans/numbers, and tool-error-shaped results.
import { assertEquals, assert } from "jsr:@std/assert";
import {
  looksJsonish,
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
  const paths = new Set(t.rows.map((r) => r.path));
  assert(paths.has("items.0.name"));
  assert(paths.has("items.0.tags.1"));
  assert(paths.has("meta.deep.ratio"));
  assert(t.rows.find((r) => r.path === "meta.deep.ratio").text === "0.75");
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
  const items = t.rows.find((r) => r.path === "items");
  if (!items) throw new Error("items row missing");
  const json = subtreeJson(value, items.path, t.rows);
  const parsed = JSON.parse(json);
  assert(parsed.length <= TOOL_TREE_CONTAINER_CAP, "the copied JSON is bounded");
  assert(parsed[0].i === 0);
  assertEquals(subtreeJson(value, "", t.rows).startsWith("{"), true, "root copy starts with {");
});

Deno.test("tool-tree: looksJsonish only accepts clear JSON value starts", () => {
  assert(looksJsonish('{"a":1}'));
  assert(looksJsonish("[1,2]"));
  assert(!looksJsonish("hello"));
  assert(!looksJsonish("42"));
  assert(!looksJsonish("null"));
  assert(!looksJsonish(""));
});

// @ts-nocheck
// Owner-authored site adapters — CAP-FB-20260828-AMBIENT-SITE-TOOLS-01.
//
// The security argument for adapters rests on four properties, so each one is
// asserted directly rather than inferred from "the happy path works":
//   1. the operation vocabulary is CLOSED (no unknown kind or field survives),
//   2. an op can only reference a parameter the tool DECLARES,
//   3. nothing is executable until an explicit owner approval, and
//   4. no path anywhere interprets a string as code.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ADAPTER_BOUNDS,
  ADAPTER_OPS,
  adapterToolDescriptors,
  approveAdapter,
  canonicalAdapterOrigin,
  validateAdapter,
} from "../extension/lib/site-adapters.js";

const ok = (raw) => {
  const r = validateAdapter(raw);
  assert(r.ok, `expected valid, got: ${r.error}`);
  return r.adapter;
};
const bad = (raw, why) => {
  const r = validateAdapter(raw);
  assert(!r.ok, `expected REJECTED (${why}) but it validated`);
  return r.error;
};

const base = (tools) => ({ origin: "https://shop.example", label: "Shop", tools });

const searchTool = {
  name: "search_products",
  description: "Search the catalogue.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  op: { kind: "callGlobal", fn: "shopSearch", args: ["query"] },
};

// ── the happy path ─────────────────────────────────────────────────────────
Deno.test("adapter: a well-formed owner document validates and canonicalises", () => {
  const a = ok(base([searchTool]));
  assertEquals(a.v, 1);
  assertEquals(a.origin, "https://shop.example");
  assertEquals(a.tools.length, 1);
  assertEquals(a.tools[0].name, "search_products");
  assertEquals(a.tools[0].op.kind, "callGlobal");
  assertEquals(a.tools[0].mutating, true);
  // Validation NEVER yields an approved adapter.
  assertEquals(a.status, "proposed");
});

Deno.test("adapter: every op kind in the vocabulary round-trips with its own fields", () => {
  const a = ok(base([
    { name: "t_call", inputSchema: { type: "object", properties: { q: { type: "string" } } }, op: { kind: "callGlobal", fn: "go", args: ["q"] } },
    { name: "t_read", op: { kind: "readText", selector: ".price" } },
    { name: "t_read_all", op: { kind: "readText", selector: ".row", all: true } },
    { name: "t_attr", op: { kind: "readAttribute", selector: "a.result", attribute: "href" } },
    { name: "t_click", op: { kind: "click", selector: "#buy" } },
    { name: "t_fill", inputSchema: { type: "object", properties: { term: { type: "string" } } }, op: { kind: "fill", selector: "#q", value: "term" } },
  ]));
  assertEquals(a.tools.length, 6);
  assertEquals(a.tools.map((t) => t.op.kind), ["callGlobal", "readText", "readText", "readAttribute", "click", "fill"]);
  // Reads are non-mutating; the rest are. This drives the approval copy and the
  // grant class, so it is asserted rather than assumed.
  assertEquals(a.tools.map((t) => t.mutating), [true, false, false, false, true, true]);
});

// ── property 1: the vocabulary is CLOSED ───────────────────────────────────
Deno.test("adapter PROPERTY: unknown op kinds and unknown fields both fail closed", () => {
  bad(base([{ name: "t", op: { kind: "eval", code: "alert(1)" } }]), "unknown kind");
  bad(base([{ name: "t", op: { kind: "fetch", url: "https://evil.example" } }]), "unknown kind");
  // A field we do not understand is a refusal, not something to ignore — an
  // ignored field is a capability the owner read and we silently dropped.
  bad(base([{ name: "t", op: { kind: "click", selector: "#x", onError: "retry" } }]), "unknown field");
  bad(base([{ name: "t", op: { kind: "readText", selector: ".a", attribute: "href" } }]), "field from another kind");
  bad(base([{ name: "t", op: { kind: "click" } }]), "missing required field");
});

Deno.test("adapter PROPERTY: callGlobal takes a bare identifier — no paths, no computed access", () => {
  bad(base([{ name: "t", op: { kind: "callGlobal", fn: "a.b.c" } }]), "dotted path");
  bad(base([{ name: "t", op: { kind: "callGlobal", fn: "window['x']" } }]), "bracket access");
  bad(base([{ name: "t", op: { kind: "callGlobal", fn: "" } }]), "empty");
  bad(base([{ name: "t", op: { kind: "callGlobal", fn: "2bad" } }]), "not an identifier");
  ok(base([{ name: "t", op: { kind: "callGlobal", fn: "shopSearch" } }]));
});

// ── property 2: ops may only reference DECLARED parameters ─────────────────
Deno.test("adapter PROPERTY: an op cannot reference a parameter the tool never declared", () => {
  const err = bad(base([{
    name: "leaky",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    op: { kind: "callGlobal", fn: "go", args: ["query", "secret"] },
  }]), "undeclared arg");
  assert(err.includes("undeclared parameter"), err);

  bad(base([{
    name: "leaky_fill",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
    op: { kind: "fill", selector: "#q", value: "b" },
  }]), "fill references an undeclared parameter");

  bad(base([{
    name: "no_schema",
    op: { kind: "callGlobal", fn: "go", args: ["anything"] },
  }]), "no schema declares anything");
});

Deno.test("adapter: required must reference declared parameters, and types are bounded", () => {
  bad({ ...base([{ name: "t", inputSchema: { type: "object", properties: {}, required: ["ghost"] }, op: { kind: "click", selector: "#a" } }]) }, "required ghost");
  bad(base([{ name: "t", inputSchema: { type: "object", properties: { a: { type: "object" } }, op: { kind: "click", selector: "#a" } } }]), "unsupported param type");
  bad(base([{ name: "t", inputSchema: { type: "array", properties: {} }, op: { kind: "click", selector: "#a" } }]), "non-object schema");
});

// ── selectors and origins ──────────────────────────────────────────────────
Deno.test("adapter: selectors are bounded and cannot smuggle a URL or markup", () => {
  bad(base([{ name: "t", op: { kind: "click", selector: "javascript:alert(1)" } }]), "javascript: URL");
  bad(base([{ name: "t", op: { kind: "click", selector: "data:text/html,<b>" } }]), "data: URL");
  bad(base([{ name: "t", op: { kind: "click", selector: "<script>" } }]), "markup");
  bad(base([{ name: "t", op: { kind: "click", selector: "a".repeat(ADAPTER_BOUNDS.maxSelectorLength + 1) } }]), "over the length bound");
  ok(base([{ name: "t", op: { kind: "click", selector: "#buy > .cta[data-id='1']" } }]));
});

Deno.test("adapter: the origin is one exact origin — no wildcards, paths, credentials or query", () => {
  assertEquals(canonicalAdapterOrigin("https://shop.example"), "https://shop.example");
  assertEquals(canonicalAdapterOrigin("https://shop.example/"), "https://shop.example");
  assertEquals(canonicalAdapterOrigin("http://localhost:3000"), "http://localhost:3000");
  for (const nope of [
    "https://*.example",           // wildcard host
    "https://shop.example/path",   // path
    "https://shop.example?a=1",    // query
    "https://u:p@shop.example",    // credentials
    "http://shop.example",         // plain http on a non-loopback host
    "ftp://shop.example",
    "not a url",
    "",
    null,
  ]) {
    assertEquals(canonicalAdapterOrigin(nope), null, `must refuse: ${String(nope)}`);
  }
});

// ── bounds + whole-document refusal ────────────────────────────────────────
Deno.test("adapter: a partially valid document is refused WHOLE, never partially applied", () => {
  // The owner approves a document. Applying the good half of it would mean the
  // site behaves differently from the thing they read.
  const r = validateAdapter(base([searchTool, { name: "bad", op: { kind: "eval", code: "x" } }]));
  assert(!r.ok);
  assertEquals(validateAdapter(base([searchTool])).ok, true);
});

Deno.test("adapter: duplicate tool names are refused rather than last-one-wins", () => {
  bad(base([searchTool, { ...searchTool, description: "different" }]), "duplicate name");
});

Deno.test("adapter: per-adapter and total-size bounds hold", () => {
  const many = Array.from({ length: ADAPTER_BOUNDS.maxToolsPerAdapter + 1 }, (_, i) => ({
    name: `t_${i}`, op: { kind: "click", selector: "#a" },
  }));
  bad(base(many), "too many tools");
  bad(base([]), "empty tools");
  bad({ origin: "https://a.example" }, "no tools array");
});

// ── property 3: nothing executes without an explicit owner approval ────────
Deno.test("adapter PROPERTY: approval requires an explicit owner act", () => {
  const a = ok(base([searchTool]));
  assertEquals(approveAdapter(a, { ownerApproved: false, at: 1 }).ok, false);
  assertEquals(approveAdapter(a, { ownerApproved: undefined, at: 1 }).ok, false);
  // Truthy-but-not-true must not pass: this is the whole gate.
  assertEquals(approveAdapter(a, { ownerApproved: "yes", at: 1 }).ok, false);
  assertEquals(approveAdapter(a, { ownerApproved: 1, at: 1 }).ok, false);

  const good = approveAdapter(a, { ownerApproved: true, at: 1234 });
  assert(good.ok);
  assertEquals(good.adapter.status, "approved");
  assertEquals(good.adapter.approvedAt, 1234);
});

Deno.test("adapter PROPERTY: approval RE-VALIDATES, so tampered stored bytes cannot be approved", () => {
  const a = ok(base([searchTool]));
  // Simulate an adapter edited in storage after it was written.
  const tampered = structuredClone(a);
  tampered.tools[0].op = { kind: "callGlobal", fn: "window['exfil']" };
  assertEquals(approveAdapter(tampered, { ownerApproved: true, at: 1 }).ok, false);

  const tampered2 = structuredClone(a);
  tampered2.origin = "https://*.evil.example";
  assertEquals(approveAdapter(tampered2, { ownerApproved: true, at: 1 }).ok, false);
});

Deno.test("adapter PROPERTY: an agent-authored proposal is inert until the owner approves it", () => {
  const proposed = ok({ ...base([searchTool]), authoredBy: "agent" });
  assertEquals(proposed.authoredBy, "agent");
  assertEquals(proposed.status, "proposed");
  // Unapproved projects to NOTHING — invisible, not merely unexecutable.
  assertEquals(adapterToolDescriptors(proposed).length, 0);
  // A document cannot declare itself approved.
  const selfApproved = ok({ ...base([searchTool]), status: "approved", approvedAt: 1 });
  assertEquals(selfApproved.status, "proposed");
  assertEquals(adapterToolDescriptors(selfApproved).length, 0);
});

// ── property 4: no string is ever interpreted as code ──────────────────────
Deno.test("adapter PROPERTY: the module contains no eval, no Function constructor, no code sink", () => {
  const raw = Deno.readTextFileSync(new URL("../extension/lib/site-adapters.js", import.meta.url));
  // Strip comments first: this asserts the CODE has no sink, and the header
  // comment legitimately names `document.modelContext` and `window.webmcpExpose`
  // when explaining what adapters are for.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const sink of ["eval(", "new Function", "setTimeout(", "setInterval(", "innerHTML", "importScripts", "fetch("]) {
    assert(!src.includes(sink), `site-adapters.js must not contain ${sink}`);
  }
  // It is pure: no storage, messaging, DOM or Chrome API.
  for (const impure of ["chrome.", "document.", "window.", "localStorage", "indexedDB", "postMessage"]) {
    assert(!src.includes(impure), `site-adapters.js must not reference ${impure}`);
  }
});

// ── projection into the existing tool vocabulary ───────────────────────────
Deno.test("adapter: approved adapters project into ordinary tool descriptors tagged source:adapter", () => {
  const a = approveAdapter(ok(base([searchTool, { name: "price", op: { kind: "readText", selector: ".price" } }])), { ownerApproved: true, at: 9 }).adapter;
  const d = adapterToolDescriptors(a);
  assertEquals(d.length, 2);
  assertEquals(d[0].origin, "https://shop.example");
  assertEquals(d[0].name, "search_products");
  assertEquals(d[0].source, "adapter");
  assertEquals(d[0].inputSchema.properties.query.type, "string");
  // The mutating flag survives projection: the dispatcher needs it to pick the
  // right grant class, and the approval prompt needs it for honest copy.
  assertEquals(d[0].mutating, true);
  assertEquals(d[1].mutating, false);
});

Deno.test("adapter: the op vocabulary is small and every entry declares its mutation class", () => {
  // A guard on the vocabulary itself: adding an op must be deliberate, and an
  // op without a mutation class would silently default to the wrong grant.
  const kinds = Object.keys(ADAPTER_OPS).sort();
  assertEquals(kinds, ["callGlobal", "click", "fill", "readAttribute", "readText"]);
  for (const [kind, spec] of Object.entries(ADAPTER_OPS)) {
    assertEquals(typeof spec.mutating, "boolean", `${kind} declares a mutation class`);
    assert(Array.isArray(spec.required) && Array.isArray(spec.optional), `${kind} declares its fields`);
  }
});

// ── the round-trip property that caught two real bugs ─────────────────────
Deno.test("adapter PROPERTY: validation output re-validates — the round trip holds", () => {
  // approveAdapter deliberately re-validates the STORED document rather than
  // trusting its bytes. That only works if canonical output is itself valid
  // input. Two bugs were found here: canonicalisation writes `label:""` and
  // `description:""`, and the bounded-string helper rejects the empty string,
  // so every adapter without a label — and every adapter containing a
  // description-less tool — was impossible to approve.
  const cases = [
    { origin: "https://a.example", tools: [{ name: "t", op: { kind: "click", selector: "#a" } }] },                        // no label, no description
    { origin: "https://a.example", label: "L", tools: [{ name: "t", op: { kind: "readText", selector: ".p" } }] },          // label, no description
    { origin: "https://a.example", tools: [{ name: "t", description: "d", op: { kind: "click", selector: "#a" } }] },       // description, no label
  ];
  for (const raw of cases) {
    const first = validateAdapter(raw);
    assert(first.ok, `first pass: ${first.error}`);
    const second = validateAdapter(first.adapter);
    assert(second.ok, `RE-validation of canonical output failed: ${second.error}`);
    assertEquals(second.adapter, first.adapter, "canonicalisation must be idempotent");
    const approved = approveAdapter(first.adapter, { ownerApproved: true, at: 5 });
    assert(approved.ok, `approve of canonical output failed: ${approved.error}`);
    assertEquals(approved.adapter.status, "approved");
    assertEquals(adapterToolDescriptors(approved.adapter).length, 1);
  }
});

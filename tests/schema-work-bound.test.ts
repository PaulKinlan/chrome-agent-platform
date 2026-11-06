// tests/schema-work-bound.test.ts — chrome-agent-platform-mfu4a
// (GHSA-mrhx-c7xc-m3w5)
//
// THE DEFECT. compileSchemaToZod (extension/lib/pure.js) bounds every
// dimension of an untrusted remote MCP schema SEPARATELY — maxDepth 8,
// maxArrayItems 100, maxProperties 200, maxUnionBranches 5 — and nothing
// bounds their PRODUCT. Validation work is per element of the ARGUMENTS, and
// tool arguments deliberately have no byte ceiling
// (extension/lib/tool-argument-contract.js:4-9), so a schema of four nested
// arrays lets a hostile MCP server (or page-driven model output) demand
// 100^4 = 100,000,000 element validations inside the service worker. Every cap
// held on its own; the multiplication was unbounded.
//
// WHAT THIS ASSERTS. The compile now carries a BUDGET on that product
// (SCHEMA_BOUNDS.maxValidationWork), refuses a schema that exceeds it with a
// named fatal ("schema-work-exceeded") before any validator is installed, and
// leaves realistic schemas alone. Both halves matter: a bound that also bricks
// ordinary tools is a regression, not a fix.
//
// SCOPE OF THE GUARANTEE (chrome-agent-platform-jzz9z): the budget presumes a
// payload that RESPECTS the declared element caps. zod's .max() length check
// runs AFTER the per-element loop, so a payload violating the caps (1M
// elements against a 100-cap array) is REJECTED but costs a linear scan
// first — the schema-side product bound does not bound PAYLOAD-side work.
// Practical bound on the residual (chrome-agent-platform-gtcha): NOT the
// 8 KiB attached-args cap — attached-webmcp-authority runs safeParse FIRST
// and measures the PARSED data's JSON after, so that cap bounds what is
// DISPATCHED, not what was SCANNED (and the args on that path are
// model-produced: the page declares the TOOL, the model supplies the ARGS).
// The residual scan is therefore linear in the model's output size, bounded
// by the provider's output limit; a pre-parse length guard is the escalation
// if it ever matters.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@3";
import { compileSchemaToZod, SCHEMA_BOUNDS, schemaValidationWork } from "../extension/lib/pure.js";

const BUDGET = SCHEMA_BOUNDS.maxValidationWork;

/** An array nested `depth` times, each level admitting maxArrayItems elements. */
function nestedArrays(depth: number, leaf: any = { type: "integer" }) {
  let node: any = leaf;
  for (let i = 0; i < depth; i++) node = { type: "array", items: node };
  return node;
}

Deno.test("mfu4a: the product of the per-dimension caps is what was unbounded", () => {
  // Each cap is legal on its own — the defect is that they compose.
  const depth = 4;
  assert(depth <= SCHEMA_BOUNDS.maxDepth, "the shape stays inside the depth cap");
  const multiplicative = Math.pow(SCHEMA_BOUNDS.maxArrayItems, depth);
  assert(
    multiplicative > BUDGET,
    `100^${depth} = ${multiplicative} must exceed the work budget (${BUDGET}) — ` +
      `if this ever stops being true the budget is pointless`,
  );
  assertEquals(schemaValidationWork(nestedArrays(depth)), BUDGET + 1, "the estimate saturates, never overflows");
});

Deno.test("mfu4a: a multiplicative bomb is refused at COMPILE time with a named fatal", () => {
  const bomb = { type: "object", properties: { rows: nestedArrays(4) } };
  const compiled = compileSchemaToZod(z, bomb);
  assertEquals(compiled.fatal, "schema-work-exceeded", "the refusal must be named, not silent");
  assertEquals(compiled.work, BUDGET + 1);
  // The refusal has to be a schema that accepts nothing: callers that ignore
  // `fatal` (mcp-run-tools turns fatal into a passthrough) must still not be
  // handed a validator that pays the multiplication.
  const parsed = compiled.zodSchema.safeParse({ rows: [[[[1]]]] });
  assertEquals(parsed.success, false, "nothing validates against a refused schema");
});

Deno.test("mfu4a: real-world schemas stay well inside the budget and still validate", () => {
  const realistic = {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 500 },
      limit: { type: "integer" },
      rows: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          properties: { id: { type: "string" }, score: { type: "number" }, ok: { type: "boolean" } },
          required: ["id"],
        },
      },
      // A grid — the smallest legitimate two-level collection.
      matrix: { type: "array", maxItems: 100, items: { type: "array", maxItems: 100, items: { type: "integer" } } },
    },
    required: ["query"],
  };
  const compiled = compileSchemaToZod(z, realistic);
  assertEquals(compiled.fatal, null, "a realistic tool schema must compile");
  assert(compiled.work !== undefined && compiled.work < BUDGET / 2, `work ${compiled.work} should be far under ${BUDGET}`);
  // and it still does its job: a valid payload passes, a missing required fails.
  assert(compiled.zodSchema.safeParse({ query: "x", rows: [{ id: "a", score: 1 }], matrix: [[1, 2]] }).success);
  assertEquals(compiled.zodSchema.safeParse({ rows: [] }).success, false);
});

Deno.test("mfu4a: the budget does not fire on a schema that merely uses the caps", () => {
  // 200 properties of bounded scalars: the properties cap itself, no nesting.
  const properties: Record<string, any> = {};
  for (let i = 0; i < SCHEMA_BOUNDS.maxProperties; i++) properties[`p${i}`] = { type: "string" };
  const wide = { type: "object", properties };
  assertEquals(compileSchemaToZod(z, wide).fatal, null, "a wide-but-flat schema is allowed");

  // One array at exactly the element cap, of flat records.
  const atCap = {
    type: "array",
    maxItems: SCHEMA_BOUNDS.maxArrayItems,
    items: { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } } },
  };
  assertEquals(compileSchemaToZod(z, atCap).fatal, null, "an array at the element cap is allowed");
});

Deno.test("mfu4a: a union multiplies through its branches, not just through arrays", () => {
  // anyOf branches are each validated; nested bombs hide in one branch.
  const viaUnion = {
    type: "object",
    properties: {
      payload: { anyOf: [{ type: "string" }, nestedArrays(4)] },
    },
  };
  assertEquals(compileSchemaToZod(z, viaUnion).fatal, "schema-work-exceeded", "a bomb inside a union branch is refused");
});

// ── The three bypasses chrome-agent-platform-26g5y found in the first cut ──
// The first implementation decided "container or leaf" from `type` and returned
// early, so three shapes accounted as work 1 while the BUILDER validated them:
// each is pinned here with the shape the reviewer used, because "bounded" is a
// claim about the product and these are the products a hostile server would use.

Deno.test("mfu4a: an UNTYPED container is accounted for (type is not the discriminator)", () => {
  // No `type` at all: buildFromClean still builds the object and validates every
  // property (measured pre-fix: 105k leaves in ~99ms while work reported 1).
  const untyped = { properties: { rows: nestedArrays(4) } };
  assertEquals(schemaValidationWork(untyped), BUDGET + 1, "the product must be counted without a type tag");
  assertEquals(compileSchemaToZod(z, untyped).fatal, "schema-work-exceeded");
});

Deno.test("mfu4a: a union on a TYPED node still adds its branches", () => {
  // The builder intersects the declared type with each branch, so both run.
  const typedUnion = { type: "object", anyOf: [{ type: "object", properties: { rows: nestedArrays(4) } }] };
  assertEquals(compileSchemaToZod(z, typedUnion).fatal, "schema-work-exceeded");

  // The same trick on the array side.
  const arrayUnion = { type: "array", items: { type: "integer" }, anyOf: [{ type: "array", items: nestedArrays(4) }] };
  assertEquals(compileSchemaToZod(z, arrayUnion).fatal, "schema-work-exceeded");
});

Deno.test("mfu4a/yn8en: a schema-valued additionalProperties is counted AND live (zod catchall); patternProperties stays dropped", () => {
  // Comment truth (chrome-agent-platform-yn8en): additionalProperties is NOT
  // insurance — sanitizeSchemaNode keeps it and buildFromClean compiles it into
  // obj.catchall(...), so extras are validated per key on a LIVE path. The
  // accounting counts it, and the asserts below pin the behavior: an extra
  // violating the catchall schema fails, a conforming one passes. If the
  // catchall compile is ever silently dropped, these red. patternProperties is
  // the dropped half; counting it is the insurance.
  const liveCatchall = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: { type: "array", items: { type: "integer" } },
  };
  const compiled = compileSchemaToZod(z, liveCatchall);
  assertEquals(compiled.fatal, null, "the catchall schema is inside the work budget");
  assertEquals(compiled.zodSchema.safeParse({ a: "x", extra: ["not-an-int"] }).success, false,
    "an extra key violating the catchall schema must FAIL — the catchall is a live validator path");
  assertEquals(compiled.zodSchema.safeParse({ a: "x", extra: [1, 2] }).success, true,
    "a conforming extra passes the live catchall");
  const addProps = { type: "object", additionalProperties: nestedArrays(4) };
  assertEquals(compileSchemaToZod(z, addProps).fatal, "schema-work-exceeded");
  const boolAddProps = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assertEquals(compileSchemaToZod(z, boolAddProps).fatal, null, "a boolean additionalProperties costs nothing");
});

// ── chrome-agent-platform-4vzgv: the builder's REQUIRED-refine loop ────────
// sanitizeSchemaNode keeps a well-formed `required` string array VERBATIM with
// no length cap (maxProperties caps properties KEYS, not required), and
// buildBaseZod defines one z.any().refine presence constraint PER required
// name ABSENT from properties. The accounting counted none of them: a ~3MB
// schema with 200k required names compiled 200k refines — measured 25.7s
// compile and 7.3s per safeParse inside the service worker while work
// reported 1 — reachable from any remote MCP tools/list or page WebMCP
// schema (chrome-agent-platform-4vzgv).
Deno.test("mfu4a: required-driven presence refines are counted — the accounting is at least as wide as the builder", () => {
  const required = Array.from({ length: 200_000 }, (_, i) => `k${i}`);
  const hostile = { type: "object", properties: {}, required };
  // The estimate must saturate on the 200k presence constraints the builder
  // would create, not just the (empty) properties.
  assertEquals(schemaValidationWork(hostile), BUDGET + 1, "200k absent-required refines must be counted as work");
  const compiled = compileSchemaToZod(z, hostile);
  assertEquals(compiled.fatal, "schema-work-exceeded", "refused with a named fatal BEFORE any refine is built");
  assertEquals(compiled.zodSchema.safeParse({}).success, false, "nothing validates against a refused schema");
});

Deno.test("mfu4a: required names covered by declared properties are not double-counted into a refusal", () => {
  // buildBaseZod adds no refine for a required name that HAS a declared
  // property (the property's own validator enforces presence), so the budget
  // must not charge for it either — mirroring the builder exactly, both ways.
  const legit = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "integer" } },
    required: ["a", "b"],
  };
  const compiled = compileSchemaToZod(z, legit);
  assertEquals(compiled.fatal, null, "required-present-in-properties stays free");
  assert(compiled.work <= 5, `work ${compiled.work} should reflect two leaf properties, not the required array`);
  assert(compiled.zodSchema.safeParse({ a: "x", b: 1 }).success, "and it still validates a conforming payload");
});

Deno.test("mfu4a: a CYCLIC object graph terminates instead of recursing forever", () => {
  // A cycle cannot arrive as parsed JSON, but the accounting must not depend on
  // that: it walks BEFORE the builder, so a caller passing a hand-built graph
  // must not be able to spin it. The depth cap is the termination argument.
  const cyclic: any = { type: "array" };
  cyclic.items = cyclic;
  const started = Date.now();
  const work = schemaValidationWork(cyclic);
  assert(Number.isFinite(work) && work <= BUDGET + 1, `work must stay finite and bounded (got ${work})`);
  assert(Date.now() - started < 1000, "the accounting pass must be cheap on a cyclic graph");
});

// chrome-agent-platform-jzz9z precision pin: the budget bounds the SCHEMA-side
// product; PAYLOAD-side work is rejected but linear (zod's .max() runs after
// the element loop). What this pin holds: an over-cap payload is REJECTED and
// the schema-side estimate stays 101 — the budget counts the schema, never
// the payload. chrome-agent-platform-gtcha: it deliberately does NOT pin the
// residual's existence — if a pre-parse length guard (shape b) lands, this
// pin stays green and the SCOPE header above must be widened in the same
// change.
Deno.test("mfu4a: a payload violating the declared caps is still rejected — but the scan is linear, not budgeted", () => {
  const schema = { type: "array", maxItems: 100, items: { type: "integer" } };
  const compiled = compileSchemaToZod(z, schema);
  assertEquals(compiled.fatal, null, "the schema itself is legal (work = 1 + 100×1)");
  assertEquals(compiled.work, 101, "the schema-side estimate reflects 100 element validations");
  const payload = Array.from({ length: 1_000_000 }, (_, i) => i);
  const parsed = compiled.zodSchema.safeParse(payload);
  assertEquals(parsed.success, false, "a payload over the declared cap is rejected");
  // The DOCUMENTED guarantee now says "for a payload that respects the declared
  // element caps" — this pin keeps that statement honest: work=101 did NOT
  // bound the 1M-element scan, and the header says so.
});

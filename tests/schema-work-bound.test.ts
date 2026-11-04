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

Deno.test("mfu4a: a schema-valued additionalProperties is counted (insurance, not a live path)", () => {
  // This converter DROPS additionalProperties/patternProperties today, so the
  // budget counts them for the day they are supported — the point is that the
  // accounting cannot be narrower than the builder without a test noticing.
  const addProps = { type: "object", additionalProperties: nestedArrays(4) };
  assertEquals(compileSchemaToZod(z, addProps).fatal, "schema-work-exceeded");
  const boolAddProps = { type: "object", properties: { a: { type: "string" } }, additionalProperties: false };
  assertEquals(compileSchemaToZod(z, boolAddProps).fatal, null, "a boolean additionalProperties costs nothing");
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

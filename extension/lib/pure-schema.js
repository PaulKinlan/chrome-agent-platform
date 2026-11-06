// lib/pure-schema.js — the schema converter seam (SCHEMA_BOUNDS, sanitize, work budget)
// extracted from lib/pure.js by chrome-agent-platform-ux4ud. pure.js re-exports all of it;
// nothing about the converter changed in the move.

/** Bounds for the schema converter (fail-closed against hostile descriptors). */
export const SCHEMA_BOUNDS = {
  maxDepth: 8,
  maxProperties: 200,
  maxArrayItems: 100,
  maxStringLength: 10000,
  maxUnionBranches: 5,
  maxEnumValues: 256,
  maxLiteralDepth: 8,
  // chrome-agent-platform-mfu4a: the caps above bound each DIMENSION, and a
  // hostile schema multiplies them. maxArrayItems=100 and maxDepth=8 permit an
  // array-of-array-of-array… schema whose payload costs 100^n element
  // validations, and tool arguments have NO byte ceiling on purpose
  // (extension/lib/tool-argument-contract.js:4-9), so nothing else bounds the
  // work a remote MCP server can ask this service worker to do. This is the
  // budget on the PRODUCT: the worst-case number of leaf validations one
  // payload can require — FOR A PAYLOAD THAT RESPECTS THE DECLARED ELEMENT
  // CAPS (chrome-agent-platform-jzz9z: zod's .max() runs AFTER the per-element
  // loop, so a 1M-element payload against a 100-cap array is REJECTED but
  // costs a linear scan first. chrome-agent-platform-gtcha: the 8 KiB
  // attached-args cap does NOT bound that scan — attached-webmcp-authority.js
  // runs safeParse FIRST and measures the PARSED data's JSON after, so the cap
  // bounds what is DISPATCHED, not what was SCANNED; and the args on that path
  // are MODEL-produced — the page declares the TOOL, the model supplies the
  // ARGS — so the practical bound on the residual scan is the provider's
  // output limit: linear in the model's output size. A pre-parse length guard
  // is the escalation if that residual ever matters). A
  // realistic tool (a list of 100 records with a handful of fields each, or an
  // array of arrays) sits in the hundreds to low thousands; the smallest
  // useful multiplicative bomb is 100^3 = 1,000,000.
  maxValidationWork: 100_000,
};

/**
 * The JSON-Schema keywords this converter ENFORCES. Recognised-but-unsupported
 * keywords ($schema, $id, $ref, $defs, $comment, format, pattern, not,
 * exclusiveMinimum/Maximum, multipleOf, uniqueItems, if/then/else, ...) and
 * unknown keywords are DROPPED with a record (fail-open — a page that declares
 * more than we enforce must not have its tool bricked), while every ENFORCED
 * keyword stays strict (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01). oneOf is
 * downgraded to anyOf (union); allOf composes as an intersection.
 */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "description",
  "default",
  "title",
  "minLength",
  "maxLength", // string
  "minimum",
  "maximum", // number/integer
  "items",
  "minItems",
  "maxItems", // array
  "properties",
  "required",
  "additionalProperties", // object
  "anyOf", // union
  "allOf", // intersection
]);

/** Constraint keywords valid per declared type (wrong-type use is DROPPED). */
const TYPE_CONSTRAINT_KEYWORDS = {
  string: ["minLength", "maxLength"],
  number: ["minimum", "maximum"],
  integer: ["minimum", "maximum"],
  array: ["items", "minItems", "maxItems"],
  object: ["properties", "required", "additionalProperties"],
  boolean: [],
  null: [],
};

function valueMatchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" &&
        !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

/** Deep structural equality for const/enum literal comparison. */
function deepEqual(a, b, depth = 0) {
  if (depth > SCHEMA_BOUNDS.maxLiteralDepth) return false;
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], depth + 1)) return false;
    return true;
  }
  if (typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      // Exact structural equality: a key must be an OWN key of BOTH objects.
      // (Without this, {x:undefined} would equal {y:undefined} — both resolve
      // to undefined on the missing-key read.)
      if (!Object.hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Whether a const/enum literal is within the SCHEMA_BOUNDS size caps. The
 * descriptor's serialized size limits total bytes but NOT semantic depth or
 * per-collection cardinality; a 101-item array const or a 10,001-char string
 * const must be rejected in validation, not compiled into a z.literal that
 * bypasses the bounds `buildBaseZod` would otherwise apply.
 */
function literalWithinBounds(value, depth = 0) {
  if (depth > SCHEMA_BOUNDS.maxLiteralDepth) return false;
  if (typeof value === "string") {
    return value.length <= SCHEMA_BOUNDS.maxStringLength;
  }
  if (Array.isArray(value)) {
    if (value.length > SCHEMA_BOUNDS.maxArrayItems) return false;
    return value.every((v) => literalWithinBounds(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > SCHEMA_BOUNDS.maxProperties) return false;
    return keys.every((k) => literalWithinBounds(value[k], depth + 1));
  }
  return true;
}

/**
 * Sanitize ONE schema node (shallow): keep only well-formed ENFORCED keywords,
 * drop everything else with a record (fail-open). oneOf folds into anyOf
 * (union semantics — exactly-one is not enforced). Returns null when the node
 * itself is unusable (a non-object child is dropped by its parent); sets
 * report.fatal (and returns null) only for DoS-bounds violations (depth,
 * property/branch counts, oversized literals) which must fail the WHOLE
 * compile closed (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01).
 */
function sanitizeSchemaNode(schema, depth, report) {
  const drop = (key) => {
    if (report && report.dropped.length < 32) report.dropped.push(key);
  };
  const fatal = (reason) => {
    if (report && !report.fatal) report.fatal = reason;
    return null;
  };
  if (depth > SCHEMA_BOUNDS.maxDepth) return fatal("schema-depth-exceeded");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    // A non-object ROOT is unusable (fail closed); a non-object CHILD is
    // dropped by its parent without failing the whole schema.
    return depth === 0 ? fatal("schema-root-not-an-object") : null;
  }

  const clean = {};
  // type: a valid declared type is kept; an unknown type value is DROPPED
  // (the node becomes untyped and composes by runtime kind).
  const t = schema.type;
  const typeValid = t === undefined ||
    ["string", "number", "integer", "boolean", "array", "object", "null"].includes(t);
  if (t !== undefined && typeValid) clean.type = t;
  else if (t !== undefined) drop("type");
  // Wrong-type constraint keywords are dropped ONLY when a valid type is
  // declared; untyped nodes keep every constraint (runtime-kind composition).
  const allowedForType = clean.type !== undefined
    ? new Set(TYPE_CONSTRAINT_KEYWORDS[clean.type])
    : null;
  const wrongType = (key) =>
    allowedForType !== null &&
    Object.values(TYPE_CONSTRAINT_KEYWORDS).flat().includes(key) &&
    !allowedForType.has(key);

  for (const key of Object.keys(schema)) {
    if (key === "type") continue;
    const value = schema[key];
    if (!SUPPORTED_KEYWORDS.has(key) && key !== "oneOf") {
      // Recognised-but-unsupported ($schema, $ref, format, pattern, not, ...) or
      // unknown: fail-open drop — never brick the tool over an annotation.
      drop(key);
      continue;
    }
    if (wrongType(key)) {
      drop(key);
      continue;
    }
    switch (key) {
      case "description":
      case "default":
      case "title":
        clean[key] = value; // annotations — never constrain
        break;
      case "const":
        if (!literalWithinBounds(value)) { drop("const(literal-exceeds-bounds)"); break; }
        clean.const = value;
        break;
      case "enum":
        if (!Array.isArray(value)) { drop("enum"); break; }
        if (value.length === 0) { drop("enum"); break; } // unsatisfiable → fail-open
        // Enum VALUES are set members checked by deep equality (O(n) over small,
        // individually-bounded literals) — NOT z.union branches — so the branch
        // cap does not apply; a generous value cap guards the descriptor.
        if (value.length > SCHEMA_BOUNDS.maxEnumValues) { drop("enum(exceeds-bounds)"); break; }
        if (!value.every((v) => literalWithinBounds(v))) { drop("enum(literal-exceeds-bounds)"); break; }
        clean.enum = value;
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
        if (typeof value === "number" && Number.isInteger(value) && value >= 0) clean[key] = value;
        else drop(key);
        break;
      case "minimum":
      case "maximum":
        if (typeof value === "number" && Number.isFinite(value)) clean[key] = value;
        else drop(key);
        break;
      case "items":
        // A plain-object subschema is kept; the draft-07 TUPLE form (an array)
        // is dropped (fail-open to unconstrained items).
        if (value !== null && typeof value === "object" && !Array.isArray(value)) clean.items = value;
        else drop(Array.isArray(value) ? "items(tuple-form)" : "items");
        break;
      case "properties": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) { drop("properties"); break; }
        if (Object.keys(value).length > SCHEMA_BOUNDS.maxProperties) { drop("properties(exceeds-bounds)"); break; }
        clean.properties = value;
        break;
      }
      case "required":
        // Well-formed string arrays are kept VERBATIM — a required name absent
        // from properties is still enforced as a PRESENCE constraint (the
        // builder adds an any-defined entry), never a whole-schema rejection.
        if (Array.isArray(value) && value.every((k) => typeof k === "string")) clean.required = value;
        else drop("required");
        break;
      case "additionalProperties":
        // false → strict; true → passthrough; a schema-valued form is kept and
        // compiled as a catchall; anything else is dropped.
        if (typeof value === "boolean") clean.additionalProperties = value;
        else if (value !== null && typeof value === "object" && !Array.isArray(value)) clean.additionalProperties = value;
        else drop("additionalProperties");
        break;
      case "anyOf":
        if (!Array.isArray(value)) { drop("anyOf"); break; }
        if (value.length === 0) { drop("anyOf"); break; }
        if (value.length > SCHEMA_BOUNDS.maxUnionBranches) { drop("anyOf(exceeds-bounds)"); break; }
        clean.anyOf = value;
        break;
      case "oneOf":
        // exactly-one is not enforced: oneOf DOWNGRADES to anyOf (union
        // semantics) — fail-open, recorded.
        if (!Array.isArray(value)) { drop("oneOf"); break; }
        if (value.length === 0) { drop("oneOf"); break; }
        if (value.length > SCHEMA_BOUNDS.maxUnionBranches) { drop("oneOf(exceeds-bounds)"); break; }
        clean.anyOf = [...(clean.anyOf ?? []), ...value];
        if (clean.anyOf.length > SCHEMA_BOUNDS.maxUnionBranches) { delete clean.anyOf; drop("oneOf(as-union)"); break; }
        drop("oneOf(as-union)");
        break;
      case "allOf":
        if (!Array.isArray(value)) { drop("allOf"); break; }
        if (value.length === 0) { drop("allOf"); break; }
        if (value.length > SCHEMA_BOUNDS.maxUnionBranches) { drop("allOf(exceeds-bounds)"); break; }
        clean.allOf = value;
        break;
      default:
        drop(key);
    }
  }
  return clean;
}

/**
 * Does a LITERAL value satisfy this schema — type, every scalar/array/object
 * bound, const/enum membership, and every anyOf branch? Used to compose
 * const/enum with their siblings: a const or enum candidate that violates ANY
 * sibling makes that candidate invalid (and, if none survive, the schema is
 * unsatisfiable). Applies bounds even when `type` is not declared (bounds are
 * inferred from the value's runtime kind).
 */
function valueSatisfiesSchema(schema, value, depth) {
  if (depth > SCHEMA_BOUNDS.maxDepth) return false;
  const t = schema.type;
  if (t !== undefined && !valueMatchesType(value, t)) return false;

  // string bounds (apply to string values regardless of a declared type).
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
  }
  // number/integer bounds (apply to number values).
  if (typeof value === "number") {
    if (t === "integer" && !Number.isInteger(value)) return false;
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  // array bounds + item validation.
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    // A non-object items subschema (dropped by the sanitizer) is NO constraint.
    if (schema.items !== undefined && schema.items !== null && typeof schema.items === "object") {
      for (const item of value) {
        if (!valueSatisfiesSchema(schema.items, item, depth + 1)) return false;
      }
    }
  }
  // object bounds + property validation.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const k of required) if (!(k in value)) return false;
    if (schema.properties && typeof schema.properties === "object") {
      for (const [k, sub] of Object.entries(schema.properties)) {
        // A non-object property subschema is no constraint (sanitizer-dropped).
        if (sub !== null && typeof sub === "object" && k in value && !valueSatisfiesSchema(sub, value[k], depth + 1)) return false;
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties || {}));
      for (const k of Object.keys(value)) if (!known.has(k)) return false;
    }
  }

  // const / enum membership (compose with each other + siblings).
  if (schema.const !== undefined && !deepEqual(value, schema.const)) return false;
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(value, e))) return false;
  if (schema.anyOf !== undefined && !schema.anyOf.some((b) =>
    b !== null && typeof b === "object" && valueSatisfiesSchema(b, value, depth + 1)
  )) return false;
  return true;
}

/**
 * Whether an untyped schema carries any value-constraining sibling keyword
 * (bounds/items/properties/required/additionalProperties). These are composed
 * by runtime kind via valueSatisfiesSchema — NOT treated as a single global
 * type declaration (which produced false negatives when, e.g., minLength
 * [string] and properties [object] appeared together in a union).
 */
function hasConstrainingSibling(schema) {
  return [
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "items",
    "minItems",
    "maxItems",
    "properties",
    "required",
    "additionalProperties",
  ].some((k) => schema[k] !== undefined);
}

/**
 * Build a zod literal for a const/enum value. Primitives use z.literal; object
 * and array values use a bounded deepEqual refinement (z.literal compares
 * non-primitives by IDENTITY, which would reject structurally-equal clones).
 */
function literalSchema(z, value) {
  if (value !== null && typeof value === "object") {
    return z.any().refine((x) => deepEqual(x, value), {
      message: "expected exact structural value",
    });
  }
  return z.literal(value);
}

/**
 * Convert a JSON-schema descriptor into a bounded zod schema. POLICY
 * (CAP-FB-20260824-WEBMCP-ARGSVALIDATION-01): enforce every supported keyword
 * strictly; DROP unknown/unsupported/malformed-but-benign keywords with a
 * record (fail-open) instead of bricking the whole tool; fail CLOSED
 * (z.never()) only on DoS bounds (depth, counts, oversized literals) and
 * genuinely unsatisfiable const/enum compositions. An EMPTY schema ({}) means
 * "no constraints" (JSON Schema semantics) and compiles to z.unknown().
 */
export function schemaToZod(z, schema, depth = 0, report = undefined) {
  const rep = report ?? { dropped: [], fatal: null };
  const clean = sanitizeSchemaNode(schema, depth, rep);
  if (clean === null || rep.fatal) return z.never();
  const built = buildFromClean(z, clean, depth, rep);
  // A bounds violation deep in the tree fails the WHOLE compile closed.
  return rep.fatal ? z.never() : built;
}

/**
 * Compile with a diagnostics report: { zodSchema, dropped, fatal }. fatal is a
 * named reason when the schema could not be compiled at all (zodSchema is
 * z.never()); dropped lists the keywords ignored under the fail-open policy.
 */
/**
 * Worst-case number of leaf validations ONE payload can force this schema to
 * perform — the quantity the per-dimension caps do not bound, because they
 * multiply: an array contributes its element cap × its items' work, a union the
 * sum of its branches, an object the sum of its properties.
 *
 * Deliberately computed from the RAW schema over the SAME caps the builder
 * applies, and it saturates at `budget + 1` so no multiplication can overflow
 * into Infinity or wrap. It is an upper bound: where the builder drops a child
 * this pass may still count it, which can only make it MORE conservative (a
 * schema it refuses is one whose real work is at most what is counted).
 * @param {any} schema
 * @param {number} budget
 * @returns {number} saturated work estimate (budget+1 means "over budget")
 */
export function schemaValidationWork(schema, budget = SCHEMA_BOUNDS.maxValidationWork) {
  const cap = budget + 1;
  const mul = (a, b) => {
    if (!a || !b) return 0;
    const v = a * b;
    return v > cap || !Number.isFinite(v) ? cap : v;
  };
  const add = (a, b) => {
    const v = a + b;
    return v > cap || !Number.isFinite(v) ? cap : v;
  };
  const isNode = (v) => v && typeof v === "object" && !Array.isArray(v);
  const walk = (node, depth) => {
    if (!isNode(node) || depth > SCHEMA_BOUNDS.maxDepth) return 1;
    // A union COMPOSES with whatever else the node declares (buildFromClean
    // intersects the base with each branch), so its branches are added whatever
    // `type` says — chrome-agent-platform-26g5y: an early return per type threw
    // away exactly that, so `{type:"object", anyOf:[bomb]}` accounted as 1 and
    // then validated 100^4 leaves.
    let total = 1; // the node itself
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = Array.isArray(node[key]) ? node[key].slice(0, SCHEMA_BOUNDS.maxUnionBranches) : [];
      for (const b of branches) total = add(total, walk(b, depth + 1));
    }
    // CONTAINERS ARE DETECTED BY THEIR KEYWORDS, NOT BY `type`: the builder
    // treats `{properties:{…}}` (no type) as an object and validates every
    // property, so `type` alone let an untyped bomb through (measured: 105k
    // leaves validated in ~99ms while the budget reported work 1).
    if (node.type === "array" || node.items !== undefined) {
      const pageMax = node.maxItems !== undefined ? node.maxItems : SCHEMA_BOUNDS.maxArrayItems;
      const elements = Math.max(0, Math.min(pageMax, SCHEMA_BOUNDS.maxArrayItems));
      // An array with no items schema validates `unknown` per element (work 1);
      // an array that admits NO elements still costs one validation of itself.
      const perElement = node.items !== undefined ? walk(node.items, depth + 1) : 1;
      total = add(total, elements > 0 ? mul(elements, perElement) : 1);
    }
    const declaresObject = node.type === "object" ||
      (isNode(node.properties)) ||
      isNode(node.additionalProperties) ||
      isNode(node.patternProperties);
    if (declaresObject) {
      if (isNode(node.properties)) {
        for (const child of Object.values(node.properties)) total = add(total, walk(child, depth + 1));
      }
      // chrome-agent-platform-yn8en (comment truth): these two keywords DIFFER.
      // `additionalProperties` IS enforced — a schema-valued one compiles to a zod
      // catchall (buildFromClean), so every extra payload key is validated against it
      // live. Schema work is counted below, but the payload's KEY COUNT is unbounded
      // by the schema, so work there stays ~linear in payload size (not a bomb, but a
      // live validator path that must be reasoned about, not waved off as insurance).
      // `patternProperties` IS dropped with a record: for that keyword alone the
      // counting is insurance for the day it gains support. A boolean
      // `additionalProperties` costs nothing and adds nothing.
      if (isNode(node.additionalProperties)) total = add(total, walk(node.additionalProperties, depth + 1));
      if (isNode(node.patternProperties)) {
        for (const child of Object.values(node.patternProperties)) total = add(total, walk(child, depth + 1));
      }
    }
    // chrome-agent-platform-4vzgv: each required name ABSENT from properties
    // is one z.any().refine presence constraint in buildBaseZod — work 1 each
    // — and `required` is kept VERBATIM by the sanitizer with no length cap
    // (maxProperties caps properties KEYS, not required), so a 200k-name
    // required array compiled 200k refines while this budget reported 1.
    // Counting only the ABSENT names mirrors the builder exactly: a required
    // name WITH a declared property adds no refine (the property's own
    // validator enforces presence), and non-string entries are dropped by the
    // sanitizer, so they add nothing here either. The early break saturates
    // the estimate so a hostile array cannot make the estimator itself the
    // expensive part.
    if (Array.isArray(node.required)) {
      const propKeys = isNode(node.properties) ? new Set(Object.keys(node.properties)) : null;
      let absent = 0;
      for (const k of node.required) {
        if (typeof k !== "string" || (propKeys && propKeys.has(k))) continue;
        if (++absent > cap) break;
      }
      total = add(total, absent);
    }
    return total;
  };
  return Math.min(walk(schema, 0), cap);
}

export function compileSchemaToZod(z, schema) {
  const report = { dropped: [], fatal: null };
  // The work bound is checked BEFORE the tree is compiled, because compiling a
  // bomb is itself the expensive part once a payload arrives: with no fatal
  // flag the caller installs the validator and every later safeParse pays the
  // multiplication.
  const work = schemaValidationWork(schema);
  if (work > SCHEMA_BOUNDS.maxValidationWork) {
    report.fatal = "schema-work-exceeded";
    return Object.freeze({
      zodSchema: z.never(),
      dropped: Object.freeze([]),
      fatal: report.fatal,
      work,
    });
  }
  const zodSchema = schemaToZod(z, schema, 0, report);
  return Object.freeze({
    zodSchema,
    dropped: Object.freeze(report.dropped.slice(0, 32)),
    fatal: report.fatal,
    // Reported on BOTH paths so a caller (or a test) can see how much work the
    // schema it just compiled may force — the number the budget is about.
    work,
  });
}

/** Compose the zod schema from a SANITIZED node (children are sanitized as the
 * recursion descends; a broken child is dropped, a fatal child → z.never()). */
function buildFromClean(z, clean, depth, report) {
  // ---- const / enum compose their FULL sibling set (type + bounds + anyOf
  // + each other). A literal candidate must satisfy EVERY present constraint;
  // if none survive, the schema is unsatisfiable and fails closed. ----
  if (clean.const !== undefined) {
    if (!valueSatisfiesSchema(clean, clean.const, depth)) return z.never();
    return literalSchema(z, clean.const);
  }
  if (clean.enum !== undefined) {
    // Compose the FULL sibling set: only enum values satisfying every sibling
    // constraint survive; an empty survivor set is unsatisfiable → fail closed.
    const valid = clean.enum.filter((v) => valueSatisfiesSchema(clean, v, depth));
    if (valid.length === 0) return z.never();
    // Membership by deep equality (bounded values), not a z.union of literals —
    // real tools declare 6+ member enums (the bistro's guests/seating).
    return z.any().refine((value) => valid.some((v) => deepEqual(value, v)), {
      message: `expected one of ${valid.slice(0, 8).map((v) => JSON.stringify(v)).join(", ")}${valid.length > 8 ? ", …" : ""}`,
    });
  }

  // Build the base WITHOUT anyOf/allOf (type + bounds + object/array shape).
  const baseWithoutAnyOf = { ...clean };
  delete baseWithoutAnyOf.anyOf;
  delete baseWithoutAnyOf.allOf;

  // An UNTYPED schema composes its siblings by RUNTIME kind (minLength applies
  // only to strings, properties only to objects — JSON Schema semantics), not
  // by inferring a single declared type. An untyped schema with NO siblings and
  // NO unions (the empty {} — or everything dropped) means "no constraints":
  // z.unknown() (JSON Schema semantics — previously fail-closed z.never(),
  // which bricked every tool that declared no inputSchema).
  const base = (() => {
    if (clean.type !== undefined) return buildBaseZod(z, clean, depth, report);
    if (hasConstrainingSibling(baseWithoutAnyOf)) {
      return z.any().refine((value) =>
        valueSatisfiesSchema(baseWithoutAnyOf, value, depth), {
        message: "value must satisfy all schema constraints",
      });
    }
    return z.unknown();
  })();
  if (report.fatal) return z.never(); // a deep child tripped a DoS bound

  let out = base;
  if (clean.anyOf !== undefined) {
    const branches = [];
    for (const b of clean.anyOf) {
      const bc = sanitizeSchemaNode(b, depth + 1, report);
      if (report.fatal) return z.never();
      if (bc === null) continue; // a broken branch is dropped, never fatal
      branches.push(buildFromClean(z, bc, depth + 1, report));
      if (report.fatal) return z.never();
    }
    // Compose the declared type/bounds with anyOf — JSON Schema requires BOTH.
    // No surviving branch → the union keyword is dropped (fail-open base).
    if (branches.length === 1) out = z.intersection(base, branches[0]);
    else if (branches.length > 1) out = z.intersection(base, z.union(branches));
  }
  if (clean.allOf !== undefined) {
    for (const b of clean.allOf) {
      const bc = sanitizeSchemaNode(b, depth + 1, report);
      if (report.fatal) return z.never();
      if (bc === null) continue;
      out = z.intersection(out, buildFromClean(z, bc, depth + 1, report));
      if (report.fatal) return z.never();
    }
  }
  return out;
}

/** Build the zod schema for a schema's own type + bounds (no anyOf/allOf/const/enum). */
function buildBaseZod(z, schema, depth, report) {
  const t = schema.type;
  if (t === "string") {
    let s = z.string();
    if (schema.minLength !== undefined) s = s.min(schema.minLength);
    const pageMax = schema.maxLength !== undefined ? schema.maxLength : SCHEMA_BOUNDS.maxStringLength;
    s = s.max(Math.min(pageMax, SCHEMA_BOUNDS.maxStringLength));
    return s;
  }
  if (t === "number") {
    let s = z.number();
    if (schema.minimum !== undefined) s = s.min(schema.minimum);
    if (schema.maximum !== undefined) s = s.max(schema.maximum);
    return s;
  }
  if (t === "integer") {
    let s = z.number().int();
    if (schema.minimum !== undefined) s = s.min(Math.ceil(schema.minimum));
    if (schema.maximum !== undefined) s = s.max(Math.floor(schema.maximum));
    return s;
  }
  if (t === "boolean") return z.boolean();
  if (t === "null") return z.null();
  if (t === "array") {
    // A dropped/absent items schema means unconstrained items (fail-open),
    // never the old z.never() that rejected every element.
    let inner = z.unknown();
    if (schema.items !== undefined) {
      const ic = sanitizeSchemaNode(schema.items, depth + 1, report);
      if (report.fatal) return z.never();
      if (ic !== null) inner = buildFromClean(z, ic, depth + 1, report);
      if (report.fatal) return z.never();
    }
    let arr = z.array(inner);
    if (schema.minItems !== undefined) arr = arr.min(schema.minItems);
    const pageMax = schema.maxItems !== undefined ? schema.maxItems : SCHEMA_BOUNDS.maxArrayItems;
    arr = arr.max(Math.min(pageMax, SCHEMA_BOUNDS.maxArrayItems));
    return arr;
  }
  if (t === "object") {
    const props = schema.properties || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    // defineProperty, never shape[key] = ...: a page-supplied "__proto__" key
    // must land as an OWN property (and be validated), not silently mutate the
    // shape object's prototype and skip validation.
    const shape = {};
    const define = (key, zodValue) =>
      Object.defineProperty(shape, key, { value: zodValue, enumerable: true, writable: true, configurable: true });
    for (const [key, sub] of Object.entries(props)) {
      const sc = sanitizeSchemaNode(sub, depth + 1, report);
      if (report.fatal) return z.never();
      if (sc === null) continue; // a broken property schema is dropped (fail-open)
      const subZod = buildFromClean(z, sc, depth + 1, report);
      if (report.fatal) return z.never();
      define(key, required.has(key) ? subZod : subZod.optional());
    }
    // A required name with NO declared property is still a PRESENCE constraint
    // (any defined value qualifies) — enforced, never a whole-schema rejection.
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(shape, key)) {
        define(key, z.any().refine((v) => v !== undefined, { message: "required" }));
      }
    }
    const obj = z.object(shape);
    if (schema.additionalProperties === false) return obj.strict();
    if (
      schema.additionalProperties !== undefined &&
      typeof schema.additionalProperties === "object"
    ) {
      // Schema-valued additionalProperties → a catchall (extras must satisfy it).
      const ac = sanitizeSchemaNode(schema.additionalProperties, depth + 1, report);
      if (report.fatal) return z.never();
      if (ac !== null) {
        const catchall = buildFromClean(z, ac, depth + 1, report);
        if (report.fatal) return z.never();
        return obj.catchall(catchall);
      }
    }
    return obj.passthrough();
  }
  // Unreachable (sanitize keeps only valid types); fail-closed by construction.
  return z.never();
}

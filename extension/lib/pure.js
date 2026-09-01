// lib/pure.js — pure, dependency-free helpers (no chrome.*, no AI SDK) so the
// security-critical logic can be unit-tested in Deno without a browser.

/** Bounds for the schema converter (fail-closed against hostile descriptors). */
export const SCHEMA_BOUNDS = {
  maxDepth: 8,
  maxProperties: 200,
  maxArrayItems: 100,
  maxStringLength: 10000,
  maxUnionBranches: 5,
  maxEnumValues: 256,
  maxLiteralDepth: 8,
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
export function compileSchemaToZod(z, schema) {
  const report = { dropped: [], fatal: null };
  const zodSchema = schemaToZod(z, schema, 0, report);
  return Object.freeze({
    zodSchema,
    dropped: Object.freeze(report.dropped.slice(0, 32)),
    fatal: report.fatal,
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

/**
 * Build a collision-resistant, bounded AI-SDK tool id from an origin + name.
 * Uses a 64-bit FNV-1a (two independent 32-bit rounds) so distinct
 * (origin, name) pairs are astronomically unlikely to collide after
 * punctuation sanitization. The caller additionally checks for duplicates.
 */
export function sanitizeToolName(origin, name) {
  const safe = String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const h = fnv1a64(`${origin}\u0000${name}`);
  return `site_${h}_${safe}`.slice(0, 64);
}

/** FNV-1a 32-bit (pure, deterministic, dependency-free). */
export function fnv1a(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** FNV-1a 64-bit: two independent 32-bit FNV rounds, hex-encoded (16 chars).
 * NON-cryptographic — fine for tool-name disambiguation, NEVER for security
 * fingerprints (use sha256Hex / hmacSha256Hex below). */
export function fnv1a64(input) {
  const seedA = 0x811c9dc5, seedB = 0x01000193;
  let a = seedA, b = seedB;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul((a ^ c) >>> 0, 0x01000193) >>> 0;
    b = Math.imul((b ^ (c + 0x9e)) >>> 0, 0x01000193) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0");
}

/* ── SHA-256 (FIPS 180-4), synchronous + dependency-free ──────────────────
 * The collision-resistant digest for every security-relevant fingerprint
 * (registry content hashes, prompt attestations). Pure JS over UTF-8 BYTES —
 * no WebCrypto (works identically in the SW, pages, Deno tests), no eval
 * (MV3-CSP-safe). Verified against the FIPS test vectors in tests/pure.test.ts.
 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 over a Uint8Array → the 32-byte digest. */
export function sha256Bytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const H = new Uint32Array(SHA256_H0);
  const bitLen = bytes.length * 8;
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3],
      e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** SHA-256 over the UTF-8 encoding of a string → 64-char hex. */
export function sha256Hex(text) {
  return bytesToHex(sha256Bytes(new TextEncoder().encode(String(text ?? ""))));
}

/** HMAC-SHA-256 (RFC 2104) over the UTF-8 encoding of `text`, keyed by raw
 * key bytes → 64-char hex. Used for the OPAQUE run/preview attestation
 * receipts: a keyed digest is not dictionary-testable against guessed owner
 * text the way a public stable fingerprint is (the review's privacy finding),
 * because the per-install key never leaves storage. */
export function hmacSha256Hex(keyBytes, text) {
  let key = keyBytes instanceof Uint8Array
    ? keyBytes
    : new TextEncoder().encode(String(keyBytes ?? ""));
  if (key.length > 64) key = sha256Bytes(key);
  const ipad = new Uint8Array(64 + 0);
  const opad = new Uint8Array(64 + 0);
  for (let i = 0; i < 64; i++) {
    const kb = i < key.length ? key[i] : 0;
    ipad[i] = kb ^ 0x36;
    opad[i] = kb ^ 0x5c;
  }
  const msg = new TextEncoder().encode(String(text ?? ""));
  const inner = new Uint8Array(64 + msg.length);
  inner.set(ipad);
  inner.set(msg, 64);
  const innerHash = sha256Bytes(inner);
  const outer = new Uint8Array(64 + innerHash.length);
  outer.set(opad);
  outer.set(innerHash, 64);
  return bytesToHex(sha256Bytes(outer));
}

/* ── UTF-8 accounting (byte-accurate bounds, malformed-Unicode rejection) ── */

/** The UTF-8 BYTE length of a string (JS `.length` counts UTF-16 code units —
 * wrong for any non-ASCII text). */
export function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).byteLength;
}

/** Does the string contain a LONE surrogate (malformed Unicode)? A lone
 * surrogate can never round-trip through UTF-8 (TextEncoder silently rewrites
 * it to U+FFFD), so inputs carrying one are REJECTED fail-closed rather than
 * silently mutated. */
export function hasLoneSurrogates(text) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true; // unpaired lead
      i++; // skip the trail half of a valid pair
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // unpaired trail
    }
  }
  return false;
}

/** Truncate to at most `maxBytes` of UTF-8 WITHOUT splitting a code point
 * (iterates code points, so a surrogate pair is never halved — the review's
 * UTF-16 slice finding).
 *
 * MALFORMED-INPUT CONTRACT (sanitize, never propagate): a lone surrogate can
 * never round-trip through UTF-8 (TextEncoder silently rewrites it to U+FFFD),
 * so truncateUtf8 DROPS lone-surrogate code units instead of re-appending the
 * malformed original. The output is ALWAYS well-formed Unicode:
 * hasLoneSurrogates(truncateUtf8(x, n)) === false for every input. Callers
 * that must REJECT malformed input outright (owner-entered override text) use
 * hasLoneSurrogates fail-closed BEFORE this helper; this helper guarantees it
 * never manufactures or propagates malformed output. */
export function truncateUtf8(text, maxBytes) {
  const s = String(text ?? "");
  const enc = new TextEncoder();
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    // A single-code-unit iteration value in the surrogate range is a LONE
    // surrogate (a valid pair iterates as one two-unit code point) — drop it.
    if (ch.length === 1) {
      const c = ch.charCodeAt(0);
      if (c >= 0xd800 && c <= 0xdfff) continue;
    }
    bytes += enc.encode(ch).byteLength;
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

/**
 * Classify a runtime message sender + derive/validate the tool-report origin.
 * Pure: takes a sender-shaped object, returns a decision. This is the sender
 * authorization boundary — a content script may only report tools for ITS OWN
 * page origin, never a message-supplied one.
 *
 * Returns: { kind: "content-script"|"extension"|"unmatched", origin?, error? }
 */
/**
 * Owner approvals may be resolved only by the exact Settings document. This
 * checks browser-supplied sender metadata, never message-body claims. A tab
 * sender is rejected even if it claims the extension URL.
 */
export const SETTINGS_SECTIONS = Object.freeze([
  "providers",
  "mcp-servers",
  "local-folders",
  "tool-library",
  "skills",
  "agents",
  "browser",
  "board-permissions",
  "permissions",
  "hooks",
  "prompts",
  "usage",
  "data",
  "about",
]);

// The DEVELOPER-only subset of the Settings sections. With the developer flag
// off (the default, CAP-FB-20260830-EXEC-BUILD-FLAG-01) these nav items and
// panels are hidden and their renderers are skipped; the ids stay valid so a
// deep link still resolves (and shows a "turn on developer features" notice).
// These are the platform/plumbing lanes, never a user-facing surface — Local
// folders and Browser control stay visible because they are legitimate user
// features (their monolith fold is owned by CAP-FB-20260827-SETTINGS-MONOLITH-01,
// not this flag).
export const DEVELOPER_SECTIONS = Object.freeze([
  "tool-library",
  "board-permissions",
  "hooks",
  "prompts",
]);

export const DEVELOPER_SECTIONS_SET = new Set(DEVELOPER_SECTIONS);

// The kv key for the developer-features preference. Defined here (a dependency-
// free module) so the Settings page can read/write it without importing the
// heavy model layer; lib/provider.js re-exports it as DEVELOPER_FEATURES_KEY so
// developerFeaturesOn() and the Settings toggle share one source of truth.
export const DEVELOPER_FEATURES_KEY = "cap:developerFeatures";

export function normalizeSettingsSectionId(hash) {
  if (typeof hash !== "string" || !hash) return null;
  const clean = hash.startsWith("#") ? hash.slice(1).trim() : hash.trim();
  // Legacy background-agent deep links now land on the unified Agents section.
  if (clean === "background-agents" || clean === "background") return "agents";
  if (SETTINGS_SECTIONS.includes(clean)) return clean;
  return null;
}

export const OPTIONS_PRODUCT_HASHES = new Set([
  "#providers", "#mcp-servers", "#local-folders", "#tool-library", "#skills", "#agents", "#background",
  "#background-agents", "#board-permissions",
  "#browser", "#permissions", "#hooks",
  "#prompts", "#usage", "#data", "#about",
]);

export function isExactOptionsSender(sender, extensionId, exactOptionsUrl) {
  if (!sender || typeof sender !== "object") return false;
  if (typeof extensionId !== "string" || !extensionId) return false;
  if (typeof exactOptionsUrl !== "string" || !exactOptionsUrl || /[?#]/.test(exactOptionsUrl)) return false;
  // Settings owns these fragment-only deep links. Accepting an explicit closed
  // set reconciles the product's own navigation with sender authorization while
  // preserving exact document/origin equality and rejecting every query,
  // foreign path, unknown fragment, or mixed query+fragment.
  const exactDocument = sender.url === exactOptionsUrl ||
    (typeof sender.url === "string" && OPTIONS_PRODUCT_HASHES.has(sender.url.slice(exactOptionsUrl.length)) && sender.url.startsWith(exactOptionsUrl));
  // The shipped NTP presents this exact private extension document in an
  // iframe. Chrome may omit frame/lifecycle/tab metadata for extension pages.
  // Web pages cannot load this non-web-accessible document; browser-supplied
  // extension id + exact document URL/product-owned hash + document id are the
  // authority.
  return sender.id === extensionId &&
    exactDocument &&
    // Chrome omits `origin` for extension-page runtime messages; the exact
    // browser-supplied chrome-extension:// URL already binds the origin.
    (sender.origin == null || sender.origin === `chrome-extension://${extensionId}`) &&
    (sender.documentLifecycle == null || sender.documentLifecycle === "active") &&
    typeof sender.documentId === "string" && sender.documentId.length > 0;
}

export function authorizeToolReport(
  sender,
  messageOrigin,
  canonicalOrigin,
  extensionId,
) {
  const senderUrl = sender?.url ?? "";
  const senderTabUrl = sender?.tab?.url ?? "";
  const isContentScript = Boolean(
    sender?.id === extensionId &&
      senderTabUrl &&
      !senderUrl.startsWith("chrome-extension://") &&
      !senderUrl.startsWith("moz-extension://") &&
      sender?.frameId === 0,
  );
  if (!isContentScript) {
    if (!senderUrl.startsWith("chrome-extension://") && senderTabUrl) {
      return {
        kind: "unmatched",
        error: "tool reports must come from the page's top frame",
      };
    }
    return { kind: "extension" };
  }
  const senderOrigin = canonicalOrigin(senderTabUrl);
  if (!senderOrigin) {
    return { kind: "content-script", error: "invalid sender origin" };
  }
  if (sender?.origin && canonicalOrigin(sender.origin) !== senderOrigin) {
    return { kind: "content-script", error: "sender origin mismatch — tool report rejected" };
  }
  if (messageOrigin && canonicalOrigin(messageOrigin) !== senderOrigin) {
    return {
      kind: "content-script",
      error: "origin mismatch — tool report rejected",
    };
  }
  return { kind: "content-script", origin: senderOrigin };
}

/** SECRET-key pattern for `redactSecrets`: any object key matching this must
 * never be serialized into a hook task/prompt/journal (the wider-goal review's
 * CRITICAL — the storage.onChanged hook forwarded providerConfig.apiKey). */
// Structural: a key whose NAME looks like a credential. BOTH-side boundaries
// prevent false positives on ordinary words that merely CONTAIN a keyword
// (tokenCount, secretary, mytoken, notasecret) — the keyword must START and
// END at a non-word-char boundary.
export const SECRET_KEY_RE = /(?<![a-z0-9])(api[_-]?key|token|secret|password|authorization|credential|bearer|access[_-]?key)(?![a-z0-9])/i;

/** Escape a literal for safe RegExp construction. */
function _reEsc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** NFKC-normalize (handles fullwidth/confusable + combining forms). */
function _nfkc(s) {
  try { return String(s).normalize("NFKC"); } catch { return String(s); }
}

/** Mask the QUERY STRING of every http(s) URL embedded ANYWHERE in the text
 *  (messages, reasons, bodies — not just explicit url: fields): the query is
 *  dropped entirely (sig=, key=, token=, or ANY unknown credential param). */
function _stripUrlQueries(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>)]+/gi, (m) => {
    const cut = m.search(/[?#]/);
    return cut >= 0 ? m.slice(0, cut) + "…[query redacted]" : m;
  });
}

/** A secret VALUE that may appear inside arbitrary error text: a configured
 * key echoed back by a hostile/misbehaving endpoint, a Bearer credential, or
 * credentials embedded in a URL. Exported for unit tests.
 *
 * Robustness (the final review's HIGH): known secrets are masked
 * case-insensitively, in their NFKC-NORMALIZED forms, and from length >= 4
 * (short keys count too); embedded URL queries are stripped WHOLESALE (any
 * unknown credential param, not a keyword list). */
export function redactSecretText(text, knownSecrets = []) {
  let out = _nfkc(String(text ?? ""));
  // Known secrets (longest first). COLLISION-SAFE FOR ALL LENGTHS (the
  // successor review): NO global substring masking at any length — every
  // known secret masks ONLY inside credential CONTEXTS (after a bounded
  // credential keyword with separator/whitespace, or in a Bearer/Basic header
  // value). Prose containing a colliding substring (any length) and existing
  // [REDACTED] markers are never corrupted.
  const secrets = knownSecrets
    .filter((s) => typeof s === "string" && s.length >= 1)
    .map((s) => [s, _nfkc(s), (() => { try { return encodeURIComponent(s); } catch { return s; } })()])
    .flat()
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .sort((a, b) => b.length - a.length);
  const KW = "(?<![a-z0-9])(?:api[_-]?key|access[_-]?key|key|token|secret|password|authorization|credential|bearer)(?![a-z0-9])";
  for (const s of secrets) {
    // EVERY length: credential-context-only masking.
    out = out.replace(
      new RegExp(`${KW}["'\`]?\\s*[:=]?\\s*["'\`]?\\s*${_reEsc(s)}(?![a-z0-9])`, "gi"),
      (m) => m.slice(0, Math.max(0, m.length - s.length)) + "[REDACTED]",
    );
    out = out.replace(
      new RegExp(`((?:bearer|basic)\\s+)${_reEsc(s)}`, "gi"),
      "$1[REDACTED]",
    );
  }
  // Embedded URL queries: strip wholesale (covers sig=, key=, token=, and
  // every unrecognized credential param) — BEFORE the credential-shape pass
  // so URL tails never hide a shape match.
  out = _stripUrlQueries(out);
  // Bearer/Basic credentials in text + URL userinfo passwords.
  out = out.replace(/(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]");
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:\/\s]+:)([^@\s]{4,})@/gi, "$1[REDACTED]@");
  // A bounded keyword followed by a credential SHAPE (colon/quote OR bare
  // whitespace): `api_key=…`, `bad key sk-…`, `key: ghp_…`.
  out = out.replace(
    /((?<![a-z0-9])(?:api[_-]?key|access[_-]?key|key|token|secret|password|authorization|credential|bearer)(?![a-z0-9])["'`]?\s*[:=]?\s*["'`]?\s*)((?:sk|rk|pk|key|tok|ghp|gho|xox|AIza|sig)[A-Za-z0-9_-]{3,}|Bearer\s+\S{8,})/gi,
    "$1[REDACTED]",
  );
  // Generic assignment redaction (keyword + separator + any 6+ char value).
  out = out.replace(
    /((?<![a-z0-9])(?:api[_-]?key|token|secret|password|authorization|credential|access[_-]?key)(?![a-z0-9])["'`]?\s*[:=]\s*["'`]?)([^\s"'`,;}]{6,})/gi,
    "$1[REDACTED]",
  );
  return out;
}

/** Bound an arbitrary error string to a safe display length (the provider's
 * raw body can be huge; only the head is ever useful). */
export function boundErrorText(text, max = 300) {
  const s = String(text ?? "").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** The single safe-mapping point for provider errors crossing into
 * console/UI/storage: redact known secrets + pattern-embedded credentials,
 * then bound the length. Every provider error surface (the model adapter's
 * fetch logging, the connection tester's messages, the Settings error
 * bubbles) routes through here (the sol review's HIGH-2). */
export function safeProviderError(text, knownSecrets = []) {
  return boundErrorText(redactSecretText(text, knownSecrets));
}

/**
 * Deep-redact secret VALUES from an arbitrary payload (pure, dependency-free).
 * Every object key matching SECRET_KEY_RE is replaced with "[REDACTED]"; arrays
 * and nested objects are recursed. Strings (which may themselves contain
 * secrets inside arbitrary text) pass through unchanged — the storage hook
 * additionally passes only KEY NAMES, never values (see the storage.onChanged
 * map in the service worker), so a credential string is never serialized.
 */
export function redactSecrets(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  // Path-scoped cycle guard: an object is only "seen" while it is an
  // ANCESTOR of the current position, so a cyclic payload degrades to a
  // "[Circular]" placeholder instead of throwing RangeError, while a
  // legitimately SHARED (DAG) subtree is still redacted at every site.
  // "[Circular]" is display-only; a literal string with that value is
  // intentionally indistinguishable because no consumer treats it semantically.
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      return value.map((v) => redactSecrets(v, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redactSecrets(v, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return value;
}

/** redactDeep — BOTH redaction layers for a structured value crossing a
 * UI/broadcast/journal boundary (the tool-call clarity fix): secret-valued
 * KEYS (SECRET_KEY_RE) AND credential-SHAPED string values (redactSecretText:
 * `key: sk-…`, Bearer …, apiKey=… patterns). Bounded depth so a hostile deep
 * object cannot recurse without limit; never throws on hostile input. */
export function redactDeep(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    try { return redactSecretText(value); } catch { return value; }
  }
  if (depth > 8) return "[depth-capped]";
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((v) => redactDeep(v, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ >= 200) { out["…"] = "[truncated]"; break; }
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** The exact message types a page's content script is allowed to route. */
// The exact message types a page's content script is allowed to route.
// NOTE: approval is an OWNER security decision and stays extension-only — a
// content script must NEVER be able to approve its own page tools.
export const PAGE_ALLOWED_ROUTES = new Set([
  "webmcp.detect.bootstrap", // extension-private key delivery for passive detection
  "webmcp.detect.arm", // arms the exact MAIN-world document after the relay has its key
  "webmcp.detected", // detection-only capability snapshot; sender origin is browser-derived
  "tools.list",
  "tools.upsert",
  "tools.pending",
  "webmcp.diagnostics.get", // read-only owner toggle (a page's script may read its own diagnostics gate)
  "enrollment.status", // read-only: a freshly-injected bridge syncs the enrollment generation for ITS OWN origin (sender-derived)
]);

// ── WebMCP status bounding + discovery-snapshot ordering (pure, testable) ──
// The SW-attested lifecycle (script registration/injection) is kept STRICTLY
// separate from page-reported tool data: a page can report tools, but it can
// never write the attested lifecycle fields — page reports land in a labeled
// `lastReport` section only.

/** The closed set of SW-attested script lifecycle states. Anything else is
 * coerced to "injection-error" so a caller can never inject a fabricated
 * status string into the attested record. */
export const WEBMCP_SCRIPT_STATUSES = new Set([
  "none",
  "registered",
  "no-open-tabs",
  "no-scripting-permission",
  "injected",
  "injection-partial",
  "injection-failed",
  "injection-error",
]);

// The ONE diagnostics error bound — a UTF-16 CODE-UNIT bound (JS string
// length semantics; NOT a UTF-8 byte bound and NOT a code-point count).
// The persisted cap:webmcpStatus error is bounded in code units.
export const WEBMCP_ERROR_BOUND = 240;

/** Bound a lifecycle error to WEBMCP_ERROR_BOUND UTF-16 code units. The slice
 * is SURROGATE-SAFE: if the truncation would leave a lone high surrogate as
 * the final code unit, that unit is dropped too (a malformed pair must never
 * be persisted). */
export function boundWebmcpError(e, max = WEBMCP_ERROR_BOUND) {
  if (e == null) return null;
  const text = String(e);
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const last = sliced.charCodeAt(sliced.length - 1);
  const drops = last >= 0xd800 && last <= 0xdbff ? 1 : 0;
  return sliced.slice(0, sliced.length - drops);
}

/** Clamp a count to a sane non-negative integer (page-reported counts are
 * untrusted). */
export function clampToolCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), 100000);
}

/** Build the PAGE-REPORTED section of the status record from the SANITIZED
 * (bounded) tool descriptors the SW accepted — never from the raw page
 * payload, so out-of-bounds descriptors cannot inflate the status. */
export function buildWebmcpPageReport(tools, at = Date.now()) {
  const list = Array.isArray(tools) ? tools : [];
  return {
    at,
    declaredCount: clampToolCount(list.filter((t) => t?.source === "declared").length),
    inferredCount: clampToolCount(list.filter((t) => t?.source === "inferred").length),
    toolCount: clampToolCount(list.length),
    toolNames: list
      .map((t) => String(t?.name ?? "").slice(0, 128))
      .filter(Boolean)
      .slice(0, 50),
  };
}

/** Merge an SW-ATTESTED lifecycle patch into the status record. Only the
 * service worker calls this; a page report can never masquerade as an
 * attested lifecycle state. A lifecycle record for a DIFFERENT origin drops
 * the previous origin's page report (the record is a single latest slot). */
export function applyWebmcpLifecycle(prev, patch, at = Date.now()) {
  const origin = String(patch?.origin ?? "");
  const status = WEBMCP_SCRIPT_STATUSES.has(patch?.scriptStatus)
    ? patch.scriptStatus
    : "injection-error";
  const sameOrigin = prev && prev.origin === origin;
  return {
    origin,
    at,
    scriptStatus: status,
    scriptStatusAt: at,
    scriptError: boundWebmcpError(patch?.error),
    injection: patch?.injection ?? null,
    lastReport: sameOrigin ? prev.lastReport ?? null : null,
  };
}

/** Merge a PAGE-REPORTED tool snapshot into the status record. Never touches
 * the SW-attested lifecycle fields. */
export function applyWebmcpPageReport(prev, origin, report) {
  const sameOrigin = prev && prev.origin === origin;
  const base = sameOrigin
    ? prev
    : {
        origin,
        at: report.at,
        scriptStatus: "none",
        scriptStatusAt: null,
        scriptError: null,
        injection: null,
        lastReport: null,
      };
  return { ...base, at: report.at, lastReport: report };
}

/** Summarize per-tab per-role injection results. A tab is READY only when BOTH
 * the MAIN-world and the ISOLATED-world script injected; exactly one world
 * succeeding is a PARTIAL (the bridge without MAIN discovers nothing, MAIN
 * without the bridge reports nowhere) and must be surfaced, never counted as
 * success. */
export function summarizeInjection(results) {
  const list = Array.isArray(results) ? results : [];
  const ready = [];
  const partial = [];
  const failed = [];
  for (const r of list) {
    const main = r?.main === true;
    const bridge = r?.bridge === true;
    if (main && bridge) {
      ready.push(r.tabId);
    } else if (!main && !bridge) {
      failed.push({ tabId: r?.tabId ?? null, error: boundWebmcpError(r?.error) });
    } else {
      partial.push({
        tabId: r?.tabId ?? null,
        missing: [main ? null : "main", bridge ? null : "bridge"].filter(Boolean),
      });
    }
  }
  const scriptStatus = list.length === 0
    ? "no-open-tabs"
    : partial.length === 0 && failed.length === 0
      ? "injected"
      : ready.length === 0
        ? "injection-failed"
        : "injection-partial";
  return { targets: list.length, ready, partial, failed, scriptStatus };
}

// ── Discovery-snapshot ordering: origin / tab / document / navigation epoch ──
// The round-30 blocker: the old gate accepted ANY new random session id
// unconditionally, so a late report from an older session — or from a SECOND
// same-origin tab — could replace a newer snapshot. The gate is now keyed by
// the origin and ordered by BROWSER-ATTESTED identity the page cannot forge:
// the service worker derives `tabId` + `documentId` from the message SENDER
// (never from the message body) and assigns a MONOTONIC navigation epoch per
// origin. A snapshot is accepted only from the bound tab's CURRENT document
// with an advancing per-document sequence.

/** The empty per-origin snapshot gate. `maxEpoch` is monotonic and survives
 * re-enrollment seeding, so a navigation epoch is never reissued. */
export function emptySnapshotGate() {
  return { tabId: null, documentId: null, epoch: -1, maxEpoch: -1, seq: -1 };
}

function validTabId(tabId) {
  return typeof tabId === "number" && Number.isInteger(tabId) && tabId >= 0;
}
function validDocumentId(documentId) {
  return typeof documentId === "string" && documentId.length > 0 && documentId.length <= 128;
}
function validSeq(seq) {
  return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 && seq <= 1e9;
}

/** Seed/rebind the gate at (re-)enrollment. A picker-approved tab becomes the
 * ONLY tab whose reports are accepted (`pickedTabId`); a null pick leaves the
 * gate unbound so the first reporting tab binds. `maxEpoch` is preserved — a
 * re-enrollment must never reissue a stale navigation epoch. */
export function seedSnapshotGate(prev, pickedTabId) {
  const maxEpoch = Number.isInteger(prev?.maxEpoch) ? prev.maxEpoch : -1;
  return {
    tabId: validTabId(pickedTabId) ? pickedTabId : null,
    documentId: null,
    epoch: -1,
    maxEpoch,
    seq: -1,
  };
}

/** A bridge startup sync observed a document on a tab. Advances the gate to
 * that document with a fresh monotonic epoch when the document is NEW on the
 * bound tab (a navigation). Returns { gate, bound } — `bound` is false when
 * the sender is NOT the authoritative tab (a second same-origin tab never
 * displaces the bound tab's document). Pure. */
export function syncSnapshotDocument(prev, tabId, documentId) {
  const gate = prev ?? emptySnapshotGate();
  if (!validTabId(tabId) || !validDocumentId(documentId)) {
    return { gate, bound: false };
  }
  if (gate.tabId == null) {
    const epoch = gate.maxEpoch + 1;
    return { gate: { tabId, documentId, epoch, maxEpoch: epoch, seq: -1 }, bound: true };
  }
  if (tabId !== gate.tabId) return { gate, bound: false };
  if (documentId === gate.documentId) return { gate, bound: true };
  const epoch = gate.maxEpoch + 1;
  return { gate: { tabId, documentId, epoch, maxEpoch: epoch, seq: -1 }, bound: true };
}

/** Accept a complete replacement snapshot ONLY from the current
 * (tab, document, epoch) with an advancing per-document sequence. `report` is
 * { tabId, documentId, epoch, seq } where tabId/documentId are
 * SENDER-DERIVED by the service worker and `epoch` is the epoch the SW issued
 * to that document at its startup sync (echoed by the bridge — a stale
 * document can only echo its own older epoch and is rejected). Returns
 * { accept, gate }. Pure. */
export function acceptToolSnapshot(prev, report) {
  const gate = prev ?? emptySnapshotGate();
  const { tabId, documentId, epoch, seq } = report ?? {};
  if (!validTabId(tabId) || !validDocumentId(documentId) || !validSeq(seq)) {
    return { accept: false, gate };
  }
  // Snapshot reports NEVER establish identity. Only enrollment.status from an
  // active, browser-attested document may bind/advance the gate through
  // syncSnapshotDocument; otherwise a report that raced startup could choose
  // its own identity/epoch.
  if (gate.tabId == null || gate.documentId == null || gate.epoch < 0) {
    return { accept: false, gate };
  }
  if (tabId !== gate.tabId) {
    return { accept: false, gate }; // a second same-origin tab never replaces
  }
  if (documentId !== gate.documentId) {
    return { accept: false, gate }; // a stale document's late report
  }
  if (epoch !== gate.epoch) {
    return { accept: false, gate }; // a wrong/older navigation epoch
  }
  if (seq <= gate.seq) {
    return { accept: false, gate }; // a same-document replay/stale sequence
  }
  return { accept: true, gate: { ...gate, seq } };
}

/** The page-identity seam: whether a tab matches the invocation target.
 * `targetIdentity` is { origin } today (origin equality); the page-scoped
 * identity lane refines it to { origin, path } without touching the SW flow. */
export function matchesPageIdentity(tab, targetIdentity) {
  const t = tab && typeof tab === "object" ? tab : null;
  const target = targetIdentity && typeof targetIdentity === "object" ? targetIdentity : null;
  if (!t || !target) return false;
  if (typeof target.origin !== "string" || !target.origin) return false;
  const tabUrl = typeof t.url === "string" ? t.url : "";
  if (!tabUrl) return false;
  let tabOrigin;
  try {
    const u = new URL(tabUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    tabOrigin = u.origin;
  } catch {
    return false;
  }
  if (tabOrigin !== target.origin) return false;
  if (typeof target.path === "string" && target.path) {
    try {
      const p = new URL(tabUrl).pathname || "/";
      return p === target.path;
    } catch {
      return false;
    }
  }
  return true;
}

/** Pure planner for the invocation tab (CAP-FB-20260824-WEBMCP-EXECUTION-01 /
 * CAP-FB-20260824-WEBMCP-PAGE-IDENTITY-01): the bound tab's binding is resolved
 * if its tab is alive and matches the target identity (origin + optional path);
 * otherwise the planner prefers the active same-identity tab, then the lowest
 * tabId, deterministically. When opening a new tab for a page-scoped tool, the
 * exact page URL is used. Never invents a candidate. */
export function planWebmcpInvocationTab({ canonical, path = null, pageUrl = null, binding, tabs }) {
  if (typeof canonical !== "string" || !canonical) return { kind: "open", url: canonical };
  const list = Array.isArray(tabs) ? tabs : [];
  let targetPath = path;
  if (!targetPath && pageUrl) {
    try { targetPath = new URL(pageUrl).pathname || "/"; } catch { targetPath = null; }
  }
  const target = targetPath ? { origin: canonical, path: targetPath } : { origin: canonical };
  // The BOUND tab: alive and still on the origin/page → the current path.
  if (binding && typeof binding === "object" && typeof binding.tabId === "number") {
    const bound = list.find((t) => t?.id === binding.tabId);
    if (bound && matchesPageIdentity(bound, target)) {
      return {
        kind: "bound",
        tabId: binding.tabId,
        documentId: typeof binding.documentId === "string" ? binding.documentId : "",
      };
    }
  }
  // Reuse an existing matching tab: the ACTIVE one first, else the lowest id.
  const matching = list.filter((t) => t && typeof t.id === "number" && matchesPageIdentity(t, target));
  if (matching.length) {
    const active = matching.find((t) => t?.active === true);
    const pick = active ?? matching.slice().sort((a, b) => a.id - b.id)[0];
    return { kind: "reuse", tabId: pick.id };
  }
  const openUrl = pageUrl || (targetPath && targetPath !== "/" ? `${canonical}${targetPath.startsWith("/") ? targetPath : `/${targetPath}`}` : canonical);
  return { kind: "open", url: openUrl };
}

/** The deliberate re-bind transition (mirrors seedSnapshotGate): replaces a
 * DEAD binding so the resolved tab's bridge re-binds through the existing
 * enrollment.status → tools.upsert flow. `maxEpoch` is preserved (never
 * reissue a stale epoch). NEVER displaces a live binding (the caller proves
 * dead/absent first — the round-30 fence). Pure. */
export function rebindSnapshotGate(prev, tabId) {
  if (!validTabId(tabId)) return prev ?? emptySnapshotGate();
  const maxEpoch = Number.isInteger(prev?.maxEpoch) ? prev.maxEpoch : -1;
  return { tabId, documentId: null, epoch: -1, maxEpoch, seq: -1 };
}

/** Parse an omnibox-entered string into an intent.
 *  - "recipe:<id>"  → { kind: "recipe", id }
 *  - "thread:<id>"  → { kind: "thread", id }
 *  - anything else   → { kind: "run", query } (the raw text is a task)
 *  Empty/whitespace → { kind: "none" }. */
export function parseOmniboxContent(content) {
  const c = String(content ?? "").trim();
  if (!c) return { kind: "none" };
  if (c.startsWith("recipe:")) return { kind: "recipe", id: c.slice("recipe:".length).trim() };
  if (c.startsWith("thread:")) return { kind: "thread", id: c.slice("thread:".length).trim() };
  return { kind: "run", query: c };
}

/** The manifest `commands` ids, in the order Settings lists them. Kept beside
 * the parser so the UI, the service worker and the tests share ONE list — a
 * hand-copied second list is exactly how the composer/+menu duplicates drifted. */
export const KEYBOARD_COMMANDS = ["open-hub", "new-task", "open-side-panel"];

/** The hub URL a keyboard command should open. "new-task" lands on "#compose",
 * which parseNtpHash routes to the hub with the task composer focused. No
 * command ever carries a payload — a shortcut must not inject task text. */
export function hubUrlForCommand(command, getURL) {
  const base = getURL("ntp/ntp.html");
  return command === "new-task" ? `${base}#compose` : base;
}

/* ── Single-sourced shared helpers (CAP-FB-20260830-ESCAPEHTML-SINGLE-SOURCE-01)
 * Every page, worker and the service worker imports THESE. A second copy of any
 * of them anywhere under extension/ fails tests/single-source-helpers.test.ts
 * — the hub and Settings each carried an escapeHtml that skipped the single
 * quote, which is exactly the drift a grep guard exists to stop. This module
 * is dependency-free so the agent worker (where components.js cannot load)
 * can import it too. ─────────────────────────────────────────────────────── */

/** Escape untrusted text for an HTML sink. THE STRICT ONE: `& < > " '` — the
 * single quote too, so a single-quoted attribute built with it cannot be broken
 * out of. components.js re-exports this for the pages and the gallery. */
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** A relative timestamp label ("just now" / "5m ago" / "3h ago" / "2d ago"). */
export function timeAgo(ts) {
  const d = Date.now() - (ts ?? 0);
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** REAL SHA-256 over raw bytes (a Uint8Array / ArrayBuffer) or the UTF-8
 * encoding of a string → 64-char hex, via WebCrypto. Async, so file-sized
 * inputs (the OPFS workspace CAS, artifact digests, Wasm package bytes) never
 * block the thread; the synchronous `sha256Hex(text)` above stays for the
 * short security fingerprints that must be computable without an await. */
export async function sha256HexBytes(input) {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input instanceof Uint8Array
    ? input
    : new Uint8Array(input ?? []);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** A unique id: `${prefix}_${uuid}`, or the bare UUID with no prefix. Every
 * store-facing id (threads, tasks, screenshots, assets, scripts, board jobs,
 * grants, lock tokens) mints here; the UUID charset (`[0-9a-f-]`) satisfies
 * every id validator in the tree (thread ids are `[A-Za-z0-9_-]{1,200}`). The
 * Date/Math fallback exists ONLY for a realm without crypto.randomUUID and is
 * the one place that pattern is allowed to live. */
export function newId(prefix = "") {
  const uuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

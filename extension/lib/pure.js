// lib/pure.js — pure, dependency-free helpers (no chrome.*, no AI SDK) so the
// security-critical logic can be unit-tested in Deno without a browser.

/** Bounds for the schema converter (fail-closed against hostile descriptors). */
export const SCHEMA_BOUNDS = {
  maxDepth: 4,
  maxProperties: 50,
  maxArrayItems: 100,
  maxStringLength: 10000,
  maxUnionBranches: 5,
  maxLiteralDepth: 8,
};

/**
 * The exact JSON-Schema keywords this converter supports. Anything else is
 * REJECTED (fail closed) — never silently ignored or loosened.
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
  "anyOf", // union (exactly-one oneOf is NOT supported)
]);

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
    for (const k of ka) if (!deepEqual(a[k], b[k], depth + 1)) return false;
    return true;
  }
  return false;
}

/**
 * Validate the COMPLETE schema AST first — every keyword value shape, every
 * per-type keyword rule, every nested subschema — and only then compile.
 * Returns true if the tree is a supported, well-formed schema; false otherwise.
 * This prevents fail-open cases where a malformed child silently became
 * optional z.never() or a lone union branch.
 */
function validateSchemaAST(schema, depth) {
  if (depth > SCHEMA_BOUNDS.maxDepth) return false;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;

  // Strict keyword allowlist — anything outside it is REJECTED.
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return false;
  }
  // oneOf (exactly-one) + pattern (regex DoS) are not supported — reject.
  if (schema.oneOf !== undefined || schema.pattern !== undefined) return false;
  // additionalProperties must be a boolean (false → strict). Schema-valued → reject.
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) return false;

  // ---- keyword value SHAPES (malformed shape → reject) ----
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((k) => typeof k !== "string")
    ) return false;
    // Every required name must be DECLARED in properties (a required key with
    // no properties, or a required key absent from properties, is malformed).
    if (schema.properties === undefined || schema.properties === null) return false;
    const propKeys = Object.keys(schema.properties);
    for (const k of schema.required) {
      if (!propKeys.includes(k)) return false;
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) return false;
    if (schema.enum.length === 0 || schema.enum.length > SCHEMA_BOUNDS.maxUnionBranches) return false;
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf)) return false;
    if (schema.anyOf.length === 0 || schema.anyOf.length > SCHEMA_BOUNDS.maxUnionBranches) return false;
  }
  // items / properties must be plain objects (NOT null, NOT arrays).
  if (schema.items !== undefined) {
    if (schema.items === null || typeof schema.items !== "object" || Array.isArray(schema.items)) return false;
  }
  if (schema.properties !== undefined) {
    if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return false;
    const keys = Object.keys(schema.properties);
    if (keys.length > SCHEMA_BOUNDS.maxProperties) return false;
  }
  // numeric bounds: finite numbers for min/max; NON-NEGATIVE INTEGERS for
  // length/item counts (negative or fractional bounds are malformed).
  for (const k of ["minimum", "maximum"]) {
    if (schema[k] !== undefined && (typeof schema[k] !== "number" || !Number.isFinite(schema[k]))) return false;
  }
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (schema[k] !== undefined && (typeof schema[k] !== "number" || !Number.isInteger(schema[k]) || schema[k] < 0)) return false;
  }

  // ---- per-type keyword allowlist (a keyword on the wrong type → reject) ----
  const t = schema.type;
  if (t !== undefined && !["string", "number", "integer", "boolean", "array", "object", "null"].includes(t)) return false;
  const nonString = (s) => schema[s] !== undefined;
  if (t === "string") {
    if (nonString("minimum") || nonString("maximum") || nonString("items") || nonString("minItems") || nonString("maxItems") || nonString("properties") || nonString("required") || nonString("additionalProperties")) return false;
  } else if (t === "number" || t === "integer") {
    if (nonString("minLength") || nonString("maxLength") || nonString("items") || nonString("minItems") || nonString("maxItems") || nonString("properties") || nonString("required") || nonString("additionalProperties")) return false;
  } else if (t === "boolean") {
    if (nonString("minLength") || nonString("maxLength") || nonString("minimum") || nonString("maximum") || nonString("items") || nonString("minItems") || nonString("maxItems") || nonString("properties") || nonString("required") || nonString("additionalProperties")) return false;
  } else if (t === "null") {
    if (nonString("minLength") || nonString("maxLength") || nonString("minimum") || nonString("maximum") || nonString("items") || nonString("minItems") || nonString("maxItems") || nonString("properties") || nonString("required") || nonString("additionalProperties")) return false;
  } else if (t === "array") {
    if (nonString("minLength") || nonString("maxLength") || nonString("minimum") || nonString("maximum") || nonString("properties") || nonString("required") || nonString("additionalProperties")) return false;
  } else if (t === "object") {
    if (nonString("minLength") || nonString("maxLength") || nonString("minimum") || nonString("maximum") || nonString("items") || nonString("minItems") || nonString("maxItems")) return false;
  }

  // const must match the declared type (if declared) — a const value of the
  // wrong type makes the schema unsatisfiable.
  if (t !== undefined && schema.const !== undefined && !valueMatchesType(schema.const, t)) {
    return false;
  }
  // const AND enum together are only satisfiable if const is IN enum.
  if (schema.const !== undefined && schema.enum !== undefined) {
    if (!schema.enum.some((v) => deepEqual(v, schema.const))) return false;
  }
  // enum values that mismatch the declared type are EXCLUDED at compile time
  // (JSON Schema: a value that doesn't match the type simply never matches).

  // ---- recursive validation of nested subschemas ----
  if (schema.items !== undefined && !validateSchemaAST(schema.items, depth + 1)) return false;
  if (schema.properties !== undefined) {
    for (const key of Object.keys(schema.properties)) {
      if (!validateSchemaAST(schema.properties[key], depth + 1)) return false;
    }
  }
  if (schema.anyOf !== undefined) {
    for (const branch of schema.anyOf) {
      if (!validateSchemaAST(branch, depth + 1)) return false;
    }
  }

  return true;
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
    if (schema.items !== undefined) {
      for (const item of value) {
        if (!valueSatisfiesSchema(schema.items, item, depth + 1)) return false;
      }
    }
  }
  // object bounds + property validation.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const k of required) if (!(k in value)) return false;
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value && !valueSatisfiesSchema(sub, value[k], depth + 1)) return false;
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
  if (schema.anyOf !== undefined && !schema.anyOf.some((b) => valueSatisfiesSchema(b, value, depth + 1))) return false;
  return true;
}

/**
 * Convert a JSON-schema descriptor into a bounded zod schema — FAIL CLOSED.
 * The whole tree is validated first (validateSchemaAST); an unsupported or
 * malformed schema becomes z.never() (rejects everything), never a permissive
 * fallback. All supported sibling constraints are composed, never dropped.
 */

/**
 * Infer the type an UNTYPED schema implies from its bound siblings. Used to
 * compose an untyped `anyOf` with its root siblings (minLength → string,
 * minimum → number, items → array, properties/required → object). Returns a
 * string type, or null when nothing implies a type, or a sentinel CONFLICT
 * when multiple incompatible types are implied (fail closed).
 */
const CONFLICT = Symbol("type-conflict");
function inferTypeFromSiblings(schema) {
  let inferred = null;
  const claim = (t) => {
    if (inferred !== null && inferred !== t) return CONFLICT;
    inferred = t;
    return inferred;
  };
  if (schema.minLength !== undefined || schema.maxLength !== undefined) {
    if (claim("string") === CONFLICT) return CONFLICT;
  }
  if (schema.minimum !== undefined || schema.maximum !== undefined) {
    if (claim("number") === CONFLICT) return CONFLICT;
  }
  if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    if (claim("array") === CONFLICT) return CONFLICT;
  }
  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    if (claim("object") === CONFLICT) return CONFLICT;
  }
  return inferred;
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

export function schemaToZod(z, schema, depth = 0) {
  // Phase 1: validate the complete AST. Any malformed/unsupported shape fails
  // closed for the WHOLE schema (not just a branch that could become optional).
  if (!validateSchemaAST(schema, depth)) return z.never();

  // ---- const / enum compose their FULL sibling set (type + bounds + anyOf
  // + each other). A literal candidate must satisfy EVERY present constraint;
  // if none survive, the schema is unsatisfiable and fails closed. ----
  if (schema.const !== undefined) {
    if (!valueSatisfiesSchema(schema, schema.const, depth)) return z.never();
    return literalSchema(z, schema.const);
  }
  if (schema.enum !== undefined) {
    const valid = schema.enum.filter((v) => valueSatisfiesSchema(schema, v, depth));
    if (valid.length === 0) return z.never();
    return z.union(valid.slice(0, SCHEMA_BOUNDS.maxUnionBranches).map((v) => literalSchema(z, v)));
  }

  // Build the type + bounds guard (the base schema WITHOUT anyOf).
  // An UNTYPED schema carrying anyOf must still compose its root siblings:
  // infer the type the siblings imply (minLength → string, properties → object,
  // ...) and use that typed base; conflicting inferences fail closed; only a
  // truly unconstrained untyped union falls back to z.unknown().
  const base = (schema.type === undefined && schema.anyOf !== undefined)
    ? (() => {
        const inferred = inferTypeFromSiblings(schema);
        if (inferred === CONFLICT) return z.never();
        if (inferred === null) return z.unknown();
        return buildBaseZod(z, { ...schema, type: inferred });
      })()
    : buildBaseZod(z, schema);
  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((b) => schemaToZod(z, b, depth + 1));
    // Compose the declared type/bounds with anyOf — JSON Schema requires BOTH.
    // An UNTYPED schema with anyOf must NOT reject everything: base is z.unknown().
    return z.intersection(base, z.union(branches));
  }
  return base;
}

/** Build the zod schema for a schema's own type + bounds (no anyOf/const/enum). */
function buildBaseZod(z, schema) {
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
    const inner = schemaToZod(z, schema.items, 1);
    let arr = z.array(inner);
    if (schema.minItems !== undefined) arr = arr.min(schema.minItems);
    const pageMax = schema.maxItems !== undefined ? schema.maxItems : SCHEMA_BOUNDS.maxArrayItems;
    arr = arr.max(Math.min(pageMax, SCHEMA_BOUNDS.maxArrayItems));
    return arr;
  }
  if (t === "object") {
    const props = schema.properties || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const shape = {};
    for (const [key, sub] of Object.entries(props)) {
      const subZod = schemaToZod(z, sub, 1);
      shape[key] = required.has(key) ? subZod : subZod.optional();
    }
    const obj = z.object(shape);
    return schema.additionalProperties === false ? obj.strict() : obj.passthrough();
  }
  // No type declared: when reached here the schema has neither const/enum (those
  // are handled above) nor anyOf (also above), so an untyped, unconstrained
  // schema is a fail-closed z.never(). (An untyped schema WITH anyOf is handled
  // in schemaToZod, where base must be permissive — see below.)
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

/** FNV-1a 64-bit: two independent 32-bit FNV rounds, hex-encoded (16 chars). */
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

/**
 * Classify a runtime message sender + derive/validate the tool-report origin.
 * Pure: takes a sender-shaped object, returns a decision. This is the sender
 * authorization boundary — a content script may only report tools for ITS OWN
 * page origin, never a message-supplied one.
 *
 * Returns: { kind: "content-script"|"extension"|"unmatched", origin?, error? }
 */
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
  if (messageOrigin && canonicalOrigin(messageOrigin) !== senderOrigin) {
    return {
      kind: "content-script",
      error: "origin mismatch — tool report rejected",
    };
  }
  return { kind: "content-script", origin: senderOrigin };
}

/** The exact message types a page's content script is allowed to route. */
// The exact message types a page's content script is allowed to route.
// NOTE: approval is an OWNER security decision and stays extension-only — a
// content script must NEVER be able to approve its own page tools.
export const PAGE_ALLOWED_ROUTES = new Set([
  "tools.list",
  "tools.upsert",
  "tools.pending",
]);

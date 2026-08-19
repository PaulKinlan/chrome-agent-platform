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
  // const/enum literals must respect the SCHEMA_BOUNDS caps (a huge literal
  // must not bypass the size limits by returning before buildBaseZod).
  if (schema.const !== undefined && !literalWithinBounds(schema.const)) return false;
  if (
    schema.enum !== undefined &&
    !schema.enum.every((v) => literalWithinBounds(v))
  ) return false;
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

  // Build the base WITHOUT anyOf (type + bounds + object/array shape).
  const baseWithoutAnyOf = { ...schema };
  delete baseWithoutAnyOf.anyOf;

  // An UNTYPED schema composes its siblings by RUNTIME kind (minLength applies
  // only to strings, properties only to objects — JSON Schema semantics), not
  // by inferring a single declared type. A bare untyped union (no siblings)
  // falls back to z.unknown() so the union alone constrains; an unconstrained
  // untyped schema (no type, no siblings, no anyOf) is meaningless → z.never().
  const base = (() => {
    if (schema.type !== undefined) return buildBaseZod(z, schema);
    if (hasConstrainingSibling(baseWithoutAnyOf)) {
      return z.any().refine((value) =>
        valueSatisfiesSchema(baseWithoutAnyOf, value, depth), {
        message: "value must satisfy all schema constraints",
      });
    }
    return schema.anyOf !== undefined ? z.unknown() : z.never();
  })();

  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((b) => schemaToZod(z, b, depth + 1));
    // Compose the declared type/bounds with anyOf — JSON Schema requires BOTH.
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
  // No type declared and no constraining sibling: an unconstrained untyped
  // schema is fail-closed z.never(). (Untyped schemas WITH siblings are handled
  // in schemaToZod via valueSatisfiesSchema; those WITHOUT siblings but WITH
  // anyOf use z.unknown() there.)
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
export function isExactOptionsSender(sender, extensionId, exactOptionsUrl) {
  if (!sender || typeof sender !== "object") return false;
  if (typeof extensionId !== "string" || !extensionId) return false;
  if (typeof exactOptionsUrl !== "string" || !exactOptionsUrl) return false;
  const exactDocument = sender.url === exactOptionsUrl ||
    (typeof sender.url === "string" && sender.url.startsWith(`${exactOptionsUrl}#`));
  // The shipped NTP presents this exact private extension document in an
  // iframe. Chrome may omit frame/lifecycle/tab metadata for extension pages.
  // Web pages cannot load this non-web-accessible document; browser-supplied
  // extension id + exact document URL + document id are the authority.
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
export const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|authorization|credential|bearer|access[_-]?key)/i;

/**
 * Deep-redact secret VALUES from an arbitrary payload (pure, dependency-free).
 * Every object key matching SECRET_KEY_RE is replaced with "[REDACTED]"; arrays
 * and nested objects are recursed. Strings (which may themselves contain
 * secrets inside arbitrary text) pass through unchanged — the storage hook
 * additionally passes only KEY NAMES, never values (see the storage.onChanged
 * map in the service worker), so a credential string is never serialized.
 */
export function redactSecrets(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[REDACTED]" : redactSecrets(v);
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

/** Byte-bound an error string for the status record (page/SW exception text is
 * unbounded attacker-influenced data — never store it raw). */
export function boundWebmcpError(e, max = 300) {
  if (e == null) return null;
  return String(e).slice(0, max);
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

// lib/pure.js — pure, dependency-free helpers (no chrome.*, no AI SDK) so the
// security-critical logic can be unit-tested in Deno without a browser.

/** Bounds for the schema converter (fail-closed against hostile descriptors). */
export const SCHEMA_BOUNDS = {
  maxDepth: 4,
  maxProperties: 50,
  maxArrayItems: 100,
  maxStringLength: 10000,
  maxUnionBranches: 5,
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

/** A zod schema enforcing a JSON-Schema `type` string (used to compose anyOf). */
function typeZod(z, type) {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    case "object":
      return z.object({}).passthrough();
    case "null":
      return z.null();
    default:
      return z.never();
  }
}

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

/**
 * Convert a JSON-schema descriptor into a bounded zod schema — FAIL CLOSED.
 * An unsupported or malformed schema becomes z.never() (rejects everything),
 * never a permissive z.record(z.any()). Only a bounded, reviewed subset of
 * JSON Schema is supported; every keyword outside it is rejected, not ignored.
 */
export function schemaToZod(z, schema, depth = 0) {
  if (depth > SCHEMA_BOUNDS.maxDepth) return z.never();
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return z.never();
  }

  // Fail closed on ANY unsupported keyword (strict allowlist, not permissiveness).
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return z.never();
  }
  // oneOf (exactly-one) cannot be faithfully enforced with a zod union — reject.
  if (schema.oneOf !== undefined) return z.never();
  // pattern is a regex-DoS vector — reject.
  if (schema.pattern !== undefined) return z.never();
  // additionalProperties must be a boolean (false → strict); a schema-valued
  // additionalProperties is NOT supported — reject rather than passthrough.
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    return z.never();
  }

  const t = schema.type;

  // ---- per-keyword SHAPE validation (a malformed keyword fails closed) ----
  // required: if present must be a non-empty array of strings.
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((k) => typeof k !== "string")
    ) return z.never();
  }
  // enum / anyOf: if present must be an array.
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    return z.never();
  }
  if (schema.anyOf !== undefined && !Array.isArray(schema.anyOf)) {
    return z.never();
  }
  // items / properties: if present must be an object.
  if (schema.items !== undefined && typeof schema.items !== "object") {
    return z.never();
  }
  if (
    schema.properties !== undefined &&
    (typeof schema.properties !== "object" || Array.isArray(schema.properties))
  ) return z.never();
  // numeric bounds: if present must be a finite number.
  for (
    const k of [
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
      "minLength",
      "maxLength",
    ]
  ) {
    if (schema[k] !== undefined && typeof schema[k] !== "number") {
      return z.never();
    }
  }

  // const → literal, enum → union of literals — both validated against the
  // declared type so `{type:"string", enum:[42]}` fails closed.
  if (schema.const !== undefined) {
    if (t !== undefined && !valueMatchesType(schema.const, t)) return z.never();
    return z.literal(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) return z.never(); // empty enum = rejects everything
    if (schema.enum.length > SCHEMA_BOUNDS.maxUnionBranches) return z.never();
    if (schema.enum.length > SCHEMA_BOUNDS.maxUnionBranches) return z.never();
    // Enum values that mismatch the declared type are EXCLUDED (so
    // {type:"string", enum:[42,"a"]} rejects 42 and accepts "a"); if none
    // match, the enum is empty and rejects everything (fail closed).
    const valid = t !== undefined
      ? schema.enum.filter((v) => valueMatchesType(v, t))
      : schema.enum;
    if (valid.length === 0) return z.never();
    return z.union(
      valid.slice(0, SCHEMA_BOUNDS.maxUnionBranches).map((v) => z.literal(v)),
    );
  }
  if (Array.isArray(schema.anyOf)) {
    if (
      schema.anyOf.length === 0 ||
      schema.anyOf.length > SCHEMA_BOUNDS.maxUnionBranches
    ) return z.never();
    const branches = schema.anyOf.map((b) => schemaToZod(z, b, depth + 1));
    // Compose the declared `type` with anyOf (JSON Schema requires BOTH) by
    // intersecting the union with a type guard built from `t`.
    const typeGuard = t !== undefined ? typeZod(z, t) : null;
    return typeGuard
      ? z.intersection(z.union(branches), typeGuard)
      : z.union(branches);
  }

  // ---- per-type keyword allowlist (a keyword on the wrong type fails closed) ----
  if (t === "string") {
    if (
      schema.minimum !== undefined || schema.maximum !== undefined ||
      schema.items !== undefined || schema.minItems !== undefined ||
      schema.maxItems !== undefined || schema.properties !== undefined ||
      schema.required !== undefined || schema.additionalProperties !== undefined
    ) return z.never();
    let s = z.string();
    if (typeof schema.minLength === "number" && schema.minLength >= 0) {
      s = s.min(schema.minLength);
    }
    // Global cap is ALWAYS applied (even when the page omits maxLength) so a
    // hostile descriptor cannot describe an unbounded string.
    const pageMax =
      typeof schema.maxLength === "number" && schema.maxLength >= 0
        ? schema.maxLength
        : SCHEMA_BOUNDS.maxStringLength;
    s = s.max(Math.min(pageMax, SCHEMA_BOUNDS.maxStringLength));
    return s;
  }
  if (t === "number") {
    if (
      schema.minLength !== undefined || schema.maxLength !== undefined ||
      schema.items !== undefined || schema.minItems !== undefined ||
      schema.maxItems !== undefined || schema.properties !== undefined ||
      schema.required !== undefined || schema.additionalProperties !== undefined
    ) return z.never();
    let s = z.number();
    if (typeof schema.minimum === "number") s = s.min(schema.minimum);
    if (typeof schema.maximum === "number") s = s.max(schema.maximum);
    return s;
  }
  if (t === "integer") {
    if (
      schema.minLength !== undefined || schema.maxLength !== undefined ||
      schema.items !== undefined || schema.minItems !== undefined ||
      schema.maxItems !== undefined || schema.properties !== undefined ||
      schema.required !== undefined || schema.additionalProperties !== undefined
    ) return z.never();
    let s = z.number().int();
    if (typeof schema.minimum === "number") {
      s = s.min(Math.ceil(schema.minimum));
    }
    if (typeof schema.maximum === "number") {
      s = s.max(Math.floor(schema.maximum));
    }
    return s;
  }
  if (t === "boolean") {
    if (
      schema.minLength !== undefined || schema.maxLength !== undefined ||
      schema.minimum !== undefined || schema.maximum !== undefined ||
      schema.items !== undefined || schema.minItems !== undefined ||
      schema.maxItems !== undefined || schema.properties !== undefined ||
      schema.required !== undefined || schema.additionalProperties !== undefined
    ) return z.never();
    return z.boolean();
  }
  if (t === "null") {
    return z.null();
  }
  if (t === "array") {
    if (
      schema.minLength !== undefined || schema.maxLength !== undefined ||
      schema.minimum !== undefined || schema.maximum !== undefined ||
      schema.properties !== undefined || schema.required !== undefined ||
      schema.additionalProperties !== undefined
    ) return z.never();
    const inner = schemaToZod(z, schema.items, depth + 1);
    let arr = z.array(inner);
    if (typeof schema.minItems === "number" && schema.minItems >= 0) {
      arr = arr.min(schema.minItems);
    }
    const pageMax = typeof schema.maxItems === "number" && schema.maxItems >= 0
      ? schema.maxItems
      : SCHEMA_BOUNDS.maxArrayItems;
    arr = arr.max(Math.min(pageMax, SCHEMA_BOUNDS.maxArrayItems)); // global cap ALWAYS applied
    return arr;
  }
  if (t === "object") {
    if (
      schema.minLength !== undefined || schema.maxLength !== undefined ||
      schema.minimum !== undefined || schema.maximum !== undefined ||
      schema.items !== undefined || schema.minItems !== undefined ||
      schema.maxItems !== undefined
    ) return z.never();
    const props = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const propKeys = Object.keys(props);
    if (propKeys.length > SCHEMA_BOUNDS.maxProperties) return z.never();
    const required = Array.isArray(schema.required)
      ? new Set(schema.required)
      : new Set();
    // A `required` key not declared in `properties` is malformed — fail closed.
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) return z.never();
    }
    const shape = {};
    for (const [key, sub] of Object.entries(props)) {
      const subZod = schemaToZod(z, sub, depth + 1);
      shape[key] = required.has(key) ? subZod : subZod.optional();
    }
    const obj = z.object(shape);
    // additionalProperties:false → z.strict() (reject unknown keys). Absent or
    // true → passthrough (accept extra keys, as JSON Schema defaults).
    return schema.additionalProperties === false
      ? obj.strict()
      : obj.passthrough();
  }
  // Unsupported / unknown → fail closed.
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

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
 * Convert a JSON-schema descriptor into a bounded zod schema — FAIL CLOSED.
 * An unsupported or malformed schema becomes z.never() (rejects everything),
 * never a permissive z.record(z.any()). Honours enum/const, min/max, length,
 * pattern, and additionalProperties:false (→ z.strict()).
 */
export function schemaToZod(z, schema, depth = 0) {
  if (depth > SCHEMA_BOUNDS.maxDepth) return z.never();
  if (!schema || typeof schema !== "object") return z.never();

  // const → literal, enum → union of literals
  if (schema.const !== undefined) return z.literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.length > SCHEMA_BOUNDS.maxUnionBranches) return z.never();
    return z.union(schema.enum.slice(0, SCHEMA_BOUNDS.maxUnionBranches).map((v) => z.literal(v)));
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = (schema.oneOf ?? schema.anyOf) ?? [];
    if (branches.length === 0 || branches.length > SCHEMA_BOUNDS.maxUnionBranches) return z.never();
    return z.union(branches.map((b) => schemaToZod(z, b, depth + 1)));
  }

  const t = schema.type;
  if (t === "string") {
    let s = z.string();
    if (typeof schema.minLength === "number" && schema.minLength >= 0) s = s.min(schema.minLength);
    // Global cap is ALWAYS applied (even when the page omits maxLength) so a
    // hostile descriptor cannot describe an unbounded string.
    const pageMax = typeof schema.maxLength === "number" && schema.maxLength >= 0 ? schema.maxLength : SCHEMA_BOUNDS.maxStringLength;
    s = s.max(Math.min(pageMax, SCHEMA_BOUNDS.maxStringLength));
    // Pattern/regex is NOT supported: arbitrary page-controlled regex is a
    // regex-DoS vector. A descriptor carrying `pattern` fails closed.
    if (schema.pattern !== undefined) return z.never();
    return s;
  }
  if (t === "number") {
    let s = z.number();
    if (typeof schema.minimum === "number") s = s.min(schema.minimum);
    if (typeof schema.maximum === "number") s = s.max(schema.maximum);
    return s;
  }
  if (t === "integer") {
    let s = z.number().int();
    if (typeof schema.minimum === "number") s = s.min(Math.ceil(schema.minimum));
    if (typeof schema.maximum === "number") s = s.max(Math.floor(schema.maximum));
    return s;
  }
  if (t === "boolean") return z.boolean();
  if (t === "array") {
    const inner = schemaToZod(z, schema.items, depth + 1);
    let arr = z.array(inner);
    if (typeof schema.minItems === "number" && schema.minItems >= 0) arr = arr.min(schema.minItems);
    const pageMax = typeof schema.maxItems === "number" && schema.maxItems >= 0 ? schema.maxItems : SCHEMA_BOUNDS.maxArrayItems;
    arr = arr.max(Math.min(pageMax, SCHEMA_BOUNDS.maxArrayItems)); // global cap ALWAYS applied
    return arr;
  }
  if (t === "object") {
    const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const propKeys = Object.keys(props);
    if (propKeys.length > SCHEMA_BOUNDS.maxProperties) return z.never();
    const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
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
    return schema.additionalProperties === false ? obj.strict() : obj.passthrough();
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
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/**
 * Classify a runtime message sender + derive/validate the tool-report origin.
 * Pure: takes a sender-shaped object, returns a decision. This is the sender
 * authorization boundary — a content script may only report tools for ITS OWN
 * page origin, never a message-supplied one.
 *
 * Returns: { kind: "content-script"|"extension"|"unmatched", origin?, error? }
 */
export function authorizeToolReport(sender, messageOrigin, canonicalOrigin, extensionId) {
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
      return { kind: "unmatched", error: "tool reports must come from the page's top frame" };
    }
    return { kind: "extension" };
  }
  const senderOrigin = canonicalOrigin(senderTabUrl);
  if (!senderOrigin) return { kind: "content-script", error: "invalid sender origin" };
  if (messageOrigin && canonicalOrigin(messageOrigin) !== senderOrigin) {
    return { kind: "content-script", error: "origin mismatch — tool report rejected" };
  }
  return { kind: "content-script", origin: senderOrigin };
}

/** The exact message types a page's content script is allowed to route. */
export const PAGE_ALLOWED_ROUTES = new Set(["tools.list", "tools.upsert", "tools.approve", "tools.pending"]);

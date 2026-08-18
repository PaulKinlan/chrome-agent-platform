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

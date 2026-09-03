// dptw: no token/output byte limits. MAX_JSON_DEPTH stays — it bounds parse
// recursion (a stack-safety grammar bound, not a size cap).
const MAX_JSON_DEPTH = 32;

const NO_VERIFICATION_WARNING =
  "WARNING: JWT signature was not verified; header and payload claims are untrusted.";
const NONE_WARNING = "WARNING: alg \"none\" denotes an unsigned token.";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const LIMITS = Object.freeze({
  maxTokenBytes: Number.POSITIVE_INFINITY,
  maxJsonDepth: MAX_JSON_DEPTH,
  maxOutputBytes: Number.POSITIVE_INFINITY,
});

export class JwtDecodeError extends Error {
  constructor(exitCode, code, diagnostic) {
    super(diagnostic);
    this.name = "JwtDecodeError";
    this.exitCode = exitCode;
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function dataError(code, diagnostic) {
  throw new JwtDecodeError(1, code, diagnostic);
}

function usageError(code, diagnostic) {
  throw new JwtDecodeError(2, code, diagnostic);
}

function hasOnlyKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

class JsonPreparser {
  constructor(source, context, maxDepth) {
    this.source = source;
    this.context = context;
    this.maxDepth = maxDepth;
    this.index = 0;
  }

  fail(code, detail) {
    dataError(code, `jwt: ${detail} in ${this.context}`);
  }

  skipWhitespace() {
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        this.index += 1;
      } else {
        break;
      }
    }
  }

  parse() {
    this.skipWhitespace();
    this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) this.fail("JSON_SYNTAX", "invalid JSON");
  }

  ensureDepth(depth) {
    if (depth > this.maxDepth) {
      this.fail("JSON_DEPTH", `JSON exceeds depth ${this.maxDepth}`);
    }
  }

  parseValue(depth) {
    if (this.index >= this.source.length) this.fail("JSON_SYNTAX", "invalid JSON");
    const character = this.source[this.index];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') {
      this.parseString();
      return;
    }
    if (character === "t") return this.parseLiteral("true");
    if (character === "f") return this.parseLiteral("false");
    if (character === "n") return this.parseLiteral("null");
    if (character === "-" || (character >= "0" && character <= "9")) {
      this.parseNumber();
      return;
    }
    this.fail("JSON_SYNTAX", "invalid JSON");
  }

  parseObject(depth) {
    this.ensureDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return;
    }
    while (true) {
      if (this.source[this.index] !== '"') this.fail("JSON_SYNTAX", "invalid JSON");
      const key = this.parseString();
      if (keys.has(key)) this.fail("DUPLICATE_JSON_KEY", "duplicate JSON key");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") this.fail("JSON_SYNTAX", "invalid JSON");
      this.index += 1;
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return;
      }
      if (delimiter !== ",") this.fail("JSON_SYNTAX", "invalid JSON");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseArray(depth) {
    this.ensureDepth(depth);
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return;
    }
    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return;
      }
      if (delimiter !== ",") this.fail("JSON_SYNTAX", "invalid JSON");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const raw = this.source.slice(start, this.index);
        let value;
        try {
          value = JSON.parse(raw);
        } catch {
          this.fail("JSON_SYNTAX", "invalid JSON");
        }
        if (!isUnicodeScalarString(value)) {
          const reason = value.includes("\0") ? "NUL is forbidden" : "invalid Unicode scalar value";
          this.fail(reason.startsWith("NUL") ? "JSON_NUL" : "JSON_UNICODE", reason);
        }
        return value;
      }
      if (code < 0x20) this.fail("JSON_SYNTAX", "invalid JSON");
      if (code === 0x5c) {
        this.index += 1;
        if (this.index >= this.source.length) this.fail("JSON_SYNTAX", "invalid JSON");
        const escaped = this.source[this.index];
        if ('"\\/bfnrt'.includes(escaped)) {
          this.index += 1;
          continue;
        }
        if (escaped !== "u") this.fail("JSON_SYNTAX", "invalid JSON");
        const hex = this.source.slice(this.index + 1, this.index + 5);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail("JSON_SYNTAX", "invalid JSON");
        this.index += 5;
        continue;
      }
      this.index += 1;
    }
    this.fail("JSON_SYNTAX", "invalid JSON");
  }

  parseLiteral(literal) {
    if (!this.source.startsWith(literal, this.index)) this.fail("JSON_SYNTAX", "invalid JSON");
    this.index += literal.length;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.source.slice(this.index),
    );
    if (!match) this.fail("JSON_SYNTAX", "invalid JSON");
    const numeric = Number(match[0]);
    if (!Number.isFinite(numeric)) this.fail("JSON_NUMBER", "non-finite JSON number");
    this.index += match[0].length;
  }
}

export function parseStrictJson(source, context, maxDepth = MAX_JSON_DEPTH) {
  if (typeof source !== "string") usageError("INPUT_SCHEMA", "jwt: JSON input must be text");
  new JsonPreparser(source, context, maxDepth).parse();
  try {
    return JSON.parse(source);
  } catch {
    dataError("JSON_SYNTAX", `jwt: invalid JSON in ${context}`);
  }
}

function decodeBase64Url(component, componentName) {
  if (component.includes("=")) {
    dataError("BASE64URL_PADDING", "jwt: unpadded base64url encoding required");
  }
  if (!/^[A-Za-z0-9_-]*$/.test(component)) {
    dataError("BASE64URL_CHARACTER", "jwt: invalid base64url character");
  }
  if (component.length % 4 === 1) {
    dataError("BASE64URL_LENGTH", `jwt: invalid base64url length in ${componentName}`);
  }

  const output = new Uint8Array(Math.floor((component.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (const character of component) {
    const code = character.charCodeAt(0);
    let value;
    if (code >= 65 && code <= 90) value = code - 65;
    else if (code >= 97 && code <= 122) value = code - 71;
    else if (code >= 48 && code <= 57) value = code + 4;
    else if (character === "-") value = 62;
    else value = 63;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex] = (accumulator >> bits) & 0xff;
      outputIndex += 1;
      accumulator &= bits === 0 ? 0 : (1 << bits) - 1;
    }
  }
  if (accumulator !== 0) {
    dataError("BASE64URL_NON_CANONICAL", `jwt: non-canonical base64url in ${componentName}`);
  }
  return output;
}

function decodeJsonComponent(component, componentName) {
  if (component.length === 0) dataError("EMPTY_COMPONENT", `jwt: empty ${componentName} component`);
  const bytes = decodeBase64Url(component, componentName);
  if (bytes.includes(0)) dataError("JSON_NUL", `jwt: NUL is forbidden in ${componentName}`);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    dataError("JSON_BOM", `jwt: UTF-8 BOM is forbidden in ${componentName}`);
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    dataError("UTF8", `jwt: invalid UTF-8 in ${componentName}`);
  }
  const parsed = parseStrictJson(text, componentName);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    dataError("JSON_OBJECT", `jwt: ${componentName} must be a JSON object`);
  }
  return parsed;
}

function normalizedIdentifier(key) {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSensitiveKey(key, ancestors) {
  const normalized = normalizedIdentifier(key);
  const parts = new Set(normalized.split("_").filter(Boolean));
  if (
    ["token", "secret", "password", "passwd", "cookie", "credential", "authorization", "bearer", "signature"].includes(
      normalized,
    )
  ) {
    return true;
  }
  if ([...parts].some((part) => ["password", "passwd", "cookie", "credential", "authorization"].includes(part))) {
    return true;
  }
  if (parts.has("token") || parts.has("secret")) return true;
  if (parts.has("private") && parts.has("key")) return true;
  if (parts.has("api") && parts.has("key")) return true;
  const insideJwk = ancestors.some((ancestor) => normalizedIdentifier(ancestor) === "jwk");
  return insideJwk && ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].includes(normalized);
}

function redactValue(value, ancestors = []) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, ancestors));
  if (value !== null && typeof value === "object") {
    const result = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSensitiveKey(key, ancestors) ? "[REDACTED]" : redactValue(child, [...ancestors, key]);
    }
    return result;
  }
  return value;
}

export function validateCliInput(value) {
  if (!hasOnlyKeys(value, ["token"]) || typeof value.token !== "string") {
    usageError("INPUT_SCHEMA", "jwt: CLI input must exactly match {\"token\":string}");
  }
  return value.token;
}

export function validateWorkerRequest(value) {
  if (!hasOnlyKeys(value, ["schemaVersion", "id", "method", "params"])) {
    usageError("WORKER_SCHEMA", "jwt: invalid Worker request schema");
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 64 ||
    !/^[A-Za-z0-9._-]+$/.test(value.id) ||
    value.method !== "jwt_decode_bounded" ||
    !hasOnlyKeys(value.params, ["token"]) ||
    typeof value.params.token !== "string"
  ) {
    usageError("WORKER_SCHEMA", "jwt: invalid Worker request schema");
  }
  return value;
}

export function decodeJwtBounded(token) {
  if (typeof token !== "string") usageError("INPUT_SCHEMA", "jwt: token must be a string");
  const tokenBytes = encoder.encode(token).length;

  const components = token.split(".");
  if (components.length === 5) dataError("JWE_UNSUPPORTED", "jwt: JWE compact serialization is not supported");
  if (components.length !== 3) dataError("COMPONENT_COUNT", "jwt: token must have exactly 3 components");

  const [headerComponent, payloadComponent, signatureComponent] = components;
  const header = decodeJsonComponent(headerComponent, "header");
  const payload = decodeJsonComponent(payloadComponent, "payload");
  decodeBase64Url(signatureComponent, "signature");

  if (Object.hasOwn(header, "enc")) {
    dataError("JWE_UNSUPPORTED", "jwt: JWE protected headers are not supported");
  }

  const warnings = [NO_VERIFICATION_WARNING];
  if (header.alg === "none") {
    if (signatureComponent.length !== 0) {
      dataError("UNSECURED_SIGNATURE", "jwt: alg none requires an empty signature component");
    }
    warnings.push(NONE_WARNING);
  } else if (signatureComponent.length === 0) {
    dataError("EMPTY_SIGNATURE", "jwt: signed token requires a signature component");
  }

  const result = {
    header: redactValue(header),
    payload: redactValue(payload),
    verified: false,
    warnings,
  };
  // dptw: no output byte limit — the decoded claims return whole.
  return result;
}

// extension/lib/thread-export-redact.js — Pure secret redaction for single-thread exports.
// Part of chrome-agent-platform-3p3e.12.
//
// Guaranteed exact-value scrubbing for all configured profile credentials
// (API keys, bearer tokens, passwords, headers, session cookies, HMACs) across arbitrary text,
// plus URL query stripping, shape masking, and local path sanitization.

import { BARE_SECRET_SHAPES } from "./pure.js";

/** Escape a literal string for safe use in RegExp. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** NFKC normalize a string safely. */
function nfkc(s) {
  try {
    return String(s ?? "").normalize("NFKC");
  } catch {
    return String(s ?? "");
  }
}

/**
 * Common field names carrying sensitive credentials in provider, MCP, and service records.
 */
const CREDENTIAL_KEY_RE =
  /(api[_-]?key|token|secret|password|pwd|passphrase|authorization|auth|credential|bearer|access[_-]?key|vault|cookie|session|sig|signature|private|client[_-]?secret|refresh[_-]?token)/i;

/**
 * Collect all active credential strings from profile configurations.
 * Gathers exact secret values from provider configs, MCP servers, vault records,
 * and caller-supplied secrets. Only values of length >= 4 are collected.
 *
 * @param {object} [options]
 * @param {any} [options.providerConfig]
 * @param {any} [options.mcpServers]
 * @param {any} [options.vaultSecrets]
 * @param {string[]} [options.extraSecrets]
 * @returns {string[]} Deduplicated secret literals sorted longest first.
 */
export function collectProfileSecrets({ providerConfig, mcpServers, vaultSecrets, extraSecrets } = {}) {
  const gathered = new Set();

  function addSecret(str) {
    if (typeof str !== "string") return;
    const trimmed = str.trim();
    if (trimmed.length < 4) return;
    gathered.add(trimmed);

    // Extract Bearer token payload if string starts with "Bearer "
    if (/^Bearer\s+\S{4,}$/i.test(trimmed)) {
      gathered.add(trimmed.replace(/^Bearer\s+/i, "").trim());
    }

    // Extract cookie values if string is a Cookie header (e.g. "session_id=xyz; Path=/")
    if (trimmed.includes("=") && (trimmed.includes(";") || !trimmed.includes(" "))) {
      for (const part of trimmed.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0) {
          const val = part.slice(eq + 1).trim();
          if (val.length >= 4 && !/^(true|false|none|strict|lax|\/)$/i.test(val)) {
            gathered.add(val);
          }
        }
      }
    }
  }

  function scan(obj, parentKey = "") {
    if (!obj || typeof obj !== "object") return;
    for (const [key, val] of Object.entries(obj)) {
      const effectiveKey = Array.isArray(obj) ? parentKey : key;
      if (typeof val === "string") {
        if (
          CREDENTIAL_KEY_RE.test(effectiveKey) ||
          /^(sk-|ghp_|xox[baprs]-|AIza|eyJ|tok_|sec_|key-)/.test(val.trim()) ||
          /^Bearer\s+\S{4,}$/i.test(val.trim())
        ) {
          addSecret(val);
        }
      } else if (val && typeof val === "object") {
        scan(val, effectiveKey);
      }
    }
  }

  // 1. Provider configurations (API keys, custom endpoints)
  if (providerConfig) {
    scan(providerConfig);
  }

  // 2. MCP server configurations (auth headers, transport tokens)
  if (Array.isArray(mcpServers)) {
    for (const s of mcpServers) scan(s);
  } else if (mcpServers && typeof mcpServers === "object") {
    scan(mcpServers);
  }

  // 3. Vault secrets (stored credentials: every string in vault is treated as a secret)
  if (vaultSecrets) {
    function scanVault(obj) {
      if (!obj || typeof obj !== "object") return;
      for (const val of Object.values(obj)) {
        if (typeof val === "string") {
          addSecret(val);
        } else if (val && typeof val === "object") {
          scanVault(val);
        }
      }
    }
    scanVault(vaultSecrets);
  }

  // 4. Extra explicitly supplied secrets / HMACs
  if (Array.isArray(extraSecrets)) {
    for (const s of extraSecrets) {
      if (typeof s === "string") addSecret(s);
    }
  }

  // Return unique strings sorted longest first to avoid prefix collisions
  return Array.from(gathered).sort((a, b) => b.length - a.length);
}

/**
 * Perform exact-value redaction of known literals across text.
 * Replaces exact matches of the literal, its NFKC-normalized form, its URL-encoded
 * form, and its JSON-string-escaped form. Matching is case-insensitive.
 * Note: preserves original user prose/ligatures without globally normalizing text.
 *
 * @param {string} text
 * @param {string[]} knownLiterals
 * @param {string} [replacement="[REDACTED]"]
 * @returns {string}
 */
export function exactValueRedact(text, knownLiterals = [], replacement = "[REDACTED]") {
  if (!text || typeof text !== "string") return String(text ?? "");
  if (!Array.isArray(knownLiterals) || knownLiterals.length === 0) return text;

  let out = text;
  for (const rawLit of knownLiterals) {
    if (typeof rawLit !== "string") continue;
    const lit = String(rawLit).trim();
    if (lit.length < 4) continue; // Minimum length gate to avoid false positives

    // 1. Plain exact literal
    out = out.replace(new RegExp(escapeRegex(lit), "gi"), replacement);

    // 2. NFKC-normalized variant of the literal
    const normLit = nfkc(lit);
    if (normLit !== lit) {
      out = out.replace(new RegExp(escapeRegex(normLit), "gi"), replacement);
    }

    // 3. URL-encoded variant (e.g. key%3Dvalue or encoded tokens)
    try {
      const urlEnc = encodeURIComponent(lit);
      if (urlEnc !== lit && urlEnc !== normLit) {
        out = out.replace(new RegExp(escapeRegex(urlEnc), "gi"), replacement);
      }
    } catch { /* ignore */ }

    // 4. JSON string escaped variant (e.g. \" or \/ or unicode escapes)
    try {
      const jsonEsc = JSON.stringify(lit).slice(1, -1);
      if (jsonEsc !== lit && jsonEsc !== normLit) {
        out = out.replace(new RegExp(escapeRegex(jsonEsc), "gi"), replacement);
      }
    } catch { /* ignore */ }
  }

  return out;
}

/**
 * Strip query strings from all HTTP and HTTPS URLs embedded anywhere in text.
 * URLs containing sensitive params like ?token=, ?key=, or unknown auth params
 * are truncated to path…[query redacted].
 *
 * @param {string} text
 * @returns {string}
 */
export function stripUrlQueries(text) {
  if (!text || typeof text !== "string") return String(text ?? "");
  return text.replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => {
    const cut = url.search(/[?#]/);
    return cut >= 0 ? url.slice(0, cut) + "…[query redacted]" : url;
  });
}

/**
 * Mask HTTP userinfo credentials (user:password@host or user@host),
 * including passwords < 4 chars and long-scheme variants (>64 chars).
 *
 * @param {string} text
 * @returns {string}
 */
export function maskUrlUserinfo(text) {
  if (!text || typeof text !== "string") return String(text ?? "");
  // 1. Standard bounded scheme userinfo (with or without colon)
  let out = text.replace(/([a-z][a-z0-9+.-]{0,63}:\/\/)([^/@\s]+)@/gi, "$1[REDACTED]@");

  // 2. Covering pass for long schemes (>64 chars) matching pure.js _maskLongSchemeUserinfo
  const SCHEME_CHAR = /[a-z0-9+.-]/i;
  let res = "";
  let i = 0;
  while (true) {
    const j = out.indexOf("://", i);
    if (j < 0) return res + out.slice(i);
    let k = j;
    while (k > 0 && SCHEME_CHAR.test(out[k - 1])) k--;
    const run = out.slice(k, j);
    if (run.length > 64 && !/[a-z]/i.test(run.slice(-64)) && /[a-z]/i.test(run)) {
      let u = j + 3;
      while (u < out.length && out[u] !== "/" && !/\s/.test(out[u]) && out[u] !== "@") u++;
      if (u < out.length && out[u] === "@") {
        res += out.slice(i, j + 3) + "[REDACTED]@";
        i = u + 1;
        continue;
      }
    }
    res += out.slice(i, j + 3);
    i = j + 3;
  }
}

/**
 * Mask bare credential shapes (sk-*, ghp_*, xox*, AIza*, JWT, AWS access key).
 *
 * @param {string} text
 * @returns {string}
 */
export function maskBareSecretShapes(text) {
  if (!text || typeof text !== "string") return String(text ?? "");
  let out = text;
  for (const re of BARE_SECRET_SHAPES) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/**
 * Sanitize absolute user and personal directory paths
 * to avoid leaking operator filesystem trees.
 *
 * @param {string} text
 * @returns {string}
 */
const HOME_PATH_RE = new RegExp(
  "(?:\\/" + "home\\/[a-zA-Z0-9._-]+|\\/Users\\/[a-zA-Z0-9._-]+|[A-Z]:\\\\[Uu]sers\\\\[a-zA-Z0-9._-]+)(?:\\/[a-zA-Z0-9._-]+|\\\\[a-zA-Z0-9._-]+)*",
  "g",
);

export function sanitizeFilePaths(text) {
  if (!text || typeof text !== "string") return String(text ?? "");
  return text
    .replace(HOME_PATH_RE, "[LOCAL_PATH]")
    .replace(/file:\/\/\/[^\s"'<>)]+/gi, "file:///[LOCAL_PATH]");
}

/**
 * Redact an export string combining exact profile credentials, URL sanitization,
 * bare pattern masking, and local path redaction.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string[]} [options.knownSecrets]
 * @param {boolean} [options.scrubUrls=true]
 * @param {boolean} [options.scrubShapes=true]
 * @param {boolean} [options.scrubPaths=true]
 * @returns {string}
 */
export function redactExportText(text, { knownSecrets = [], scrubUrls = true, scrubShapes = true, scrubPaths = true } = {}) {
  if (text == null) return "";
  let s = String(text);

  // If text is a serialized JSON object/array, parse it and run redactExportValue
  // so keys like approvalHmac and nonce are dropped prior to string rendering
  const trimmed = s.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        const cleaned = redactExportValue(parsed, { knownSecrets, scrubUrls, scrubShapes, scrubPaths });
        return JSON.stringify(cleaned, null, 2);
      }
    } catch { /* proceed as plain text */ }
  }

  // 1. Exact-value redaction for all known profile secrets
  if (Array.isArray(knownSecrets) && knownSecrets.length > 0) {
    s = exactValueRedact(s, knownSecrets);
  }

  // 2. URL userinfo and query string stripping
  if (scrubUrls) {
    s = maskUrlUserinfo(s);
    s = stripUrlQueries(s);
  }

  // 3. Bare credential patterns
  if (scrubShapes) {
    s = maskBareSecretShapes(s);
  }

  // 4. Local path stripping (home/user trees only)
  if (scrubPaths) {
    s = sanitizeFilePaths(s);
  }

  return s;
}

/**
 * Deeply redact any structured JSON/object value intended for export.
 * Drops internal security fields (approvalHmac, nonce, sessionToken) and
 * redacts all strings.
 *
 * @param {any} value
 * @param {object} options
 * @param {number} [depth=0]
 * @param {WeakSet<object>} [seen=new WeakSet()]
 * @returns {any}
 */
export function redactExportValue(value, options = {}, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return redactExportText(value, options);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth > 8) return "[depth-exceeded]";

  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((v) => redactExportValue(v, options, depth + 1, seen));
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        // Discard approval HMACs and security token internal fields directly
        if (/^(approvalHmac|hmac|nonce|sessionToken|internalSecret|sig|signature)$/i.test(k)) {
          continue;
        }
        out[k] = redactExportValue(v, options, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

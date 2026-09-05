// lib/match-patterns.js — Chrome-style match patterns for origin-bound skills
// (CAP-FB-20260830-SITE-PLAYBOOKS-01). A skill record may declare
// `origins: ["https://github.com/*", ...]` (bounded to 8) — the run's active
// tab URL is matched against the patterns and non-matching origin-bound
// skills never compose into the system prompt.
//
// PURE module: no chrome.*, no storage, no imports. Match-pattern semantics
// follow chrome.declarativeContent / extension match patterns, restricted to
// what a skill binding needs: <scheme>://<host><path> with http/https/* schemes,
// `*` or `*.`-prefixed hosts, and a path with `*` wildcards.

export const MAX_SKILL_ORIGINS = 8;

const SCHEME_RE = /^(https?|\*)$/;

/** Parse a match pattern into { scheme, host, path } or return null when the
 * pattern is not a valid (supported) match pattern. Never throws. */
export function parseMatchPattern(pattern) {
  if (typeof pattern !== "string") return null;
  const m = /^([^:]+):\/\/([^/]*)(\/.*)$/.exec(pattern.trim());
  if (!m) return null;
  const [, scheme, host, path] = m;
  if (!SCHEME_RE.test(scheme)) return null;
  if (!host) return null;
  // An optional :port suffix is allowed (local fixture origins ride ports).
  let port = "";
  let bareHost = host;
  const pm = /^(.*):(\d+)$/.exec(host);
  if (pm) {
    bareHost = pm[1];
    port = pm[2];
  } else if (host.includes(":")) return null;
  // Host is "*", "*.host" (host + subdomains), or a literal host. No other
  // wildcard placement is valid in the host part.
  if (bareHost !== "*" && !bareHost.startsWith("*.")) {
    if (bareHost.includes("*")) return null;
  }
  return { scheme, host: bareHost, port, path: path || "/*" };
}

/** True when `pattern` is a valid, supported match pattern. */
export function isValidMatchPattern(pattern) {
  return parseMatchPattern(pattern) !== null;
}

function hostMatches(patternHost, urlHost) {
  if (patternHost === "*") return true;
  if (patternHost.startsWith("*.")) {
    const base = patternHost.slice(2);
    return urlHost === base || urlHost.endsWith(`.${base}`);
  }
  return urlHost === patternHost;
}

function pathMatches(patternPath, urlPath) {
  // `*` matches any run of characters (incl. empty); every other character is
  // literal. Anchored to the whole path.
  const re = new RegExp(
    "^" +
      patternPath
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  return re.test(urlPath);
}

/** True when `url` matches the match pattern. Never throws — a malformed URL
 * or pattern is simply not a match. */
export function matchPattern(pattern, url) {
  const p = parseMatchPattern(pattern);
  if (!p) return false;
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return false;
  }
  const scheme = u.protocol.replace(":", "");
  if (p.scheme !== "*" && p.scheme !== scheme) return false;
  if (p.scheme === "*" && scheme !== "http" && scheme !== "https") return false;
  if (!hostMatches(p.host.toLowerCase(), u.hostname.toLowerCase())) return false;
  if (p.port && p.port !== u.port) return false;
  return pathMatches(p.path, u.pathname + u.search);
}

/** Validate a skill record's `origins` declaration: an array of at most
 * MAX_SKILL_ORIGINS valid match patterns, or absent. Returns
 * { ok: true, origins } or { ok: false, error }. Never throws. */
export function validateSkillOrigins(origins) {
  if (origins == null) return { ok: true, origins: [] };
  if (!Array.isArray(origins)) {
    return { ok: false, error: "origins must be an array of match patterns" };
  }
  if (origins.length > MAX_SKILL_ORIGINS) {
    return { ok: false, error: `origins is bounded to ${MAX_SKILL_ORIGINS} match patterns` };
  }
  for (const o of origins) {
    if (!isValidMatchPattern(o)) {
      return { ok: false, error: `invalid match pattern: ${JSON.stringify(o)}` };
    }
  }
  return { ok: true, origins: origins.slice() };
}

/** True when a skill record matches `url`: a record with NO origins is global
 * (matches everywhere); a record WITH origins matches only when at least one
 * pattern matches. Pure. */
export function skillMatchesUrl(skill, url) {
  const v = validateSkillOrigins(skill?.origins);
  // An invalid declaration fails CLOSED: the skill never composes, rather
  // than silently becoming global.
  if (!v.ok) return false;
  if (v.origins.length === 0) return true; // no origins: a global skill
  return v.origins.some((p) => matchPattern(p, url));
}

// lib/pure-redact.js — the credential-redaction seam (secret shapes, URL/userinfo masking,
// durable-log normalisers, tool-argument redaction). Extracted from lib/pure.js by
// chrome-agent-platform-ux4ud; pure.js re-exports all of it.

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

/** Covering pass for the bounded userinfo regex (vj4s review P0): the {0,63}
 * scheme bound kills the quadratic, but its match window can only START on a
 * letter — a scheme run longer than 64 chars with NO letter in its trailing
 * 64 (e.g. "a"+"0"×64+"://user:pw@host") has no in-window start and leaked
 * under the naive bound, while the unbounded pre-vj4s regex masked it (any
 * letter anywhere in the run is a match start). This restores exact parity
 * for long runs with a LINEAR scan: anchor on "://", walk back over the
 * scheme-char run (a run can never cross an earlier ':', so runs never
 * overlap and total work is O(n)), then apply the same user:password@ tail
 * shape as the regex. Fires only where the bounded pass cannot; every other
 * case is byte-identical to it. KEEP IN SYNC with the main-world.js port. */
function _maskLongSchemeUserinfo(text) {
  const s = String(text ?? "");
  const SCHEME_CHAR = /[a-z0-9+.-]/i;
  let out = "";
  let i = 0;
  for (;;) {
    const j = s.indexOf("://", i);
    if (j < 0) return out + s.slice(i);
    let k = j;
    while (k > 0 && SCHEME_CHAR.test(s[k - 1])) k--;
    const run = s.slice(k, j);
    // Only the bounded pass's blind spot: run longer than the window, no
    // letter inside the window, but a letter somewhere earlier in the run
    // (the old regex's match start). Letter-less runs stay untouched (no
    // over-redaction — the old regex never masked them either).
    if (run.length > 64 && !/[a-z]/i.test(run.slice(-64)) && /[a-z]/i.test(run)) {
      // Tail shape identical to the regex: [^:/\s]+ ":" [^@\s]{4,} "@".
      let u = j + 3;
      while (u < s.length && s[u] !== ":" && s[u] !== "/" && !/\s/.test(s[u])) u++;
      if (u > j + 3 && s[u] === ":") {
        let p = u + 1;
        while (p < s.length && s[p] !== "@" && !/\s/.test(s[p])) p++;
        if (p - (u + 1) >= 4 && s[p] === "@") {
          out += s.slice(i, u + 1) + "[REDACTED]@";
          i = p + 1;
          continue;
        }
      }
    }
    out += s.slice(i, j + 3);
    i = j + 3;
  }
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
  // KEEP IN SYNC: content/main-world.js redactBridgeText is a faithful port of
  // this function's passes (plain injected scripts cannot import this module)
  // — a change here must land there too.
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
  // The scheme run is BOUNDED ({0,63}): an unbounded * is quadratic on long
  // alphanumeric tokens (the engine eats the run, fails on ://, backtracks
  // one char, retries — 37 s on a 300 KiB token, vj4s). The bound is safe
  // whenever a LETTER falls within the last 64 scheme chars (the match window
  // slides to it); the covering scan below handles the rest.
  out = out.replace(/([a-z][a-z0-9+.-]{0,63}:\/\/[^:\/\s]+:)([^@\s]{4,})@/gi, "$1[REDACTED]@");
  out = _maskLongSchemeUserinfo(out);
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

export const BARE_SECRET_SHAPES = [
  /(?<![a-zA-Z0-9])(?:sk|rk|pk|key|tok)[-_][A-Za-z0-9_-]{8,}/g,
  /(?<![a-zA-Z0-9])AKIA[0-9A-Z]{16}\b/g,
  /(?<![a-zA-Z0-9])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /(?<![a-zA-Z0-9])xox[baprs]-[A-Za-z0-9-]{8,}/g,
  /(?<![a-zA-Z0-9])AIza[0-9A-Za-z_-]{20,}/g,
  /(?<![a-zA-Z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
];

/** Convert an arbitrary value to string safely without throwing, even for Object.create(null),
 * symbols, throwing valueOf/toString, or non-primitive objects. */
export function safeString(value, fallback = "") {
  if (value == null) return fallback;
  try {
    if (typeof value === "string") return value;
    if (typeof value === "symbol") return fallback;
    return String(value);
  } catch {
    try {
      if (typeof value?.toString === "function") {
        return String(value.toString());
      }
    } catch { /* ignore */ }
    return fallback;
  }
}

/** Bound and redact an arbitrary string or string array/object for durable log storage.
 * Every string passes through redactSecretText + bare credential scrub and is sliced to maxChars.
 * Protected against circular references, throwing getters, throwing coercions, and unbounded depth/keys. */
export function boundedAndRedacted(value, maxChars = 240, seen = new WeakSet(), depth = 0) {
  try {
    if (value == null) return "";
    if (depth > 4) return "[depth-exceeded]";
    if (typeof value === "string") {
      let out = "";
      try { out = redactSecretText(value); } catch { out = value; }
      for (const re of BARE_SECRET_SHAPES) {
        try { out = out.replace(re, "[REDACTED]"); } catch { /* ignore */ }
      }
      return out.slice(0, maxChars);
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (typeof value === "object") {
      try {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      } catch { /* e.g. non-extensible or foreign proxy */ }

      if (Array.isArray(value)) {
        const out = [];
        let len = 0;
        try { len = Math.min(value.length, 32); } catch { len = 0; }
        for (let i = 0; i < len; i++) {
          try {
            out.push(boundedAndRedacted(value[i], maxChars, seen, depth + 1));
          } catch {
            out.push("[unserializable]");
          }
        }
        return out;
      }

      const out = {};
      let keys = [];
      try {
        keys = Object.keys(value).slice(0, 32);
      } catch {
        try {
          keys = Object.getOwnPropertyNames(value).slice(0, 32);
        } catch {
          keys = [];
        }
      }

      for (const k of keys) {
        let cleanKey = "";
        try {
          cleanKey = boundedAndRedacted(safeString(k, "key"), 64, seen, depth + 1);
        } catch {
          cleanKey = "key";
        }
        let propVal;
        try {
          propVal = value[k];
        } catch {
          propVal = "[unserializable]";
        }
        try {
          out[cleanKey] = propVal === "[unserializable]"
            ? "[unserializable]"
            : boundedAndRedacted(propVal, maxChars, seen, depth + 1);
        } catch {
          out[cleanKey] = "[unserializable]";
        }
      }
      return out;
    }
    const str = safeString(value, "[unserializable]");
    if (str === "[unserializable]") return "[unserializable]";
    return boundedAndRedacted(str, maxChars, seen, depth + 1);
  } catch {
    return "[unserializable]";
  }
}

/** Canonical durable log normalizer for tool-call entries: constructs a strictly
 * allowlisted object with only known keys, bounding and redacting every string.
 * Completely guarded against throwing getters and coercion failures. */
export function normalizeDurableToolCall(log) {
  try {
    if (!log || typeof log !== "object") {
      return {
        type: "tool-call",
        id: "",
        executionId: "",
        callId: "",
        tool: "tool",
        args: "",
        at: Date.now(),
      };
    }
    let rawId, rawExecId, rawCallId, rawTool, rawArgs, rawRun, rawAt;
    try { rawId = log.id; } catch { rawId = "[unserializable]"; }
    try { rawExecId = log.executionId; } catch { rawExecId = "[unserializable]"; }
    try { rawCallId = log.callId; } catch { rawCallId = "[unserializable]"; }
    try { rawTool = log.tool; } catch { rawTool = "[unserializable]"; }
    try { rawArgs = log.args; } catch { rawArgs = "[unserializable]"; }
    try { rawRun = log.run; } catch { rawRun = null; }
    try { rawAt = log.at; } catch { rawAt = null; }

    const out = {
      type: "tool-call",
      id: boundedAndRedacted(safeString(rawId, ""), 64),
      executionId: boundedAndRedacted(safeString(rawExecId, ""), 128),
      callId: boundedAndRedacted(safeString(rawCallId, ""), 128),
      tool: boundedAndRedacted(safeString(rawTool, "tool"), 128),
      args: boundedAndRedacted(safeString(rawArgs, ""), 65536),
    };
    if (rawRun != null) {
      try { out.run = Number(rawRun) || 0; } catch { out.run = 0; }
    }
    try {
      out.at = Number.isFinite(Number(rawAt)) ? Number(rawAt) : Date.now();
    } catch {
      out.at = Date.now();
    }
    return out;
  } catch {
    return {
      type: "tool-call",
      id: "[unserializable]",
      executionId: "[unserializable]",
      callId: "[unserializable]",
      tool: "tool",
      args: "[unserializable]",
      at: Date.now(),
    };
  }
}

/** Canonical durable log normalizer for tool-result entries: enforces structural bounds,
 * strict allowlisting (no object spreading), and credential redaction at the persistence chokepoint.
 * Completely guarded against throwing getters and coercion failures. */
export function normalizeDurableToolResult(log) {
  try {
    if (!log || typeof log !== "object") {
      return {
        type: "tool-result",
        id: "",
        executionId: "",
        callId: "",
        tool: "tool",
        result: "",
        ok: null,
        at: Date.now(),
      };
    }
    let rawId, rawExecId, rawCallId, rawTool, rawResult, rawOk, rawRun, rawSelTool, rawSiteAct, rawPr, rawPermDec, rawReexec, rawResFull, rawResTrunc, rawResBytes, rawAt;
    try { rawId = log.id; } catch { rawId = "[unserializable]"; }
    try { rawExecId = log.executionId; } catch { rawExecId = "[unserializable]"; }
    try { rawCallId = log.callId; } catch { rawCallId = "[unserializable]"; }
    try { rawTool = log.tool; } catch { rawTool = "[unserializable]"; }
    try { rawResult = log.result; } catch { rawResult = "[unserializable]"; }
    try { rawOk = log.ok; } catch { rawOk = null; }
    try { rawRun = log.run; } catch { rawRun = null; }
    try { rawSelTool = log.selectedTool; } catch { rawSelTool = null; }
    try { rawSiteAct = log.siteActivity; } catch { rawSiteAct = null; }
    try { rawPr = log.permissionRequirement; } catch { rawPr = null; }
    try { rawPermDec = log.permissionDecision; } catch { rawPermDec = null; }
    try { rawReexec = log.reexecuted; } catch { rawReexec = false; }
    try { rawResFull = log.resultFull; } catch { rawResFull = null; }
    try { rawResTrunc = log.resultFullTruncated; } catch { rawResTrunc = false; }
    try { rawResBytes = log.resultFullBytes; } catch { rawResBytes = 0; }
    try { rawAt = log.at; } catch { rawAt = null; }

    const out = {
      type: "tool-result",
      id: boundedAndRedacted(safeString(rawId, ""), 64),
      executionId: boundedAndRedacted(safeString(rawExecId, ""), 128),
      callId: boundedAndRedacted(safeString(rawCallId, ""), 128),
      tool: boundedAndRedacted(safeString(rawTool, "tool"), 128),
      result: boundedAndRedacted(safeString(rawResult, ""), 65536),
      ok: typeof rawOk === "boolean" ? rawOk : (rawOk == null ? null : Boolean(rawOk)),
    };
    if (rawRun != null) {
      try { out.run = Number(rawRun) || 0; } catch { out.run = 0; }
    }
    if (rawSelTool != null) {
      out.selectedTool = boundedAndRedacted(safeString(rawSelTool, "tool"), 128);
    }
    if (rawSiteAct && typeof rawSiteAct === "object" && !Array.isArray(rawSiteAct)) {
      let actOrigin, actTool;
      try { actOrigin = rawSiteAct.origin; } catch { actOrigin = "[unserializable]"; }
      try { actTool = rawSiteAct.tool; } catch { actTool = "[unserializable]"; }
      out.siteActivity = {
        origin: boundedAndRedacted(safeString(actOrigin, ""), 240),
        tool: boundedAndRedacted(safeString(actTool, ""), 128),
      };
    }
    if (rawPr && typeof rawPr === "object" && !Array.isArray(rawPr)) {
      let prReason, prPerms, prGrantOrigins, prGrantGlobal, prHostOrigins, prApprovals;
      try { prReason = rawPr.reason; } catch { prReason = "[unserializable]"; }
      try { prPerms = rawPr.permissions; } catch { prPerms = []; }
      try { prGrantOrigins = rawPr.grantOrigins; } catch { prGrantOrigins = []; }
      try { prGrantGlobal = rawPr.grantGlobal; } catch { prGrantGlobal = false; }
      try { prHostOrigins = rawPr.hostOrigins; } catch { prHostOrigins = []; }
      try { prApprovals = rawPr.approvals; } catch { prApprovals = []; }

      let permissions = [];
      try {
        if (Array.isArray(prPerms)) {
          permissions = prPerms.slice(0, 8).map((p) => {
            try { return boundedAndRedacted(safeString(p, ""), 64); } catch { return "[unserializable]"; }
          });
        }
      } catch {
        permissions = [];
      }

      let grantOrigins = [];
      try {
        if (Array.isArray(prGrantOrigins)) {
          grantOrigins = prGrantOrigins.slice(0, 50).map((o) => {
            try { return boundedAndRedacted(safeString(o, ""), 240); } catch { return "[unserializable]"; }
          });
        }
      } catch {
        grantOrigins = [];
      }

      const req = {
        reason: boundedAndRedacted(safeString(prReason, ""), 240),
        permissions,
        grantOrigins,
        grantGlobal: prGrantGlobal === true,
      };
      try {
        if (Array.isArray(prHostOrigins) && prHostOrigins.length) {
          req.hostOrigins = prHostOrigins.slice(0, 50).map((h) => {
            try { return boundedAndRedacted(safeString(h, ""), 240); } catch { return "[unserializable]"; }
          });
        }
      } catch {
        // Omit hostOrigins on processing failure
      }
      try {
        if (Array.isArray(prApprovals) && prApprovals.length) {
          req.approvals = prApprovals.slice(0, 10).map((a) => {
            if (!a || typeof a !== "object" || Array.isArray(a)) return null;
            let aId, aAct, aTgt, aDetail;
            try { aId = a.approvalId; } catch { aId = "[unserializable]"; }
            try { aAct = a.action; } catch { aAct = "[unserializable]"; }
            try { aTgt = a.targetRef; } catch { aTgt = "[unserializable]"; }
            try { aDetail = a.detail; } catch { aDetail = null; }

            const app = {
              approvalId: boundedAndRedacted(safeString(aId, ""), 64),
              action: boundedAndRedacted(safeString(aAct, ""), 64),
              targetRef: boundedAndRedacted(safeString(aTgt, ""), 240),
            };
            if (aDetail && typeof aDetail === "object" && !Array.isArray(aDetail)) {
              let dKind, dOrig, dTool, dScope;
              try { dKind = aDetail.kind; } catch { dKind = "[unserializable]"; }
              try { dOrig = aDetail.origin; } catch { dOrig = "[unserializable]"; }
              try { dTool = aDetail.tool; } catch { dTool = "[unserializable]"; }
              try { dScope = aDetail.scope; } catch { dScope = null; }

              app.detail = {
                kind: boundedAndRedacted(safeString(dKind, "webmcp-tool"), 32),
                origin: boundedAndRedacted(safeString(dOrig, ""), 240),
                tool: boundedAndRedacted(safeString(dTool, ""), 1024),
              };
              if (dScope != null) {
                app.detail.scope = boundedAndRedacted(safeString(dScope, ""), 32);
              }
            }
            return app;
          }).filter(Boolean);
        }
      } catch {
        // Omit approvals on processing failure
      }
      out.permissionRequirement = req;
    }
    if (rawPermDec != null) {
      out.permissionDecision = boundedAndRedacted(safeString(rawPermDec, ""), 16);
    }
    if (rawReexec === true) {
      out.reexecuted = true;
    }
    if (rawResFull != null && typeof rawResFull === "string" && rawResFull) {
      out.resultFull = boundedAndRedacted(safeString(rawResFull, ""), 65536);
      out.resultFullTruncated = rawResTrunc === true;
      try { out.resultFullBytes = Number(rawResBytes) || 0; } catch { out.resultFullBytes = 0; }
    }
    try {
      out.at = Number.isFinite(Number(rawAt)) ? Number(rawAt) : Date.now();
    } catch {
      out.at = Date.now();
    }
    return out;
  } catch {
    return {
      type: "tool-result",
      id: "[unserializable]",
      executionId: "[unserializable]",
      callId: "[unserializable]",
      tool: "tool",
      result: "[unserializable]",
      ok: null,
      at: Date.now(),
    };
  }
}

/** Normalize any durable log entry (tool-call or tool-result) via allowlisting. */
export function normalizeDurableLog(log) {
  if (!log || typeof log !== "object") return log;
  if (log.type === "tool-call") return normalizeDurableToolCall(log);
  if (log.type === "tool-result") return normalizeDurableToolResult(log);
  return log;
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

/** Known per-tool secret argument names (P1-3 / 2uhx). Bare argument names
 * like "key" are not covered by generic SECRET_KEY_RE to avoid global false
 * positives, but are redacted on tool egress, digest, and display paths. */
export const KNOWN_TOOL_SECRET_ARGS = Object.freeze({
  chacha20_poly1305: Object.freeze(["key"]),
});

const ALL_KNOWN_TOOL_SECRET_ARGS = Object.freeze(
  Array.from(new Set(Object.values(KNOWN_TOOL_SECRET_ARGS).flat()))
);

/**
 * Redact tool arguments declared as secret for a specific tool.
 * Targeted: avoids widening SECRET_KEY_RE globally while ensuring bare secret
 * arguments (such as AEAD keys) never reach continuation digests or tool cards.
 * When the tool is a protocol tool (e.g. execute_tool) or unknown/unresolved,
 * arguments (including nested arguments envelopes) are redacted against the union
 * of known tool secret argument names.
 * Bounded depth and cycle-resistant; never throws on hostile input.
 * @param {string} toolName
 * @param {any} args
 * @param {readonly string[]|string[]|null} [extraSecretArgs]
 * @param {number} [depth=0]
 * @param {Set<object>} [activeAncestors=new Set()]
 * @returns {any}
 */
export function redactToolArgs(toolName, args, extraSecretArgs = null, depth = 0, activeAncestors = new Set()) {
  if (args == null) return args;
  if (depth > 8) return "[depth-capped]";

  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(redactToolArgs(toolName, parsed, extraSecretArgs, depth + 1, activeAncestors));
      }
    } catch {
      return args;
    }
    return args;
  }

  if (typeof args !== "object") return args;
  if (activeAncestors.has(args)) return "[cycle]";
  activeAncestors.add(args);

  try {
    if (Array.isArray(args)) {
      return args.slice(0, 200).map((item) => redactToolArgs(toolName, item, extraSecretArgs, depth + 1, activeAncestors));
    }

    const tool = String(toolName ?? "").slice(0, 64);
    const effectiveTool = tool || (typeof args?.toolId === "string" ? args.toolId : (typeof args?.tool === "string" ? args.tool : ""));
    const isProtocolOrUnknown = !effectiveTool || effectiveTool === "execute_tool" || effectiveTool === "search_tools" || effectiveTool === "tool";
    const secretSet = new Set(
      Array.isArray(extraSecretArgs)
        ? extraSecretArgs
        : (KNOWN_TOOL_SECRET_ARGS[effectiveTool] ?? (isProtocolOrUnknown ? ALL_KNOWN_TOOL_SECRET_ARGS : []))
    );

    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(args)) {
      if (n++ >= 200) { out["…"] = "[truncated]"; break; }
      if (secretSet.has(k)) {
        out[k] = "[REDACTED]";
      } else if (v && typeof v === "object") {
        const nestedExtra = (k === "arguments" && secretSet.size === 0) ? ALL_KNOWN_TOOL_SECRET_ARGS : extraSecretArgs;
        out[k] = redactToolArgs(toolName, v, nestedExtra, depth + 1, activeAncestors);
      } else if (typeof v === "string") {
        if (k === "arguments") {
          const nestedExtra = secretSet.size === 0 ? ALL_KNOWN_TOOL_SECRET_ARGS : extraSecretArgs;
          out[k] = redactToolArgs(toolName, v, nestedExtra, depth + 1, activeAncestors);
        } else {
          out[k] = v;
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  } finally {
    activeAncestors.delete(args);
  }
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

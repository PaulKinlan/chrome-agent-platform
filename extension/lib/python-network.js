// lib/python-network.js — the OWNER GRANT policy and the request LEDGER behind
// Python's permissioned network access (bead chrome-agent-platform-4p7j.2,
// stage S0.5; design in cap-evidence/claude/4p7j-analysis.md §10.2b/§15).
//
// WHY THIS EXISTS. S0 (chrome-agent-platform-4p7j.1) removed the Pyodide
// worker's ambient network globals: model-authored Python can no longer reach
// any origin on its own. That was never meant to be the end state. Paul's
// requirement is that Python CAN make requests — but only ones the owner
// granted, only through a proxy the owner can see, and only with a record.
// Ambient fetch is a capability the owner cannot see, scope or revoke; a
// proxied grant is all three.
//
// THE SHAPE OF THE WHOLE BRIDGE, so this module reads in context:
//
//   Python `await cap.fetch(url)`            (wasm-tools/python/python-worker.js)
//     -> JS shim, one correlation id per call
//     -> postMessage to the offscreen host   (lib/python-host.js)
//     -> chrome.runtime to the SERVICE WORKER
//     -> THIS module's policy + the SW's "python.fetch" route
//     -> the SW performs the ONLY fetch, and records it
//     -> response envelope back down the same path
//
// The service worker is the only network actor. With S0 landed the worker holds
// no network globals at all, so the shim is the only route out of the
// interpreter and the policy below cannot be bypassed from Python.
//
// THE CONFUSED-DEPUTY PROBLEM — the reason this file is careful. The service
// worker holds host_permissions <all_urls> AND the owner's ambient cookies for
// every origin. A naive `fetch(url)` in the SW issues AUTHENTICATED requests:
// a grant that merely said "example.com is allowed" would silently become
// "read the owner's logged-in session at example.com". So a granted origin
// buys ANONYMOUS access and nothing more. The defenses split across two files
// by their nature:
//   - here (pure, testable): which origins are reachable, and which request
//     headers a caller may set;
//   - in the SW route (where the fetch happens): credentials "omit", redirect
//     "manual", and the host-permission check.
// The scheme and loopback/private-address (SSRF) checks are NOT reimplemented
// here — they are `checkFetchTarget` in lib/fetch-policy.js, shared with the
// script sandbox's "cap:fetch" bridge so the two can never drift apart.

import { checkFetchTarget } from "./fetch-policy.js";

/** Where the owner's grants persist (kv.js / chrome.storage.local). */
export const PYTHON_NETWORK_GRANTS_KEY = "cap:pythonNetworkGrants";

/** How a grant came to exist. Recorded per row and shown in Settings, because
 * "when, and by which gesture" is what makes a list of grants auditable rather
 * than a list of assertions. */
export const GRANT_GESTURES = Object.freeze(["settings", "first-use-prompt"]);

/** Records kept per run. A program that loops forever on a granted origin must
 * not grow the ledger without bound; the count is honest when it truncates. */
const MAX_RECORDS_PER_RUN = 500;

/** Request headers the CALLER may never set. Cookie/Authorization would
 * re-authenticate the anonymous request the whole design depends on; the
 * Origin/Referer/Host family would let a caller forge where the request claims
 * to come from. (Chrome forbids some of these to fetch() anyway — the refusal
 * is here so the caller gets a reason instead of a silently dropped header.) */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "cookie", "cookie2", "authorization", "proxy-authorization",
  "origin", "referer", "host", "set-cookie", "set-cookie2",
]);

/** Canonical origin for a grant or a request: scheme + host + explicit port.
 *
 * A bare "example.com" is read as https — the safe reading, never http. An
 * origin is deliberately NOT just a host: granting https://example.com does not
 * grant http://example.com, because the cleartext one is a different security
 * story and the owner did not agree to it.
 *
 * Returns null when the input cannot be read as an http(s) origin. */
export function normalizeGrantOrigin(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.port ? `${u.protocol}//${u.hostname}:${u.port}` : `${u.protocol}//${u.hostname}`;
}

/** chrome-agent-platform-lrhyl: the query string is where credentials live
 * (the '?key=' pattern), and every URL that becomes model-readable — the
 * cap.fetch response echo and the network records carried in the run envelope
 * — must carry ORIGIN+PATH ONLY. A parse failure yields the empty string:
 * fail closed toward saying nothing rather than echoing a raw, possibly
 * secret-carrying string. The REQUEST still fetches the full URL — stripping
 * is for echoes, never for dispatch. */
export function urlWithoutQuery(raw) {
  try {
    const u = new URL(String(raw ?? ""));
    // Round 6: only http(s) has a meaningful origin. An opaque-scheme string
    // ('user:LRHYL@host/path?token=x' PARSES with scheme 'user:') has origin
    // "null" and keeps its whole credential-bearing body as the path — so a
    // non-special scheme fails closed to "" exactly like garbage input.
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/** lrhyl round 6 (coord's contract narrowing): five review rounds found five
 * leak SHAPES because the surface was any string — a scrubber over arbitrary
 * free text cannot be made correct when the input is attacker-shaped. So the
 * free-text scrubber (scrubUrlQueries, rounds 2-5) is DELETED and the
 * model-visible ledger no longer carries arbitrary text at all: failures are a
 * fixed machine code plus structured, already-sanitised fields. This is the
 * vocabulary. The first four are the codes coord named; the rest replace the
 * interpolations this handler actually had, one code per pre-existing
 * distinction, so the model keeps every actionable difference it had. */
export const PYTHON_FETCH_ERROR_CODES = Object.freeze([
  "fetch_failed", "aborted", "timeout", "invalid_url",
  "grant_store_failed", "method_not_allowed", "forbidden_host", "not_granted",
  "vault_origin_not_approved", "vault_key_missing", "host_permission_missing",
  "grant_revoked", "redirect_refused", "unauthorized_principal",
]);
const ERROR_CODE_SET = new Set(PYTHON_FETCH_ERROR_CODES);

/** Static guidance per code — OUR words, selected by the code, NEVER
 * interpolated with request data. This is what keeps the refusal teachable
 * (the old prose explained the boundary to the model) without the prose being
 * attacker-shaped: the only per-request values travel in structured,
 * sanitised fields alongside it. */
export const PYTHON_FETCH_ERROR_HINTS = Object.freeze({
  fetch_failed: "The fetch failed at the network layer. Nothing more is known; the service-worker console has the raw error for debugging.",
  aborted: "The Python run settled before this fetch finished, so it was aborted and recorded with its duration.",
  timeout: "The fetch timed out.",
  invalid_url: "The URL was unparseable or not http(s). Use an absolute https:// URL.",
  grant_store_failed: "Network access could not be checked because the grant store failed to read; nothing was sent. Retry, and check extension storage if it persists.",
  method_not_allowed: "cap.fetch does GET, HEAD, POST only.",
  forbidden_host: "The host is private or loopback. The Python sandbox reaches public origins only.",
  not_granted: "That origin is not in the owner's Python network grants; the request was refused and recorded. Nothing was sent. The owner can add the origin in Settings → Permissions → “Python network access”.",
  vault_origin_not_approved: "The $VAULT secret referenced is not bound to this origin. Fetch the origin the secret was registered for (see vaultKeyId).",
  vault_key_missing: "The $VAULT key referenced has no value in the vault (see vaultKeyId).",
  host_permission_missing: "Chrome host permission is missing — it is granted at install (<all_urls>). If Settings → Permissions shows it missing, reinstall the extension.",
  grant_revoked: "The origin's grant was revoked mid-run, so the fetch was refused; nothing more will be sent to it.",
  redirect_refused: "The response redirected elsewhere, so the fetch was refused. A granted origin is an origin, not a starting point — grant the destination if you meant to reach it.",
  unauthorized_principal: "Only the extension host may relay python.fetch.",
});

/** The CLOSED record shape (lrhyl round 6). A ledger record is exactly these
 * fields; anything else a caller passes is dropped by projectRecord before the
 * marshal ever sees it. The shape test in tests/python-network-bridge.test.ts
 * pins Object.keys() per writer, so a new field — free-text or not — cannot be
 * added silently. */
const RECORD_FIELDS = Object.freeze([
  "method", "url", "origin", "ok", "status", "bytes", "ms",
  "refused", "aborted", "outcome", "inFlight", "errorCode", "vaultKeyId",
  "refusedHeaders",
]);
const RECORD_FIELD_SET = new Set(RECORD_FIELDS);
/** A header name per RFC 9110 token rules, length-bounded. Anything else in a
 * model-visible list is refused under a fixed marker. */
const HEADER_NAME_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,128}$/;

/** Method is model-supplied, so it is a fixed token or nothing: the raw string
 * once travelled into records AND into refusal prose ('method X is not
 * allowed'), which made it a free-text leak with the model's own input in it. */
function safeMethodToken(method) {
  const t = String(method ?? "GET").toUpperCase();
  return ALLOWED_METHODS.includes(t) ? t : "INVALID";
}

/** Every writer projects through here BEFORE the marshal. Unknown fields are
 * dropped — including any free-text 'error' — and an errorCode outside the
 * fixed vocabulary collapses to 'fetch_failed'. The drop is announced on a
 * DEBUG-ONLY sink (console.error in the service worker, never part of a
 * record): field NAMES are logged, never values, because values are exactly
 * what attacker-shaped input could poison. */
function projectRecord(partial, where) {
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(partial ?? {})) {
    if (RECORD_FIELD_SET.has(k)) out[k] = v;
    else dropped.push(k);
  }
  if (out.method !== undefined) out.method = safeMethodToken(out.method);
  if (out.errorCode !== undefined && !ERROR_CODE_SET.has(out.errorCode)) {
    dropped.push(`errorCode<${typeof out.errorCode}>`);
    out.errorCode = "fetch_failed";
  }
  // Round 6, value bounds: EVERY string field of a record is now provably
  // bounded — method (token), errorCode (enum), outcome (enum), origin
  // (re-parsed to a bare origin or dropped), url (writers fail it closed to
  // "" or origin+path), refusedHeaders (token charset or '<invalid-name>').
  // That is what makes the marshal's verbatim pass-through for unparseable
  // strings sound: no free text can occupy a contract field.
  if (out.outcome !== undefined && out.outcome !== "aborted") {
    dropped.push("outcome");
    delete out.outcome;
  }
  if (out.origin != null) {
    // Round 6: an origin is scheme+host(+port) of an http(s) URL, or nothing.
    // An opaque-scheme string ('user:SECRET@host/path') PARSES with origin
    // "null" and its body in the path — dropped, same as garbage.
    try {
      const parsed = new URL(String(out.origin));
      if (parsed.protocol === "http:" || parsed.protocol === "https:") out.origin = parsed.origin;
      else { dropped.push("origin"); delete out.origin; }
    } catch {
      dropped.push("origin");
      delete out.origin;
    }
  }
  for (const f of ["status", "bytes", "ms"]) {
    if (out[f] === undefined) continue;
    const n = Number(out[f]);
    if (Number.isFinite(n)) out[f] = n;
    else { dropped.push(f); delete out[f]; }
  }
  for (const f of ["ok", "refused", "aborted", "inFlight"]) {
    if (out[f] !== undefined && typeof out[f] !== "boolean") {
      dropped.push(f);
      delete out[f];
    }
  }
  if (out.refusedHeaders !== undefined) {
    if (!Array.isArray(out.refusedHeaders)) {
      dropped.push("refusedHeaders");
      delete out.refusedHeaders;
    } else {
      out.refusedHeaders = out.refusedHeaders.map((n) =>
        typeof n === "string" && HEADER_NAME_TOKEN.test(n) ? n : "<invalid-name>"
      );
    }
  }
  if (dropped.length > 0) {
    // Debug-only, NOT model-visible: names, never values.
    try {
      console.error(`python-network ledger (${where}): dropped non-contract field(s): ${dropped.join(", ")}`);
    } catch { /* hosts without a console lose the debug line only */ }
  }
  return out;
}

/** The tag vocabulary for values the marshal cannot inspect — FIXED names
 * decided by instanceof checks inside try/catch. It never reads .name,
 * .constructor or .toString off the value: those are attacker-influenceable
 * getters, and a tag embedding them turns the fallback itself into the leak
 * (lrhyl round 5, review finding 4). */
function uninspectableKind(value) {
  try {
    if (value instanceof Map) return "Map";
    if (value instanceof Set) return "Set";
    if (value instanceof Date) return "Date";
    if (value instanceof RegExp) return "RegExp";
    if (ArrayBuffer.isView(value)) return "View";
  } catch { /* hostile Symbol.hasInstance — the generic tag below is safe */ }
  return "object";
}

/** lrhyl round 4 (review finding, coord's structural spec): ONE marshal that
 * EVERY record passes through before it can be observed. Round 3's walker was
 * wired into the three construction points it knew about; the reviewer found a
 * FOURTH writer that already existed (abortInFlight) and silent skips for
 * nested objects, arrays, URL instances and uninspectable values. This is the
 * shape-independent answer: deep-walk plain objects and arrays, handle URL
 * instances via toString, strip any string that PARSES as a URL carrying a
 * query, hash or userinfo (all credential locations) down to origin+path while
 * clean URLs keep their exact shape (origins must not grow a slash), lexically
 * scrub URL tokens inside free text (userinfo, query AND fragment — round 5),
 * marshal object KEYS exactly like values (round 5: a query-bearing URL as a
 * key leaked before; assignment goes through defineProperty so a '__proto__'
 * key can never repoint the prototype), and TAG anything that cannot be
 * inspected with the FIXED uninspectableKind vocabulary — a tag is honest and
 * model-visible; a silent skip looks like success, and an informative tag is
 * itself a leak.
 * Circular structures and depth > 8 are tagged, never walked to death.
 * Idempotent: marshalling an already-marshalled record is a no-op, so take()
 * re-marshals at the observation boundary as defense in depth (a hypothetical
 * fifth writer cannot bypass the boundary even if it bypassed the writers). */
export function marshalModelReadable(value, depth = 0, path = null) {
  if (typeof value === "string") {
    try {
      const u = new URL(value);
      // Round 6: an opaque-scheme string parses too ('user:SECRET@host/path'),
      // with origin "null" and the credential kept in the path — fail closed.
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      // Strip only when there IS something to strip — a clean URL keeps its
      // exact shape (origins must not grow a trailing slash). Query, hash and
      // userinfo are all credential locations.
      if (u.search || u.hash || u.username || u.password) return urlWithoutQuery(value);
      return value;
    } catch {
      // Round 6: unparseable strings pass through VERBATIM. That is safe
      // because the contract changed, not because the strings are trusted:
      // records carry no free text at all (projectRecord drops any field
      // outside the closed shape, and failures are fixed codes), so every
      // string that can reach here is a code-generated token — a method, an
      // outcome, an errorCode, a token-charset header name, a normalised
      // origin+path. The old lexical scrubber is deleted: a text scrubber
      // over attacker-shaped input cannot be made correct (five rounds,
      // five shapes), and keeping it would invite free text back in.
      return value;
    }
  }
  if (value instanceof URL) return marshalModelReadable(value.toString(), depth, path);
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "number" || t === "boolean") return value;
  if (t !== "object") return `[lrhyl-uninspectable:${t}]`; // functions, symbols, bigint: tagged, never passed
  if (depth > 8) return "[lrhyl-uninspectable:depth]";
  const trail = path ?? [];
  if (trail.includes(value)) return "[lrhyl-uninspectable:cycle]";
  const deeper = [...trail, value];
  if (Array.isArray(value)) return value.map((v) => marshalModelReadable(v, depth + 1, deeper));
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Round 5: keys are model-visible strings exactly like values — marshal
      // them with the same walker. defineProperty so a '__proto__' key becomes
      // a plain own property and can never repoint out's prototype.
      Object.defineProperty(out, marshalModelReadable(k, depth + 1, deeper), {
        value: marshalModelReadable(v, depth + 1, deeper),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return `[lrhyl-uninspectable:${uninspectableKind(value)}]`; // class instances: FIXED vocabulary, never a value-derived name
}

/** Read a persisted grant list into the canonical, de-duplicated shape.
 * Anything unreadable is DROPPED, never guessed at: a grant that cannot be
 * parsed is not a grant. */
export function normalizeGrants(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const byOrigin = new Map();
  for (const row of list) {
    const origin = normalizeGrantOrigin(row?.origin ?? row);
    if (!origin || byOrigin.has(origin)) continue;
    const gesture = GRANT_GESTURES.includes(row?.gesture) ? row.gesture : "settings";
    const grantedAt = Number.isFinite(row?.grantedAt) ? Number(row.grantedAt) : 0;
    byOrigin.set(origin, Object.freeze({ origin, grantedAt, gesture }));
  }
  return Object.freeze([...byOrigin.values()]);
}

/** Add a grant (idempotent on origin — re-granting keeps the FIRST grant's
 * timestamp, so the list answers "since when" honestly). */
export function addGrant(rows, input, { gesture = "settings", now = Date.now() } = {}) {
  const origin = normalizeGrantOrigin(input);
  if (!origin) return { ok: false, error: `"${String(input ?? "")}" is not an http(s) origin` };
  const grants = normalizeGrants(rows);
  if (grants.some((g) => g.origin === origin)) return { ok: true, origin, grants, added: false };
  const next = normalizeGrants([...grants, { origin, grantedAt: now, gesture }]);
  return { ok: true, origin, grants: next, added: true };
}

/** Revoke a grant. Removal IS the revocation authority — there is no disabled
 * state to get out of step with the list the owner is reading. */
export function removeGrant(rows, input) {
  const origin = normalizeGrantOrigin(input);
  const grants = normalizeGrants(rows);
  if (!origin) return { ok: false, error: "unknown origin", grants };
  const next = grants.filter((g) => g.origin !== origin);
  return { ok: true, origin, grants: Object.freeze(next), removed: next.length !== grants.length };
}

/** Which methods a granted origin buys. GET/HEAD/POST only.
 *
 * POST is here because most useful APIs need it and a grant is a per-origin
 * owner decision with every call recorded — not because it is free. PUT /
 * PATCH / DELETE are refused: those write to somebody else's system, and the
 * owner granting "this agent may read from api.example.com" has not agreed to
 * that. Widening this set is an owner decision, not an implementation one. */
export const ALLOWED_METHODS = Object.freeze(["GET", "HEAD", "POST"]);

/** Split caller headers into the ones that travel and the ones refused, with
 * the reason. Refused headers do NOT fail the request — they are dropped and
 * NAMED in the record, so an owner reading the transcript sees the attempt. */
export function sanitizeRequestHeaders(headers) {
  const out = {};
  const refused = [];
  const source = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName ?? "").trim();
    if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      // Round 6: the refused list is model-visible, and header NAMES are
      // caller-supplied strings — a hostile name like 'X-https://h?token=S'
      // was free text in the record. Names that are not HTTP tokens are
      // refused under a fixed marker; the attempt is still visible.
      refused.push("<invalid-name>");
      continue;
    }
    const lower = name.toLowerCase();
    if (lower === "authorization") {
      const val = String(rawValue ?? "");
      if (/\$VAULT\{[A-Z][A-Z0-9_]*\}/.test(val)) {
        out[name] = val;
        continue;
      }
      refused.push(name);
      continue;
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
      refused.push(name);
      continue;
    }
    out[name] = String(rawValue ?? "");
  }
  return { headers: out, refused };
}

/**
 * The grant decision for one Python request.
 *
 * `grants` is the owner's persisted list. NO grants means NOTHING is
 * reachable — the empty list is a real answer, not a missing configuration, so
 * this fails closed with a machine code; the teachable prose lives in the
 * static PYTHON_FETCH_ERROR_HINTS (round 6: a refusal message that interpolated
 * the method string was itself a free-text leak). A silent empty response
 * would teach the model that the network is broken rather than that it is
 * bounded.
 *
 * Returns { ok:true, url, origin, method } or { ok:false, errorCode, origin? }
 * — errorCode from the fixed PYTHON_FETCH_ERROR_CODES vocabulary, never text.
 */
export function checkPythonNetworkRequest({ url, method = "GET", grants = [] } = {}) {
  const m = String(method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.includes(m)) {
    // Round 6: the method string is model-supplied — echoing it back in prose
    // ('method X is not allowed') made the refusal a free-text channel.
    return { ok: false, errorCode: "method_not_allowed" };
  }
  const target = checkFetchTarget(url);
  if (!target.ok) return { ok: false, errorCode: target.errorCode ?? "invalid_url" };
  const u = target.url;
  const origin = normalizeGrantOrigin(u.origin);
  const allowed = normalizeGrants(grants).some((g) => g.origin === origin);
  if (!allowed) {
    return { ok: false, errorCode: "not_granted", origin };
  }
  return { ok: true, url: u.href, origin, method: m };
}

/** True when a fetch response is a redirect that `redirect:"manual"` surfaced
 * rather than followed. A granted origin redirecting to an ungranted one is how
 * an allow-list gets laundered, so the bridge refuses instead of re-resolving:
 * the owner granted an ORIGIN, not a starting point. */
export function isRedirect(response) {
  if (!response || typeof response !== "object") return false;
  if (response.type === "opaqueredirect") return true;
  const status = Number(response.status);
  return Number.isFinite(status) && status >= 300 && status < 400;
}

/**
 * The per-run ledger of every request the SW made (or refused) on Python's
 * behalf.
 *
 * WHO WRITES IT is the point. The record is made by the SERVICE WORKER — the
 * actor — not by the Python program and not by the worker. Python catching the
 * refusal exception, or never printing anything, changes nothing: the record
 * already exists and travels back attached to the tool result. Visibility that
 * the caller can suppress is not visibility.
 *
 * Refusals are recorded as loudly as successes. A denied origin is exactly what
 * an owner wants to see.
 */
export function createPythonNetworkLedger({ maxPerRun = MAX_RECORDS_PER_RUN, maxTakenIds = 500 } = {}) {
  const runs = new Map();
  const takenIds = new Set();

  function rememberTaken(id) {
    if (!id) return;
    if (takenIds.has(id)) takenIds.delete(id);
    takenIds.add(id);
    while (takenIds.size > maxTakenIds) {
      const oldest = takenIds.values().next().value;
      if (oldest === undefined) break;
      takenIds.delete(oldest);
    }
  }

  function ensureRow(id) {
    let row = runs.get(id);
    if (!row) {
      row = { records: [], dropped: 0, hasSuccessfulFetch: false, inFlight: new Set(), settled: false };
      runs.set(id, row);
    }
    return row;
  }

  function abortInFlight(id, now = Date.now()) {
    const row = runs.get(id);
    if (!row) return 0;
    row.settled = true;
    let count = 0;
    for (const inflight of row.inFlight) {
      if (inflight.settled) continue;
      inflight.settled = true;
      count += 1;
      const ms = Math.max(0, now - inflight.startedAt);
      if (inflight.index >= 0 && inflight.index < row.records.length) {
        // lrhyl round 4 (review finding): abortInFlight was the FOURTH writer,
        // pre-existing and unwired. Round 6: the interpolated abort MESSAGE is
        // gone — an abort is the fixed code plus the duration, both structured.
        row.records[inflight.index] = Object.freeze(marshalModelReadable(projectRecord({
          method: inflight.method,
          url: inflight.url,
          ...(inflight.origin ? { origin: inflight.origin } : {}),
          ok: false,
          aborted: true,
          outcome: "aborted",
          ms,
          errorCode: "aborted",
        }, "abortInFlight")));
      }
      try {
        inflight.controller?.abort?.("run_settled");
      } catch { /* controller already closed */ }
    }
    row.inFlight.clear();
    return count;
  }

  return Object.freeze({
    /** Begin an in-flight request at dispatch time (bead chrome-agent-platform-gtc8).
     * Registers its per-run AbortController and writes a dispatch-time record that
     * is completed when fetch() settles or marked aborted with duration if the
     * Python run settles first. */
    begin(runId, { method = "GET", url = "", origin = null, startedAt = Date.now(), controller = null } = {}) {
      const id = String(runId ?? "");
      if (!id) {
        return Object.freeze({ complete: () => false, isSettled: () => false });
      }
      if (takenIds.has(id) || runs.get(id)?.settled) {
        try {
          controller?.abort?.("run_settled");
        } catch { /* ignore */ }
        return Object.freeze({ complete: () => false, isSettled: () => true });
      }
      const row = ensureRow(id);
      // Round 6: method is a fixed token or 'INVALID' — the model-shaped raw
      // string never enters a record (it once did, and was echoed in refusal
      // prose besides).
      const m = safeMethodToken(method);
      // lrhyl: ledger records travel to the model in the run envelope's
      // network field — normalize at the choke point so NO writer (current or
      // future) can put a query string into a model-readable record.
      const u = urlWithoutQuery(url);
      // lrhyl round 4: the in-flight closure stores the SANITISED origin, so
      // every interpolation of it (the abort error text especially) is clean
      // at the source — the marshal at each writer is the belt, this is the
      // braces.
      const o = origin == null ? null : marshalModelReadable(origin);
      const start = Number.isFinite(startedAt) ? Number(startedAt) : Date.now();
      let index = -1;
      if (row.records.length >= maxPerRun) {
        row.dropped += 1;
      } else {
        index = row.records.length;
        row.records.push(Object.freeze(marshalModelReadable(projectRecord({
          method: m,
          url: u,
          ...(o ? { origin: o } : {}),
          ok: false,
          inFlight: true,
          ms: 0,
        }, "begin"))));
      }
      const inflight = {
        index,
        method: m,
        url: u,
        origin: o,
        startedAt: start,
        controller,
        settled: false,
      };
      row.inFlight.add(inflight);
      return Object.freeze({
        complete(finalEntry = {}, now = Date.now()) {
          if (inflight.settled || row.settled || takenIds.has(id)) return false;
          inflight.settled = true;
          row.inFlight.delete(inflight);
          if (finalEntry?.ok === true && !finalEntry?.refused) {
            row.hasSuccessfulFetch = true;
          }
          if (inflight.index >= 0 && inflight.index < row.records.length) {
            const ms = Number.isFinite(finalEntry?.ms)
              ? Number(finalEntry.ms)
              : Math.max(0, now - inflight.startedAt);
            // lrhyl rounds 2-6: the record is PROJECTED onto the closed shape
            // first (round 6 — a caller's free-text 'error', or any other
            // non-contract field, is dropped here and never reaches the
            // marshal), then marshalled (deep walk, URL normalisation, fixed
            // tags). The explicit url line stays: it is the fail-closed-to-
            // empty policy for unparseable url values.
            const merged = projectRecord({
              method: inflight.method,
              url: inflight.url,
              ...(inflight.origin ? { origin: inflight.origin } : {}),
              ms,
              ...finalEntry,
            }, "complete");
            if (merged.url !== undefined) merged.url = urlWithoutQuery(merged.url);
            row.records[inflight.index] = Object.freeze(marshalModelReadable(merged));
          }
          return true;
        },
        isSettled() {
          return inflight.settled;
        },
      });
    },

    /** Abort any in-flight fetches for `runId` and finalize their records with
     * duration before `take(runId)`. */
    abortRun(runId, { now = Date.now() } = {}) {
      const id = String(runId ?? "");
      if (!id) return 0;
      return abortInFlight(id, now);
    },

    /** Record one attempt. The record shape is CLOSED (round 6): exactly
     * { method, url, origin, ok, status?, bytes?, ms, errorCode?, vaultKeyId?,
     * refused?, aborted?, outcome?, refusedHeaders? } — anything else, and any
     * free-text `error`, is dropped by projectRecord. `url` is normalized to
     * origin+path — these records are model-readable via the run envelope. */
    record(runId, entry) {
      const id = String(runId ?? "");
      if (!id || takenIds.has(id) || runs.get(id)?.settled) return;
      const row = ensureRow(id);
      if (entry?.ok === true && !entry?.refused) {
        row.hasSuccessfulFetch = true;
      }
      if (row.records.length >= maxPerRun) {
        row.dropped += 1; // honest count, never a silent truncation
        return;
      }
      // lrhyl rounds 4+6: project onto the closed shape, then through the ONE
      // marshal (deep-walk, URL instances, fixed tags), with the fail-closed
      // url line kept on top.
      const projected = projectRecord(entry, "record");
      if (projected.url !== undefined) projected.url = urlWithoutQuery(projected.url);
      row.records.push(Object.freeze(marshalModelReadable(projected)));
    },

    /** Take (and forget) a run's records. Called once when the run settles, so
     * a finished run holds no memory in a service worker that may live for
     * days. Aborts and finalizes any in-flight fetches for `runId` first. */
    take(runId, { now = Date.now() } = {}) {
      const id = String(runId ?? "");
      if (!id) return { records: [], dropped: 0, hasSuccessfulFetch: false };
      rememberTaken(id);
      abortInFlight(id, now);
      const row = runs.get(id);
      runs.delete(id);
      if (!row) return { records: [], dropped: 0, hasSuccessfulFetch: false };
      // lrhyl round 4: the OBSERVATION boundary — every record is re-marshalled
      // at take() regardless of which writer produced it (the marshal is
      // idempotent and records are bounded per run, so this costs nothing
      // measurable). A hypothetical fifth writer that bypassed the write-time
      // choke points still cannot hand the model an unnormalised record.
      return {
        records: Object.freeze(row.records.map((r) => Object.freeze(marshalModelReadable(r)))),
        dropped: row.dropped,
        hasSuccessfulFetch: row.hasSuccessfulFetch,
      };
    },

    /** Live count, for tests and for a run still in flight. */
    size() {
      return runs.size;
    },
  });
}


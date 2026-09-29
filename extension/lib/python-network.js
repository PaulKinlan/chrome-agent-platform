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
      refused.push(String(rawName ?? ""));
      continue;
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
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
 * this fails closed with a message that names the origin and says how to grant
 * it. A silent empty response would teach the model that the network is broken
 * rather than that it is bounded.
 *
 * Returns { ok:true, url, origin, method } or { ok:false, error, origin? }.
 */
export function checkPythonNetworkRequest({ url, method = "GET", grants = [] } = {}) {
  const m = String(method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.includes(m)) {
    return { ok: false, error: `method ${m} is not allowed here — cap.fetch does ${ALLOWED_METHODS.join(", ")}` };
  }
  const target = checkFetchTarget(url);
  if (!target.ok) return { ok: false, error: target.error };
  const u = target.url;
  const origin = normalizeGrantOrigin(u.origin);
  const allowed = normalizeGrants(grants).some((g) => g.origin === origin);
  if (!allowed) {
    return {
      ok: false,
      origin,
      error: `network access to ${origin} is not granted. Python here reaches only origins the owner has granted; ` +
        `this request was refused and recorded. To allow it, the owner adds ${origin} in Settings → Permissions → ` +
        `"Python network access". Nothing was sent.`,
    };
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
export function createPythonNetworkLedger({ maxPerRun = MAX_RECORDS_PER_RUN } = {}) {
  const runs = new Map();

  return Object.freeze({
    /** Record one attempt. `record` is already the owner-facing shape:
     * { method, url, origin, ok, status?, bytes?, ms, error?, refusedHeaders? } */
    record(runId, entry) {
      const id = String(runId ?? "");
      if (!id) return;
      let row = runs.get(id);
      if (!row) {
        row = { records: [], dropped: 0 };
        runs.set(id, row);
      }
      if (row.records.length >= maxPerRun) {
        row.dropped += 1; // honest count, never a silent truncation
        return;
      }
      row.records.push(Object.freeze({ ...entry }));
    },

    /** Take (and forget) a run's records. Called once when the run settles, so
     * a finished run holds no memory in a service worker that may live for
     * days. */
    take(runId) {
      const id = String(runId ?? "");
      const row = runs.get(id);
      runs.delete(id);
      if (!row) return { records: [], dropped: 0 };
      return { records: row.records, dropped: row.dropped };
    },

    /** Live count, for tests and for a run still in flight. */
    size() {
      return runs.size;
    },
  });
}

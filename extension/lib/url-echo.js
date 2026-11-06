// chrome-agent-platform-7t2zv: the SHARED model-readable URL echo normaliser,
// promoted out of python-network.js so the script-side brokers (script-host's
// runFetch direct fallback, and any future non-SW echo site) can strip query
// strings WITHOUT importing the whole Python network ledger into their bundle
// surface. python-network.js re-exports it, so every existing consumer and
// citation (THREAT_MODEL.md TB4's `python-network.js#urlWithoutQuery`, the
// service-worker import) keeps working unchanged.
//
// chrome-agent-platform-lrhyl: the query string is where credentials live
// (the '?key=' pattern), and every URL that becomes model-readable — the
// cap.fetch response echo and the network records carried in the run envelope
// — must carry ORIGIN+PATH ONLY. A parse failure yields the empty string:
// fail closed toward saying nothing rather than echoing a raw, possibly
// secret-carrying string. The REQUEST still fetches the full URL — stripping
// is for echoes, never for dispatch.
// CAVEAT (lrhyl r6.1 review): failing closed on opaque schemes is right for
// model-readable echoes, but do not reuse this helper where opaque schemes are
// legitimate (data:, blob:, chrome-extension: URLs) — it would blank them.
// CAVEAT (guh95): origin+path KEEPS the path. Where secrets can be substituted
// INTO the path ($VAULT{KEY} substitution scans the whole URL string), this
// helper does NOT make a post-substitution URL safe to echo — echo the
// PRE-SUBSTITUTION template instead, as python.fetch's return does. The same
// rule now governs the script-side brokers this module serves.

/** Normalise a URL to its echo-safe form: origin + path, or "" if it does not
 * parse as http(s). Exported for the brokers and their tests. */
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

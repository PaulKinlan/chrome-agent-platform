// Python's permissioned network access (bead chrome-agent-platform-4p7j.2,
// stage S0.5). S0 removed the Pyodide worker's ambient network globals; this
// stage gives back a narrower capability in their place — per-origin owner
// grants, proxied through the service worker, with every request and refusal
// recorded.
//
// These are the PURE halves: which origins are reachable, which headers a
// caller may set, and the ledger that makes a request visible whether or not
// the Python program admits to it. The confused-deputy defaults that live in
// the fetch call itself (credentials "omit", redirect "manual") are asserted in
// tests/python-network-route.test.ts, and driven for real in
// scripts/kat-python-permissioned-fetch.ts.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ALLOWED_METHODS,
  addGrant,
  checkPythonNetworkRequest,
  createPythonNetworkLedger,
  isRedirect,
  normalizeGrantOrigin,
  normalizeGrants,
  removeGrant,
  sanitizeRequestHeaders,
} from "../extension/lib/python-network.js";

const GRANTED = [{ origin: "https://api.example.com", grantedAt: 1, gesture: "settings" }];

Deno.test("no grants means nothing is reachable — the empty list is an answer, not a gap", () => {
  const res = checkPythonNetworkRequest({ url: "https://api.example.com/x", grants: [] });
  assertEquals(res.ok, false);
  assert(String(res.error).includes("https://api.example.com"), res.error);
  assert(String(res.error).includes("not granted"), res.error);
  // The refusal has to TEACH: it names the origin and where the owner grants
  // it, so a model reads a boundary rather than an outage and stops retrying.
  assert(/Settings/.test(res.error), res.error);
  assert(/Nothing was sent/.test(res.error), res.error);
});

Deno.test("a granted origin is reachable; a different origin on the same host is not", () => {
  assertEquals(checkPythonNetworkRequest({ url: "https://api.example.com/items?q=1", grants: GRANTED }).ok, true);
  // Scheme is part of the origin: granting https never grants cleartext http.
  assertEquals(checkPythonNetworkRequest({ url: "http://api.example.com/items", grants: GRANTED }).ok, false);
  // Nor does it grant a sibling host or a port.
  assertEquals(checkPythonNetworkRequest({ url: "https://evil.example.com/", grants: GRANTED }).ok, false);
  assertEquals(checkPythonNetworkRequest({ url: "https://api.example.com:8443/", grants: GRANTED }).ok, false);
});

Deno.test("a granted host cannot be used to reach a private address, and no scheme but http(s) is allowed", () => {
  // The SSRF predicate is shared with the script sandbox's cap:fetch bridge
  // (lib/fetch-policy.js) — a grant must never become a way into localhost.
  const localGrants = [{ origin: "http://localhost", grantedAt: 1, gesture: "settings" }];
  const local = checkPythonNetworkRequest({ url: "http://localhost:9222/json", grants: localGrants });
  assertEquals(local.ok, false);
  assert(String(local.error).includes("private or loopback"), local.error);

  const meta = checkPythonNetworkRequest({
    url: "http://169.254.169.254/latest/meta-data/",
    grants: [{ origin: "http://169.254.169.254", grantedAt: 1, gesture: "settings" }],
  });
  assertEquals(meta.ok, false);

  for (const url of ["file:///etc/passwd", "chrome-extension://abc/manifest.json", "data:text/plain,hi"]) {
    assertEquals(checkPythonNetworkRequest({ url, grants: GRANTED }).ok, false, url);
  }
});

Deno.test("only GET/HEAD/POST — a grant to read is not a grant to write", () => {
  assertEquals(ALLOWED_METHODS, ["GET", "HEAD", "POST"]);
  for (const method of ALLOWED_METHODS) {
    assertEquals(checkPythonNetworkRequest({ url: "https://api.example.com/", method, grants: GRANTED }).ok, true, method);
  }
  for (const method of ["PUT", "PATCH", "DELETE", "TRACE", "CONNECT"]) {
    const res = checkPythonNetworkRequest({ url: "https://api.example.com/", method, grants: GRANTED });
    assertEquals(res.ok, false, method);
    assert(String(res.error).includes("cap.fetch"), res.error);
  }
});

Deno.test("a caller can never re-authenticate the anonymous request", () => {
  // The whole design rests on a granted origin buying ANONYMOUS access. A
  // caller-set Cookie or Authorization header would hand back exactly the
  // confused-deputy power the proxy exists to withhold.
  const { headers, refused } = sanitizeRequestHeaders({
    Accept: "application/json",
    "X-Api-Key": "k",
    Cookie: "session=owner",
    authorization: "Bearer owner-token",
    Origin: "https://trusted.example",
    Referer: "https://trusted.example/",
    Host: "internal",
  });
  assertEquals(Object.keys(headers).sort(), ["Accept", "X-Api-Key"]);
  assertEquals(refused.sort(), ["Cookie", "Host", "Origin", "Referer", "authorization"]);
  assertEquals(headers.Cookie, undefined);
  // Refused headers are NAMED rather than silently dropped: the attempt is what
  // an owner reading the record wants to see.
  assert(refused.length > 0);
});

Deno.test("a redirect is a refusal, not a hop — an allow-list must not be launderable", () => {
  assertEquals(isRedirect({ status: 302 }), true);
  assertEquals(isRedirect({ status: 301 }), true);
  assertEquals(isRedirect({ type: "opaqueredirect", status: 0 }), true);
  assertEquals(isRedirect({ status: 200 }), false);
  assertEquals(isRedirect({ status: 404 }), false);
  assertEquals(isRedirect(null), false);
});

Deno.test("origins normalize the safe way, and unreadable ones are dropped rather than guessed", () => {
  assertEquals(normalizeGrantOrigin("api.example.com"), "https://api.example.com"); // bare host upgrades to https, never http
  assertEquals(normalizeGrantOrigin("https://api.example.com/some/path?q=1"), "https://api.example.com");
  assertEquals(normalizeGrantOrigin("http://api.example.com:8080"), "http://api.example.com:8080");
  assertEquals(normalizeGrantOrigin("HTTPS://API.Example.COM"), "https://api.example.com");
  for (const bad of ["", "   ", "file:///etc", "chrome-extension://abc", "javascript:alert(1)", null]) {
    assertEquals(normalizeGrantOrigin(bad), null, String(bad));
  }
  // A number-shaped input IS a valid host to the URL parser ("42" canonicalises
  // to 0.0.0.42), so normalization keeps it rather than pretending otherwise —
  // and the request-time address check is what refuses it. Recorded here so the
  // division of labour is deliberate and not an accident of two predicates.
  assertEquals(normalizeGrantOrigin(42), "https://0.0.0.42");
  assertEquals(
    checkPythonNetworkRequest({
      url: "https://0.0.0.42/",
      grants: [{ origin: "https://0.0.0.42", grantedAt: 1, gesture: "settings" }],
    }).ok,
    false,
  );
  // A row that cannot be read is not a grant.
  assertEquals(normalizeGrants([{ origin: "nope://x" }, { origin: "https://ok.example" }]).length, 1);
});

Deno.test("granting is idempotent and keeps the FIRST timestamp; removing is the revocation", () => {
  const first = addGrant([], "https://api.example.com", { gesture: "settings", now: 1000 });
  assertEquals(first.added, true);
  const again = addGrant(first.grants, "api.example.com", { gesture: "first-use-prompt", now: 5000 });
  assertEquals(again.added, false);
  assertEquals(again.grants.length, 1);
  assertEquals(again.grants[0].grantedAt, 1000, "re-granting must not restate when access began");

  const gone = removeGrant(again.grants, "https://api.example.com");
  assertEquals(gone.removed, true);
  assertEquals(gone.grants.length, 0);
  // And with the row gone, the origin is refused again — there is no lingering
  // disabled state that could disagree with the list the owner is reading.
  assertEquals(checkPythonNetworkRequest({ url: "https://api.example.com/", grants: gone.grants }).ok, false);

  const bad = addGrant([], "not a url at all !!");
  assertEquals(bad.ok, false);
});

Deno.test("the ledger records refusals as loudly as successes, and a run's records are taken exactly once", () => {
  const ledger = createPythonNetworkLedger();
  ledger.record("run-1", { method: "GET", url: "https://api.example.com/a", ok: true, status: 200, bytes: 12, ms: 5 });
  ledger.record("run-1", { method: "GET", url: "https://evil.example/b", ok: false, refused: true, error: "not granted", ms: 1 });
  ledger.record("run-2", { method: "GET", url: "https://api.example.com/c", ok: true, status: 200, bytes: 1, ms: 1 });

  const taken = ledger.take("run-1");
  assertEquals(taken.records.length, 2);
  assertEquals(taken.records[1].refused, true, "a denied origin is exactly what an owner wants to see");
  // Taken once: the second read is empty, so a service worker that lives for
  // days does not accumulate finished runs.
  assertEquals(ledger.take("run-1").records.length, 0);
  assertEquals(ledger.size(), 1);
  ledger.take("run-2");
  assertEquals(ledger.size(), 0);
});

Deno.test("a runaway program truncates the ledger with an honest count, never silently", () => {
  const ledger = createPythonNetworkLedger({ maxPerRun: 3 });
  for (let i = 0; i < 10; i++) {
    ledger.record("r", { method: "GET", url: `https://api.example.com/${i}`, ok: true, status: 200, bytes: 0, ms: 0 });
  }
  const taken = ledger.take("r");
  assertEquals(taken.records.length, 3);
  assertEquals(taken.dropped, 7);
});

// cap:fetch policy (CAP-FB-20260830-RUN-SCRIPT-FETCH-APPROVAL-01): the
// host-side fetch a sandboxed script is bridged to must refuse loopback and
// private address ranges (SSRF from the user's network position) and any host
// the owner did not see on the approval card (the per-run allow-list). The
// predicate is pure so this test runs without a browser; the service worker's
// "cap:fetch" route calls exactly this function before fetching.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { checkFetchPolicy, extractFetchHosts, isPrivateOrLoopbackHost } from "../extension/lib/fetch-policy.js";

const PRIVATE = [
  "http://127.0.0.1/",
  "http://localhost/",
  "http://LOCALHOST:8080/x",
  "http://foo.localhost/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.254/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://[fe80::1]/",
  "http://[fc00::1]/",
  "http://[fd12:3456::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:10.0.0.1]/",
  "http://0.0.0.0/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://017700000001/",
];

Deno.test("cap:fetch policy: every loopback / private / link-local address is refused", () => {
  for (const url of PRIVATE) {
    const res = checkFetchPolicy(url, { hosts: ["example.com", "127.0.0.1", "localhost", "10.1.2.3"], dynamic: true });
    assertEquals(res.ok, false, url);
    assert(String(res.error).includes("private or loopback address"), `${url}: ${res.error}`);
  }
});

Deno.test("cap:fetch policy: a public host is allowed on the run's allow-list and refused off it", () => {
  assertEquals(checkFetchPolicy("https://example.com/", { hosts: ["example.com"], dynamic: false }).ok, true);
  assertEquals(checkFetchPolicy("https://EXAMPLE.com:443/path", { hosts: ["example.com"], dynamic: false }).ok, true);
  const off = checkFetchPolicy("https://example.com/", { hosts: ["other.example"], dynamic: false });
  assertEquals(off.ok, false);
  assert(String(off.error).includes("not on this run's approved host list"), off.error);
  // A port is part of the approved host.
  assertEquals(checkFetchPolicy("https://example.com:8443/", { hosts: ["example.com"], dynamic: false }).ok, false);
  assertEquals(checkFetchPolicy("https://example.com:8443/", { hosts: ["example.com:8443"], dynamic: false }).ok, true);
  // No registered run → nothing is allowed (fail closed).
  assertEquals(checkFetchPolicy("https://example.com/", null).ok, false);
  assertEquals(checkFetchPolicy("https://example.com/", undefined).ok, false);
  // Only http(s).
  assertEquals(checkFetchPolicy("ftp://example.com/", { hosts: ["example.com"], dynamic: false }).ok, false);
  assertEquals(checkFetchPolicy("not a url", { hosts: ["example.com"], dynamic: false }).ok, false);
});

Deno.test("cap:fetch policy: the private predicate handles hostnames and literals directly", () => {
  for (const h of ["localhost", "a.b.localhost", "127.0.0.1", "10.0.0.0", "172.16.0.0", "172.31.1.1", "192.168.0.1", "169.254.1.1", "::1", "fe80::1", "fc00::", "fdff::1", "::ffff:192.168.0.1", "0.0.0.0", ""]) {
    assertEquals(isPrivateOrLoopbackHost(h), true, h);
  }
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "2606:4700::1111", "localhost.example.com"]) {
    assertEquals(isPrivateOrLoopbackHost(h), false, h);
  }
});

Deno.test("cap:fetch policy: hosts are extracted from URL literals; a computed fetch target is flagged dynamic", () => {
  const staticSrc = `const a = await fetch("https://api.example.com/v1?x=1");\nconst b = await fetch('http://feeds.example.org:8080/rss');\nreturn a.text + b.text;`;
  assertEquals(extractFetchHosts(staticSrc), { hosts: ["api.example.com", "feeds.example.org:8080"], dynamic: false });
  const dynamicSrc = "const base = 'https://api.example.com'; return (await fetch(base + '/?d=' + encodeURIComponent(secret))).text";
  assertEquals(extractFetchHosts(dynamicSrc), { hosts: ["api.example.com"], dynamic: true });
  // Template literals with interpolation are computed targets.
  assertEquals(extractFetchHosts("return await fetch(`https://${host}/x`)"), { hosts: [], dynamic: true });
  assertEquals(extractFetchHosts("return 1 + 1"), { hosts: [], dynamic: false });
  // Bounded: hosts are unique and capped.
  const many = Array.from({ length: 200 }, (_, i) => `fetch("https://h${i}.example/")`).join(";");
  assert(extractFetchHosts(many).hosts.length <= 64);
});

Deno.test("cap:fetch policy (v6ej): DNS-rebinding residual is formally registered in RISK-REGISTER and THREAT_MODEL", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const riskRegister = await Deno.readTextFile(join(root, "docs/RISK-REGISTER.md"));
  const r23 = riskRegister.split("### R23")[1]?.split("\n### ")[0];
  assert(r23 !== undefined, "RISK-REGISTER.md must define entry R23 for DNS-rebinding residual");
  assert(r23.includes("- **Risk:**"), "R23 must contain - **Risk:**");
  assert(r23.includes("- **Lives at:**"), "R23 must contain - **Lives at:**");
  assert(r23.includes("- **Mitigation:**"), "R23 must contain - **Mitigation:**");
  assert(r23.includes("- **Open question:**"), "R23 must contain - **Open question:**");
  assert(r23.includes("ADJUDICATED AND WITHHELD"), "R23 must be marked ADJUDICATED AND WITHHELD");
  assert(r23.includes("chrome-agent-platform-coord"), "R23 must name accepting decider");
  assert(r23.includes("REOPEN TRIGGER"), "R23 must specify reopen trigger");
  assert(r23.includes("extension/lib/fetch-policy.js:21"), "R23 must cite fetch-policy.js:21");
  assert(r23.includes("extension/lib/python-network.js:183"), "R23 must cite python-network.js:183");
  assert(r23.includes("extension/background/routes/enclave-proxy.js:348"), "R23 must cite enclave-proxy.js:348");
  assert(r23.includes("v6ej"), "R23 must cite bead v6ej");
  assert(r23.includes("TM-104"), "R23 must cite software factory TM-104 finding");

  const fetchPolicy = await Deno.readTextFile(join(root, "extension/lib/fetch-policy.js"));
  assert(fetchPolicy.includes("R23"), "fetch-policy.js must cite RISK-REGISTER.md R23 in header comment");

  const threatModel = await Deno.readTextFile(join(root, "THREAT_MODEL.md"));
  assert(threatModel.includes("Brokered fetch DNS rebinding (TM-104 / v6ej)"), "THREAT_MODEL.md must document DNS rebinding exclusion in §7");
  assert(threatModel.includes("chrome-agent-platform-coord"), "THREAT_MODEL.md §7 item 9 must name accepting decider");
  assert(threatModel.includes("**Register:** R23"), "THREAT_MODEL.md T6 must cross-reference register R23");
});

Deno.test("cap:fetch untrusted tagging (INV-7): returns tagUntrusted and production runFetch forces untrusted marker", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const swSrc = await Deno.readTextFile(join(root, "extension/background/service-worker.js"));

  // 1. Verify service-worker.js cap:fetch route wraps return in tagUntrusted
  // (hvd4s: the 1 MB bound is now on the READ itself — streamed and cancelled
  // at the ceiling — so the return carries the already-bounded text.
  // 7t2zv: the echoed url passes the shared origin+path normaliser, so the
  // INV-7 fence and the lrhyl echo-strip now both hold at this broker.)
  assert(
    swSrc.includes("return tagUntrusted({ ok: true, status: res.status, url: urlWithoutQuery(res.url), text })"),
    "service-worker.js cap:fetch route must return tagUntrusted({ ok: true, ... }) with the stripped url echo",
  );

  // 2. Real production runFetch through chrome.runtime:
  // Even if a buggy or malicious SW response lacks `untrusted: true`, production runFetch
  // forces tagUntrusted(...) before returning to the sandbox environment.
  const { runFetch } = await import("../extension/lib/script-host.js");
  const originalChrome = (globalThis as any).chrome;
  try {
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: async (msg: any) => {
          // Simulate untagged SW response
          return { ok: true, status: 200, url: msg.url, text: "FETCHED_WEB_DATA" };
        },
      },
    };
    const res = await runFetch({ url: "https://example.com/api", opts: {} }, "test-run");
    assertEquals(res.ok, true);
    assertEquals(res.text, "FETCHED_WEB_DATA");
    assertEquals(res.untrusted, true, "production runFetch must guarantee untrusted: true on SW response (INV-7)");
  } finally {
    if (originalChrome === undefined) delete (globalThis as any).chrome;
    else (globalThis as any).chrome = originalChrome;
  }

  // 3. Direct fetch fallback in runFetch also returns untrusted: true
  const originalFetch = globalThis.fetch;
  try {
    delete (globalThis as any).chrome;
    globalThis.fetch = async () => new Response("DIRECT_FETCH_DATA", { status: 200 });
    const directRes = await runFetch({ url: "https://example.com/direct", opts: {} });
    assertEquals(directRes.ok, true);
    assertEquals(directRes.text, "DIRECT_FETCH_DATA");
    assertEquals(directRes.untrusted, true, "direct fetch fallback must guarantee untrusted: true (INV-7)");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome !== undefined) (globalThis as any).chrome = originalChrome;
  }
});


// --- 7t2zv: the script-side brokers fold in the lrhyl r6 contract ---
//
// Filed as a SIBLING of lrhyl (one branch per bead), not folded into it: the
// lrhyl fix stripped the PYTHON broker's model-readable echoes; cap:fetch and
// script-host's runFetch had the identical shape. The r6 pattern folds in:
// fixed error codes + static hints (never interpolated method, protocol,
// host or exception text) and origin+path-only URL echoes at every
// model-readable return. Dispatch keeps the full URL. The urlWithoutQuery
// normaliser is promoted to a shared module (lib/url-echo.js) rather than
// importing the whole python ledger into the offscreen bundle; python-network
// re-exports it so every existing consumer and citation keeps working.

Deno.test("7t2zv: checkFetchPolicy refusals carry fixed errorCodes alongside their text", () => {
  assertEquals(checkFetchPolicy("https://example.com/", null).errorCode, "no_active_run");
  const off = checkFetchPolicy("https://example.com/", { hosts: ["other.example"], dynamic: false });
  assertEquals(off.errorCode, "host_not_approved");
  // the target-level codes pass through the composed policy check
  assertEquals(checkFetchPolicy("http://127.0.0.1/", { hosts: ["127.0.0.1"], dynamic: true }).errorCode, "forbidden_host");
  assertEquals(checkFetchPolicy("javascript:alert(1)", { hosts: [], dynamic: false }).errorCode, "invalid_url");
});

Deno.test("7t2zv: runFetch validator and method refusals are codes, not interpolated text", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const proto = await runFetch({ url: "ftp://example.com/x" }, "run-7t2zv");
  assertEquals(proto.error, "invalid_url");
  assertEquals(proto.hint, "protocol not allowed (http/https only)");
  assert(!JSON.stringify(proto).includes("ftp:"), "the parser-derived protocol is never echoed back");
  const creds = await runFetch({ url: "https://user:pass@example.com/" }, "run-7t2zv");
  assertEquals(creds.error, "invalid_url");
  assertEquals(creds.hint, "URLs with credentials are not allowed");
  const bad = await runFetch({ url: "not a url" }, "run-7t2zv");
  assertEquals(bad.error, "invalid_url");
  const meth = await runFetch({ url: "https://example.com/x", opts: { method: "POST" } }, "run-7t2zv");
  assertEquals(meth.error, "method_not_allowed");
  assert(!JSON.stringify(meth).includes("POST"), "the model-controlled method is never echoed back");
});

Deno.test("7t2zv: the direct-fallback echo is stripped - a ?key= credential never rides result.url", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const origChrome = globalThis.chrome;
  const origFetch = globalThis.fetch;
  try {
    delete globalThis.chrome;
    globalThis.fetch = async () => {
      const r = new Response("body", { status: 200 });
      Object.defineProperty(r, "url", { value: "https://example.com/p?key=SECRET7T2ZV" });
      return r;
    };
    const res = await runFetch({ url: "https://example.com/p?key=SENT" }, null);
    assertEquals(res.ok, true);
    assertEquals(res.url, "https://example.com/p", "the echoed url is origin+path only");
    assert(!JSON.stringify(res).includes("SECRET7T2ZV"), "the resolved response url's query never reaches the script-visible result");
  } finally {
    globalThis.chrome = origChrome;
    globalThis.fetch = origFetch;
  }
});

Deno.test("7t2zv SW source pin: cap:fetch returns codes + static hints and echoes origin+path only", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("return tagUntrusted({ ok: true, status: res.status, url: urlWithoutQuery(res.url), text })"), "the success echo is stripped at the broker");
  assert(!sw.includes("url: res.url, text })"), "the bare response-URL echo is gone");
  assert(sw.includes("error: verdict.errorCode, hint: SCRIPT_FETCH_ERROR_HINTS[verdict.errorCode]"), "policy refusals are codes + static hints");
  assert(sw.includes('error: "redirect_refused", hint: SCRIPT_FETCH_ERROR_HINTS.redirect_refused'), "the redirect refusal is a code");
  assert(sw.includes('error: "host_permission_missing", hint: SCRIPT_FETCH_ERROR_HINTS.host_permission_missing'), "the host-permission refusal is a code");
  assert(!sw.includes("`method ${m} is not allowed"), "the method refusal no longer interpolates the model's method");
  assert(!sw.includes("error: `fetch failed: ${e?.message ?? e}`"), "the cap:fetch catch no longer echoes exception text");
  assert(!sw.includes("network access to ${u.host} is not granted"), "the host-permission refusal no longer interpolates the host");
});

// 7t2zv r2 — RUNTIME falsifier on the REAL SW broker path (the merger's bar;
// the cac6c-r4 lesson: a source-shape pin standing in for an observed
// emission). The "cap:fetch" handler body is extracted from service-worker.js
// (marker-based, never line-based), compiled with ONLY its real imports
// (checkFetchPolicy, readResponseTextBounded, tagUntrusted, urlWithoutQuery)
// and stubs for the four ambient edges (chrome.permissions, fetch, the run
// policy map, swLog), then driven through refusals and success so the
// OBSERVED emissions — not the source text — are what assert the contract:
// fixed codes + static hints on every refusal, and a stripped echo.
Deno.test("7t2zv SW broker runtime: refusals are fixed codes + static hints, the echo is origin+path only", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const sig = 'async "cap:fetch"({ url, method = "GET", runId }) {';
  const at = sw.indexOf(sig);
  assert(at > 0, "the cap:fetch handler signature must exist (unique route-map entry)");
  const bodyStart = at + sig.length - 1; // index of the handler's opening '{'
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < sw.length; i++) {
    if (sw[i] === "{") depth++;
    else if (sw[i] === "}") { depth--; if (depth === 0) { bodyEnd = i; break; } }
  }
  assert(bodyEnd > bodyStart, "the cap:fetch handler body must close");
  const body = sw.slice(bodyStart + 1, bodyEnd);
  const { readResponseTextBounded } = await import("../extension/lib/fetch-body-bound.js");
  const { tagUntrusted } = await import("../extension/lib/untrusted-fence.js");
  const { urlWithoutQuery } = await import("../extension/lib/url-echo.js");
  const factory = new Function(
    "checkFetchPolicy",
    "scriptRunPolicies",
    "chrome",
    "fetch",
    "readResponseTextBounded",
    "tagUntrusted",
    "urlWithoutQuery",
    "swLog",
    'return async function capFetchProbe({ url, method = "GET", runId }) {\n' + body + "\n};",
  );
  const policies = new Map([["run-7t2zv", { hosts: ["example.com"], dynamic: false, at: Date.now() }]]);
  const chromeStub = { permissions: { contains: async () => true } };
  const makeDispatch = (fetchImpl) =>
    factory(checkFetchPolicy, policies, chromeStub, fetchImpl, readResponseTextBounded, tagUntrusted, urlWithoutQuery, { error: () => {} });
  const dispatch = makeDispatch(null); // refusals below never reach fetch

  // (1) The method refusal emits a FIXED CODE, and the caller's method value
  // never rides the reply.
  const methodRes = await dispatch({ url: "https://example.com/", method: "POST", runId: "run-7t2zv" });
  assertEquals(methodRes.ok, false);
  assertEquals(methodRes.error, "method_not_allowed");
  assert(typeof methodRes.hint === "string" && methodRes.hint.length > 0, "a static hint accompanies the code");
  assert(!JSON.stringify(methodRes).includes("POST"), "the reply must not echo the caller's method");

  // (2) An unapproved host is refused with a code, and the caller's URL/host
  // (and any credential in it) appears NOWHERE in the refusal.
  const offRes = await dispatch({ url: "https://secret-host7t2zv.example/?token=SECRET7T2ZV", method: "GET", runId: "run-7t2zv" });
  assertEquals(offRes.ok, false);
  assert(/^[a-z_]+$/.test(offRes.error), `the refusal error is a fixed code, got ${JSON.stringify(offRes.error)}`);
  assert(typeof offRes.hint === "string" && offRes.hint.length > 0, "a static hint accompanies the policy refusal");
  assert(!JSON.stringify(offRes).includes("secret-host7t2zv"), "the refusal must not echo the refused host");
  assert(!JSON.stringify(offRes).includes("SECRET7T2ZV"), "the refusal must not echo the URL's query");

  // (3) A redirect response is refused with redirect_refused — the redirect
  // target never reaches the model.
  const redirectRes = await makeDispatch(async () => ({ status: 302, type: "opaqueredirect" }))({
    url: "https://example.com/", method: "GET", runId: "run-7t2zv",
  });
  assertEquals(redirectRes.ok, false);
  assertEquals(redirectRes.error, "redirect_refused");
  assert(typeof redirectRes.hint === "string" && redirectRes.hint.length > 0);

  // (4) The success path: the model-readable echo is ORIGIN+PATH only — a
  // credential in the resolved response URL's query is stripped before any
  // script sees it — and the result carries the real untrusted marker.
  const successRes = await makeDispatch(async () => ({
    status: 200, type: "basic", url: "https://example.com/p?key=SECRET7T2ZV", body: new Response("hi").body,
  }))({ url: "https://example.com/p", method: "GET", runId: "run-7t2zv" });
  assertEquals(successRes.ok, true);
  assertEquals(successRes.untrusted, true, "the real tagUntrusted wraps the success");
  assertEquals(successRes.url, "https://example.com/p", "the echoed url is origin+path only");
  assert(!JSON.stringify(successRes).includes("SECRET7T2ZV"), "the resolved response url's query never reaches the result");
});

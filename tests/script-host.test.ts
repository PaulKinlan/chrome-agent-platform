// Unit test for the script-host claim protocol (the GLM H1 fix).
// The SW's runScriptSandboxed announces a runId first; the hosts claim it (the
// FIRST claim wins via the SW's sendMessage), then the SW sends the source
// addressed to the winning host ONLY. This test proves a host drops a run
// addressed to a DIFFERENT host (no double-execution) and claims the announce.
// @ts-nocheck — the handler's sendResponse is intentionally loose here.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleScriptRunMessage } from "../extension/lib/script-host.js";

Deno.test("script host: announce responds with a claim + the host id", () => {
  let response = null;
  const ret = handleScriptRunMessage(
    { type: "cap:script-run-announce", runId: "run_abcdefgh" },
    (r) => { response = r; },
    { createElement: () => ({}) },
    "offscreen",
  );
  assertEquals(ret, false, "the announce is answered synchronously");
  assertEquals(response?.claimed, true);
  assertEquals(response?.host, "offscreen");
  assertEquals(response?.runId, "run_abcdefgh");
});

Deno.test("script host: a run addressed to ANOTHER host is dropped (no double execution)", () => {
  let response = null;
  const ret = handleScriptRunMessage(
    { type: "cap:script-run", source: "return 1;", runId: "run_abcdefgh", for: "ntp" },
    (r) => { response = r; },
    { createElement: () => ({}) },
    "offscreen",
  );
  assertEquals(ret, false, "the offscreen host must NOT handle a run for the ntp host");
  assertEquals(response, null, "no response is sent for a foreign-host run");
});

Deno.test("script host: a run addressed to THIS host is accepted (not dropped)", () => {
  let response = null;
  // The handler accepts a matching host (returns true) then attempts the sandbox
  // run (which needs a real document). Without a document it throws, but the
  // ROUTING decision — accept, not drop — is what matters. Catch the throw.
  let threw = false;
  let ret;
  try {
    ret = handleScriptRunMessage(
      { type: "cap:script-run", source: "return 1;", runId: "run_abcdefgh", for: "offscreen" },
      (r) => { response = r; },
      { createElement: () => ({}) },
      "offscreen",
    );
  } catch {
    threw = true;
  }
  // Either it returned true (accepted + held for the async run) or it threw on
  // the sandbox bootstrap — but it must NOT have returned false (dropped).
  assertEquals(ret !== false || threw, true, "a matching-host run is accepted, not dropped");
});

Deno.test("script host: handleScriptRunMessage accepts modules array and dispatches", () => {
  let ret = handleScriptRunMessage(
    {
      type: "cap:script-run",
      source: "return 1;",
      runId: "run_abcdefgh",
      for: "offscreen",
      modules: [{ name: "my-math", digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", source: "" }],
    },
    (_r) => {},
    { createElement: () => ({ style: {}, setAttribute: () => {}, addEventListener: () => {} }), body: { appendChild: () => {} } },
    "offscreen",
  );
  assertEquals(ret, true, "host accepts run with modules");
});

Deno.test("script host: handleScriptRunMessage fails closed on invalid module name", async () => {
  let response = null;
  const ret = handleScriptRunMessage(
    {
      type: "cap:script-run",
      source: "return 1;",
      runId: "run_abcdefgh",
      for: "offscreen",
      modules: [{ name: "../escape", digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", source: "" }],
    },
    (r) => { response = r; },
    { createElement: () => ({ style: {}, setAttribute: () => {}, addEventListener: () => {} }), body: { appendChild: () => {} } },
    "offscreen",
  );
  assertEquals(ret, true);
  // Wait for async resolution
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(response?.ok, false);
  assertEquals(response?.error?.includes("Invalid module name"), true);
});

Deno.test("script host te1pu: runFetch refuses direct fetch fallback on registered run when chrome.runtime is absent", async () => {
  const { runFetch } = await import("../extension/lib/script-host.js");
  const origChrome = globalThis.chrome;
  const origFetch = globalThis.fetch;
  let fetchCalled = false;
  try {
    delete globalThis.chrome;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };

    // 1. With runId and chrome absent: fails closed, never calls direct fetch
    const runRes = await runFetch({ url: "https://example.com/api" }, "registered-run-123");
    assertEquals(runRes.ok, false);
    assertEquals(runRes.error, "fetch failed: brokered service worker route unavailable for run");
    assertEquals(fetchCalled, false, "direct fetch must NOT be invoked on a run-scoped path");

    // 2. Unscoped call (runId == null) preserves the test fallback
    const unscopedRes = await runFetch({ url: "https://example.com/api" }, null);
    assertEquals(unscopedRes.ok, true);
    assertEquals(fetchCalled, true, "direct fetch allowed in unscoped test context");

    // 3. Passing extra arguments or allowDirect must not bypass the runId guard (oe4nz)
    fetchCalled = false;
    const bypassAttempt = await runFetch({ url: "https://example.com/api" }, "registered-run-123", { allowDirect: true });
    assertEquals(bypassAttempt.ok, false);
    assertEquals(bypassAttempt.error, "fetch failed: brokered service worker route unavailable for run");
    assertEquals(fetchCalled, false, "run-scoped call must never direct-fetch even if allowDirect was passed");
  } finally {
    globalThis.chrome = origChrome;
    globalThis.fetch = origFetch;
  }
});



Deno.test("script host ibdr4: the unscoped direct-fetch fallback refuses private/loopback/metadata destinations BEFORE issuing", async () => {
  // The fallback is the ONE site INV-5 sanctions outside the broker (te1pu/oe4nz preconditions).
  // Pre-fix it applied no destination predicate at all, so the sanctioned site could target
  // http://127.0.0.1:*, http://169.254.169.254/ or any intranet host and the request WAS issued
  // (nightly run-20261107; the store booked the row fixed without a fix). The deny list is the
  // shared one — fetch-policy.js#isPrivateOrLoopbackHost, the same predicate every broker pays.
  // MUTANT: delete the isPrivateOrLoopbackHost refusal in runFetch's DIRECT-FALLBACK branch and
  // this pin REDs — the loopback/metadata calls return ok:true with the recording fetch invoked.
  // (sab0g: the predicate lives on the fallback branch, NOT in validateUrl; validateUrl gates
  // both routes, so refusing there short-circuited the BROKERED route's own refusal vocabulary
  // — see the sab0g pin below.)
  const { runFetch } = await import("../extension/lib/script-host.js");
  const origChrome = globalThis.chrome;
  const origFetch = globalThis.fetch;
  let fetchCalled = false;
  try {
    delete globalThis.chrome;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("ok", { status: 200 });
    };

    for (const url of [
      "http://127.0.0.1:9/",
      "http://169.254.169.254/latest/meta-data/",
      "http://192.168.1.1/admin",
      "http://10.0.0.5/internal",
      "http://localhost:8080/x",
    ]) {
      fetchCalled = false;
      const res = await runFetch({ url }, null);
      assertEquals(res.ok, false, `${url} must be refused`);
      assertEquals(res.error, "private_host_refused");
      assertEquals(res.hint, "private, loopback and link-local destinations are not allowed");
      assertEquals(fetchCalled, false, `no request may be ISSUED to ${url}`);
    }

    // An ordinary public URL still passes the unscoped fallback (te1pu precondition 2 unchanged).
    const pub = await runFetch({ url: "https://example.com/api" }, null);
    assertEquals(pub.ok, true);
    assertEquals(fetchCalled, true, "public destinations keep working in unscoped contexts");

    // The nv5lt run-scoped guard behaviour is unchanged: a registered run still fails closed
    // before any fetch, private or public.
    fetchCalled = false;
    const scoped = await runFetch({ url: "https://example.com/api" }, "registered-run-123");
    assertEquals(scoped.ok, false);
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.chrome = origChrome;
    globalThis.fetch = origFetch;
  }
});

Deno.test("script host sab0g: the BROKERED route keeps the service worker as the private-address authority", async () => {
  // The sandbox-egress journey (tests/sandbox-egress-confinement.test.ts) proves the sandbox's
  // fetch refusal ARRIVES FROM the host-bridge round-trip by pinning the code the service worker
  // returns: `forbidden_host` (cap:fetch -> checkFetchPolicy -> checkFetchTarget, the vocabulary
  // tests/cap-fetch-deny.test.ts:180 pins too). ibdr4's fallback predicate first landed in
  // validateUrl, which gates BOTH routes, so the brokered route was pre-refused as
  // `private_host_refused` and never reached the broker — a contract divergence the sandbox
  // journey caught as MAIN RED (chrome-agent-platform-sab0g).
  // MUTANT: move the isPrivateOrLoopbackHost check back into validateUrl and this pin REDs — the
  // broker never sees the URL, so the surfaced code is `private_host_refused`, not the broker's.
  const { runFetch } = await import("../extension/lib/script-host.js");
  const origChrome = globalThis.chrome;
  const origFetch = globalThis.fetch;
  const brokerCalls = [];
  let fetchedDirectly = false;
  try {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          brokerCalls.push(msg);
          // What the real cap:fetch handler answers for a loopback target (service-worker.js:
          // SCRIPT_FETCH_ERROR_HINTS.forbidden_host), i.e. the broker's own refusal.
          return { ok: false, error: "forbidden_host", hint: "That host is private, loopback or link-local; script fetches may only reach public approved hosts." };
        },
      },
    };
    globalThis.fetch = async () => {
      fetchedDirectly = true;
      return new Response("ok", { status: 200 });
    };

    const res = await runFetch({ url: "http://127.0.0.1:9/secret" }, "run-sab0g");
    assertEquals(brokerCalls.length, 1, "the brokered route must DISPATCH to the service worker broker");
    assertEquals(brokerCalls[0].type, "cap:fetch");
    assertEquals(brokerCalls[0].url, "http://127.0.0.1:9/secret");
    assertEquals(brokerCalls[0].runId, "run-sab0g");
    assertEquals(res.ok, false);
    assertEquals(res.error, "forbidden_host", "the service worker's code contract is what surfaces, not a host-side one");
    assertEquals(fetchedDirectly, false, "the host must never fetch on its own for a brokered, run-scoped call");
  } finally {
    globalThis.chrome = origChrome;
    globalThis.fetch = origFetch;
  }
});

Deno.test("script host z7i3m: the unscoped fallback REFUSES redirects instead of following them into a refused destination", async () => {
  // The fallback is the one sanctioned direct-fetch site (INV-5). It refuses private/loopback
  // destinations as WRITTEN (ibdr4), so a public origin that 30x-redirects to 127.0.0.1 /
  // 169.254.169.254 was the residual: plain fetch followed the hop and ISSUED it from the user's
  // network position. The brokered route refuses 30x (service-worker.js cap:fetch uses
  // redirect:'manual'), so one path refused redirects and the weaker one followed them.
  // MUTANTS, both measured: (a) drop the redirect refusal -> the pin REDs on the returned code;
  // (b) drop redirect:'manual' from the fetch init -> the pin REDs on the init assertion.
  const { runFetch } = await import("../extension/lib/script-host.js");

  // 1. LIVE SERVER, no stub: prove that redirect:'manual' really does NOT issue the hop.
  //    (/target arrival count is the authority; the response event is secondary.)
  let targetArrivals = 0;
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === "/go") {
      return new Response(null, { status: 302, headers: { location: "/target" } });
    }
    targetArrivals += 1;
    return new Response("target-ok");
  });
  const origFetch = globalThis.fetch;
  let liveType = "";
  let liveStatus = 0;
  try {
    const live = await origFetch(`http://127.0.0.1:${server.addr.port}/go`, { redirect: "manual" });
    liveStatus = live.status;
    liveType = live.type;
    // Give a followed hop a chance to land before asserting absence.
    await new Promise((r) => setTimeout(r, 250));
    assertEquals(liveStatus, 302, "redirect:'manual' must surface the 30x itself");
    assert(liveType !== "opaqueredirect" || liveStatus === 0, "manual mode returns the 30x (Deno/node) or an opaque redirect (browser)");
    assertEquals(targetArrivals, 0, "manual mode must not ISSUE the redirect hop");
  } finally {
    await server.shutdown();
  }

  // 2. runFetch-level: the policy — a 3xx is a REFUSAL with a fixed code, the hop is never
  //    issued, and the request asks for manual mode in the first place.
  const origChrome = globalThis.chrome;
  const initSeen = [];
  let transportCalls = 0;
  try {
    delete globalThis.chrome; // the INV-5 fallback precondition: no runtime at all
    globalThis.fetch = async (url, init) => {
      transportCalls += 1;
      initSeen.push({ url, init });
      // A real 30x response shape, as the live server produced above.
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/secret" } });
    };

    const res = await runFetch({ url: "https://public.example/hop" }, null);
    assertEquals(transportCalls, 1, "the fallback must issue exactly one request: it never chases the hop");
    assertEquals(initSeen[0].init.redirect, "manual", "the fallback must not ask fetch to follow redirects");
    assertEquals(res.ok, false, "a 30x is a refusal, not a body to read");
    assertEquals(res.error, "redirect_refused", "the broker's code vocabulary, so both paths answer the same way");
    assert(!JSON.stringify(res).includes("127.0.0.1"), "the redirect target is never echoed into a model-readable return");
  } finally {
    globalThis.chrome = origChrome;
    globalThis.fetch = origFetch;
  }
});

// Unit test for the script-host claim protocol (the GLM H1 fix).
// The SW's runScriptSandboxed announces a runId first; the hosts claim it (the
// FIRST claim wins via the SW's sendMessage), then the SW sends the source
// addressed to the winning host ONLY. This test proves a host drops a run
// addressed to a DIFFERENT host (no double-execution) and claims the announce.
// @ts-nocheck — the handler's sendResponse is intentionally loose here.

import { assertEquals } from "jsr:@std/assert@1";
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

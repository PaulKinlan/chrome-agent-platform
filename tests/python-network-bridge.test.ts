// The Python network BRIDGE (bead chrome-agent-platform-4p7j.2, stage S0.5):
// the plumbing that carries `await cap.fetch(url)` from inside the Pyodide
// worker out to the service worker — the only network actor — and carries the
// answer, and the RECORD, back.
//
// The policy itself is tested in tests/python-network.test.ts; the end-to-end
// behaviour in a real loaded extension is scripts/kat-python-permissioned-fetch.ts.
// What is asserted here is the part that is easy to get quietly wrong: that the
// relay answers every call (a coroutine awaiting forever is a 30-second hang
// with no explanation), that the record survives a FAILED run, and that the
// service worker route keeps its confused-deputy defaults.
// @ts-nocheck
import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { registerPythonHost } from "../extension/lib/python-host.js";
import { createPythonRuntimeProvider } from "../extension/lib/python-runtime.js";
import { createPythonNetworkLedger, urlWithoutQuery, marshalModelReadable, sanitizeRequestHeaders } from "../extension/lib/python-network.js";
import { runPython } from "../extension/lib/python-execution.js";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function stripJsComments(src) {
  return src.replace(
    /("(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, quoted) => (quoted ? quoted : match.replace(/[^\n]/g, " ")),
  );
}

function extractRuntimeBody(uncommentedSrc) {
  const decl = /(?:async\s+)?function\s+runtime\s*\([^)]*\)\s*\{/.exec(uncommentedSrc);
  assert(decl !== null, "runtime() function declaration missing in python-worker.js");
  const openBrace = decl.index + decl[0].length - 1;
  let depth = 0;
  let quote = "";
  for (let i = openBrace; i < uncommentedSrc.length; i++) {
    const ch = uncommentedSrc[i];
    if (quote) {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return uncommentedSrc.slice(openBrace + 1, i);
    }
  }
  throw new Error("unclosed runtime() body in python-worker.js");
}

function stmtOffset(body, pattern) {
  const m = pattern.exec(body);
  return m ? m.index : -1;
}

export function assertRuntimeInitOrder(workerSrc) {
  const uncommented = stripJsComments(workerSrc);
  const runtimeBody = extractRuntimeBody(uncommented);

  const stripNetwork = stmtOffset(runtimeBody, /^\s*stripAmbientNetwork\(\);\s*$/m);
  const stripStorage = stmtOffset(runtimeBody, /^\s*stripAmbientStorage\(\);\s*$/m);
  const register = stmtOffset(runtimeBody, /^\s*pyodide\.registerJsModule\(\s*["_']_cap_net["_'][^\n]*;\s*$/m);
  const install = stmtOffset(runtimeBody, /^\s*installCapModule\(pyodide\);\s*$/m);

  assert(stripNetwork > 0, "the S0 network strip call moved or vanished");
  assert(stripStorage > 0, "the S0.3 storage strip call moved or vanished");
  assert(register > stripNetwork, "the bridge must be installed after the network strip, never before");
  assert(register > stripStorage, "the bridge must be installed after the storage strip too");
  assert(install > stripNetwork, "cap must be installed after the network strip");
  assert(install > stripStorage, "cap must be installed after the storage strip");
  assert(install > register, "cap is installed after its bridge exists");
}

// A fake worker that plays the part of the Pyodide worker: it asks for one
// fetch, then reports its run.
function fetchingWorkerClass(ask, { thenFail = false } = {}) {
  return class FakeWorker {
    constructor(url) { this.url = url; }
    postMessage(message) {
      if (message.type === "python.run") {
        this.runId = message.runId;
        queueMicrotask(() => this.onmessage({ data: { runId: message.runId, type: "python.fetch", callId: "c1", ...ask } }));
        return;
      }
      if (message.type === "python.fetch.result") {
        this.answer = message.result;
        queueMicrotask(() => this.onmessage({
          data: thenFail
            ? { runId: this.runId, ok: false, error: "Traceback: cap.NetworkRefused" }
            : { runId: this.runId, ok: true, stdout: JSON.stringify(message.result) },
        }));
      }
    }
    terminate() { this.terminated = true; }
  };
}

function hostDeps(overrides = {}) {
  return {
    getURL: (rel) => `ext://${rel}`,
    // Admission is not what this file tests: hand back bytes whose hash the
    // pins reject and stub the check out by verifying nothing... instead we
    // supply the REAL files so ensureVerified passes.
    fetchImpl: async (url) => {
      const file = String(url).split("/").pop();
      const bytes = await Deno.readFile(`${ROOT}wasm-tools/python/${file}`);
      return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    ...overrides,
  };
}

Deno.test("the host RELAYS cap.fetch to the service worker and never fetches for Python itself", async () => {
  const relayed = [];
  const host = registerPythonHost(hostDeps({
    WorkerCtor: fetchingWorkerClass({ url: "https://api.example.com/x", method: "GET", headers: { Accept: "text/plain" }, body: "" }),
    sendToServiceWorker: async (message) => {
      relayed.push(message);
      return { ok: true, status: 200, text: "hi", bytes: 2 };
    },
  }));
  const result = await host.executeRun({ runId: "run-a", code: "print(1)" });
  assertEquals(result.ok, true, result.error);
  assertEquals(relayed.length, 1);
  assertEquals(relayed[0].type, "python.fetch");
  assertEquals(relayed[0].runId, "run-a", "the record has to be filed against the run the owner is looking at");
  assertEquals(relayed[0].url, "https://api.example.com/x");
  // The answer reached the worker intact.
  assertStringIncludes(result.stdout, '"status":200');
});

Deno.test("a proxy that throws still ANSWERS the call — a hung coroutine is a 30s mystery", async () => {
  const host = registerPythonHost(hostDeps({
    WorkerCtor: fetchingWorkerClass({ url: "https://api.example.com/x", method: "GET" }),
    sendToServiceWorker: async () => { throw new Error("the service worker is gone"); },
  }));
  const result = await host.executeRun({ runId: "run-b", code: "print(1)" });
  assertEquals(result.ok, true, result.error);
  assertStringIncludes(result.stdout, '"ok":false');
  assertStringIncludes(result.stdout, "the network proxy failed");
});

Deno.test("a host with no relay refuses honestly instead of pretending the network is down", async () => {
  const host = registerPythonHost(hostDeps({
    WorkerCtor: fetchingWorkerClass({ url: "https://api.example.com/x", method: "GET" }),
    sendToServiceWorker: undefined,
  }));
  const result = await host.executeRun({ runId: "run-c", code: "print(1)" });
  assertStringIncludes(result.stdout, "the network proxy is unavailable in this host");
});

// ── the records reach the tool result, on BOTH paths ──────────────────────────

function providerWith(ledger, response) {
  return createPythonRuntimeProvider({
    ensureHost: async () => ({ ok: true }),
    networkLedger: ledger,
    sendMessage: async (message) => {
      // The proxy "made" two requests during this run: one allowed, one refused.
      ledger.record(message.runId, { method: "GET", url: "https://api.example.com/a", origin: "https://api.example.com", ok: true, status: 200, bytes: 3, ms: 7 });
      ledger.record(message.runId, { method: "GET", url: "https://evil.example/b", origin: "https://evil.example", ok: false, refused: true, error: "not granted", ms: 1 });
      return response;
    },
  }).provider;
}

Deno.test("a SUCCESSFUL run carries its network records to the tool result", async () => {
  const ledger = createPythonNetworkLedger();
  const runtime = await providerWith(ledger, { ok: true, stdout: "done\n" })();
  const result = await runPython(runtime, { code: "print('done')" });
  assertEquals(result.ok, true);
  assertEquals(result.network.length, 2);
  assertEquals(result.network[1].refused, true);
  assertEquals(ledger.size(), 0, "the run's ledger entry is taken, not left to accumulate");
});

Deno.test("a FAILED run keeps its network records — that is often the run that matters", async () => {
  const ledger = createPythonNetworkLedger();
  const runtime = await providerWith(ledger, { ok: false, error: "cap.NetworkRefused: not granted" })();
  const result = await runPython(runtime, { code: "await cap.fetch('https://evil.example/b')" });
  assertEquals(result.ok, false);
  assertEquals(result.network.length, 2, "a traceback must not swallow the requests that led to it");
  assertEquals(result.untrusted, true, "a failed run with successful fetch history carries untrusted taint");
  assertEquals(ledger.size(), 0);
});

Deno.test("a run with dropped ledger records taints output fail-closed", async () => {
  const ledger = createPythonNetworkLedger();
  const runtime = await createPythonRuntimeProvider({
    ensureHost: async () => ({ ok: true }),
    networkLedger: ledger,
    sendMessage: async (message) => {
      // Flood ledger past 500 records
      for (let i = 0; i < 501; i++) {
        ledger.record(message.runId, { method: "GET", url: `https://api.example.com/${i}`, origin: "https://api.example.com", ok: false, refused: true, error: "not granted", ms: 1 });
      }
      return { ok: true, stdout: "overflowed\n" };
    },
  }).provider();
  const result = await runPython(runtime, { code: "print('overflowed')" });
  assertEquals(result.ok, true);
  assertEquals(result.networkDropped, 1);
  assertEquals(result.untrusted, true, "dropped records must taint output fail-closed (INV-7)");
});

Deno.test("a run that asked for nothing carries no network field at all", async () => {
  const ledger = createPythonNetworkLedger();
  const runtime = await createPythonRuntimeProvider({
    ensureHost: async () => ({ ok: true }),
    networkLedger: ledger,
    sendMessage: async () => ({ ok: true, stdout: "4\n" }),
  }).provider();
  const result = await runPython(runtime, { code: "print(2+2)" });
  assertEquals(result.ok, true);
  assertEquals(result.network, undefined);
});

Deno.test("a runtime with no bridge at all (the KAT mocks) is unaffected", async () => {
  const result = await runPython({
    setStdout({ batched }) { this._out = batched; },
    setStdin() {},
    runPythonAsync: async function () { this._out("plain\n"); },
  }, { code: "print('plain')" });
  assertEquals(result.ok, true);
  assertEquals(result.stdout, "plain\n");
  assertEquals(result.network, undefined);
});

// ── the invariants that live in files too large to import here ────────────────

Deno.test("the service worker's python.fetch route keeps every confused-deputy default", async () => {
  const sw = await Deno.readTextFile(`${ROOT}extension/background/service-worker.js`);
  const start = sw.indexOf('async "python.fetch"');
  assert(start > 0, "the python.fetch route is gone");
  const route = sw.slice(start, sw.indexOf('async "python.network.grants"', start));

  // The SW holds <all_urls> AND the owner's cookies for every origin. Each of
  // these is what stops a grant for one origin becoming authenticated access to
  // the owner's logged-in session there.
  assertStringIncludes(route, 'credentials: "omit"');
  assertStringIncludes(route, 'redirect: "manual"');
  assertStringIncludes(route, "isRedirectResponse(res)");
  assertStringIncludes(route, "sanitizePythonRequestHeaders(headers)");
  assertStringIncludes(route, "checkPythonNetworkRequest(");
  // Only an extension host relays a Python request; a model principal must not
  // reach the proxy directly.
  assertStringIncludes(route, 'context?.principal !== "extension"');
  // Refusals are recorded, not just returned.
  assert(/record\(\{ ok: false/.test(route), "a refusal must leave a record");
  // Granting is an owner gesture, never something a run does for itself.
  const grant = sw.slice(sw.indexOf('async "python.network.grant"'));
  assertStringIncludes(grant.slice(0, 400), 'context?.principal !== "owner-options"');
  // In-flight abort: revocation cuts in-flight requests by origin immediately,
  // and dispatch-time begin() tracks each request per run so a run timeout
  // aborts in-flight requests and records their duration (gtc8).
  assertStringIncludes(route, "signal: controller.signal");
  assertStringIncludes(route, "pythonNetworkLedger.begin(");
  assertStringIncludes(route, "inflight.complete(");
  const revoke = sw.slice(sw.indexOf('async "python.network.revoke"'), sw.indexOf('async "capabilities.status"'));
  assertStringIncludes(revoke, "activePythonFetches.get");
  assertStringIncludes(revoke, "ctrl.abort()");
});

Deno.test("a TIMED-OUT run aborts its in-flight cap.fetch and carries the aborted record with duration (gtc8)", async () => {
  const ledger = createPythonNetworkLedger();
  const slowController = new AbortController();
  let inflightHandle = null;

  const { provider } = createPythonRuntimeProvider({
    ensureHost: async () => ({ ok: true }),
    timeoutMs: 30,
    networkLedger: ledger,
    sendMessage: (message) => new Promise((resolve) => {
      // Simulate a cap.fetch dispatched 20ms ago that stalls past the run fence.
      inflightHandle = ledger.begin(message.runId, {
        method: "POST",
        url: "https://api.example.com/slow",
        origin: "https://api.example.com",
        startedAt: Date.now() - 20,
        controller: slowController,
      });
      slowController.signal.addEventListener("abort", () => {
        // Simulate the SW fetch() catch block firing after the run settled:
        // must not overwrite the aborted record or recreate an orphaned ledger row.
        inflightHandle.complete({ ok: false, error: "late abort catch" });
        ledger.record(message.runId, {
          method: "POST",
          url: "https://api.example.com/slow",
          origin: "https://api.example.com",
          ok: false,
          ms: 999,
          error: "late record",
        });
        resolve({ ok: false, error: "python_run_timeout" });
      });
    }),
  });

  const runtime = await provider();
  const result = await runPython(runtime, { code: "await cap.fetch('https://api.example.com/slow')", timeoutMs: 30 });
  assertEquals(result.ok, false);
  assertEquals(result.error, "python_run_timeout");
  assertEquals(slowController.signal.aborted, true, "the stalled in-flight fetch is aborted when the run times out");
  assert(Array.isArray(result.network) && result.network.length === 1, "the timed-out run carries the aborted request record");
  assertEquals(result.network[0].method, "POST");
  assertEquals(result.network[0].url, "https://api.example.com/slow");
  assertEquals(result.network[0].origin, "https://api.example.com");
  assertEquals(result.network[0].ok, false);
  assertEquals(result.network[0].aborted, true);
  assertEquals(result.network[0].outcome, "aborted");
  assert(typeof result.network[0].ms === "number" && result.network[0].ms >= 20, `expected duration >= 20ms, got ${result.network[0].ms}`);
  assertEquals(ledger.size(), 0, "the ledger holds no orphaned row for the timed-out run afterwards");
});

Deno.test("all three texts disclose that POST requests send the extension's Origin header while cookies and logins are never sent (2h4f)", async () => {
  const worker = await Deno.readTextFile(`${ROOT}wasm-tools/python/python-worker.js`);
  const optionsHtml = await Deno.readTextFile(`${ROOT}extension/options/options.html`);
  const { buildPrivacyStatement } = await import("../extension/lib/privacy-statement.js");

  // 1. cap.py docstring in wasm-tools/python/python-worker.js
  assert(!worker.includes("Requests are ANONYMOUS"), "cap.py docstring must not claim requests are anonymous when POST sends Origin");
  assertStringIncludes(worker, "Requests carry NO CREDENTIALS");
  assertStringIncludes(worker, "Origin (chrome-extension://<id>)");

  // 2. Settings → Permissions → Python network access help copy
  assertStringIncludes(optionsHtml, "without your cookies or logins (POST requests still send this extension's Origin header)");

  // 3. Privacy statement python-fetch row
  const statement = buildPrivacyStatement();
  const pythonRow = statement.sent.find((row) => row.id === "python-fetch");
  assert(pythonRow !== undefined, "privacy statement must include python-fetch row");
  assertStringIncludes(pythonRow.text, "sends no cookies or logins (POST requests still send this extension's Origin header)");
});

Deno.test("the worker hands back the granted reach only AFTER the ambient reach is gone", async () => {
  const worker = await Deno.readTextFile(`${ROOT}wasm-tools/python/python-worker.js`);
  // 4p7j.3 (landed after this pin was written) adds the STORAGE strip between the
  // network strip and the bridge, and o8ul anchors the pin on comment-stripped
  // statement lines inside runtime()'s body so an earlier comment cannot satisfy it.
  assertRuntimeInitOrder(worker);

  // Falsification (chrome-agent-platform-o8ul):
  // Mutant A: moving stripAmbientStorage(); below installCapModule(pyodide); in runtime() fails.
  const mutantA = worker
    .replace(/^\s*stripAmbientStorage\(\);\s*\n/m, "")
    .replace(
      /^(\s*installCapModule\(pyodide\);)/m,
      "$1\n      stripAmbientStorage();",
    );
  assert(mutantA !== worker, "mutantA must alter the worker source");
  assertThrows(
    () => assertRuntimeInitOrder(mutantA),
    Error,
    "the bridge must be installed after the storage strip too",
  );

  // Mutant B: Mutant A PLUS line and block comments naming stripAmbientStorage();
  // at the top of the file and at the top of runtime() still fails.
  const mutantB =
    "// stripAmbientStorage();\n/* stripAmbientStorage(); */\n" +
    mutantA.replace(
      /(function\s+runtime\s*\(\)\s*\{)/,
      "$1\n  // stripAmbientStorage();\n  /* stripAmbientStorage(); */",
    );
  assertThrows(
    () => assertRuntimeInitOrder(mutantB),
    Error,
    "the bridge must be installed after the storage strip too",
  );

  // The worker decides nothing: no allow-list, no credential policy, no log.
  assert(!/credentials\s*:/.test(worker), "the worker must not hold a credential policy");
  assert(!/allowlist|allowList/i.test(worker), "the allow-list lives in the service worker, not here");
});


// --- lrhyl: a query string must never reach a model-readable surface ------------
//
// python.fetch echoed the FULL request URL (res.url || u.href) in its
// tagUntrusted response, and the ledger's dispatch/error records stored the
// raw url — both flow to the model (the cap.fetch return value; the run
// envelope's network field). A credential in a query string (the '?key='
// pattern) therefore escaped the enclave. The fix strips at the two ledger
// write choke points (begin/record) and at the response echo; the REQUEST
// still fetches the full URL — stripping is for echoes, never dispatch.
// Secret-safe discipline: the placeholder below is a synthetic marker, not
// credential material.
const SECRET_PLACEHOLDER = "LRHYL-SYNTHETIC-PLACEHOLDER-DO-NOT-ECHO";

Deno.test("lrhyl: urlWithoutQuery keeps origin+path, drops search and hash, fails closed on garbage", () => {
  assertEquals(urlWithoutQuery(`https://api.example.com/v1/models?key=${SECRET_PLACEHOLDER}`), "https://api.example.com/v1/models");
  assertEquals(urlWithoutQuery("https://a.example/p/q#frag"), "https://a.example/p/q");
  assertEquals(urlWithoutQuery("https://a.example:8443/p?x=1"), "https://a.example:8443/p", "an explicit port is part of the origin and survives");
  assertEquals(urlWithoutQuery(`https://a.example/?key=${SECRET_PLACEHOLDER}`), "https://a.example/");
  assertEquals(urlWithoutQuery("not a url at all"), "", "an unparseable string yields NOTHING rather than an echo");
  assertEquals(urlWithoutQuery(undefined), "");
  assertEquals(urlWithoutQuery(null), "");
});


Deno.test("lrhyl: the ledger strips the query at BOTH write choke points, and the abort record is a fixed code", () => {
  const ledger = createPythonNetworkLedger();
  // the direct record() path (the broker's validation/error closures)
  ledger.record("run-lrhyl", { method: "GET", url: `https://api.example.com/a?token=${SECRET_PLACEHOLDER}`, origin: "https://api.example.com", ok: false, refused: true, errorCode: "not_granted", ms: 1 });
  // the begin()/complete() path (dispatch-time record)
  const inflight = ledger.begin("run-lrhyl", { method: "GET", url: `https://api.example.com/b?key=${SECRET_PLACEHOLDER}`, origin: "https://api.example.com", startedAt: Date.now(), controller: null });
  inflight.complete({ ok: true, origin: "https://api.example.com", status: 200, bytes: 3 });
  // a still-in-flight record that take() must abort — round 6: the abort is
  // the fixed code plus the duration, never an interpolated message
  ledger.begin("run-lrhyl", { method: "GET", url: `https://api.example.com/c?sig=${SECRET_PLACEHOLDER}`, origin: "https://api.example.com", startedAt: Date.now(), controller: { abort() {} } });
  const taken = ledger.take("run-lrhyl");
  assertEquals(taken.records.length, 3);
  assertEquals(taken.records[0].url, "https://api.example.com/a");
  assertEquals(taken.records[1].url, "https://api.example.com/b");
  assertEquals(taken.records[2].url, "https://api.example.com/c");
  assertEquals(taken.records[2].aborted, true);
  assertEquals(taken.records[2].errorCode, "aborted", "the abort record is the fixed code");
  assertEquals((taken.records[2] as any).error, undefined, "the interpolated abort message no longer exists");
  const serialized = JSON.stringify(taken.records);
  assert(!serialized.includes(SECRET_PLACEHOLDER), "no model-readable record may carry the query value");
  assert(!serialized.includes("token=") && !serialized.includes("key=") && !serialized.includes("sig="), "not even the query KEYS survive");
});

Deno.test("lrhyl r2: a caller-supplied finalEntry.url CANNOT override the sanitised ledger URL (construction-point fix)", () => {
  const ledger = createPythonNetworkLedger();
  const inflight = ledger.begin("run-lrhyl2", { method: "GET", url: "https://api.example.com/b", origin: "https://api.example.com", startedAt: Date.now(), controller: null });
  // The review finding: complete() built `{url: inflight.url, ...finalEntry}` -
  // the spread came LAST, so a caller supplying `url` here overrode the
  // sanitised value un-normalised. The fix sanitises AFTER the spread.
  inflight.complete({ ok: true, url: `https://api.example.com/b?key=${SECRET_PLACEHOLDER}`, status: 200 });
  const taken = ledger.take("run-lrhyl2");
  assertEquals(taken.records.length, 1);
  assertEquals(taken.records[0].url, "https://api.example.com/b", "the override is sanitised at construction, after the spread");
  assert(!JSON.stringify(taken.records).includes(SECRET_PLACEHOLDER), "the override's query value never reaches a model-readable record");
});

// --- lrhyl round 6: the contract is NARROWED, not the scrubber improved -------
//
// Five review rounds found five leak SHAPES (query echo, error text, origin
// field, userinfo/fragment in free text, greedy-prefix mis-scrub) because the
// surface was any string. Round 6 removes the surface: a model-visible ledger
// record carries NO free text at all. Failures are a fixed machine code
// (PYTHON_FETCH_ERROR_CODES) plus structured, sanitised fields; every writer
// projects onto a CLOSED field set before the marshal; and the lexical
// free-text scrubber is deleted rather than left as bait. The marshal stays —
// keys, arrays, URL normalisation, fixed tags — as the second layer under the
// closed shape.

Deno.test("lrhyl r6: caller-supplied free-text 'error' is DROPPED at both choke points - it never reaches the model in any form (coord probe: query-bearing text)", () => {
  const ledger = createPythonNetworkLedger();
  ledger.record("run-lrhyl3", { method: "GET", origin: "https://api.example.com", ok: false, errorCode: "fetch_failed", error: `fetch to https://api.example.com/p?token=${SECRET_PLACEHOLDER} failed: boom`, ms: 1 });
  const inflight = ledger.begin("run-lrhyl3", { method: "GET", url: "https://api.example.com/q", origin: "https://api.example.com", startedAt: Date.now(), controller: null });
  inflight.complete({ ok: false, errorCode: "fetch_failed", error: `fetch to https://api.example.com/q?sig=${SECRET_PLACEHOLDER} failed: network went away` });
  const taken = ledger.take("run-lrhyl3");
  for (const rec of taken.records) {
    assertEquals((rec as any).error, undefined, "'error' is not a contract field - it is dropped, not scrubbed");
  }
  const serialized = JSON.stringify(taken.records);
  assert(!serialized.includes(SECRET_PLACEHOLDER), "no record carries the query value");
  assert(!serialized.includes("boom") && !serialized.includes("network went away"), "not even scrubbed remnants of the free text survive");
});

Deno.test("lrhyl r6: the r5 greedy-prefix repro and the schemeless credential have NO PATH - free text no longer exists in records", () => {
  const ledger = createPythonNetworkLedger();
  // the exact r5 failure shape: a query that the greedy-prefix scrub missed
  ledger.record("run-lrhyl-r6g", { method: "GET", url: "https://h/p", ok: false, errorCode: "fetch_failed", error: `failed https://h/p?token=${SECRET_PLACEHOLDER}`, ms: 3 });
  // stacked delimiters that survived take()'s double marshal in r5
  ledger.record("run-lrhyl-r6g", { method: "GET", url: "https://h/p", ok: false, errorCode: "fetch_failed", error: `failed https://h/p?q=1#a#b carrying ${SECRET_PLACEHOLDER}`, ms: 3 });
  // the schemeless credential the lexical scrubber could never see
  ledger.record("run-lrhyl-r6g", { method: "GET", url: "https://h/p", ok: false, errorCode: "fetch_failed", error: `failed user:LRHYL_SECRET_9317@host/path?token=x`, ms: 3 });
  const taken = ledger.take("run-lrhyl-r6g");
  assertEquals(taken.records.length, 3);
  const serialized = JSON.stringify(taken.records);
  assert(!serialized.includes(SECRET_PLACEHOLDER) && !serialized.includes("LRHYL_SECRET_9317"), "no scrubber needed: the text is gone");
  assert(!serialized.includes("user:") && !serialized.includes("failed http") && !serialized.includes("carrying"), "not a fragment of the free text survives ('fetch_failed' the CODE is fine - it is ours)");
});

Deno.test("lrhyl r6: the free-text scrubber is DELETED, not kept as bait", async () => {
  const lib = await import("../extension/lib/python-network.js");
  assertEquals((lib as any).scrubUrlQueries, undefined, "rounds 2-5's lexical scrubber is gone from the module surface - a text scrubber over attacker-shaped input cannot be made correct, and keeping it invites free text back in");
});

Deno.test("lrhyl r6: the record shape is CLOSED - pinned per writer, so a new free-text field cannot be added silently (coord probe)", () => {
  // writer 1+4: begin()'s dispatch record, finalized by take()'s abort path
  const ledgerA = createPythonNetworkLedger();
  ledgerA.begin("run-shape-a", { method: "GET", url: "https://h/p", origin: "https://h", startedAt: Date.now(), controller: { abort() {} } });
  const recA = ledgerA.take("run-shape-a").records[0];
  assertEquals(Object.keys(recA).sort(), ["aborted", "errorCode", "method", "ms", "ok", "origin", "outcome", "url"], "the abort-finalized shape is exactly the contract");
  // writer 2: begin() + complete()
  const ledgerB = createPythonNetworkLedger();
  const iB = ledgerB.begin("run-shape-b", { method: "GET", url: "https://h/p", origin: "https://h", startedAt: Date.now(), controller: null });
  iB.complete({ ok: true, status: 200, bytes: 3, sneaky: `https://h/x?s=${SECRET_PLACEHOLDER}`, error: "free text" });
  const recB = ledgerB.take("run-shape-b").records[0];
  assertEquals(Object.keys(recB).sort(), ["bytes", "method", "ms", "ok", "origin", "status", "url"], "non-contract fields (sneaky, error) are dropped, not scrubbed");
  // writer 3: record()
  const ledgerC = createPythonNetworkLedger();
  ledgerC.record("run-shape-c", { method: "GET", url: "https://h/q", origin: "https://h", ok: false, refused: true, errorCode: "not_granted", ms: 1, label: "arbitrary", detail: { nested: "free text" } });
  const recC = ledgerC.take("run-shape-c").records[0];
  assertEquals(Object.keys(recC).sort(), ["errorCode", "method", "ms", "ok", "origin", "refused", "url"], "record()'s shape is exactly the contract");
});

Deno.test("lrhyl r6: EVERY string field is value-bounded - the schemeless credential cannot ride in through ANY of them", () => {
  const ledger = createPythonNetworkLedger();
  const evil = `user:LRHYL_SECRET_9317@host/path?token=x`;
  ledger.record("run-lrhyl-r6v", {
    method: `GET https://h?x=${SECRET_PLACEHOLDER}`,
    url: evil,
    origin: evil,
    ok: "yes please",
    status: `200 ${SECRET_PLACEHOLDER}`,
    ms: 1,
    refusedHeaders: [evil, "Cookie"],
    refusedHeaderCount: `3 ${SECRET_PLACEHOLDER}`,
    vaultKeyId: "TOKEN_SECRET_FROM_CALLER",
    outcome: `aborted ${SECRET_PLACEHOLDER}`,
    errorCode: `not_granted ${SECRET_PLACEHOLDER}`,
  });
  const rec = ledger.take("run-lrhyl-r6v").records[0];
  assertEquals(rec.method, "INVALID", "a method outside the allow-list is a fixed token");
  assertEquals(rec.url, "", "an unparseable url fails closed to empty");
  assertEquals((rec as any).origin, undefined, "an unparseable origin is dropped");
  assertEquals((rec as any).ok, undefined, "a non-boolean ok is dropped");
  assertEquals((rec as any).status, undefined, "a non-numeric status is dropped");
  assertEquals((rec as any).refusedHeaders, undefined, "round 7: the caller's header NAMES are not a record field at all");
  assertEquals((rec as any).refusedHeaderCount, undefined, "a non-numeric count is dropped");
  assertEquals((rec as any).vaultKeyId, undefined, "round 7: the caller-controlled keyId echo is not a record field");
  assertEquals((rec as any).outcome, undefined, "an outcome outside the enum is dropped");
  assertEquals(rec.errorCode, "fetch_failed", "an errorCode outside the vocabulary collapses to fetch_failed");
  const serialized = JSON.stringify(rec);
  assert(!serialized.includes("LRHYL_SECRET_9317") && !serialized.includes(SECRET_PLACEHOLDER), "no field carried the credential");
});

Deno.test("lrhyl r6: refused header NAMES are token-bounded inside the sanitizer - and since round 7 records carry only the COUNT", () => {
  const { refused, headers } = sanitizeRequestHeaders({
    [`X-Bad https://h/p?token=LRHYL_SECRET_9317`]: "1",
    Cookie: "session=x",
    "X-Ok": "keep me",
  });
  assert(refused.includes("<invalid-name>"), "a model-shaped header name is refused under the fixed marker");
  assert(refused.includes("Cookie"), "a forbidden but well-formed name is still named (it is a token)");
  assert(!JSON.stringify(refused).includes("LRHYL_SECRET_9317"), "the hostile name never enters the refused list verbatim");
  assertEquals(headers["X-Ok"], "keep me", "an allowed header travels");
});

Deno.test("lrhyl r6: the marshal still scrubs nested objects and arrays of URLs (structural property preserved, tested directly)", () => {
  const m = marshalModelReadable({
    meta: { finalUrl: `https://api.example.com/landed?sig=${SECRET_PLACEHOLDER}`, depth: { deeper: `https://x.example/d?k=${SECRET_PLACEHOLDER}` } },
    chain: [`https://a.example/1?next=${SECRET_PLACEHOLDER}`, "https://b.example/2", 7],
  });
  assertEquals(m.meta.finalUrl, "https://api.example.com/landed", "a nested object's URL field is scrubbed");
  assertEquals(m.meta.depth.deeper, "https://x.example/d", "recursively");
  assertEquals(m.chain[0], "https://a.example/1", "an array element URL is scrubbed");
  assertEquals(m.chain[1], "https://b.example/2", "a clean URL element is untouched");
  assertEquals(m.chain[2], 7, "non-string elements pass through");
  assert(!JSON.stringify(m).includes(SECRET_PLACEHOLDER));
});

Deno.test("lrhyl r6: the marshal handles URL instances, userinfo, keys, cycles and the FIXED tag vocabulary (r4/r5 properties, direct)", () => {
  // URL instance via toString
  assertEquals(marshalModelReadable(new URL(`https://api.example.com/final?key=${SECRET_PLACEHOLDER}`)), "https://api.example.com/final");
  // userinfo is a credential location too
  assertEquals(marshalModelReadable(`https://user:${SECRET_PLACEHOLDER}@h.example/p`), "https://h.example/p");
  // keys are marshalled exactly like values (r5)
  const keyed = marshalModelReadable({ [`https://h/p?token=${SECRET_PLACEHOLDER}`]: "value", clean: 1 });
  assert(Object.keys(keyed).includes("https://h/p"), "the query-bearing KEY is scrubbed");
  assertEquals(keyed["https://h/p"], "value");
  // '__proto__' as a key cannot pollute
  const polluter = {};
  Object.defineProperty(polluter, "__proto__", { value: { polluted: true }, enumerable: true });
  const marshalled = marshalModelReadable(polluter);
  assertEquals(Object.getPrototypeOf(marshalled), Object.prototype, "no prototype pollution through a marshalled key");
  // cycles and depth are tagged, not walked to death
  const circular = { name: "cyc" };
  circular.self = circular;
  const cm = marshalModelReadable(circular);
  assertEquals(cm.self, "[lrhyl-uninspectable:cycle]");
  // the tag vocabulary is FIXED - a constructor name is attacker-influenceable
  class Decoy {}
  Object.defineProperty(Decoy, "name", { value: `LRHYL_SECRET_9317` });
  const tags = marshalModelReadable({ decoy: new Decoy(), sym: Symbol("LRHYL_SECRET_9317"), map: new Map([["k", "LRHYL_SECRET_9317"]]), fn: () => 1 });
  for (const field of ["decoy", "sym", "map", "fn"]) {
    assert(/^\[lrhyl-uninspectable:[A-Za-z]+\]$/.test(tags[field]), `${field} tags from the fixed vocabulary (got ${tags[field]})`);
  }
  assert(!JSON.stringify({ ...keyed, ...cm, ...tags }).includes("LRHYL_SECRET_9317"), "no tag or key embeds the value");
  assert(!JSON.stringify(tags).includes(SECRET_PLACEHOLDER));
});

Deno.test("lrhyl r6: the marshal is idempotent and keeps honest records byte-identical", () => {
  const ledger = createPythonNetworkLedger();
  ledger.record("run-lrhyl-r4e", { method: "GET", url: "https://api.example.com/clean", origin: "https://api.example.com", ok: true, status: 200, bytes: 10, ms: 2 });
  const first = ledger.take("run-lrhyl-r4e").records[0];
  assertEquals(first.url, "https://api.example.com/clean");
  assertEquals(first.method, "GET");
  assertEquals(first.origin, "https://api.example.com");
  assertEquals(first.status, 200);
  assertEquals(first.ok, true);
  // take() re-marshals: marshalling an already-marshalled record changes nothing
  assertEquals(JSON.stringify(marshalModelReadable(first)), JSON.stringify(first), "idempotent");
});

Deno.test("lrhyl r6: every error code has a STATIC hint, and no hint interpolates", async () => {
  const lib = await import("../extension/lib/python-network.js");
  const codes = (lib as any).PYTHON_FETCH_ERROR_CODES as string[];
  const hints = (lib as any).PYTHON_FETCH_ERROR_HINTS as Record<string, string>;
  assert(Array.isArray(codes) && codes.length >= 4, "the fixed vocabulary exists");
  for (const expected of ["fetch_failed", "aborted", "timeout", "invalid_url"]) {
    assert(codes.includes(expected), `coord's four codes are in the vocabulary (missing ${expected})`);
  }
  for (const code of codes) {
    assertEquals(typeof hints[code], "string", `every code has a hint: ${code}`);
    assert(hints[code].length > 0, code);
    assert(!hints[code].includes("${"), "hints are static prose, never templates");
  }
  assert(/Settings/.test(hints.not_granted), "the not_granted hint keeps the owner-guidance the old prose had");
  assert(/cap\.fetch does GET, HEAD, POST/.test(hints.method_not_allowed), "the method hint keeps the boundary text");
});

Deno.test("lrhyl r3: the reviewer's origin repro - a caller-supplied query-bearing origin is reduced to the BARE origin at every choke point", () => {
  const ledger = createPythonNetworkLedger();
  const i1 = ledger.begin("run-lrhyl-r3", { method: "GET", url: "https://h/p", origin: `https://h/p?token=${SECRET_PLACEHOLDER}`, startedAt: Date.now(), controller: null });
  i1.complete({ ok: true, status: 200, origin: `https://h/p?token=${SECRET_PLACEHOLDER}` });
  ledger.record("run-lrhyl-r3", { method: "GET", url: "https://h/q", origin: `https://h/p?token=${SECRET_PLACEHOLDER}`, ok: false, refused: true, ms: 1 });
  const taken = ledger.take("run-lrhyl-r3");
  assertEquals(taken.records.length, 2);
  for (const rec of taken.records) {
    assertEquals(rec.origin, "https://h", "round 6: the origin field is re-parsed to scheme+host - stronger than origin+path, a caller's path cannot ride along");
  }
  const serialized = JSON.stringify(taken.records);
  assert(!serialized.includes(SECRET_PLACEHOLDER), "the reviewer's repro: no model-readable record may carry the token");
  assert(!serialized.includes("token="), "not even the query KEY survives");
});

Deno.test("lrhyl SW source pin: the python.fetch echo strips, the failure returns are CODES, and the free-text paths are gone", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  // guh95 supersedes the echo target: the stripped echo used to be built from
  // res.url || u.href, but BOTH are post-$VAULT-substitution — a secret
  // substituted into the PATH survives origin+path normalization. The echo now
  // comes from the PRE-SUBSTITUTION template url, still through the ONE
  // normaliser, still exactly once.
  assertEquals(
    sw.split("url: urlWithoutQuery(String(url ?? \"\")),").length - 1, 1,
    "the python.fetch broker's response echo must go through urlWithoutQuery exactly once, from the template url",
  );
  const withoutWrapped = sw.split("url: urlWithoutQuery(String(url ?? \"\")),").join("");
  assert(!withoutWrapped.includes("url: res.url || u.href"), "a bare, unstripped echo must not survive anywhere in the SW");
  assert(!sw.includes("urlWithoutQuery(res.url || u.href)"), "the post-substitution echo is deleted (guh95): res.url/u.href carry substituted vault secrets");
  assert(sw.includes("urlWithoutQuery,\n  PYTHON_FETCH_ERROR_HINTS,\n} from \"../lib/python-network.js\""), "the SW imports the code-hint map from the module that owns the invariant");
  assert(!sw.includes("scrubUrlQueries"), "the deleted scrubber has no surviving reference in the SW");
  assert(sw.includes("return { ok: false, error: code, origin: verdict.origin, hint: PYTHON_FETCH_ERROR_HINTS[code] ?? \"\" };"), "the exception path returns a fixed code + sanitised origin + STATIC hint, never an interpolated message");
  assert(sw.includes("error: verdict.errorCode"), "the policy refusal returns the verdict's code");
  assert(sw.includes("e?.name === \"TimeoutError\""), "the catch maps exception NAMES to codes");
  assert(sw.includes("swLog.error(`python.fetch to ${verdict.origin} failed [${code}]: ${e?.message ?? e}`)"), "the raw exception text goes to the DEBUG-ONLY sanctioned logger sink (code-health: no raw console.* outside cap-log)");
  // discriminating pins on the ledger choke points
  const lib = await Deno.readTextFile(new URL("../extension/lib/python-network.js", import.meta.url));
  assert(!lib.includes("export function scrubUrlQueries"), "the scrubber is deleted from the lib, not kept as bait");
  assert(lib.includes("const u = urlWithoutQuery(url);"), "begin() normalizes at the choke point");
  assert(lib.includes("const projected = projectRecord(entry, \"record\");"), "record() projects onto the closed shape");
  assert(lib.includes("if (projected.url !== undefined) projected.url = urlWithoutQuery(projected.url);"), "record() keeps the fail-closed url line");
  assert(lib.includes("if (merged.url !== undefined) merged.url = urlWithoutQuery(merged.url);"), "complete() sanitises AFTER the finalEntry spread (r2 override fix)");
  assertEquals(
    lib.split("marshalModelReadable(projectRecord({").length - 1, 2,
    "begin and abortInFlight construct through projectRecord+marshal",
  );
  assertEquals(
    lib.split("Object.freeze(marshalModelReadable(").length - 1, 5,
    "all FOUR writers (begin, complete, record, abortInFlight) plus the take() boundary construct through the single marshal",
  );
  assert(lib.includes("row.records.map((r) => Object.freeze(marshalModelReadable(r)))"), "take() re-marshals at the observation boundary (a fifth writer cannot bypass it)");
  assert(lib.includes("errorCode: \"aborted\""), "the abort writer's record is the fixed code");
  // round 7: the two caller-controlled TEXT fields are gone from every surface
  assert(!sw.includes("vaultKeyId"), "the caller-controlled $VAULT keyId echo is gone from the SW");
  assertEquals(sw.split("vaultKeyPresented: true").length - 1, 6, "the three vault refusals record AND return the boolean fact only");
  assert(sw.includes("refusedHeaderCount: refusedHeaders.length"), "the success echo carries the COUNT of refused headers, never the names");
  assert(sw.includes("...(refusedHeaders.length ? { refusedHeaderCount: refusedHeaders.length } : {})"), "the ledger entry carries the count too");
});

// --- lrhyl round 7: the two caller-controlled TEXT fields, removed -----------
//
// Review FAIL of round 6.1, two probes, one mistake: fields that carry
// CALLER-CONTROLLED TEXT survived the narrowing. (1) vaultKeyId echoed the
// caller's $VAULT{...} capture - a secret-shaped token placed in a granted
// URL's query or an Authorization placeholder came back through take() and
// the Python-facing return. (2) refusedHeaders permitted arbitrary 128-char
// token strings. A code-like string carrying arbitrary data is free text with
// extra steps. The fix keeps the shape closed: vaultKeyPresented (boolean)
// and refusedHeaderCount (number) replace them - the model needs to know a
// key was presented and how many headers were refused, never the texts.

import { PYTHON_FETCH_ERROR_CODES } from "../extension/lib/python-network.js";

/** The round-7 contract scan: EVERY string in a record (including inside
 * arrays) is either a fixed enum member or a validated http(s) origin /
 * origin+path in normal form - so the NEXT field someone adds cannot be
 * arbitrary text by accident. */
function assertRecordStringsBounded(rec: Record<string, any>, where: string) {
  const enums = new Set<string>(["GET", "HEAD", "POST", "INVALID", "aborted", ...PYTHON_FETCH_ERROR_CODES]);
  const check = (v: string, path: string) => {
    if (enums.has(v)) return;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      throw new Error(`${where}${path}: string is neither a fixed enum member nor a parseable URL: ${JSON.stringify(v)}`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`${where}${path}: non-http(s) scheme in a record string: ${JSON.stringify(v)}`);
    }
    if (u.search || u.hash || u.username || u.password) {
      throw new Error(`${where}${path}: credential location survived in a record string: ${JSON.stringify(v)}`);
    }
    const isOriginField = path === ".origin";
    const normal = isOriginField ? u.origin : `${u.origin}${u.pathname}`;
    if (v !== normal) {
      throw new Error(`${where}${path}: string is not in normal ${isOriginField ? "origin" : "origin+path"} form: ${JSON.stringify(v)}`);
    }
  };
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") check(v, `.${k}`);
    else if (Array.isArray(v)) v.forEach((item, i) => { if (typeof item === "string") check(item, `.${k}[${i}]`); });
  }
}

Deno.test("lrhyl r7: a secret-shaped token in vaultKeyId or refusedHeaders survives NOTHING - not take(), not any model-facing surface", () => {
  const ledger = createPythonNetworkLedger();
  ledger.record("run-lrhyl-r7", {
    method: "GET", url: "https://h/p", ok: false, refused: true,
    errorCode: "vault_key_missing", vaultKeyPresented: true,
    vaultKeyId: "TOKEN_SECRET_FROM_CALLER", // the reviewer's probe: dropped, not a contract field
    ms: 1,
  });
  const inflight = ledger.begin("run-lrhyl-r7", { method: "GET", url: "https://h/q", origin: "https://h", startedAt: Date.now(), controller: null });
  inflight.complete({ ok: true, status: 200, bytes: 5, refusedHeaders: ["X-TOKEN_SECRET_FROM_CALLER"], refusedHeaderCount: 1 });
  const taken = ledger.take("run-lrhyl-r7");
  const serialized = JSON.stringify(taken.records);
  assert(!serialized.includes("TOKEN_SECRET_FROM_CALLER"), "neither field echoes caller-controlled text");
  assertEquals((taken.records[0] as any).vaultKeyId, undefined, "vaultKeyId is not a record field any more");
  assertEquals((taken.records[0] as any).vaultKeyPresented, true, "the boolean carries the only fact the model needs");
  assertEquals((taken.records[1] as any).refusedHeaders, undefined, "refusedHeaders is not a record field any more");
  assertEquals((taken.records[1] as any).refusedHeaderCount, 1, "the COUNT replaces the caller's header names");
});

Deno.test("lrhyl r7: EVERY string field of EVERY writer's record is a fixed enum member or a validated http(s) origin/origin+path", () => {
  const ledger = createPythonNetworkLedger();
  // adversarial inputs across all four writers
  ledger.record("run-lrhyl-r7s", {
    method: `TRACE ${SECRET_PLACEHOLDER}`, url: `https://h/p?token=${SECRET_PLACEHOLDER}`,
    origin: `https://user:${SECRET_PLACEHOLDER}@h/x`, ok: false, refused: true,
    errorCode: `free_${SECRET_PLACEHOLDER}`, vaultKeyId: "TOKEN_SECRET_FROM_CALLER",
    refusedHeaders: [`X-TOKEN_SECRET_FROM_CALLER`], label: `see https://h/p?token=${SECRET_PLACEHOLDER}`,
    ms: 1,
  });
  const i = ledger.begin("run-lrhyl-r7s", { method: "GET", url: "https://h/q#frag", origin: "https://h", startedAt: Date.now(), controller: { abort() {} } });
  i.complete({ ok: true, status: 200, bytes: 1, refusedHeaderCount: 2 });
  const taken = ledger.take("run-lrhyl-r7s"); // the third record is abort-written inside take()
  assertEquals(taken.records.length, 2);
  taken.records.forEach((rec, idx) => assertRecordStringsBounded(rec as Record<string, any>, `records[${idx}]`));
  const serialized = JSON.stringify(taken.records);
  assert(!serialized.includes(SECRET_PLACEHOLDER) && !serialized.includes("TOKEN_SECRET_FROM_CALLER"));
  // the method collapsed to INVALID, the errorCode to fetch_failed, unknown fields are gone
  assertEquals((taken.records[0] as any).method, "INVALID");
  assertEquals((taken.records[0] as any).errorCode, "fetch_failed");
  assertEquals((taken.records[0] as any).vaultKeyId, undefined);
  assertEquals((taken.records[0] as any).refusedHeaders, undefined);
  assertEquals((taken.records[0] as any).label, undefined);
  assertEquals((taken.records[0] as any).origin, "https://h", "the userinfo-bearing origin is re-parsed to the BARE origin - the credential is gone, the honest origin survives (same policy as url -> origin+path)");
});

// --- khwi9: the python.fetch body read is BOUNDED, and truncation is honest ---
//
// The hvd4s class, worse: python.fetch buffered the ENTIRE response body into
// the privileged service worker with no bound at all (sw.js:7991's raw
// res.text()), and its bodies are attacker-chosen web content. The hub fixed
// the cap at 10 MB (2026-11-06: "consistency with the fetch brokers and the
// OOXML bounds"). The read goes through the same stream-level bounded reader
// cap:fetch uses (lib/fetch-body-bound.js), and truncation is SURFACED, never
// guessed: a boolean on the Python-facing return and, when true, a contract
// field on the ledger record - a boolean, so the lrhyl r6/r7 closed shape and
// its string-field contract scan are untouched.

Deno.test("khwi9: 'truncated' is a contract field - the ledger carries the boolean, only when true, type-checked", () => {
  const ledger = createPythonNetworkLedger();
  const i1 = ledger.begin("run-khwi9-a", { method: "GET", url: "https://h/big", origin: "https://h", startedAt: Date.now(), controller: null });
  i1.complete({ ok: true, status: 200, bytes: 10_000_000, truncated: true });
  const recA = ledger.take("run-khwi9-a").records[0];
  assertEquals(recA.truncated, true, "a truncated body is recorded as the boolean fact");
  const i2 = ledger.begin("run-khwi9-b", { method: "GET", url: "https://h/small", origin: "https://h", startedAt: Date.now(), controller: null });
  i2.complete({ ok: true, status: 200, bytes: 12 });
  const recB = ledger.take("run-khwi9-b").records[0];
  assertEquals((recB as any).truncated, undefined, "an untruncated record does not grow the field");
  // a non-boolean 'truncated' is dropped, never laundered into a record string
  const ledger2 = createPythonNetworkLedger();
  ledger2.record("run-khwi9-c", { method: "GET", url: "https://h/x", ok: true, ms: 1, truncated: `yes https://h/?s=${SECRET_PLACEHOLDER}` });
  const recC = ledger2.take("run-khwi9-c").records[0];
  assertEquals((recC as any).truncated, undefined, "a caller-supplied non-boolean truncated is dropped");
  assert(!JSON.stringify(recC).includes(SECRET_PLACEHOLDER));
});

Deno.test("khwi9 SW source pin: python.fetch reads the body through the bounded reader at the hub's 10 MB cap", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("const PYTHON_FETCH_BODY_MAX_BYTES = 10_000_000;"), "the hub's 10 MB decision is a named constant at the broker");
  assert(sw.includes('const { text, truncated } = m === "HEAD" ? { text: "", truncated: false } : await readResponseTextBounded(res, PYTHON_FETCH_BODY_MAX_BYTES);'), "the body read is bounded at the STREAM, HEAD keeps its body-less semantics");
  assert(sw.includes("...(truncated ? { truncated: true } : {})"), "the ledger entry surfaces truncation honestly (only when true)");
  assert(sw.includes("truncated,\n        // Round 7: the COUNT"), "the Python-facing success return carries the truncated boolean next to the count");
  assert(!sw.includes('const text = m === "HEAD" ? "" : await res.text();'), "the unbounded read is deleted, not commented out");
});

// --- guh95: the echo is built from the PRE-SUBSTITUTION template, never the fetched URL ---
//
// urlWithoutQuery preserves origin+PATH by design (contract), so ANY vault
// secret that reaches the path of a fetched URL rides through it. The filed
// repro substituted the template by hand; through the real flow the URL parser
// percent-encodes braces in the PATH before $VAULT{KEY} substitution runs
// (substitution fires only in the query, which the lrhyl strip removed), so
// the leak is not live today — but res.url/u.href are the wrong echo source
// REGARDLESS: their safety depends on that encoding coincidence, and any
// future substitution semantics (e.g. raw-template substitution with
// revalidation) would reopen the leak through them. The model wrote the
// TEMPLATE; it must never learn the vault value. Fix: echo
// urlWithoutQuery(template) — which is also what the ledger's begin()
// records — closing the last post-substitution echo under every semantics.
// The silent functional gap this uncovered (a $VAULT{KEY} in the path is
// never substituted, and no refusal says so) is reported separately on the
// bead — making substitution fire there is a design decision (substituting
// before the parse can move the origin, so it needs revalidation), not a
// one-line change.

Deno.test("guh95 repro pin: a PATH-substituted vault secret survives urlWithoutQuery - which is why the echo must use the template", () => {
  const S = "GUH95_VAULT_SEKRET_4417";
  const template = "https://api.example.com/v1/$VAULT{GEMINI}/generate";
  const postSub = template.split("$VAULT{GEMINI}").join(S);
  // The defect's mechanism, pinned so the fix's premise cannot silently change:
  // origin+path normalization KEEPS the path, secret included.
  assert(urlWithoutQuery(postSub).includes(S), "urlWithoutQuery preserves PATH by contract - a post-substitution echo leaks");
  // The template echo carries no secret - only the model's own placeholder
  // text (URL parsing percent-encodes the braces in the path; deterministic,
  // secret-free, and still recognisable to the model that wrote it).
  const echoed = urlWithoutQuery(template);
  assert(!echoed.includes(S));
  assertEquals(echoed, "https://api.example.com/v1/$VAULT%7BGEMINI%7D/generate");
});

Deno.test("guh95 SW source pin: python.fetch echoes the PRE-SUBSTITUTION template url; the post-substitution echo is gone", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(sw.includes("url: urlWithoutQuery(String(url ?? \"\")),"), "the model-readable echo is the template url the model itself wrote");
  assert(!sw.includes("urlWithoutQuery(res.url || u.href)"), "the post-substitution echo (res.url/u.href - both carry substituted vault secrets) is deleted, not commented out");
});
// --- j2mff: the truncated flag reaches the PYTHON PROGRAM, not just the SW return ---
//
// khwi9's landed claim said "truncation surfaced to the Python program", but
// cap.Response declares __slots__ — and a slots class SILENTLY DISCARDS any
// attribute not listed. The SW return carried truncated; python-worker.js's
// Response never copied it, so a >10 MB body was silently partial at the
// Python surface (the container-not-content pattern: the review read the SW
// return as the Python surface). These pins hold the CONTENT contract at the
// Python side: the slots tuple lists the flag, __init__ copies it from the
// payload under the SAME key the SW writes, and both live in class Response.

Deno.test("j2mff: cap.Response carries truncated - slots list it, __init__ copies it, same key the SW writes", async () => {
  const worker = await Deno.readTextFile(new URL("../wasm-tools/python/python-worker.js", import.meta.url));
  assert(
    worker.includes('__slots__ = ("status", "url", "headers", "text", "bytes", "truncated")'),
    "cap.Response.__slots__ must list truncated - a slots class silently discards any attribute not listed, which is exactly how khwi9's flag vanished",
  );
  assert(
    worker.includes('self.truncated = bool(payload.get("truncated"))'),
    "__init__ must copy the flag from the payload as a bool",
  );
  const respStart = worker.indexOf("class Response:");
  const slotsIdx = worker.indexOf('__slots__ = ("status"');
  const copyIdx = worker.indexOf('self.truncated = bool(payload.get("truncated"))');
  assert(respStart > 0 && slotsIdx > respStart && copyIdx > slotsIdx, "the slots entry and the init copy live in class Response, slots before the copy");
  // Cross-surface key contract: the worker reads the same literal key the SW
  // return writes (khwi9's SW pin covers the write side; this covers the read).
  assert(worker.includes('payload.get("truncated")'), "the worker reads the key 'truncated' - the same literal the SW's tagUntrusted return writes");
  // A printed Response announces truncation - silent partiality is the defect.
  assert(worker.includes('", TRUNCATED at the broker\'s byte cap" if self.truncated else ""'), "__repr__ must announce a truncated body");
  // The flag is documented where a Python author reads docs: the class docstring.
  assert(/class Response:[\s\S]{0,400}?truncated/.test(worker), "the Response docstring must mention the truncated flag");
});

// --- 6cwaa folded into j2mff (coord notified): the worker error path speaks r6 ---
//
// lrhyl r6 made the broker's failure contract a fixed CODE plus structured
// sanitised fields (origin: bare scheme+host; hint: STATIC guidance). The
// worker's error path never learned the contract: it substring-matched the
// message ('failed' in it) to split NetworkError/NetworkRefused - so 'timeout'
// and 'aborted' raised NetworkRefused ("retrying changes nothing", materially
// wrong guidance) - and it raised the bare code, DISCARDING the origin and the
// hint, which is why kat-python-permissioned-fetch's 'the refusal names the
// origin and how to grant it' has been deterministic RED on main's heavy tier
// since lrhyl landed. Fix: classify by CODE, compose the message from the
// structured fields, fail safe on unknown codes.

Deno.test("6cwaa: the worker error path classifies by CODE and composes the message from the sanitised fields", async () => {
  const worker = await Deno.readTextFile(new URL("../wasm-tools/python/python-worker.js", import.meta.url));
  assert(!worker.includes('"failed" in message'), "the substring-based classification is gone - it misclassified timeout/aborted once messages became codes");
  assert(worker.includes('if code in ("fetch_failed", "timeout", "aborted", "grant_store_failed"):'), "the retryable class is a CODE set: permitted-but-did-not-complete");
  assert(worker.includes('if code in ("invalid_url", "method_not_allowed", "forbidden_host", "not_granted",'), "the permission class is a CODE set");
  assert(worker.includes("raise NetworkError(message)") && worker.includes("raise NetworkRefused(message)"), "both exception classes are raised from the code sets");
  // unknown codes: the retryable default is the safe one when the vocabulary grows
  const errIdx = worker.indexOf("payload = _json.loads(raw)");
  const fallbackIdx = worker.indexOf("# unknown code: the retryable default");
  assert(errIdx > 0 && fallbackIdx > errIdx, "an unknown code falls back to NetworkError (retryable), never a silent pass");
  // the r6 structured fields reach the program: refusals stay teachable
  assert(worker.includes('payload.get("hint")'), "the STATIC hint reaches the Python program (how to grant, what to change)");
  assert(worker.includes('payload.get("origin")'), "the sanitised origin reaches the Python program (which origin was refused)");
});

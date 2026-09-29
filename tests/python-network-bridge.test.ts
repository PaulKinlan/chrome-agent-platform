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
import { createPythonNetworkLedger } from "../extension/lib/python-network.js";
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
  assertEquals(ledger.size(), 0);
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


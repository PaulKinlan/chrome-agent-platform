// chrome-agent-platform-ltkj.3 — the offscreen Emscripten host contract:
// exact-key cap:emscripten-run envelope, SW-only sender gate, scalar-validated
// args, hash-verified assets, fresh worker per job, host-owned deadline armed
// before initialization, exactly-once settlement, per-package busy refusal.
// @ts-nocheck — browser stubs are intentionally dynamic (house style).
import { buildPreviewAuthority } from "../extension/lib/tool-exec-preview.js";
import {
  EMSCRIPTEN_RUN_TYPE,
  EMSCRIPTEN_WORKER_PATH,
  executeEmscriptenRunRequest,
  registerEmscriptenHost,
} from "../extension/lib/emscripten-host.js";

function assert(condition, message = "assertion failed") { if (!condition) throw new Error(message); }

const runtime = {
  id: "cap-kat",
  getURL(path) { return `chrome-extension://cap-kat/${path}`; },
  getManifest() { return { background: { service_worker: "dist/background/service-worker.js" } }; },
};

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GLUE_BYTES = new TextEncoder().encode("// glue");
const ADAPTER_BYTES = new TextEncoder().encode("// adapter");
const WASM_BYTES = new TextEncoder().encode("wasm-bytes");

async function assetFor(role, path, bytes) {
  return { role, path, sha256: await sha256Hex(bytes), size: bytes.byteLength };
}

async function request(overrides = {}) {
  const req = {
    type: EMSCRIPTEN_RUN_TYPE,
    packageId: "cap.acceptance.a0.numeric",
    version: "1.0.0",
    graphDigest: "a".repeat(64),
    operationId: "weighted_sum",
    operation: {
      id: "weighted_sum",
      adapterId: "cap-a0-numeric-v1",
      exportName: "cap_weighted_sum",
      result: "f64",
      params: [
        { name: "value", type: "f64", minimum: -1000000, maximum: 1000000 },
        { name: "weight", type: "f64", minimum: -1000000, maximum: 1000000 },
        { name: "bias", type: "f64", minimum: -1000000, maximum: 1000000 },
      ],
    },
    args: [6, 7, 0.5],
    assets: [
      await assetFor("glue", "wasm/runtime/cap.acceptance.a0.numeric/1.0.0/numeric-glue.mjs", GLUE_BYTES),
      await assetFor("adapter", "wasm/runtime/cap.acceptance.a0.numeric/1.0.0/cap-a0-numeric-v1.mjs", ADAPTER_BYTES),
      await assetFor("main-wasm", `wasm/cas/${"b".repeat(64)}.wasm`, WASM_BYTES),
    ],
    lifecycle: { startupMs: 10000, callMs: 30000 },
    authority: buildPreviewAuthority({ origin: "https://agent.cap", documentId: "host-kat", now: () => 1 }),
  };
  return Object.assign(req, overrides);
}

function syntheticFetch(bytesByPath) {
  return async (url) => {
    const path = String(url).replace("chrome-extension://cap-kat/", "");
    const bytes = bytesByPath[path];
    if (!bytes) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
    return {
      ok: true,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  };
}

const defaultBytes = {
  "wasm/runtime/cap.acceptance.a0.numeric/1.0.0/numeric-glue.mjs": GLUE_BYTES,
  "wasm/runtime/cap.acceptance.a0.numeric/1.0.0/cap-a0-numeric-v1.mjs": ADAPTER_BYTES,
  [`wasm/cas/${"b".repeat(64)}.wasm`]: WASM_BYTES,
};

const realChrome = globalThis.chrome;
const realFetch = globalThis.fetch;
function installStubs(fetchImpl = syntheticFetch(defaultBytes)) {
  globalThis.chrome = { runtime };
  globalThis.fetch = fetchImpl;
}
function restoreStubs() {
  globalThis.chrome = realChrome;
  globalThis.fetch = realFetch;
}

function workerResult(posted, overrides = {}) {
  return {
    type: "cap:emscripten-run-result",
    sessionId: posted.sessionId,
    packageId: posted.packageId,
    operationId: posted.operationId,
    ok: true,
    phase: "completed",
    result: 42.5,
    error: null,
    workerInstanceId: "33333333-3333-4333-8333-333333333333",
    ...overrides,
  };
}

Deno.test("emscripten host: happy path posts the exact job to one fresh worker and settles once", async () => {
  installStubs();
  try {
    let posted = null, transferred = null, terminated = 0, workerUrl = null;
    class FakeWorker {
      constructor(url) { workerUrl = url; }
      postMessage(message, transfer) {
        posted = message; transferred = transfer;
        queueMicrotask(() => this.onmessage({ data: workerResult(message) }));
      }
      terminate() { terminated++; }
    }
    const result = await executeEmscriptenRunRequest(await request(), { createWorker: (url) => new FakeWorker(url) });
    assert(result.ok === true && result.phase === "completed" && result.result === 42.5, `happy path result: ${JSON.stringify(result)}`);
    assert(workerUrl === `chrome-extension://cap-kat/${EMSCRIPTEN_WORKER_PATH}`, "worker is the literal packaged path");
    assert(posted.type === "cap:emscripten-worker-job", "job type");
    assert(JSON.stringify(Object.keys(posted).sort()) ===
      JSON.stringify(["adapterUrl","args","glueUrl","graphDigest","operation","operationId","packageId","sessionId","type","version","wasmBytes"]),
      "exact job keys");
    assert(posted.glueUrl.endsWith("wasm/runtime/cap.acceptance.a0.numeric/1.0.0/numeric-glue.mjs"), "broker-selected glue URL");
    assert(transferred?.length === 1 && transferred[0] instanceof ArrayBuffer, "the verified wasm bytes transfer");
    assert(terminated >= 1, "the worker is terminated on settlement");
  } finally { restoreStubs(); }
});

Deno.test("emscripten host: exact-key envelope rejects caller-supplied extras (Module/hooks/locateFile)", async () => {
  installStubs();
  try {
    const bloated = await request({ locateFile: () => "https://evil.example/x.wasm" });
    let code = null;
    try { await executeEmscriptenRunRequest(bloated, { createWorker: () => { throw new Error("must not spawn"); } }); }
    catch (error) { code = error.code ?? error.message; }
    assert(code === "emscripten_run_request", `extra key refused: ${code}`);
  } finally { restoreStubs(); }
});

Deno.test("emscripten host: scalar args are validated against the broker-derived param bounds", async () => {
  installStubs();
  try {
    let code = null;
    try { await executeEmscriptenRunRequest(await request({ args: [6, 2000000, 0.5] })); }
    catch (error) { code = error.code ?? error.message; }
    assert(code === "emscripten_run_args", `out-of-bounds arg refused: ${code}`);
    code = null;
    try { await executeEmscriptenRunRequest(await request({ args: [6, 7] })); }
    catch (error) { code = error.code ?? error.message; }
    assert(code === "emscripten_run_args", `arity mismatch refused: ${code}`);
    code = null;
    try { await executeEmscriptenRunRequest(await request({ args: [6, "7", 0.5] })); }
    catch (error) { code = error.code ?? error.message; }
    assert(code === "emscripten_run_args", `non-scalar arg refused: ${code}`);
  } finally { restoreStubs(); }
});

Deno.test("emscripten host: asset byte/hash drift fails closed before any worker exists", async () => {
  installStubs(syntheticFetch({
    ...defaultBytes,
    [`wasm/cas/${"b".repeat(64)}.wasm`]: new TextEncoder().encode("drifted-bytes"),
  }));
  try {
    let code = null;
    try { await executeEmscriptenRunRequest(await request(), { createWorker: () => { throw new Error("must not spawn"); } }); }
    catch (error) { code = error.code ?? error.message; }
    assert(code === "emscripten_asset_hash", `hash drift refused: ${code}`);
  } finally { restoreStubs(); }
});

Deno.test("emscripten host: hostile worker results are rejected (wrong session, extra keys, bad scalar)", async () => {
  installStubs();
  try {
    let settled = null;
    class WrongSession {
      postMessage(message) {
        queueMicrotask(() => this.onmessage({ data: workerResult(message, { sessionId: "forged" }) }));
      }
      terminate() {}
    }
    const result = await executeEmscriptenRunRequest(await request(), { createWorker: () => new WrongSession() });
    assert(result.ok === false && result.phase === "failed" && /emscripten_worker_result/.test(result.error),
      `wrong-session result rejected: ${JSON.stringify(result)}`);
  } finally { restoreStubs(); }
});

Deno.test("emscripten host: one in-flight job per package — the second refuses honestly", async () => {
  installStubs();
  let first = null;
  try {
    let firstPosted = null;
    let onFirstPosted = null;
    const firstPostedPromise = new Promise((resolve) => { onFirstPosted = resolve; });
    class HangingWorker {
      postMessage(message) {
        firstPosted = message;
        onFirstPosted?.(message);
        /* never answers */
      }
      terminate() {}
    }
    first = executeEmscriptenRunRequest(await request({
      lifecycle: { startupMs: 250, callMs: 250 },
    }), { createWorker: () => new HangingWorker() });
    await Promise.race([
      firstPostedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("first job post timeout")), 5000)),
    ]);
    assert(firstPosted, "the first job posted");
    let code = null;
    try { await executeEmscriptenRunRequest(await request()); }
    catch (error) { code = error.code ?? error.message; }
    assert(code === "emscripten_busy", `concurrent run refused: ${code}`);
    const firstResult = await first; // the deadline (armed before init) settles it
    assert(firstResult.ok === false && firstResult.phase === "timeout", `first run timed out honestly: ${JSON.stringify(firstResult)}`);
  } finally {
    if (first) {
      try { await first; } catch { /* best effort */ }
    }
    restoreStubs();
  }
});

Deno.test("emscripten host: only the service worker may submit (tab/document senders rejected)", async () => {
  installStubs();
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      ...runtime,
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  let runPromise = null;
  try {
    registerEmscriptenHost();
    assert(listeners.length === 1, "exactly one listener");
    const listener = listeners[0];
    const req = await request();
    const swSender = { id: "cap-kat", url: "chrome-extension://cap-kat/dist/background/service-worker.js" };
    const responses = [];
    // Not ours → undefined (no claim).
    assert(listener({ type: "other" }, swSender, () => {}) === undefined, "other types unclaimed");
    // Tab sender with a matching extension id is still rejected.
    const tabAccepted = listener(req, { ...swSender, tab: { id: 1 } }, (r) => responses.push(r));
    assert(tabAccepted === false && responses.at(-1)?.error === "emscripten_run_sender", "tab sender rejected");
    const docAccepted = listener(req, { ...swSender, documentId: "doc-1" }, (r) => responses.push(r));
    assert(docAccepted === false && responses.at(-1)?.error === "emscripten_run_sender", "document sender rejected");
    const wrongUrl = listener(req, { ...swSender, url: "chrome-extension://cap-kat/options/options.html" }, (r) => responses.push(r));
    assert(wrongUrl === false && responses.at(-1)?.error === "emscripten_run_sender", "wrong URL rejected");
    // The real SW sender is accepted and runs async (worker factory injected).
    class InstantWorker {
      postMessage(message) { queueMicrotask(() => this.onmessage({ data: workerResult(message) })); }
      terminate() {}
    }
    registerEmscriptenHost({ createWorker: () => new InstantWorker() });
    let runPromiseResolve;
    runPromise = new Promise((resolve) => { runPromiseResolve = resolve; });
    const accepted = listeners[1](req, swSender, runPromiseResolve);
    assert(accepted === true, "SW sender accepted (async)");
    const ran = await Promise.race([
      runPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("SW run timed out")), 5000)),
    ]);
    assert(ran?.ok === true && ran?.result === 42.5, `SW-submitted run completed: ${JSON.stringify(ran)}`);
  } finally {
    if (runPromise) {
      try { await Promise.race([runPromise, new Promise((r) => setTimeout(r, 100))]); } catch { /* best effort */ }
    }
    restoreStubs();
  }
});

Deno.test("emscripten host: dangling promise / undefined chrome.runtime cannot recur", async () => {
  // 1. Calling registerEmscriptenHost when globalThis.chrome is undefined fails safe without throwing.
  restoreStubs();
  assert(globalThis.chrome === undefined, "chrome is undefined");
  let registerError = null;
  try { registerEmscriptenHost(); } catch (err) { registerError = err; }
  assert(registerError === null, `registerEmscriptenHost with undefined chrome must not throw: ${registerError}`);

  // 2. Calling executeEmscriptenRunRequest when chrome is undefined fails closed honestly (no unhandled TypeError).
  const req = await request();
  let runCode = null;
  try {
    await executeEmscriptenRunRequest(req);
  } catch (err) {
    runCode = err.code ?? err.message;
  }
  assert(runCode === "emscripten_asset_fetch", `executeEmscriptenRunRequest without chrome fails closed honestly: ${runCode}`);

  // 3. Sender-guard path fails closed honestly when chrome.runtime is undefined (no unhandled deref).
  const swSender = { id: "cap-kat", url: "chrome-extension://cap-kat/dist/background/service-worker.js" };
  const mockListeners = [];
  registerEmscriptenHost({
    runtime: {
      onMessage: { addListener: (fn) => mockListeners.push(fn) },
    },
  });
  assert(mockListeners.length === 1, "listener registered with mock runtime");
  let senderResponse = null;
  const accepted = mockListeners[0](req, swSender, (r) => { senderResponse = r; });
  assert(accepted === false, "untrusted sender rejected synchronously when runtime invalid");
  assert(senderResponse?.error === "emscripten_run_sender", "sender rejection error code");

  // 4. An in-flight run where chrome stub is wiped mid-fetch (before line 203 getURL) settles cleanly using captured runtime.
  const fetchMock = syntheticFetch(defaultBytes);
  installStubs((url) => {
    // Clear global chrome mid-fetch before line 203 evaluates glueUrl:
    globalThis.chrome = undefined;
    return fetchMock(url);
  });
  try {
    let workerUrl = null;
    class FastWorker {
      constructor(url) { workerUrl = url; }
      postMessage(message) { queueMicrotask(() => this.onmessage({ data: workerResult(message) })); }
      terminate() {}
    }
    const result = await executeEmscriptenRunRequest(req, { createWorker: (url) => new FastWorker(url) });
    assert(result.ok === true && result.phase === "completed" && result.result === 42.5,
      `in-flight run settles safely even if global chrome wiped mid-fetch: ${JSON.stringify(result)}`);
    assert(workerUrl.startsWith("chrome-extension://cap-kat/"), "worker url constructed from captured runtime");
  } finally {
    restoreStubs();
  }
});

Deno.test("emscripten host: source pins — worker path literal, no execution primitives in the host", async () => {
  const hostSource = await Deno.readTextFile("extension/lib/emscripten-host.js");
  const workerSource = await Deno.readTextFile("extension/lib/emscripten-worker.js");
  const registrySource = await Deno.readTextFile("extension/lib/emscripten-adapter-registry.js");
  assert(hostSource.includes('"lib/emscripten-worker.js"'), "the worker path is a literal string");
  assert(!/eval\s*\(|new Function|importScripts|WebAssembly\./.test(hostSource), "the host executes nothing itself");
  assert(!/eval\s*\(|new Function|importScripts|WebAssembly\./.test(workerSource), "the worker uses no dynamic code or direct WebAssembly");
  assert(workerSource.includes('factory({ wasmBinary: job.wasmBytes })'), "the factory receives exactly wasmBinary");
  assert(registrySource.includes('"cap-a0-numeric-v1"'), "the literal adapter registry names the A0 adapter");
  const offscreenSource = await Deno.readTextFile("extension/offscreen/offscreen.js");
  assert(offscreenSource.includes("registerEmscriptenHost()"), "the offscreen document registers the host");
});

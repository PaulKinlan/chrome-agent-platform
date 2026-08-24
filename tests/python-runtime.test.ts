// @ts-nocheck — the Pyodide runtime is an injected mock; the runtime shape is under test.
// tests/python-runtime.test.ts — CAP-FEATURE-PYODIDE-01: the bounded Python
// execution contract + the lazy loader's degrade-on-unavailable. No Chrome; the
// Pyodide runtime is a mock (the real load is the browser-gate lane).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createPythonRuntime, verifyIntegrity, PYTHON_RUNTIME_PIN, PYTHON_STATUS } from "../extension/lib/python-runtime.js";
import { runPython, PYTHON_EXEC_BOUNDS } from "../extension/lib/python-execution.js";

function sha384(bytes) {
  // A tiny synchronous SHA-384 stub for the KATs (not a production digest —
  // the browser-gate lane wires crypto.subtle).
  const b = Array.from(new Uint8Array(bytes)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return Promise.resolve(new TextEncoder().encode(`stub${b.length}:${b}`).buffer);
}

Deno.test("pyodide: verifyIntegrity is a no-op on an empty (unpinned) integrity, fails on a mismatch", async () => {
  const text = "hello";
  assertEquals(await verifyIntegrity(text, { integrity: "" }), text, "the unpinned check passes through");
  let threw = null;
  try { await verifyIntegrity("substituted", { integrity: "sha384-Zm9rZ2F0ZXN0", digest: () => Promise.resolve(new TextEncoder().encode("other").buffer) }); } catch (e) { threw = e?.message; }
  assertEquals(threw, "python_runtime_integrity_mismatch");
});

Deno.test("pyodide: the lazy loader is unavailable -> loading -> available on a successful load", async () => {
  const rt = createPythonRuntime({
    fetchImpl: async () => ({ ok: true, text: async () => "pinned-bytes" }),
    cache: { bytes: new Map(), get: null, set: null },
  });
  assertEquals(rt.status(), PYTHON_STATUS.unavailable);
  const p = rt.load(async () => ({ runPython: (code) => code }));
  assertEquals(rt.status(), PYTHON_STATUS.loading, "in-flight status");
  const res = await p;
  assertEquals(res.ok, true);
  assertEquals(rt.status(), PYTHON_STATUS.available);
});

Deno.test("pyodide: a failed load degrades to unavailable and the platform still works", async () => {
  const rt = createPythonRuntime({
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }),
    cache: { bytes: new Map(), get: null, set: null },
  });
  const res = await rt.load(async () => ({ runPython: () => "x" }));
  assertEquals(res.ok, false);
  assertEquals(rt.status(), PYTHON_STATUS.unavailable, "the degrade");
  assertEquals(res.error, "python_runtime_fetch_failed");
  // The platform works without Python: runPython degrades, never throws.
  const run = await runPython(null, { code: "print(1)" });
  assertEquals(run.ok, false);
  assertEquals(run.error, "python_unavailable");
});

Deno.test("pyodide: runPython enforces the stdin/stdout/timeout bounds and is fresh per run", async () => {
  // stdin over budget.
  const over = await runPython({ runPython: () => "1" }, { code: "x", stdin: "y".repeat(PYTHON_EXEC_BOUNDS.maxStdinBytes + 1) });
  assertEquals(over.ok, false);
  assertEquals(over.error, "python_stdin_over_budget");
  // empty code.
  const empty = await runPython({ runPython: () => "1" }, { code: "" });
  assertEquals(empty.error, "python_empty_code");
  // stdout over budget.
  const big = await runPython({ runPython: () => "z".repeat(PYTHON_EXEC_BOUNDS.maxStdoutBytes + 1) }, { code: "print()" });
  assertEquals(big.ok, false);
  assertEquals(big.error, "python_stdout_over_budget");
  // the timeout fence.
  const slow = await runPython({ runPython: () => new Promise(() => {}) }, { code: "sleep", timeoutMs: 5 });
  assertEquals(slow.ok, false);
  assertEquals(slow.error, "python_run_timeout");
  // the happy path: the code + the stdin are the only inputs; fresh per run.
  const seen = [];
  const ok = await runPython({
    runPython: (code, stdin) => { seen.push([code, stdin]); return `${code}:${stdin}`; },
  }, { code: "print(2)", stdin: "data" });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "print(2):data");
  assertEquals(seen.length, 1, "one call — no cross-run state");
});

Deno.test("pyodide: the pinned CDN version is stable and the pins are non-empty-shaped", () => {
  assertEquals(PYTHON_RUNTIME_PIN.version, "0.26.4");
  assert(PYTHON_RUNTIME_PIN.jsUrl.startsWith("https://"), "the CDN pin is https");
  assert(PYTHON_RUNTIME_PIN.wasmUrl.includes("pyodide.asm.wasm"), "the core wasm is pinned");
});

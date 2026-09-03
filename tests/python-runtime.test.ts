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

Deno.test("pyodide: runPython has NO byte budgets (dptw); the timeout + non-eval entrypoint stay", async () => {
  // A mock with the NON-EVAL interpreter shape (runPythonAsync + setStdout/setStdin).
  const mockRuntime = (behavior) => ({
    runPythonAsync: behavior,
    setStdout: () => {},
    setStdin: () => {},
  });
  // stdin past the removed 2 KiB budget runs.
  const over = await runPython(mockRuntime(async () => {}), { code: "x", stdin: "y".repeat(2048 + 1) });
  assertEquals(over.ok, true, "stdin past the old budget runs");
  // empty code.
  const empty = await runPython(mockRuntime(async () => {}), { code: "" });
  assertEquals(empty.error, "python_empty_code");
  // stdout past the removed 64 KiB budget arrives whole.
  const bigOut = "z".repeat(64 * 1024 + 1);
  const big = await runPython({ runPythonAsync: async () => {}, setStdout: ({ batched }) => batched(bigOut), setStdin: () => {} }, { code: "print()" });
  assertEquals(big.ok, true, "stdout past the old budget arrives");
  assertEquals(big.stdout, bigOut, "the whole output is delivered");
  // the timeout fence.
  const slow = await runPython({ runPythonAsync: () => new Promise(() => {}), setStdout: () => {}, setStdin: () => {} }, { code: "sleep", timeoutMs: 5 });
  assertEquals(slow.ok, false);
  assertEquals(slow.error, "python_run_timeout");
  // the happy path: code is the interpreter's input, stdout is captured via setStdout.
  const seen = [];
  let emit = null;
  const ok = await runPython({
    runPythonAsync: (code) => { seen.push(code); emit("hello"); },
    setStdout: ({ batched }) => { emit = batched; },
    setStdin: ({ stdin }) => seen.push(`stdin:${stdin()}`),
  }, { code: "print(2)", stdin: "data" });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "hello");
  assertEquals(seen[0], "stdin:data", "stdin flows through setStdin's provider");
  assertEquals(seen[1], "print(2)", "the code reaches only runPythonAsync (never a JS eval path)");
});

Deno.test("pyodide: a JS-eval-shaped runtime (no runPythonAsync) is refused fail-closed", async () => {
  // A runtime that ONLY offers a JS-eval-shaped surface (eval/new Function) and
  // no interpreter entrypoint must be refused — the adapter never calls eval.
  const evil = { eval: (code) => code, runPython: () => "x" };
  const r = await runPython(evil, { code: "print(1)" });
  assertEquals(r.ok, false);
  assertEquals(r.error, "python_unavailable");
});

Deno.test("pyodide: the pinned CDN version is stable and the pins are non-empty-shaped", () => {
  assertEquals(PYTHON_RUNTIME_PIN.version, "0.26.4");
  assert(PYTHON_RUNTIME_PIN.jsUrl.startsWith("https://"), "the CDN pin is https");
  assert(PYTHON_RUNTIME_PIN.wasmUrl.includes("pyodide.asm.wasm"), "the core wasm is pinned");
});

Deno.test("pyodide: the python tool fails closed when the runtime is not admitted, and runs when injected", async () => {
  const { pythonTool, setPythonRuntimeProvider } = await import("../extension/lib/python-tool.js");
  // Default provider = null → honest unavailable, no fabricated result.
  const unavailable = await pythonTool.execute({ code: "print(1)" });
  assertEquals(unavailable.ok, undefined);
  assert(String(unavailable.error).includes("python unavailable"), "honest unavailable when the runtime is not admitted");
  // Inject a non-eval runtime; the tool now runs bounded code.
  setPythonRuntimeProvider(async () => ({
    runPythonAsync: async () => {},
    setStdout: ({ batched }) => batched("42\n"),
    setStdin: () => {},
  }));
  const ok = await pythonTool.execute({ code: "print(6*7)" });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "42\n");
  // dptw: code past the removed 2 KiB budget runs (no schema/exec refusal).
  const over = await pythonTool.execute({ code: "x".repeat(2048 + 1) });
  assertEquals(over.ok, true, `past the old code budget runs: ${JSON.stringify(over).slice(0, 120)}`);
});

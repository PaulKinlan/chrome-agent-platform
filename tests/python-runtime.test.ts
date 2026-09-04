// @ts-nocheck — the in-process Pyodide harness below is Deno-specific node
// compat glue for the tests; the shipped browser path runs the SAME pinned
// runtime inside a classic worker (wasm-tools/python/python-worker.js).
// tests/python-runtime.test.ts — CAP-FEATURE-PYODIDE-01 / bead
// chrome-agent-platform-4usu: the bounded python execution contract, the
// admitted-runtime pins, the runtime-provider transport, and — the
// falsification — REAL Pyodide execution of python_execute code.
import { assertEquals, assert, assertStringIncludes } from "jsr:@std/assert@1";
import { runPython, PYTHON_EXEC_BOUNDS } from "../extension/lib/python-execution.js";
import {
  createPythonRuntimeProvider,
  PYTHON_RUNTIME_PIN,
  PYTHON_RUNTIME_VERSION,
} from "../extension/lib/python-runtime.js";
import { registerPythonHost } from "../extension/lib/python-host.js";

// ── the pinned on-disk runtime (the same bytes the shipped worker loads) ──
const RUNTIME_SRC = new URL("../wasm-tools/python/", import.meta.url).pathname;

async function sha256HexBytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("pyodide: admission pins == MANIFEST.json == on-disk bytes (exact hashes)", async () => {
  const manifest = JSON.parse(await Deno.readTextFile(`${RUNTIME_SRC}MANIFEST.json`));
  // The six pyodide dist files are in both the manifest and the shipped pins.
  for (const [file, pin] of Object.entries(PYTHON_RUNTIME_PIN.files)) {
    const bytes = await Deno.readFile(`${RUNTIME_SRC}${file}`);
    assertEquals(bytes.byteLength, pin.bytes, `${file} byte count`);
    const got = await sha256HexBytes(bytes);
    assertEquals(got, pin.sha256, `${file} sha256`);
    assertEquals(manifest.files[file].sha256, pin.sha256, `${file} manifest pin`);
    assertEquals(manifest.provenance.version, PYTHON_RUNTIME_VERSION, "pinned version");
  }
  // python-worker.js is pinned in the manifest (the build verifies it too).
  const workerBytes = await Deno.readFile(`${RUNTIME_SRC}python-worker.js`);
  const workerGot = await sha256HexBytes(workerBytes);
  assertEquals(workerGot, manifest.files["python-worker.js"].sha256, "python-worker.js sha256");
});

// ── the REAL Pyodide runtime, loaded in-process for the tests (the shipped
//    browser host loads these exact bytes in a classic worker instead) ──────
let pyodidePromise = null;
function realPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      // Deno 2 exposes a node-compatible `process`, so Pyodide's loader takes
      // its node branch and needs the node-ish globals it guards on.
      const mods = {};
      for (const [key, spec] of Object.entries({
        fs: "node:fs", crypto: "node:crypto", cp: "node:child_process",
        path: "node:path", url: "node:url", vm: "node:vm", tty: "node:tty",
      })) mods[key] = await import(spec);
      globalThis.require = (name) => ({ ...mods, ws: {} })[name];
      globalThis.__dirname = RUNTIME_SRC;
      globalThis.__filename = `${RUNTIME_SRC}pyodide.mjs`;
      // pyodide.asm.js is classic glue; as an ESM import its top-level still
      // assigns globalThis._createPyodideModule (its tail line).
      await import(new URL(`file://${RUNTIME_SRC}pyodide.asm.js`).href);
      const { loadPyodide } = await import(new URL(`file://${RUNTIME_SRC}pyodide.mjs`).href);
      return await loadPyodide({
        indexURL: RUNTIME_SRC,
        stdout: () => {},
        stderr: () => {},
      });
    })().catch((error) => {
      pyodidePromise = null; // a failure can be retried by the next test
      throw error;
    });
  }
  return pyodidePromise;
}

async function pythonToolWithRealRuntime() {
  const { pythonTool, setPythonRuntimeProvider } = await import("../extension/lib/python-tool.js");
  setPythonRuntimeProvider(() => realPyodide());
  return pythonTool;
}

// The falsification: python_execute actually EXECUTES — print("Hello, World")
// returns the captured output, not a text description of the code.
Deno.test("pyodide REAL: python_execute print(Hello, World) returns the actual output", async () => {
  const tool = await pythonToolWithRealRuntime();
  const result = await tool.execute({ code: 'print("Hello, World")' });
  assertEquals(result.ok, true, JSON.stringify(result));
  // Pyodide's batched stdout writer delivers each line WITHOUT its trailing
  // newline (the newline is the batch terminator) — this is the interpreter's
  // actual output, line content preserved.
  assertEquals(result.stdout, "Hello, World", "captured stdout is the executed output");
  assertEquals(result.stdoutBytes, 12);
});

Deno.test("pyodide REAL: python_execute print(1+1) returns 2", async () => {
  const tool = await pythonToolWithRealRuntime();
  const result = await tool.execute({ code: "print(1+1)" });
  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(result.stdout, "2");
});

Deno.test("pyodide REAL: stdin reaches the program and read-to-EOF terminates", async () => {
  const tool = await pythonToolWithRealRuntime();
  const result = await tool.execute({
    code: "import sys\nprint('GOT:' + repr(sys.stdin.read()))",
    stdin: "line-a\nline-b\n",
  });
  assertEquals(result.ok, true, JSON.stringify(result));
  // repr() keeps the newlines as escapes inside ONE output line, so the exact
  // stdin round-trip is assertable through the line-batched writer.
  assertEquals(result.stdout, "GOT:'line-a\\nline-b\\n'", "one-shot stdin: content once, then EOF");
});

Deno.test("pyodide REAL: stdlib modules import (datetime, random, json)", async () => {
  const tool = await pythonToolWithRealRuntime();
  const result = await tool.execute({
    code: "import datetime, json, random\nprint(datetime.date(2021, 3, 4).isoformat(), json.dumps({'k': 2}), random.__name__)",
  });
  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(result.stdout, "2021-03-04 {\"k\": 2} random");
});

Deno.test("pyodide REAL: a python error is a bounded {ok:false,error}, never a fabricated result", async () => {
  const tool = await pythonToolWithRealRuntime();
  const result = await tool.execute({ code: "print('before')\nundefined_name_xyz" });
  assertEquals(result.ok, undefined, "the tool surfaces the failure shape");
  assert(String(result.error).length > 0, "error carries the traceback");
  // The error is the interpreter's real traceback (bounded to 200 chars by the
  // adapter) — never a JS-level echo or a fabricated success.
  assertStringIncludes(String(result.error), "Traceback (most recent call last)");
});

// ── the pure adapter contract (mock runtimes, as before) ────────────────────
Deno.test("pyodide: runPython has NO byte budgets (dptw); the timeout + non-eval entrypoint stay", async () => {
  const mockRuntime = (behavior) => ({ runPythonAsync: behavior, setStdout: () => {}, setStdin: () => {} });
  const over = await runPython(mockRuntime(async () => {}), { code: "x", stdin: "y".repeat(2048 + 1) });
  assertEquals(over.ok, true, "stdin past the old budget runs");
  const empty = await runPython(mockRuntime(async () => {}), { code: "" });
  assertEquals(empty.error, "python_empty_code");
  const bigOut = "z".repeat(64 * 1024 + 1);
  const big = await runPython({ runPythonAsync: async () => {}, setStdout: ({ batched }) => batched(bigOut), setStdin: () => {} }, { code: "print()" });
  assertEquals(big.ok, true, "stdout past the old budget arrives");
  assertEquals(big.stdout, bigOut, "the whole output is delivered");
  const slow = await runPython({ runPythonAsync: () => new Promise(() => {}), setStdout: () => {}, setStdin: () => {} }, { code: "sleep", timeoutMs: 5 });
  assertEquals(slow.ok, false);
  assertEquals(slow.error, "python_run_timeout");
  const seen = [];
  let emit = null;
  const ok = await runPython({
    runPythonAsync: (code) => { seen.push(code); emit("hello"); },
    setStdout: ({ batched }) => { emit = batched; },
    setStdin: ({ stdin }) => { seen.push(`stdin1:${stdin()}`); seen.push(`stdin2:${stdin()}`); },
  }, { code: "print(2)", stdin: "data" });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "hello");
  assertEquals(seen[0], "stdin1:data", "stdin flows through setStdin's provider");
  assertEquals(seen[1], "stdin2:undefined", "one-shot stdin: the second read is EOF");
  assertEquals(seen[2], "print(2)", "the code reaches only runPythonAsync (never a JS eval path)");
});

Deno.test("pyodide: a JS-eval-shaped runtime (no runPythonAsync) is refused fail-closed", async () => {
  const evil = { eval: (code) => code, runPython: () => "x" };
  const r = await runPython(evil, { code: "print(1)" });
  assertEquals(r.ok, false);
  assertEquals(r.error, "python_unavailable");
});

Deno.test("pyodide: the python tool fails closed when no runtime provider is injected, and runs when injected", async () => {
  const { pythonTool, setPythonRuntimeProvider } = await import("../extension/lib/python-tool.js");
  // Module-level provider state persists across tests in this file: reset to
  // the default unavailable provider first, then assert the honest degrade.
  setPythonRuntimeProvider(async () => null);
  const unavailable = await pythonTool.execute({ code: "print(1)" });
  assertEquals(unavailable.ok, undefined);
  assert(String(unavailable.error).includes("python unavailable"), "honest unavailable when the runtime is not admitted");
  setPythonRuntimeProvider(async () => ({
    runPythonAsync: async () => {},
    setStdout: ({ batched }) => batched("42\n"),
    setStdin: () => {},
  }));
  const ok = await pythonTool.execute({ code: "print(6*7)" });
  assertEquals(ok.ok, true);
  assertEquals(ok.stdout, "42\n");
  const over = await pythonTool.execute({ code: "x".repeat(2048 + 1) });
  assertEquals(over.ok, true, `past the old code budget runs: ${JSON.stringify(over).slice(0, 120)}`);
});

// ── the runtime-provider transport (the setPythonRuntimeProvider seam, SW side)
// The production provider is created by createPythonRuntimeProvider and injected
// into python-tool.js at SW boot; every python_execute then runs through the
// python-execution adapter into the facade, which transports the run to the
// offscreen host. These tests drive the FULL seam (pythonTool.execute).
async function providerBacked({ ensureHost, sendMessage, timeoutMs }) {
  const { pythonTool, setPythonRuntimeProvider } = await import("../extension/lib/python-tool.js");
  setPythonRuntimeProvider(
    createPythonRuntimeProvider({ ensureHost, sendMessage, timeoutMs }).provider,
  );
  return pythonTool;
}

Deno.test("pyodide provider: python_execute transports code+stdin to the host and returns captured stdout", async () => {
  const sent = [];
  const tool = await providerBacked({
    ensureHost: async () => ({ ok: true }),
    sendMessage: async (message) => { sent.push(message); return { ok: true, stdout: "2" }; },
  });
  const result = await tool.execute({ code: "print(1+1)" });
  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(result.stdout, "2", "captured stdout arrives whole through the facade");
  assertEquals(sent[0].type, "python.run");
  assertEquals(sent[0].code, "print(1+1)", "the code reaches only the run message");
  assertEquals(sent[0].stdin, "", "empty stdin is transported");
  assert(typeof sent[0].runId === "string");
});

Deno.test("pyodide provider: a host that cannot open degrades to unavailable, then retries", async () => {
  let fails = true;
  const tool = await providerBacked({
    ensureHost: async () => (fails ? { ok: false } : { ok: true }),
    sendMessage: async () => ({ ok: true, stdout: "x" }),
  });
  const down = await tool.execute({ code: "print(1)" });
  assert(down.ok !== true && String(down.error).includes("python_unavailable_host"), JSON.stringify(down));
  fails = false; // the next run retries the host
  const ok = await tool.execute({ code: "print(1)" });
  assertEquals(ok.ok, true, JSON.stringify(ok));
  assertEquals(ok.stdout, "x");
});

Deno.test("pyodide provider: a dead host channel is retried next run", async () => {
  let dead = true;
  const tool = await providerBacked({
    ensureHost: async () => ({ ok: true }),
    sendMessage: async () => (dead ? null : { ok: true, stdout: "y" }),
  });
  const down = await tool.execute({ code: "print(1)" });
  assert(down.ok !== true && String(down.error).includes("python_unavailable_host"), JSON.stringify(down));
  dead = false;
  const ok = await tool.execute({ code: "print(1)" });
  assertEquals(ok.ok, true, JSON.stringify(ok));
  assertEquals(ok.stdout, "y");
});

Deno.test("pyodide provider: a silent host hits the fence as python_run_timeout", async () => {
  const tool = await providerBacked({
    ensureHost: async () => ({ ok: true }),
    sendMessage: () => new Promise(() => {}), // never answers — the fence must fire
    timeoutMs: 50,
  });
  const result = await tool.execute({ code: "while True: pass" });
  assert(result.ok !== true, JSON.stringify(result));
  assertEquals(String(result.error), "python_run_timeout");
});

Deno.test("pyodide provider: host errors propagate as bounded {error}, never a fabricated result", async () => {
  const tool = await providerBacked({
    ensureHost: async () => ({ ok: true }),
    sendMessage: async () => ({ ok: false, error: "python_run_timeout" }),
  });
  const result = await tool.execute({ code: "print(1)" });
  assert(result.ok !== true, JSON.stringify(result));
  assertEquals(String(result.error), "python_run_timeout");
});

// ── the offscreen host (python-host.js) ─────────────────────────────────────
function fakeResponse(bytes) {
  return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function diskFetch() {
  return async (url) => {
    const file = url.split("/").pop();
    return fakeResponse(await Deno.readFile(`${RUNTIME_SRC}${file}`));
  };
}

Deno.test("pyodide host: a substituted runtime byte fails closed (integrity mismatch)", async () => {
  const calls = [];
  const host = registerPythonHost({
    getURL: (rel) => `ext://${rel}`,
    fetchImpl: async () => { calls.push("fetch"); return fakeResponse(new Uint8Array([1, 2, 3])); },
    WorkerCtor: class { postMessage() {} terminate() {} },
  });
  const result = await host.executeRun({ code: "print(1)" });
  assertEquals(result.ok, false);
  assert(String(result.error).includes("python_runtime_integrity_mismatch"), result.error);
});

Deno.test("pyodide host: verified pinned bytes run in a fresh worker per run", async () => {
  const workerRuns = [];
  class FakeWorker {
    constructor(url) { this.url = url; workerRuns.push(url); }
    postMessage(message) {
      this.message = message;
      queueMicrotask(() => this.onmessage({ data: { runId: message.runId, ok: true, stdout: "42\n" } }));
    }
    terminate() { this.terminated = true; }
  }
  const host = registerPythonHost({ getURL: (rel) => `ext://${rel}`, fetchImpl: diskFetch(), WorkerCtor: FakeWorker });
  const result = await host.executeRun({ runId: "r1", code: "print(6*7)" });
  assertEquals(result.ok, true);
  assertEquals(result.stdout, "42\n");
  assert(workerRuns[0].endsWith("dist/wasm-tools/python/python-worker.js"), workerRuns[0]);
});

Deno.test("pyodide host: empty code is refused before any worker spawns", async () => {
  const host = registerPythonHost({ getURL: (rel) => `ext://${rel}`, fetchImpl: diskFetch(), WorkerCtor: class { postMessage() {} terminate() {} } });
  const result = await host.executeRun({ code: "" });
  assertEquals(result.error, "python_empty_code");
});

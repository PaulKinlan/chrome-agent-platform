// @ts-nocheck
// tests/python-execution-gate.test.ts — CAP-FB-20260823-PYODIDE-PYTHON-01 / brv
//
// Verifies:
// 1. python_execute tool definition, argument schema, and routing.
// 2. runPython execution over the non-eval Pyodide interpreter entrypoint.
// 3. Stdin/stdout capture and error handling (syntax errors, exceptions).
// 4. Timeout enforcement on infinite loops.
// 5. Fail-closed behavior when runtime is absent or malformed (no JS eval).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { runPython, PYTHON_EXEC_BOUNDS } from "../extension/lib/python-execution.js";
import { pythonTool, pythonExecuteTool, setPythonRuntimeProvider } from "../extension/lib/python-tool.js";
import { managementToolset, MANAGEMENT_TOOL_NAMES } from "../extension/lib/management-tools.js";

Deno.test("python-execute: management toolset exports python_execute with correct schema", () => {
  assert(MANAGEMENT_TOOL_NAMES.includes("python_execute"), "python_execute is in MANAGEMENT_TOOL_NAMES");
  const toolset = managementToolset({ callRoute: () => Promise.resolve({ ok: true }) });
  assert("python_execute" in toolset, "python_execute is in management toolset");
  assert(toolset.python_execute.description.includes("Pyodide"), "description mentions Pyodide runtime");

  // Schema parsing
  const valid = toolset.python_execute.inputSchema.parse({ code: "print('hello')" });
  assertEquals(valid.code, "print('hello')");
  assertEquals(valid.stdin, undefined);

  const withStdin = toolset.python_execute.inputSchema.parse({ code: "import sys; print(sys.stdin.read())", stdin: "input-data" });
  assertEquals(withStdin.stdin, "input-data");
});

Deno.test("python-execute: python_execute routes to python.execute route", async () => {
  const calls = [];
  const toolset = managementToolset({
    callRoute: async (type, args) => {
      calls.push({ type, args });
      return { ok: true, stdout: "output\n" };
    },
  });

  const res = await toolset.python_execute.execute({ code: "print('test')", stdin: "input" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].type, "python.execute");
  assertEquals(calls[0].args.code, "print('test')");
  assertEquals(calls[0].args.stdin, "input");
  assertEquals(res.ok, true);
});

Deno.test("python-execute: runPython executes code and captures stdout via Pyodide interface", async () => {
  let executedCode = "";
  const mockPyodide = {
    setStdout({ batched }) {
      this._stdout = batched;
    },
    setStdin({ stdin }) {
      this._stdin = stdin;
    },
    async runPythonAsync(code) {
      executedCode = code;
      if (this._stdout) {
        this._stdout("result: 42\n");
      }
      return null;
    },
  };

  const res = await runPython(mockPyodide, { code: "print('result: 42')" });
  assertEquals(res.ok, true);
  assertEquals(res.stdout, "result: 42\n");
  assertEquals(executedCode, "print('result: 42')");
});

Deno.test("python-execute: runPython captures stdin via Pyodide setStdin", async () => {
  let capturedStdin = "";
  const mockPyodide = {
    setStdout({ batched }) {
      this._stdout = batched;
    },
    setStdin({ stdin }) {
      capturedStdin = stdin();
      this._stdin = stdin;
    },
    async runPythonAsync(code) {
      if (this._stdout) {
        this._stdout(`read: ${capturedStdin}\n`);
      }
      return null;
    },
  };

  const res = await runPython(mockPyodide, { code: "import sys; print(sys.stdin.read())", stdin: "data-123" });
  assertEquals(res.ok, true);
  assertEquals(capturedStdin, "data-123");
  assertEquals(res.stdout, "read: data-123\n");
});

Deno.test("python-execute: runPython surfaces Python exceptions honestly", async () => {
  const mockPyodide = {
    setStdout() {},
    setStdin() {},
    async runPythonAsync() {
      throw new Error("ZeroDivisionError: division by zero");
    },
  };

  const res = await runPython(mockPyodide, { code: "1 / 0" });
  assertEquals(res.ok, false);
  assert(res.error.includes("ZeroDivisionError: division by zero"));
});

Deno.test("python-execute: runPython enforces timeout on long-running code", async () => {
  const mockPyodide = {
    setStdout() {},
    setStdin() {},
    async runPythonAsync() {
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
  };

  const res = await runPython(mockPyodide, { code: "while True: pass", timeoutMs: 50 });
  assertEquals(res.ok, false);
  assertEquals(res.error, "python_run_timeout");
});

Deno.test("python-execute: runPython rejects empty code", async () => {
  const mockPyodide = {
    runPythonAsync: async () => {},
  };
  const res = await runPython(mockPyodide, { code: "" });
  assertEquals(res.ok, false);
  assertEquals(res.error, "python_empty_code");
});

Deno.test("python-execute: runPython refuses runtime without runPythonAsync (non-eval invariant)", async () => {
  // A runtime that only offers eval/Function but no runPythonAsync is refused
  const fakeEvalRuntime = {
    eval: (c) => eval(c),
  };
  const res = await runPython(fakeEvalRuntime, { code: "print(1)" });
  assertEquals(res.ok, false);
  assertEquals(res.error, "python_unavailable");
});

Deno.test("python-execute: pythonTool fails closed when runtime provider returns null", async () => {
  setPythonRuntimeProvider(async () => null);
  const res = await pythonTool.execute({ code: "print(1)" });
  assertEquals(res.ok, undefined);
  assert(res.error.includes("python unavailable"));
});

Deno.test("python-execute: pythonTool executes when runtime provider is armed", async () => {
  setPythonRuntimeProvider(async () => ({
    setStdout({ batched }) { this._out = batched; },
    setStdin() {},
    async runPythonAsync(code) {
      this._out?.(`executed: ${code}\n`);
    },
  }));

  const res = await pythonTool.execute({ code: "2 + 2" });
  assertEquals(res.ok, true);
  assertEquals(res.stdout, "executed: 2 + 2\n");
});

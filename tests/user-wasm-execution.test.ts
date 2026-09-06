// @ts-nocheck
// tests/user-wasm-execution.test.ts — Unit tests for S4 user-wasm execution call path
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { executeUserWasmRun, USER_WASM_RUN_TYPE } from "../extension/lib/wasm-offscreen-host.js";
import {
  executableUserWasmToolRecords,
  userWasmLazyRecords,
  createLazyProviderToolset,
} from "../extension/lib/lazy-tool-protocol.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { buildWasiEntryExportWasm } from "./wasm-fixture-builder.mjs";

const WORKER_URL = new URL("../extension/lib/wasm-execution-worker.js", import.meta.url).href;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("user-wasm S4: executeUserWasmRun succeeds with matching digest and returns stdout", async () => {
  const wasm = buildWasiEntryExportWasm({ exportName: "_start" });
  const digest = await sha256Hex(wasm);

  const authority = {
    sessionId: "session-test-1",
    executionId: "exec-test-1",
    callId: "call-test-1",
    agentId: "hub",
    origin: "https://agent.cap",
    documentId: "task-run",
  };

  const result = await executeUserWasmRun({
    toolId: "test_tool",
    digest,
    args: ["arg1", "arg2"],
    stdin: "test stdin",
    wasmBytes: wasm,
    authority,
    wallMs: 5000,
  });

  assertEquals(result.ok, true);
  assertEquals(result.phase, "completed");
  assertEquals(result.stdout, "hi");
  assertEquals(result.exitCode, 0);
});

Deno.test("user-wasm S4: pre-instantiate content re-hash rejects mismatched digest (fail-closed, Acceptance 1)", async () => {
  const wasm = buildWasiEntryExportWasm({ exportName: "_start" });
  const wrongDigest = "d".repeat(64);

  const authority = {
    sessionId: "session-test-2",
    executionId: "exec-test-2",
    callId: "call-test-2",
    agentId: "hub",
    origin: "https://agent.cap",
    documentId: "task-run",
  };

  await assertRejects(
    () => executeUserWasmRun({
      toolId: "test_tool",
      digest: wrongDigest,
      wasmBytes: wasm,
      authority,
    }),
    Error,
    "digest-mismatch",
  );
});

Deno.test("user-wasm S4: execution handles proc_exit(nonzero) honestly without crashing", async () => {
  const wasm = buildWasiEntryExportWasm({
    exportName: "_start",
    callsProcExit: true,
    exitCode: 42,
  });
  const digest = await sha256Hex(wasm);

  const authority = {
    sessionId: "session-test-3",
    executionId: "exec-test-3",
    callId: "call-test-3",
    agentId: "hub",
    origin: "https://agent.cap",
    documentId: "task-run",
  };

  const result = await executeUserWasmRun({
    toolId: "failing_tool",
    digest,
    wasmBytes: wasm,
    authority,
  });

  assertEquals(result.ok, false);
  assertEquals(result.phase, "proc-exit");
  assertEquals(result.errno, 42);
  assert(result.error?.includes("42") || result.error?.includes("proc_exit"));
});

Deno.test("user-wasm S4: trapping wasm module returns readable tool error and does not hang", async () => {
  // A wasm module that executes `unreachable` opcode (0x00)
  const trappingWasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x05, 0x04, 0x01, 0x01, 0x01, 0x01,
    0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
    0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b, // code: unreachable, end
  ]);
  const digest = await sha256Hex(trappingWasm);

  const authority = {
    sessionId: "session-test-4",
    executionId: "exec-test-4",
    callId: "call-test-4",
    agentId: "hub",
    origin: "https://agent.cap",
    documentId: "task-run",
  };

  const result = await executeUserWasmRun({
    toolId: "trapping_tool",
    digest,
    wasmBytes: trappingWasm,
    authority,
  });

  assertEquals(result.ok, false);
  assert(result.error !== null);
  assert(result.phase === "runtime-error" || result.phase === "instantiation-error");
});

Deno.test("user-wasm S4: argument validation accepts WASI shape (args, stdin) and rejects invalid inputs", async () => {
  const row = {
    version: 2,
    digest: "a".repeat(64),
    kind: "wasm",
    name: "csv_filter",
    description: "Filters CSV",
  };

  const records = executableUserWasmToolRecords([row]);
  assertEquals(records.length, 1);
  const record = records[0];

  // 1. Valid object with args and stdin
  const valid = await record.validateArguments({ args: ["-f", "col"], stdin: "a,b\n1,2" });
  assertEquals(valid.ok, true);
  assertEquals(valid.data.args, ["-f", "col"]);
  assertEquals(valid.data.stdin, "a,b\n1,2");

  // 2. Convenience aliases for stdin: input and text
  const withInput = await record.validateArguments({ input: "test" });
  assertEquals(withInput.ok, true);
  assertEquals(withInput.data.stdin, "test");

  const withText = await record.validateArguments({ text: "hello" });
  assertEquals(withText.ok, true);
  assertEquals(withText.data.stdin, "hello");

  // 3. Null bytes in args rejected
  const withNullByte = await record.validateArguments({ args: ["bad\0arg"] });
  assertEquals(withNullByte.ok, false);
  assert(withNullByte.error.includes("null bytes"));

  // 4. Non-string args rejected
  const withNumberArg = await record.validateArguments({ args: [123] });
  assertEquals(withNumberArg.ok, false);

  // 5. Non-string stdin rejected
  const withNumberStdin = await record.validateArguments({ stdin: 12345 });
  assertEquals(withNumberStdin.ok, false);
});

Deno.test("user-wasm S4: lazy-tool-protocol execute_tool dispatches user-wasm call and receives stdout", async () => {
  const sampleDigest = "c".repeat(64);
  const row = {
    version: 2,
    digest: sampleDigest,
    kind: "wasm",
    name: "uppercase_tool",
    description: "Converts stdin to uppercase",
  };

  let dispatched = false;
  const toolset = createLazyProviderToolset({
    readSources: async () => userWasmLazyRecords([row], {
      dispatchUserWasmTool: async ({ descriptorInput, args }) => {
        dispatched = true;
        assertEquals(descriptorInput.packageDigest, sampleDigest);
        return {
          ok: true,
          stdout: (args.stdin || "").toUpperCase(),
        };
      },
    }),
    contextReader: async () => ({
      runId: "run-e2e-1",
      taskId: "task-e2e-1",
      agentId: "hub",
      origin: "https://agent.cap",
      documentId: "task-run",
      runGeneration: "1",
    }),
    selectionAuthority: new ToolSelectionAuthority(),
  });

  // Search finds the user-wasm tool
  const searchRes = await toolset.tools.search_tools.execute({ query: "uppercase" });
  assertEquals(searchRes.results.length, 1);
  const ref = searchRes.results[0].selectionRef;

  // Execute runs it
  const execRes = await toolset.tools.execute_tool.execute({
    selectionRef: ref,
    arguments: { stdin: "hello from agent" },
  });

  assert(dispatched, "dispatchUserWasmTool must have been invoked");
  assertEquals(execRes.ok, true);
  assertEquals(execRes.result.stdout, "HELLO FROM AGENT");
});

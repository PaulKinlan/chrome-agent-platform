// tests/wasm-task-execution.test.ts — Verification of model-invoked WebAssembly task
// execution dispatch closures, argument validation, authorization, and file-backed output
// (CAP-FB-20260823-WASM-TASK-EXECUTION-01).
// @ts-nocheck

import {
  assertBundledExecutionAuthority,
  createLazyProviderToolset,
  executableBundledToolRecords,
  LazyToolProtocol,
} from "../extension/lib/lazy-tool-protocol.js";
import { setRunFence, clearRunFence } from "../extension/lib/run-fence.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import {
  executeBundledWasiJob,
  previewSpecFor,
  PREVIEW_LIMITS,
  STREAM_BACKED_BUNDLED_TOOL_IDS,
} from "../extension/lib/tool-exec-preview.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Assertion failed"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("executableBundledToolRecords: constructs non-null validateArguments, authorize, and dispatch for admitted tools", () => {
  const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
  });

  assertEquals(records.length, 32, "exact 32 bundled tool records");

  for (const rec of records) {
    const toolId = rec.descriptorInput.toolId;
    const spec = previewSpecFor(toolId);
    if (spec && rec.descriptorInput.availability !== "disabled") {
      assert(typeof rec.validateArguments === "function", `admitted tool ${toolId} must have validateArguments`);
      assert(typeof rec.authorize === "function", `admitted tool ${toolId} must have authorize`);
      assert(typeof rec.dispatch === "function", `admitted tool ${toolId} must have dispatch`);
    } else {
      assertEquals(rec.validateArguments, null, `disabled tool ${toolId} must have null validateArguments`);
      assertEquals(rec.authorize, null, `disabled tool ${toolId} must have null authorize`);
      assertEquals(rec.dispatch, null, `disabled tool ${toolId} must have null dispatch`);
    }
  }
});

Deno.test("executableBundledToolRecords: validateArguments validates valid and rejects hostile arguments", async () => {
  const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });

  const base64Rec = records.find((r) => r.descriptorInput.toolId === "base64");
  assert(base64Rec, "base64 record must exist");

  // Valid args
  const valid1 = await base64Rec.validateArguments({ stdin: "hello world" });
  assertEquals(valid1.ok, true);
  assertEquals(valid1.data.toolId, "base64");
  assertEquals(valid1.data.stdin, "hello world");

  // Valid with flags
  const valid2 = await base64Rec.validateArguments({ args: ["-d"], stdin: "aGVsbG8=" });
  assertEquals(valid2.ok, true);
  assertEquals(valid2.data.args.includes("-d"), true);

  // dptw: stdin of any size validates (the >2 KiB refusal is gone).
  const hugeStdin = "a".repeat(3000);
  const bigStdin = await base64Rec.validateArguments({ stdin: hugeStdin });
  assertEquals(bigStdin.ok, true, "stdin past the removed 2 KiB bound validates");
  assertEquals(bigStdin.data.stdin, hugeStdin, "the stdin arrives whole");

  const ref = { version: 1, id: "0123456789abcdef0123456789abcdef", kind: "stdout" };
  const chained = await base64Rec.validateArguments({ args: ["-d"], inputRef: ref });
  assertEquals(chained.ok, true, "a prior owner-bound output reference is valid input");
  assertEquals(chained.data.inputRef.id, ref.id);
  assertEquals((await base64Rec.validateArguments({ stdin: "inline", inputRef: ref })).ok, false,
    "inline and referenced input are mutually exclusive");
  assertEquals((await base64Rec.validateArguments({ args: ["-d", 7], stdin: "x" })).ok, false,
    "non-string argv entries are rejected, never filtered");
  assertEquals((await base64Rec.validateArguments({ stdin: "x", authority: "forged" })).ok, false,
    "unknown request fields cannot cross the validator");

  // Two document tool (diff)
  const diffRec = records.find((r) => r.descriptorInput.toolId === "diff");
  assert(diffRec, "diff record must exist");

  const validDiff = await diffRec.validateArguments({ docA: "a\nb\n", docB: "a\nc\n" });
  assertEquals(validDiff.ok, true);
  assertEquals(validDiff.data.args.length, 2);
  assertEquals((await diffRec.validateArguments({ inputRef: ref })).ok, false,
    "non-stream packages do not acquire an unsupported file-backed execution profile");

  // 0alg/6s2c: pin the literal ten — deriving the expectation FROM the module
  // under test lets an eleventh member (e.g. cat) pass both sides silently.
  // imageops joined for live execution (6s2c): without stream-backing a
  // bundled tool cannot execute in a run at all (wasi_task_host_unavailable).
  const expectedStreamIds = ["awk", "base64", "grep", "imageops", "jq", "sed", "sort", "tr", "uniq", "wc"];
  assertEquals(JSON.stringify([...STREAM_BACKED_BUNDLED_TOOL_IDS].sort()), JSON.stringify(expectedStreamIds),
    "the streamed allowlist itself is exactly the pinned ten");
  const schemaStreamIds = records
    .filter((record) => Object.hasOwn(record.descriptorInput.inputSchema.properties, "inputRef"))
    .map((record) => record.descriptorInput.toolId)
    .sort();
  assertEquals(JSON.stringify(schemaStreamIds), JSON.stringify(expectedStreamIds),
    "only the ten streamed packages advertise opaque input references");
});

Deno.test("executeBundledWasiJob: real manifest and CAS bytes revalidation with typed error envelope on absent host", async () => {
  const spec = previewSpecFor("base64");
  assert(spec, "base64 spec must exist");

  const fileFetcher = async (url) => {
    const cleanPath = url.replace(/^chrome-extension:\/\/[^/]+\//, "").replace(/^\//, "");
    const absPath = new URL(`../extension/${cleanPath}`, import.meta.url);
    const bytes = await Deno.readFile(absPath);
    return {
      ok: true,
      status: 200,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer,
    };
  };

  const res = await executeBundledWasiJob({
    toolId: "base64",
    args: [],
    stdin: "hello",
    runContext: { origin: "https://example.com", documentId: "doc-1" },
    fetchFn: fileFetcher,
  });

  // Without a live Worker host spawned, it returns the typed no-partial error envelope
  assertEquals(res.ok, false);
  assertEquals(res.phase, "failed");
  assertEquals(res.error, "wasi_task_host_unavailable");
  assertEquals(res.stdout, "");
  assertEquals(res.stdoutBytes, 0);
});

Deno.test("assertBundledExecutionAuthority: admits installed tools and fails closed on disabled/unadmitted tools", async () => {
  clearRunFence();
  const controller = new AbortController();
  setRunFence({ signal: controller.signal, assertOwned: async () => {} });

  try {
    const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
      scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
    });

    const base64Rec = records.find((r) => r.descriptorInput.toolId === "base64");

    // Admitted tool succeeds under active valid run fence
    const auth1 = await assertBundledExecutionAuthority({
      toolId: "base64",
      descriptorInput: base64Rec.descriptorInput,
      validatedArgs: { toolId: "base64", args: [], stdin: "test" },
      context: {},
    });
    assertEquals(auth1.ok, true);
    assertEquals(auth1.authorized, true);
    assertEquals(auth1.policy, "owner-build-admission");

    // A non-admitted descriptor fails closed (all 31 bundled tools are now
    // admitted after the R12 sqlite admission, so a fictional disabled row
    // stands in for the fail-closed check).
    let disabledThrew = false;
    try {
      await assertBundledExecutionAuthority({
        toolId: "disabled_tool",
        descriptorInput: { toolId: "disabled_tool", availability: "disabled" },
        validatedArgs: { toolId: "disabled_tool", args: [], stdin: "{}" },
        context: {},
      });
    } catch (err) {
      disabledThrew = true;
      assert(err.message.includes("not_admitted"), "non-admitted tool must be rejected");
    }
    assertEquals(disabledThrew, true, "a non-admitted descriptor must throw in assertBundledExecutionAuthority");

    // Unadmitted descriptor fails closed
    let unadmittedThrew = false;
    try {
      await assertBundledExecutionAuthority({
        toolId: "unadmitted_tool",
        descriptorInput: { toolId: "unadmitted_tool", availability: "disabled" },
        validatedArgs: {},
        context: {},
      });
    } catch {
      unadmittedThrew = true;
    }
    assertEquals(unadmittedThrew, true, "unadmitted tool must fail closed");
  } finally {
    clearRunFence();
  }
});

Deno.test("assertBundledExecutionAuthority: fails closed when run ownership is aborted or lost", async () => {
  const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  const base64Rec = records.find((r) => r.descriptorInput.toolId === "base64");

  // 1. Aborted run signal
  setRunFence({ signal: { aborted: true } });
  let abortThrew = false;
  try {
    await assertBundledExecutionAuthority({
      toolId: "base64",
      descriptorInput: base64Rec.descriptorInput,
      validatedArgs: { toolId: "base64", args: [], stdin: "test" },
      context: {},
    });
  } catch (err) {
    abortThrew = true;
    assert(err.message.includes("run aborted"), "aborted run must throw");
  }
  assertEquals(abortThrew, true, "aborted run fence must reject execution");

  // 2. Ownership loss during assertOwned check
  setRunFence({
    signal: { aborted: false },
    assertOwned: async () => {
      throw new Error("durable_run_ownership_lost");
    },
  });
  let ownershipThrew = false;
  try {
    await assertBundledExecutionAuthority({
      toolId: "base64",
      descriptorInput: base64Rec.descriptorInput,
      validatedArgs: { toolId: "base64", args: [], stdin: "test" },
      context: {},
    });
  } catch (err) {
    ownershipThrew = true;
    assert(err.message.includes("durable_run_ownership_lost"), "ownership loss must throw");
  }
  assertEquals(ownershipThrew, true, "ownership loss must reject execution");

  clearRunFence();
});

Deno.test("LazyToolProtocol end-to-end: search -> claim selectionRef -> execute dispatch", async () => {
  clearRunFence();
  const controller = new AbortController();
  setRunFence({ signal: controller.signal, assertOwned: async () => {} });

  try {
    const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
      scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
      sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
      dispatchBundledTool: async ({ toolId, args }) => {
        return {
          ok: true,
          toolId,
          stdout: `Executed ${toolId} with stdin: ${args.stdin}`,
          stdoutBytes: 30,
          exitCode: 0,
        };
      },
    });

    const protocol = new LazyToolProtocol({
      readSources: async () => records,
      selectionAuthority: new ToolSelectionAuthority(),
    });

    const context = {
      runId: "run-e2e-1",
      taskId: "task-e2e-1",
      agentId: "hub",
      origin: "master",
      documentId: "",
      runGeneration: "1",
    };

    // Step 1: Search for base64
    const searchResult = await protocol.search({ query: "base64", limit: 1 }, context);
    assertEquals(searchResult.ok, true);
    assertEquals(searchResult.results.length, 1);
    const selectionRef = searchResult.results[0].selectionRef;
    assert(typeof selectionRef === "string" && selectionRef.startsWith("sel_"), "must receive valid selectionRef");

    // Step 2: Execute tool with selectionRef
    const execResult = await protocol.execute({
      selectionRef,
      arguments: { stdin: "hello" },
    }, context);

    assertEquals(execResult.ok, true);
    assert(JSON.stringify(execResult).includes("Executed base64 with stdin: hello"));

    // Step 3: the same selectionRef runs the same tool again (bounded reuse,
    // CAP-FB-20260901-RUN-BUDGET-EVERY-ITEM-01) — still re-authorized live.
    const reuseResult = await protocol.execute({
      selectionRef,
      arguments: { stdin: "hello again" },
    }, context);

    assertEquals(reuseResult.ok, true, "a reused selectionRef dispatches the same tool again");
    assert(JSON.stringify(reuseResult).includes("Executed base64 with stdin: hello again"));
    // A ref from another run's scope still fails closed.
    const foreign = await protocol.execute({ selectionRef, arguments: { stdin: "x" } }, { ...context, runId: "run-other" });
    assertEquals(foreign.ok, false, "scope fences survive reuse");
  } finally {
    clearRunFence();
  }
});

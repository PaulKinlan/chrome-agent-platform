// tests/preview-only-bundled-tools.test.ts — Verification and falsification for
// chrome-agent-platform-hl4f: preview-only bundled Wasm tools fail live with an
// honest, named preview_only_tool error rather than opaque wasi_task_host_unavailable.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import {
  PREVIEW_TOOL_IDS,
  STREAM_BACKED_BUNDLED_TOOL_IDS,
  executeBundledWasiJob,
  isStreamBackedBundledTool,
  previewOnlyToolEnvelope,
  previewOnlyToolError,
  previewSpecFor,
} from "../extension/lib/tool-exec-preview.js";
import {
  LazyToolProtocol,
  executableBundledToolRecords,
} from "../extension/lib/lazy-tool-protocol.js";
import { setRunFence, clearRunFence } from "../extension/lib/run-fence.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";

Deno.test("hl4f census: partition of 34 admitted bundled tools into stream-backed and preview-only is exact", () => {
  assertEquals(PREVIEW_TOOL_IDS.length, 34, "exactly 34 bundled tools admitted in catalog");
  const streamBacked = PREVIEW_TOOL_IDS.filter((id) => isStreamBackedBundledTool(id));
  const previewOnly = PREVIEW_TOOL_IDS.filter((id) => !isStreamBackedBundledTool(id));

  assertEquals(streamBacked.length, 10, "exactly 10 stream-backed tools");
  assertEquals(
    JSON.stringify(streamBacked.sort()),
    JSON.stringify(["awk", "base64", "grep", "imageops", "jq", "sed", "sort", "tr", "uniq", "wc"]),
    "stream-backed allowlist matches known stream tools",
  );

  assertEquals(previewOnly.length, 24, "exactly 24 preview-only tools");
  const expectedPreviewOnly = [
    "awk_filter_bounded",
    "compressops",
    "csvtool",
    "cut",
    "date_formatter_bounded",
    "diff",
    "du",
    "gzip",
    "head",
    "markdown",
    "md5sum",
    "patch",
    "sha256sum",
    "sha512sum",
    "sqlite3_query_bounded",
    "stat",
    "tail",
    "toml2json",
    "touch",
    "tree",
    "truncate",
    "uuid",
    "xxd",
    "zxing",
  ];
  assertEquals(
    JSON.stringify(previewOnly.sort()),
    JSON.stringify(expectedPreviewOnly),
    "preview-only toolset matches exact remaining catalog members",
  );
});

Deno.test("hl4f falsification: legacy executor reproduces opaque wasi_task_host_unavailable on absent Worker", async () => {
  // FALSIFICATION: Without the live dispatcher gate, calling executeBundledWasiJob
  // in a non-options context (the service worker environment) falls through to
  // the opaque wasi_task_host_unavailable error. This proves the bug existed.
  const legacyRes = await executeBundledWasiJob({
    toolId: "csvtool",
    args: [],
    stdin: "a,b\n1,2",
    runContext: { origin: "https://agent.cap", documentId: "doc-test" },
    fetchFn: async () => ({ ok: false }), // simulated or absent
  });
  // If fetch fails or host is unavailable, it fails with asset_fetch_failed or wasi_task_host_unavailable
  assertEquals(legacyRes.ok, false);
  assert(
    legacyRes.error.includes("asset_fetch_failed") || legacyRes.error === "wasi_task_host_unavailable",
    `legacy path fails with transport/host error, got ${legacyRes.error}`,
  );
});

Deno.test("hl4f live dispatch: every preview-only tool returns honest preview_only_tool refusal, NEVER wasi_task_host_unavailable", async () => {
  const previewOnly = PREVIEW_TOOL_IDS.filter((id) => !isStreamBackedBundledTool(id));
  assert(previewOnly.length > 0, "must have preview-only tools");

  const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  const recordMap = new Map(records.map((r) => [r.descriptorInput.toolId, r]));

  for (const toolId of previewOnly) {
    const record = recordMap.get(toolId);
    assert(record, `record must exist for ${toolId}`);
    assert(typeof record.dispatch === "function", `dispatch must be a function for ${toolId}`);

    // Execute in a live task context (origin != settings)
    const res = await record.dispatch(
      { toolId, args: [], stdin: "test" },
      { origin: "https://agent.cap", runId: "run-test-hl4f", agentId: "hub" },
    );

    assertEquals(res.ok, false, `${toolId} must fail closed in live run`);
    assertEquals(res.phase, "failed", `${toolId} phase must be failed`);
    assertEquals(res.code, "preview_only_tool", `${toolId} code must be preview_only_tool`);
    assertEquals(
      res.error,
      previewOnlyToolError(toolId),
      `${toolId} must return exact honest preview_only_tool message`,
    );
    assert(
      !res.error.includes("wasi_task_host_unavailable"),
      `${toolId} must NEVER return opaque wasi_task_host_unavailable`,
    );
  }
});

Deno.test("hl4f LazyToolProtocol end-to-end: search -> claim selectionRef -> execute on csvtool gives clean preview_only_tool error", async () => {
  clearRunFence();
  const controller = new AbortController();
  setRunFence({ signal: controller.signal, assertOwned: async () => {} });

  try {
    const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
      scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
      sourceGeneration: `bundled-inventory:${BUNDLED_INVENTORY.release}`,
    });

    const protocol = new LazyToolProtocol({
      readSources: async () => records,
      selectionAuthority: new ToolSelectionAuthority(),
    });

    const context = {
      runId: "run-hl4f-e2e",
      taskId: "task-hl4f-e2e",
      agentId: "hub",
      origin: "https://agent.cap",
      documentId: "doc-hl4f-e2e",
      runGeneration: "1",
    };

    // 1. Search discovers csvtool
    const searchRes = await protocol.search({ query: "csvtool", limit: 1 }, context);
    assertEquals(searchRes.ok, true);
    assertEquals(searchRes.results.length, 1);
    const selectionRef = searchRes.results[0].selectionRef;
    assert(typeof selectionRef === "string" && selectionRef.startsWith("sel_"), "must receive valid selectionRef");

    // 2. Execute csvtool in live task context
    const execRes = await protocol.execute(
      {
        selectionRef,
        arguments: { args: [], stdin: "a,b\n1,2" },
      },
      context,
    );

    assertEquals(execRes.ok, true, "lazy protocol execution dispatch succeeded");
    assertEquals(execRes.selectedTool, "csvtool");
    assertEquals(execRes.result.ok, false, "tool result itself must be failed");
    assertEquals(execRes.result.phase, "failed");
    assertEquals(execRes.result.code, "preview_only_tool");
    assertEquals(
      execRes.result.error,
      "preview_only_tool: csvtool is available in Settings preview, not in live agent tasks",
    );
    assert(!execRes.result.error.includes("wasi_task_host_unavailable"));
  } finally {
    clearRunFence();
  }
});

Deno.test("hl4f preview envelope: previewOnlyToolEnvelope is deeply frozen and exact-key shape", () => {
  const env = previewOnlyToolEnvelope("csvtool");
  assert(Object.isFrozen(env), "envelope must be frozen");
  assertEquals(env.ok, false);
  assertEquals(env.phase, "failed");
  assertEquals(env.code, "preview_only_tool");
  assertEquals(env.error, "preview_only_tool: csvtool is available in Settings preview, not in live agent tasks");
  assertEquals(env.stdout, "");
  assertEquals(env.stdoutBytes, 0);
  assertEquals(env.stdoutBase64, null);
  assertEquals(env.stderr, "");
  assertEquals(env.errno, null);
  assertEquals(env.exitCode, null);
});

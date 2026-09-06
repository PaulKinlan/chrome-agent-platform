// tests/bundled-tools-live-execution.test.ts — chrome-agent-platform-ten9
// (owner directive 2026-09-06: NO tool may be preview-gated). Replaces the hl4f
// contract, which pinned an honest preview_only_tool refusal for 24 of the 34
// admitted bundled tools — that refusal must NEVER come back. Every admitted
// bundled tool is findable via search_tools, selectable, and dispatches through
// the real WASI job executor in live agent tasks. In the Deno unit environment
// the executor fails at the transport layer (asset_fetch_failed /
// wasi_task_host_unavailable) — reaching THE EXECUTOR is the unit-level proof;
// real in-browser execution is proven by scripts/kat-bundled-execute.ts.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import {
  PREVIEW_TOOL_IDS,
  STREAM_BACKED_BUNDLED_TOOL_IDS,
  isStreamBackedBundledTool,
  executeBundledWasiJob,
} from "../extension/lib/tool-exec-preview.js";
import {
  LazyToolProtocol,
  executableBundledToolRecords,
} from "../extension/lib/lazy-tool-protocol.js";
import { setRunFence, clearRunFence } from "../extension/lib/run-fence.js";
import { ToolSelectionAuthority } from "../extension/lib/tool-selection.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";

const LIVE_CONTEXT = { origin: "https://agent.cap", runId: "run-ten9", agentId: "hub", documentId: "doc-ten9" };

Deno.test("ten9 census: 34 admitted bundled tools; the formerly preview-only 24 are named and none is gated", () => {
  assertEquals(PREVIEW_TOOL_IDS.length, 34, "exactly 34 bundled tools admitted in catalog");
  assertEquals(STREAM_BACKED_BUNDLED_TOOL_IDS.length, 10, "10 tools keep stream-ref input capability");
  const formerlyPreviewOnly = PREVIEW_TOOL_IDS.filter((id) => !isStreamBackedBundledTool(id));
  assertEquals(formerlyPreviewOnly.length, 24, "the 24 un-gated tools are present");
  for (const id of ["gzip", "sha256sum", "uuid", "csvtool", "toml2json", "stat", "zxing", "markdown"]) {
    assert(formerlyPreviewOnly.includes(id), `${id} (explicitly named in the ten9 directive) must be admitted`);
  }
});

Deno.test("ten9 GUARD: live dispatch of EVERY admitted bundled tool reaches the executor — preview_only_tool must never return", async () => {
  const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  const recordMap = new Map(records.map((r) => [r.descriptorInput.toolId, r]));
  assertEquals(records.length, 35, "every admitted tool exposes an executable record (34 wasi + 1 call-export)");

  for (const toolId of PREVIEW_TOOL_IDS) {
    const record = recordMap.get(toolId);
    assert(record, `record must exist for ${toolId}`);
    assert(typeof record.dispatch === "function", `dispatch must be a function for ${toolId}`);

    // Live task context (origin != settings). The executor fails here at the
    // transport layer (no Worker/fetch target in Deno) — that failure PROVES
    // the dispatch reached the executor instead of a preview refusal.
    const res = await record.dispatch({ toolId, args: [], stdin: "test" }, { ...LIVE_CONTEXT });
    assertEquals(res.ok, false, `${toolId} fails closed in the unit environment`);
    assertEquals(res.phase, "failed", `${toolId} phase must be failed`);
    assert(
      res.code !== "preview_only_tool",
      `${toolId} must NEVER be preview-gated (got preview_only_tool — the ten9 gate came back)`,
    );
    assert(
      !String(res.error || "").includes("preview_only_tool"),
      `${toolId} error must not carry the preview_only_tool refusal`,
    );
    assert(
      String(res.error || "").includes("asset_fetch_failed") ||
        String(res.error || "").includes("wasi_task_host_unavailable") ||
        String(res.error || "").includes("unknown_bundled_tool") ||
        String(res.error || "").includes("invalid_input"),
      `${toolId} must fail at the executor/validator, got: ${res.error}`,
    );
  }
});

Deno.test("ten9 LazyToolProtocol end-to-end: search -> claim -> execute on csvtool DISPATCHES (never preview-refuses)", async () => {
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
      runId: "run-ten9-e2e",
      taskId: "task-ten9-e2e",
      agentId: "hub",
      origin: "https://agent.cap",
      documentId: "doc-ten9-e2e",
      runGeneration: "1",
    };

    const searchRes = await protocol.search({ query: "csvtool", limit: 1 }, context);
    assertEquals(searchRes.ok, true);
    assertEquals(searchRes.results.length, 1);
    const selectionRef = searchRes.results[0].selectionRef;
    assert(typeof selectionRef === "string" && selectionRef.startsWith("sel_"), "must receive valid selectionRef");

    const execRes = await protocol.execute(
      { selectionRef, arguments: { args: [], stdin: "a,b\n1,2" } },
      context,
    );

    assertEquals(execRes.ok, true, "lazy protocol execution dispatched");
    assertEquals(execRes.selectedTool, "csvtool");
    assert(
      execRes.result.code !== "preview_only_tool",
      "csvtool must never be preview-refused in a live run (ten9 gate came back)",
    );
    assert(
      !String(execRes.result.error || "").includes("preview_only_tool"),
      "csvtool error must not carry the preview refusal",
    );
  } finally {
    clearRunFence();
  }
});

Deno.test("ten9 structural guard: the lazy protocol source contains no preview-only gate", async () => {
  // Removing the property a deleted test protected (hl4f's honest-refusal
  // coverage) requires a guard that fails if the gate is reintroduced. The
  // dispatcher must route admitted bundled tools to the executor directly.
  const src = await Deno.readTextFile(new URL("../extension/lib/lazy-tool-protocol.js", import.meta.url));
  assert(!src.includes("previewOnlyToolEnvelope"), "previewOnlyToolEnvelope must not be referenced by the protocol");
  assert(
    !/preview_only_tool/.test(src),
    "the protocol must never synthesize a preview_only_tool refusal",
  );
});

Deno.test("ten9 falsification: executor-level transport failure is honest (no opaque success)", async () => {
  const res = await executeBundledWasiJob({
    toolId: "csvtool",
    args: [],
    stdin: "a,b\n1,2",
    runContext: { origin: "https://agent.cap", documentId: "doc-test" },
    fetchFn: async () => ({ ok: false }),
  });
  assertEquals(res.ok, false);
  assert(
    String(res.error || "").includes("asset_fetch_failed") ||
      res.error === "wasi_task_host_unavailable",
    `transport failure surfaces honestly, got ${res.error}`,
  );
});

// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { managementToolset, MANAGEMENT_TOOL_NAMES } from "../extension/lib/management-tools.js";
import { TABLE_TOOL_NAMES } from "../extension/lib/table-tool-runtime.js";
import { toolOutputSchema } from "../extension/lib/tool-argument-contract.js";
import { replaySafetyForTool } from "../extension/lib/tool-replay-safety.js";

const canonicalSource = { artifactId: "a_input", format: "cap.table/1" };

Deno.test("table management tools are real lazy-management records over one route", async () => {
  const calls = [];
  const tools = managementToolset({
    callRoute: async (type, body) => { calls.push({ type, body }); return { ok: true, artifactId: "a_result" }; },
  });
  for (const name of TABLE_TOOL_NAMES) {
    assert(MANAGEMENT_TOOL_NAMES.includes(name));
    assert(tools[name], `${name} exists in the live management toolset`);
    assert(typeof tools[name].execute === "function");
    assert(typeof tools[name].inputSchema?.safeParse === "function");
    assert(tools[name].description.includes("artifact") || tools[name].description.includes("table"));
    assertEquals(replaySafetyForTool(name), "idempotent", `${name} replays through its content-derived key`);
    assertEquals(toolOutputSchema(name)["x-cap-output-shape"], "provider-safe-table-metadata");
  }

  const args = { source: canonicalSource, columns: [{ column: "c1" }], outputName: "Projection" };
  const result = await tools.table_select.execute(args);
  assertEquals(result, { ok: true, artifactId: "a_result" });
  assertEquals(calls, [{ type: "table.run", body: { toolId: "table_select", args } }]);
});

Deno.test("table management schemas are closed and carry no caller custody field", () => {
  const tools = managementToolset({ callRoute: async () => ({ ok: true }) });
  const good = tools.table_join.inputSchema.safeParse({
    leftSource: canonicalSource,
    rightSource: { artifactId: "a_right", format: "cap.table/1" },
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1"],
    rightColumns: ["c1"],
  });
  assertEquals(good.success, true);
  assertEquals(tools.table_join.inputSchema.safeParse({ ...good.data, owner: "attacker" }).success, false);
  assertEquals(tools.table_filter.inputSchema.safeParse({
    source: { ...canonicalSource, streamOwner: "attacker" },
    predicate: { column: "c1", op: "is_present" },
  }).success, false);
  assertEquals(tools.table_join.inputSchema.safeParse({ ...good.data, keys: [] }).success, false);
  assertEquals(tools.table_join.inputSchema.safeParse({ ...good.data, keys: Array.from({ length: 9 }, () => ({ left: "c1", right: "c1" })) }).success, false);
  assertEquals(tools.table_join.inputSchema.safeParse({ ...good.data, leftColumns: [], rightColumns: ["c1"] }).success, true, "either requested join projection may be empty");

  const pivotBase = {
    source: canonicalSource,
    rowGroupBy: [],
    pivotColumn: "c1",
    categories: [{ value: "Q1", header: "Quarter 1" }],
    metrics: [{ op: "avg", column: "c2", header: "Average", scale: 2 }],
  };
  assertEquals(tools.table_pivot.inputSchema.safeParse(pivotBase).success, true);
  assertEquals(tools.table_pivot.inputSchema.safeParse({ ...pivotBase, categories: [{ value: null, header: "Missing" }] }).success, false);
  assertEquals(tools.table_pivot.inputSchema.safeParse({ ...pivotBase, metrics: [{ op: "avg", column: "c2", header: "Average" }] }).success, false);
  assertEquals(tools.table_pivot.inputSchema.safeParse({ ...pivotBase, metrics: [{ op: "sum", column: "c2", header: "Total", scale: 2 }] }).success, false);
  assertEquals(tools.table_pivot.inputSchema.safeParse({ ...pivotBase, metrics: [{ op: "count_rows", column: "c2", header: "Rows" }] }).success, false);
  assertEquals(tools.table_pivot.inputSchema.safeParse({ ...pivotBase, metrics: [{ op: "count_values", header: "Present" }] }).success, false);
  assertEquals(tools.table_pivot.inputSchema.safeParse({ ...pivotBase, categories: [{ value: "x", header: "h".repeat(257) }] }).success, false, "headers are bounded before local execution");
});

Deno.test("table management source schemas preserve explicit locale/type choices", () => {
  const tools = managementToolset({ callRoute: async () => ({ ok: true }) });
  const base = {
    source: {
      artifactId: "a_csv",
      format: "csv",
      hasHeader: true,
      schemaMode: "explicit",
      localeProfile: "de-DE-v1",
      columns: [
        { type: { kind: "text" }, header: "Code" },
        { type: { kind: "decimal", scale: 2 }, header: "Amount" },
      ],
    },
    columns: [{ column: "c1" }],
  };
  assertEquals(tools.table_select.inputSchema.safeParse(base).success, true);
  assertEquals(tools.table_select.inputSchema.safeParse({ ...base, source: { ...base.source, localeProfile: "ambient-browser" } }).success, false);
  assertEquals(tools.table_select.inputSchema.safeParse({ ...base, source: { ...base.source, columns: [{ type: { kind: "decimal", scale: 19 } }] } }).success, false);
});

Deno.test("service-worker table route pins live-run fences and sender-derived identity", () => {
  const source = Deno.readTextFileSync(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = source.indexOf('async "table.run"');
  assert(start >= 0, "table.run route exists");
  const end = source.indexOf("// File-backed bundled-tool transport", start);
  const block = source.slice(start, end);
  assert(block.includes("activeExecutions.has(executionId)"), "interactive model run must still be live");
  assert(block.includes("runControl.get(executionId)"), "worker model run must still be live");
  assert(block.includes("live.surface === `agent-worker:${agentId}`"), "worker run binds its immutable agent surface");
  assert(block.includes("runTableArtifactTool(toolId, args, context, { isRunLive, runJob: runOffscreenTableJob })"), "all six tools share one authority route, the offscreen worker host, and publication liveness checks");
  assert(!block.includes("wasmStreamOwner(context)"), "Settings-document stream ownership is not reused for model calls");

  const getStart = source.indexOf('async "asset.get"');
  const getEnd = source.indexOf("// ---- agent-generated scripts", getStart);
  const getBlock = source.slice(getStart, getEnd);
  assert(getBlock.includes('context?.principal === "model" ? providerSafeTableAssetRead(result) : result'), "model get_asset cannot recover local table bytes");
  assert(source.includes("function finalizeExecution(execId)"));
  assert(source.includes("cancelTableExecution(execId)"), "foreground and delegated terminal paths cancel exact-run table workers");
  assert(source.includes("onRunSettled: cancelTableExecution"), "worker-run terminal path cancels exact-run table workers through the offscreen host");
  assert(source.includes("chrome.runtime.sendMessage({\n      type: TABLE_WORKER_RUN_TYPE"), "the MV3 service worker delegates dedicated-Worker construction to the offscreen document");
  const offscreen = Deno.readTextFileSync(new URL("../extension/offscreen/offscreen.js", import.meta.url));
  assert(offscreen.includes('import { registerTableWorkerHost } from "../lib/table-worker-host.js"'));
  assert(offscreen.includes("registerTableWorkerHost();"));
});

// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  canonicalTableJson,
  TABLE_LIMITS,
  TABLE_VERSION,
} from "../extension/lib/table-core.js";
import { executeTableOperationJob } from "../extension/lib/table-operation-worker.js";
import { runTableArtifactTool } from "../extension/lib/table-tool-runtime.js";
import { encodeCanonicalBase64 } from "../extension/lib/wasm-base64.js";
import { WASM_STREAM_ROOT_NAME } from "../extension/lib/wasm-stream-files.js";

const encoder = new TextEncoder();
const context = Object.freeze({
  principal: "model",
  executionId: "exec:11111111-1111-4111-8111-111111111111",
  runId: "exec:11111111-1111-4111-8111-111111111111",
  agentId: "table-integration-agent",
});

const fileNode = () => ({ kind: "file", bytes: new Uint8Array() });
const directoryNode = () => ({ kind: "directory", children: new Map() });

class MemoryWritable {
  constructor(node, keep) {
    this.node = node;
    this.bytes = keep ? node.bytes.slice() : new Uint8Array();
    this.position = 0;
  }
  async seek(position) { this.position = position; }
  async write(value) {
    const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
    const next = new Uint8Array(Math.max(this.bytes.byteLength, this.position + bytes.byteLength));
    next.set(this.bytes);
    next.set(bytes, this.position);
    this.bytes = next;
    this.position += bytes.byteLength;
  }
  async close() { this.node.bytes = this.bytes; }
  async abort() {}
}

class MemoryFile {
  constructor(node) { this.node = node; this.kind = "file"; }
  async getFile() { return new Blob([this.node.bytes]); }
  async createWritable({ keepExistingData = false } = {}) {
    return new MemoryWritable(this.node, keepExistingData);
  }
}

class MemoryDirectory {
  constructor(node) { this.node = node; this.kind = "directory"; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, directoryNode());
    }
    const child = this.node.children.get(name);
    if (child.kind !== "directory") throw new Error("type mismatch");
    return new MemoryDirectory(child);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, fileNode());
    }
    const child = this.node.children.get(name);
    if (child.kind !== "file") throw new Error("type mismatch");
    return new MemoryFile(child);
  }
  async removeEntry(name) {
    if (!this.node.children.delete(name)) throw new Error("not found");
  }
}

function memoryStorage() {
  const root = new MemoryDirectory(directoryNode());
  return { root, storage: { async getDirectory() { return root; } } };
}

function streamCount(root) {
  return root.node.children.get(WASM_STREAM_ROOT_NAME)?.children.size ?? 0;
}

function canonicalSource(artifactId) {
  return { artifactId, format: TABLE_VERSION };
}

function primaryTable() {
  return {
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: [
      { id: "c1", header: "Region", type: { kind: "text" } },
      { id: "c2", header: "Quarter", type: { kind: "text" } },
      { id: "c3", header: "Amount", type: { kind: "decimal", scale: 2 } },
      { id: "c4", header: "Quantity", type: { kind: "int64" } },
    ],
    rows: [
      ["East", "Q1", "10.00", "2"],
      ["East", "Q2", "5.00", "3"],
      ["West", "Q1", "7.50", "1"],
    ],
  };
}

function lookupTable() {
  return {
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: [
      { id: "c1", header: "Region", type: { kind: "text" } },
      { id: "c2", header: "Owner", type: { kind: "text" } },
    ],
    rows: [["East", "Ada"], ["West", "Bea"]],
  };
}

function realRuntimeHarness() {
  const { root, storage } = memoryStorage();
  const assets = new Map([
    ["a_primary", { id: "a_primary", type: "data", content: canonicalTableJson(primaryTable()), meta: {} }],
    ["a_lookup", { id: "a_lookup", type: "data", content: canonicalTableJson(lookupTable()), meta: {} }],
  ]);
  const created = [];
  const deps = {
    storage,
    isRunLive: () => true,
    readAsset: async (_origin, id) => assets.has(id)
      ? { ok: true, asset: assets.get(id) }
      : { ok: false, error: "not found" },
    runJob: async (job, options) => {
      try { return { ok: true, ...(await executeTableOperationJob(job, options)) }; }
      catch (error) { return { ok: false, code: error?.code ?? "table_worker_failed" }; }
    },
    createArtifact: async (_origin, input) => {
      const id = `a_output_${created.length + 1}`;
      const asset = { id, type: input.type, name: input.name, content: input.content, size: encoder.encode(input.content).byteLength, sha256: input.meta.sha256, meta: input.meta };
      assets.set(id, asset);
      created.push({ ...input, id });
      return { ok: true, id };
    },
  };
  return { root, storage, assets, created, deps };
}

Deno.test("all six table tools execute through real sealed OPFS staging and publish canonical local artifacts", async () => {
  const harness = realRuntimeHarness();
  const cases = [
    ["table_filter", {
      source: canonicalSource("a_primary"),
      predicate: { column: "c3", op: "gte", value: "7.50" },
    }],
    ["table_select", {
      source: canonicalSource("a_primary"),
      columns: [{ column: "c3", header: "Selected" }, { column: "c1", header: "Selected" }],
    }],
    ["table_join", {
      leftSource: canonicalSource("a_primary"),
      rightSource: canonicalSource("a_lookup"),
      kind: "inner",
      keys: [{ left: "c1", right: "c1" }],
      leftColumns: ["c1", "c3"],
      rightColumns: ["c2"],
    }],
    ["table_group_aggregate", {
      source: canonicalSource("a_primary"),
      groupBy: ["c1"],
      metrics: [
        { op: "count_rows", header: "Rows" },
        { op: "sum", column: "c3", header: "Total" },
        { op: "avg", column: "c3", header: "Average", scale: 2 },
      ],
    }],
    ["table_pivot", {
      source: canonicalSource("a_primary"),
      rowGroupBy: ["c1"],
      pivotColumn: "c2",
      categories: [{ value: "Q1", header: "Q1" }, { value: "Q2", header: "Q2" }],
      metrics: [
        { op: "sum", column: "c3", header: "Amount" },
        { op: "count_rows", header: "Rows" },
      ],
    }],
    ["table_formula", {
      source: canonicalSource("a_primary"),
      mode: "append_column",
      readRange: { r1: 1, c1: 3, r2: 3, c2: 4 },
      targetRows: { r1: 1, r2: 3 },
      expression: "=CELL(ROW,3)*CELL(ROW,4)",
      result: { header: "Line total", type: { kind: "decimal", scale: 2 } },
      numericPolicy: { divisionScale: 6, rounding: "half_even" },
    }],
  ];

  const results = new Map();
  for (const [toolId, args] of cases) {
    const result = await runTableArtifactTool(toolId, args, context, harness.deps);
    results.set(toolId, result);
    assertEquals(result.ok, true, `${toolId} succeeds`);
    assertEquals(streamCount(harness.root), 0, `${toolId} removes every temporary staged stream before publication`);
    const asset = harness.assets.get(result.artifactId);
    assert(asset && asset.content === canonicalTableJson(JSON.parse(asset.content)), `${toolId} stores canonical complete bytes`);
    assertEquals(asset.meta.schema, TABLE_VERSION);
    assertEquals(asset.meta.outputSha256, result.sha256);
    assertEquals(asset.meta.operationDigest.length, 64);
    const visible = JSON.stringify(result);
    for (const forbidden of ["Region", "Quarter", "Amount", "East", "West", "Ada", "Bea", "10.00"]) {
      assert(!visible.includes(forbidden), `${toolId} provider result omits ${forbidden}`);
    }
    assert(encoder.encode(visible).byteLength <= TABLE_LIMITS.maxProviderResultBytes);
  }

  assertEquals(results.get("table_filter").workUnits, 11, "filter counts three predicate visits plus eight emitted cells");
  assertEquals(results.get("table_select").workUnits, 6, "select counts each of six projected cells exactly once");
  assertEquals(results.get("table_join").workUnits, 14, "join counts five key-cell visits plus nine emitted cells");
  assertEquals(results.get("table_group_aggregate").workUnits, 20, "group counts aggregate input visits plus eight emitted cells");
  assertEquals(results.get("table_pivot").workUnits, 22, "pivot counts grouping/category/aggregate visits plus ten emitted cells");
  assertEquals(results.get("table_formula").workUnits, 30, "formula counts AST/cell visits plus fifteen emitted cells");
  assertEquals(JSON.parse(harness.created[0].content).rows.length, 2, "filter materializes only true rows");
  assertEquals(JSON.parse(harness.created[2].content).rows, [
    ["East", "10.00", "Ada"],
    ["East", "5.00", "Ada"],
    ["West", "7.50", "Bea"],
  ]);
  assertEquals(JSON.parse(harness.created[3].content).rows, [
    ["East", "2", "15.00", "7.50"],
    ["West", "1", "7.50", "7.50"],
  ]);
  assertEquals(JSON.parse(harness.created[4].content).columns.map((column) => column.header), [
    "Region", "Q1 · Amount", "Q1 · Rows", "Q2 · Amount", "Q2 · Rows",
  ], "pivot output is category-major");
  assertEquals(JSON.parse(harness.created[5].content).rows.map((row) => row[4]), ["20.00", "15.00", "7.50"]);
});

Deno.test("the live join route applies exact int64/decimal key normalization only at key comparison", async () => {
  const harness = realRuntimeHarness();
  const numericTable = (kind, rows) => ({
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: [
      { id: "c1", header: "Key", type: kind === "int64" ? { kind } : { kind: "decimal", scale: 2 } },
      { id: "c2", header: "Value", type: { kind: "text" } },
    ],
    rows,
  });
  harness.assets.set("a_int", { id: "a_int", type: "data", content: canonicalTableJson(numericTable("int64", [["5", "left-five"], ["6", "left-six"]])), meta: {} });
  harness.assets.set("a_decimal", { id: "a_decimal", type: "data", content: canonicalTableJson(numericTable("decimal", [["5.00", "right-five"], ["6.10", "right-six-ten"]])), meta: {} });
  const result = await runTableArtifactTool("table_join", {
    leftSource: canonicalSource("a_int"),
    rightSource: canonicalSource("a_decimal"),
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1", "c2"],
    rightColumns: ["c1", "c2"],
  }, context, harness.deps);
  assertEquals(result.ok, true);
  assertEquals(JSON.parse(harness.assets.get(result.artifactId).content).rows, [["5", "left-five", "5.00", "right-five"]]);
  assertEquals(streamCount(harness.root), 0);
});

Deno.test("a multi-window CSV source executes through the same artifact and OPFS route", async () => {
  const harness = realRuntimeHarness();
  const csv = `value\n${"x\n".repeat(33_000)}`;
  assert(encoder.encode(csv).byteLength > TABLE_LIMITS.chunkSize, "fixture crosses one worker read window");
  harness.assets.set("a_csv", { id: "a_csv", type: "data", content: csv, meta: {} });
  const result = await runTableArtifactTool("table_select", {
    source: { artifactId: "a_csv", format: "csv", hasHeader: true, schemaMode: "text", localeProfile: "canonical-v1" },
    columns: [{ column: "c1" }],
  }, context, harness.deps);
  assertEquals(result.ok, true);
  assertEquals(result.rows, 33_000);
  assertEquals(streamCount(harness.root), 0);
  assertEquals(JSON.parse(harness.assets.get(result.artifactId).content).rows.at(-1), ["x"]);
});

function inlineReadOptions(bytes, mutate = (window) => window) {
  return {
    validateStream: async () => ({ bytes: bytes.byteLength }),
    readWindow: async ({ offset, length }) => {
      const chunk = bytes.subarray(offset, offset + length);
      return mutate({
        base64: encodeCanonicalBase64(chunk),
        offset,
        end: offset + chunk.byteLength,
        size: bytes.byteLength,
        eof: offset + chunk.byteLength === bytes.byteLength,
      });
    },
  };
}

Deno.test("operation worker rejects noncanonical tables and malformed stream windows before execution", async () => {
  const body = encoder.encode("value\nx\n");
  const source = { format: "csv", ref: { id: "s", kind: "input" }, owner: "agent:test", bytes: body.byteLength, options: { hasHeader: true, schemaMode: "text", localeProfile: "canonical-v1" } };
  const request = { columns: [{ column: "c1" }] };
  const variants = [
    (window) => ({ ...window, end: window.end - 1 }),
    (window) => ({ ...window, size: window.size + 1 }),
    (window) => ({ ...window, eof: !window.eof }),
    (window) => ({ ...window, base64: "%%%" }),
  ];
  for (const mutate of variants) {
    let code = "";
    try { await executeTableOperationJob({ toolId: "table_select", source, request }, inlineReadOptions(body, mutate)); }
    catch (error) { code = error?.code; }
    assertEquals(code, "table_stream_read_failed");
  }

  let authorityCode = "";
  try {
    await executeTableOperationJob({ toolId: "table_select", source, request }, {
      ...inlineReadOptions(body),
      validateStream: async () => ({ bytes: body.byteLength + 1 }),
    });
  } catch (error) { authorityCode = error?.code; }
  assertEquals(authorityCode, "table_stream_authority");

  const noncanonical = encoder.encode(JSON.stringify(primaryTable(), null, 2));
  let canonicalCode = "";
  try {
    await executeTableOperationJob({
      toolId: "table_select",
      source: { format: TABLE_VERSION, ref: { id: "s", kind: "input" }, owner: "agent:test", bytes: noncanonical.byteLength },
      request,
    }, inlineReadOptions(noncanonical));
  } catch (error) { canonicalCode = error?.code; }
  assertEquals(canonicalCode, "table_json_noncanonical");
});

Deno.test("failed real staging and execution clean sealed inputs and publish no partial artifact", async () => {
  const harness = realRuntimeHarness();
  const before = harness.created.length;
  const partialJoin = await runTableArtifactTool("table_join", {
    leftSource: canonicalSource("a_primary"),
    rightSource: canonicalSource("a_missing"),
    kind: "inner",
    keys: [{ left: "c1", right: "c1" }],
    leftColumns: ["c1"],
    rightColumns: ["c1"],
  }, context, harness.deps);
  assertEquals(partialJoin.code, "table_artifact_read_failed");
  assertEquals(streamCount(harness.root), 0, "the already-staged left input is removed when right staging fails");

  const result = await runTableArtifactTool("table_pivot", {
    source: canonicalSource("a_primary"),
    rowGroupBy: ["c1"],
    pivotColumn: "c2",
    categories: [{ value: "Q1", header: "Q1" }],
    metrics: [{ op: "count_rows", header: "Rows" }],
  }, context, harness.deps);
  assertEquals(result.ok, false);
  assertEquals(harness.created.length, before);
  assertEquals(streamCount(harness.root), 0);
  for (const forbidden of ["Q2", "East", "Quarter"]) assert(!JSON.stringify(result).includes(forbidden));
});

// lib/table-operation-worker.js — isolated execution realm for the six table tools.

import {
  assertCanonicalTable,
  canonicalTableJson,
  parseTableBytes,
  runBasicTableTool,
  TABLE_LIMITS,
  TableError,
} from "./table-core.js";
import { joinTables, pivotTable } from "./table-join-pivot.js";
import { formulaTable } from "./table-formula.js";
import { decodeCanonicalBase64 } from "./wasm-base64.js";
import { readWasmStreamWindow, validateSealedWasmStream } from "./wasm-stream-files.js";

const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

async function readSourceBytes(source, {
  storage,
  validateStream = validateSealedWasmStream,
  readWindow = readWasmStreamWindow,
  decodeBase64 = decodeCanonicalBase64,
} = {}) {
  if (!source || typeof source !== "object" || !source.ref || typeof source.owner !== "string" || !Number.isSafeInteger(source.bytes) || source.bytes < 0) {
    throw new TableError("table_bad_request", "source");
  }
  if (source.bytes > TABLE_LIMITS.maxInputBytes) throw new TableError("table_input_bound");
  let validated;
  try { validated = await validateStream({ ref: source.ref, owner: source.owner, storage }); }
  catch { throw new TableError("table_stream_authority"); }
  if (validated.bytes !== source.bytes) throw new TableError("table_stream_authority");
  const output = new Uint8Array(source.bytes);
  for (let offset = 0; offset < source.bytes; offset += TABLE_LIMITS.chunkSize) {
    const requested = Math.min(TABLE_LIMITS.chunkSize, source.bytes - offset);
    let window;
    try {
      window = await readWindow({
        ref: source.ref,
        owner: source.owner,
        offset,
        length: requested,
        storage,
      });
    } catch {
      throw new TableError("table_stream_read_failed");
    }
    let bytes;
    try { bytes = decodeBase64(window.base64); }
    catch { throw new TableError("table_stream_read_failed"); }
    if (bytes.byteLength !== requested || window.offset !== offset || window.end !== offset + requested ||
        window.size !== source.bytes || window.eof !== (offset + requested === source.bytes)) {
      throw new TableError("table_stream_read_failed");
    }
    output.set(bytes, offset);
  }
  return output;
}

async function decodeSource(source, options) {
  const bytes = await readSourceBytes(source, options);
  if (source.format === "cap.table/1") {
    let parsed;
    let content;
    try { content = fatalDecoder.decode(bytes); }
    catch { throw new TableError("table_invalid_utf8"); }
    try { parsed = JSON.parse(content); }
    catch { throw new TableError("table_json_invalid"); }
    const table = assertCanonicalTable(parsed);
    // `cap.table/1` is canonical bytes, not merely JSON with a familiar
    // shape. This rejects whitespace/key-order aliases and duplicate-key
    // payloads (JSON.parse would otherwise silently keep the last key).
    if (canonicalTableJson(table) !== content) throw new TableError("table_json_noncanonical");
    return table;
  }
  if (source.format !== "csv" && source.format !== "tsv") {
    throw new TableError("table_format_invalid");
  }
  return parseTableBytes(bytes, {
    format: source.format,
    ...(source.options ?? {}),
  });
}

function resultOf(value, { addOutputCells = false } = {}) {
  let table;
  try { table = assertCanonicalTable(value?.table ?? value); }
  catch { throw new TableError("table_output_bound"); }
  const reported = value?.workUnits;
  if (!Number.isSafeInteger(reported) || reported < 0) throw new TableError("table_work_bound");
  const emittedCells = addOutputCells ? table.rows.length * table.columns.length : 0;
  const workUnits = reported + emittedCells;
  if (!Number.isSafeInteger(workUnits) || workUnits > TABLE_LIMITS.maxWorkUnits) throw new TableError("table_work_bound");
  return { table, workUnits };
}

function publicWorkerCode(error) {
  if (!(error instanceof TableError) || typeof error.code !== "string") return "table_worker_failed";
  if (error.code === "table_output_bound") return "table_output_bound";
  if (error.code === "table_work_bound" || error.code === "table_formula_work_bound" || error.code === "table_formula_visit_bound") {
    return "table_work_bound";
  }
  if (error.code.endsWith("_bound") || error.code === "table_numeric_overflow") return "table_input_bound";
  return "table_invalid_input";
}

export async function executeTableOperationJob(job, options = {}) {
  const toolId = job?.toolId;
  const request = job?.request;
  if (toolId === "table_join") {
    return resultOf(joinTables(await decodeSource(job.left, options), await decodeSource(job.right, options), request));
  }
  const table = await decodeSource(job?.source, options);
  if (["table_filter", "table_select", "table_group_aggregate"].includes(toolId)) {
    // select already charges each projected output cell in the strict core;
    // filter/group charge their predicate/aggregate visits there, so the
    // integration boundary adds their emitted cells exactly once.
    return resultOf(runBasicTableTool(toolId, table, request), { addOutputCells: toolId !== "table_select" });
  }
  if (toolId === "table_pivot") return resultOf(pivotTable(table, request));
  // Formula accounting covers AST/range visits; materializing its result table
  // is a separate emitted-cell cost under the shared operation budget.
  if (toolId === "table_formula") return resultOf(formulaTable(table, request), { addOutputCells: true });
  throw new TableError("table_tool_unknown");
}

self.onmessage = async (event) => {
  try {
    const result = await executeTableOperationJob(event?.data);
    self.postMessage({ ok: true, ...result });
  } catch (error) {
    self.postMessage({ ok: false, code: publicWorkerCode(error) });
  }
};

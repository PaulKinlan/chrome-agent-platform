// @ts-nocheck
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  assertCanonicalTable,
  filterTable,
  formatTableDelimited,
  groupAggregateTable,
  parseTableBytes,
  parseTableFile,
  sanitizeFormulaCell,
  selectTable,
  TABLE_LIMITS,
  TABLE_VERSION,
} from "../extension/lib/table-core.js";

const encode = (value: string) => new TextEncoder().encode(value);

function throwsCode(fn: () => unknown, code: string) {
  const error = assertThrows(fn);
  assertEquals(error.code, code, error.message);
  return error;
}

async function rejectsCode(fn: () => Promise<unknown>, code: string) {
  const error = await assertRejects(fn);
  assertEquals(error.code, code, error.message);
  return error;
}

function table(columns, rows, localeProfile = "canonical-v1") {
  return assertCanonicalTable({
    version: TABLE_VERSION,
    localeProfile,
    columns: columns.map((column, index) => ({ id: `c${index + 1}`, ...column })),
    rows,
  });
}

Deno.test("strict CSV/TSV ingestion preserves duplicate headers, empty text, missing cells, Unicode and stable IDs", () => {
  const input = '\ufeffCode,Amount,Amount,Note\r\n001,1.50,,""\r\n002,2.25,3.00,"snowman ☃"';
  const result = parseTableBytes(encode(input), {
    format: "csv",
    schemaMode: "explicit",
    localeProfile: "en-US-v1",
    columns: [
      { header: "Code", type: { kind: "text" } },
      { header: "Amount", type: { kind: "decimal", scale: 2 } },
      { header: "Amount", type: { kind: "decimal", scale: 2 } },
      { header: "Note", type: { kind: "text" } },
    ],
  });
  assertEquals(result.columns.map(({ id, header }) => ({ id, header })), [
    { id: "c1", header: "Code" },
    { id: "c2", header: "Amount" },
    { id: "c3", header: "Amount" },
    { id: "c4", header: "Note" },
  ]);
  assertEquals(result.rows, [
    ["001", "1.50", null, ""],
    ["002", "2.25", "3.00", "snowman ☃"],
  ]);

  const tsv = parseTableBytes(encode("name\tvalue\nA\t1\n"), {
    format: "tsv",
    schemaMode: "explicit",
    columns: [{ type: "text" }, { type: "int64" }],
  });
  assertEquals(tsv.rows, [["A", "1"]]);
});

Deno.test("strict parser handles quoted newlines and a doubled quote split at the 64 KiB chunk boundary", async () => {
  const filler = `${"x".repeat(16_000)},z\n`.repeat(4);
  const beforeQuoted = `h1,h2\n${filler}`;
  const padding = TABLE_LIMITS.chunkSize - 1 - encode(beforeQuoted).byteLength - 1;
  const quoted = "q".repeat(padding);
  const source = `${beforeQuoted}"${quoted}""z\nq",tail\n`;
  const bytes = encode(source);
  assertEquals(bytes[TABLE_LIMITS.chunkSize - 1], '"'.charCodeAt(0));
  assertEquals(bytes[TABLE_LIMITS.chunkSize], '"'.charCodeAt(0));
  const file = {
    size: bytes.byteLength,
    slice(start, end) {
      return { arrayBuffer: async () => bytes.slice(start, end).buffer };
    },
  };
  const parsed = await parseTableFile(file, { schemaMode: "text" });
  assertEquals(parsed.rows.length, 5);
  assert(parsed.rows[4][0].endsWith('"z\nq'));
  assertEquals(parsed.rows[4][1], "tail");
});

Deno.test("malformed UTF-8 and malformed CSV fail closed", () => {
  throwsCode(() => parseTableBytes(new Uint8Array([0x68, 0x0a, 0xc3, 0x28]), { schemaMode: "text" }), "table_invalid_utf8");
  for (const source of ['h\n"open', 'h\n"x"junk', 'h\na"b', "h\rrow"]) {
    throwsCode(() => parseTableBytes(encode(source), { schemaMode: "text" }), "table_csv_syntax");
  }
  throwsCode(() => parseTableBytes(encode("a;b\n1;2\n"), { delimiter: ";", schemaMode: "text" }), "table_delimiter_invalid");
});

Deno.test("rows are rectangular: short rows pad missing; wide rows fail", () => {
  const short = parseTableBytes(encode("a,b,c\n1,2\n"), { schemaMode: "text" });
  assertEquals(short.rows, [["1", "2", null]]);
  throwsCode(() => parseTableBytes(encode("a,b\n1,2,3\n"), { schemaMode: "text" }), "table_row_width");
});

Deno.test("explicit typed ingestion is exact and locale profiles only affect spelling", () => {
  const parsed = parseTableBytes(encode('id;not-used'), { schemaMode: "text" });
  assertEquals(parsed.rows, []);

  const de = parseTableBytes(encode('id,price,flag,date,when\n1,"1,50",true,2026-09-05,2026-09-05T01:02:03.004Z\n'), {
    schemaMode: "explicit",
    localeProfile: "de-DE-v1",
    columns: [
      { type: "int64" },
      { type: { kind: "decimal", scale: 2 } },
      { type: "boolean" },
      { type: "date" },
      { type: "datetime" },
    ],
  });
  assertEquals(de.rows[0], ["1", "1.50", true, "2026-09-05", "2026-09-05T01:02:03.004Z"]);
  assertEquals(formatTableDelimited(de), 'id,price,flag,date,when\n1,"1,50",true,2026-09-05,2026-09-05T01:02:03.004Z\n');
  const negativeFraction = parseTableBytes(encode("v\n-0.50\n"), {
    schemaMode: "explicit",
    columns: [{ type: { kind: "decimal", scale: 2 } }],
  });
  assertEquals(negativeFraction.rows, [["-0.50"]]);
  throwsCode(() => parseTableBytes(encode("v\n-0.00\n"), {
    schemaMode: "explicit",
    columns: [{ type: { kind: "decimal", scale: 2 } }],
  }), "table_type_mismatch");
  throwsCode(() => parseTableBytes(encode("id\n9223372036854775808\n"), {
    schemaMode: "explicit",
    columns: [{ type: "int64" }],
  }), "table_numeric_overflow");
  throwsCode(() => parseTableBytes(encode("id\n001\n"), {
    schemaMode: "explicit",
    columns: [{ type: "int64" }],
  }), "table_type_mismatch");
});

Deno.test("bounded inference is deterministic and never guesses dates or leading-zero identifiers", () => {
  const result = parseTableBytes(encode("id,amount,active,date\n001,1.20,true,2026-09-05\n002,2.3,false,2026-09-06\n"), {
    schemaMode: "infer",
  });
  assertEquals(result.columns.map((column) => column.type), [
    { kind: "text" },
    { kind: "decimal", scale: 2 },
    { kind: "boolean" },
    { kind: "text" },
  ]);
  assertEquals(result.rows[1], ["002", "2.30", false, "2026-09-06"]);
});

Deno.test("filter uses stable column IDs and three-valued missing logic", () => {
  const source = table([
    { header: "Amount", type: { kind: "text" } },
    { header: "Amount", type: { kind: "decimal", scale: 2 } },
  ], [
    ["A", "12.00"],
    ["B", null],
    ["A", "9.00"],
  ]);
  const result = filterTable(source, {
    predicate: {
      all: [
        { column: "c1", op: "eq", value: "A" },
        { column: "c2", op: "gte", value: "10.00" },
      ],
    },
  });
  assertEquals(result.table.rows, [["A", "12.00"]]);
  assertEquals(filterTable(source, { predicate: { column: "c2", op: "neq", value: "10.00" } }).table.rows, [
    ["A", "12.00"],
    ["A", "9.00"],
  ]);
  throwsCode(() => filterTable(source, { predicate: { column: "Amount", op: "eq", value: "A" } }), "table_unknown_column");
});

Deno.test("select permits repeated source columns and duplicate display headers in request order", () => {
  const source = table([
    { header: "Dept", type: { kind: "text" } },
    { header: "Amount", type: { kind: "decimal", scale: 2 } },
  ], [["A", "12.00"]]);
  const result = selectTable(source, { columns: [
    { column: "c2", header: "Amount" },
    { column: "c1", header: "Amount" },
    { column: "c2", header: "Again" },
  ] });
  assertEquals(result.table.columns.map(({ id, header, type }) => ({ id, header, type })), [
    { id: "c1", header: "Amount", type: { kind: "decimal", scale: 2 } },
    { id: "c2", header: "Amount", type: { kind: "text" } },
    { id: "c3", header: "Again", type: { kind: "decimal", scale: 2 } },
  ]);
  assertEquals(result.table.rows, [["12.00", "A", "12.00"]]);
  throwsCode(() => selectTable(source, { columns: [{ column: "c9" }] }), "table_unknown_column");
});

Deno.test("group aggregates preserve first-seen order, missing semantics and exact decimal averages", () => {
  const source = table([
    { header: "Dept", type: { kind: "text" } },
    { header: "Amount", type: { kind: "decimal", scale: 2 } },
  ], [
    ["A", "1.10"],
    ["A", "2.20"],
    ["A", null],
    ["B", null],
  ]);
  const result = groupAggregateTable(source, {
    groupBy: ["c1"],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "count_values", column: "c2", header: "Values" },
      { op: "sum", column: "c2", header: "Total" },
      { op: "avg", column: "c2", scale: 2, header: "Average" },
    ],
  });
  assertEquals(result.table.rows, [
    ["A", "3", "2", "3.30", "1.65"],
    ["B", "1", "0", null, null],
  ]);

  const empty = table([{ header: "Amount", type: { kind: "decimal", scale: 2 } }], []);
  assertEquals(groupAggregateTable(empty, {
    groupBy: [],
    metrics: [
      { op: "count_rows", header: "Rows" },
      { op: "sum", column: "c1", header: "Total" },
    ],
  }).table.rows, [["0", null]]);
});

Deno.test("CSV export materializes typed values and always neutralizes formula-like text", () => {
  const source = table([
    { header: "Text", type: { kind: "text" } },
    { header: "Number", type: { kind: "decimal", scale: 2 } },
  ], [
    ["=2+2", "-2.00"],
    ["  @cmd", "1.00"],
  ]);
  assertEquals(formatTableDelimited(source), "Text,Number\n'=2+2,-2.00\n'  @cmd,1.00\n");
  assertEquals(sanitizeFormulaCell("|DDE"), "'|DDE");
});

Deno.test("hard byte/shape limits accept exact boundary and reject +1", async () => {
  const exactCell = "é".repeat(TABLE_LIMITS.maxCellBytes / 2);
  assertEquals(parseTableBytes(encode(`h\n${exactCell}\n`), { schemaMode: "text" }).rows[0][0], exactCell);
  throwsCode(() => parseTableBytes(encode(`h\n${exactCell}a\n`), { schemaMode: "text" }), "table_cell_bound");

  const exactColumns = Array.from({ length: TABLE_LIMITS.maxColumns }, (_, index) => `h${index}`).join(",");
  assertEquals(parseTableBytes(encode(`${exactColumns}\n`), { schemaMode: "text" }).columns.length, TABLE_LIMITS.maxColumns);
  throwsCode(() => parseTableBytes(encode(`${exactColumns},extra\n`), { schemaMode: "text" }), "table_column_bound");

  const tooLargeFile = {
    size: TABLE_LIMITS.maxInputBytes + 1,
    slice() { throw new Error("must reject before read"); },
  };
  await rejectsCode(() => parseTableFile(tooLargeFile, { schemaMode: "text" }), "table_input_bound");

  const headerExact = "h".repeat(TABLE_LIMITS.maxHeaderBytes);
  assertEquals(parseTableBytes(encode(`${headerExact}\n`), { schemaMode: "text" }).columns[0].header, headerExact);
  throwsCode(() => parseTableBytes(encode(`${headerExact}x\n`), { schemaMode: "text" }), "table_header_bound");
});

Deno.test("input, row-byte, row-count and total-header limits accept exact and reject +1", () => {
  // 512 x 1024 cells: one 8,199-byte text cell plus 1,023 quoted booleans
  // makes each row exactly 16,384 bytes. Typed booleans keep the canonical
  // representation below its independent output ceiling.
  const exactInputRow = `${"x".repeat(8199)},${Array(1023).fill('"false"').join(",")}\n`;
  assertEquals(encode(exactInputRow).byteLength, 16_384);
  const exactInput = encode(exactInputRow.repeat(512));
  assertEquals(exactInput.byteLength, TABLE_LIMITS.maxInputBytes);
  const exactInputTable = parseTableBytes(exactInput, {
    hasHeader: false,
    schemaMode: "explicit",
    columns: [
      { type: "text" },
      ...Array.from({ length: 1023 }, () => ({ type: "boolean" })),
    ],
  });
  assertEquals(exactInputTable.rows.length, 512);
  throwsCode(() => parseTableBytes(new Uint8Array(TABLE_LIMITS.maxInputBytes + 1), { schemaMode: "text" }), "table_input_bound");

  const headers = Array.from({ length: 16 }, (_, index) => `h${index}`).join(",");
  const rowExact = [...Array(15).fill("x".repeat(TABLE_LIMITS.maxCellBytes)), "x".repeat(TABLE_LIMITS.maxCellBytes - 16)].join(",") + "\n";
  assertEquals(encode(rowExact).byteLength, TABLE_LIMITS.maxRowBytes);
  assertEquals(parseTableBytes(encode(`${headers}\n${rowExact}`), { schemaMode: "text" }).rows.length, 1);
  throwsCode(() => parseTableBytes(encode(`${headers}\n${rowExact.slice(0, -1)}x\n`), { schemaMode: "text" }), "table_row_byte_bound");

  const exactRows = encode(`h\n${"\n".repeat(TABLE_LIMITS.maxRows)}`);
  assertEquals(parseTableBytes(exactRows, { schemaMode: "text" }).rows.length, TABLE_LIMITS.maxRows);
  throwsCode(() => parseTableBytes(encode(`h\n${"\n".repeat(TABLE_LIMITS.maxRows + 1)}`), { schemaMode: "text" }), "table_row_bound");

  const exactHeaders = Array.from({ length: TABLE_LIMITS.maxHeaderTotalBytes / TABLE_LIMITS.maxHeaderBytes }, () => "h".repeat(TABLE_LIMITS.maxHeaderBytes));
  assertEquals(parseTableBytes(encode(`${exactHeaders.join(",")}\n`), { schemaMode: "text" }).columns.length, exactHeaders.length);
  throwsCode(() => parseTableBytes(encode(`${[...exactHeaders, "x"].join(",")}\n`), { schemaMode: "text" }), "table_header_bound");
});

Deno.test("cell-count and canonical-output limits accept exact and reject +1", () => {
  const thousandColumns = Array.from({ length: 1000 }, (_, index) => ({ header: `h${index}`, type: { kind: "text" } }));
  const thousandCells = Array(1000).fill(null);
  assertEquals(table(thousandColumns, Array(1000).fill(thousandCells)).rows.length, 1000);

  const plusColumns = Array.from({ length: 1001 }, (_, index) => ({ header: `h${index}`, type: { kind: "text" } }));
  throwsCode(() => table(plusColumns, Array(1000).fill(Array(1001).fill(null))), "table_cell_count_bound");

  const large = "x".repeat(TABLE_LIMITS.maxCellBytes);
  const rows = Array.from({ length: 512 }, (_, index) => [index < 511 ? large : ""]);
  const candidate = {
    version: TABLE_VERSION,
    localeProfile: "canonical-v1",
    columns: [{ id: "c1", header: "h", type: { kind: "text" } }],
    rows,
  };
  const baseBytes = encode(JSON.stringify(candidate)).byteLength;
  const finalCellBytes = TABLE_LIMITS.maxOutputBytes - baseBytes;
  assert(finalCellBytes >= 0 && finalCellBytes <= TABLE_LIMITS.maxCellBytes);
  candidate.rows[511][0] = "x".repeat(finalCellBytes);
  assertEquals(encode(JSON.stringify(candidate)).byteLength, TABLE_LIMITS.maxOutputBytes);
  assertEquals(assertCanonicalTable(candidate).rows.length, 512);
  candidate.rows[511][0] += "x";
  throwsCode(() => assertCanonicalTable(candidate), "table_output_bound");
});

Deno.test("group-count limit accepts exact and rejects +1", () => {
  const exact = table([{ header: "key", type: { kind: "text" } }], Array.from({ length: TABLE_LIMITS.maxGroups }, (_, index) => [`g${index}`]));
  assertEquals(groupAggregateTable(exact, { groupBy: ["c1"], metrics: [] }).table.rows.length, TABLE_LIMITS.maxGroups);
  const over = table([{ header: "key", type: { kind: "text" } }], [...exact.rows, ["extra"]]);
  throwsCode(() => groupAggregateTable(over, { groupBy: ["c1"], metrics: [] }), "table_group_bound");
});

Deno.test("predicate, group, metric, depth and work bounds are exact and fail before silent loosening", () => {
  const source = table([{ header: "v", type: { kind: "text" } }], [["x"]]);
  const exactNodes = { all: Array.from({ length: TABLE_LIMITS.maxPredicateNodes - 1 }, () => ({ column: "c1", op: "eq", value: "x" })) };
  assertEquals(filterTable(source, { predicate: exactNodes }).table.rows.length, 1);
  throwsCode(() => filterTable(source, { predicate: { all: [...exactNodes.all, { column: "c1", op: "eq", value: "x" }] } }), "table_predicate_bound");
  let exactDepth = { column: "c1", op: "eq", value: "x" };
  for (let index = 0; index < TABLE_LIMITS.maxPredicateDepth; index++) exactDepth = { not: exactDepth };
  assertEquals(filterTable(source, { predicate: exactDepth }).table.rows.length, 1);
  throwsCode(() => filterTable(source, { predicate: { not: exactDepth } }), "table_predicate_bound");

  const exactGroupBy = table(Array.from({ length: TABLE_LIMITS.maxGroupColumns }, (_, index) => ({ header: `h${index}`, type: { kind: "text" } })), [Array(TABLE_LIMITS.maxGroupColumns).fill("x")]);
  assertEquals(groupAggregateTable(exactGroupBy, { groupBy: exactGroupBy.columns.map((column) => column.id), metrics: [] }).table.rows.length, 1);
  const tooManyGroupColumns = table(Array.from({ length: TABLE_LIMITS.maxGroupColumns + 1 }, (_, index) => ({ header: `h${index}`, type: { kind: "text" } })), [Array(TABLE_LIMITS.maxGroupColumns + 1).fill("x")]);
  throwsCode(() => groupAggregateTable(tooManyGroupColumns, { groupBy: tooManyGroupColumns.columns.map((column) => column.id), metrics: [] }), "table_bad_request");

  const exactMetrics = Array.from({ length: TABLE_LIMITS.maxMetrics }, (_, index) => ({ op: "count_rows", header: `m${index}` }));
  assertEquals(groupAggregateTable(source, { groupBy: [], metrics: exactMetrics }).table.columns.length, TABLE_LIMITS.maxMetrics);
  throwsCode(() => groupAggregateTable(source, { groupBy: [], metrics: [...exactMetrics, { op: "count_rows", header: "extra" }] }), "table_bad_request");

  assertEquals(filterTable(source, { predicate: { column: "c1", op: "eq", value: "x" } }, { units: TABLE_LIMITS.maxWorkUnits - 1 }).workUnits, TABLE_LIMITS.maxWorkUnits);
  throwsCode(() => filterTable(source, { predicate: { column: "c1", op: "eq", value: "x" } }, { units: TABLE_LIMITS.maxWorkUnits }), "table_work_bound");
});

// @ts-nocheck
// tests/tool-tabular-contracts.test.ts — Tabular & structured data streaming contracts.
// CAP-FB-20260822-SPREADSHEET-TOOLKIT-01 / CAP-FB-20260822-WASM-TOOL-PLATFORM-01 (Pillar 3 / def alignment).

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  parseCsv,
  formatCsv,
  parseJsonl,
  formatJsonl,
  sanitizeFormulaCell,
  transformTabularData,
  streamTabularTransform,
} from "../extension/lib/tool-tabular-contracts.js";
import {
  createWasmStreamInput,
  appendWasmStreamInput,
  sealWasmStreamInput,
  validateSealedWasmStream,
} from "../extension/lib/wasm-stream-files.js";

// In-memory OPFS fake
function dirNode() { return { kind: "directory", children: new Map() }; }
function fileNode(content = "") { return { kind: "file", content }; }

class FakeWritable {
  constructor(node, { keepExistingData = false } = {}) {
    this.node = node;
    this.pos = 0;
    if (!keepExistingData) {
      this.node.content = "";
    }
  }
  async seek(pos) { this.pos = pos; }
  async write(chunk) {
    const str = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    const prev = this.node.content ?? "";
    const prefix = prev.slice(0, this.pos);
    const suffix = prev.slice(this.pos + str.length);
    this.node.content = prefix + str + suffix;
    this.pos += str.length;
  }
  async close() {}
}

class FakeFileHandle {
  constructor(node) { this.node = node; }
  get kind() { return "file"; }
  async getFile() {
    const text = this.node.content ?? "";
    return {
      size: text.length,
      text: async () => text,
      slice: (start, end) => ({
        arrayBuffer: async () => new TextEncoder().encode(text.slice(start, end)).buffer,
      }),
    };
  }
  async createWritable({ keepExistingData = false } = {}) {
    return new FakeWritable(this.node, { keepExistingData });
  }
}

class FakeDirHandle {
  constructor(node) { this.node = node; }
  get kind() { return "directory"; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts?.create) throw new Error(`directory ${name} not found`);
      this.node.children.set(name, dirNode());
    }
    return new FakeDirHandle(this.node.children.get(name));
  }
  async getFileHandle(name, opts = {}) {
    if (!this.node.children.has(name)) {
      if (!opts?.create) throw new Error(`file ${name} not found`);
      this.node.children.set(name, fileNode(""));
    }
    return new FakeFileHandle(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new FakeFileHandle(node) : new FakeDirHandle(node)];
    }
  }
}

const root = dirNode();
const fakeStorage = {
  async getDirectory() { return new FakeDirHandle(root); }
};

Object.defineProperty(globalThis, "navigator", {
  value: { storage: fakeStorage },
  configurable: true,
  writable: true,
});

const OWNER = "agent:test-tabular:owner";

Deno.test("parseCsv: parses RFC 4180 quoted cells and preserves types", () => {
  const csv = `id,name,score,active,notes\n1,"Smith, John",95.5,true,"Top performer"\n2,"Doe, Jane",88,false,"Special ""quoted"" text"\n3,Bob,null,true,\n`;
  const table = parseCsv(csv);

  assertEquals(table.headers, ["id", "name", "score", "active", "notes"]);
  assertEquals(table.rows.length, 3);
  assertEquals(table.rows[0], [1, "Smith, John", 95.5, true, "Top performer"]);
  assertEquals(table.rows[1], [2, "Doe, Jane", 88, false, 'Special "quoted" text']);
  assertEquals(table.rows[2], [3, "Bob", null, true, null]);
});

Deno.test("formula defense: neutralizes formula injection characters", () => {
  assertEquals(sanitizeFormulaCell("=SUM(A1:A10)"), "'=SUM(A1:A10)");
  assertEquals(sanitizeFormulaCell("+1+1"), "'+1+1");
  assertEquals(sanitizeFormulaCell("-2*3"), "'-2*3");
  assertEquals(sanitizeFormulaCell("@HYPERLINK(...)"), "'@HYPERLINK(...)");
  assertEquals(sanitizeFormulaCell("\tDDE_ATTACK"), "'\tDDE_ATTACK");
  assertEquals(sanitizeFormulaCell("Standard Text"), "Standard Text");
  assertEquals(sanitizeFormulaCell(42), 42);
});

Deno.test("formatCsv: formats safe CSV with sanitized formula cells", () => {
  const headers = ["product", "formula"];
  const rows = [
    ["Widget A", "=1+1"],
    ["Widget B", "Normal"],
  ];
  const out = formatCsv(headers, rows);
  assert(out.includes("product,formula\n"));
  assert(out.includes("Widget A,'=1+1\n"), "must neutralize formula with leading apostrophe");
  assert(out.includes("Widget B,Normal\n"));
});

Deno.test("transformTabularData: filter, select, and sort operations", () => {
  const table = {
    headers: ["id", "dept", "salary"],
    rows: [
      [1, "eng", 120000],
      [2, "sales", 90000],
      [3, "eng", 140000],
      [4, "hr", 85000],
      [5, "eng", 110000],
    ],
  };

  // Filter: dept == "eng", select: [id, salary], sort by salary desc
  const res = transformTabularData(table, [
    { op: "filter", column: "dept", comparison: "eq", value: "eng" },
    { op: "select", columns: ["id", "salary"] },
    { op: "sort", column: "salary", direction: "desc" },
  ]);

  assertEquals(res.headers, ["id", "salary"]);
  assertEquals(res.rows.length, 3);
  assertEquals(res.rows[0], [3, 140000]);
  assertEquals(res.rows[1], [1, 120000]);
  assertEquals(res.rows[2], [5, 110000]);
});

Deno.test("transformTabularData: group-by aggregation", () => {
  const table = {
    headers: ["category", "amount"],
    rows: [
      ["books", 10],
      ["electronics", 100],
      ["books", 25],
      ["electronics", 50],
      ["groceries", 40],
    ],
  };

  const res = transformTabularData(table, [
    {
      op: "aggregate",
      groupBy: ["category"],
      metrics: [
        { column: "amount", metric: "count", as: "count" },
        { column: "amount", metric: "sum", as: "total" },
        { column: "amount", metric: "avg", as: "avg" },
        { column: "amount", metric: "max", as: "max" },
      ],
    },
    { op: "sort", column: "total", direction: "desc" },
  ]);

  assertEquals(res.headers, ["category", "count", "total", "avg", "max"]);
  assertEquals(res.rows.length, 3);
  assertEquals(res.rows[0], ["electronics", 2, 150, 75, 100]);
  assertEquals(res.rows[1], ["groceries", 1, 40, 40, 40]);
  assertEquals(res.rows[2], ["books", 2, 35, 17.5, 25]);
});

Deno.test("jsonl: streaming round-trip parse and format", () => {
  const rows = [
    { id: 1, name: "Alpha", active: true },
    { id: 2, name: "Beta", active: false },
  ];
  const jsonl = formatJsonl(rows);
  const parsed = parseJsonl(jsonl);
  assertEquals(parsed, rows);
});

Deno.test("streamTabularTransform: transforms OPFS CSV stream end-to-end", async () => {
  const csvContent = "dept,employees,budget\nfinance,12,120000\nengineering,50,600000\nmarketing,15,150000\nengineering,25,300000\n";
  const inputRef = await createWasmStreamInput({ owner: OWNER, storage: fakeStorage });
  await appendWasmStreamInput({
    ref: inputRef,
    owner: OWNER,
    bytes: new TextEncoder().encode(csvContent),
    storage: fakeStorage,
  });
  await sealWasmStreamInput({ ref: inputRef, owner: OWNER, storage: fakeStorage });

  const res = await streamTabularTransform(inputRef, {
    operations: [
      { op: "filter", column: "dept", comparison: "eq", value: "engineering" },
      { op: "select", columns: ["dept", "employees", "budget"] },
    ],
    outputFormat: "csv",
    owner: OWNER,
    storage: fakeStorage,
  });

  assertEquals(res.ok, true);
  assertEquals(res.rowsCount, 2);
  assertEquals(res.columnsCount, 3);

  const outputValidated = await validateSealedWasmStream({ ref: res.outputRef, owner: OWNER, storage: fakeStorage });
  assert(outputValidated.bytes > 0);
  const file = await (await outputValidated.directory.getFileHandle("stdout.bin")).getFile();
  const text = await file.text();
  assert(text.includes("engineering,50,600000"));
  assert(text.includes("engineering,25,300000"));
  assert(!text.includes("finance"));
});

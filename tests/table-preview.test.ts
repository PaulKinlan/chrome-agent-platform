// @ts-nocheck
// tests/table-preview.test.ts — Bounded accessible native table preview for cap.table/1
// CAP-FB-20260822-SPREADSHEET-TOOLKIT-01 / chrome-agent-platform-def.5

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// ── minimal browser-global stubs (components.js touches these at load) ────
const registry = new Map();
class HTMLElementStub {
  attachShadow(_init) {
    return {
      innerHTML: "",
      querySelector() { return null; },
      querySelectorAll() { return []; },
      replaceChildren() {},
    };
  }
  getAttribute(_n) { return null; }
  hasAttribute(_n) { return false; }
  setAttribute(_n, _v) {}
  removeAttribute(_n) {}
  dispatchEvent(_e) { return true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
globalThis.HTMLElement = HTMLElementStub;
globalThis.customElements = {
  define(name, cls) { registry.set(name, cls); },
  get(name) { return registry.get(name); },
};
globalThis.window = globalThis;
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? {}; }
};
globalThis.matchMedia = () => ({ matches: false });

const {
  TABLE_PREVIEW_LIMITS,
  buildTablePreviewModel,
} = await import("../extension/shared/components.js");

Deno.test("table-preview: canonical cap.table/1 normalization and basic paging", () => {
  const capTable = {
    schema: "cap.table/1",
    columns: [
      { id: "c1", name: "Product", type: "string" },
      { id: "c2", name: "Price", type: "number" },
      { id: "c3", name: "InStock", type: "boolean" },
    ],
    rows: [
      ["Widget A", 19.99, true],
      ["Widget B", 29.50, false],
      ["Widget C", 9.95, true],
    ],
  };

  const model = buildTablePreviewModel(capTable, { pageSize: 2 });
  assertEquals(model.totalRows, 3);
  assertEquals(model.totalColumns, 3);
  assertEquals(model.totalPages, 2);
  assertEquals(model.page, 1);
  assertEquals(model.rows.length, 2); // page 1 has 2 rows
  assertEquals(model.columns.length, 3);
  assertEquals(model.omittedCols, 0);
  assertEquals(model.omittedRows, 1); // 1 row on next page
  assertEquals(model.mountedCells, 6);
  assertEquals(model.hasPrev, false);
  assertEquals(model.hasNext, true);
  assertStringIncludes(model.caption, "rows 1–2 of 3");
  assertStringIncludes(model.pageStatus, "Page 1 of 2");

  // Page 2
  const page2 = buildTablePreviewModel(capTable, { page: 2, pageSize: 2 });
  assertEquals(page2.page, 2);
  assertEquals(page2.rows.length, 1);
  assertEquals(page2.hasPrev, true);
  assertEquals(page2.hasNext, false);
  assertStringIncludes(page2.caption, "rows 3–3 of 3");
});

Deno.test("table-preview: bounds enforcement (maximum 50 rows x 20 cols / 1000 cells)", () => {
  // Generate large table: 150 rows x 35 columns
  const cols = Array.from({ length: 35 }, (_, i) => ({ id: `c${i + 1}`, name: `Col ${i + 1}`, type: "string" }));
  const rows = Array.from({ length: 150 }, (_, r) => cols.map((_, c) => `R${r + 1}C${c + 1}`));

  const model = buildTablePreviewModel({ columns: cols, rows }, { pageSize: 100, maxCols: 50 });

  // Page size capped at 50 max
  assertEquals(model.pageSize, TABLE_PREVIEW_LIMITS.maxRows);
  assertEquals(model.rows.length, 50);

  // Columns capped at 20 max
  assertEquals(model.columns.length, TABLE_PREVIEW_LIMITS.maxCols);
  assertEquals(model.omittedCols, 15); // 35 - 20 = 15 omitted

  // Mounted cells <= 1,000
  assertEquals(model.mountedCells, 50 * 20);
  assertEquals(model.mountedCells <= TABLE_PREVIEW_LIMITS.maxCells, true);

  // Explicit omitted counts reflected in caption
  assertStringIncludes(model.caption, "15 columns omitted");
  assertStringIncludes(model.caption, "rows 1–50 of 150");
});

Deno.test("table-preview: scalar-safe display truncation at <= 512 UTF-8 bytes", () => {
  const giantAscii = "A".repeat(1000);
  // Multi-byte Unicode: 3-byte Japanese characters
  const giantUnicode = "日本語テスト文字列です。".repeat(50); // ~1100 bytes

  const input = {
    columns: ["ID", "LargeText", "LargeUnicode"],
    rows: [
      [1, giantAscii, giantUnicode],
    ],
  };

  const model = buildTablePreviewModel(input);
  const row = model.rows[0];

  // Cell 1: ID = 1
  assertEquals(row[0].display, "1");
  assertEquals(row[0].truncated, false);

  // Cell 2: Giant ASCII truncated at <= 512 bytes
  const encoder = new TextEncoder();
  assert(row[1].truncated, "must flag truncated");
  assert(row[1].display.endsWith("…"));
  assert(encoder.encode(row[1].display).byteLength <= TABLE_PREVIEW_LIMITS.maxCellBytes);

  // Cell 3: Giant Unicode truncated cleanly without splitting multi-byte code points
  assert(row[2].truncated, "must flag truncated");
  assert(row[2].display.endsWith("…"));
  assert(encoder.encode(row[2].display).byteLength <= TABLE_PREVIEW_LIMITS.maxCellBytes);

  // Verify decoded text contains valid characters (no replacement \uFFFD from broken sequences)
  assert(!row[2].display.includes("\uFFFD"), "surrogate/multi-byte sequences must not be split");
});

Deno.test("table-preview: formula injection detection and warning counts", () => {
  const input = {
    columns: ["Name", "FormulaCol", "SafeCol"],
    rows: [
      ["Alice", "=SUM(A1:A10)", "42"],
      ["Bob", "+123456", "Normal"],
      ["Charlie", "-500", "Text"],
      ["Diana", "@macro_call", "Safe"],
      ["Eve", "|cmd /c calc", "Safe"],
      ["Frank", "\tleading_tab", "Safe"],
      ["Grace", "\rleading_cr", "Safe"],
      ["Heidi", "Plain text", "Safe"],
    ],
  };

  const model = buildTablePreviewModel(input);

  // Rows 0..6 contain formula cells
  assertEquals(model.formulaCellCount, 7);
  assertEquals(model.rows[0][1].isFormula, true); // =SUM
  assertEquals(model.rows[1][1].isFormula, true); // +123
  assertEquals(model.rows[2][1].isFormula, true); // -500
  assertEquals(model.rows[3][1].isFormula, true); // @macro
  assertEquals(model.rows[4][1].isFormula, true); // |cmd
  assertEquals(model.rows[5][1].isFormula, true); // \tleading
  assertEquals(model.rows[6][1].isFormula, true); // \rleading
  assertEquals(model.rows[7][1].isFormula, false); // Plain text
});

Deno.test("table-preview: CSV and array-of-objects input normalization", () => {
  // 1. CSV string
  const csv = "City,Population,Capital\nLondon,8982000,true\nManchester,547627,false\nEdinburgh,527620,true\n";
  const mCsv = buildTablePreviewModel(csv);
  assertEquals(mCsv.totalRows, 3);
  assertEquals(mCsv.columns.length, 3);
  assertEquals(mCsv.columns[0].name, "City");
  assertEquals(mCsv.rows[0][0].display, "London");

  // 2. Array of objects
  const objs = [
    { name: "Alpha", val: 10 },
    { name: "Beta", val: 20 },
  ];
  const mObjs = buildTablePreviewModel(objs);
  assertEquals(mObjs.totalRows, 2);
  assertEquals(mObjs.columns.length, 2);
  assertEquals(mObjs.columns[1].name, "val");
  assertEquals(mObjs.rows[1][1].display, "20");
});

Deno.test("table-preview: custom element registration and structural accessibility semantics", async () => {
  const TablePreviewCls = registry.get("table-preview");
  assert(TablePreviewCls !== undefined, "<table-preview> must be registered in customElements");

  const componentsSrc = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));

  // 1. Accessibility semantics: scope="col", <caption>, aria-live="polite", role="region"
  assertStringIncludes(componentsSrc, '<th scope="col"');
  assertStringIncludes(componentsSrc, "<caption>${escapeHtml(model.caption)}</caption>");
  assertStringIncludes(componentsSrc, '<span class="page-status" role="status" aria-live="polite">');
  assertStringIncludes(componentsSrc, 'nav class="pagination" aria-label="Table pagination"');
  assertStringIncludes(componentsSrc, 'role="region"');

  // 2. Visible focus styling
  assertStringIncludes(componentsSrc, ".scroller:focus-visible { outline:2px solid var(--accent,#0e6e63);");
  assertStringIncludes(componentsSrc, ".btn-p:focus-visible { outline:2px solid var(--accent,#0e6e63);");

  // 3. Formula export warnings notice
  assertStringIncludes(componentsSrc, 'class="formula-warning" role="note"');
  assertStringIncludes(componentsSrc, "Export notice:");

  // 4. ArtifactInspector integration
  assertStringIncludes(componentsSrc, 'const isTable = a.type === "table" || a.type === "cap.table/1"');
  assertStringIncludes(componentsSrc, 'document.createElement("table-preview")');
});

// @ts-nocheck
// tests/extract-tables-3p3e8.test.ts — comprehensive tests for extract_tables and injectedTableExtractor (3p3e.8)
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  extractTablesFromDom,
  extractTablesFromHtml,
  injectedTableExtractor,
  toCanonicalTable,
  createTabularArtifact,
  TABLE_EXTRACTOR_LIMITS,
} from "../extension/lib/table-extractor.js";
import {
  filterTable,
  canonicalTableJson,
  assertCanonicalTable,
  TABLE_VERSION,
  TABLE_MEDIA_TYPE,
} from "../extension/lib/table-core.js";
import { runTableArtifactTool } from "../extension/lib/table-tool-runtime.js";
import { toolUserLanguage, TOOL_USER_LANGUAGE } from "../extension/lib/permission-language.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";
import { replaySafetyForTool, REPLAY_READ_ONLY } from "../extension/lib/tool-replay-safety.js";
import { BROWSER_TOOL_NAMES, chromeToolCapability } from "../extension/lib/chrome-tool-capabilities.js";
import { browserToolset, extractTables } from "../extension/lib/browser-tools.js";

/** Lightweight MockNode hierarchy for direct unit testing of injectedTableExtractor. */
class MockNode {
  tagName: string;
  nodeType: number; // 1 = ELEMENT, 3 = TEXT
  nodeValue: string | null;
  attributes: Map<string, string>;
  children: MockNode[];
  parentElement: MockNode | null;
  previousElementSibling: MockNode | null;

  constructor(tagName: string, nodeType = 1, text: string | null = null) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = nodeType;
    this.nodeValue = text;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.previousElementSibling = null;
  }

  get childNodes() {
    return this.children;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.children.map((c) => c.textContent).join("");
  }

  set textContent(val: string) {
    this.children = [new MockNode("#text", 3, val)];
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name: string, val: string) {
    this.attributes.set(name.toLowerCase(), val);
  }

  appendChild(child: MockNode) {
    child.parentElement = this;
    const prev = this.children[this.children.length - 1];
    if (prev && prev.nodeType === 1) {
      child.previousElementSibling = prev;
    }
    this.children.push(child);
    return child;
  }

  querySelector(selector: string): MockNode | null {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }

  querySelectorAll(selector: string): MockNode[] {
    const results: MockNode[] = [];
    const lower = selector.toLowerCase().trim();
    function match(node: MockNode): boolean {
      if (node.nodeType !== 1) return false;
      const tag = node.tagName.toLowerCase();
      if (lower === "table" && tag === "table") return true;
      if (lower === "caption" && tag === "caption") return true;
      if (lower === "tr" && tag === "tr") return true;
      if (lower === "th, td" || lower === "td, th") return tag === "th" || tag === "td";
      if (lower === '[role="table"], [role="grid"]') {
        const r = node.getAttribute("role");
        return r === "table" || r === "grid";
      }
      if (lower === '[role="columnheader"]' && node.getAttribute("role") === "columnheader") return true;
      if (lower === '[role="row"]' && node.getAttribute("role") === "row") return true;
      if (lower === '[role="gridcell"], [role="cell"]') {
        const r = node.getAttribute("role");
        return r === "gridcell" || r === "cell";
      }
      return false;
    }
    function walk(node: MockNode) {
      for (const child of node.children) {
        if (match(child)) results.push(child);
        walk(child);
      }
    }
    walk(this);
    return results;
  }
}

function createMockDocument(): { body: MockNode; querySelectorAll: (sel: string) => MockNode[]; getElementById: (id: string) => MockNode | null } {
  const body = new MockNode("body");
  return {
    body,
    querySelectorAll(sel: string) {
      return body.querySelectorAll(sel);
    },
    getElementById(id: string) {
      let found: MockNode | null = null;
      function walk(node: MockNode) {
        if (found) return;
        if (node.getAttribute("id") === id) {
          found = node;
          return;
        }
        for (const child of node.children) walk(child);
      }
      walk(body);
      return found;
    },
  };
}

// ── 1. Pure extractor over fixture HTML with 3 tables (Acceptance 1) ──────────
Deno.test("table-extractor: fixture page with 3 tables extracts all 3 with headers and rows (Acceptance 1)", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head><title>Test Store & Conference</title></head>
      <body>
        <!-- Table 1: Standard HTML <table> -->
        <h1>Fruit Inventory</h1>
        <table id="fruits-table">
          <caption>Fruit Prices and Stock</caption>
          <thead>
            <tr>
              <th>Fruit Item</th>
              <th>Unit Price</th>
              <th>In Stock</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Honeycrisp Apple</td><td>$1.50</td><td>120</td></tr>
            <tr><td>Organic Banana</td><td>$0.75</td><td>340</td></tr>
            <tr><td>Valencia Orange</td><td>$1.20</td><td>85</td></tr>
          </tbody>
        </table>

        <!-- Table 2: ARIA role="grid" -->
        <div role="grid" aria-label="Conference Speakers 2026">
          <div role="row">
            <div role="columnheader">Speaker Name</div>
            <div role="columnheader">Session Topic</div>
            <div role="columnheader">Time Slot</div>
          </div>
          <div role="row">
            <div role="gridcell">Dr. Alice Chen</div>
            <div role="gridcell">Neural Agents on Edge</div>
            <div role="gridcell">10:00 AM</div>
          </div>
          <div role="row">
            <div role="gridcell">Bob Builder</div>
            <div role="gridcell">Wasm Sandboxing Architecture</div>
            <div role="gridcell">11:30 AM</div>
          </div>
        </div>

        <!-- Table 3: Repeated-card list -->
        <h2>Hosting Plans</h2>
        <div class="cards" aria-label="Cloud Hosting Tiers">
          <div class="card">
            <h3>Starter</h3>
            <span class="price">$5/mo</span>
            <span class="category">Basic</span>
          </div>
          <div class="card">
            <h3>Pro</h3>
            <span class="price">$25/mo</span>
            <span class="category">Business</span>
          </div>
          <div class="card">
            <h3>Enterprise</h3>
            <span class="price">$100/mo</span>
            <span class="category">Scale</span>
          </div>
        </div>
      </body>
    </html>
  `;

  const result = extractTablesFromHtml(html);
  assert(result && Array.isArray(result.tables), "Extractor must return tables array");
  assertEquals(result.tables.length, 3, "Must extract exactly 3 tables from fixture");

  // Table 1 checks
  const t1 = result.tables[0];
  assertEquals(t1.caption, "Fruit Prices and Stock");
  assertEquals(t1.headers, ["Fruit Item", "Unit Price", "In Stock"]);
  assertEquals(t1.rows.length, 3);
  assertEquals(t1.rows[0], ["Honeycrisp Apple", "$1.50", "120"]);
  assertEquals(t1.rows[1], ["Organic Banana", "$0.75", "340"]);
  assertEquals(t1.rows[2], ["Valencia Orange", "$1.20", "85"]);
  assertEquals(t1.truncated, false);
});

// ── 2. Direct table_filter execution on emitted tabular artifact (Acceptance 2) ─
Deno.test("table-extractor: table_filter on the emitted artifact works directly with no conversion step (Acceptance 2)", async () => {
  const extractedTable = {
    caption: "Server Cluster Metrics",
    headers: ["Host", "Status", "Load"],
    rows: [
      ["node-01", "healthy", "0.45"],
      ["node-02", "degraded", "0.92"],
      ["node-03", "healthy", "0.12"],
    ],
  };

  const storedAssets = new Map();
  const mockCreateAsset = async (origin, assetData) => {
    const id = `art_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const full = { id, origin, ...assetData };
    storedAssets.set(id, full);
    return { ok: true, id, asset: full };
  };

  const artifactRes = await createTabularArtifact(extractedTable, {
    name: "Server Metrics Test",
    origin: "master",
    createAssetFn: mockCreateAsset,
  });

  assert(artifactRes.artifactId, "Must return an artifactId");
  const asset = storedAssets.get(artifactRes.artifactId);
  assert(asset, "Asset must exist in storage");
  assertEquals(asset.meta.mediaType, TABLE_MEDIA_TYPE);
  assertEquals(asset.meta.schema, TABLE_VERSION);

  const filterResult = filterTable(JSON.parse(asset.content), {
    predicate: { column: "c2", op: "eq", value: "healthy" },
  });

  assert(filterResult && filterResult.table, "Must return filtered table result");
  assertEquals(filterResult.table.rows.length, 2, "Must filter down to 2 healthy nodes");
  assertEquals(filterResult.table.rows[0][0], "node-01");
  assertEquals(filterResult.table.rows[1][0], "node-03");
});

// ── 3. 10k-row fixture returning truncated: true (Acceptance 3) ─────────────────
Deno.test("table-extractor: 10k-row fixture returns truncated: true bounded to 2000 rows (Acceptance 3)", () => {
  const rowCount = 10000;
  let trs = "";
  for (let i = 0; i < rowCount; i++) {
    trs += `<tr><td>Row-${i}</td><td>Value-${i}</td></tr>`;
  }
  const html = `
    <table>
      <thead><tr><th>Index</th><th>Payload</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;

  const result = extractTablesFromHtml(html, { maxRows: 2000 });
  assertEquals(result.tables.length, 1);
  const t = result.tables[0];
  assertEquals(t.headers, ["Index", "Payload"]);
  assertEquals(t.rows.length, 2000, "Must be bounded to exactly maxRows (2000)");
  assertEquals(t.truncated, true, "Must flag truncated: true");
  assertEquals(t.truncationReason, "row-limit", "Must specify truncationReason: row-limit");
});

// ── 4. Injected production extractor: Headerless tables (P1c) ───────────────────
Deno.test("injectedTableExtractor: headerless data-only table synthesizes headers without dropping data (P1c)", () => {
  const doc = createMockDocument();
  const tbl = new MockNode("table");
  const tr = new MockNode("tr");
  const td1 = new MockNode("td"); td1.appendChild(new MockNode("#text", 3, "Widget A"));
  const td2 = new MockNode("td"); td2.appendChild(new MockNode("#text", 3, "$19.99"));
  tr.appendChild(td1);
  tr.appendChild(td2);
  tbl.appendChild(tr);
  doc.body.appendChild(tbl);

  const res = injectedTableExtractor({ customDocument: doc });
  assertEquals(res.tables.length, 1);
  const t = res.tables[0];
  assertEquals(t.headers, ["Column 1", "Column 2"]);
  assertEquals(t.rows.length, 1);
  assertEquals(t.rows[0], ["Widget A", "$19.99"]);
  assertEquals(t.rowCount, 1);
  assertEquals(t.columnCount, 2);
  assertEquals(t.truncated, false);
});

// ── 5. Injected production extractor: Rowspan & Colspan (P1c) ────────────────────
Deno.test("injectedTableExtractor: 2D occupancy grid correctly propagates rowspan and colspan across cells (P1c)", () => {
  const doc = createMockDocument();
  const tbl = new MockNode("table");

  // Header: 1 single column + 1 spanning column
  const thead = new MockNode("thead");
  const htr = new MockNode("tr");
  const th1 = new MockNode("th"); th1.appendChild(new MockNode("#text", 3, "Region"));
  const th2 = new MockNode("th"); th2.setAttribute("colspan", "2"); th2.appendChild(new MockNode("#text", 3, "Quarterly Stats"));
  htr.appendChild(th1); htr.appendChild(th2); thead.appendChild(htr);
  tbl.appendChild(thead);

  // Body: Row 1 has Region spanning 2 rows
  const tbody = new MockNode("tbody");
  const r1 = new MockNode("tr");
  const tdR1 = new MockNode("td"); tdR1.setAttribute("rowspan", "2"); tdR1.appendChild(new MockNode("#text", 3, "North"));
  const tdQ1 = new MockNode("td"); tdQ1.appendChild(new MockNode("#text", 3, "Q1"));
  const tdV1 = new MockNode("td"); tdV1.appendChild(new MockNode("#text", 3, "100"));
  r1.appendChild(tdR1); r1.appendChild(tdQ1); r1.appendChild(tdV1);
  tbody.appendChild(r1);

  // Row 2: Region is occupied by North; only Q2 and 200 are in HTML
  const r2 = new MockNode("tr");
  const tdQ2 = new MockNode("td"); tdQ2.appendChild(new MockNode("#text", 3, "Q2"));
  const tdV2 = new MockNode("td"); tdV2.appendChild(new MockNode("#text", 3, "200"));
  r2.appendChild(tdQ2); r2.appendChild(tdV2);
  tbody.appendChild(r2);

  tbl.appendChild(tbody);
  doc.body.appendChild(tbl);

  const res = injectedTableExtractor({ customDocument: doc });
  assertEquals(res.tables.length, 1);
  const t = res.tables[0];
  assertEquals(t.headers, ["Region", "Quarterly Stats", "Quarterly Stats_2"]);
  assertEquals(t.rows.length, 2);
  assertEquals(t.rows[0], ["North", "Q1", "100"]);
  assertEquals(t.rows[1], ["North", "Q2", "200"]);
});

// ── 6. Injected production extractor: Nested tables (P1a/P1c) ───────────────────
Deno.test("injectedTableExtractor: nested tables do not pollute parent rows and extract independently", () => {
  const doc = createMockDocument();

  // Outer table
  const outer = new MockNode("table");
  outer.setAttribute("aria-label", "Outer Table");
  const oThead = new MockNode("thead");
  const oHtr = new MockNode("tr");
  const oTh1 = new MockNode("th"); oTh1.appendChild(new MockNode("#text", 3, "Outer Col 1"));
  const oTh2 = new MockNode("th"); oTh2.appendChild(new MockNode("#text", 3, "Outer Col 2"));
  oHtr.appendChild(oTh1); oHtr.appendChild(oTh2); oThead.appendChild(oHtr);
  outer.appendChild(oThead);

  const oTbody = new MockNode("tbody");
  const oTr = new MockNode("tr");
  const oTd1 = new MockNode("td"); oTd1.appendChild(new MockNode("#text", 3, "Outer Val 1"));
  const oTd2 = new MockNode("td"); // contains inner table
  const inner = new MockNode("table");
  inner.setAttribute("aria-label", "Inner Table");
  const iThead = new MockNode("thead");
  const iHtr = new MockNode("tr");
  const iTh1 = new MockNode("th"); iTh1.appendChild(new MockNode("#text", 3, "Inner Col 1"));
  iHtr.appendChild(iTh1); iThead.appendChild(iHtr);
  inner.appendChild(iThead);
  const iTbody = new MockNode("tbody");
  const iTr = new MockNode("tr");
  const iTd1 = new MockNode("td"); iTd1.appendChild(new MockNode("#text", 3, "Inner Val 1"));
  iTr.appendChild(iTd1); iTbody.appendChild(iTr);
  inner.appendChild(iTbody);

  oTd2.appendChild(inner);
  oTr.appendChild(oTd1); oTr.appendChild(oTd2);
  oTbody.appendChild(oTr);
  outer.appendChild(oTbody);
  doc.body.appendChild(outer);

  const res = injectedTableExtractor({ customDocument: doc });
  assertEquals(res.tables.length, 2);
  assertEquals(res.tables[0].caption, "Outer Table");
  assertEquals(res.tables[0].headers, ["Outer Col 1", "Outer Col 2"]);
  assertEquals(res.tables[0].rows, [["Outer Val 1", ""]]);

  assertEquals(res.tables[1].caption, "Inner Table");
  assertEquals(res.tables[1].headers, ["Inner Col 1"]);
  assertEquals(res.tables[1].rows, [["Inner Val 1"]]);
});

// ── 7. Injected production extractor: Huge cells bounded (P1a) ───────────────────
Deno.test("injectedTableExtractor: huge cell text bounded to maxCellChars BEFORE copying (P1a)", () => {
  const doc = createMockDocument();
  const tbl = new MockNode("table");
  const tr = new MockNode("tr");
  const td = new MockNode("td");
  const hugeString = "Z".repeat(50000);
  td.appendChild(new MockNode("#text", 3, hugeString));
  tr.appendChild(td);
  tbl.appendChild(tr);
  doc.body.appendChild(tbl);

  const res = injectedTableExtractor({ customDocument: doc, maxCellChars: 128 });
  assertEquals(res.tables.length, 1);
  assertEquals(res.tables[0].rows[0][0].length, 128);
  assertEquals(res.tables[0].rows[0][0], "Z".repeat(128));
});

// ── 8. Injected production extractor: Whole-page aggregate limits (P1a) ─────────
Deno.test("injectedTableExtractor: whole-page table and work budgets enforce truncation with explicit reasons (P1a)", () => {
  const doc = createMockDocument();
  for (let i = 0; i < 5; i++) {
    const tbl = new MockNode("table");
    tbl.setAttribute("aria-label", `Table-${i}`);
    const tr = new MockNode("tr");
    const td = new MockNode("td"); td.appendChild(new MockNode("#text", 3, `val-${i}`));
    tr.appendChild(td); tbl.appendChild(tr);
    doc.body.appendChild(tbl);
  }

  const res = injectedTableExtractor({ customDocument: doc, maxTablesPerPage: 2 });
  assertEquals(res.count, 2);
  assertEquals(res.pageTruncated, true);
  assertEquals(res.pageTruncationReason, "table-limit");
});

// ── 9. Tool capability, permission language, purpose group ───────────────────────
Deno.test("extract_tables: registration, replay-safety, purpose-groups, and permission language", () => {
  assert(BROWSER_TOOL_NAMES.includes("extract_tables"), "Must be in BROWSER_TOOL_NAMES");
  const cap = chromeToolCapability("extract_tables", "chrome-api");
  assert(cap, "Must have capability row");
  assertEquals(cap.sourceKind, "chrome-api");
  assertEquals(cap.policyClass, "read");
  assertEquals(cap.replayClass, "read-only");
  assertEquals(replaySafetyForTool("extract_tables"), REPLAY_READ_ONLY);
  assertEquals(toolPurposeGroup("extract_tables"), "reading-capture");
  assertEquals(toolUserLanguage("extract_tables"), "Extract tables from page");
  assert(browserToolset().extract_tables, "Must be registered in browserToolset");
});

// ── 10. Refusal of privileged chrome:// URLs ────────────────────────────────────
Deno.test("extract_tables: refuses privileged chrome:// URLs before script injection", async () => {
  const previousChrome = (globalThis as any).chrome;
  (globalThis as any).chrome = {
    tabs: {
      get: async (id: number) => ({ id, url: "chrome://settings" }),
    },
    storage: {
      local: {
        get: async () => ({ "cap:browserControlGrant": { allowed: true } }),
      },
    },
    scripting: {
      executeScript: async () => {
        throw new Error("executeScript must NOT be reached for privileged URL");
      },
    },
  };

  try {
    const res = await extractTables(123);
    assert(res && typeof res === "object", "Must return result object");
    assert(res.error || res.untrusted, "Must return refusal/error");
    const str = JSON.stringify(res);
    assert(str.includes("privileged") || str.includes("refused") || str.includes("not allowed"), "Must state refusal");
  } finally {
    (globalThis as any).chrome = previousChrome;
  }
});

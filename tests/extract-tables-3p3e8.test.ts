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
    const selectors = selector.split(",").map((s) => s.trim().toLowerCase());
    function match(node: MockNode): boolean {
      if (node.nodeType !== 1) return false;
      const tag = node.tagName.toLowerCase();
      const cls = (node.getAttribute("class") || "").toLowerCase().split(/\s+/);
      const role = (node.getAttribute("role") || "").toLowerCase();
      for (const s of selectors) {
        if (s === "table" && tag === "table") return true;
        if (s === "caption" && tag === "caption") return true;
        if (s === "thead tr" && tag === "tr" && node.parentElement?.tagName?.toLowerCase() === "thead") return true;
        if (s === "tr" && tag === "tr") return true;
        if ((s === "th" || s === "td") && (tag === "th" || tag === "td")) return true;
        if (s === "dt" && tag === "dt") return true;
        if (s === "dd" && tag === "dd") return true;
        if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(s) && tag === s) return true;
        if (s === '[role="columnheader"]' && role === "columnheader") return true;
        if (s === '[role="row"]' && role === "row") return true;
        if ((s === '[role="gridcell"]' || s === '[role="cell"]') && (role === "gridcell" || role === "cell")) return true;
        if ((s === '[role="table"]' || s === '[role="grid"]') && (role === "table" || role === "grid")) return true;
        if (s === '[role="list"]' && role === "list") return true;
        if (s === "ul" && tag === "ul") return true;
        if (s === "ol" && tag === "ol") return true;
        if (s === "[data-field]" && node.getAttribute("data-field")) return true;
        if (s === "[class]" && node.getAttribute("class")) return true;
        if (s.startsWith(".") && cls.includes(s.slice(1))) return true;
        if (s.startsWith("div.") && tag === "div" && cls.includes(s.slice(4))) return true;
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
            <h2>Starter</h2>
            <span class="price">$5/mo</span>
            <span class="category">Basic</span>
          </div>
          <div class="card">
            <h2>Pro</h2>
            <span class="price">$25/mo</span>
            <span class="category">Business</span>
          </div>
          <div class="card">
            <h2>Enterprise</h2>
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

  // Detailed Table 1 checks (HTML table)
  const t1 = result.tables[0];
  assertEquals(t1.caption, "Fruit Prices and Stock");
  assertEquals(t1.headers, ["Fruit Item", "Unit Price", "In Stock"]);
  assertEquals(t1.rows.length, 3);
  assertEquals(t1.rows[0], ["Honeycrisp Apple", "$1.50", "120"]);
  assertEquals(t1.rows[1], ["Organic Banana", "$0.75", "340"]);
  assertEquals(t1.rows[2], ["Valencia Orange", "$1.20", "85"]);
  assertEquals(t1.truncated, false);

  // Detailed Table 2 checks (ARIA grid)
  const t2 = result.tables[1];
  assertEquals(t2.caption, "Conference Speakers 2026");
  assertEquals(t2.headers, ["Speaker Name", "Session Topic", "Time Slot"]);
  assertEquals(t2.rows.length, 2);
  assertEquals(t2.rows[0], ["Dr. Alice Chen", "Neural Agents on Edge", "10:00 AM"]);
  assertEquals(t2.rows[1], ["Bob Builder", "Wasm Sandboxing Architecture", "11:30 AM"]);
  assertEquals(t2.truncated, false);

  // Detailed Table 3 checks (Repeated-card list)
  const t3 = result.tables[2];
  assertEquals(t3.caption, "Cloud Hosting Tiers");
  assertEquals(t3.headers, ["Title", "Price", "Category"]);
  assertEquals(t3.rows.length, 3);
  assertEquals(t3.rows[0], ["Starter", "$5/mo", "Basic"]);
  assertEquals(t3.rows[1], ["Pro", "$25/mo", "Business"]);
  assertEquals(t3.rows[2], ["Enterprise", "$100/mo", "Scale"]);
  assertEquals(t3.truncated, false);
});

// ── 2. Direct runTableArtifactTool execution with emitted artifact ID (Acceptance 2) ─
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

  const context = Object.freeze({
    principal: "model",
    executionId: "exec:11111111-1111-4111-8111-111111111111",
    runId: "exec:11111111-1111-4111-8111-111111111111",
    agentId: "agent-instance-a",
  });

  let outputArtifact = null;
  const toolResult = await runTableArtifactTool(
    "table_filter",
    {
      source: { artifactId: artifactRes.artifactId, format: TABLE_VERSION },
      predicate: { column: "c2", op: "eq", value: "healthy" },
    },
    context,
    {
      readAsset: async (_origin, id) => {
        const a = storedAssets.get(id);
        if (!a) return { ok: false, error: "not found" };
        return { ok: true, asset: a };
      },
      stageAsset: async (assetToStage) => ({
        ok: true,
        inputRef: { id: "s1", kind: "input" },
        bytes: new TextEncoder().encode(assetToStage.content).byteLength,
        chained: false,
      }),
      discardStream: async () => ({ ok: true }),
      isRunLive: () => true,
      runJob: async (job) => {
        const sourceAsset = storedAssets.get(artifactRes.artifactId);
        const canonical = JSON.parse(sourceAsset.content);
        const filtered = filterTable(canonical, { predicate: job.request.predicate });
        return { ok: true, table: filtered.table, workUnits: 1 };
      },
      createArtifact: async (origin, data) => {
        const id = "art_filtered_result";
        outputArtifact = { id, origin, ...data };
        storedAssets.set(id, outputArtifact);
        return { ok: true, id, asset: outputArtifact };
      },
    },
  );

  assert(toolResult.ok, `Filter execution failed: ${toolResult.error}`);
  assertEquals(toolResult.rows, 2, "Must return metadata showing 2 rows filtered");
  assertEquals(toolResult.columns, 3, "Must preserve 3 columns");
  const filteredOutput = JSON.parse(outputArtifact.content);
  assertEquals(filteredOutput.rows.length, 2);
  assertEquals(filteredOutput.rows[0], ["node-01", "healthy", "0.45"]);
  assertEquals(filteredOutput.rows[1], ["node-03", "healthy", "0.12"]);
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

// ── 5. Injected production extractor: Rowspan & Colspan with collision (P1c) ────
Deno.test("injectedTableExtractor: collision fixture advances past occupied slots (col 2 rowspan, new col 1 colspan=2) (P1c)", () => {
  const doc = createMockDocument();
  const tbl = new MockNode("table");

  // Row 0: Cell 0 = "A", Cell 1 = "B" with rowspan=2
  const r0 = new MockNode("tr");
  const tdA = new MockNode("td"); tdA.appendChild(new MockNode("#text", 3, "A"));
  const tdB = new MockNode("td"); tdB.setAttribute("rowspan", "2"); tdB.appendChild(new MockNode("#text", 3, "B"));
  r0.appendChild(tdA); r0.appendChild(tdB);
  tbl.appendChild(r0);

  // Row 1: Cell 0 = "C" with colspan=2.
  // Col 0 gets "C". Col 1 is occupied by "B", so second span of "C" must advance to Col 2!
  const r1 = new MockNode("tr");
  const tdC = new MockNode("td"); tdC.setAttribute("colspan", "2"); tdC.appendChild(new MockNode("#text", 3, "C"));
  r1.appendChild(tdC);
  tbl.appendChild(r1);

  doc.body.appendChild(tbl);

  const res = injectedTableExtractor({ customDocument: doc });
  assertEquals(res.tables.length, 1);
  const t = res.tables[0];
  assertEquals(t.rows.length, 2);
  assertEquals(t.rows[0], ["A", "B", ""]);
  assertEquals(t.rows[1], ["C", "B", "C"], "Colspan must advance past occupied rowspan slot without overwriting");
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
Deno.test("injectedTableExtractor: huge cell text bounded to maxCellChars AT SOURCE (P1a)", () => {
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
Deno.test("injectedTableExtractor: whole-page table, cell, and time budgets enforce truncation (P1a)", async () => {
  // Test 8a: maxTablesPerPage
  const doc1 = createMockDocument();
  for (let i = 0; i < 5; i++) {
    const tbl = new MockNode("table");
    tbl.setAttribute("aria-label", `Table-${i}`);
    const tr = new MockNode("tr");
    const td = new MockNode("td"); td.appendChild(new MockNode("#text", 3, `val-${i}`));
    tr.appendChild(td); tbl.appendChild(tr);
    doc1.body.appendChild(tbl);
  }

  const resTableLimit = injectedTableExtractor({ customDocument: doc1, maxTablesPerPage: 2 });
  assertEquals(resTableLimit.count, 2);
  assertEquals(resTableLimit.pageTruncated, true);
  assertEquals(resTableLimit.pageTruncationReason, "table-limit");

  // Test 8b: maxTotalCellsPerPage budget
  const doc2 = createMockDocument();
  const tblBig = new MockNode("table");
  for (let r = 0; r < 20; r++) {
    const tr = new MockNode("tr");
    for (let c = 0; c < 10; c++) {
      const td = new MockNode("td");
      td.appendChild(new MockNode("#text", 3, `c${r}_${c}`));
      tr.appendChild(td);
    }
    tblBig.appendChild(tr);
  }
  doc2.body.appendChild(tblBig);

  const resCellBudget = injectedTableExtractor({ customDocument: doc2, maxTotalCellsPerPage: 50 });
  assertEquals(resCellBudget.pageTruncated, true);
  assertEquals(resCellBudget.pageTruncationReason, "cell-budget");
  assert(resCellBudget.tables[0].rows.length <= 5, "Must abort row extraction once cell budget is hit");

  // Test 8c: maxExecutionTimeMs timeout
  const doc3 = createMockDocument();
  const tblTimed = new MockNode("table");
  for (let r = 0; r < 100; r++) {
    const tr = new MockNode("tr");
    const td = new MockNode("td");
    td.appendChild(new MockNode("#text", 3, `timed-${r}`));
    tr.appendChild(td);
    tblTimed.appendChild(tr);
  }
  doc3.body.appendChild(tblTimed);

  // Set timeout to 0ms to immediately trip time budget
  const resTimeout = injectedTableExtractor({ customDocument: doc3, maxExecutionTimeMs: 0 });
  assertEquals(resTimeout.pageTruncated, true);
  assertEquals(resTimeout.pageTruncationReason, "timeout");
});

// ── 9. DOM-root scope: extractTablesFromDom must not escape root (P2) ───────────
Deno.test("extractTablesFromDom: scoped subtree root does not extract tables outside it (P2)", () => {
  const doc = createMockDocument();

  const containerA = new MockNode("div");
  containerA.setAttribute("id", "container-a");
  const tblInScope = new MockNode("table");
  tblInScope.setAttribute("aria-label", "Table In Scope");
  const trA = new MockNode("tr");
  const tdA = new MockNode("td"); tdA.appendChild(new MockNode("#text", 3, "In Scope"));
  trA.appendChild(tdA); tblInScope.appendChild(trA);
  containerA.appendChild(tblInScope);
  doc.body.appendChild(containerA);

  const containerB = new MockNode("div");
  containerB.setAttribute("id", "container-b");
  const tblOutOfScope = new MockNode("table");
  tblOutOfScope.setAttribute("aria-label", "Table Outside Scope");
  const trB = new MockNode("tr");
  const tdB = new MockNode("td"); tdB.appendChild(new MockNode("#text", 3, "Outside Scope"));
  trB.appendChild(tdB); tblOutOfScope.appendChild(trB);
  containerB.appendChild(tblOutOfScope);
  doc.body.appendChild(containerB);

  // Call extractTablesFromDom specifically scoping to containerA
  const res = extractTablesFromDom(containerA);
  assertEquals(res.tables.length, 1);
  assertEquals(res.tables[0].caption, "Table In Scope");
  assertEquals(res.tables[0].rows[0][0], "In Scope");
});

// ── 10. Tool capability, permission language, purpose group ──────────────────────
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

// ── 11. Refusal of privileged chrome:// URLs ────────────────────────────────────
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

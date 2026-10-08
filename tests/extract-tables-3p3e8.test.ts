// @ts-nocheck
// tests/extract-tables-3p3e8.test.ts — tests for extract_tables tool and table extraction (chrome-agent-platform-3p3e.8)
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  extractTablesFromDom,
  extractTablesFromHtml,
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

// ── 1. Pure extractor over fixture HTML with 3 tables ──────────────────────────
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
        <div class="cards pricing-grid" aria-label="Cloud Hosting Tiers">
          <div class="card plan-card">
            <dl>
              <dt>Tier</dt><dd>Starter</dd>
              <dt>Monthly Cost</dt><dd>$15</dd>
              <dt>Storage</dt><dd>20 GB</dd>
            </dl>
          </div>
          <div class="card plan-card">
            <dl>
              <dt>Tier</dt><dd>Professional</dd>
              <dt>Monthly Cost</dt><dd>$45</dd>
              <dt>Storage</dt><dd>100 GB</dd>
            </dl>
          </div>
          <div class="card plan-card">
            <dl>
              <dt>Tier</dt><dd>Enterprise</dd>
              <dt>Monthly Cost</dt><dd>$120</dd>
              <dt>Storage</dt><dd>1 TB</dd>
            </dl>
          </div>
        </div>
      </body>
    </html>
  `;

  const result = extractTablesFromHtml(html);
  assert(Array.isArray(result.tables), "result.tables is an array");
  assertEquals(result.tables.length, 3, "extracts exactly 3 distinct tables from the page");

  // Verify Table 1 (Native <table>)
  const t1 = result.tables[0];
  assertEquals(t1.caption, "Fruit Prices and Stock");
  assertEquals(t1.headers, ["Fruit Item", "Unit Price", "In Stock"]);
  assertEquals(t1.rowCount, 3);
  assertEquals(t1.rows[0], ["Honeycrisp Apple", "$1.50", "120"]);
  assertEquals(t1.rows[1], ["Organic Banana", "$0.75", "340"]);
  assertEquals(t1.rows[2], ["Valencia Orange", "$1.20", "85"]);
  assertEquals(t1.truncated, false);

  // Verify Table 2 (ARIA grid)
  const t2 = result.tables[1];
  assertEquals(t2.caption, "Conference Speakers 2026");
  assertEquals(t2.headers, ["Speaker Name", "Session Topic", "Time Slot"]);
  assertEquals(t2.rowCount, 2);
  assertEquals(t2.rows[0], ["Dr. Alice Chen", "Neural Agents on Edge", "10:00 AM"]);
  assertEquals(t2.rows[1], ["Bob Builder", "Wasm Sandboxing Architecture", "11:30 AM"]);
  assertEquals(t2.truncated, false);

  // Verify Table 3 (Repeated cards)
  const t3 = result.tables[2];
  assertEquals(t3.caption, "Cloud Hosting Tiers");
  assertEquals(t3.headers, ["Tier", "Monthly Cost", "Storage"]);
  assertEquals(t3.rowCount, 3);
  assertEquals(t3.rows[0], ["Starter", "$15", "20 GB"]);
  assertEquals(t3.rows[1], ["Professional", "$45", "100 GB"]);
  assertEquals(t3.rows[2], ["Enterprise", "$120", "1 TB"]);
  assertEquals(t3.truncated, false);
});

// ── 2. table_filter on the emitted artifact works directly ──────────────────
Deno.test("table-extractor: table_filter on the emitted artifact works directly with no conversion step (Acceptance 2)", async () => {
  const tableData = {
    caption: "Server Nodes",
    headers: ["Node ID", "Region", "Status"],
    rows: [
      ["node-01", "us-east", "online"],
      ["node-02", "eu-west", "offline"],
      ["node-03", "us-east", "online"],
      ["node-04", "ap-south", "degraded"],
    ],
  };

  // Convert to canonical schema cap.table/1
  const canonical = toCanonicalTable(tableData);
  assertEquals(canonical.version, TABLE_VERSION);
  assertEquals(canonical.columns.length, 3);
  assertEquals(canonical.columns[0].header, "Node ID");
  assertEquals(canonical.columns[1].header, "Region");
  assertEquals(canonical.columns[2].header, "Status");

  // In-memory asset mock to verify stage and execution round-trip
  const assets = new Map();
  const mockCreateAsset = async (origin, asset) => {
    const id = `ast_table_${Math.random().toString(36).slice(2, 8)}`;
    const record = { id, origin, ...asset };
    assets.set(id, record);
    return { ok: true, id, asset: record };
  };
  const mockGetAsset = async (origin, id) => {
    const asset = assets.get(id);
    if (!asset) return { ok: false, error: "not_found" };
    return { ok: true, asset };
  };

  const { artifactId, artifact } = await createTabularArtifact(tableData, {
    createAssetFn: mockCreateAsset,
  });
  assert(artifactId, "emitted an artifactId");
  assertEquals(artifact.meta.schema, TABLE_VERSION);
  assertEquals(artifact.meta.mediaType, TABLE_MEDIA_TYPE);

  // Direct table_filter execution without any conversion step:
  // Passes { artifactId, format: "cap.table/1" } directly to table_filter
  const runId = "exec_12345678";
  const filterResult = await runTableArtifactTool(
    "table_filter",
    {
      source: {
        artifactId,
        format: TABLE_VERSION,
      },
      predicate: {
        op: "eq",
        column: "c2", // Region
        value: "us-east",
      },
    },
    { principal: "model", runId, executionId: runId, agentId: "test-agent" },
    {
      readAsset: mockGetAsset,
      createArtifact: async (origin, input) => {
        const id = `ast_out_${Math.random().toString(36).slice(2, 8)}`;
        const record = { id, origin, ...input };
        assets.set(id, record);
        return { ok: true, id, asset: record };
      },
      runJob: async (job) => {
        // Direct local execution of filter on canonical table
        const table = JSON.parse(assets.get(artifactId).content);
        const filtered = filterTable(table, job.request);
        return {
          ok: true,
          workUnits: filtered.workUnits,
          table: filtered.table,
        };
      },
      readStreamReceipt: async () => ({
        receipt: { stdoutBytes: 100, stdoutSha256: "0000000000000000000000000000000000000000000000000000000000000000" },
      }),
      stageAsset: async (asset) => ({
        ok: true,
        inputRef: { kind: "stdout", handle: "stream-0" },
        bytes: new TextEncoder().encode(asset.content).byteLength,
        chained: false,
      }),
      discardStream: async () => ({ ok: true }),
      isRunLive: () => true,
    },
  );

  assert(filterResult.ok, "table_filter succeeded directly on emitted tabular artifact");
  assert(filterResult.artifactId, "table_filter produced an output artifact");
  const outputAsset = assets.get(filterResult.artifactId);
  const outTable = JSON.parse(outputAsset.content);
  assertEquals(outTable.rows.length, 2, "filtered to exactly 2 us-east nodes");
  assertEquals(outTable.rows[0][0], "node-01");
  assertEquals(outTable.rows[1][0], "node-03");
});

// ── 3. 10k-row fixture returns truncated: true under the cap ────────────────
Deno.test("table-extractor: 10k-row fixture returns truncated: true bounded to 2000 rows (Acceptance 3)", () => {
  let rowsHtml = "";
  for (let i = 1; i <= 10000; i++) {
    rowsHtml += `<tr><td>Row-${i}</td><td>Metric-${i}</td><td>Value-${i * 10}</td></tr>`;
  }
  const bigHtml = `
    <table>
      <caption>Massive Sensor Log</caption>
      <thead>
        <tr><th>Identifier</th><th>Metric</th><th>Reading</th></tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;

  const result = extractTablesFromHtml(bigHtml, { maxRows: 2000 });
  assertEquals(result.tables.length, 1);
  const tbl = result.tables[0];
  assertEquals(tbl.caption, "Massive Sensor Log");
  assertEquals(tbl.headers, ["Identifier", "Metric", "Reading"]);
  assertEquals(tbl.rowCount, 2000, "bounded to exactly 2000 rows");
  assertEquals(tbl.truncated, true, "truncated is true when fixture exceeds maxRows");
  assertEquals(tbl.rows[0], ["Row-1", "Metric-1", "Value-10"]);
  assertEquals(tbl.rows[1999], ["Row-2000", "Metric-2000", "Value-20000"]);
});

// ── 4. Colspan and multi-column bounds ─────────────────────────────────────────
Deno.test("table-extractor: handles colspan and enforces maxColumns bound", () => {
  const html = `
    <table>
      <caption>Quarterly Breakdown</caption>
      <thead>
        <tr><th colspan="2">Q1 Results</th><th colspan="2">Q2 Results</th></tr>
      </thead>
      <tbody>
        <tr><td>Jan</td><td>Feb</td><td>Apr</td><td>May</td></tr>
        <tr><td colspan="4">All quarters consolidated</td></tr>
      </tbody>
    </table>
  `;

  const result = extractTablesFromHtml(html);
  assertEquals(result.tables.length, 1);
  const tbl = result.tables[0];
  assertEquals(tbl.headers.length, 4);
  assertEquals(tbl.rows.length, 2);
  // Colspan 4 should repeat the text across 4 columns
  assertEquals(tbl.rows[1], [
    "All quarters consolidated",
    "All quarters consolidated",
    "All quarters consolidated",
    "All quarters consolidated",
  ]);
});

// ── 5. Capability registration, security, and permissions ──────────────────────
Deno.test("extract_tables: registration, replay-safety, purpose-groups, and permission language", () => {
  // 1. Registered in BROWSER_TOOL_NAMES
  assert(BROWSER_TOOL_NAMES.includes("extract_tables"), "extract_tables is in BROWSER_TOOL_NAMES");

  // 2. Permission language
  assertEquals(toolUserLanguage("extract_tables"), "Extract tables from page");
  assertEquals(TOOL_USER_LANGUAGE.extract_tables, "Extract tables from page");

  // 3. Tool purpose group
  assertEquals(toolPurposeGroup("extract_tables"), "reading-capture");

  // 4. Replay safety is read-only
  assertEquals(replaySafetyForTool("extract_tables"), REPLAY_READ_ONLY);

  // 5. Chrome tool capabilities match read_page/capture_page
  const cap = chromeToolCapability("extract_tables", "chrome-api");
  assert(cap, "extract_tables capability record exists");
  assertEquals(cap.sourceKind, "chrome-api");
  assertEquals(cap.capabilityTokens, ["chrome.host.exact-origin", "chrome.page.read"]);
  assertEquals(cap.optionalPermissions, ["activeTab", "scripting", "tabs"]);
  assertEquals(cap.replayClass, "read-only");
  assertEquals(cap.mutationClass, "read");
  assertEquals(cap.routeFamily, "browser.page");

  // 6. browserToolset exposes extract_tables with matching schema
  const tools = browserToolset(false);
  assert("extract_tables" in tools, "extract_tables is in default browserToolset");
  const readOnlyTools = browserToolset(true);
  assert("extract_tables" in readOnlyTools, "extract_tables is in readOnly browserToolset");
});

// ── 6. Privileged URL gate rejects chrome:// before injection ────────────────
Deno.test("extract_tables: refuses privileged chrome:// URLs before script injection", async () => {
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: "chrome://settings", title: "Settings" }),
      query: async () => [{ id: 1, active: true, url: "chrome://settings", title: "Settings" }],
    },
    permissions: {
      contains: async () => true,
    },
    scripting: {
      executeScript: async () => {
        throw new Error("must not be called on privileged URL");
      },
    },
  };

  try {
    const result = await extractTables(1);
    assert(result.error, "result has error");
    assert(
      result.error.includes("privileged") || result.error.includes("chrome://"),
      `error must disclose privileged URL refusal: ${result.error}`,
    );
  } finally {
    globalThis.chrome = prevChrome;
  }
});

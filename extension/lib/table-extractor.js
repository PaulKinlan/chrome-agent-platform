// extension/lib/table-extractor.js — Bounded table and grid extraction from web pages.
// Part of bead chrome-agent-platform-3p3e.8:
// Extracts <table>, role="grid" / role="table", and repeated-card lists.
// Emits CSV-shaped JSON { tables: [{ caption, headers, rows, truncated, truncationReason, rowCount, columnCount }] }
// and supports promotion to canonical tabular artifacts for table_* tools.

import {
  assertCanonicalTable,
  canonicalTableJson,
  TABLE_LIMITS,
  TABLE_MEDIA_TYPE,
  TABLE_VERSION,
  tableUtf8Bytes,
} from "./table-core.js";
import { sha256Hex } from "./pure.js";

export const TABLE_EXTRACTOR_LIMITS = Object.freeze({
  maxRows: 2000,
  maxColumns: 50,
  maxBytes: 1024 * 1024, // 1 MB per table
  maxCellChars: 2000,    // Truncate cell text length AT SOURCE before copying
  maxCaptionChars: 300,  // Truncate caption text length AT SOURCE
  maxHeaderRows: 20,     // Bounded header row allocation
  maxTablesPerPage: 50,  // Whole-page table count cap
  maxTotalCellsPerPage: 50000, // Aggregate whole-page cell extraction work budget
  maxExecutionTimeMs: 2500,    // 2.5 second time budget
});

/** Decode common HTML entities. */
function decodeEntities(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, dec) => {
      const n = parseInt(dec, 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    })
    .replace(/&amp;/g, "&");
}

/** Clean text by stripping inner markup, decoding entities, and collapsing whitespace. */
export function cleanText(str) {
  if (!str || typeof str !== "string") return "";
  return decodeEntities(str.replace(/<[^>]+>/g, " "))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sanitize and deduplicate header labels. */
export function sanitizeHeaders(rawHeaders, defaultWidth = 1) {
  const width = Math.max(Array.isArray(rawHeaders) ? rawHeaders.length : 0, defaultWidth);
  const headers = [];
  const seen = new Map();
  for (let i = 0; i < width; i++) {
    let name = cleanText(rawHeaders?.[i] ?? "");
    if (!name) name = `Column ${i + 1}`;
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    if (count > 0) {
      name = `${name}_${count + 1}`;
    }
    headers.push(name);
  }
  return headers;
}

/** Convert raw headers and rows into a canonical table representation. */
export function toCanonicalTable({ headers = [], rows = [], caption = "Table" } = {}, options = {}) {
  const safeHeaders = sanitizeHeaders(headers, rows[0]?.length || 1);
  const columns = safeHeaders.map((header, i) => ({
    id: `c${i + 1}`,
    header,
    type: { kind: "text" },
  }));
  const safeRows = rows.map((row) => {
    const r = [];
    for (let c = 0; c < columns.length; c++) {
      const val = row[c];
      r.push(val == null ? null : String(val));
    }
    return r;
  });
  return assertCanonicalTable({
    version: TABLE_VERSION,
    localeProfile: options.localeProfile || "canonical-v1",
    columns,
    rows: safeRows,
  });
}

/** Save extracted table as a persistent tabular artifact directly accepted by table_* tools. */
export async function createTabularArtifact(tableData, {
  name = null,
  origin = "master",
  sourceUrl = null,
  createAssetFn = null,
} = {}) {
  const canonical = toCanonicalTable(tableData);
  const content = canonicalTableJson(canonical);
  const digest = sha256Hex(content);
  const artifactName = (name || tableData.caption || "Extracted table").slice(0, 120);

  const saveAsset = createAssetFn || (await import("./artifacts.js")).createAsset;
  const assetRes = await saveAsset(origin, {
    type: "data",
    name: artifactName,
    content,
    meta: {
      schema: TABLE_VERSION,
      mediaType: TABLE_MEDIA_TYPE,
      sha256: digest,
      rows: canonical.rows.length,
      columns: canonical.columns.length,
      sourceUrl: sourceUrl || undefined,
      extractedAt: new Date().toISOString(),
    },
  });

  if (!assetRes?.ok) {
    throw new Error(`Failed to create tabular artifact: ${assetRes?.error ?? "unknown error"}`);
  }

  return {
    artifactId: assetRes.asset?.id ?? assetRes.id ?? null,
    artifact: assetRes.asset ?? null,
  };
}

/**
 * Self-contained table extraction function designed for tab execution
 * via chrome.scripting.executeScript.
 *
 * Implements:
 * - Live/bounded collection traversal before materialization (no full Array.from/slice).
 * - Bounded <thead> collection and allocation.
 * - Incremental live walks with budget checks for ARIA grids and cards.
 * - Text truncation AT SOURCE (during node walk) for cells and captions.
 * - Accurate UTF-8 byte measurement via TextEncoder, failing closed on overflow (including card path).
 * - General 2D span-occupancy grid advancing past occupied slots for colspan/rowspan collisions.
 * - Headerless table inference (synthesizes column names when all cells are td).
 * - Scoped DOM root handling (never escapes caller's subtree).
 * - Isolation of nested tables from parent rows and cell text.
 * - Whole-page aggregate table/cell/time budgets with explicit truncation reasons.
 */
export function injectedTableExtractor({
  ref = null,
  targetRoot = null,
  maxRows = 2000,
  maxColumns = 50,
  maxBytes = 1024 * 1024,
  maxCellChars = 2000,
  maxCaptionChars = 300,
  maxHeaderRows = 20,
  maxTablesPerPage = 50,
  maxTotalCellsPerPage = 50000,
  maxExecutionTimeMs = 2500,
  customDocument = null,
} = {}) {
  var doc = customDocument || (typeof document !== "undefined" ? document : null);
  if (!doc && !targetRoot) return { tables: [], count: 0, pageTruncated: false };

  var startTime = Date.now();
  var totalCellsCount = 0;
  var pageTruncated = false;
  var pageTruncationReason = null;
  var utf8Encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  function measureBytes(val) {
    if (utf8Encoder) {
      return utf8Encoder.encode(typeof val === "string" ? val : JSON.stringify(val)).byteLength;
    }
    return unescape(encodeURIComponent(typeof val === "string" ? val : JSON.stringify(val))).length;
  }

  function clean(s) {
    if (!s) return "";
    return s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Extract text AT SOURCE, truncating during the walk before string concatenation
  function extractBoundedText(node, maxChars, ignoreNestedTables) {
    if (!node) return "";
    var text = "";

    function walk(n, depth) {
      if (text.length >= maxChars || depth > 20) return;
      if (n.nodeType === 3) {
        var val = n.nodeValue || "";
        var remaining = maxChars - text.length;
        text += val.slice(0, remaining);
        return;
      }
      if (n.nodeType === 1) {
        var tag = n.tagName ? n.tagName.toUpperCase() : "";
        if (ignoreNestedTables && tag === "TABLE") return;
        var children = n.childNodes || [];
        for (var i = 0; i < children.length; i++) {
          walk(children[i], depth + 1);
          if (text.length >= maxChars) break;
        }
      }
    }

    walk(node, 0);
    return clean(text);
  }

  function headingBefore(el) {
    var p = el.previousElementSibling;
    while (p) {
      if (p.tagName && /^H[1-6]$/i.test(p.tagName)) return extractBoundedText(p, maxCaptionChars, false);
      var inner = p.querySelector ? p.querySelector("h1, h2, h3, h4, h5, h6") : null;
      if (inner) return extractBoundedText(inner, maxCaptionChars, false);
      p = p.previousElementSibling;
    }
    if (el.parentElement && el.parentElement !== (doc ? doc.body : null) && el.parentElement !== scope) {
      return headingBefore(el.parentElement);
    }
    return null;
  }

  function getScope() {
    if (targetRoot) return targetRoot;
    if (ref !== null && ref !== undefined && doc) {
      var target = (doc.querySelector && (
        doc.querySelector('[data-cap-ref="' + ref + '"]') ||
        doc.querySelector('[data-ref="' + ref + '"]')
      )) || (doc.getElementById && doc.getElementById(String(ref)));
      if (target) return target;
    }
    return doc ? (doc.body || doc) : null;
  }

  var scope = getScope();
  if (!scope) return { tables: [], count: 0, pageTruncated: false };

  function checkBudget() {
    if (Date.now() - startTime >= maxExecutionTimeMs) {
      pageTruncated = true;
      pageTruncationReason = "timeout";
      return false;
    }
    if (totalCellsCount >= maxTotalCellsPerPage) {
      pageTruncated = true;
      pageTruncationReason = "cell-budget";
      return false;
    }
    if (tables.length >= maxTablesPerPage) {
      pageTruncated = true;
      pageTruncationReason = "table-limit";
      return false;
    }
    return true;
  }

  // Iterative bounded element finder that avoids stack overflow and full querySelectorAll array allocation
  var MAX_WALK_DEPTH = 32;
  function findMatchingElements(root, isMatch, maxCount, maxDepth) {
    var depthLimit = typeof maxDepth === "number" ? maxDepth : MAX_WALK_DEPTH;
    var results = [];
    var stack = [{ node: root, depth: 0 }];

    while (stack.length > 0 && results.length < maxCount) {
      if (!checkBudget()) break;
      var item = stack.pop();
      var node = item.node;
      var depth = item.depth;

      if (node !== root && isMatch(node)) {
        results.push(node);
        if (results.length >= maxCount) break;
      }

      if (depth >= depthLimit) {
        pageTruncated = true;
        if (!pageTruncationReason) pageTruncationReason = "depth-limit";
        continue;
      }

      var ch = node.children || [];
      for (var i = ch.length - 1; i >= 0; i--) {
        stack.push({ node: ch[i], depth: depth + 1 });
      }
    }
    return results;
  }

  var tables = [];
  var seen = new Set();

  // Helper: place a cell with colspan & rowspan into the 2D occupancy grid advancing past occupied slots
  function placeCellInGrid(row, activeSpans, cellText, cs, rs, maxCols, maxRowsRemaining) {
    var col = 0;
    for (var s = 0; s < cs; s++) {
      while (col < maxCols && row[col] !== null) col++;
      if (col >= maxCols) return false;
      row[col] = cellText;
      if (rs > 1) {
        activeSpans.push({ col: col, remaining: Math.min(rs - 1, maxRowsRemaining), text: cellText });
      }
      col++;
    }
    return true;
  }

  // 1. Native HTML <table> elements (bounded live enumeration)
  function collectTables(rootNode) {
    if (rootNode.tagName && rootNode.tagName.toUpperCase() === "TABLE") {
      return [rootNode];
    }
    if (rootNode.getElementsByTagName) {
      var liveColl = rootNode.getElementsByTagName("table");
      var list = [];
      for (var idx = 0; idx < liveColl.length; idx++) {
        if (list.length >= maxTablesPerPage) {
          pageTruncated = true;
          pageTruncationReason = "table-limit";
          break;
        }
        list.push(liveColl[idx]);
      }
      if (liveColl.length > maxTablesPerPage) {
        pageTruncated = true;
        pageTruncationReason = "table-limit";
      }
      return list;
    }
    var list = findMatchingElements(rootNode, function (n) {
      return n && n.nodeType === 1 && n.tagName && n.tagName.toUpperCase() === "TABLE";
    }, maxTablesPerPage + 1);
    if (list.length > maxTablesPerPage) {
      pageTruncated = true;
      pageTruncationReason = "table-limit";
      list = list.slice(0, maxTablesPerPage);
    }
    return list;
  }

  var nativeTables = collectTables(scope);

  for (var i = 0; i < nativeTables.length; i++) {
    if (!checkBudget()) break;
    var tbl = nativeTables[i];
    seen.add(tbl);

    var caption = "";
    var capEl = tbl.querySelector ? tbl.querySelector("caption") : null;
    if (capEl) caption = extractBoundedText(capEl, maxCaptionChars, false);
    if (!caption && tbl.getAttribute) caption = clean(tbl.getAttribute("aria-label") || "").slice(0, maxCaptionChars);
    if (!caption && tbl.getAttribute && tbl.getAttribute("aria-labelledby") && doc && doc.getElementById) {
      var lb = doc.getElementById(tbl.getAttribute("aria-labelledby"));
      if (lb) caption = extractBoundedText(lb, maxCaptionChars, false);
    }
    if (!caption) caption = headingBefore(tbl) || ("Table " + (tables.length + 1));

    // Bounded live row traversal via direct children (thead, tbody, tfoot, tr)
    var theadRows = [];
    var dataRows = [];
    var tblChildren = tbl.children || [];
    var truncated = false;
    var truncationReason = null;

    for (var tc = 0; tc < tblChildren.length; tc++) {
      var sec = tblChildren[tc];
      var secTag = sec.tagName ? sec.tagName.toUpperCase() : "";
      if (secTag === "TR") {
        if (dataRows.length >= maxRows) {
          truncated = true;
          truncationReason = "row-limit";
          break;
        }
        dataRows.push(sec);
      } else if (secTag === "THEAD") {
        var theadChildren = sec.children || [];
        for (var thr = 0; thr < theadChildren.length; thr++) {
          if (theadChildren[thr].tagName && theadChildren[thr].tagName.toUpperCase() === "TR") {
            if (theadRows.length >= maxHeaderRows) {
              truncated = true;
              if (!truncationReason) truncationReason = "row-limit";
              break;
            }
            if (!checkBudget()) {
              truncated = true;
              if (!truncationReason) truncationReason = pageTruncationReason;
              break;
            }
            theadRows.push(theadChildren[thr]);
          }
        }
      } else if (secTag === "TBODY" || secTag === "TFOOT") {
        var bodyChildren = sec.children || [];
        for (var tbr = 0; tbr < bodyChildren.length; tbr++) {
          if (bodyChildren[tbr].tagName && bodyChildren[tbr].tagName.toUpperCase() === "TR") {
            if (dataRows.length >= maxRows) {
              truncated = true;
              truncationReason = "row-limit";
              break;
            }
            dataRows.push(bodyChildren[tbr]);
          }
        }
      }
      if (dataRows.length >= maxRows) break;
    }

    var rawHeaders = [];

    // Header extraction bounded to maxHeaderRows with budget checks
    if (theadRows.length > 0) {
      var headGrid = [];
      var headActiveRowSpans = [];
      for (var hr = 0; hr < theadRows.length; hr++) {
        if (!checkBudget()) break;
        var htr = theadRows[hr];
        var hrow = new Array(maxColumns).fill(null);
        for (var si = headActiveRowSpans.length - 1; si >= 0; si--) {
          var sp = headActiveRowSpans[si];
          hrow[sp.col] = sp.text;
          sp.remaining--;
          if (sp.remaining <= 0) headActiveRowSpans.splice(si, 1);
        }
        var htrChildren = htr.children || [];
        var hcellCount = 0;
        for (var hc = 0; hc < htrChildren.length && hcellCount < maxColumns; hc++) {
          if (!checkBudget()) break;
          var hcell = htrChildren[hc];
          var tg = hcell.tagName ? hcell.tagName.toUpperCase() : "";
          if (tg !== "TH" && tg !== "TD") continue;
          var hcs = parseInt(hcell.getAttribute ? (hcell.getAttribute("colspan") || "1") : "1", 10);
          var hrs = parseInt(hcell.getAttribute ? (hcell.getAttribute("rowspan") || "1") : "1", 10);
          var hspan = (Number.isFinite(hcs) && hcs > 1) ? hcs : 1;
          var hrspan = (Number.isFinite(hrs) && hrs > 1) ? hrs : 1;
          var htxt = extractBoundedText(hcell, maxCellChars, true);
          placeCellInGrid(hrow, headActiveRowSpans, htxt, hspan, hrspan, maxColumns, theadRows.length - hr);
          hcellCount++;
        }
        headGrid.push(hrow);
      }
      var lastHRow = headGrid[headGrid.length - 1] || [];
      for (var colI = 0; colI < maxColumns; colI++) {
        var val = lastHRow[colI];
        if (val == null && headGrid.length > 1) {
          for (var gr = headGrid.length - 2; gr >= 0; gr--) {
            if (headGrid[gr][colI] != null) { val = headGrid[gr][colI]; break; }
          }
        }
        if (val != null) rawHeaders.push(val);
        else if (rawHeaders.length > 0) rawHeaders.push("");
      }
      while (rawHeaders.length > 0 && !rawHeaders[rawHeaders.length - 1]) rawHeaders.pop();
    } else if (dataRows.length > 0) {
      var firstTr = dataRows[0];
      var firstChildren = firstTr.children || [];
      var hasTh = false;
      for (var fci = 0; fci < firstChildren.length && fci < maxColumns; fci++) {
        var tg = firstChildren[fci].tagName ? firstChildren[fci].tagName.toUpperCase() : "";
        if (tg === "TH") { hasTh = true; break; }
      }
      if (hasTh) {
        dataRows.shift();
        var frow = new Array(maxColumns).fill(null);
        var fActive = [];
        var fcCount = 0;
        for (var fci = 0; fci < firstChildren.length && fcCount < maxColumns; fci++) {
          if (!checkBudget()) break;
          var fcell = firstChildren[fci];
          var tg = fcell.tagName ? fcell.tagName.toUpperCase() : "";
          if (tg !== "TH" && tg !== "TD") continue;
          var fcs = parseInt(fcell.getAttribute ? (fcell.getAttribute("colspan") || "1") : "1", 10);
          var fspan = (Number.isFinite(fcs) && fcs > 1) ? fcs : 1;
          var ftxt = extractBoundedText(fcell, maxCellChars, true);
          placeCellInGrid(frow, fActive, ftxt, fspan, 1, maxColumns, 1);
          fcCount++;
        }
        for (var fk = 0; fk < maxColumns; fk++) {
          if (frow[fk] != null) rawHeaders.push(frow[fk]);
        }
      }
    }

    var rows = [];
    var currentBytes = 0;
    var maxDataCols = rawHeaders.length;
    var activeRowSpans = [];

    // Row iteration with budget checks and UTF-8 byte bounds
    for (var r = 0; r < dataRows.length; r++) {
      if (rows.length >= maxRows) {
        truncated = true;
        truncationReason = "row-limit";
        break;
      }
      if (!checkBudget()) {
        truncated = true;
        truncationReason = pageTruncationReason;
        break;
      }

      var tr = dataRows[r];
      var row = new Array(maxColumns).fill(null);

      // 1. Fill active row spans from previous rows
      for (var si = activeRowSpans.length - 1; si >= 0; si--) {
        var span = activeRowSpans[si];
        row[span.col] = span.text;
        span.remaining--;
        if (span.remaining <= 0) activeRowSpans.splice(si, 1);
      }

      // 2. Place direct cells without array slicing or filtering (P1a)
      var trChildren = tr.children || [];
      var cellCount = 0;
      for (var c = 0; c < trChildren.length && cellCount < maxColumns; c++) {
        if (!checkBudget()) break;
        var cell = trChildren[c];
        var tg = cell.tagName ? cell.tagName.toUpperCase() : "";
        if (tg !== "TD" && tg !== "TH") continue;
        var cs = parseInt(cell.getAttribute ? (cell.getAttribute("colspan") || "1") : "1", 10);
        var rs = parseInt(cell.getAttribute ? (cell.getAttribute("rowspan") || "1") : "1", 10);
        var cspan = (Number.isFinite(cs) && cs > 1) ? cs : 1;
        var rspan = (Number.isFinite(rs) && rs > 1) ? rs : 1;
        var text = extractBoundedText(cell, maxCellChars, true);

        var placed = placeCellInGrid(row, activeRowSpans, text, cspan, rspan, maxColumns, dataRows.length - r);
        if (!placed) {
          truncated = true;
          if (!truncationReason) truncationReason = "column-limit";
          break;
        }
        cellCount++;
      }
      if (trChildren.length > maxColumns) {
        truncated = true;
        if (!truncationReason) truncationReason = "column-limit";
      }

      var lastFilled = -1;
      for (var f = maxColumns - 1; f >= 0; f--) {
        if (row[f] !== null) { lastFilled = f; break; }
      }
      if (lastFilled === -1 && dcells.length === 0) continue;

      var cleanRow = [];
      for (var k = 0; k <= lastFilled; k++) {
        cleanRow.push(row[k] === null ? "" : row[k]);
      }
      if (cleanRow.length > maxDataCols) maxDataCols = cleanRow.length;

      var rowBytes = measureBytes(cleanRow);
      if (currentBytes + rowBytes > maxBytes) {
        truncated = true;
        truncationReason = "byte-limit";
        break;
      }

      rows.push(cleanRow);
      totalCellsCount += cleanRow.length;
      currentBytes += rowBytes;
    }

    var colCount = Math.max(rawHeaders.length, maxDataCols, 1);
    var headers = [];
    var seenH = {};
    for (var colIdx = 0; colIdx < colCount; colIdx++) {
      var name = rawHeaders[colIdx] || ("Column " + (colIdx + 1));
      var count = seenH[name] || 0;
      seenH[name] = count + 1;
      if (count > 0) name = name + "_" + (count + 1);
      headers.push(name);
    }

    var normalizedRows = rows.map(function (rowArr) {
      var padded = rowArr.slice(0, headers.length);
      while (padded.length < headers.length) padded.push("");
      return padded;
    });

    if (normalizedRows.length > 0) {
      tables.push({
        caption: caption,
        headers: headers,
        rows: normalizedRows,
        rowCount: normalizedRows.length,
        columnCount: headers.length,
        truncated: truncated,
        truncationReason: truncationReason,
      });
    }
  }

  // 2. ARIA grids / tables: [role="grid"], [role="table"] (bounded incremental walk)
  function isAriaGrid(el) {
    if (!el || el.nodeType !== 1 || el.tagName === "TABLE" || seen.has(el)) return false;
    var role = el.getAttribute ? el.getAttribute("role") : null;
    return role === "table" || role === "grid";
  }

  var remainingGridSlots = Math.max(0, maxTablesPerPage - tables.length);
  var ariaGrids = [];
  if (scope.getAttribute && isAriaGrid(scope)) {
    ariaGrids.push(scope);
  } else {
    ariaGrids = findMatchingElements(scope, isAriaGrid, remainingGridSlots);
  }

  for (var g = 0; g < ariaGrids.length; g++) {
    if (!checkBudget()) break;
    var grid = ariaGrids[g];
    seen.add(grid);

    var caption = clean(grid.getAttribute ? (grid.getAttribute("aria-label") || "") : "").slice(0, maxCaptionChars);
    if (!caption && grid.getAttribute && grid.getAttribute("aria-labelledby") && doc && doc.getElementById) {
      var lb = doc.getElementById(grid.getAttribute("aria-labelledby"));
      if (lb) caption = extractBoundedText(lb, maxCaptionChars, false);
    }
    if (!caption) caption = headingBefore(grid) || ("Data Grid " + (tables.length + 1));

    // Incremental walk for column headers bounded to maxColumns
    function isColumnHeader(el) {
      return el && el.nodeType === 1 && el.getAttribute && el.getAttribute("role") === "columnheader";
    }
    var colHeaders = findMatchingElements(grid, isColumnHeader, maxColumns);
    var rawHeaders = colHeaders.map(function (ch) { return extractBoundedText(ch, maxCellChars, false); });

    // Incremental walk for ARIA rows bounded to maxRows + 20
    function isAriaRow(el) {
      return el && el.nodeType === 1 && el.getAttribute && el.getAttribute("role") === "row";
    }
    var allRowEls = findMatchingElements(grid, isAriaRow, maxRows + 20);
    var dataRowEls = allRowEls.filter(function (rEl) {
      return !rEl.querySelector || !rEl.querySelector('[role="columnheader"]');
    });

    var rows = [];
    var truncated = false;
    var truncationReason = null;
    var currentBytes = 0;
    var maxCols = rawHeaders.length;

    for (var r = 0; r < dataRowEls.length; r++) {
      if (rows.length >= maxRows) {
        truncated = true;
        truncationReason = "row-limit";
        break;
      }
      if (!checkBudget()) {
        truncated = true;
        truncationReason = pageTruncationReason;
        break;
      }

      var rEl = dataRowEls[r];
      function isAriaCell(el) {
        if (!el || el.nodeType !== 1 || !el.getAttribute) return false;
        var rl = el.getAttribute("role");
        return rl === "gridcell" || rl === "cell";
      }
      var cells = findMatchingElements(rEl, isAriaCell, maxColumns + 1);
      if (cells.length === 0) continue;

      var row = [];
      for (var c = 0; c < Math.min(cells.length, maxColumns); c++) {
        row.push(extractBoundedText(cells[c], maxCellChars, false));
      }
      if (cells.length > maxColumns) {
        truncated = true;
        if (!truncationReason) truncationReason = "column-limit";
      }

      if (row.length > maxCols) maxCols = row.length;

      var rowBytes = measureBytes(row);
      if (currentBytes + rowBytes > maxBytes) {
        truncated = true;
        truncationReason = "byte-limit";
        break;
      }

      rows.push(row);
      totalCellsCount += row.length;
      currentBytes += rowBytes;
    }

    var colCount = Math.max(rawHeaders.length, maxCols, 1);
    var headers = [];
    var seenH = {};
    for (var colIdx = 0; colIdx < colCount; colIdx++) {
      var name = rawHeaders[colIdx] || ("Column " + (colIdx + 1));
      var count = seenH[name] || 0;
      seenH[name] = count + 1;
      if (count > 0) name = name + "_" + (count + 1);
      headers.push(name);
    }

    var normalizedRows = rows.map(function (rowArr) {
      var padded = rowArr.slice(0, headers.length);
      while (padded.length < headers.length) padded.push("");
      return padded;
    });

    if (normalizedRows.length > 0) {
      tables.push({
        caption: caption,
        headers: headers,
        rows: normalizedRows,
        rowCount: normalizedRows.length,
        columnCount: headers.length,
        truncated: truncated,
        truncationReason: truncationReason,
      });
    }
  }

  // 3. Repeated-card lists (bounded incremental walk with UTF-8 byte measurement)
  function isCardContainer(el) {
    if (!el || el.nodeType !== 1 || seen.has(el)) return false;
    var role = el.getAttribute ? el.getAttribute("role") : "";
    var tag = el.tagName ? el.tagName.toUpperCase() : "";
    var cls = (el.getAttribute ? (el.getAttribute("class") || "") : "").toLowerCase();
    if (role === "list" || tag === "UL" || tag === "OL") return true;
    return /\b(?:cards|pricing|grid|card-grid|speaker-list)\b/.test(cls);
  }

  var remainingCardSlots = Math.max(0, maxTablesPerPage - tables.length);
  var listContainers = findMatchingElements(scope, isCardContainer, remainingCardSlots);

  for (var lc = 0; lc < listContainers.length; lc++) {
    if (!checkBudget()) break;
    var container = listContainers[lc];
    if (container.querySelector && container.querySelector("table, [role='table'], [role='grid']")) continue;

    var childElements = container.children || [];
    var cardRecords = [];
    var fieldOrder = [];
    var seenF = {};
    var cardTruncated = false;
    var cardTruncationReason = null;
    var cardWorkingBytes = 0;

    function addField(f) {
      if (!seenF[f]) { seenF[f] = true; fieldOrder.push(f); }
    }

    for (var it = 0; it < childElements.length; it++) {
      var el = childElements[it];
      var t = el.tagName ? el.tagName.toUpperCase() : "";
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "H1", "H2", "H3", "H4", "H5", "H6"].indexOf(t) !== -1) continue;

      if (cardRecords.length >= maxRows) {
        cardTruncated = true;
        cardTruncationReason = "row-limit";
        break;
      }
      if (cardWorkingBytes >= maxBytes) {
        cardTruncated = true;
        cardTruncationReason = "byte-limit";
        break;
      }
      if (!checkBudget()) {
        cardTruncated = true;
        cardTruncationReason = pageTruncationReason;
        break;
      }

      var rec = {};
      var recWorkingBytes = 0;
      var foundFields = 0;

      function trySetField(key, val) {
        if (!key || rec[key]) return;
        var fBytes = measureBytes(key) + measureBytes(val);
        if (cardWorkingBytes + recWorkingBytes + fBytes > maxBytes) {
          cardTruncated = true;
          cardTruncationReason = "byte-limit";
          return;
        }
        rec[key] = val;
        recWorkingBytes += fBytes;
        addField(key);
        foundFields++;
      }

      // Incremental walk of card children to avoid full descendant materialization
      function walkCardFields(n, depth) {
        if (depth > 4 || foundFields >= maxColumns) return;
        if (!checkBudget()) return;
        if (cardWorkingBytes + recWorkingBytes >= maxBytes) {
          cardTruncated = true;
          cardTruncationReason = "byte-limit";
          return;
        }
        var tag = n.tagName ? n.tagName.toUpperCase() : "";
        if (tag === "DT") {
          var dd = n.nextElementSibling && n.nextElementSibling.tagName === "DD" ? n.nextElementSibling : null;
          if (dd) {
            var k = extractBoundedText(n, 100, false);
            if (k) trySetField(k, extractBoundedText(dd, maxCellChars, false));
          }
        } else if (/^H[2-6]$/.test(tag) && !rec["Title"] && !rec["Name"]) {
          var field = (container.className && container.className.indexOf("speaker") !== -1) ? "Name" : "Title";
          trySetField(field, extractBoundedText(n, maxCellChars, false));
        } else if (n.getAttribute) {
          var df = n.getAttribute("data-field");
          if (df) {
            var k = clean(df).slice(0, 100);
            if (k) trySetField(k, extractBoundedText(n, maxCellChars, false));
          } else {
            var cls = String(n.getAttribute("class") || "").toLowerCase();
            var tokens = ["price", "cost", "role", "topic", "time", "date", "status", "category"];
            for (var tki = 0; tki < tokens.length; tki++) {
              if (cls.indexOf(tokens[tki]) !== -1) {
                var key = tokens[tki].charAt(0).toUpperCase() + tokens[tki].slice(1);
                if (!rec[key]) {
                  trySetField(key, extractBoundedText(n, maxCellChars, false));
                  break;
                }
              }
            }
          }
        }
        var ch = n.children || [];
        for (var ci = 0; ci < ch.length; ci++) {
          walkCardFields(ch[ci], depth + 1);
          if (foundFields >= maxColumns || (cardTruncated && cardTruncationReason === "byte-limit")) break;
        }
      }

      walkCardFields(el, 0);

      if (Object.keys(rec).length > 0) {
        cardRecords.push(rec);
        cardWorkingBytes += recWorkingBytes;
        totalCellsCount += Object.keys(rec).length;
      }
      if (cardTruncated && cardTruncationReason === "byte-limit") {
        break;
      }
    }

    if (fieldOrder.length >= 2 && cardRecords.length >= 3) {
      var caption = clean(container.getAttribute ? (container.getAttribute("aria-label") || "") : "").slice(0, maxCaptionChars) ||
                    headingBefore(container) || ("Card List " + (tables.length + 1));
      var headers = fieldOrder.slice(0, maxColumns);
      var rows = [];
      var currentBytes = 0;

      // Retain card rows with safety byte bounding
      for (var cri = 0; cri < cardRecords.length; cri++) {
        var rec = cardRecords[cri];
        var row = headers.map(function (hdr) { return rec[hdr] || ""; });
        var rowBytes = measureBytes(row);
        if (currentBytes + rowBytes > maxBytes) {
          cardTruncated = true;
          cardTruncationReason = "byte-limit";
          break;
        }
        rows.push(row);
        currentBytes += rowBytes;
      }

      if (rows.length > 0 || cardTruncated) {
        tables.push({
          caption: caption,
          headers: headers,
          rows: rows,
          rowCount: rows.length,
          columnCount: headers.length,
          truncated: cardTruncated || fieldOrder.length > maxColumns,
          truncationReason: cardTruncationReason || (fieldOrder.length > maxColumns ? "column-limit" : null),
        });
      }
    }
  }

  return {
    tables: tables,
    count: tables.length,
    pageTruncated: pageTruncated,
    pageTruncationReason: pageTruncationReason,
  };
}

/** Extract tables from a DOM root element without escaping into caller document. */
export function extractTablesFromDom(root, options = {}) {
  return injectedTableExtractor({ targetRoot: root, customDocument: root.ownerDocument || root, ...options });
}

class HtmlMockNode {
  constructor(tagName, nodeType = 1, text = null) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = nodeType;
    this.nodeValue = text;
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.previousElementSibling = null;
  }
  get childNodes() { return this.children; }
  get textContent() {
    if (this.nodeType === 3) return this.nodeValue || "";
    return this.children.map((c) => c.textContent).join("");
  }
  get className() { return this.getAttribute("class") || ""; }
  getAttribute(name) { return this.attributes.get(name.toLowerCase()) ?? null; }
  setAttribute(name, val) { this.attributes.set(name.toLowerCase(), val); }
  appendChild(child) {
    child.parentElement = this;
    const prev = this.children[this.children.length - 1];
    if (prev && prev.nodeType === 1) child.previousElementSibling = prev;
    this.children.push(child);
    return child;
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }
  querySelectorAll(selector) {
    const results = [];
    const selectors = selector.split(",").map((s) => s.trim().toLowerCase());
    const match = (n) => {
      if (n.nodeType !== 1) return false;
      const t = n.tagName.toLowerCase();
      const cls = (n.getAttribute("class") || "").toLowerCase().split(/\s+/);
      const role = (n.getAttribute("role") || "").toLowerCase();
      for (const s of selectors) {
        if (s === "table" && t === "table") return true;
        if (s === "caption" && t === "caption") return true;
        if (s === "thead tr" && t === "tr" && n.parentElement?.tagName?.toLowerCase() === "thead") return true;
        if (s === "tr" && t === "tr") return true;
        if ((s === "th" || s === "td") && (t === "th" || t === "td")) return true;
        if (s === "dt" && t === "dt") return true;
        if (s === "dd" && t === "dd") return true;
        if (["h1","h2","h3","h4","h5","h6"].includes(s) && t === s) return true;
        if (s === '[role="columnheader"]' && role === "columnheader") return true;
        if (s === '[role="row"]' && role === "row") return true;
        if ((s === '[role="gridcell"]' || s === '[role="cell"]') && (role === "gridcell" || role === "cell")) return true;
        if ((s === '[role="table"]' || s === '[role="grid"]') && (role === "table" || role === "grid")) return true;
        if (s === '[role="list"]' && role === "list") return true;
        if (s === "ul" && t === "ul") return true;
        if (s === "ol" && t === "ol") return true;
        if (s === "[data-field]" && n.getAttribute("data-field")) return true;
        if (s === "[class]" && n.getAttribute("class")) return true;
        if (s.startsWith(".") && cls.includes(s.slice(1))) return true;
        if (s.startsWith("div.") && t === "div" && cls.includes(s.slice(4))) return true;
      }
      return false;
    };
    const walk = (n) => {
      for (const c of n.children) {
        if (match(c)) results.push(c);
        walk(c);
      }
    };
    walk(this);
    return results;
  }
}

function parseHtmlToDom(html) {
  const root = new HtmlMockNode("body");
  let current = root;
  const tagRe = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[0].startsWith("<!--")) continue;
    if (m[4]) {
      const text = m[4].replace(/[\r\n\t]+/g, " ");
      if (text.trim()) current.appendChild(new HtmlMockNode("#text", 3, text));
    } else if (m[2]) {
      const isClose = !!m[1];
      const tag = m[2].toLowerCase();
      if (["meta", "link", "br", "hr", "img", "input"].includes(tag)) {
        const el = new HtmlMockNode(tag);
        const attrRe = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
        let am;
        while ((am = attrRe.exec(m[3])) !== null) el.setAttribute(am[1], am[2] || "");
        current.appendChild(el);
      } else if (isClose) {
        if (current.parentElement) current = current.parentElement;
      } else {
        const el = new HtmlMockNode(tag);
        const attrRe = /([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?/g;
        let am;
        while ((am = attrRe.exec(m[3])) !== null) el.setAttribute(am[1], am[2] || "");
        current.appendChild(el);
        current = el;
      }
    }
  }
  return root;
}

/** Simple fallback extractor for tests/environments without full DOMParser. */
export function extractTablesFromHtml(html, options = {}) {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return injectedTableExtractor({ customDocument: doc, ...options });
  }

  const body = parseHtmlToDom(html);
  const doc = {
    body,
    querySelector(s) { return body.querySelector(s); },
    querySelectorAll(s) { return body.querySelectorAll(s); },
    getElementById() { return null; },
  };
  return injectedTableExtractor({ customDocument: doc, ...options });
}

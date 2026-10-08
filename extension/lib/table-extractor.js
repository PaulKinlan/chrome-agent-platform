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
  maxCellChars: 2000,    // Truncate cell text length BEFORE copying
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
 * - Bounded traversal and memory limits BEFORE materialization.
 * - Cell text length truncation before copying.
 * - Bounded 2D span-occupancy grid supporting colspan and rowspan.
 * - Headerless table inference (synthesizes column names when all cells are td).
 * - Isolation of nested tables from parent rows.
 * - Whole-page aggregate table/cell/time budgets with explicit truncation reasons.
 */
export function injectedTableExtractor({
  ref = null,
  maxRows = 2000,
  maxColumns = 50,
  maxBytes = 1024 * 1024,
  maxCellChars = 2000,
  maxTablesPerPage = 50,
  maxTotalCellsPerPage = 50000,
  maxExecutionTimeMs = 2500,
  customDocument = null,
} = {}) {
  var doc = customDocument || (typeof document !== "undefined" ? document : null);
  if (!doc) return { tables: [], count: 0, pageTruncated: false };

  var startTime = Date.now();
  var totalCellsCount = 0;
  var pageTruncated = false;
  var pageTruncationReason = null;

  function clean(s) {
    if (!s) return "";
    return s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  }

  function cleanCellText(text) {
    if (!text) return "";
    var s = text.length > maxCellChars ? text.slice(0, maxCellChars) : text;
    return clean(s);
  }

  function getCellDirectText(cellEl) {
    if (!cellEl) return "";
    var text = "";
    var children = cellEl.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var n = children[i];
      if (n.nodeType === 3) {
        text += n.nodeValue;
      } else if (n.nodeType === 1) {
        var tag = n.tagName ? n.tagName.toUpperCase() : "";
        if (tag !== "TABLE") {
          text += (n.innerText || n.textContent || "");
        }
      }
      if (text.length >= maxCellChars) break;
    }
    return cleanCellText(text);
  }

  function headingBefore(el) {
    var p = el.previousElementSibling;
    while (p) {
      if (p.tagName && /^H[1-6]$/i.test(p.tagName)) return clean(p.textContent);
      var inner = p.querySelector ? p.querySelector("h1, h2, h3, h4, h5, h6") : null;
      if (inner) return clean(inner.textContent);
      p = p.previousElementSibling;
    }
    if (el.parentElement && el.parentElement !== doc.body) {
      return headingBefore(el.parentElement);
    }
    return null;
  }

  function getScope() {
    if (ref !== null && ref !== undefined) {
      var target = (doc.querySelector && (
        doc.querySelector('[data-cap-ref="' + ref + '"]') ||
        doc.querySelector('[data-ref="' + ref + '"]')
      )) || (doc.getElementById && doc.getElementById(String(ref)));
      if (target) return target;
    }
    return doc;
  }

  function getDirectTrs(tableEl, sectionTag) {
    var trs = [];
    var children = tableEl.children || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      var tag = child.tagName ? child.tagName.toUpperCase() : "";
      if (!sectionTag && tag === "TR") {
        trs.push(child);
      } else if (sectionTag && tag === sectionTag) {
        var secChildren = child.children || [];
        for (var j = 0; j < secChildren.length; j++) {
          if (secChildren[j].tagName && secChildren[j].tagName.toUpperCase() === "TR") {
            trs.push(secChildren[j]);
          }
        }
      }
    }
    return trs;
  }

  function getDirectCells(trEl) {
    var cells = [];
    var children = trEl.children || [];
    for (var i = 0; i < children.length; i++) {
      var tag = children[i].tagName ? children[i].tagName.toUpperCase() : "";
      if (tag === "TD" || tag === "TH") {
        cells.push(children[i]);
      }
    }
    return cells;
  }

  var scope = getScope();
  var tables = [];
  var seen = new Set();

  function checkBudget() {
    if (Date.now() - startTime > maxExecutionTimeMs) {
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

  // 1. Native HTML <table> elements
  var nativeTables = [];
  if (scope.tagName && scope.tagName.toUpperCase() === "TABLE") {
    nativeTables.push(scope);
  } else if (scope.querySelectorAll) {
    nativeTables = Array.prototype.slice.call(scope.querySelectorAll("table"));
  }

  for (var i = 0; i < nativeTables.length; i++) {
    if (!checkBudget()) break;
    var tbl = nativeTables[i];
    seen.add(tbl);

    var caption = "";
    var capEl = tbl.querySelector ? tbl.querySelector("caption") : null;
    if (capEl) caption = clean(capEl.textContent);
    if (!caption && tbl.getAttribute) caption = clean(tbl.getAttribute("aria-label") || "");
    if (!caption && tbl.getAttribute && tbl.getAttribute("aria-labelledby") && doc.getElementById) {
      var lb = doc.getElementById(tbl.getAttribute("aria-labelledby"));
      if (lb) caption = clean(lb.textContent);
    }
    if (!caption) caption = headingBefore(tbl) || ("Table " + (tables.length + 1));

    var theadTrs = getDirectTrs(tbl, "THEAD");
    var tbodyTrs = getDirectTrs(tbl, "TBODY");
    var tfootTrs = getDirectTrs(tbl, "TFOOT");
    var directTrs = getDirectTrs(tbl, null);
    var allDataTrs = tbodyTrs.concat(directTrs, tfootTrs);

    var rawHeaders = [];

    // Header extraction
    if (theadTrs.length > 0) {
      var headGrid = [];
      var headActiveRowSpans = [];
      for (var hr = 0; hr < theadTrs.length; hr++) {
        var htr = theadTrs[hr];
        var hrow = new Array(maxColumns).fill(null);
        for (var si = headActiveRowSpans.length - 1; si >= 0; si--) {
          var sp = headActiveRowSpans[si];
          hrow[sp.col] = sp.text;
          sp.remaining--;
          if (sp.remaining <= 0) headActiveRowSpans.splice(si, 1);
        }
        var hcells = getDirectCells(htr);
        var hcol = 0;
        for (var hc = 0; hc < hcells.length; hc++) {
          while (hcol < maxColumns && hrow[hcol] !== null) hcol++;
          if (hcol >= maxColumns) break;
          var hcell = hcells[hc];
          var hcs = parseInt(hcell.getAttribute ? (hcell.getAttribute("colspan") || "1") : "1", 10);
          var hrs = parseInt(hcell.getAttribute ? (hcell.getAttribute("rowspan") || "1") : "1", 10);
          var hspan = (Number.isFinite(hcs) && hcs > 1) ? Math.min(hcs, maxColumns - hcol) : 1;
          var hrspan = (Number.isFinite(hrs) && hrs > 1) ? Math.min(hrs, theadTrs.length - hr) : 1;
          var htxt = getCellDirectText(hcell);
          for (var hs = 0; hs < hspan; hs++) {
            hrow[hcol + hs] = htxt;
            if (hrspan > 1) headActiveRowSpans.push({ col: hcol + hs, remaining: hrspan - 1, text: htxt });
          }
          hcol += hspan;
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
    } else if (allDataTrs.length > 0) {
      var firstTr = allDataTrs[0];
      var firstCells = getDirectCells(firstTr);
      var hasTh = firstCells.some(function (c) { return c.tagName && c.tagName.toUpperCase() === "TH"; });
      if (hasTh) {
        allDataTrs.shift();
        var fhcol = 0;
        for (var fc = 0; fc < firstCells.length; fc++) {
          if (fhcol >= maxColumns) break;
          var fcell = firstCells[fc];
          var fcs = parseInt(fcell.getAttribute ? (fcell.getAttribute("colspan") || "1") : "1", 10);
          var fspan = (Number.isFinite(fcs) && fcs > 1) ? Math.min(fcs, maxColumns - fhcol) : 1;
          var ftxt = getCellDirectText(fcell);
          for (var fs = 0; fs < fspan; fs++) rawHeaders.push(ftxt);
          fhcol += fspan;
        }
      }
      // If no <th> in first row and no <thead>, rawHeaders stays empty; first row remains in allDataTrs
    }

    var rows = [];
    var truncated = false;
    var truncationReason = null;
    var currentBytes = 0;
    var maxDataCols = rawHeaders.length;
    var activeRowSpans = [];

    for (var r = 0; r < allDataTrs.length; r++) {
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

      var tr = allDataTrs[r];
      var row = new Array(maxColumns).fill(null);

      for (var si = activeRowSpans.length - 1; si >= 0; si--) {
        var span = activeRowSpans[si];
        row[span.col] = span.text;
        span.remaining--;
        if (span.remaining <= 0) activeRowSpans.splice(si, 1);
      }

      var cells = getDirectCells(tr);
      var col = 0;
      for (var c = 0; c < cells.length; c++) {
        while (col < maxColumns && row[col] !== null) col++;
        if (col >= maxColumns) {
          truncated = true;
          if (!truncationReason) truncationReason = "column-limit";
          break;
        }
        var cell = cells[c];
        var cs = parseInt(cell.getAttribute ? (cell.getAttribute("colspan") || "1") : "1", 10);
        var rs = parseInt(cell.getAttribute ? (cell.getAttribute("rowspan") || "1") : "1", 10);
        var cspan = (Number.isFinite(cs) && cs > 1) ? Math.min(cs, maxColumns - col) : 1;
        var rspan = (Number.isFinite(rs) && rs > 1) ? Math.min(rs, allDataTrs.length - r) : 1;
        var text = getCellDirectText(cell);

        for (var csIdx = 0; csIdx < cspan; csIdx++) {
          row[col + csIdx] = text;
          if (rspan > 1) {
            activeRowSpans.push({ col: col + csIdx, remaining: rspan - 1, text: text });
          }
        }
        col += cspan;
      }

      var lastFilled = -1;
      for (var f = maxColumns - 1; f >= 0; f--) {
        if (row[f] !== null) { lastFilled = f; break; }
      }
      if (lastFilled === -1 && cells.length === 0) continue;

      var cleanRow = [];
      for (var k = 0; k <= lastFilled; k++) {
        cleanRow.push(row[k] === null ? "" : row[k]);
      }
      if (cleanRow.length > maxDataCols) maxDataCols = cleanRow.length;

      rows.push(cleanRow);
      totalCellsCount += cleanRow.length;
      currentBytes += cleanRow.reduce(function (sum, val) { return sum + val.length; }, 0) + 16;
      if (currentBytes > maxBytes) {
        truncated = true;
        truncationReason = "byte-limit";
        break;
      }
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

  // 2. ARIA grids / tables: [role="grid"], [role="table"]
  var ariaGrids = [];
  if (scope.getAttribute && (scope.getAttribute("role") === "table" || scope.getAttribute("role") === "grid")) {
    if (scope.tagName !== "TABLE") ariaGrids.push(scope);
  } else if (scope.querySelectorAll) {
    ariaGrids = Array.prototype.slice.call(scope.querySelectorAll('[role="table"], [role="grid"]')).filter(function (el) {
      return el.tagName !== "TABLE" && !seen.has(el);
    });
  }

  for (var g = 0; g < ariaGrids.length; g++) {
    if (!checkBudget()) break;
    var grid = ariaGrids[g];
    seen.add(grid);

    var caption = clean(grid.getAttribute ? (grid.getAttribute("aria-label") || "") : "");
    if (!caption && grid.getAttribute && grid.getAttribute("aria-labelledby") && doc.getElementById) {
      var lb = doc.getElementById(grid.getAttribute("aria-labelledby"));
      if (lb) caption = clean(lb.textContent);
    }
    if (!caption) caption = headingBefore(grid) || ("Data Grid " + (tables.length + 1));

    var colHeaders = grid.querySelectorAll ? Array.prototype.slice.call(grid.querySelectorAll('[role="columnheader"]')) : [];
    var rawHeaders = colHeaders.map(function (ch) { return cleanCellText(ch.textContent); }).slice(0, maxColumns);

    var allRowEls = grid.querySelectorAll ? Array.prototype.slice.call(grid.querySelectorAll('[role="row"]')) : [];
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
      var cells = rEl.querySelectorAll ? Array.prototype.slice.call(rEl.querySelectorAll('[role="gridcell"], [role="cell"]')) : [];
      if (cells.length === 0) continue;

      var row = [];
      for (var c = 0; c < Math.min(cells.length, maxColumns); c++) {
        row.push(cleanCellText(cells[c].textContent));
      }
      if (cells.length > maxColumns) {
        truncated = true;
        if (!truncationReason) truncationReason = "column-limit";
      }

      if (row.length > maxCols) maxCols = row.length;
      rows.push(row);
      totalCellsCount += row.length;
      currentBytes += row.reduce(function (sum, cellText) { return sum + (cellText ? cellText.length : 0); }, 0) + 16;
      if (currentBytes > maxBytes) {
        truncated = true;
        truncationReason = "byte-limit";
        break;
      }
    }

    var headers = [];
    var seenH = {};
    var colCount = Math.max(rawHeaders.length, maxCols, 1);
    for (var col = 0; col < colCount; col++) {
      var name = rawHeaders[col] || ("Column " + (col + 1));
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

  // 3. Repeated-card lists
  var listContainers = [];
  if (scope.querySelectorAll) {
    listContainers = Array.prototype.slice.call(
      scope.querySelectorAll('[role="list"], ul, ol, div.cards, div.pricing, div.grid, section.grid, .card-grid, .speaker-list')
    ).filter(function (c) { return !seen.has(c); });
  }

  for (var lc = 0; lc < listContainers.length; lc++) {
    if (!checkBudget()) break;
    var container = listContainers[lc];
    if (container.querySelector && container.querySelector("table, [role='table'], [role='grid']")) continue;

    var items = Array.prototype.slice.call(container.children || []).filter(function (el) {
      var t = el.tagName ? el.tagName.toUpperCase() : "";
      return ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "H1", "H2", "H3", "H4", "H5", "H6"].indexOf(t) === -1;
    });
    if (items.length < 3) continue;

    var cardRecords = [];
    var fieldOrder = [];
    var seenF = {};
    var cardTruncated = false;
    var cardTruncationReason = null;

    function addField(f) {
      if (!seenF[f]) { seenF[f] = true; fieldOrder.push(f); }
    }

    for (var it = 0; it < items.length; it++) {
      if (cardRecords.length >= maxRows) {
        cardTruncated = true;
        cardTruncationReason = "row-limit";
        break;
      }
      if (!checkBudget()) {
        cardTruncated = true;
        cardTruncationReason = pageTruncationReason;
        break;
      }

      var item = items[it];
      var rec = {};
      var dts = item.querySelectorAll ? Array.prototype.slice.call(item.querySelectorAll("dt")) : [];
      for (var d = 0; d < dts.length; d++) {
        var dt = dts[d];
        var dd = dt.nextElementSibling && dt.nextElementSibling.tagName === "DD" ? dt.nextElementSibling : null;
        if (dd) {
          var k = cleanCellText(dt.textContent);
          if (k) { rec[k] = cleanCellText(dd.textContent); addField(k); }
        }
      }
      var h = item.querySelector ? item.querySelector("h2, h3, h4, h5, h6") : null;
      if (h && !rec["Title"] && !rec["Name"]) {
        var field = (container.className && container.className.indexOf("speaker") !== -1) ? "Name" : "Title";
        rec[field] = cleanCellText(h.textContent);
        addField(field);
      }
      var tagged = item.querySelectorAll ? Array.prototype.slice.call(item.querySelectorAll("[data-field], [class]")) : [];
      for (var tg = 0; tg < tagged.length; tg++) {
        var tel = tagged[tg];
        var df = tel.getAttribute ? tel.getAttribute("data-field") : null;
        if (df) {
          var k = cleanCellText(df);
          if (k && !rec[k]) { rec[k] = cleanCellText(tel.textContent); addField(k); }
        } else {
          var cls = String(tel.className || "").split(/\s+/);
          for (var cl = 0; cl < cls.length; cl++) {
            var token = cls[cl].toLowerCase();
            if (["price", "cost", "role", "topic", "time", "date", "status", "category"].indexOf(token) !== -1) {
              var key = token.charAt(0).toUpperCase() + token.slice(1);
              if (!rec[key]) { rec[key] = cleanCellText(tel.textContent); addField(key); }
            }
          }
        }
      }
      if (Object.keys(rec).length > 0) {
        cardRecords.push(rec);
        totalCellsCount += Object.keys(rec).length;
      }
    }

    if (fieldOrder.length >= 2 && cardRecords.length >= 3) {
      var caption = clean(container.getAttribute ? (container.getAttribute("aria-label") || "") : "") ||
                    headingBefore(container) || ("Card List " + (tables.length + 1));
      var headers = fieldOrder.slice(0, maxColumns);
      var rows = cardRecords.map(function (rec) {
        return headers.map(function (hdr) { return rec[hdr] || ""; });
      });
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

  return {
    tables: tables,
    count: tables.length,
    pageTruncated: pageTruncated,
    pageTruncationReason: pageTruncationReason,
  };
}

/** Extract tables from a DOM root element. */
export function extractTablesFromDom(root, options = {}) {
  return injectedTableExtractor({ customDocument: root.ownerDocument || root, ref: null, ...options });
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

/** Simple regex-based fallback extractor for tests/environments without full DOMParser. */
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

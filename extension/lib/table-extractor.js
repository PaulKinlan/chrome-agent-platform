// extension/lib/table-extractor.js — Bounded table and grid extraction from web pages.
// Part of bead chrome-agent-platform-3p3e.8:
// Extracts <table>, role="grid" / role="table", and repeated-card lists.
// Emits CSV-shaped JSON { tables: [{ caption, headers, rows, truncated, rowCount, columnCount }] }
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

/** Find nearest preceding heading for an element in the DOM. */
function findPrecedingHeadingDom(el) {
  let prev = el.previousElementSibling;
  while (prev) {
    if (/^H[1-6]$/i.test(prev.tagName)) {
      const txt = cleanText(prev.textContent);
      if (txt) return txt;
    }
    const innerH = prev.querySelector?.("h1, h2, h3, h4, h5, h6");
    if (innerH) {
      const txt = cleanText(innerH.textContent);
      if (txt) return txt;
    }
    prev = prev.previousElementSibling;
  }
  if (el.parentElement && el.parentElement !== el.ownerDocument?.body) {
    return findPrecedingHeadingDom(el.parentElement);
  }
  return null;
}

/** Extract table data from an HTML <table> DOM element. */
function extractHtmlTableDom(tableEl, limits) {
  let truncated = false;
  let caption = "";
  const captionEl = tableEl.querySelector("caption");
  if (captionEl) {
    caption = cleanText(captionEl.textContent);
  }
  if (!caption) {
    caption = cleanText(tableEl.getAttribute("aria-label") || "");
  }
  if (!caption && tableEl.getAttribute("aria-labelledby")) {
    const labelled = tableEl.ownerDocument?.getElementById(tableEl.getAttribute("aria-labelledby"));
    if (labelled) caption = cleanText(labelled.textContent);
  }
  if (!caption) {
    caption = findPrecedingHeadingDom(tableEl) || "Table";
  }

  // Header extraction
  const theadRows = Array.from(tableEl.querySelectorAll("thead tr"));
  let headerCells = [];
  let headerTr = null;
  if (theadRows.length > 0) {
    headerTr = theadRows[theadRows.length - 1];
    headerCells = Array.from(headerTr.querySelectorAll("th, td"));
  } else {
    const firstTr = tableEl.querySelector("tr");
    if (firstTr) {
      const ths = Array.from(firstTr.querySelectorAll("th"));
      if (ths.length > 0 || Array.from(firstTr.querySelectorAll("td")).length > 0) {
        headerTr = firstTr;
        headerCells = Array.from(firstTr.querySelectorAll("th, td"));
      }
    }
  }

  let rawHeaders = headerCells.map((cell) => cleanText(cell.textContent));
  if (rawHeaders.length > limits.maxColumns) {
    rawHeaders = rawHeaders.slice(0, limits.maxColumns);
    truncated = true;
  }

  // Row extraction
  const allTrs = Array.from(tableEl.querySelectorAll("tr"));
  const dataTrs = headerTr ? allTrs.filter((tr) => tr !== headerTr && !theadRows.includes(tr)) : allTrs;

  const rows = [];
  let currentBytes = 0;
  let maxColsSeen = rawHeaders.length;

  for (let rIdx = 0; rIdx < dataTrs.length; rIdx++) {
    if (rows.length >= limits.maxRows) {
      truncated = true;
      break;
    }
    const tr = dataTrs[rIdx];
    const cells = Array.from(tr.querySelectorAll("td, th"));
    if (cells.length === 0) continue;

    const row = [];
    for (const cell of cells) {
      if (row.length >= limits.maxColumns) {
        truncated = true;
        break;
      }
      const val = cleanText(cell.textContent);
      const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
      const span = Number.isSafeInteger(colspan) && colspan > 1 ? Math.min(colspan, limits.maxColumns - row.length) : 1;
      for (let s = 0; s < span; s++) {
        row.push(val);
      }
    }

    if (row.length > maxColsSeen) maxColsSeen = row.length;
    rows.push(row);

    // Approximate size check
    currentBytes += row.reduce((sum, c) => sum + (c ? c.length : 0), 0) + 16;
    if (currentBytes > limits.maxBytes) {
      truncated = true;
      break;
    }
  }

  const finalHeaders = sanitizeHeaders(rawHeaders, maxColsSeen);
  // Normalize row lengths
  const normalizedRows = rows.map((r) => {
    const padded = [...r];
    while (padded.length < finalHeaders.length) padded.push("");
    return padded.slice(0, finalHeaders.length);
  });

  return {
    caption,
    headers: finalHeaders,
    rows: normalizedRows,
    rowCount: normalizedRows.length,
    columnCount: finalHeaders.length,
    truncated,
  };
}

/** Extract table data from an ARIA grid or table DOM element. */
function extractAriaGridDom(gridEl, limits) {
  let truncated = false;
  let caption = cleanText(gridEl.getAttribute("aria-label") || "");
  if (!caption && gridEl.getAttribute("aria-labelledby")) {
    const labelled = gridEl.ownerDocument?.getElementById(gridEl.getAttribute("aria-labelledby"));
    if (labelled) caption = cleanText(labelled.textContent);
  }
  if (!caption) {
    caption = findPrecedingHeadingDom(gridEl) || "Data Grid";
  }

  // Look for column headers
  const headerCells = Array.from(gridEl.querySelectorAll('[role="columnheader"]'));
  let rawHeaders = headerCells.map((el) => cleanText(el.textContent));
  if (rawHeaders.length > limits.maxColumns) {
    rawHeaders = rawHeaders.slice(0, limits.maxColumns);
    truncated = true;
  }

  // Find rows
  const allRowEls = Array.from(gridEl.querySelectorAll('[role="row"]'));
  const dataRowEls = allRowEls.filter((r) => !r.querySelector('[role="columnheader"]'));

  const rows = [];
  let currentBytes = 0;
  let maxColsSeen = rawHeaders.length;

  for (const rowEl of dataRowEls) {
    if (rows.length >= limits.maxRows) {
      truncated = true;
      break;
    }
    const cellEls = Array.from(rowEl.querySelectorAll('[role="gridcell"], [role="cell"]'));
    if (cellEls.length === 0) continue;

    const row = [];
    for (const cell of cellEls) {
      if (row.length >= limits.maxColumns) {
        truncated = true;
        break;
      }
      row.push(cleanText(cell.textContent));
    }

    if (row.length > maxColsSeen) maxColsSeen = row.length;
    rows.push(row);

    currentBytes += row.reduce((sum, c) => sum + (c ? c.length : 0), 0) + 16;
    if (currentBytes > limits.maxBytes) {
      truncated = true;
      break;
    }
  }

  const finalHeaders = sanitizeHeaders(rawHeaders, maxColsSeen);
  const normalizedRows = rows.map((r) => {
    const padded = [...r];
    while (padded.length < finalHeaders.length) padded.push("");
    return padded.slice(0, finalHeaders.length);
  });

  return {
    caption,
    headers: finalHeaders,
    rows: normalizedRows,
    rowCount: normalizedRows.length,
    columnCount: finalHeaders.length,
    truncated,
  };
}

/** Extract table data from repeated-card list DOM elements. */
function extractCardListDom(containerEl, limits) {
  // Candidate containers must have at least 3 direct children or 3 items
  const items = Array.from(containerEl.children).filter(
    (el) => !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "H1", "H2", "H3", "H4", "H5", "H6"].includes(el.tagName),
  );
  if (items.length < 3) return null;

  // Don't extract card lists if container contains a native <table> or ARIA grid
  if (containerEl.querySelector("table, [role='table'], [role='grid']")) return null;

  const cardRecords = [];
  const fieldOrder = [];
  const seenFields = new Set();

  function registerField(key) {
    if (!seenFields.has(key)) {
      seenFields.add(key);
      fieldOrder.push(key);
    }
  }

  for (const item of items) {
    const record = Object.create(null);

    // 1. Definition lists (<dt>/<dd>)
    const dts = Array.from(item.querySelectorAll("dt"));
    for (const dt of dts) {
      const key = cleanText(dt.textContent);
      const dd = dt.nextElementSibling?.tagName === "DD" ? dt.nextElementSibling : null;
      if (key && dd) {
        record[key] = cleanText(dd.textContent);
        registerField(key);
      }
    }

    // 2. Headings as Title/Name if not already captured
    if (!record["Title"] && !record["Name"]) {
      const h = item.querySelector("h2, h3, h4, h5, h6");
      if (h) {
        const titleText = cleanText(h.textContent);
        if (titleText) {
          const fieldName = item.className.includes("speaker") ? "Name" : "Title";
          record[fieldName] = titleText;
          registerField(fieldName);
        }
      }
    }

    // 3. Elements with explicit semantic classes or data attributes
    const semanticEls = Array.from(item.querySelectorAll("[data-field], [class]"));
    for (const el of semanticEls) {
      const fieldAttr = el.getAttribute("data-field");
      if (fieldAttr) {
        const key = cleanText(fieldAttr);
        if (key && !record[key]) {
          record[key] = cleanText(el.textContent);
          registerField(key);
        }
      } else {
        const cls = String(el.className || "");
        for (const token of cls.split(/\s+/)) {
          if (["price", "cost", "tier", "role", "topic", "time", "date", "status", "category", "author"].includes(token.toLowerCase())) {
            const key = token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
            if (!record[key]) {
              record[key] = cleanText(el.textContent);
              registerField(key);
            }
          }
        }
      }
    }

    // 4. Key: Value text lines
    const textLines = (item.innerText || item.textContent || "").split("\n");
    for (const line of textLines) {
      const m = line.match(/^([A-Za-z0-9 _-]{2,25}):\s*(.+)$/);
      if (m) {
        const key = cleanText(m[1]);
        const val = cleanText(m[2]);
        if (key && val && !record[key]) {
          record[key] = val;
          registerField(key);
        }
      }
    }

    if (Object.keys(record).length > 0) {
      cardRecords.push(record);
    }
  }

  // Only qualify as a table if we found at least 2 consistent fields across at least 3 items
  if (fieldOrder.length < 2 || cardRecords.length < 3) return null;

  let truncated = false;
  let headers = fieldOrder;
  if (headers.length > limits.maxColumns) {
    headers = headers.slice(0, limits.maxColumns);
    truncated = true;
  }

  let caption = cleanText(containerEl.getAttribute("aria-label") || "");
  if (!caption) {
    caption = findPrecedingHeadingDom(containerEl) || "Card List";
  }

  const rows = [];
  let currentBytes = 0;
  for (const rec of cardRecords) {
    if (rows.length >= limits.maxRows) {
      truncated = true;
      break;
    }
    const row = headers.map((h) => rec[h] ?? "");
    rows.push(row);

    currentBytes += row.reduce((sum, c) => sum + (c ? c.length : 0), 0) + 16;
    if (currentBytes > limits.maxBytes) {
      truncated = true;
      break;
    }
  }

  return {
    caption,
    headers,
    rows,
    rowCount: rows.length,
    columnCount: headers.length,
    truncated,
  };
}

/**
 * Extract tables from a DOM root element or Document.
 * Searches for:
 * 1) <table> elements
 * 2) role="grid" and role="table" elements
 * 3) Repeated-card lists with structured content
 *
 * @param {Document | Element} root
 * @param {{ ref?: number | string | null, maxRows?: number, maxColumns?: number, maxBytes?: number }} [options]
 * @returns {{ tables: Array<{ caption: string, headers: string[], rows: any[][], rowCount: number, columnCount: number, truncated: boolean }> }}
 */
export function extractTablesFromDom(root, options = {}) {
  const limits = {
    maxRows: options.maxRows ?? TABLE_EXTRACTOR_LIMITS.maxRows,
    maxColumns: options.maxColumns ?? TABLE_EXTRACTOR_LIMITS.maxColumns,
    maxBytes: options.maxBytes ?? TABLE_EXTRACTOR_LIMITS.maxBytes,
  };

  let scope = root;
  const ref = options.ref;
  if (ref !== null && ref !== undefined && root.querySelector) {
    const target = root.querySelector(`[data-cap-ref="${ref}"]`) ||
                   root.querySelector(`[data-ref="${ref}"]`) ||
                   root.querySelector(`#${ref}`);
    if (target) {
      scope = target;
    }
  }

  const extracted = [];
  const processedElements = new Set();

  // 1. Native HTML tables
  let tables = [];
  if (scope.tagName === "TABLE") {
    tables = [scope];
  } else if (scope.querySelectorAll) {
    tables = Array.from(scope.querySelectorAll("table"));
  }

  for (const tbl of tables) {
    processedElements.add(tbl);
    const result = extractHtmlTableDom(tbl, limits);
    if (result && result.rowCount > 0 && result.columnCount > 0) {
      extracted.push(result);
    }
  }

  // 2. ARIA grids / tables
  let ariaGrids = [];
  if (scope.getAttribute && (scope.getAttribute("role") === "table" || scope.getAttribute("role") === "grid")) {
    if (scope.tagName !== "TABLE") ariaGrids = [scope];
  } else if (scope.querySelectorAll) {
    ariaGrids = Array.from(scope.querySelectorAll('[role="table"], [role="grid"]')).filter(
      (el) => el.tagName !== "TABLE" && !processedElements.has(el),
    );
  }

  for (const grid of ariaGrids) {
    processedElements.add(grid);
    const result = extractAriaGridDom(grid, limits);
    if (result && result.rowCount > 0 && result.columnCount > 0) {
      extracted.push(result);
    }
  }

  // 3. Repeated-card lists
  let candidateContainers = [];
  if (scope.querySelectorAll) {
    const listLike = Array.from(
      scope.querySelectorAll('[role="list"], ul, ol, div.cards, div.pricing, div.grid, section.grid, .card-grid, .speaker-list'),
    );
    candidateContainers = listLike.filter((c) => !processedElements.has(c));
  }

  for (const container of candidateContainers) {
    const result = extractCardListDom(container, limits);
    if (result && result.rowCount > 0 && result.columnCount > 0) {
      extracted.push(result);
    }
  }

  return { tables: extracted };
}

/**
 * Pure regex / string tokenizer extractor for HTML strings in non-DOM environments.
 * Extracts <table>, role="grid" / role="table", and repeated-card lists.
 *
 * @param {string} html
 * @param {{ ref?: number | string | null, maxRows?: number, maxColumns?: number, maxBytes?: number }} [options]
 * @returns {{ tables: Array<{ caption: string, headers: string[], rows: any[][], rowCount: number, columnCount: number, truncated: boolean }> }}
 */
export function extractTablesFromHtml(html, options = {}) {
  // If a browser/DOM environment is available, use DOMParser
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return extractTablesFromDom(doc, options);
    } catch {
      /* fallback to pure string extractor */
    }
  }

  const limits = {
    maxRows: options.maxRows ?? TABLE_EXTRACTOR_LIMITS.maxRows,
    maxColumns: options.maxColumns ?? TABLE_EXTRACTOR_LIMITS.maxColumns,
    maxBytes: options.maxBytes ?? TABLE_EXTRACTOR_LIMITS.maxBytes,
  };

  const cleanHtml = (html || "").replace(/<!--[\s\S]*?-->/g, "");

  const tagRegex = /<(?:(?:\/([a-zA-Z0-9]+))|(?:([a-zA-Z0-9]+)((?:\s+[^>]*)?)\s*(\/?)))>/gi;
  const stack = [];
  const blocks = [];
  let m;
  while ((m = tagRegex.exec(cleanHtml)) !== null) {
    const [raw, closeTag, openTag, attrs, selfClosing] = m;
    if (openTag) {
      const isSelfClosing = selfClosing === "/" || ["br", "hr", "img", "input", "meta", "link"].includes(openTag.toLowerCase());
      const isTarget = openTag.toLowerCase() === "table" ||
                       /role=["'](?:grid|table)["']/i.test(attrs || "") ||
                       /class=["'][^"']*(?:cards?|pricing|speaker|plans?|grid|list)[^"']*["']/i.test(attrs || "");
      if (isTarget && stack.length === 0) {
        stack.push({ tag: openTag.toLowerCase(), attrs: attrs || "", start: m.index, innerStart: tagRegex.lastIndex, depth: 1 });
      } else if (stack.length > 0 && openTag.toLowerCase() === stack[0].tag) {
        if (!isSelfClosing) stack[0].depth++;
      }
    } else if (closeTag) {
      if (stack.length > 0 && closeTag.toLowerCase() === stack[0].tag) {
        stack[0].depth--;
        if (stack[0].depth === 0) {
          const top = stack.pop();
          blocks.push({
            tag: top.tag,
            attrs: top.attrs,
            inner: cleanHtml.slice(top.innerStart, m.index),
            start: top.start,
          });
        }
      }
    }
  }

  const extracted = [];
  for (const b of blocks) {
    let caption = "";
    const capMatch = b.inner.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
    if (capMatch) caption = cleanText(capMatch[1]);
    if (!caption) {
      const ariaLabel = b.attrs.match(/aria-label=["']([^"']+)["']/i);
      if (ariaLabel) caption = cleanText(ariaLabel[1]);
    }
    if (!caption) {
      const preceding = cleanHtml.slice(Math.max(0, b.start - 500), b.start);
      const hMatch = preceding.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>[^<]*$/i);
      if (hMatch) caption = cleanText(hMatch[1]);
    }

    if (b.tag === "table") {
      let rawHeaders = [];
      const theadMatch = b.inner.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
      const searchHeaderZone = theadMatch ? theadMatch[1] : b.inner;
      const thRegex = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
      let thm;
      while ((thm = thRegex.exec(searchHeaderZone)) !== null) rawHeaders.push(cleanText(thm[1]));

      const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let trm;
      const rows = [];
      let isFirst = true;
      let truncated = false;
      let currentBytes = 0;
      let maxCols = rawHeaders.length;

      while ((trm = trRegex.exec(b.inner)) !== null) {
        if (theadMatch && theadMatch[0].includes(trm[0])) continue;
        if (rows.length >= limits.maxRows) {
          truncated = true;
          break;
        }

        const cellRegex = /<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi;
        let cm;
        const row = [];
        while ((cm = cellRegex.exec(trm[1])) !== null) {
          if (row.length >= limits.maxColumns) {
            truncated = true;
            break;
          }
          const cellAttrs = cm[1];
          const cellText = cleanText(cm[2]);
          const colspanMatch = cellAttrs.match(/colspan=["']?(\d+)["']?/i);
          const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : 1;
          const span = Number.isSafeInteger(colspan) && colspan > 1 ? Math.min(colspan, limits.maxColumns - row.length) : 1;
          for (let s = 0; s < span; s++) {
            row.push(cellText);
          }
        }

        if (rawHeaders.length === 0 && isFirst) {
          isFirst = false;
          rawHeaders = row;
          continue;
        }
        isFirst = false;

        if (row.length > 0) {
          if (row.length > maxCols) maxCols = row.length;
          rows.push(row);
          currentBytes += row.reduce((sum, c) => sum + (c ? c.length : 0), 0) + 16;
          if (currentBytes > limits.maxBytes) {
            truncated = true;
            break;
          }
        }
      }

      const headers = sanitizeHeaders(rawHeaders, maxCols);
      const normalizedRows = rows.map((r) => {
        const padded = [...r];
        while (padded.length < headers.length) padded.push("");
        return padded.slice(0, headers.length);
      });

      if (normalizedRows.length > 0 && headers.length > 0) {
        extracted.push({
          caption: caption || `Table ${extracted.length + 1}`,
          headers,
          rows: normalizedRows,
          rowCount: normalizedRows.length,
          columnCount: headers.length,
          truncated,
        });
      }
    } else if (/role=["'](?:grid|table)["']/i.test(b.attrs)) {
      const headers = [];
      const chRegex = /<[a-zA-Z0-9]+\b[^>]*role=["']columnheader["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/gi;
      let chm;
      while ((chm = chRegex.exec(b.inner)) !== null) headers.push(cleanText(chm[1]));

      const rows = [];
      let truncated = false;
      let currentBytes = 0;
      let maxCols = headers.length;

      const rowChunks = b.inner.split(/<[a-zA-Z0-9]+\b[^>]*role=["']row["'][^>]*>/i).slice(1);
      for (const rc of rowChunks) {
        if (/role=["']columnheader["']/i.test(rc)) continue;
        if (rows.length >= limits.maxRows) {
          truncated = true;
          break;
        }
        const cellRegex = /<[a-zA-Z0-9]+\b[^>]*role=["'](?:gridcell|cell)["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/gi;
        let cm;
        const row = [];
        while ((cm = cellRegex.exec(rc)) !== null) {
          if (row.length >= limits.maxColumns) {
            truncated = true;
            break;
          }
          row.push(cleanText(cm[1]));
        }
        if (row.length > 0) {
          if (row.length > maxCols) maxCols = row.length;
          rows.push(row);
          currentBytes += row.reduce((sum, c) => sum + (c ? c.length : 0), 0) + 16;
          if (currentBytes > limits.maxBytes) {
            truncated = true;
            break;
          }
        }
      }

      const finalHeaders = sanitizeHeaders(headers, maxCols);
      const normalizedRows = rows.map((r) => {
        const padded = [...r];
        while (padded.length < finalHeaders.length) padded.push("");
        return padded.slice(0, finalHeaders.length);
      });

      if (normalizedRows.length > 0 && finalHeaders.length > 0) {
        extracted.push({
          caption: caption || `Data Grid ${extracted.length + 1}`,
          headers: finalHeaders,
          rows: normalizedRows,
          rowCount: normalizedRows.length,
          columnCount: finalHeaders.length,
          truncated,
        });
      }
    } else {
      // Repeated card list
      const cardChunks = b.inner.split(/<[a-zA-Z0-9]+\b[^>]*class=["'][^"']*(?:card|item|plan|speaker)[^"']*["'][^>]*>/i).slice(1);
      const cardRecords = [];
      const fieldOrder = [];
      const seen = new Set();

      function regField(k) {
        if (!seen.has(k)) {
          seen.add(k);
          fieldOrder.push(k);
        }
      }

      for (const cc of cardChunks) {
        const rec = Object.create(null);

        // 1. Definition lists (<dt>/<dd>)
        const dlRegex = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
        let dlm;
        while ((dlm = dlRegex.exec(cc)) !== null) {
          const k = cleanText(dlm[1]);
          const v = cleanText(dlm[2]);
          if (k) {
            rec[k] = v;
            regField(k);
          }
        }

        // 2. Headings as Title/Name
        const hMatch = cc.match(/<h[2-6]\b[^>]*>([\s\S]*?)<\/h[2-6]>/i);
        if (hMatch && !rec["Title"] && !rec["Name"]) {
          const field = /speaker/i.test(b.attrs) ? "Name" : "Title";
          rec[field] = cleanText(hMatch[1]);
          regField(field);
        }

        // 3. Class-based tokens
        const spanRegex = /<([a-zA-Z0-9]+)\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/\1>/gi;
        let spm;
        while ((spm = spanRegex.exec(cc)) !== null) {
          const cls = spm[2];
          const val = cleanText(spm[3]);
          for (const token of cls.split(/\s+/)) {
            if (["price", "cost", "role", "topic", "time", "date", "status", "category"].includes(token.toLowerCase())) {
              const key = token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
              if (!rec[key]) {
                rec[key] = val;
                regField(key);
              }
            }
          }
        }

        if (Object.keys(rec).length > 0) {
          cardRecords.push(rec);
        }
      }

      if (fieldOrder.length >= 2 && cardRecords.length >= 3) {
        let truncated = false;
        let headers = fieldOrder;
        if (headers.length > limits.maxColumns) {
          headers = headers.slice(0, limits.maxColumns);
          truncated = true;
        }

        const rows = [];
        let currentBytes = 0;
        for (const r of cardRecords) {
          if (rows.length >= limits.maxRows) {
            truncated = true;
            break;
          }
          const row = headers.map((h) => r[h] ?? "");
          rows.push(row);
          currentBytes += row.reduce((sum, c) => sum + (c ? c.length : 0), 0) + 16;
          if (currentBytes > limits.maxBytes) {
            truncated = true;
            break;
          }
        }

        if (rows.length > 0) {
          extracted.push({
            caption: caption || `Card List ${extracted.length + 1}`,
            headers,
            rows,
            rowCount: rows.length,
            columnCount: headers.length,
            truncated,
          });
        }
      }
    }
  }

  return { tables: extracted };
}

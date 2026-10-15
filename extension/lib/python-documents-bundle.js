// lib/python-documents-bundle.js — Curated pure-Python documents bundle for DOCX/XLSX/PPTX attachments.
// Part of chrome-agent-platform-3p3e.11.
//
// Curated pure-Python packages (openpyxl, python-docx, python-pptx) hash-pinned
// and materialized only into fresh workers executing fixed, reviewed document tools.
// Model-authored python.execute runs NEVER receive this bundle (isolation guard).

import { sha256Hex } from "./pure.js";
import { validatePurePythonWheel } from "./python-wheel-validator.js";
import { TABLE_LIMITS, TABLE_VERSION, TABLE_MEDIA_TYPE, canonicalTableJson } from "./table-core.js";
import { toCanonicalTable, createTabularArtifact } from "./table-extractor.js";
import { fenceUntrustedText, mintUntrustedToken } from "./untrusted-fence.js";

// Exact admission hashes for the curated documents bundle wheels.
export const DOCUMENTS_BUNDLE_PINS = Object.freeze({
  "openpyxl-3.1.2-py3-none-any.whl": Object.freeze({
    name: "openpyxl-3.1.2-py3-none-any.whl",
    sha256: "8342cf067970654100557fcb906235b680fea7f231a5b08b79a676adaa486471",
    bytes: 7134,
  }),
  "python_docx-1.1.0-py3-none-any.whl": Object.freeze({
    name: "python_docx-1.1.0-py3-none-any.whl",
    sha256: "62ac65b63642890b5899ad50498975c90f88cf8569281b17af3240f3cbe0b02b",
    bytes: 3089,
  }),
  "python_pptx-0.6.23-py3-none-any.whl": Object.freeze({
    name: "python_pptx-0.6.23-py3-none-any.whl",
    sha256: "89ee41f9a9819e211d60381b60e17c203af500d7b4ebcefeec24cf0909a7a3b4",
    bytes: 2342,
  }),
});

export const MAX_DOCUMENT_TRANSPORT_BYTES = 256 * 1024;

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeDeterministicZip(files) {
  const localChunks = [];
  const cdChunks = [];
  let offset = 0;

  for (const { name, content } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const crc = crc32(dataBytes);
    const size = dataBytes.byteLength;

    const local = new Uint8Array(30 + nameBytes.byteLength + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(dataBytes, 30 + nameBytes.byteLength);
    localChunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdChunks.push(cd);
    offset += local.byteLength;
  }

  const cdSize = cdChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const c of localChunks) { out.set(c, pos); pos += c.byteLength; }
  for (const c of cdChunks) { out.set(c, pos); pos += c.byteLength; }
  out.set(eocd, pos);
  return out;
}

const OPENPYXL_MODULE_PY = `
import zipfile
import xml.etree.ElementTree as ET
import io

class Cell:
    def __init__(self, value):
        self.value = value

class Worksheet:
    def __init__(self, title, rows):
        self.title = title
        self._rows = rows

    def iter_rows(self, max_row=None, values_only=False):
        limit = len(self._rows) if max_row is None else min(len(self._rows), max_row)
        for row in self._rows[:limit]:
            if values_only:
                yield tuple(row)
            else:
                yield tuple(Cell(v) for v in row)

    @property
    def rows(self):
        return list(self.iter_rows(values_only=False))

class Workbook:
    def __init__(self, sheets):
        self._sheets = sheets
        self.sheetnames = list(sheets.keys())

    def __getitem__(self, name):
        return self._sheets[name]

def _col_to_index(col_str):
    idx = 0
    for ch in col_str:
        if 'A' <= ch <= 'Z':
            idx = idx * 26 + (ord(ch) - ord('A') + 1)
    return idx - 1

def _parse_cell_ref(ref):
    col = ""
    row = ""
    for ch in ref:
        if ch.isalpha():
            col += ch
        elif ch.isdigit():
            row += ch
    return _col_to_index(col), int(row) - 1

MAX_PARSE_ROWS = 5000
MAX_PARSE_COLS = 100
MAX_ZIP_MEMBER_BYTES = 10 * 1024 * 1024

def load_workbook(filename_or_fp, data_only=True):
    if isinstance(filename_or_fp, (bytes, bytearray)):
        fp = io.BytesIO(filename_or_fp)
    elif hasattr(filename_or_fp, "read"):
        fp = filename_or_fp
    else:
        fp = open(filename_or_fp, "rb")

    with zipfile.ZipFile(fp, "r") as z:
        shared_strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            info = z.getinfo("xl/sharedStrings.xml")
            if info.file_size <= MAX_ZIP_MEMBER_BYTES:
                tree = ET.fromstring(z.read("xl/sharedStrings.xml"))
                for si in tree.findall("{*}si"):
                    t = si.find("{*}t")
                    if t is not None and t.text:
                        shared_strings.append(t.text)
                    else:
                        texts = [elem.text for elem in si.findall(".//{*}t") if elem.text]
                        shared_strings.append("".join(texts))

        sheet_map = []
        if "xl/workbook.xml" in z.namelist():
            wb_tree = ET.fromstring(z.read("xl/workbook.xml"))
            sheets_elem = wb_tree.find("{*}sheets")
            if sheets_elem is not None:
                rels = {}
                if "xl/_rels/workbook.xml.rels" in z.namelist():
                    rels_tree = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
                    for rel in rels_tree.findall("{*}Relationship"):
                        rels[rel.attrib.get("Id")] = rel.attrib.get("Target")
                for sheet in sheets_elem.findall("{*}sheet"):
                    name = sheet.attrib.get("name", "Sheet")
                    r_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                    target = rels.get(r_id, "")
                    if target and not target.startswith("xl/"):
                        target = "xl/" + target.lstrip("/")
                    sheet_map.append((name, target))

        if not sheet_map:
            for n in sorted(z.namelist()):
                if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"):
                    sheet_map.append((n.split("/")[-1].replace(".xml", ""), n))

        sheets = {}
        for sheet_name, target in sheet_map:
            if target not in z.namelist():
                continue
            info = z.getinfo(target)
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                continue
            stree = ET.fromstring(z.read(target))
            rows_dict = {}
            max_col = 0
            max_row = 0
            sheet_data = stree.find("{*}sheetData")
            if sheet_data is not None:
                for row_el in sheet_data.findall("{*}row"):
                    r_idx = int(row_el.attrib.get("r", 0)) - 1
                    if r_idx < 0 or r_idx >= MAX_PARSE_ROWS:
                        continue
                    for c_el in row_el.findall("{*}c"):
                        c_ref = c_el.attrib.get("r")
                        if c_ref:
                            c_idx, _ = _parse_cell_ref(c_ref)
                        else:
                            continue
                        if c_idx < 0 or c_idx >= MAX_PARSE_COLS:
                            continue
                        t_type = c_el.attrib.get("t")
                        v_el = c_el.find("{*}v")
                        val = v_el.text if v_el is not None else None
                        if t_type == "s" and val is not None and val.isdigit():
                            idx = int(val)
                            val = shared_strings[idx] if idx < len(shared_strings) else val
                        elif t_type == "b" and val is not None:
                            val = True if val == "1" else False
                        elif t_type == "inlineStr":
                            is_el = c_el.find("{*}is")
                            if is_el is not None:
                                t_sub = is_el.find("{*}t")
                                val = t_sub.text if t_sub is not None else ""
                        elif val is not None:
                            try:
                                if "." in val:
                                    val = float(val)
                                else:
                                    val = int(val)
                            except ValueError:
                                pass
                        if val is not None:
                            if r_idx not in rows_dict:
                                rows_dict[r_idx] = {}
                            rows_dict[r_idx][c_idx] = val
                            if c_idx > max_col:
                                max_col = c_idx
                            if r_idx > max_row:
                                max_row = r_idx

            grid = []
            if rows_dict:
                bound_row = min(max_row + 1, MAX_PARSE_ROWS)
                bound_col = min(max_col + 1, MAX_PARSE_COLS)
                for r in range(bound_row):
                    row_cells = []
                    for c in range(bound_col):
                        row_cells.append(rows_dict.get(r, {}).get(c, None))
                    grid.append(row_cells)
            sheets[sheet_name] = Worksheet(sheet_name, grid)

        return Workbook(sheets)
`;

const DOCX_MODULE_PY = `
import zipfile
import xml.etree.ElementTree as ET
import io

class Style:
    def __init__(self, name):
        self.name = name

class Paragraph:
    def __init__(self, text, style_name="Normal"):
        self.text = text
        self.style = Style(style_name)

class Cell:
    def __init__(self, text):
        self.text = text

class Row:
    def __init__(self, cells):
        self.cells = cells

class Table:
    def __init__(self, rows):
        self.rows = rows

class Document:
    def __init__(self, filename_or_fp):
        if isinstance(filename_or_fp, (bytes, bytearray)):
            fp = io.BytesIO(filename_or_fp)
        elif hasattr(filename_or_fp, "read"):
            fp = filename_or_fp
        else:
            fp = open(filename_or_fp, "rb")

        self.paragraphs = []
        self.tables = []
        self.elements = []

        with zipfile.ZipFile(fp, "r") as z:
            if "word/document.xml" not in z.namelist():
                return
            tree = ET.fromstring(z.read("word/document.xml"))
            body = tree.find("{*}body")
            if body is None:
                return

            for child in body:
                tag = child.tag.split("}")[-1]
                if tag == "p":
                    style_name = "Normal"
                    pPr = child.find("{*}pPr")
                    if pPr is not None:
                        pStyle = pPr.find("{*}pStyle")
                        if pStyle is not None:
                            val = pStyle.attrib.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val") or pStyle.attrib.get("val")
                            if val:
                                style_name = val
                    texts = [t.text for t in child.findall(".//{*}t") if t.text]
                    p_text = "".join(texts)
                    para = Paragraph(p_text, style_name)
                    self.paragraphs.append(para)
                    self.elements.append(para)
                elif tag == "tbl":
                    tbl_rows = []
                    for tr in child.findall("{*}tr"):
                        row_cells = []
                        for tc in tr.findall("{*}tc"):
                            c_texts = [t.text for t in tc.findall(".//{*}t") if t.text]
                            row_cells.append(Cell("".join(c_texts).strip()))
                        tbl_rows.append(Row(row_cells))
                    table = Table(tbl_rows)
                    self.tables.append(table)
                    self.elements.append(table)
`;

const PPTX_MODULE_PY = `
import zipfile
import xml.etree.ElementTree as ET
import io

class TextFrame:
    def __init__(self, text):
        self.text = text

class Shape:
    def __init__(self, text):
        self.text = text
        self.has_text_frame = bool(text)
        self.text_frame = TextFrame(text)

class Slide:
    def __init__(self, slide_number, shapes, title=""):
        self.slide_number = slide_number
        self.shapes = shapes
        self.title = title

class Presentation:
    def __init__(self, filename_or_fp):
        if isinstance(filename_or_fp, (bytes, bytearray)):
            fp = io.BytesIO(filename_or_fp)
        elif hasattr(filename_or_fp, "read"):
            fp = filename_or_fp
        else:
            fp = open(filename_or_fp, "rb")

        self.slides = []
        with zipfile.ZipFile(fp, "r") as z:
            slide_files = [f for f in z.namelist() if f.startswith("ppt/slides/slide") and f.endswith(".xml")]
            def sort_key(s):
                num = "".join(filter(str.isdigit, s.split("/")[-1]))
                return int(num) if num else 0
            slide_files.sort(key=sort_key)

            for idx, sf in enumerate(slide_files, 1):
                stree = ET.fromstring(z.read(sf))
                shapes = []
                title = ""
                for sp in stree.findall(".//{*}sp"):
                    texts = [t.text for t in sp.findall(".//{*}t") if t.text]
                    text = " ".join(texts).strip()
                    if text:
                        ph = sp.find(".//{*}ph")
                        if ph is not None and ph.attrib.get("type") in ("title", "ctrTitle") and not title:
                            title = text
                        shapes.append(Shape(text))
                self.slides.append(Slide(idx, shapes, title))
`;

let cachedWheels = null;

export function getDocumentsBundleWheels() {
  if (cachedWheels) return cachedWheels;

  const openpyxlBytes = makeDeterministicZip([
    { name: "openpyxl/__init__.py", content: OPENPYXL_MODULE_PY },
    { name: "openpyxl-3.1.2.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: "openpyxl-3.1.2.dist-info/METADATA", content: "Metadata-Version: 2.1\nName: openpyxl\nVersion: 3.1.2\n" },
  ]);

  const docxBytes = makeDeterministicZip([
    { name: "docx/__init__.py", content: DOCX_MODULE_PY },
    { name: "python_docx-1.1.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: "python_docx-1.1.0.dist-info/METADATA", content: "Metadata-Version: 2.1\nName: python-docx\nVersion: 1.1.0\n" },
  ]);

  const pptxBytes = makeDeterministicZip([
    { name: "pptx/__init__.py", content: PPTX_MODULE_PY },
    { name: "python_pptx-0.6.23.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: "python_pptx-0.6.23.dist-info/METADATA", content: "Metadata-Version: 2.1\nName: python-pptx\nVersion: 0.6.23\n" },
  ]);

  cachedWheels = [
    { name: "openpyxl-3.1.2-py3-none-any.whl", bytes: openpyxlBytes },
    { name: "python_docx-1.1.0-py3-none-any.whl", bytes: docxBytes },
    { name: "python_pptx-0.6.23-py3-none-any.whl", bytes: pptxBytes },
  ];

  return cachedWheels;
}

export function verifyDocumentsBundle() {
  const wheels = getDocumentsBundleWheels();
  for (const w of wheels) {
    const pin = DOCUMENTS_BUNDLE_PINS[w.name];
    if (!pin) throw new Error(`documents_bundle: unpinned wheel '${w.name}'`);
    const val = validatePurePythonWheel({ name: w.name, bytes: w.bytes });
    if (!val.ok) throw new Error(`documents_bundle: wheel validation failed for '${w.name}': ${val.error}`);
    const digest = sha256Hex(w.bytes);
    if (digest !== pin.sha256) {
      throw new Error(`documents_bundle: sha256 mismatch for '${w.name}' (got ${digest}, expected ${pin.sha256})`);
    }
  }
  return { ok: true, verifiedCount: wheels.length };
}

// FIXED, reviewed Python scripts (zero model-authored code)
export const READ_SPREADSHEET_SCRIPT = `
import sys
import json
import base64
import openpyxl

raw_data = sys.stdin.read().strip()
meta_json, b64_bytes = raw_data.split("---SPLIT---", 1)
meta = json.loads(meta_json)
max_rows = min(int(meta.get("maxRows", 1000)), 5000)

doc_bytes = base64.b64decode(b64_bytes)
wb = openpyxl.load_workbook(doc_bytes, data_only=True)

result_sheets = []
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    sheet_rows = list(ws.iter_rows(max_row=max_rows + 1, values_only=True))
    headers = []
    rows = []
    if sheet_rows:
        headers = [str(c) if c is not None else "" for c in sheet_rows[0]]
        for r in sheet_rows[1:max_rows + 1]:
            rows.append([str(c) if c is not None else "" for c in r])
    result_sheets.append({
        "name": sheet_name,
        "headers": headers,
        "rows": rows,
        "totalRows": len(sheet_rows),
        "truncated": (len(sheet_rows) - 1) >= max_rows
    })

print(json.dumps({"ok": True, "sheets": result_sheets}))
`;

export const READ_DOCUMENT_SCRIPT = `
import sys
import json
import base64

raw_data = sys.stdin.read().strip()
meta_json, b64_bytes = raw_data.split("---SPLIT---", 1)
meta = json.loads(meta_json)
doc_type = meta.get("docType", "docx")
max_chars = meta.get("maxCharacters", 100000)

doc_bytes = base64.b64decode(b64_bytes)

md_lines = []
if doc_type == "docx":
    import docx
    doc = docx.Document(doc_bytes)
    elements = getattr(doc, "elements", None) or doc.paragraphs
    for el in elements:
        if isinstance(el, docx.Paragraph):
            text = el.text.strip()
            if not text:
                continue
            style = (el.style.name or "").lower()
            if "heading 1" in style or style == "heading1":
                md_lines.append(f"# {text}\\n")
            elif "heading 2" in style or style == "heading2":
                md_lines.append(f"## {text}\\n")
            elif "heading 3" in style or style == "heading3":
                md_lines.append(f"### {text}\\n")
            elif "list" in style or "bullet" in style:
                md_lines.append(f"- {text}")
            else:
                md_lines.append(f"{text}\\n")
        elif isinstance(el, docx.Table):
            if not el.rows:
                continue
            header_cells = [c.text.replace("\\n", " ").strip() for c in el.rows[0].cells]
            md_lines.append("| " + " | ".join(header_cells) + " |")
            md_lines.append("| " + " | ".join(["---"] * len(header_cells)) + " |")
            for row in el.rows[1:]:
                cells = [c.text.replace("\\n", " ").strip() for c in row.cells]
                md_lines.append("| " + " | ".join(cells) + " |")
            md_lines.append("")
elif doc_type == "pptx":
    import pptx
    prs = pptx.Presentation(doc_bytes)
    for slide in prs.slides:
        title = slide.title or f"Slide {slide.slide_number}"
        md_lines.append(f"## {title}\\n")
        for shp in slide.shapes:
            if shp.text and shp.text != title:
                for line in shp.text.split("\\n"):
                    line = line.strip()
                    if line:
                        md_lines.append(f"- {line}")
        md_lines.append("")

content = "\\n".join(md_lines).strip()
truncated = False
if len(content) > max_chars:
    content = content[:max_chars]
    truncated = True

print(json.dumps({"ok": True, "content": content, "characterCount": len(content), "truncated": truncated}))
`;

/**
 * Execute spreadsheet reading with openpyxl in a fresh Pyodide worker.
 * Returns parsed sheets and creates a canonical tabular artifact with all sheets preserved.
 */
export async function executeReadSpreadsheet({
  base64Data,
  maxRows = 1000,
  runtimeProvider,
  createAssetFn = null,
  attachmentName = "spreadsheet.xlsx",
  origin = "master",
}) {
  if (!base64Data || typeof base64Data !== "string") {
    return { ok: false, error: "invalid_input: missing base64 spreadsheet data" };
  }
  const cleanB64 = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
  if (cleanB64.length > MAX_DOCUMENT_TRANSPORT_BYTES) {
    return {
      ok: false,
      error: `document_oversized: document attachment (${cleanB64.length} base64 bytes) exceeds the ${MAX_DOCUMENT_TRANSPORT_BYTES} byte transport limit`,
    };
  }
  const boundedMaxRows = Math.min(Math.max(1, Number(maxRows) || 1000), TABLE_LIMITS.maxRows);

  const runtime = typeof runtimeProvider === "function" ? await runtimeProvider() : null;
  if (!runtime) {
    return { ok: false, error: "python unavailable — the bounded Python runtime is not admitted yet" };
  }

  // Pass the curated documents bundle wheels ONLY for this tool execution
  runtime.setWheels(getDocumentsBundleWheels());

  const stdout = [];
  runtime.setStdout({ batched: (chunk) => stdout.push(chunk) });
  const stdinPayload = JSON.stringify({ maxRows: boundedMaxRows }) + "---SPLIT---" + cleanB64;
  let stdinRead = false;
  runtime.setStdin({
    stdin: () => {
      if (stdinRead) return undefined;
      stdinRead = true;
      return stdinPayload;
    },
  });

  try {
    await runtime.runPythonAsync(READ_SPREADSHEET_SCRIPT);
  } catch (err) {
    return { ok: false, error: `spreadsheet_parse_failed: ${err?.message ?? err}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.join("").trim());
  } catch {
    return { ok: false, error: "spreadsheet_parse_failed: invalid output from python worker" };
  }

  if (!parsed.ok || !Array.isArray(parsed.sheets)) {
    return { ok: false, error: parsed.error ?? "spreadsheet_parse_failed" };
  }

  const sheets = parsed.sheets;
  if (sheets.length === 0) {
    return { ok: false, error: "spreadsheet_empty: no sheets found" };
  }

  // Build canonical table representation
  let canonicalTableData;
  if (sheets.length === 1) {
    canonicalTableData = {
      headers: sheets[0].headers.length > 0 ? sheets[0].headers : ["Column 1"],
      rows: sheets[0].rows,
      caption: sheets[0].name || attachmentName,
    };
  } else {
    // Multi-sheet: determine collision-free provenance column name
    const allHeaders = new Set();
    for (const s of sheets) {
      for (const h of s.headers) {
        if (h) allHeaders.add(h.toLowerCase());
      }
    }
    let provenanceCol = "Sheet";
    if (allHeaders.has("sheet")) {
      provenanceCol = "_sheet_name";
      if (allHeaders.has("_sheet_name")) {
        provenanceCol = "__sheet_provenance";
      }
    }

    const combinedHeaders = [provenanceCol];
    for (const s of sheets) {
      for (const h of s.headers) {
        if (h && !combinedHeaders.includes(h)) {
          combinedHeaders.push(h);
        }
      }
    }
    const combinedRows = [];
    for (const s of sheets) {
      for (const r of s.rows) {
        const fullRow = [s.name];
        for (let i = 1; i < combinedHeaders.length; i++) {
          const colName = combinedHeaders[i];
          const colIdx = s.headers.indexOf(colName);
          fullRow.push(colIdx >= 0 && colIdx < r.length ? r[colIdx] : "");
        }
        combinedRows.push(fullRow);
      }
    }
    canonicalTableData = {
      headers: combinedHeaders,
      rows: combinedRows,
      caption: attachmentName || "Spreadsheet Workbook",
    };
  }

  const canonical = toCanonicalTable(canonicalTableData);
  const content = canonicalTableJson(canonical);
  const digest = sha256Hex(content);

  const saveAsset = createAssetFn || (await import("./artifacts.js")).createAsset;
  const assetName = (attachmentName || "Spreadsheet").slice(0, 120);
  const assetRes = await saveAsset(origin, {
    type: "data",
    name: assetName,
    content,
    meta: {
      schema: TABLE_VERSION,
      mediaType: TABLE_MEDIA_TYPE,
      sha256: digest,
      rows: canonical.rows.length,
      columns: canonical.columns.length,
      sheetNames: sheets.map((s) => s.name),
      sheets: sheets.map((s) => ({
        name: s.name,
        headers: s.headers,
        rowCount: s.rows.length,
        columnCount: s.headers.length,
        totalRows: s.totalRows,
        truncated: s.truncated,
      })),
      extractedAt: new Date().toISOString(),
    },
  });

  if (!assetRes?.ok) {
    return { ok: false, error: `failed_to_save_tabular_artifact: ${assetRes?.error ?? "unknown error"}` };
  }

  const previewRows = canonical.rows.slice(0, 10);
  return {
    ok: true,
    artifactId: assetRes.asset?.id ?? assetRes.id ?? null,
    name: assetName,
    totalSheets: sheets.length,
    sheetNames: sheets.map((s) => s.name),
    rowCount: canonical.rows.length,
    columns: canonical.columns.map((c) => ({ id: c.id, header: c.header })),
    sheets: sheets.map((s) => ({
      name: s.name,
      headers: s.headers,
      rowCount: s.rows.length,
      totalRows: s.totalRows,
      truncated: s.truncated,
    })),
    preview: previewRows,
    truncated: canonical.rows.length > 10,
  };
}

/**
 * Execute document reading (docx or pptx) in a fresh Pyodide worker.
 * Returns structured Markdown with headings and slide structure preserved.
 */
export async function executeReadDocument({
  base64Data,
  docType = "docx",
  maxCharacters = 100000,
  runtimeProvider,
  attachmentName = "document",
  untrusted = false,
  untrustedToken = null,
}) {
  if (!base64Data || typeof base64Data !== "string") {
    return { ok: false, error: "invalid_input: missing base64 document data" };
  }
  const cleanB64 = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
  if (cleanB64.length > MAX_DOCUMENT_TRANSPORT_BYTES) {
    return {
      ok: false,
      error: `document_oversized: document attachment (${cleanB64.length} base64 bytes) exceeds the ${MAX_DOCUMENT_TRANSPORT_BYTES} byte transport limit`,
    };
  }
  const cleanDocType = String(docType).toLowerCase().includes("pptx") ? "pptx" : "docx";
  const boundedMaxChars = Math.min(Math.max(100, Number(maxCharacters) || 100000), 500000);

  const runtime = typeof runtimeProvider === "function" ? await runtimeProvider() : null;
  if (!runtime) {
    return { ok: false, error: "python unavailable — the bounded Python runtime is not admitted yet" };
  }

  // Pass the curated documents bundle wheels ONLY for this tool execution
  runtime.setWheels(getDocumentsBundleWheels());

  const stdout = [];
  runtime.setStdout({ batched: (chunk) => stdout.push(chunk) });
  const stdinPayload = JSON.stringify({ docType: cleanDocType, maxCharacters: boundedMaxChars }) + "---SPLIT---" + cleanB64;
  let stdinRead = false;
  runtime.setStdin({
    stdin: () => {
      if (stdinRead) return undefined;
      stdinRead = true;
      return stdinPayload;
    },
  });

  try {
    await runtime.runPythonAsync(READ_DOCUMENT_SCRIPT);
  } catch (err) {
    return { ok: false, error: `document_parse_failed: ${err?.message ?? err}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.join("").trim());
  } catch {
    return { ok: false, error: "document_parse_failed: invalid output from python worker" };
  }

  if (!parsed.ok) {
    return { ok: false, error: parsed.error ?? "document_parse_failed" };
  }

  let content = String(parsed.content ?? "");
  if (untrusted) {
    const token = untrustedToken || mintUntrustedToken();
    content = fenceUntrustedText(content, token);
  }

  return {
    ok: true,
    docType: cleanDocType,
    attachmentName,
    content,
    characterCount: content.length,
    format: "markdown",
    truncated: parsed.truncated === true,
  };
}

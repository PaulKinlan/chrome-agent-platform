// lib/python-documents-bundle.js — CAP's own bounded OOXML text/table readers.
// Part of chrome-agent-platform-3p3e.11; these are NOT upstream Office packages.
// The deterministic local wheels are pinned for build integrity only, not upstream
// provenance. Their deliberately limited format support must fail closed when a
// document cannot be read completely. Model-authored python.execute runs NEVER
// receive these modules (isolation guard).

import { sha256Hex, createSha256 } from "./pure.js";
import { validatePurePythonWheel } from "./python-wheel-validator.js";
import { TABLE_LIMITS, TABLE_VERSION, TABLE_MEDIA_TYPE, canonicalTableJson } from "./table-core.js";
import { toCanonicalTable, createTabularArtifact } from "./table-extractor.js";
import { fenceUntrustedText, mintUntrustedToken } from "./untrusted-fence.js";

// Local generated-wheel integrity pins; never represent upstream package hashes.
export const DOCUMENTS_BUNDLE_PINS = Object.freeze({
  "cap_xlsx_reader-0.1.0-py3-none-any.whl": Object.freeze({
    name: "cap_xlsx_reader-0.1.0-py3-none-any.whl",
    sha256: "83107a8465f126cef8d2b2c9951d81b06aae14775ec9b9545092061ab0533e2f",
    bytes: 12719,
  }),
  "cap_docx_reader-0.1.0-py3-none-any.whl": Object.freeze({
    name: "cap_docx_reader-0.1.0-py3-none-any.whl",
    sha256: "78b729206a5496b7808c2f10916430a026ce573db900bc307191557ac5168002",
    bytes: 6773,
  }),
  "cap_pptx_reader-0.1.0-py3-none-any.whl": Object.freeze({
    name: "cap_pptx_reader-0.1.0-py3-none-any.whl",
    sha256: "80cd1d1fd1c54d0a16d194cba815274208bb44cca32fec1f7870ef9fca8c5574",
    bytes: 7629,
  }),
});

export const MAX_DOCUMENT_TRANSPORT_BYTES = 256 * 1024;

// Pyodide's stdin bridge consumes bounded chunks. Supplying a whole compressed
// document in one callback can truncate the base64 payload at its internal
// buffer boundary, well below this tool's advertised transport ceiling.
function setDocumentStdin(runtime, payload) {
  let offset = 0;
  runtime.setStdin({
    stdin: () => {
      if (offset >= payload.length) return undefined;
      const chunk = payload.slice(offset, offset + 4096);
      offset += chunk.length;
      return chunk;
    },
  });
}

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

const CAP_XLSX_MODULE_PY = `
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

    @property
    def max_row(self):
        return len(self._rows)

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
MAX_TOTAL_ZIP_BYTES = 12 * 1024 * 1024
MAX_ZIP_MEMBERS = 256
MAX_TOTAL_OUTPUT_CHARS = 2 * 1024 * 1024
MAX_TOTAL_GRID_CELLS = 100000

def _zip_budget(z):
    infos = z.infolist()
    if len(infos) > MAX_ZIP_MEMBERS:
        raise ValueError("document_incomplete: too many ZIP members")
    total = 0
    for info in infos:
        if info.file_size > MAX_ZIP_MEMBER_BYTES:
            raise ValueError("document_incomplete: ZIP member exceeds the 10 MiB limit")
        total += info.file_size
        if total > MAX_TOTAL_ZIP_BYTES:
            raise ValueError("document_incomplete: total uncompressed ZIP content exceeds 12 MiB")
    return {"read": 0}

def _read_part(z, name, budget):
    chunks = []
    size = 0
    with z.open(name) as source:
        while True:
            chunk = source.read(16 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_ZIP_MEMBER_BYTES or budget["read"] + size > MAX_TOTAL_ZIP_BYTES:
                raise ValueError("document_incomplete: total uncompressed ZIP content exceeds the reader budget")
            chunks.append(chunk)
    budget["read"] += size
    return b"".join(chunks)

def load_workbook(filename_or_fp, data_only=True):
    if isinstance(filename_or_fp, (bytes, bytearray)):
        fp = io.BytesIO(filename_or_fp)
    elif hasattr(filename_or_fp, "read"):
        fp = filename_or_fp
    else:
        fp = open(filename_or_fp, "rb")

    with zipfile.ZipFile(fp, "r") as z:
        budget = _zip_budget(z)  # Refuse aggregate inflation before reading any XML.
        names = z.namelist()
        if len(set(names)) != len(names):
            raise ValueError("document_incomplete: duplicate spreadsheet ZIP members")
        metadata = {"[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "docProps/custom.xml"}
        if any(n not in metadata and not n.startswith("xl/") for n in names):
            raise ValueError("document_incomplete: unsupported spreadsheet package root")
        if "xl/workbook.xml" not in names:
            raise ValueError("document_incomplete: workbook manifest is missing")
        if any(n.startswith(("xl/drawings/", "xl/charts/", "xl/media/", "xl/embeddings/", "xl/externalLinks/")) for n in names):
            raise ValueError("document_incomplete: unsupported spreadsheet drawing or linked content")
        shared_strings = []
        if "xl/sharedStrings.xml" in z.namelist():
            info = z.getinfo("xl/sharedStrings.xml")
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise ValueError("document_incomplete: shared strings exceed the 10 MiB member limit")
            tree = ET.fromstring(_read_part(z, "xl/sharedStrings.xml", budget))
            for si in tree.findall("{*}si"):
                t = si.find("{*}t")
                if t is not None and t.text:
                    shared_strings.append(t.text)
                else:
                    texts = [elem.text for elem in si.findall(".//{*}t") if elem.text]
                    shared_strings.append("".join(texts))

        sheet_map = []
        if "xl/workbook.xml" in z.namelist():
            wb_tree = ET.fromstring(_read_part(z, "xl/workbook.xml", budget))
            sheets_elem = wb_tree.find("{*}sheets")
            if sheets_elem is not None:
                rels = {}
                if "xl/_rels/workbook.xml.rels" in z.namelist():
                    rels_tree = ET.fromstring(_read_part(z, "xl/_rels/workbook.xml.rels", budget))
                    for rel in rels_tree.findall("{*}Relationship"):
                        kind = rel.attrib.get("Type", "").split("/")[-1]
                        if rel.attrib.get("TargetMode", "Internal") != "Internal" or kind not in ("worksheet", "sharedStrings", "styles", "theme"):
                            raise ValueError("document_incomplete: unsupported workbook relationship")
                        if kind == "worksheet":
                            rels[rel.attrib.get("Id")] = rel.attrib.get("Target")
                for sheet in sheets_elem.findall("{*}sheet"):
                    name = sheet.attrib.get("name", "Sheet")
                    r_id = sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                    target = rels.get(r_id, "")
                    if target.startswith("/"):
                        target = target.lstrip("/")
                    elif target and not target.startswith("xl/"):
                        target = "xl/" + target
                    if not target.startswith("xl/worksheets/"):
                        raise ValueError("document_incomplete: unresolved or unsupported worksheet relationship")
                    sheet_map.append((name, target))

        if not sheet_map:
            raise ValueError("document_incomplete: workbook has no declared worksheets")
        allowed = {"xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml"}
        allowed.update(target for _name, target in sheet_map)
        if any(n.startswith("xl/") and n not in allowed and not n.startswith("xl/theme/") for n in names):
            raise ValueError("document_incomplete: unsupported spreadsheet package part")

        sheets = {}
        total_output_chars = 0
        total_grid_cells = 0
        for sheet_name, target in sheet_map:
            if target not in z.namelist():
                raise ValueError("document_incomplete: declared worksheet is missing")
            info = z.getinfo(target)
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise ValueError("document_incomplete: worksheet exceeds the 10 MiB member limit")
            if sheet_name in sheets:
                raise ValueError("document_incomplete: duplicate worksheet name")
            stree = ET.fromstring(_read_part(z, target, budget))
            if any(el.tag.split("}")[-1] in ("drawing", "tableParts", "pivotTable", "oleObjects", "extLst") for el in stree.iter()):
                raise ValueError("document_incomplete: unsupported worksheet content")
            rows_dict = {}
            max_col = 0
            max_row = 0
            sheet_data = stree.find("{*}sheetData")
            if sheet_data is not None:
                for row_el in sheet_data.findall("{*}row"):
                    r_idx = int(row_el.attrib.get("r", 0)) - 1
                    if r_idx < 0 or r_idx >= MAX_PARSE_ROWS:
                        raise ValueError("document_incomplete: worksheet row exceeds the 5000-row limit")
                    next_col = 0
                    for c_el in row_el.findall("{*}c"):
                        c_ref = c_el.attrib.get("r")
                        if c_ref:
                            try:
                                c_idx, cell_row = _parse_cell_ref(c_ref)
                            except (TypeError, ValueError):
                                raise ValueError("document_incomplete: invalid cell reference")
                            if cell_row != r_idx or c_idx < next_col:
                                raise ValueError("document_incomplete: mismatched or duplicate cell reference")
                        else:
                            c_idx = next_col  # The r attribute is optional: infer the next column.
                        if c_idx < 0 or c_idx >= MAX_PARSE_COLS:
                            raise ValueError("document_incomplete: worksheet column exceeds the 100-column limit")
                        next_col = c_idx + 1
                        t_type = c_el.attrib.get("t")
                        if c_el.attrib.get("s") is not None:
                            raise ValueError("document_incomplete: styled cells require unsupported date or number formatting")
                        if c_el.find("{*}f") is not None or t_type not in (None, "n", "s", "b", "inlineStr", "str"):
                            raise ValueError("document_incomplete: unsupported formula or cell type")
                        v_el = c_el.find("{*}v")
                        val = v_el.text if v_el is not None else None
                        if t_type == "s" and val is not None and val.isdigit():
                            idx = int(val)
                            if idx >= len(shared_strings):
                                raise ValueError("document_incomplete: shared string index is missing")
                            val = shared_strings[idx]
                        elif t_type == "b" and val is not None:
                            val = True if val == "1" else False
                        elif t_type == "inlineStr":
                            is_el = c_el.find("{*}is")
                            if is_el is None:
                                raise ValueError("document_incomplete: inline string content is missing")
                            # Both direct <t> and ordered rich-text <r><t> runs carry data.
                            val = "".join(t.text or "" for t in is_el.findall(".//{*}t"))
                        elif val is not None:
                            try:
                                if "." in val:
                                    val = float(val)
                                else:
                                    val = int(val)
                            except ValueError:
                                pass
                        if val is not None:
                            total_output_chars += len(str(val))
                            if total_output_chars > MAX_TOTAL_OUTPUT_CHARS:
                                raise ValueError("document_incomplete: total spreadsheet text exceeds 2 MiB")
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
                total_grid_cells += bound_row * bound_col
                if total_grid_cells > MAX_TOTAL_GRID_CELLS:
                    raise ValueError("document_incomplete: total spreadsheet grid exceeds 100000 cells")
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

MAX_PART_BYTES = 10 * 1024 * 1024
MAX_PACKAGE_BYTES = 12 * 1024 * 1024

def _budget(z):
    infos = z.infolist()
    if len(infos) > 256 or any(i.file_size > MAX_PART_BYTES for i in infos):
        raise ValueError("document_incomplete: DOCX ZIP member limit exceeded")
    if sum(i.file_size for i in infos) > MAX_PACKAGE_BYTES:
        raise ValueError("document_incomplete: total uncompressed DOCX content exceeds 12 MiB")
    return {"read": 0}

def _read_part(z, name, budget):
    chunks = []
    size = 0
    with z.open(name) as source:
        while True:
            chunk = source.read(16 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_PART_BYTES or budget["read"] + size > MAX_PACKAGE_BYTES:
                raise ValueError("document_incomplete: total uncompressed DOCX content exceeds the reader budget")
            chunks.append(chunk)
    budget["read"] += size
    return b"".join(chunks)

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
            budget = _budget(z)
            names = z.namelist()
            if len(set(names)) != len(names):
                raise ValueError("document_incomplete: duplicate DOCX ZIP members")
            metadata = {"[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "docProps/custom.xml"}
            if any(n not in metadata and not n.startswith("word/") for n in names):
                raise ValueError("document_incomplete: unsupported DOCX package root")
            if any(n.startswith(("word/media/", "word/embeddings/", "word/charts/", "word/drawings/", "word/headers/", "word/footers/")) or n in ("word/comments.xml", "word/footnotes.xml", "word/endnotes.xml") for n in names):
                raise ValueError("document_incomplete: unsupported DOCX attachment or annotation")
            allowed = {"word/document.xml", "word/styles.xml", "word/settings.xml", "word/webSettings.xml", "word/fontTable.xml", "word/numbering.xml", "word/_rels/document.xml.rels"}
            if any(n.startswith("word/") and n not in allowed and not n.startswith("word/theme/") for n in names):
                raise ValueError("document_incomplete: unsupported DOCX package part")
            if "word/_rels/document.xml.rels" in names:
                rels = ET.fromstring(_read_part(z, "word/_rels/document.xml.rels", budget))
                for rel in rels.findall("{*}Relationship"):
                    kind = rel.attrib.get("Type", "").split("/")[-1]
                    if rel.attrib.get("TargetMode", "Internal") != "Internal" or kind not in ("styles", "settings", "webSettings", "fontTable", "numbering", "theme"):
                        raise ValueError("document_incomplete: unsupported DOCX relationship")
            if "word/document.xml" not in names:
                raise ValueError("document_incomplete: DOCX body is missing")
            if z.getinfo("word/document.xml").file_size > 10 * 1024 * 1024:
                raise ValueError("document_incomplete: DOCX body exceeds the 10 MiB member limit")
            tree = ET.fromstring(_read_part(z, "word/document.xml", budget))
            body = tree.find("{*}body")
            if body is None:
                raise ValueError("document_incomplete: DOCX body is missing")

            for child in body:
                tag = child.tag.split("}")[-1]
                if tag == "p":
                    if any(el.tag.split("}")[-1] in ("drawing", "object", "pict", "fldChar", "instrText", "del", "ins", "sdt") for el in child.iter()):
                        raise ValueError("document_incomplete: unsupported DOCX paragraph content")
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
                            if any(el.tag.split("}")[-1] in ("tbl", "drawing", "object", "pict", "altChunk") for el in tc.iter() if el is not tc):
                                raise ValueError("document_incomplete: unsupported DOCX table content")
                            c_texts = [t.text for t in tc.findall(".//{*}t") if t.text]
                            row_cells.append(Cell("".join(c_texts).strip()))
                        tbl_rows.append(Row(row_cells))
                    table = Table(tbl_rows)
                    self.tables.append(table)
                    self.elements.append(table)
                elif tag != "sectPr":
                    raise ValueError("document_incomplete: unsupported DOCX body content")
`;

const PPTX_MODULE_PY = `
import zipfile
import xml.etree.ElementTree as ET
import io

MAX_PART_BYTES = 10 * 1024 * 1024
MAX_PACKAGE_BYTES = 12 * 1024 * 1024

def _budget(z):
    infos = z.infolist()
    if len(infos) > 256 or any(i.file_size > MAX_PART_BYTES for i in infos):
        raise ValueError("document_incomplete: PPTX ZIP member limit exceeded")
    if sum(i.file_size for i in infos) > MAX_PACKAGE_BYTES:
        raise ValueError("document_incomplete: total uncompressed PPTX content exceeds 12 MiB")
    return {"read": 0}

def _read_part(z, name, budget):
    chunks = []
    size = 0
    with z.open(name) as source:
        while True:
            chunk = source.read(16 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_PART_BYTES or budget["read"] + size > MAX_PACKAGE_BYTES:
                raise ValueError("document_incomplete: total uncompressed PPTX content exceeds the reader budget")
            chunks.append(chunk)
    budget["read"] += size
    return b"".join(chunks)

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
            budget = _budget(z)
            names = z.namelist()
            if len(set(names)) != len(names):
                raise ValueError("document_incomplete: duplicate PPTX ZIP members")
            metadata = {"[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "docProps/custom.xml"}
            if any(n not in metadata and not n.startswith("ppt/") for n in names):
                raise ValueError("document_incomplete: unsupported presentation package root")
            if any(n.startswith(("ppt/media/", "ppt/embeddings/", "ppt/charts/", "ppt/notesSlides/")) for n in names):
                raise ValueError("document_incomplete: unsupported slide media, notes or embedded content")
            allowed = {"ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "ppt/presProps.xml", "ppt/viewProps.xml", "ppt/tableStyles.xml"}
            if any(n.startswith("ppt/") and n not in allowed and not n.startswith(("ppt/theme/", "ppt/slideMasters/", "ppt/slideLayouts/")) and not (n.startswith("ppt/slides/slide") and n.endswith(".xml")) for n in names):
                raise ValueError("document_incomplete: unsupported presentation package part")
            slide_files = [f for f in names if f.startswith("ppt/slides/slide") and f.endswith(".xml")]
            if not slide_files:
                raise ValueError("document_incomplete: presentation has no readable slides")
            def sort_key(s):
                num = "".join(filter(str.isdigit, s.split("/")[-1]))
                return int(num) if num else 0
            slide_files.sort(key=sort_key)
            if "ppt/presentation.xml" in names:
                if "ppt/_rels/presentation.xml.rels" not in names:
                    raise ValueError("document_incomplete: presentation slide relationships are missing")
                if z.getinfo("ppt/presentation.xml").file_size > 10 * 1024 * 1024 or z.getinfo("ppt/_rels/presentation.xml.rels").file_size > 10 * 1024 * 1024:
                    raise ValueError("document_incomplete: presentation manifest exceeds the 10 MiB member limit")
                presentation = ET.fromstring(_read_part(z, "ppt/presentation.xml", budget))
                slide_ids = presentation.find("{*}sldIdLst")
                rels_tree = ET.fromstring(_read_part(z, "ppt/_rels/presentation.xml.rels", budget))
                rels = {}
                for rel in rels_tree.findall("{*}Relationship"):
                    kind = rel.attrib.get("Type", "").split("/")[-1]
                    if rel.attrib.get("TargetMode", "Internal") != "Internal" or kind not in ("slide", "slideMaster", "presProps", "viewProps", "tableStyles", "theme"):
                        raise ValueError("document_incomplete: unsupported presentation relationship")
                    if kind == "slide":
                        target = rel.attrib.get("Target", "")
                        if target.startswith("/"):
                            target = target.lstrip("/")
                        elif target and not target.startswith("ppt/"):
                            target = "ppt/" + target
                        rels[rel.attrib.get("Id")] = target
                ordered = []
                for slide_id in slide_ids if slide_ids is not None else []:
                    rid = slide_id.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                    target = rels.get(rid)
                    if target not in slide_files or target in ordered:
                        raise ValueError("document_incomplete: unresolved or duplicate presentation slide")
                    ordered.append(target)
                if len(ordered) != len(slide_files):
                    raise ValueError("document_incomplete: presentation omits a slide")
                slide_files = ordered
            elif "ppt/_rels/presentation.xml.rels" in names:
                raise ValueError("document_incomplete: presentation manifest is missing")

            for idx, sf in enumerate(slide_files, 1):
                if z.getinfo(sf).file_size > 10 * 1024 * 1024:
                    raise ValueError("document_incomplete: slide exceeds the 10 MiB member limit")
                stree = ET.fromstring(_read_part(z, sf, budget))
                shape_tree = stree.find(".//{*}spTree")
                if shape_tree is None:
                    raise ValueError("document_incomplete: slide shape tree is missing")
                if any(el.tag.split("}")[-1] not in ("sp", "nvGrpSpPr", "grpSpPr") for el in shape_tree):
                    raise ValueError("document_incomplete: unsupported slide picture, group or chart")
                shapes = []
                title = ""
                for sp in shape_tree.findall("{*}sp"):
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

  const xlsxBytes = makeDeterministicZip([
    { name: "cap_xlsx_reader/__init__.py", content: CAP_XLSX_MODULE_PY },
    { name: "cap_xlsx_reader-0.1.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: "cap_xlsx_reader-0.1.0.dist-info/METADATA", content: "Metadata-Version: 2.1\nName: cap-xlsx-reader\nVersion: 0.1.0\n" },
  ]);

  const docxBytes = makeDeterministicZip([
    { name: "cap_docx_reader/__init__.py", content: DOCX_MODULE_PY },
    { name: "cap_docx_reader-0.1.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: "cap_docx_reader-0.1.0.dist-info/METADATA", content: "Metadata-Version: 2.1\nName: cap-docx-reader\nVersion: 0.1.0\n" },
  ]);

  const pptxBytes = makeDeterministicZip([
    { name: "cap_pptx_reader/__init__.py", content: PPTX_MODULE_PY },
    { name: "cap_pptx_reader-0.1.0.dist-info/WHEEL", content: "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n" },
    { name: "cap_pptx_reader-0.1.0.dist-info/METADATA", content: "Metadata-Version: 2.1\nName: cap-pptx-reader\nVersion: 0.1.0\n" },
  ]);

  cachedWheels = [
    { name: "cap_xlsx_reader-0.1.0-py3-none-any.whl", bytes: xlsxBytes },
    { name: "cap_docx_reader-0.1.0-py3-none-any.whl", bytes: docxBytes },
    { name: "cap_pptx_reader-0.1.0-py3-none-any.whl", bytes: pptxBytes },
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
    // Hash the actual wheel bytes, not sha256Hex's String(Uint8Array) coercion.
    const digest = createSha256().update(w.bytes).hex();
    if (digest !== pin.sha256) {
      throw new Error(`documents_bundle: sha256 mismatch for '${w.name}' (got ${digest}, expected ${pin.sha256})`);
    }
  }
  return { ok: true, verifiedCount: wheels.length };
}

function admitDocumentWheels(runtime) {
  try {
    verifyDocumentsBundle();
  } catch {
    // Never put altered reader bytes in the Python worker. Do not claim these
    // local integrity hashes attest upstream provenance.
    return { ok: false, error: "documents_bundle_integrity_failed: local reader wheel changed" };
  }
  runtime.setWheels(getDocumentsBundleWheels());
  return null;
}

// FIXED, reviewed Python scripts (zero model-authored code)
export const READ_SPREADSHEET_SCRIPT = `
import sys
import json
import base64
import cap_xlsx_reader

# Emscripten's stdin bridge is bounded; read until EOF rather than one call.
raw_chunks = []
while True:
    chunk = sys.stdin.read(2048)
    if not chunk:
        break
    raw_chunks.append(chunk)
raw_data = "".join(raw_chunks).strip()
meta_json, b64_bytes = raw_data.split("---SPLIT---", 1)
meta = json.loads(meta_json)
max_rows = min(int(meta.get("maxRows", 1000)), 5000)

doc_bytes = base64.b64decode(b64_bytes)
wb = cap_xlsx_reader.load_workbook(doc_bytes, data_only=True)

result_sheets = []
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    sheet_rows = list(ws.iter_rows(max_row=max_rows + 1, values_only=True))
    headers = []
    rows = []
    if sheet_rows:
        headers = [str(c) if c is not None else "" for c in sheet_rows[0]]
        explicit = [h.casefold() for h in headers if h]
        if len(explicit) != len(set(explicit)):
            raise ValueError("document_incomplete: duplicate worksheet column headers")
        used = set(explicit)
        for i, header in enumerate(headers):
            if not header:
                # Do not drop a data-bearing column merely because row one is blank.
                name = "Column " + str(i + 1)
                while name.casefold() in used:
                    name += "_"
                headers[i] = name
                used.add(name.casefold())
        for r in sheet_rows[1:max_rows + 1]:
            rows.append([str(c) if c is not None else "" for c in r])
    result_sheets.append({
        "name": sheet_name,
        "headers": headers,
        "rows": rows,
        "totalRows": ws.max_row,
        "truncated": ws.max_row > max_rows + 1
    })

print(json.dumps({"ok": True, "sheets": result_sheets}))
`;

export const READ_DOCUMENT_SCRIPT = `
import sys
import json
import base64

raw_chunks = []
while True:
    chunk = sys.stdin.read(2048)
    if not chunk:
        break
    raw_chunks.append(chunk)
raw_data = "".join(raw_chunks).strip()
meta_json, b64_bytes = raw_data.split("---SPLIT---", 1)
meta = json.loads(meta_json)
doc_type = meta.get("docType", "docx")
max_chars = meta.get("maxCharacters", 100000)

doc_bytes = base64.b64decode(b64_bytes)

md_lines = []
if doc_type == "docx":
    import cap_docx_reader
    doc = cap_docx_reader.Document(doc_bytes)
    elements = getattr(doc, "elements", None) or doc.paragraphs
    for el in elements:
        if isinstance(el, cap_docx_reader.Paragraph):
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
        elif isinstance(el, cap_docx_reader.Table):
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
    import cap_pptx_reader
    prs = cap_pptx_reader.Presentation(doc_bytes)
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
if len(content) > max_chars:
    print(json.dumps({"ok": False, "incomplete": True, "error": "document_incomplete: extracted document exceeds maxCharacters"}))
else:
    print(json.dumps({"ok": True, "content": content, "characterCount": len(content), "truncated": False}))
`;

/**
 * Execute CAP's bounded XLSX reader in a fresh Pyodide worker.
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

  // Admit CAP-owned reader bytes only for this fixed tool execution.
  const wheelError = admitDocumentWheels(runtime);
  if (wheelError) return wheelError;

  const stdout = [];
  runtime.setStdout({ batched: (chunk) => stdout.push(chunk) });
  const stdinPayload = JSON.stringify({ maxRows: boundedMaxRows }) + "---SPLIT---" + cleanB64;
  if (stdinPayload.length > MAX_DOCUMENT_TRANSPORT_BYTES) {
    return { ok: false, error: "document_oversized: encoded spreadsheet request exceeds the 256 KiB worker frame" };
  }
  setDocumentStdin(runtime, stdinPayload);

  try {
    await runtime.runPythonAsync(READ_SPREADSHEET_SCRIPT);
  } catch (err) {
    const message = String(err?.message ?? err);
    const incomplete = message.match(/document_incomplete: ([^\n]+)/);
    if (incomplete) return { ok: false, incomplete: true, error: `document_incomplete: ${incomplete[1]}` };
    return { ok: false, error: `spreadsheet_parse_failed: ${message}` };
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
    return { ok: false, incomplete: true, error: "document_incomplete: no worksheets could be read" };
  }
  if (sheets.some((sheet) => sheet.truncated)) {
    return { ok: false, incomplete: true, error: "document_incomplete: worksheet exceeds the requested maxRows limit" };
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
    incomplete: false,
    previewTruncated: canonical.rows.length > 10,
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

  // Admit CAP-owned reader bytes only for this fixed tool execution.
  const wheelError = admitDocumentWheels(runtime);
  if (wheelError) return wheelError;

  const stdout = [];
  runtime.setStdout({ batched: (chunk) => stdout.push(chunk) });
  const stdinPayload = JSON.stringify({ docType: cleanDocType, maxCharacters: boundedMaxChars }) + "---SPLIT---" + cleanB64;
  if (stdinPayload.length > MAX_DOCUMENT_TRANSPORT_BYTES) {
    return { ok: false, error: "document_oversized: encoded document request exceeds the 256 KiB worker frame" };
  }
  setDocumentStdin(runtime, stdinPayload);

  try {
    await runtime.runPythonAsync(READ_DOCUMENT_SCRIPT);
  } catch (err) {
    const message = String(err?.message ?? err);
    const incomplete = message.match(/document_incomplete: ([^\n]+)/);
    if (incomplete) return { ok: false, incomplete: true, error: `document_incomplete: ${incomplete[1]}` };
    return { ok: false, error: `document_parse_failed: ${message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.join("").trim());
  } catch {
    return { ok: false, error: "document_parse_failed: invalid output from python worker" };
  }

  if (!parsed.ok) {
    return { ok: false, incomplete: parsed.incomplete === true, error: parsed.error ?? "document_parse_failed" };
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

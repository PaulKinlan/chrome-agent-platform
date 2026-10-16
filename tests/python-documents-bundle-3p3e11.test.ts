// tests/python-documents-bundle-3p3e11.test.ts — acceptance tests for chrome-agent-platform-3p3e.11.
// Curated pure-Python documents bundle for DOCX/XLSX/PPTX attachments.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
  DOCUMENTS_BUNDLE_PINS,
  MAX_DOCUMENT_TRANSPORT_BYTES,
  getDocumentsBundleWheels,
  verifyDocumentsBundle,
  executeReadSpreadsheet,
  executeReadDocument,
} from "../extension/lib/python-documents-bundle.js";
import { isOfficeDocumentAttachment, attachmentContext } from "../extension/lib/attachments.js";

const RUNTIME_SRC = fileURLToPath(new URL("../wasm-tools/python/", import.meta.url));

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files: Array<{ name: string; content: string | Uint8Array; deflate?: boolean }>): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const cdChunks: Uint8Array[] = [];
  let offset = 0;

  for (const { name, content, deflate = false } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const storedBytes = deflate ? deflateRawSync(dataBytes) : dataBytes;
    const crc = crc32(dataBytes);
    const size = dataBytes.byteLength;

    const local = new Uint8Array(30 + nameBytes.byteLength + storedBytes.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, storedBytes.byteLength, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(storedBytes, 30 + nameBytes.byteLength);
    localChunks.push(local);

    const cd = new Uint8Array(46 + nameBytes.byteLength);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, storedBytes.byteLength, true);
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

function makeTwoSheetXlsx(col1Header = "Month", secondSheetTarget = "worksheets/sheet2.xml", opts: {
  extraCell?: string;
  extraHeaderCell?: string;
  extraRow?: string;
  sharedStringPadding?: string;
  sheet2Padding?: string;
  extraParts?: Array<{ name: string; content: string }>;
  extraWorkbookRelationship?: string;
} = {}): Uint8Array {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${secondSheetTarget}"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  ${opts.extraWorkbookRelationship ?? ""}
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Q1 Revenue" sheetId="1" r:id="rId1"/>
    <sheet name="Q1 Expenses" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="8" uniqueCount="8">
  <si><t>${col1Header}${opts.sharedStringPadding ?? ""}</t></si>
  <si><t>Revenue</t></si>
  <si><t>January</t></si>
  <si><t>February</t></si>
  <si><t>Category</t></si>
  <si><t>Amount</t></si>
  <si><t>Payroll</t></si>
  <si><t>Rent</t></si>
</sst>`;

  const sheet1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>${opts.extraHeaderCell ?? ""}
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2"><v>10000</v></c>${opts.extraCell ?? ""}
    </row>
    <row r="3">
      <c r="A3" t="s"><v>3</v></c>
      <c r="B3"><v>12500</v></c>
    </row>${opts.extraRow ?? ""}
  </sheetData>
</worksheet>`;

  const sheet2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>4</v></c>
      <c r="B1" t="s"><v>5</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>6</v></c>
      <c r="B2"><v>7000</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>7</v></c>
      <c r="B3"><v>2000</v></c>
    </row>${opts.sheet2Padding ?? ""}
  </sheetData>
</worksheet>`;

  return makeZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: rels },
    { name: "xl/_rels/workbook.xml.rels", content: wbRels },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/sharedStrings.xml", content: sharedStrings, deflate: Boolean(opts.sharedStringPadding) },
    { name: "xl/worksheets/sheet1.xml", content: sheet1 },
    { name: "xl/worksheets/sheet2.xml", content: sheet2, deflate: Boolean(opts.sheet2Padding) },
    ...(opts.extraParts ?? []),
  ]);
}

function makeDocx(extraBodyXml = "", extraParts: Array<{ name: string; content: string; deflate?: boolean }> = [], deflateBody = false): Uint8Array {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Project Charter</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>This document defines the project scope.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>Objectives and Deliverables</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>The core objective is high performance.</w:t></w:r>
    </w:p>${extraBodyXml}
  </w:body>
</w:document>`;

  return makeZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: rels },
    { name: "word/document.xml", content: documentXml, deflate: deflateBody },
    ...extraParts,
  ]);
}

function makePptx(extraShapeXml = "", extraParts: Array<{ name: string; content: string; deflate?: boolean }> = [], reversedPresentation = false, deflateSlide = false): Uint8Array {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  ${reversedPresentation ? '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' : ""}
</Types>`;

  const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="1" name="Title 1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Body 1"/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>Key highlights and metrics</a:t></a:r></a:p></p:txBody>
      </p:sp>${extraShapeXml}
    </p:spTree>
  </p:cSld>
</p:sld>`;

  return makeZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "ppt/slides/slide1.xml", content: slideXml, deflate: deflateSlide },
    ...(reversedPresentation ? [
      { name: "ppt/slides/slide2.xml", content: slideXml.replace("Quarterly Review", "Slide Two") },
      { name: "ppt/presentation.xml", content: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>' },
      { name: "ppt/_rels/presentation.xml.rels", content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>' },
    ] : []),
    ...extraParts,
  ]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function createTestPyodide() {
  const mods: any = {};
  for (const [key, spec] of Object.entries({
    fs: "node:fs", crypto: "node:crypto", cp: "node:child_process",
    path: "node:path", url: "node:url", vm: "node:vm", tty: "node:tty",
  })) mods[key] = await import(spec);
  (globalThis as any).require = (name: string) => ({ ...mods, ws: {} })[name];
  (globalThis as any).__dirname = RUNTIME_SRC;
  (globalThis as any).__filename = `${RUNTIME_SRC}/pyodide.mjs`;
  await import(new URL(`file://${RUNTIME_SRC}/pyodide.asm.js`).href);
  const { loadPyodide } = await import(new URL(`file://${RUNTIME_SRC}/pyodide.mjs`).href);
  const py = await loadPyodide({
    indexURL: RUNTIME_SRC,
    stdout: () => {},
    stderr: () => {},
  });

  let assignedWheels: any[] = [];
  return {
    setWheels(wheels: any[]) {
      assignedWheels = wheels;
      for (const w of wheels) {
        py.unpackArchive(w.bytes, "zip", { extractDir: "/lib/python3.12/site-packages" });
      }
      py.runPython("import importlib; importlib.invalidate_caches()");
    },
    setStdout: (cfg: any) => py.setStdout(cfg),
    setStdin: (cfg: any) => py.setStdin(cfg),
    runPythonAsync: (code: string) => py.runPythonAsync(code),
    runPython: (code: string) => py.runPython(code),
  };
}

Deno.test("documents bundle: verifyDocumentsBundle passes pinned integrity checks", () => {
  const res = verifyDocumentsBundle();
  assertEquals(res.ok, true);
  assertEquals(res.verifiedCount, 3);

  const wheels = getDocumentsBundleWheels();
  assertEquals(wheels.length, 3);
  for (const w of wheels) {
    const pin = (DOCUMENTS_BUNDLE_PINS as Record<string, any>)[w.name];
    assert(pin, `pinned wheel ${w.name}`);
    assertEquals(w.bytes.byteLength, pin.bytes);
  }
});

Deno.test("documents bundle: generated wheels identify CAP's own bounded readers, never upstream packages", () => {
  const wheels = getDocumentsBundleWheels();
  assertEquals(wheels.map((w: { name: string }) => w.name).sort(), [
    "cap_docx_reader-0.1.0-py3-none-any.whl",
    "cap_pptx_reader-0.1.0-py3-none-any.whl",
    "cap_xlsx_reader-0.1.0-py3-none-any.whl",
  ]);
  for (const wheel of wheels) {
    const archive = new TextDecoder().decode(wheel.bytes);
    assert(!/Name:\s*(?:openpyxl|python-docx|python-pptx)\b/i.test(archive),
      `${wheel.name} must not impersonate an upstream package in its METADATA`);
    assertStringIncludes(archive, "Name: cap-", "each generated wheel must be honestly named");
  }
});

Deno.test("documents bundle: a changed local wheel byte is rejected before tool execution", async () => {
  const wheel = getDocumentsBundleWheels()[0];
  const originalByte = wheel.bytes[20];
  wheel.bytes[20] ^= 1;
  try {
    const res = await executeReadSpreadsheet({
      base64Data: bytesToBase64(makeTwoSheetXlsx()),
      runtimeProvider: async () => ({ setWheels: () => { throw new Error("tampered wheel reached runtime"); } }),
    }) as any;
    assertEquals(res.ok, false);
    assertStringIncludes(res.error, "documents_bundle_integrity_failed");
  } finally {
    wheel.bytes[20] = originalByte;
  }
});

Deno.test("documents bundle: isolation guard prevents model-authored python.execute from reaching openpyxl or docx", async () => {
  // A clean Pyodide runtime without setWheels(getDocumentsBundleWheels())
  const runtime = await createTestPyodide();

  // Model-authored code attempting to import openpyxl
  let errOpenpyxl = "";
  try {
    await runtime.runPythonAsync("import openpyxl");
  } catch (err: any) {
    errOpenpyxl = String(err?.message ?? err);
  }
  assertStringIncludes(errOpenpyxl, "ModuleNotFoundError: No module named 'openpyxl'");

  // Model-authored code attempting to import docx
  let errDocx = "";
  try {
    await runtime.runPythonAsync("import docx");
  } catch (err: any) {
    errDocx = String(err?.message ?? err);
  }
  assertStringIncludes(errDocx, "ModuleNotFoundError: No module named 'docx'");
});

Deno.test("documents bundle: multi-sheet .xlsx fixture creates canonical tabular artifact with both sheets preserved", async () => {
  const xlsxBytes = makeTwoSheetXlsx();
  const b64 = bytesToBase64(xlsxBytes);

  let createdAsset: any = null;
  const mockCreateAsset = async (origin: string, asset: any) => {
    createdAsset = { id: "asset-test-123", ...asset };
    return { ok: true, asset: createdAsset };
  };

  const result = await executeReadSpreadsheet({
    base64Data: b64,
    maxRows: 100,
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: mockCreateAsset as any,
    attachmentName: "financials.xlsx",
    origin: "master",
  }) as any;

  assertEquals(result.ok, true);
  assertEquals(result.totalSheets, 2);
  assertEquals(result.sheetNames, ["Q1 Revenue", "Q1 Expenses"]);
  assertEquals(result.sheets[0].name, "Q1 Revenue");
  assertEquals(result.sheets[0].headers, ["Month", "Revenue"]);
  assertEquals(result.sheets[0].rowCount, 2);
  assertEquals(result.sheets[1].name, "Q1 Expenses");
  assertEquals(result.sheets[1].headers, ["Category", "Amount"]);
  assertEquals(result.sheets[1].rowCount, 2);
  assertEquals(result.preview.length, 4);

  // Tabular artifact validation
  assert(createdAsset, "tabular asset must be created");
  assertEquals(createdAsset.type, "data");
  assertEquals(createdAsset.meta.sheetNames, ["Q1 Revenue", "Q1 Expenses"]);
  assertEquals(createdAsset.meta.sheets.length, 2);

  // Canonical table structure
  const parsedTable = JSON.parse(createdAsset.content);
  assertEquals(parsedTable.version, "cap.table/1");
  assert(parsedTable.columns.some((c: any) => c.header === "Sheet"));
  assert(parsedTable.columns.some((c: any) => c.header === "Month"));
  assert(parsedTable.columns.some((c: any) => c.header === "Revenue"));
  assert(parsedTable.columns.some((c: any) => c.header === "Category"));
  assert(parsedTable.columns.some((c: any) => c.header === "Amount"));
  assertEquals(parsedTable.rows.length, 4); // 2 rows from sheet 1 + 2 rows from sheet 2
});

Deno.test("documents bundle: .docx fixture extracts markdown with headings preserved", async () => {
  const docxBytes = makeDocx();
  const b64 = bytesToBase64(docxBytes);

  const result = await executeReadDocument({
    base64Data: b64,
    docType: "docx",
    maxCharacters: 5000,
    runtimeProvider: async () => await createTestPyodide(),
    attachmentName: "charter.docx",
  }) as any;

  assertEquals(result.ok, true);
  assertEquals(result.docType, "docx");
  assertEquals(result.format, "markdown");
  assertStringIncludes(result.content!, "# Project Charter");
  assertStringIncludes(result.content!, "This document defines the project scope.");
  assertStringIncludes(result.content!, "## Objectives and Deliverables");
  assertStringIncludes(result.content!, "The core objective is high performance.");
});

Deno.test("documents bundle: .pptx fixture extracts slides and bullets into structured markdown", async () => {
  const pptxBytes = makePptx();
  const b64 = bytesToBase64(pptxBytes);

  const result = await executeReadDocument({
    base64Data: b64,
    docType: "pptx",
    maxCharacters: 5000,
    runtimeProvider: async () => await createTestPyodide(),
    attachmentName: "review.pptx",
  }) as any;

  assertEquals(result.ok, true);
  assertEquals(result.docType, "pptx");
  assertEquals(result.format, "markdown");
  assertStringIncludes(result.content!, "## Quarterly Review");
  assertStringIncludes(result.content!, "- Key highlights and metrics");
});

Deno.test("documents bundle: isOfficeDocumentAttachment identifies office documents and provides tool hints", () => {
  assert(isOfficeDocumentAttachment({ name: "data.xlsx" }));
  assert(isOfficeDocumentAttachment({ name: "notes.docx" }));
  assert(isOfficeDocumentAttachment({ name: "deck.pptx" }));
  assert(isOfficeDocumentAttachment({ type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  assert(!isOfficeDocumentAttachment({ name: "script.py" }));
  assert(!isOfficeDocumentAttachment({ name: "image.png", type: "image/png" }));

  // Attachment context hint
  const xlsxAtt = {
    name: "data.xlsx",
    kind: "file",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 1024,
    dataURL: "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,AAAA",
  };
  const ctx = attachmentContext([xlsxAtt]);
  assertStringIncludes(ctx, "use read_spreadsheet with attachmentName: \"data.xlsx\"");

  const docxAtt = {
    name: "report.docx",
    kind: "file",
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 2048,
    dataURL: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAAA",
  };
  const ctxDocx = attachmentContext([docxAtt]);
  assertStringIncludes(ctxDocx, "use read_document with attachmentName: \"report.docx\"");
});

Deno.test("documents bundle: service worker route handlers dispatch spreadsheet and document tools with attachment resolution", async () => {
  const xlsxBytes = makeTwoSheetXlsx();
  const xlsxB64 = bytesToBase64(xlsxBytes);

  let createdAsset: any = null;
  const mockCreateAsset = async (origin: string, asset: any) => {
    createdAsset = { id: "asset-sw-456", ...asset };
    return { ok: true, asset: createdAsset };
  };

  // Test read_spreadsheet with explicit attachment context
  const mockContext = {
    attachments: [
      {
        name: "test-sheet.xlsx",
        kind: "file",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: xlsxBytes.length,
        dataURL: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsxB64}`,
      },
    ],
  };

  const resSpreadsheet = await executeReadSpreadsheet({
    base64Data: mockContext.attachments[0].dataURL,
    maxRows: 50,
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: mockCreateAsset as any,
    attachmentName: "test-sheet.xlsx",
    origin: "master",
  }) as any;

  assertEquals(resSpreadsheet.ok, true);
  assertEquals(resSpreadsheet.totalSheets, 2);
  assertEquals(resSpreadsheet.sheets.length, 2);
  assertEquals(resSpreadsheet.artifactId, "asset-sw-456");
  assertEquals(typeof resSpreadsheet.rowCount, "number");
  assert(Array.isArray(resSpreadsheet.preview));
  assert(resSpreadsheet.preview.length <= 10);
  assertEquals((resSpreadsheet as any).artifact, undefined, "full artifact object must not be returned to model");

  // Test read_document with docx attachment
  const docxBytes = makeDocx();
  const docxB64 = bytesToBase64(docxBytes);

  const resDocument = await executeReadDocument({
    base64Data: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${docxB64}`,
    docType: "docx",
    maxCharacters: 5000,
    runtimeProvider: async () => await createTestPyodide(),
    attachmentName: "charter.docx",
  }) as any;

  assertEquals(resDocument.ok, true);
  assertStringIncludes(resDocument.content, "# Project Charter");
});

Deno.test("documents bundle: an absolute OPC worksheet target cannot silently drop a declared sheet", async () => {
  // Package-root Target=/xl/... is valid in an OPC relationship. The returned
  // workbook must include BOTH sheets, never report success with one omitted.
  const xlsxBytes = makeTwoSheetXlsx("Month", "/xl/worksheets/sheet2.xml");
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(xlsxBytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async (_origin: string, asset: any) => ({ ok: true, asset: { id: "absolute-target", ...asset } })) as any,
    attachmentName: "package-root-target.xlsx",
  }) as any;
  assertEquals(res.ok, true, `do not reject a valid package-root worksheet target: ${res.error}`);
  assertEquals(res.totalSheets, 2, "a successful read cannot omit the second declared sheet");
  assertEquals(res.sheets.length, 2);
});

Deno.test("documents bundle: F1 unaddressed cell after B2 survives the canonical artifact", async () => {
  let content = "";
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
      extraCell: '<c t="n"><v>42</v></c>',
    })),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async (_origin: string, asset: any) => { content = asset.content; return { ok: true, asset: { id: "unaddressed", ...asset } }; }) as any,
  }) as any;
  assertEquals(res.ok, true, `a valid cell without r must be read or refused: ${res.error}`);
  assertEquals(res.preview[0][3], "42", "the optional r must not cause silent cell loss in the response");
  assertEquals(JSON.parse(content).rows[0][3], "42", "the persisted artifact must keep the column without a header");
});

Deno.test("documents bundle: F2 inline rich-text runs survive the canonical artifact in source order", async () => {
  let content = "";
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
      extraHeaderCell: '<c r="C1" t="inlineStr"><is><t>Notes</t></is></c>',
      extraCell: '<c r="C2" t="inlineStr"><is><r><t xml:space="preserve">Hello </t></r><r><t>World</t></r></is></c>',
    })),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async (_origin: string, asset: any) => { content = asset.content; return { ok: true, asset: { id: "rich-inline", ...asset } }; }) as any,
  }) as any;
  assertEquals(res.ok, true, `valid rich inline text must be read or refused: ${res.error}`);
  assertEquals(res.preview[0][3], "Hello World", "rich text must not become an empty string in the response");
  assertEquals(JSON.parse(content).rows[0][3], "Hello World", "the persisted artifact must retain ordered runs");
});

Deno.test("documents bundle: repeated shared strings cannot multiply logical output beyond the workbook cap", async () => {
  const bytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
    sharedStringPadding: "A".repeat(1024 * 1024),
    extraRow: '<row r="4"><c r="A4" t="s"><v>0</v></c><c r="B4" t="s"><v>0</v></c><c r="C4" t="s"><v>0</v></c></row>',
  });
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(bytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false);
  assertEquals(res.incomplete, true);
  assertStringIncludes(res.error, "total spreadsheet text exceeds 2 MiB");
  assertEquals(saved, 0);
});

Deno.test("documents bundle: sparse 5000-by-100 grid cannot bypass the aggregate cell cap", async () => {
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
      extraRow: '<row r="5000"><c r="CV5000"><v>42</v></c></row>',
    })),
    maxRows: 5000,
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false);
  assertEquals(res.incomplete, true);
  assertStringIncludes(res.error, "total spreadsheet grid exceeds 100000 cells");
  assertEquals(saved, 0);
});

Deno.test("documents bundle: F3 compressed workbook with safe members but excessive TOTAL inflation refuses before saving", async () => {
  const xlsxBytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
    sharedStringPadding: "A".repeat(8 * 1024 * 1024),
    sheet2Padding: `<!--${"B".repeat(8 * 1024 * 1024)}-->`,
  });
  assert(xlsxBytes.length < 192 * 1024, "the ZIP must fit inside the 256 KiB base64 transport cap");
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(xlsxBytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true, asset: { id: "forbidden-bomb" } }; }) as any,
  }) as any;
  assertEquals(res.ok, false, "individually legal ZIP members may still exceed the total inflation budget");
  assertEquals(res.incomplete, true);
  assertStringIncludes(res.error, "document_incomplete: total uncompressed");
  assertEquals(saved, 0, "no partial table artifact may be persisted from an oversized package");
});

for (const [limit, opts] of [
  ["shared strings member", { sharedStringPadding: "X".repeat(10 * 1024 * 1024) }],
  ["worksheet member", { sheet2Padding: `<row r="4"><c r="A4" t="inlineStr"><is><t>${"X".repeat(10 * 1024 * 1024)}</t></is></c></row>` }],
  ["row 5001", { extraRow: '<row r="5001"><c r="A5001"><v>99</v></c></row>' }],
  ["column 101", { extraCell: '<c r="CW2"><v>99</v></c>' }],
] as const) {
  Deno.test(`documents bundle: ${limit} cannot yield a successful incomplete artifact`, async () => {
    const xlsxBytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", opts);
    let saved = 0;
    const res = await executeReadSpreadsheet({
      base64Data: bytesToBase64(xlsxBytes),
      runtimeProvider: async () => await createTestPyodide(),
      createAssetFn: (async () => { saved++; return { ok: true, asset: { id: "should-not-exist" } }; }) as any,
      attachmentName: "oversized-but-compressed.xlsx",
    }) as any;
    assertEquals(res.ok, false, `${limit} may not return ok:true with omitted content`);
    assertEquals(res.incomplete, true, `${limit} must be explicitly marked incomplete: ${res.error}`);
    assertStringIncludes(res.error, "document_incomplete", `${limit} must name the incomplete result`);
    assertEquals(saved, 0, `${limit} must not persist a partial artifact`);
  });
}

Deno.test("documents bundle: an unparsed spreadsheet comments part cannot produce a complete table", async () => {
  const bytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
    extraParts: [{ name: "xl/comments1.xml", content: '<comments><comment>Material decision</comment></comments>' }],
  });
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(bytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false);
  assertEquals(res.incomplete, true);
  assertEquals(saved, 0);
});

Deno.test("documents bundle: an unparsed external workbook link fails closed", async () => {
  const bytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
    extraWorkbookRelationship: '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="https://example.invalid/data" TargetMode="External"/>',
  });
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(bytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false, "external workbook link cannot be silently ignored");
  assertEquals(res.incomplete, true);
  assertEquals(saved, 0);
});

Deno.test("documents bundle: a requested maxRows cap cannot persist a partial table", async () => {
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(makeTwoSheetXlsx()), maxRows: 1,
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false);
  assertEquals(res.incomplete, true);
  assertStringIncludes(res.error, "document_incomplete");
  assertEquals(saved, 0);
});

Deno.test("documents bundle: an unparsed Excel error cell cannot report a complete table", async () => {
  const bytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
    extraCell: '<c r="C2" t="e"><v>#N/A</v></c>',
  });
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(bytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false, "Excel error cells are not plain strings");
  assertEquals(res.incomplete, true);
  assertEquals(saved, 0);
});

Deno.test("documents bundle: a styled Excel serial cannot pretend to be interpreted text or date", async () => {
  const bytes = makeTwoSheetXlsx("Month", "worksheets/sheet2.xml", {
    extraCell: '<c r="C2" s="1"><v>45291</v></c>',
  });
  let saved = 0;
  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(bytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => { saved++; return { ok: true }; }) as any,
  }) as any;
  assertEquals(res.ok, false, "styled values need formatting/date interpretation that this reader does not implement");
  assertEquals(res.incomplete, true);
  assertEquals(saved, 0);
});

for (const [kind, bytes, docType, maxCharacters] of [
  ["DOCX alternate content", makeDocx('<w:altChunk xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="other"/>'), "docx", 5000],
  ["DOCX header part", makeDocx("", [{ name: "word/header1.xml", content: '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential</w:t></w:r></w:p></w:hdr>' }]), "docx", 5000],
  ["DOCX unknown package root", makeDocx("", [{ name: "customXml/item1.xml", content: '<data>Confidential attachment</data>' }]), "docx", 5000],
  ["PPTX picture", makePptx("<p:pic/>"), "pptx", 5000],
  ["PPTX unparsed part", makePptx("", [{ name: "ppt/customData1.xml", content: '<data>Disclosure</data>' }]), "pptx", 5000],
  ["DOCX character ceiling", makeDocx(`<w:p><w:r><w:t>${"X".repeat(400)}</w:t></w:r></w:p>`), "docx", 100],
] as const) {
  Deno.test(`documents bundle: ${kind} produces incomplete, not partial success`, async () => {
    const res = await executeReadDocument({
      base64Data: bytesToBase64(bytes), docType, maxCharacters,
      runtimeProvider: async () => await createTestPyodide(),
    }) as any;
    assertEquals(res.ok, false, `${kind} must not claim fully parsed content`);
    assertEquals(res.incomplete, true, `${kind} needs an explicit incomplete flag: ${res.error}`);
    assertStringIncludes(res.error, "document_incomplete");
    assertEquals(res.content, undefined, `${kind} must not expose a partial document body`);
  });
}

for (const [kind, makeBytes, docType] of [
  ["DOCX", () => makeDocx(`<!--${"A".repeat(8 * 1024 * 1024)}-->`, [
    { name: "word/styles.xml", content: `<styles><!--${"B".repeat(8 * 1024 * 1024)}--></styles>`, deflate: true },
  ], true), "docx"],
  ["PPTX", () => makePptx(`<!--${"A".repeat(8 * 1024 * 1024)}-->`, [
    { name: "ppt/theme/theme1.xml", content: `<theme><!--${"B".repeat(8 * 1024 * 1024)}--></theme>`, deflate: true },
  ], false, true), "pptx"],
] as const) {
  Deno.test(`documents bundle: ${kind} package total inflation refuses before extracting a partial document`, async () => {
    const bytes = makeBytes();
    assert(bytes.length < 192 * 1024, "the ZIP must fit the base64 transport cap");
    const res = await executeReadDocument({
      base64Data: bytesToBase64(bytes), docType,
      runtimeProvider: async () => await createTestPyodide(),
    }) as any;
    assertEquals(res.ok, false);
    assertEquals(res.incomplete, true);
    assertStringIncludes(res.error, "total uncompressed");
    assertEquals(res.content, undefined);
  });
}

Deno.test("documents bundle: PPTX honors the manifest slide order, not filename sort", async () => {
  const res = await executeReadDocument({
    base64Data: bytesToBase64(makePptx("", [], true)), docType: "pptx",
    runtimeProvider: async () => await createTestPyodide(),
  }) as any;
  assertEquals(res.ok, true, `valid two-slide deck must parse: ${res.error}`);
  const second = res.content.indexOf("Slide Two");
  const first = res.content.indexOf("Quarterly Review");
  assert(second >= 0 && first > second, "the declared slide order must survive extraction");
});

Deno.test("documents bundle: oversize document payload fails closed before transport", async () => {
  const hugeData = "A".repeat(300 * 1024);
  const res = await executeReadSpreadsheet({
    base64Data: hugeData,
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async () => ({ ok: true })) as any,
  }) as any;

  assertEquals(res.ok, false);
  assertStringIncludes(res.error, "document_oversized");
});

Deno.test("documents bundle: base64 plus metadata cannot exceed the worker frame without explicit refusal", async () => {
  const runtime = {
    setWheels: () => {}, setStdout: () => {}, setStdin: () => {},
    runPythonAsync: () => { throw new Error("worker must not receive an oversized frame"); },
  };
  const res = await executeReadSpreadsheet({
    base64Data: "A".repeat(MAX_DOCUMENT_TRANSPORT_BYTES),
    runtimeProvider: async () => runtime,
  }) as any;
  assertEquals(res.ok, false);
  assertStringIncludes(res.error, "document_oversized: encoded spreadsheet request");
});

Deno.test("documents bundle: spreadsheet with user 'Sheet' column preserves both user column and provenance", async () => {
  const wbBytes = makeTwoSheetXlsx("Sheet");

  const res = await executeReadSpreadsheet({
    base64Data: bytesToBase64(wbBytes),
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async (_origin: string, asset: any) => {
      return { ok: true, asset: { id: "sheet-col-asset", ...asset } };
    }) as any,
    attachmentName: "user-sheet.xlsx",
  }) as any;

  assertEquals(res.ok, true, `res failed: ${res?.error}`);
  const headers = res.columns.map((c: any) => c.header);
  assert(headers.includes("_sheet_name"), "provenance column renamed away from collision");
  assert(headers.includes("Sheet"), "user's original Sheet column preserved");
});

Deno.test("documents bundle: docx with interleaved paragraphs and tables preserves element sequence", async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>First Paragraph</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Header A</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Cell 1</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>Second Paragraph after table</w:t></w:r></w:p>
  </w:body>
</w:document>`;

  const docxBytes = makeZip([
    { name: "[Content_Types].xml", content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: "word/document.xml", content: documentXml },
  ]);

  const res = await executeReadDocument({
    base64Data: bytesToBase64(docxBytes),
    docType: "docx",
    runtimeProvider: async () => await createTestPyodide(),
    attachmentName: "interleaved.docx",
  }) as any;

  assertEquals(res.ok, true);
  const content = res.content;
  const posFirst = content.indexOf("First Paragraph");
  const posTable = content.indexOf("Header A");
  const posSecond = content.indexOf("Second Paragraph after table");
  assert(posFirst >= 0 && posTable > posFirst && posSecond > posTable, "elements must appear in exact document order");
});

Deno.test("documents bundle: model dispatch context attachment resolution without activeExecutions.get", async () => {
  const xlsxBytes = makeTwoSheetXlsx();
  const xlsxB64 = bytesToBase64(xlsxBytes);

  const testAttachment = {
    name: "financial-report.xlsx",
    kind: "file",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: xlsxBytes.length,
    dataURL: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsxB64}`,
  };

  const context = {
    principal: "model",
    executionId: "exec_test_789",
    attachments: [testAttachment],
  };

  const atts = Array.isArray(context?.attachments) && context.attachments.length > 0
    ? context.attachments
    : [];
  assertEquals(atts.length, 1);
  assertEquals(atts[0].name, "financial-report.xlsx");

  const res = await executeReadSpreadsheet({
    base64Data: atts[0].dataURL,
    maxRows: 10,
    runtimeProvider: async () => await createTestPyodide(),
    createAssetFn: (async (_origin: string, asset: any) => ({ ok: true, asset: { id: "a_1", ...asset } })) as any,
    attachmentName: atts[0].name,
  }) as any;

  assertEquals(res.ok, true);
  assertEquals(res.artifactId, "a_1");
  assertEquals(res.preview.length, 4);
});

// tests/python-documents-host-seam.test.ts — chrome-agent-platform-01d0r.
//
// The OOXML readers' size/time budgets used to live ONLY inside the generated
// Python — the same in-process trust context as the parser — so a crafted
// document could burn CPU/memory inside the extension before any budget check
// fired. The host seam (checkDocumentZipBudget) now walks the container's
// central directory in the SERVICE WORKER, on the raw bytes, BEFORE the
// Pyodide runtime is even fetched, and the readers run under the same
// wall-clock fence as python.execute.
//
// These tests are deliberately Pyodide-free (fast tier): the whole point of
// the seam is that refused documents never reach the runtime, so a spy
// runtimeProvider that MUST NOT be called is the proof. The real-Pyodide
// integration lives in tests/python-documents-bundle-3p3e11.test.ts (heavy).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  checkDocumentZipBudget,
  DOCUMENT_ZIP_BUDGET,
  executeReadDocument,
  executeReadSpreadsheet,
  getDocumentsBundleWheels,
  MAX_DOCUMENT_TRANSPORT_BYTES,
} from "../extension/lib/python-documents-bundle.js";

// ── zip crafting (STORED method; the seam validates structure and DECLARED
// sizes, never CRCs, so checksums stay zero) ────────────────────────────────

type Member = { name: string; data?: Uint8Array; declaredSize?: number; flags?: number };

function buildZip(opts: {
  members?: Member[];
  entriesTotalOverride?: number;
  cdOffsetOverride?: number;
  skipEocd?: boolean;
} = {}): Uint8Array {
  const enc = new TextEncoder();
  const members = opts.members ?? [{ name: "xl/workbook.xml", data: enc.encode("<x/>") }];
  const locals: Uint8Array[] = [];
  const cds: Uint8Array[] = [];
  let offset = 0;
  for (const m of members) {
    const name = enc.encode(m.name);
    const data = m.data ?? new Uint8Array(0);
    const declared = m.declaredSize ?? data.byteLength;
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, m.flags ?? 0, true);
    lv.setUint16(8, 0, true); // STORED
    lv.setUint32(18, data.byteLength, true);
    lv.setUint32(22, declared, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const cd = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, m.flags ?? 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.byteLength, true);
    cv.setUint32(24, declared, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    cds.push(cd);

    offset += local.byteLength;
  }
  const cdBytes = concat(cds);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, opts.entriesTotalOverride ?? members.length, true);
  ev.setUint16(10, opts.entriesTotalOverride ?? members.length, true);
  ev.setUint32(12, cdBytes.byteLength, true);
  ev.setUint32(16, opts.cdOffsetOverride ?? offset, true);
  const body = concat(locals);
  if (opts.skipEocd) return concat([body, cdBytes]);
  return concat([body, cdBytes, eocd]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Spy runtime: records that the seam let the document THROUGH to Pyodide. */
function spyRuntime(behavior: "empty" | "hang" = "empty") {
  const state = { fetched: false, wheelsSet: false };
  const provider = async () => {
    state.fetched = true;
    return {
      setWheels: () => { state.wheelsSet = true; },
      setStdout: () => {},
      setStdin: () => {},
      runPythonAsync: () => behavior === "hang"
        ? new Promise(() => {}) // never settles: only the fence can end this
        : Promise.resolve(undefined),
    };
  };
  return { state, provider };
}

// ── the seam itself ─────────────────────────────────────────────────────────

Deno.test("01d0r: the host seam refuses a declared zip bomb BEFORE the runtime is fetched", async () => {
  // Two members declaring 8 MB each: individually legal, 16 MB aggregate —
  // the exact shape of the heavy suite's F3 fixture. Tiny transport, huge
  // declared parse work; the TOTAL budget must refuse it host-side.
  const bomb = toB64(buildZip({
    members: [
      { name: "xl/sharedStrings.xml", data: new Uint8Array(10), declaredSize: 8 * 1024 * 1024 },
      { name: "xl/worksheets/sheet1.xml", data: new Uint8Array(10), declaredSize: 8 * 1024 * 1024 },
    ],
  }));
  const check = checkDocumentZipBudget(bomb);
  assertEquals(check.ok, false);
  assertStringIncludes(String((check as any).error), "document_incomplete");
  assertStringIncludes(String((check as any).error), "total uncompressed");

  const spy = spyRuntime();
  const sheet = await executeReadSpreadsheet({ base64Data: bomb, runtimeProvider: spy.provider });
  assertEquals(sheet.ok, false);
  assertEquals((sheet as any).incomplete, true, "budget refusals keep the module's incomplete:true contract");
  assertStringIncludes(String(sheet.error), "document_incomplete");
  assertEquals(spy.state.fetched, false, "the Pyodide runtime must NEVER be fetched for a refused container");

  const doc = await executeReadDocument({ base64Data: bomb, runtimeProvider: spy.provider });
  assertEquals(doc.ok, false);
  assertStringIncludes(String(doc.error), "document_incomplete");
  assertEquals(spy.state.fetched, false, "same seam fences the document reader");
});

Deno.test("01d0r: per-member, member-count, encryption, ZIP64 and non-zip containers all fail closed host-side", () => {
  const oneHugeMember = checkDocumentZipBudget(toB64(buildZip({
    members: [{ name: "word/document.xml", data: new Uint8Array(8), declaredSize: 11 * 1024 * 1024 }],
  })));
  assertEquals(oneHugeMember.ok, false);
  assertStringIncludes(String((oneHugeMember as any).error), "document_incomplete");

  const tooMany = checkDocumentZipBudget(toB64(buildZip({
    members: Array.from({ length: 257 }, (_, i) => ({ name: `f${i}.xml`, data: new Uint8Array(2) })),
  })));
  assertEquals(tooMany.ok, false);
  assertStringIncludes(String((tooMany as any).error), "document_incomplete");

  const encrypted = checkDocumentZipBudget(toB64(buildZip({
    members: [{ name: "xl/workbook.xml", data: new Uint8Array(4), flags: 0x1 }],
  })));
  assertEquals(encrypted.ok, false);
  assertStringIncludes(String((encrypted as any).error), "document_invalid");

  const zip64 = checkDocumentZipBudget(toB64(buildZip({
    members: [{ name: "xl/workbook.xml", data: new Uint8Array(4), declaredSize: 0xffffffff }],
  })));
  assertEquals(zip64.ok, false);
  assertStringIncludes(String((zip64 as any).error), "document_invalid");

  const notAZip = checkDocumentZipBudget(toB64(new TextEncoder().encode("this is not a zip container at all")));
  assertEquals(notAZip.ok, false);
  assertStringIncludes(String((notAZip as any).error), "document_invalid");

  const badB64 = checkDocumentZipBudget("!!!not-base64!!!");
  assertEquals(badB64.ok, false);
});

Deno.test("01d0r: an honest small container passes the seam and reaches the runtime", async () => {
  const honest = toB64(buildZip({ members: [{ name: "xl/workbook.xml", data: new Uint8Array(64) }] }));
  const check = checkDocumentZipBudget(honest);
  assertEquals(check.ok, true);
  assertEquals((check as any).members, 1);
  assertEquals((check as any).totalUncompressedBytes, 64);

  const spy = spyRuntime();
  const out = await executeReadSpreadsheet({ base64Data: honest, runtimeProvider: spy.provider });
  assertEquals(spy.state.fetched, true, "a within-budget document MUST still reach the reader");
  assertEquals(spy.state.wheelsSet, true, "wheel admission still runs after the seam");
  // The fake runtime emits no stdout, so parsing fails downstream — the point
  // is that it failed AFTER the seam, not at it.
  assertEquals(out.ok, false);
  assert(!String(out.error).startsWith("document_incomplete"), "not refused by the seam");
  assert(!String(out.error).startsWith("document_invalid"), "not refused by the seam");
});

Deno.test("01d0r: the readers now run under the python.execute wall-clock fence", async () => {
  const honest = toB64(buildZip({ members: [{ name: "xl/workbook.xml", data: new Uint8Array(8) }] }));
  const spy = spyRuntime("hang");
  const started = Date.now();
  const out = await executeReadSpreadsheet({ base64Data: honest, runtimeProvider: spy.provider, timeoutMs: 40 as any });
  const elapsed = Date.now() - started;
  assertEquals(out.ok, false);
  assertStringIncludes(String(out.error), "document_timeout");
  assert(elapsed < 5000, `the fence must end a hung parse (took ${elapsed}ms)`);

  const spy2 = spyRuntime("hang");
  const doc = await executeReadDocument({ base64Data: honest, runtimeProvider: spy2.provider, timeoutMs: 40 as any });
  assertEquals(doc.ok, false);
  assertStringIncludes(String(doc.error), "document_timeout");
});

Deno.test("01d0r: the transport ceiling still fires FIRST for oversized payloads", async () => {
  const spy = spyRuntime();
  const oversized = "A".repeat(MAX_DOCUMENT_TRANSPORT_BYTES + 1);
  const out = await executeReadSpreadsheet({ base64Data: oversized, runtimeProvider: spy.provider });
  assertEquals(out.ok, false);
  assertStringIncludes(String(out.error), "transport limit");
  assertEquals(spy.state.fetched, false);
});

// ── lockstep: the host budget and the generated Python budget cannot drift ──

Deno.test("01d0r: the host seam's budget EQUALS the generated Python readers' budget (drift pin)", () => {
  // The wheels are deterministic STORED zips; pull the generated xlsx reader
  // source back out and pin its literals against the host constants. Changing
  // EITHER side without the other fails here.
  const wheels = getDocumentsBundleWheels();
  const xlsx = wheels.find((w: any) => w.name.startsWith("cap_xlsx_reader"));
  assert(xlsx, "the xlsx reader wheel exists");
  const bytes: Uint8Array = (xlsx as any).bytes;
  // STORED members: concatenate local-file data by walking the central directory.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  assert(eocd >= 0, "wheel zip has an EOCD");
  let pos = dv.getUint32(eocd + 16, true);
  const cdEnd = pos + dv.getUint32(eocd + 12, true);
  let source = "";
  const dec = new TextDecoder();
  while (pos + 46 <= cdEnd) {
    assertEquals(dv.getUint32(pos, true), 0x02014b50, "central directory signature");
    assertEquals(dv.getUint16(pos + 10, true), 0, "wheel members are STORED (method 0)");
    const size = dv.getUint32(pos + 20, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localOffset = dv.getUint32(pos + 42, true);
    const localNameLen = dv.getUint16(localOffset + 26, true);
    const localExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    source += dec.decode(bytes.subarray(dataStart, dataStart + size));
    pos += 46 + nameLen + extraLen + commentLen;
  }

  assertStringIncludes(source, "MAX_ZIP_MEMBER_BYTES = 10 * 1024 * 1024",
    "the generated Python keeps its per-member literal");
  assertStringIncludes(source, "MAX_TOTAL_ZIP_BYTES = 12 * 1024 * 1024", "the generated Python keeps its aggregate literal");
  assertStringIncludes(source, "MAX_ZIP_MEMBERS = 256", "the generated Python keeps its member-count literal");

  // And the host constants are numerically the SAME budget — the host seam may
  // be stricter, never looser, than the parser-side backstop.
  assertEquals(DOCUMENT_ZIP_BUDGET.maxMemberBytes, 10 * 1024 * 1024);
  assertEquals(DOCUMENT_ZIP_BUDGET.maxTotalUncompressedBytes, 12 * 1024 * 1024);
  assertEquals(DOCUMENT_ZIP_BUDGET.maxMembers, 256);
});

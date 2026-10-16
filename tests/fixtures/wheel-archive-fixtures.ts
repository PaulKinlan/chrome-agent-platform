// tests/fixtures/wheel-archive-fixtures.ts — wheel-shaped archives for the archive-bomb bounds
// (chrome-agent-platform-gdrfu).
//
// One builder, two gates: tests/wheel-archive-bounds.test.ts uses it against the pure validator and
// tests/python-runtime.test.ts uses it against the run-time hop that feeds the Pyodide sandbox, so
// the same fixture proves the same archive is handled consistently at both boundaries.
//
// The builder LIES in the Central Directory on request (`declaredUncompressed`) while the local
// header keeps the true stored length - the parser's sequential walk needs the true length, and the
// guard must refuse on what an archive DECLARES, because reading declarations is all that happens
// before extraction. CRCs are written as 0: nothing under test reads them.

export interface ZipEntryFixture {
  name: string;
  data: Uint8Array;
  /** Declared uncompressed size in the Central Directory. Defaults to the true stored length. */
  declaredUncompressed?: number;
}

const encoder = new TextEncoder();

/** Minimal STORED (method 0) zip builder with a controllable declared uncompressed size. */
export function buildStoredZip(entries: ZipEntryFixture[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data;
    const declared = entry.declaredUncompressed ?? data.byteLength;

    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, data.byteLength, true); // true stored length: the walk depends on it
    lv.setUint32(22, data.byteLength, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, data.byteLength, true); // compressed
    cv.setUint32(24, declared, true); // <- the declaration under test
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
  }
  return finishZip(locals, centrals, offset, entries.length);
}

/** A real DEFLATE (method 8) single-entry zip, compressed with the platform's own compressor, so a
 *  test can prove a genuinely COMPRESSED archive is admitted rather than only stored ones. */
export async function buildDeflatedZip(name: string, text: string): Promise<Uint8Array> {
  const raw = encoder.encode(text);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const deflated = new Uint8Array(await new Response(stream).arrayBuffer());
  const nameBytes = encoder.encode(name);
  const crc = crc32(raw);

  const local = new Uint8Array(30 + nameBytes.byteLength + deflated.byteLength);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 8, true); // method 8 = deflate
  lv.setUint32(14, crc, true);
  lv.setUint32(18, deflated.byteLength, true);
  lv.setUint32(22, raw.byteLength, true);
  lv.setUint16(26, nameBytes.byteLength, true);
  local.set(nameBytes, 30);
  local.set(deflated, 30 + nameBytes.byteLength);

  const central = new Uint8Array(46 + nameBytes.byteLength);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, deflated.byteLength, true);
  cv.setUint32(24, raw.byteLength, true);
  cv.setUint16(28, nameBytes.byteLength, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  return finishZip([local], [central], local.byteLength, 1);
}

function finishZip(locals: Uint8Array[], centrals: Uint8Array[], offset: number, count: number): Uint8Array {
  const cdSize = centrals.reduce((n, c) => n + c.byteLength, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, count, true);
  ev.setUint16(10, count, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const chunk of [...locals, ...centrals, eocd]) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const LEGIT_WHEEL_NAME = "pkg-1.0.0-py3-none-any.whl";

/** The smallest thing that is really a pure-Python wheel: one module and its dist-info metadata. */
export function legitWheelEntries(extra: ZipEntryFixture[] = []): ZipEntryFixture[] {
  return [
    { name: "pkg/__init__.py", data: encoder.encode("VALUE = 1\n") },
    { name: "pkg-1.0.0.dist-info/WHEEL", data: encoder.encode("Wheel-Version: 1.0\n") },
    ...extra,
  ];
}

export function legitWheelBytes(): Uint8Array {
  return buildStoredZip(legitWheelEntries());
}

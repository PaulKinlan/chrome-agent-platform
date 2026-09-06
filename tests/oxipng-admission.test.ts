// @ts-nocheck
// oxipng admission KAT (chrome-agent-platform-m3vb, qazo option B): the
// CAP-authored WASI PNG optimiser — pure-WASI, single-threaded, default-tier
// memory-bounded, reproducible, dispatchable through the ten9 offscreen
// WASI-job lane, and runnable through the REAL stream worker with the pixels
// proven identical by decoding both PNGs here (inflate + unfilter), not by
// trusting the tool's own claim.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { crypto } from "jsr:@std/crypto";
import { auditWasmBinary } from "../extension/lib/wasm-package-authority.js";
import {
  appendWasmStreamInput,
  createWasmStreamInput,
  createWasmStreamOutput,
  readWasmStreamWindow,
  sealWasmStreamInput,
  sealWasmStreamOutput,
} from "../extension/lib/wasm-stream-files.js";
import {
  buildPreviewAuthority,
  buildPreviewJob,
  PREVIEW_TOOL_IDS,
  previewStdoutEncoding,
  validatePreviewInput,
} from "../extension/lib/tool-exec-preview.js";
import { executeWasmStreamJob } from "../extension/lib/wasm-stream-worker.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";
import { toolPurposeGroup } from "../extension/lib/tool-purpose-groups.js";

// In-memory OPFS stand-in (the compressops/imageops admission tests' shape).
const fileNode = () => ({ kind: "file", bytes: new Uint8Array(), syncOpen: false });
const directoryNode = () => ({ kind: "directory", children: new Map() });
class MemorySyncAccess {
  constructor(node) { this.node = node; }
  read(target, { at = 0 } = {}) {
    const count = Math.max(0, Math.min(target.byteLength, this.node.bytes.byteLength - at));
    target.set(this.node.bytes.subarray(at, at + count));
    return count;
  }
  write(bytes, { at = 0 } = {}) {
    const end = at + bytes.byteLength;
    if (end > this.node.bytes.byteLength) {
      const next = new Uint8Array(end); next.set(this.node.bytes); this.node.bytes = next;
    }
    this.node.bytes.set(bytes, at);
    return bytes.byteLength;
  }
  truncate(size) { const next = new Uint8Array(size); next.set(this.node.bytes.subarray(0, size)); this.node.bytes = next; }
  getSize() { return this.node.bytes.byteLength; }
  flush() {}
  close() {}
}
class MemoryFile {
  constructor(node) { this.node = node; this.kind = "file"; }
  async getFile() { return new Blob([this.node.bytes]); }
  async createWritable() {
    const node = this.node;
    return {
      bytes: new Uint8Array(), position: 0,
      async seek(p) { this.position = p; },
      async write(value) {
        const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
        const length = Math.max(this.bytes.byteLength, this.position + bytes.byteLength);
        const next = new Uint8Array(length);
        next.set(this.bytes); next.set(bytes, this.position);
        this.bytes = next; this.position += bytes.byteLength;
      },
      async close() { node.bytes = this.bytes; },
    };
  }
  async createSyncAccessHandle() { return new MemorySyncAccess(this.node); }
}
class MemoryDirectory {
  constructor(node) { this.node = node; this.kind = "directory"; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, directoryNode());
    }
    return new MemoryDirectory(this.node.children.get(name));
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.node.children.has(name)) {
      if (!create) throw new Error("not found");
      this.node.children.set(name, fileNode());
    }
    return new MemoryFile(this.node.children.get(name));
  }
  async removeEntry(name) { this.node.children.delete(name); }
  async *entries() {
    for (const [name, node] of this.node.children) {
      yield [name, node.kind === "file" ? new MemoryFile(node) : new MemoryDirectory(node)];
    }
  }
}
function memoryStorage() {
  const root = directoryNode();
  return { storage: { async getDirectory() { return new MemoryDirectory(root); } } };
}

const OXIPNG_SHA256 = "b93a6232119ec73eb82f2544a16e78f5eddfd36faa923cb6c99324bfe46de9eb";
const OXIPNG_BYTES = 284734;
// The nine WASI functions the binary imports — every one implemented by the
// preview-1 shim (random_get feeds the crate's hashing; the MONOTONIC clock
// feeds its optimisation deadline).
const OXIPNG_IMPORTS = [
  "args_get", "args_sizes_get", "clock_time_get", "environ_get", "environ_sizes_get",
  "fd_read", "fd_write", "proc_exit", "random_get",
];

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── A tiny PNG codec, enough to build a naive fixture and to DECODE both the
//    input and oxipng's output to raw RGBA so pixel identity is observed. ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function zlibStream(bytes, direction) {
  const s = direction === "deflate" ? new CompressionStream("deflate") : new DecompressionStream("deflate");
  const w = s.writable.getWriter();
  const done = new Response(s.readable).arrayBuffer();
  await w.write(bytes);
  await w.close();
  return new Uint8Array(await done);
}
function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  return concat([be32(data.length), t, data, be32(crc32(concat([t, data])))]);
}
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A 48x48 RGBA8 fixture with thousands of distinct colours AND varying alpha,
 *  so no lossless reduction (palette, alpha drop, bit depth) applies and the
 *  output must stay RGBA8 — only filters/deflate can change. Naively encoded
 *  (filter 0 on every scanline, zlib default): the shape most producers emit. */
async function fixturePng() {
  const W = 48, H = 48;
  const raw = new Uint8Array(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4);
    raw[row] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const p = row + 1 + x * 4;
      raw[p] = (x * 5) & 255;
      raw[p + 1] = (y * 5) & 255;
      raw[p + 2] = (x * y) & 255;
      raw[p + 3] = 128 + (((x + y) * 3) & 127);
    }
  }
  const ihdr = concat([be32(W), be32(H), new Uint8Array([8, 6, 0, 0, 0])]);
  return concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", await zlibStream(raw, "deflate")), chunk("IEND", new Uint8Array())]);
}

/** Decode an 8-bit RGBA, non-interlaced PNG to {width, height, pixels}. */
async function decodeRgba8(png) {
  assertEquals([...png.subarray(0, 8)], [...PNG_SIG], "PNG signature");
  let p = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  const idat = [];
  const u32 = (i) => ((png[i] << 24) | (png[i + 1] << 16) | (png[i + 2] << 8) | png[i + 3]) >>> 0;
  while (p < png.length) {
    const len = u32(p);
    const type = new TextDecoder().decode(png.subarray(p + 4, p + 8));
    const data = png.subarray(p + 8, p + 8 + len);
    assertEquals(u32(p + 8 + len), crc32(png.subarray(p + 4, p + 8 + len)), `${type} chunk CRC`);
    if (type === "IHDR") { width = u32(0 + p + 8); height = u32(p + 12); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  assertEquals([depth, colorType, interlace], [8, 6, 0], "RGBA8, non-interlaced (the fixture cannot be reduced losslessly)");
  const raw = await zlibStream(concat(idat), "inflate");
  const bpp = 4, stride = width * bpp;
  assertEquals(raw.length, height * (1 + stride), "inflated scanline bytes");
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    const src = raw.subarray(y * (1 + stride) + 1, (y + 1) * (1 + stride));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      cur[i] = v & 255;
    }
  }
  return { width, height, pixels };
}

Deno.test("oxipng: the shipped wasm is pure-WASI preview-1, single-threaded, default-tier bounded", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${OXIPNG_SHA256}.wasm`);
  assertEquals(bytes.length, OXIPNG_BYTES, "pinned size");
  const mod = new WebAssembly.Module(bytes);
  const fns = WebAssembly.Module.imports(mod).filter((i) => i.kind === "function");
  assertEquals([...new Set(fns.map((f) => f.module))], ["wasi_snapshot_preview1"], "only WASI preview-1");
  assertEquals(fns.map((f) => f.name).sort(), OXIPNG_IMPORTS, "the exact nine imports");
  assert(!fns.some((f) => /atomic|thread/.test(f.name)), "no atomics/threads");
  const exportsList = WebAssembly.Module.exports(mod).map((e) => `${e.name}:${e.kind}`);
  assert(exportsList.includes("_start:function") && exportsList.includes("memory:memory"), `a WASI command (${exportsList})`);
  const audit = auditWasmBinary(bytes, {
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    memory: { tier: "default", maxPages: 2048 },
  });
  assertEquals(audit.measured.memoryMax, 2048, "declared max memory is the default tier ceiling");
});

Deno.test("oxipng: the pinned sha256 is the real committed CAS artifact", async () => {
  const bytes = await Deno.readFile(`extension/wasm/cas/${OXIPNG_SHA256}.wasm`);
  assertEquals(await sha256Hex(bytes), OXIPNG_SHA256, "CAS address IS the content hash");
});

Deno.test("oxipng: the evidence tree proves byte-for-byte reproducibility (build-a == build-b)", async () => {
  const a = await Deno.readFile("packages/bundled/evidence/oxipng/build-a/oxipng.wasm");
  const b = await Deno.readFile("packages/bundled/evidence/oxipng/build-b/oxipng.wasm");
  assertEquals(await sha256Hex(a), OXIPNG_SHA256, "build-a is the shipped artifact");
  assertEquals(await sha256Hex(b), OXIPNG_SHA256, "build-b reproduces it exactly");
  const sums = await Deno.readTextFile("packages/bundled/evidence/oxipng/SHA256SUMS");
  assert(sums.includes(OXIPNG_SHA256), "SHA256SUMS pins the same artifact");
});

Deno.test("oxipng: manifest declares the default tier, read-only replay, compute, and the MIT AND Apache-2.0 composite with its notices", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.oxipng-1.0.0.manifest.json"));
  assertEquals(manifest.package.id, "cap.bundled.oxipng");
  // oxipng (crate) and libdeflate (C) are MIT-only; libdeflater/libdeflate-sys
  // and the CAP-authored driver are Apache-2.0 — a composite, like toml2json.
  assertEquals(manifest.license.spdx, "MIT AND Apache-2.0");
  assertEquals(manifest.license.notices, "extension/wasm/licenses/oxipng-NOTICES.txt");
  const notices = await Deno.readTextFile(manifest.license.notices);
  for (const needle of ["oxipng", "libdeflate", "Joshua Holmer", "Eric Biggers", "Apache-2.0", "MIT AND Apache-2.0"]) {
    assert(notices.includes(needle), `notices name ${needle}`);
  }
  const exec = manifest.executables[0];
  assertEquals(exec.memory.tier, "default");
  assertEquals(exec.memory.maxPages, 2048);
  assertEquals(exec.imports.allowed, ["wasi_snapshot_preview1"]);
  assertEquals(exec.replayClass, "read-only");
  assertEquals(exec.capabilities, ["compute"]);
  assertEquals(exec.sha256, OXIPNG_SHA256);
  assertEquals(exec.size, OXIPNG_BYTES);
  const sbom = JSON.parse(await Deno.readTextFile(manifest.sbom.ref));
  const names = sbom.components.map((c) => c.name);
  for (const needle of ["oxipng", "libdeflater", "libdeflate-sys", "libdeflate"]) assert(names.includes(needle), `SBOM lists ${needle}`);
  assert(!names.some((n) => /rayon|zopfli|clap/.test(n)), "no parallel/zopfli/CLI crates in the shipped graph");
});

Deno.test("oxipng: admitted, and its binary stdout rides the tool boundary as base64 (the stdoutEncoding row)", () => {
  assert(PREVIEW_TOOL_IDS.includes("oxipng"), "oxipng is in the admitted spec map");
  // Without the row, the transcript would show the PNG bytes as mojibake.
  assertEquals(previewStdoutEncoding("oxipng", []), "base64");
  assertEquals(previewStdoutEncoding("oxipng", ["-o", "4", "--strip", "all"]), "base64");
});

Deno.test("oxipng: runs through the REAL stream worker — pixels identical, dimensions kept, fewer bytes; garbage fails closed", async () => {
  const row = BUNDLED_TOOL_PACKAGE_ROWS.find((candidate) => candidate.toolId === "oxipng");
  assert(row, "oxipng is in the bundled inventory");
  const wasmBytes = await Deno.readFile(`extension/wasm/cas/${row.binary.sha256}.wasm`);

  const { storage } = memoryStorage();
  const owner = "agent:run-oxipng:hub";
  const authority = buildPreviewAuthority({ origin: "https://agent.cap", documentId: "run-oxipng", now: () => 1 });
  const quota = {
    hostCalls: Number.POSITIVE_INFINITY, pathCalls: 4096,
    stdinBytes: Number.POSITIVE_INFINITY, stdoutBytes: Number.POSITIVE_INFINITY,
    stderrBytes: Number.POSITIVE_INFINITY, fileBytes: Number.POSITIVE_INFINITY,
    fileSize: Number.POSITIVE_INFINITY, dynamicFds: 256,
  };
  const b64 = (bytes) => {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  // Production contract: PNG bytes ride stdin as BASE64 TEXT (the tool
  // protocol's stdin is a JSON string); the tool decodes in-wasm and writes
  // raw PNG bytes, which the stream window hands back as base64.
  async function run(args, stdinText) {
    const inputRef = await createWasmStreamInput({ owner, storage });
    await appendWasmStreamInput({ ref: inputRef, owner, bytes: new TextEncoder().encode(stdinText), storage });
    await sealWasmStreamInput({ ref: inputRef, owner, storage });
    const outputRef = await createWasmStreamOutput({ owner, storage });
    const job = buildPreviewJob({ input: validatePreviewInput({ toolId: "oxipng", args, stdin: "" }), authority, quota });
    const result = await executeWasmStreamJob({ wasmBytes, job, owner, inputRef, outputRef, toolId: "oxipng" }, { storage, authority });
    if (!result.ok || result.exitCode !== 0) return { ok: false, exitCode: result.exitCode, error: result.error };
    await sealWasmStreamOutput({ ref: outputRef, owner, bytes: result.receipt.stdoutBytes, receipt: result.receipt, storage });
    const window = await readWasmStreamWindow({ ref: outputRef, owner, offset: 0, length: result.receipt.stdoutBytes, storage });
    return { ok: true, bytes: Uint8Array.from(atob(window.base64), (c) => c.charCodeAt(0)) };
  }

  const input = await fixturePng();
  const before = await decodeRgba8(input);
  assertEquals([before.width, before.height], [48, 48]);

  // Default effort: a valid PNG, same geometry, strictly fewer bytes (the
  // naive filter-0 encoding leaves real headroom), and the SAME pixels.
  const out = await run([], b64(input));
  assert(out.ok, `default run failed: ${out.error ?? out.exitCode}`);
  const after = await decodeRgba8(out.bytes);
  assertEquals([after.width, after.height], [before.width, before.height], "dimensions preserved");
  assertEquals(after.pixels, before.pixels, "every RGBA byte identical after optimisation");
  assert(out.bytes.length < input.length, `optimised (${out.bytes.length}) is smaller than the input (${input.length})`);

  // Effort 0 + strip all: still valid, still the same pixels, never larger.
  const fast = await run(["-o", "0", "--strip", "all"], b64(input));
  assert(fast.ok, `-o 0 run failed: ${fast.error ?? fast.exitCode}`);
  assertEquals((await decodeRgba8(fast.bytes)).pixels, before.pixels, "-o 0 keeps the pixels");
  assert(fast.bytes.length <= input.length, "never hands back a larger file");

  // Garbage fails CLOSED (non-zero exit), never a silent empty output:
  // not base64, base64 of something that is not a PNG, and a bad effort level.
  for (const [args, stdin, what] of [
    [[], "not base64!!", "non-base64 stdin"],
    [[], btoa("hello, not a png"), "base64 of a non-PNG"],
    [["-o", "9"], b64(input), "an out-of-range effort level"],
  ]) {
    const bad = await run(args, stdin);
    assert(bad.ok === false, `${what} must fail closed`);
  }
});

Deno.test("oxipng: resolves to the media-images purpose group", () => {
  assertEquals(toolPurposeGroup("oxipng"), "media-images");
});

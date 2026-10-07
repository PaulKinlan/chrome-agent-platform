// @ts-nocheck
// Call-export lane admission (chrome-agent-platform-uslb): the authority's
// callExport ABI declaration + the CAP-authored harness running the REAL
// hash-wasm blake3 module (zero imports, no package JS).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  auditWasmBinary,
  WasmPackageAuthority,
  WasmPackageAuthorityError,
} from "../extension/lib/wasm-package-authority.js";
import { executeCallexportRun } from "../extension/lib/wasm-callexport-host.js";

const enc = new TextEncoder();
const leb = (value) => {
  const out = [];
  let n = value >>> 0;
  do { let byte = n & 0x7f; n >>>= 7; if (n) byte |= 0x80; out.push(byte); } while (n);
  return out;
};
const section = (id, payload) => new Uint8Array([id, ...leb(payload.length), ...payload]);
const moduleBytes = (...sections) => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flatMap((v) => [...v])]);
const memorySection = () => section(5, [1, 1, 1, 2]); // min 1 max 2
const asciiName = (v) => [v.length, ...enc.encode(v)];
const functionImport = () => section(2, [1, ...asciiName("env"), ...asciiName("helper"), 0, 0]);
// An export section declaring "entry" + "inputBuffer" functions + "memory".
const exportSection = () => section(7, [
  3,
  ...asciiName("entry"), 0, 0,
  ...asciiName("inputBuffer"), 0, 0,
  ...asciiName("memory"), 2, 0,
]);

const CALLEXPORT_SPEC = Object.freeze({ entry: "Hash_Calculate", inputBuffer: "Hash_GetBuffer", digestBytes: 32 });

const expectCode = async (fn, code) => {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught instanceof WasmPackageAuthorityError, `expected ${code}, got ${caught?.name}: ${caught?.message}`);
  assertEquals(caught.code, code);
};

Deno.test("callexport: the real blake3 module passes the audit with its declared ABI", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/hashwasm-blake3/binaries/blake3.wasm");
  const executable = {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: CALLEXPORT_SPEC,
  };
  const audit = auditWasmBinary(bytes, executable, {});
  assertEquals(audit.ok, true);
  assertEquals(audit.imports.length, 0, "zero imports by measurement");
});

Deno.test("callexport: a module WITH an import fails closed (declaration AND measurement)", async () => {
  const bytes = moduleBytes(functionImport(), memorySection(), exportSection());
  // env import: the generic gate fires first (env is never allowed bundled).
  await expectCode(() => auditWasmBinary(bytes, {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: ["env"], disallowed: [] },
    callExport: { entry: "entry", inputBuffer: "inputBuffer", digestBytes: 32 },
  }, {}), "import_not_allowed");
  // A wasi import that IS in the bundled set: the call-export rule fires —
  // zero imports is the lane's definition, measured, not declared.
  await expectCode(() => auditWasmBinary(bytes, {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    callExport: { entry: "entry", inputBuffer: "inputBuffer", digestBytes: 32 },
  }, {}), "import_not_allowed");
  // Even when the probe allows the module, the export check fires for the
  // wasi-imported module (import section present at all).
  const bytes2 = moduleBytes(section(2, [1, ...asciiName("wasi_snapshot_preview1"), ...asciiName("fd_write"), 0, 0]), memorySection(), exportSection());
  await expectCode(() => auditWasmBinary(bytes2, {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: ["wasi_snapshot_preview1"], disallowed: [] },
    callExport: { entry: "entry", inputBuffer: "inputBuffer", digestBytes: 32 },
  }, {}), "callexport_imports_present");
});

Deno.test("callexport: a manifest declaring a NON-EXISTENT export fails closed", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/hashwasm-blake3/binaries/blake3.wasm");
  const executable = {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: { entry: "Hash_DoesNotExist", inputBuffer: "Hash_GetBuffer", digestBytes: 32 },
  };
  await expectCode(() => auditWasmBinary(bytes, executable, {}), "callexport_entry_missing");
});

Deno.test("callexport: manifest validation rejects callExport with non-empty allowed imports", async () => {
  const authority = new WasmPackageAuthority({ now: () => 1 });
  const bytes = await Deno.readFile("packages/bundled/evidence/hashwasm-blake3/binaries/blake3.wasm");
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.jq-1.0.0.manifest.json"));
  // Re-dress the jq manifest as a call-export package with a nonzero allowed list.
  manifest.executables[0].sha256 = sha;
  manifest.executables[0].size = bytes.byteLength;
  manifest.executables[0].callExport = CALLEXPORT_SPEC;
  manifest.executables[0].imports = { allowed: ["wasi_snapshot_preview1"], disallowed: [] };
  const res = authority.validateManifest(JSON.stringify(manifest));
  assertEquals(res.ok, false);
  assertEquals(res.error, "callexport_imports_nonzero");
});

Deno.test("callexport: the harness runs the REAL module — known blake3 vectors", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/hashwasm-blake3/binaries/blake3.wasm");
  const executable = {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: CALLEXPORT_SPEC,
  };
  // Official BLAKE3 test vectors (BLAKE3-team/BLAKE3 test_vectors.json).
  const empty = await executeCallexportRun({ wasmBytes: bytes, executable, data: btoa("") });
  assertEquals(empty, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
  const abc = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data: btoa("abc"),
  });
  assertEquals(abc, "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85");
});

Deno.test("callexport: non-base64 input and missing spec fail closed", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/hashwasm-blake3/binaries/blake3.wasm");
  const executable = {
    memory: { tier: "tiny", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: CALLEXPORT_SPEC,
  };
  let caught = null;
  try { await executeCallexportRun({ wasmBytes: bytes, executable, data: "!!!not-base64!!!" }); } catch (e) { caught = e; }
  assert(caught, "non-base64 input throws");
  assert(String(caught.message).includes("input_not_base64"), caught.message);
  caught = null;
  try { await executeCallexportRun({ wasmBytes: bytes, executable: { memory: { tier: "tiny", maxPages: 512 }, imports: { allowed: [], disallowed: [] } }, data: btoa("x") }); } catch (e) { caught = e; }
  assert(caught && String(caught.message).includes("no_callexport_spec"), "missing spec refuses");
});

const extractHashWasm = (name) => {
  try {
    return Deno.readFileSync(`packages/bundled/evidence/hashwasm/binaries/${name}.wasm`);
  } catch {
    const cmd = new Deno.Command("tar", {
      args: ["-xOzf", "packages/bundled/evidence/hashwasm-blake3/hash-wasm-4.12.0.tgz", `package/dist/${name}.umd.min.js`],
    });
    const { stdout } = cmd.outputSync();
    const text = new TextDecoder().decode(stdout);
    const blobs = text.match(/[A-Za-z0-9+/=]{500,}/g);
    if (!blobs || blobs.length !== 1) throw new Error(`expected exactly one blob for ${name}`);
    const binStr = atob(blobs[0]);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
    return bytes;
  }
};

Deno.test("callexport: sha224 with initParam 224 matches library vector while initParam 0 yields sha256 (falsification)", async () => {
  const bytes = extractHashWasm("sha256");
  const data = btoa("hello");
  // SHA-224 mode (initParam = 224, digestBytes = 28)
  const sha224Result = await executeCallexportRun({
    wasmBytes: bytes,
    executable: {
      memory: { tier: "tiny", maxPages: 512 },
      imports: { allowed: [], disallowed: [] },
      callExport: { entry: "Hash_Calculate", inputBuffer: "Hash_GetBuffer", digestBytes: 28, initParam: 224 },
    },
    data,
  });
  // Standard SHA-224 digest for "hello"
  assertEquals(sha224Result, "ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193");

  // With initParam = 0 (or default), the exact SAME bytes execute SHA-256 and truncate to 28 bytes
  const sha256TruncResult = await executeCallexportRun({
    wasmBytes: bytes,
    executable: {
      memory: { tier: "tiny", maxPages: 512 },
      imports: { allowed: [], disallowed: [] },
      callExport: { entry: "Hash_Calculate", inputBuffer: "Hash_GetBuffer", digestBytes: 28, initParam: 0 },
    },
    data,
  });
  // First 28 bytes (56 hex chars) of SHA-256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362
  assertEquals(sha256TruncResult, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362");
  assert(sha224Result !== sha256TruncResult, "initParam MUST differentiate sha224 from sha256");
});

Deno.test("callexport: sha3 with finalParam 0x06 matches library vector while absent finalParam does NOT (falsification)", async () => {
  const bytes = extractHashWasm("sha3");
  const data = btoa("hello");
  // SHA3-256 mode (initParam = 256, digestBytes = 32, finalParam = 0x06 padding)
  const sha3Result = await executeCallexportRun({
    wasmBytes: bytes,
    executable: {
      memory: { tier: "tiny", maxPages: 512 },
      imports: { allowed: [], disallowed: [] },
      callExport: { entry: "Hash_Calculate", inputBuffer: "Hash_GetBuffer", digestBytes: 32, initParam: 256, finalParam: 0x06 },
    },
    data,
  });
  // Standard SHA3-256 digest for "hello"
  assertEquals(sha3Result, "3338be694f50c5f338814986cdf0686453a888b84f424d792af4b9202398f392");

  // Old behavior: finalParam absent -> falls back to digestBytes (32 = 0x20 padding), producing non-standard result
  const oldResult = await executeCallexportRun({
    wasmBytes: bytes,
    executable: {
      memory: { tier: "tiny", maxPages: 512 },
      imports: { allowed: [], disallowed: [] },
      callExport: { entry: "Hash_Calculate", inputBuffer: "Hash_GetBuffer", digestBytes: 32, initParam: 256 },
    },
    data,
  });
  assert(oldResult !== sha3Result, "finalParam MUST differentiate standard SHA3 padding 0x06 from digestBytes fallback");
});

Deno.test("callexport: manifest validation rejects out-of-range initParam and finalParam", async () => {
  const authority = new WasmPackageAuthority({ now: () => 1 });
  const manifestText = await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.blake3-1.0.0.manifest.json");

  // initParam < 0
  const m1 = JSON.parse(manifestText);
  m1.executables[0].callExport.initParam = -1;
  const res1 = authority.validateManifest(JSON.stringify(m1));
  assertEquals(res1.ok, false);
  assertEquals(res1.error, "callexport_initparam_invalid");

  // initParam > 0xffffffff (uint32 overflow)
  const m2 = JSON.parse(manifestText);
  m2.executables[0].callExport.initParam = 0x1_0000_0000;
  const res2 = authority.validateManifest(JSON.stringify(m2));
  assertEquals(res2.ok, false);
  assertEquals(res2.error, "callexport_initparam_invalid");

  // finalParam < 0
  const m3 = JSON.parse(manifestText);
  m3.executables[0].callExport.finalParam = -1;
  const res3 = authority.validateManifest(JSON.stringify(m3));
  assertEquals(res3.ok, false);
  assertEquals(res3.error, "callexport_finalparam_invalid");

  // finalParam > 0xff (uint8 overflow)
  const m4 = JSON.parse(manifestText);
  m4.executables[0].callExport.finalParam = 256;
  const res4 = authority.validateManifest(JSON.stringify(m4));
  assertEquals(res4.ok, false);
  assertEquals(res4.error, "callexport_finalparam_invalid");
});

Deno.test("callexport: all 14 admitted hash tools run through the harness and match KAT vectors", async () => {
  const EXPECTED_HELLO_VECTORS = {
    hash_md4: "866437cb7a794bce2b727acc0362ee27",
    hash_sha1: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    hash_sha224: "ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193",
    hash_sha384: "59e1748777448c69de6b800d7a33bbfb9ff1b463e44354c3553bcdb9c666fa90125a3c79f90397bdf5f6a13de828684f",
    hash_sha3_256: "3338be694f50c5f338814986cdf0686453a888b84f424d792af4b9202398f392",
    hash_blake2b: "e4cfa39a3d37be31c59609e807970799caa68a19bfaa15135f165085e01d41a65ba1e1b146aeb6bd0092b49eac214c103ccfa3a365954bbbe52f74a2b3620c94",
    hash_blake2s: "19213bacc58dee6dbde3ceb9a47cbb330b3d86f8cca8997eb00be456f140ca25",
    hash_ripemd160: "108f07b8382412612c048d07d13f814118445acd",
    hash_sm3: "becbbfaae6548b8bf0cfcad5a27183cd1be6093b1cceccc303d9c61d0a645268",
    hash_whirlpool: "0a25f55d7308eca6b9567a7ed3bd1b46327f0f1ffdc804dd8bb5af40e88d78b88df0d002a89e2fdbd5876c523f1b67bc44e9f87047598e7548298ea1c81cfd73",
    hash_adler32: "062c0215",
    hash_crc32: "3610a686",
    hash_xxhash32: "fb0077f9",
    hash_blake3: "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f",
  };

  for (const [toolId, expectedHash] of Object.entries(EXPECTED_HELLO_VECTORS)) {
    const pkgId = `cap.bundled.${toolId.replace(/_/g, ".")}`;
    const manifestPath = `extension/wasm/manifests/${pkgId}-1.0.0.manifest.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    const exec = manifest.executables[0];
    const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);
    const actual = await executeCallexportRun({
      wasmBytes: bytes,
      executable: exec,
      data: btoa("hello"),
    });
    assertEquals(actual, expectedHash, `${toolId} known-answer vector for 'hello'`);
  }
});



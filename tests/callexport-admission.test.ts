// @ts-nocheck
// Call-export lane admission (chrome-agent-platform-uslb): the authority's
// callExport ABI declaration + the CAP-authored harness running the REAL
// hash-wasm blake3 module (zero imports, no package JS).
import { assert, assertEquals, assertStringIncludes, assertRejects } from "jsr:@std/assert@1";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import {
  auditWasmBinary,
  WasmPackageAuthority,
  WasmPackageAuthorityError,
} from "../extension/lib/wasm-package-authority.js";
import { CALLEXPORT_RUN_TYPE, executeCallexportRun } from "../extension/lib/wasm-callexport-host.js";
import { executableBundledToolRecords } from "../extension/lib/lazy-tool-protocol.js";
import { BUNDLED_TOOL_PACKAGE_ROWS } from "../extension/lib/bundled-tool-packages.data.js";

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

Deno.test("callexport: hashwasm_stream manifests validate strictly and reject wrong shapes (bwxf)", async () => {
  const authority = new WasmPackageAuthority({ now: () => 1 });
  const manifestText = await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.crc64-1.0.0.manifest.json");
  assertEquals(authority.validateManifest(manifestText).ok, true, "the admitted crc64 streaming manifest validates");
  // A v1-only field (initParam) is not part of the streaming key set.
  const extra = JSON.parse(manifestText);
  extra.executables[0].callExport.initParam = 7;
  assertEquals(authority.validateManifest(JSON.stringify(extra)).ok, false, "unknown key under hashwasm_stream is rejected");

  // A wrong-length seedHex is rejected (must be exactly seedBytes*2 hex chars).
  const shortSeed = JSON.parse(manifestText);
  shortSeed.executables[0].callExport.seedHex = "c96c5795";
  assertEquals(authority.validateManifest(JSON.stringify(shortSeed)).ok, false, "seedHex length mismatch is rejected");

  // A non-hex seedHex is rejected.
  const badSeed = JSON.parse(manifestText);
  badSeed.executables[0].callExport.seedHex = "zzzz5795d7870f42";
  assertEquals(authority.validateManifest(JSON.stringify(badSeed)).ok, false, "non-hex seedHex is rejected");

  // The audited binary must export every export the drive calls: drop
  // Hash_Update from the declared spec and the AUDIT (not just the validator)
  // must fail with callexport_entry_missing.
  const manifest = JSON.parse(manifestText);
  const exec = manifest.executables[0];
  const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);
  const broken = JSON.parse(manifestText);
  broken.executables[0].callExport.updateEntry = "Hash_Update_Missing";
  let threw = null;
  try {
    auditWasmBinary(bytes, broken.executables[0]);
  } catch (error) {
    threw = error;
  }
  assert(threw instanceof WasmPackageAuthorityError, "a missing streaming export fails the binary audit");
  assertEquals(threw?.code, "callexport_entry_missing");
  // And the real binary passes the audit as admitted.
  assertEquals(auditWasmBinary(bytes, exec).ok, true, "the admitted crc64 binary passes the audit");
});

// nlx4o (bwxf follow-up): the BOUNDS on the streaming spec fields are enforced
// but were untested — nothing exercised 0/4097 digestBytes or 0/65 seedBytes,
// so the refusals rested on code reading. These pins prove each bound fails
// closed with its typed error against the REAL manifest + REAL binary.
Deno.test("callexport: hashwasm_stream bound refusals fail closed with typed errors (nlx4o)", async () => {
  const authority = new WasmPackageAuthority({ now: () => 1 });
  const manifestText = await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.crc64-1.0.0.manifest.json");

  function mutated(mutate: (callExport: Record<string, unknown>) => void) {
    const m = JSON.parse(manifestText);
    mutate(m.executables[0].callExport);
    return authority.validateManifest(JSON.stringify(m));
  }

  // digestBytes: 0 and 4097 are both outside 1..4096.
  assertEquals(mutated((c) => { c.digestBytes = 0; }).error, "callexport_digest_invalid");
  assertEquals(mutated((c) => { c.digestBytes = 4097; }).error, "callexport_digest_invalid");

  // seedBytes: 0 and 65 are both outside 1..64.
  assertEquals(mutated((c) => { c.seedBytes = 0; }).error, "callexport_seed_invalid");
  assertEquals(mutated((c) => { c.seedBytes = 65; }).error, "callexport_seed_invalid");

  // seedHex must be exactly seedBytes*2 lowercase hex chars.
  assertEquals(mutated((c) => { c.seedHex = "c96c5795d7870f"; }).error, "callexport_seedhex_invalid");
  assertEquals(mutated((c) => { c.seedHex = "C96C5795D7870F42"; }).error, "callexport_seedhex_invalid");

  // The bound values themselves ADMIT: digestBytes 4096 and seedBytes 64 pass
  // validation (the ranges are inclusive), proving the refusals are the BOUNDS
  // and not some other shape check.
  const wide = JSON.parse(manifestText);
  wide.executables[0].callExport.digestBytes = 4096;
  wide.executables[0].callExport.seedBytes = 64;
  wide.executables[0].callExport.seedHex = "ab".repeat(64);
  const wideResult = authority.validateManifest(JSON.stringify(wide));
  assertEquals(wideResult.ok, true, `inclusive bounds admit (got ${wideResult.error})`);
});

Deno.test("callexport: v1 callExport digestBytes bound refusals fail closed (yiy1x)", async () => {
  const authority = new WasmPackageAuthority({ now: () => 1 });
  const manifestText = await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.blake3-1.0.0.manifest.json");

  function mutated(mutate: (callExport: Record<string, unknown>) => void) {
    const m = JSON.parse(manifestText);
    mutate(m.executables[0].callExport);
    return authority.validateManifest(JSON.stringify(m));
  }

  // v1 digestBytes bound: 0 and 4097 are both outside 1..4096.
  assertEquals(mutated((c) => { c.digestBytes = 0; }).error, "callexport_digest_invalid");
  assertEquals(mutated((c) => { c.digestBytes = 4097; }).error, "callexport_digest_invalid");

  // Inclusive edge 4096 admits:
  const wide = JSON.parse(manifestText);
  wide.executables[0].callExport.digestBytes = 4096;
  const wideResult = authority.validateManifest(JSON.stringify(wide));
  assertEquals(wideResult.ok, true, `v1 inclusive bound admits (got ${wideResult.error})`);
});

Deno.test("callexport: hashwasm_stream seedHex validation and out-of-bounds digest read fail closed (ldgv0)", async () => {
  const manifestText = await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.crc64-1.0.0.manifest.json");
  const manifest = JSON.parse(manifestText);
  const exec = manifest.executables[0];
  const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);

  // 1. Invalid seedHex (bypassing manifest validator) fails closed with seed_hex_invalid
  // ldgv0 / mjkxu / o7fpl: fully invalid, trailing non-hex, leading whitespace, over-long,
  // trailing newline, short, empty, and non-string must all fail closed with seed_hex_invalid.
  for (const badHex of [
    "zz".repeat(exec.callExport.seedBytes),
    "c96c5795d7870f4z",
    " 96c5795d7870f42",
    "00c96c5795d7870f42",
    "c96c5795d7870f42ab",
    "c96c5795d7870f42\n",
    "c96c5795",
    "",
    null,
  ]) {
    const badSeedExec = JSON.parse(JSON.stringify(exec));
    badSeedExec.callExport.seedHex = badHex;
    await assertRejects(
      () => executeCallexportRun({
        wasmBytes: bytes,
        executable: badSeedExec,
        data: btoa("test"),
      }),
      Error,
      "seed_hex_invalid",
    );
  }

  // 2. Out-of-bounds digestBytes fails closed with digest_read_failed
  const oobExec = JSON.parse(JSON.stringify(exec));
  oobExec.callExport.digestBytes = 100_000_000; // far exceeds wasm memory buffer
  await assertRejects(
    () => executeCallexportRun({
      wasmBytes: bytes,
      executable: oobExec,
      data: btoa("test"),
    }),
    Error,
    "digest_read_failed",
  );

  // 3. Non-integer or out-of-range seedBytes fails closed with seed_hex_invalid (0i716)
  for (const badSeedBytes of [8.5, "8", 0, 65, NaN, Infinity]) {
    const badBytesExec = JSON.parse(JSON.stringify(exec));
    badBytesExec.callExport.seedBytes = badSeedBytes;
    if (typeof badSeedBytes === "number" && Number.isFinite(badSeedBytes)) {
      badBytesExec.callExport.seedHex = "a".repeat(Math.floor(badSeedBytes * 2));
    }
    await assertRejects(
      () => executeCallexportRun({
        wasmBytes: bytes,
        executable: badBytesExec,
        data: btoa("test"),
      }),
      Error,
      "seed_hex_invalid",
    );
  }
});

Deno.test("callexport: all 21 admitted hash tools run through the harness and match KAT vectors", async () => {
  const EXPECTED_HELLO_VECTORS = {
    hash_md4: "866437cb7a794bce2b727acc0362ee27",
    hash_sha1: "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d",
    hash_sha224: "ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193",
    hash_sha384: "59e1748777448c69de6b800d7a33bbfb9ff1b463e44354c3553bcdb9c666fa90125a3c79f90397bdf5f6a13de828684f",
    hash_sha3_256: "3338be694f50c5f338814986cdf0686453a888b84f424d792af4b9202398f392",
    hash_sha3_384: "720aea11019ef06440fbf05d87aa24680a2153df3907b23631e7177ce620fa1330ff07c0fddee54699a4c3ee0ee9d887",
    hash_sha3_512: "75d527c368f2efe848ecf6b073a36767800805e9eef2b1857d5f984f036eb6df891d75f72d9b154518c1cd58835286d1da9a38deba3de98b5a53e5ed78a84976",
    hash_keccak_256: "1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8",
    hash_blake2b: "e4cfa39a3d37be31c59609e807970799caa68a19bfaa15135f165085e01d41a65ba1e1b146aeb6bd0092b49eac214c103ccfa3a365954bbbe52f74a2b3620c94",
    hash_blake2s: "19213bacc58dee6dbde3ceb9a47cbb330b3d86f8cca8997eb00be456f140ca25",
    hash_ripemd160: "108f07b8382412612c048d07d13f814118445acd",
    hash_sm3: "becbbfaae6548b8bf0cfcad5a27183cd1be6093b1cceccc303d9c61d0a645268",
    hash_whirlpool: "0a25f55d7308eca6b9567a7ed3bd1b46327f0f1ffdc804dd8bb5af40e88d78b88df0d002a89e2fdbd5876c523f1b67bc44e9f87047598e7548298ea1c81cfd73",
    hash_adler32: "062c0215",
    hash_crc32: "3610a686",
    hash_xxhash32: "fb0077f9",
    hash_blake3: "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f",
    // hash-wasm wave 2 (chrome-agent-platform-bwxf): the streaming family —
    // measured against the pinned 4.12.0 binaries through the hashwasm_stream
    // ABI (seed 0; crc64 = CRC-64/XZ polynomial c96c5795d7870f42).
    hash_xxhash64: "26c7827d889f6da3",
    hash_xxhash3: "9555e8555c62dcfd",
    hash_xxhash128: "b5e9c1ad071b3e7fc779cfaa5e523818",
    hash_crc64: "9b1edae5dbb937b1",
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

Deno.test("callexport: the real chacha_poly1305 module passes the audit with abi declaration", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/awasm-chacha/binaries/chacha_poly1305.wasm");
  const executable = {
    memory: { tier: "default", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: { abi: "chacha20_poly1305" },
  };
  const audit = auditWasmBinary(bytes, executable, {});
  assertEquals(audit.ok, true);
  assertEquals(audit.imports.length, 0, "zero imports by measurement");
});

Deno.test("callexport: the harness runs chacha20_poly1305 round-trip encrypt and decrypt", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/awasm-chacha/binaries/chacha_poly1305.wasm");
  const executable = {
    memory: { tier: "default", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: { abi: "chacha20_poly1305" },
  };
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const nonce = btoa(String.fromCharCode(...new Uint8Array(12).fill(3)));
  const plaintext = "Hello from CAP call-export lane with ChaCha20-Poly1305!";
  const data = btoa(plaintext);

  // Encrypt
  const encResult = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data,
    args: { key, nonce, data, mode: "encrypt" },
  });
  assertEquals(encResult.algorithm, "chacha20_poly1305");
  assertEquals(encResult.mode, "encrypt");
  assert(encResult.data && encResult.data !== data);

  // Decrypt
  const decResult = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data: encResult.data,
    args: { key, nonce, data: encResult.data, mode: "decrypt" },
  });
  assertEquals(decResult.algorithm, "chacha20_poly1305");
  assertEquals(decResult.mode, "decrypt");
  assertEquals(atob(decResult.data), plaintext);
});

Deno.test("callexport: chacha20_poly1305 authenticated data (AAD) binds to ciphertext", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/awasm-chacha/binaries/chacha_poly1305.wasm");
  const executable = {
    memory: { tier: "default", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: { abi: "chacha20_poly1305" },
  };
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
  const nonce = btoa(String.fromCharCode(...new Uint8Array(12).fill(4)));
  const data = btoa("Sensitive mission directive");
  const aad = btoa("authenticated-session-header");

  const enc = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data,
    args: { key, nonce, data, aad, mode: "encrypt" },
  });

  // Decrypt with matching AAD succeeds
  const dec = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data: enc.data,
    args: { key, nonce, data: enc.data, aad, mode: "decrypt" },
  });
  assertEquals(atob(dec.data), "Sensitive mission directive");

  // Decrypt with mismatched or missing AAD fails closed
  let caught = null;
  try {
    await executeCallexportRun({
      wasmBytes: bytes,
      executable,
      data: enc.data,
      args: { key, nonce, data: enc.data, aad: btoa("tampered-aad"), mode: "decrypt" },
    });
  } catch (err) { caught = err; }
  assert(caught, "mismatched AAD throws");
  assert(String(caught.message).includes("invalid_tag"), caught.message);
});

Deno.test("callexport: chacha20_poly1305 tampered ciphertext fails closed (invalid_tag)", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/awasm-chacha/binaries/chacha_poly1305.wasm");
  const executable = {
    memory: { tier: "default", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: { abi: "chacha20_poly1305" },
  };
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
  const nonce = btoa(String.fromCharCode(...new Uint8Array(12).fill(2)));
  const data = btoa("Confidential payload");

  const enc = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data,
    args: { key, nonce, data, mode: "encrypt" },
  });

  // Tamper with the raw ciphertext
  const rawBytes = Uint8Array.from(atob(enc.data), (c) => c.charCodeAt(0));
  rawBytes[0] ^= 0x01; // flip 1 bit
  const tamperedB64 = btoa(String.fromCharCode(...rawBytes));

  let caught = null;
  try {
    await executeCallexportRun({
      wasmBytes: bytes,
      executable,
      data: tamperedB64,
      args: { key, nonce, data: tamperedB64, mode: "decrypt" },
    });
  } catch (err) { caught = err; }
  assert(caught, "tampered ciphertext throws");
  assert(String(caught.message).includes("invalid_tag"), caught.message);
});

Deno.test("callexport: chacha20_poly1305 known-answer test — RFC 8439 §2.8.2 vector", async () => {
  const bytes = await Deno.readFile("packages/bundled/evidence/awasm-chacha/binaries/chacha_poly1305.wasm");
  const executable = {
    memory: { tier: "default", maxPages: 512 },
    imports: { allowed: [], disallowed: [] },
    callExport: { abi: "chacha20_poly1305" },
  };

  // RFC 8439 §2.8.2: key 80..9f (32 bytes)
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyBytes[i] = 0x80 + i;
  const key = btoa(String.fromCharCode(...keyBytes));

  // nonce: 070000004041424344454647 (12 bytes)
  const nonceBytes = new Uint8Array([0x07, 0x00, 0x00, 0x00, 0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
  const nonce = btoa(String.fromCharCode(...nonceBytes));

  // AAD: 50515253c0c1c2c3c4c5c6c7 (12 bytes)
  const aadBytes = new Uint8Array([0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7]);
  const aad = btoa(String.fromCharCode(...aadBytes));

  // Plaintext: "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
  const plaintext = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  const data = btoa(plaintext);

  // Expected ciphertext (hex):
  const expectedCtHex = "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116";
  // Expected tag (hex):
  const expectedTagHex = "1ae10b594f09e26a7e902ecbd0600691";

  // Encrypt
  const encResult = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data,
    args: { key, nonce, data, aad, mode: "encrypt" },
  });
  assertEquals(encResult.algorithm, "chacha20_poly1305");
  assertEquals(encResult.mode, "encrypt");

  // Verify ciphertext + tag bytes
  const outBytes = Uint8Array.from(atob(encResult.data), (c) => c.charCodeAt(0));
  const ctLen = outBytes.length - 16;
  const ctHex = [...outBytes.subarray(0, ctLen)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tagHex = [...outBytes.subarray(ctLen)].map((b) => b.toString(16).padStart(2, "0")).join("");

  assertEquals(ctHex, expectedCtHex, "ciphertext matches RFC 8439 §2.8.2 exactly");
  assertEquals(tagHex, expectedTagHex, "tag matches RFC 8439 §2.8.2 exactly");

  // Decrypt of KAT ciphertext + tag reproduces plaintext
  const decResult = await executeCallexportRun({
    wasmBytes: bytes,
    executable,
    data: encResult.data,
    args: { key, nonce, data: encResult.data, aad, mode: "decrypt" },
  });
  assertEquals(decResult.algorithm, "chacha20_poly1305");
  assertEquals(decResult.mode, "decrypt");
  assertEquals(atob(decResult.data), plaintext);
});

Deno.test("callexport: executableBundledToolRecords chacha20_poly1305 validator and SW envelope args (P2-1)", async () => {
  const records = executableBundledToolRecords(BUNDLED_TOOL_PACKAGE_ROWS, {
    scope: { hub: true, agentId: "hub", origin: "", documentId: "" },
  });
  const chachaRec = records.find((r) => r.descriptorInput.toolId === "chacha20_poly1305");
  assert(chachaRec, "chacha20_poly1305 executable record must exist");
  assert(typeof chachaRec.validateArguments === "function", "validateArguments must be a function");

  // 1. Invalid shape
  assertEquals((await chachaRec.validateArguments(null)).error, "invalid_arguments: shape");
  assertEquals((await chachaRec.validateArguments("string")).error, "invalid_arguments: shape");
  assertEquals((await chachaRec.validateArguments([])).error, "invalid_arguments: shape");

  // 2. Mismatched toolId
  assertEquals((await chachaRec.validateArguments({ toolId: "other" })).error, "invalid_arguments: toolId");

  // 3. Unexpected keys
  assertEquals((await chachaRec.validateArguments({ data: "aGk=", key: "k", nonce: "n", bogus: 123 })).error, "invalid_arguments: unexpected_keys");

  // 4. Required fields missing or wrong type
  assertEquals((await chachaRec.validateArguments({ key: "k", nonce: "n" })).error, "invalid_arguments: required_fields");
  assertEquals((await chachaRec.validateArguments({ data: "aGk=", nonce: "n" })).error, "invalid_arguments: required_fields");
  assertEquals((await chachaRec.validateArguments({ data: "aGk=", key: "k" })).error, "invalid_arguments: required_fields");
  assertEquals((await chachaRec.validateArguments({ data: 123, key: "k", nonce: "n" })).error, "invalid_arguments: required_fields");

  // 5. Invalid mode
  assertEquals((await chachaRec.validateArguments({ data: "aGk=", key: "k", nonce: "n", mode: "invalid" })).error, "invalid_arguments: mode");

  // 6. Invalid AAD
  assertEquals((await chachaRec.validateArguments({ data: "aGk=", key: "k", nonce: "n", aad: 42 })).error, "invalid_arguments: aad");

  // 7. Valid arguments -> frozen result with default mode "encrypt"
  const valid = await chachaRec.validateArguments({ data: "aGk=", key: "k", nonce: "n" });
  assertEquals(valid.ok, true);
  assertEquals(valid.data.toolId, "chacha20_poly1305");
  assertEquals(valid.data.mode, "encrypt");
  assertEquals(valid.data.data, "aGk=");
  assertEquals(valid.data.key, "k");
  assertEquals(valid.data.nonce, "n");
  assert(Object.isFrozen(valid.data), "validated arguments data must be frozen");

  // 8. Service Worker envelope carries args and references CALLEXPORT_RUN_TYPE
  assertEquals(CALLEXPORT_RUN_TYPE, "cap:wasm-callexport-run");
  const swCode = await Deno.readTextFile("extension/background/service-worker.js");
  assert(swCode.includes("type: CALLEXPORT_RUN_TYPE"), "service-worker must dispatch CALLEXPORT_RUN_TYPE");
  assert(swCode.includes("args: validatedArgs ?? {}"), "service-worker callexport envelope must forward args");
});


// z3raf: inputs over 16 KiB used to be written WHOLE into the fixed 16 KiB
// main_buffer (no bounds check inside the module) — silently corrupting the
// digest — while the advertised limit said 4 MiB. The host now streams any
// oversized input through the module's own Init/Update/Final with the SAME
// admitted params. Expected digests: the OFFICIAL hash-wasm 4.12.0 JS library
// from the SAME pinned tarball (its own glue, its own wasm), 9 of them
// independently cross-checked against node crypto/zlib at generation time.
Deno.test("callexport: wave-1 tools hash a 20 KiB input correctly via the streaming fallback (z3raf)", async () => {
  const input = new Uint8Array(20480);
  for (let i = 0; i < input.length; i++) input[i] = (i * 7 + 13) & 0xff;
  const data = btoa(String.fromCharCode(...input));
  const EXPECTED_20K: Record<string, string> = {
    hash_md4: "e919c9820a5164ffd29a0c2f705e2129",
    hash_sha1: "6b6d0103c2da1f737b0f375c1a67174e4b6e0b44",
    hash_sha224: "841f8dc23d2aa4974b6d43e529147cca578126d8c10282609ac8b6ff",
    hash_sha384: "a815d8086ddaed016faec1461af4b0b5b1da1ee0d1633332ddff28779233355c17a498a8779b010ebecd19827fdb6b64",
    hash_sha3_256: "d7a1aa30106ca965d5b0c325d2e67830c393bd3cd69a44fef9a1a7b4d1c73d73",
    hash_sha3_384: "99a1da5f657b207e04baada91b70d2f915248cc4ef55696c646cfe5d54880f86cb3091311dae052112d708ee119759be",
    hash_sha3_512: "f09edffb56b383215a8991e9846031447b1d26297c3c80f682138ad8af16ddd5140e830a020e8cb38c4bad9d15f3f4423b4a408ff7b615426d711ca47cf5e653",
    hash_keccak_256: "73002ae7df1962dac768ef52a67da924b16d9bf2af416faa6750014ed982e13d",
    hash_blake2b: "d6a96035e1acf72fa7fb949bf06a1120bd5244a3377476c018752abacce0698e72263fba50cb5f8cc2179f2cef8954d257680c96ea1c3e7a95038ac3b7a9d517",
    hash_blake2s: "509537e8b1096b8ccef046abe760bc9814ece08e80fba187b47cd4b175d3f537",
    hash_ripemd160: "4767d4543e97eb62ee0a1a3e5a427f1f05bd09c8",
    hash_sm3: "73fea2bcd92628221be24086469279bb563ca49ff7cd2b67457f4fb183a4b1b2",
    hash_whirlpool: "b77a6ea2e673b4115a8ab4f471e6490c5d7ed5eb84c5b6bc837caf94e5e38900aaf6b497938df6238552d3d13d134f495e8eb94b92303d0cd98c4c99929941d1",
    hash_blake3: "2362265bdd255312540c27141ee553641f3f8e68e7c8e0865776d309d60b090a",
    hash_adler32: "5d27da4a",
    hash_crc32: "045c3ef7",
    hash_xxhash32: "3291a957",
  };
  for (const [toolId, expectedHash] of Object.entries(EXPECTED_20K)) {
    const pkgId = `cap.bundled.${toolId.replace(/_/g, ".")}`;
    const manifestPath = `extension/wasm/manifests/${pkgId}-1.0.0.manifest.json`;
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    const exec = manifest.executables[0];
    const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);
    const actual = await executeCallexportRun({ wasmBytes: bytes, executable: exec, data });
    assertEquals(actual, expectedHash, `${toolId} streaming-fallback vector for a 20 KiB input`);
  }
});

// na5gy: falsifier test demonstrating that driving the module's raw unchunked
// Hash_Calculate directly (the pre-existing v1 defect) corrupts digests on inputs > 16 KiB
// by writing over main_buffer, while the fixed host streaming path returns the exact
// external reference digest.
Deno.test("callexport: falsifier — unchunked one-shot Hash_Calculate silently corrupts inputs > 16 KiB (na5gy)", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.sha1-1.0.0.manifest.json"));
  const exec = manifest.executables[0];
  const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);

  // Verify on 17 KiB (17408 bytes) and 64 KiB (65536 bytes)
  for (const size of [17408, 65536]) {
    const input = new Uint8Array(size);
    for (let i = 0; i < input.length; i++) input[i] = (i * 7 + 13) & 0xff;

    // Simulate the pre-existing unchunked one-shot drive: writes input into main_buffer (16 KiB)
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    const ex = instance.exports;
    const bufferPtr = ex.Hash_GetBuffer();
    const heap = new Uint8Array(ex.memory.buffer);
    heap.set(input, bufferPtr);
    ex.Hash_Calculate(input.byteLength, 0, 20);
    const corruptedOneShot = [...heap.subarray(bufferPtr, bufferPtr + 20)].map((b) => b.toString(16).padStart(2, "0")).join("");

    // External reference digest from node:crypto
    const expectedRef = crypto.createHash("sha1").update(input).digest("hex");

    // FALSIFICATION: unchunked one-shot drive produces a WRONG digest
    assert(corruptedOneShot !== expectedRef, `one-shot drive must produce corrupted digest at ${size} bytes`);

    // The fixed callexport host streams via Init/Update/Final and returns the EXACT reference digest
    const b64 = Buffer.from(input).toString("base64");
    const actual = await executeCallexportRun({ wasmBytes: bytes, executable: exec, data: b64 });
    assertEquals(actual, expectedRef, `callexport host must produce exact reference digest at ${size} bytes`);
  }
});

// na5gy: full-spectrum Known-Answer Tests (KAT) for all 17 wave-1 hash tools at
// 17 KiB (boundary), 64 KiB (multi-chunk), and 4 MiB (advertised maximum limit).
// Expected digests: official hash-wasm 4.12.0 reference implementation,
// cross-checked with node:crypto / node:zlib where supported.
Deno.test("callexport: wave-1 tools hash 17 KiB, 64 KiB and 4 MiB inputs correctly against external references (na5gy)", async () => {
  const EXPECTED_KAT: Record<string, Record<string, string>> = {
    "17K": {
      hash_md4: "3eba4d2313279a5dac1e88786ab93a08",
      hash_sha1: "cc65307d10a0927961547db84402bb63eb565296",
      hash_sha224: "0f0f600d6bbdb61ce429d8bcf7bc156797ab243fa7b1929888705283",
      hash_sha384: "dc0e6eff76d0f104866e111f49e0d5019acdb55536ad290e877111c360eb8058568b21b76c6e117e50565cc903c7c23b",
      hash_sha3_256: "91b3ca0213d8f27cc005526491addae2f56b3d1a1298d655a6be4094c50be852",
      hash_sha3_384: "463aa8f84e0fff02633d24187f58b8b6317797aab219de0985a0a434dbdb22f9ab4fa8fe7894bd6e7660b228d583493e",
      hash_sha3_512: "03bf54186c5c8ac06472b01767de42951bdd8652dd0f325d2bcbd9903d38d2c06f3fc3dde20f7fac116a1b8275bbed7d262f067cb9306e2b473a3ce21851e782",
      hash_keccak_256: "6bfdd2f35d4b2df33f22f8b22b90a1099878ba2f1f3b1842fc1c8eb327c0f568",
      hash_blake2b: "b325c7a8d8d2bd58c5affc7509aa0394a10b9cca4ba9029faeacd0e1c8586348ef8b7bdd5f16e7b6b9780b6bac6cc3135c2df1d4843a07a387d2fd7b1b49f725",
      hash_blake2s: "d19cf9055147b2a17abce7060f4e787a648e9d790a072f37e9bdb31e18877130",
      hash_ripemd160: "317dea656f4bb26b9a0053545ba2a86c14ddfe92",
      hash_sm3: "2f2810c6235e24b4300a068b10c636ae93fa04f75ecf6026d51f7d99fd2b4d0d",
      hash_whirlpool: "9032e43abf58217070d039bd1d3f3058b9423b0acd5afd19da9ff1f44c5589d4a95908c4ae439031ab5f422a8b3b7df0fd63849cca733e53998fc50fac49c7b9",
      hash_blake3: "5ef582ec05dd07a55b838635f04574dbeb4e325e1a297acb408b3265796b332a",
      hash_adler32: "733adff0",
      hash_crc32: "51d7d554",
      hash_xxhash32: "ebd6460b",
    },
    "64K": {
      hash_md4: "56c867958135525dd931841bb97f5916",
      hash_sha1: "ee27b888ba32926f4a8bef844c41a4fdc310d260",
      hash_sha224: "506bb8637faafd971a546835d2d48a0af0a43417cd90602231b2d4c8",
      hash_sha384: "a208940e418ecfd739638b3bf540e4af61a7ee8287fe81a1b272a52e2db40bad18b59552e877f2badaec9991b88b4914",
      hash_sha3_256: "0d3953d62b545e11bce6d21bb1d1d72200979b513b8aaf701848bdda735ba359",
      hash_sha3_384: "c9810849e8775b8805adc31d859476232645c599517b86e41519b006dbbc26462eba56b816ef02ac8022d8c28ac76eb0",
      hash_sha3_512: "ce379da9f8030820e5d83cf820b72bb8a40af33945d1cb7c451ff97e475f1fd709461170a5cb3e70d486a2214c856086ba0a76ae757a9a15900d0ca883c23204",
      hash_keccak_256: "d9afb8d99302af8fedc89ef075a910b0d7ce4d86ee841c015e971b2de06743ee",
      hash_blake2b: "20fbe09814ea098dd140825451e2d4eb080a5defe3de96adb8e99c35364a8034006d03f7a5d8f238187bc67687cd88837b11618f81baf8b2becc8199ddd6bca7",
      hash_blake2s: "efe80a45e860fb45e4de7438ad68f818a91262a99e2f27e5133c6c7a3ad9b037",
      hash_ripemd160: "3cb9968fd04aae4338dcf05258de575e66c51e96",
      hash_sm3: "23792073f324b5817a72fa3544991794de1300fcab79d9a8233f492c555c3a7f",
      hash_whirlpool: "909fc4ccd846cc23db8c52d4ddc58a3468722ed40ca809b06db02042c16d6f3f9faed14768c4d4d549fe55641ffdf73d1ba13519f9cef70134ac3d4cb077e558",
      hash_blake3: "38017a0ce98d2f0e8933beee8b2de470365ab73ee47185c6ee27b35d825ef3fd",
      hash_adler32: "56448772",
      hash_crc32: "80e78f7c",
      hash_xxhash32: "08bd96de",
    },
    "4M": {
      hash_md4: "d5680f2be97aad3165519799818b4c61",
      hash_sha1: "feb8d41630f87bd595d7199d6845199e9015976f",
      hash_sha224: "b9e6afff5d4ac93e7821038af452df2e3d76983f423d652388482851",
      hash_sha384: "5454543aed2ca8cddcbe5534350d1cab60df72f94d7b168864fec1bf1ea4262b411057198723f7682fecaf57e71b2827",
      hash_sha3_256: "e3004448f926f56fb9f043271017913a586ad4c4de3ef6ecbec02dfbe90f6205",
      hash_sha3_384: "f1d34f4264f4171520595025381f1a6af54185c694b3146d3f77c97d9f161011cc7515e4e75f6d651aa383378b64bace",
      hash_sha3_512: "8c1d634cff381793b917bff8ed0c0ac5c077de635ad91d9876c9e43384ed1cc4105bf5651eb6c67daacb649016da2f2d3a318a3a3da7b66ead91171890ab2d01",
      hash_keccak_256: "a8970e1eb248168faa69474b9061348f49e23341119d79bcb4d42396d6052041",
      hash_blake2b: "e3bc699586ae5ddd1db9918cbd8d5169672a5ea95fc760ace3c691294ad962cb430a1b0b13ffc383fc035a30c297726f94606124fcc10d778f39db21c3363732",
      hash_blake2s: "0e3ca28b3e9f2603e4b5f48fc23d5d0a6cece550536ef9f2187fb686261be163",
      hash_ripemd160: "1d76e73b6611d146e6b548f4f10448d18551a392",
      hash_sm3: "b6bab38fdf94ef1db68486ab4a66475e2b66aaf76944ac992d82630ba1fa211d",
      hash_whirlpool: "05c47d945800ebf8e9dc0e8bcc0b40341912b775728725833ac6c58c2ac5732d23096fe0077de13ea51e47f6783177e20c39eb88aa4d1fa1f536245a3d24a8f4",
      hash_blake3: "a92d9d227552a88c81ddbcee3794e259c9f34891a68f11e6f907707fb08eb6ef",
      hash_adler32: "4008de30",
      hash_crc32: "1fafde95",
      hash_xxhash32: "72a1aea1",
    },
  };

  const SIZES: Record<string, number> = {
    "17K": 17408,
    "64K": 65536,
    "4M": 4194304,
  };

  for (const [sizeLabel, sizeBytes] of Object.entries(SIZES)) {
    const input = new Uint8Array(sizeBytes);
    for (let i = 0; i < input.length; i++) input[i] = (i * 7 + 13) & 0xff;
    const data = Buffer.from(input).toString("base64");
    const expectedForSize = EXPECTED_KAT[sizeLabel];

    for (const [toolId, expectedHash] of Object.entries(expectedForSize)) {
      const pkgId = `cap.bundled.${toolId.replace(/_/g, ".")}`;
      const manifestPath = `extension/wasm/manifests/${pkgId}-1.0.0.manifest.json`;
      const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
      const exec = manifest.executables[0];
      const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);
      const actual = await executeCallexportRun({ wasmBytes: bytes, executable: exec, data });
      assertEquals(actual, expectedHash, `${toolId} streaming digest for ${sizeLabel} (${sizeBytes} bytes) matches external reference`);
    }
  }
});

// na5gy: verify that inputs strictly exceeding the advertised 4 MiB budget fail closed
Deno.test("callexport: input over 4 MiB advertised budget fails closed with input_over_budget (na5gy)", async () => {
  const manifest = JSON.parse(await Deno.readTextFile("extension/wasm/manifests/cap.bundled.hash.sha1-1.0.0.manifest.json"));
  const exec = manifest.executables[0];
  const bytes = await Deno.readFile(`extension/wasm/cas/${exec.sha256}.wasm`);

  // 4 MiB + 1 byte
  const overInput = new Uint8Array(4 * 1024 * 1024 + 1);
  const data = Buffer.from(overInput).toString("base64");

  await assertRejects(
    async () => {
      await executeCallexportRun({ wasmBytes: bytes, executable: exec, data });
    },
    Error,
    "input_over_budget",
  );
});

// na5gy / j8qy3: verify all 17 wave-1 hash tools declare the honest 4 MiB streaming caveat
Deno.test("callexport: all 17 wave-1 hash tool caveats declare the honest 4 MiB streaming contract (na5gy/j8qy3)", () => {
  const wave1ToolIds = [
    "hash_md4", "hash_sha1", "hash_sha224", "hash_sha384",
    "hash_sha3_256", "hash_sha3_384", "hash_sha3_512", "hash_keccak_256",
    "hash_blake2b", "hash_blake2s", "hash_ripemd160", "hash_sm3",
    "hash_whirlpool", "hash_blake3", "hash_adler32", "hash_crc32", "hash_xxhash32",
  ];
  for (const toolId of wave1ToolIds) {
    const row = BUNDLED_TOOL_PACKAGE_ROWS.find((r) => r.toolId === toolId);
    assert(row, `tool row for ${toolId} must exist`);
    const caveats = (row.caveats ?? []).join(" ");
    assert(
      caveats.includes("Hashing of base64 input up to 4 MiB; inputs over 16 KiB stream through the module in 16 KiB chunks."),
      `${toolId} must advertise honest 4 MiB streaming chunk caveat (got: ${caveats})`,
    );
    assert(!caveats.includes("no streaming API yet"), `${toolId} must not contain stale 'no streaming API yet' copy`);
  }
});


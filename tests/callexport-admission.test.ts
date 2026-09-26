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

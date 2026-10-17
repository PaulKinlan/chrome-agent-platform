// 9iyc: one physical hash-wasm module can serve distinct manifest-pinned ABI variants.
// These are pure claim tests: no production build or shared worktree artifact is needed.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { manifestCasMappings, recordBundledWasmClaim, registerBundledManifestIdentity } from "../scripts/lib/wasm-manifest-assets.mjs";

const baseline = JSON.parse(await Deno.readTextFile(new URL(
  "../extension/wasm/manifests/cap.bundled.hash.sha3.256-1.0.0.manifest.json", import.meta.url,
)));

function variant(id: string, bits: number, padding: number) {
  const m = structuredClone(baseline);
  m.package.id = `cap.bundled.hash.${id.replaceAll("_", ".")}`;
  m.package.name = m.package.id.replaceAll(".", "_");
  m.meta.label = id;
  m.executables[0].id = id;
  m.executables[0].callExport = {
    ...m.executables[0].callExport,
    digestBytes: bits / 8,
    initParam: bits,
    finalParam: padding,
  };
  m.tools[0].toolId = id;
  return m;
}

function register(seen: Set<string>, claims: Map<string, unknown>, m: typeof baseline) {
  registerBundledManifestIdentity(seen, { pkg: m.package.id, version: m.package.version }, m);
  return recordBundledWasmClaim(claims, manifestCasMappings(m)[0], m);
}

Deno.test("9iyc: four SHA-3/Keccak manifest identities share one scanned CAS member, each ABI remains distinct", () => {
  const seen = new Set<string>();
  const claims = new Map<string, unknown>();
  assertEquals(register(seen, claims, baseline), true);
  for (const [id, bits, padding] of [
    ["hash_sha3_384", 384, 6], ["hash_sha3_512", 512, 6], ["hash_keccak_256", 256, 1],
  ] as const) {
    assertEquals(register(seen, claims, variant(id, bits, padding)), false);
  }
  assertEquals(seen.size, 4, "four independently bound manifest identities");
  assertEquals(claims.size, 1, "one physical binary is scanned once");
});

Deno.test("9iyc: duplicate identity and divergent physical or ABI authority cannot hide behind a shared CAS", () => {
  const seen = new Set<string>();
  const claims = new Map<string, unknown>();
  register(seen, claims, baseline);
  assertThrows(() => register(seen, claims, baseline), Error, "duplicate bundled Wasm manifest mapping");
  for (const change of [
    (m: typeof baseline) => { m.executables[0].memory.maxPages = 3; },
    (m: typeof baseline) => { m.executables[0].imports.allowed = ["env.random"]; },
    (m: typeof baseline) => { m.license.spdx = "Apache-2.0"; },
    (m: typeof baseline) => { m.source.commit = "f".repeat(40); },
    (m: typeof baseline) => { m.executables[0].callExport.entry = "OtherEntry"; },
  ]) {
    const m = variant("hash_sha3_384", 384, 6);
    change(m);
    const other = new Set(seen);
    assertThrows(() => register(other, claims, m), Error);
  }
  assertEquals(claims.size, 1, "a hostile variant never replaces the scanned representative");
});

Deno.test("9iyc: schema-2 and non-call-export schema-1 claims cannot reuse a CAS member", () => {
  const seen = new Set<string>();
  const claims = new Map<string, unknown>();
  register(seen, claims, baseline);
  const other = variant("hash_sha3_384", 384, 6);
  delete other.executables[0].callExport;
  assertThrows(() => recordBundledWasmClaim(claims, manifestCasMappings(other)[0], other), Error,
    "duplicate bundled Wasm manifest mapping");
  const casRel = manifestCasMappings(baseline)[0].casRel;
  const schema2 = { casRel, schemaVersion: 2, executable: null, asset: {
    id: "side", role: "side-wasm", sha256: baseline.executables[0].sha256, size: 4018, path: casRel,
  } };
  assertThrows(() => recordBundledWasmClaim(claims, schema2, { schemaVersion: 2 }), Error,
    "duplicate bundled Wasm manifest mapping");
  assert(claims.has(casRel));
});

// chrome-agent-platform-ltkj.2 — the single schema-aware manifest→CAS mapping
// helper (scripts/lib/wasm-manifest-assets.mjs). One mapping rule shared by the
// generator, build.mjs scan and the Store archive map; these tests pin both
// schemas' mappings and every fail-closed refusal the contract requires:
// unsupported schemaVersion, malformed content addresses, unknown asset roles,
// wasm assets off their exact CAS address, non-wasm assets inside the CAS
// namespace, duplicate mappings, and inventory-row manifest digest drift.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { manifestCasMappings, assertManifestRowDigest } from "../scripts/lib/wasm-manifest-assets.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

Deno.test("helper: schema-1 executables map to CAS with the executable identity", () => {
  const executable = { id: "csvtool", sha256: SHA_A, size: 10 };
  const out = manifestCasMappings({ schemaVersion: 1, executables: [executable] });
  assertEquals(out.length, 1);
  assertEquals(out[0].casRel, `extension/wasm/cas/${SHA_A}.wasm`);
  assertEquals(out[0].schemaVersion, 1);
  assertEquals(out[0].executable, executable);
  assertEquals(out[0].asset, null);
});

Deno.test("helper: schema-2 wasm roles map to CAS; runtime roles never do", () => {
  const manifest = {
    schemaVersion: 2,
    assets: [
      { id: "adapter", role: "adapter", path: "extension/wasm/runtime/p/1.0.0/adapter.mjs", sha256: "c".repeat(64), size: 5 },
      { id: "glue", role: "glue", path: "extension/wasm/runtime/p/1.0.0/glue.mjs", sha256: "d".repeat(64), size: 6 },
      { id: "main", role: "main-wasm", path: `extension/wasm/cas/${SHA_A}.wasm`, sha256: SHA_A, size: 7 },
      { id: "side", role: "side-wasm", path: `extension/wasm/cas/${SHA_B}.wasm`, sha256: SHA_B, size: 8 },
    ],
  };
  const out = manifestCasMappings(manifest);
  assertEquals(out.map((m) => m.casRel), [`extension/wasm/cas/${SHA_A}.wasm`, `extension/wasm/cas/${SHA_B}.wasm`]);
  for (const entry of out) {
    assertEquals(entry.schemaVersion, 2);
    assertEquals(entry.executable, null);
    assert(entry.asset && (entry.asset as { role: string }).role.endsWith("wasm"));
  }
});

Deno.test("helper hostile: unsupported schemaVersion refused", () => {
  assertThrows(() => manifestCasMappings({ schemaVersion: 3, assets: [] }), Error, "unsupported manifest schemaVersion");
  assertThrows(() => manifestCasMappings({}), Error, "unsupported manifest schemaVersion");
});

Deno.test("helper hostile: malformed content addresses refused", () => {
  assertThrows(
    () => manifestCasMappings({ schemaVersion: 1, executables: [{ id: "x", sha256: "nothex", size: 1 }] }),
    Error, "without a CAS content address",
  );
  assertThrows(
    () => manifestCasMappings({ schemaVersion: 1, executables: [] }),
    Error, "without an executables array",
  );
  assertThrows(
    () => manifestCasMappings({ schemaVersion: 2, assets: [{ id: "main", role: "main-wasm", path: `extension/wasm/cas/${SHA_A}.wasm`, sha256: "short", size: 1 }] }),
    Error, "without a content address",
  );
});

Deno.test("helper hostile: unknown schema-2 asset role refused", () => {
  assertThrows(
    () => manifestCasMappings({ schemaVersion: 2, assets: [{ id: "x", role: "loader", path: "extension/wasm/runtime/p/1.0.0/x.mjs", sha256: SHA_A, size: 1 }] }),
    Error, "unknown schema-2 asset role",
  );
});

Deno.test("helper hostile: wasm asset off its exact CAS address refused", () => {
  assertThrows(
    () => manifestCasMappings({ schemaVersion: 2, assets: [{ id: "main", role: "main-wasm", path: "extension/wasm/runtime/p/1.0.0/main.wasm", sha256: SHA_A, size: 1 }] }),
    Error, "outside its CAS address",
  );
});

Deno.test("helper hostile: non-wasm asset squatting the CAS namespace refused", () => {
  assertThrows(
    () => manifestCasMappings({ schemaVersion: 2, assets: [{ id: "glue", role: "glue", path: `extension/wasm/cas/${SHA_A}.wasm`, sha256: SHA_A, size: 1 }] }),
    Error, "inside the CAS namespace",
  );
});

Deno.test("helper hostile: duplicate CAS mapping within one manifest refused", () => {
  assertThrows(
    () => manifestCasMappings({
      schemaVersion: 2,
      assets: [
        { id: "main", role: "main-wasm", path: `extension/wasm/cas/${SHA_A}.wasm`, sha256: SHA_A, size: 1 },
        { id: "side", role: "side-wasm", path: `extension/wasm/cas/${SHA_A}.wasm`, sha256: SHA_A, size: 1 },
      ],
    }),
    Error, "duplicate CAS mapping",
  );
});

Deno.test("helper: digest drift guard accepts the real shipped inventory and refuses drift", async () => {
  const data = await import("../extension/lib/bundled-inventory-data.js");
  const inventory = (data as { BUNDLED_INVENTORY: { manifests: { pkg: string; version: string; digest: string }[] } }).BUNDLED_INVENTORY;
  const row = inventory.manifests[0];
  const rel = `extension/wasm/manifests/${row.pkg}-${row.version}.manifest.json`;
  const text = await Deno.readTextFile(new URL(`../${rel}`, import.meta.url));
  // Real row: recomputed digest matches exactly.
  assertEquals(assertManifestRowDigest(text, row), row.digest);
  // Doctored row digest: refused.
  assertThrows(
    () => assertManifestRowDigest(text, { ...row, digest: "0".repeat(64) }),
    Error, "manifest digest drift",
  );
  // Unparseable manifest text: refused.
  assertThrows(() => assertManifestRowDigest("{not json", row), Error, "not valid JSON");
});

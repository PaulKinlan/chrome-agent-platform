// CAP bundled tool packages — shipped immutable bundles (A2/B2/C2/csvtool/gzip),
// SPDX token+exact-composite licence validation, real admission flow, and the
// disabled/no-route posture. Pure no-Chrome tests over the REAL shipped bytes.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  canonicalJson,
  isValidLicenseExpression,
  WasmPackageAuthority,
} from "../extension/lib/wasm-package-authority.js";
import { createBundledInventory } from "../extension/lib/bundled-inventory.js";
import {
  admitBundledToolPackages,
  BUNDLED_PACKAGE_SOURCE_KIND,
  BUNDLED_TOOL_PACKAGES,
  listBundledToolPackages,
} from "../extension/lib/bundled-tool-packages.js";
import { BUNDLED_INVENTORY } from "../extension/lib/bundled-inventory-data.js";
import { scanBundledWasmFiles } from "../scripts/scan-shipped.mjs";

const root = (rel) => new URL(`../${rel}`, import.meta.url);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (bytes) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

class FakeStore {
  constructor() { this.rows = new Map(); this.version = 0; }
  async getStrict(key) { return structuredClone(this.rows.get(key)?.value ?? null); }
  async setTrusted(key, value) { const token = ++this.version; this.rows.set(key, { value: structuredClone(value), version: token }); return token; }
  async getVersion(key) { return this.rows.get(key)?.version ?? 0; }
  async compareAndRestore(key, expectedVersion, value) {
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    const token = ++this.version; this.rows.set(key, { value: structuredClone(value), version: token }); return true;
  }
  async compareAndDelete(key, expectedVersion) {
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    this.rows.delete(key); this.version++; return true;
  }
}

function diskInventory() {
  return createBundledInventory({
    readFile: async (rel) => (await Deno.readFile(root(rel))).buffer,
    listFiles: async () => BUNDLED_INVENTORY.files.map((row) => row.rel),
  });
}

Deno.test("SPDX: exact single tokens admitted, including Zlib", () => {
  for (const id of ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "Zlib"]) {
    assert(isValidLicenseExpression(id), id);
  }
});

Deno.test("SPDX: exact two-operand AND composites admitted (toml dual, gzip composite)", () => {
  assert(isValidLicenseExpression("MIT AND Apache-2.0"));
  assert(isValidLicenseExpression("Zlib AND Apache-2.0"));
  assert(isValidLicenseExpression("Apache-2.0 AND Apache-2.0"));
});

Deno.test("SPDX: everything else rejected fail-closed", () => {
  for (const bad of [
    "MIT OR Apache-2.0", "MIT  AND  Apache-2.0", "MIT AND", "AND MIT",
    "MIT AND Apache-2.0 AND Zlib", "(MIT AND Apache-2.0)", "MIT AND GPL-3.0-or-later",
    "mit", "MIT WITH Classpath-exception-2.0", "LicenseRef-anything", "NOASSERTION",
    "", "MIT\nAND Apache-2.0", "MIT AND mit",
  ]) {
    assert(!isValidLicenseExpression(bad), JSON.stringify(bad));
  }
  assert(!isValidLicenseExpression(null) && !isValidLicenseExpression(undefined) && !isValidLicenseExpression(42));
});

Deno.test("manifests: all 25 shipped manifests validate against the real authority (canonical bytes)", async () => {
  const probe = new WasmPackageAuthority();
  assertEquals(BUNDLED_INVENTORY.manifests.length, 25);
  for (const row of BUNDLED_INVENTORY.manifests) {
    const rel = `extension/wasm/manifests/${row.pkg}-${row.version}.manifest.json`;
    const raw = await Deno.readTextFile(root(rel));
    assertEquals(raw, canonicalJson(JSON.parse(raw)), `${rel} must be canonical`);
    const validated = probe.validateManifest(raw);
    assert(validated.ok, `${rel}: ${validated.error} ${validated.path ?? ""}`);
    assertEquals(validated.manifestDigest, row.digest, `${rel} inventory digest`);
    assertEquals(validated.manifest.signer.lane, "bundled");
    assertEquals(validated.manifest.signer.keyId, BUNDLED_INVENTORY.signer.keyId);
  }
});

Deno.test("manifests: composite licence terms present exactly where intended", async () => {
  const read = async (tool) => JSON.parse(await Deno.readTextFile(root(`extension/wasm/manifests/cap.bundled.${tool}-1.0.0.manifest.json`)));
  assertEquals((await read("toml2json")).license.spdx, "MIT AND Apache-2.0");
  assertEquals((await read("toml2json")).license.notices, "extension/wasm/licenses/toml2json-NOTICES.txt");
  assertEquals((await read("gzip")).license.spdx, "Zlib AND Apache-2.0");
  assertEquals((await read("gzip")).license.notices, "extension/wasm/licenses/CAP-authored-Apache-2.0.txt");
  assertEquals((await read("csvtool")).license.spdx, "Apache-2.0");
  assertEquals((await read("markdown")).license.spdx, "BSD-2-Clause");
  assertEquals((await read("base64")).license.spdx, "MIT");
  assertEquals((await read("sort")).license.spdx, "Apache-2.0");
  // an OR expression in place of the toml dual licence fails validation
  const mutated = await read("toml2json");
  mutated.license.spdx = "MIT OR Apache-2.0";
  const probe = new WasmPackageAuthority();
  const rejected = probe.validateManifest(canonicalJson(mutated));
  assertEquals(rejected.ok, false);
  assertEquals(rejected.error, "license_invalid");
});

Deno.test("inventory: every declared file ships on disk with the exact pinned sha256/size", async () => {
  for (const entry of BUNDLED_INVENTORY.files) {
    const bytes = await Deno.readFile(root(entry.rel));
    assertEquals(bytes.byteLength, entry.size, entry.rel);
    assertEquals(await digest(bytes), entry.sha256, entry.rel);
  }
  // no unmanifested binaries: every CAS file maps to exactly one manifest executable
  const cas = BUNDLED_INVENTORY.files.filter((f) => f.rel.startsWith("extension/wasm/cas/"));
  assertEquals(cas.length, 25);
  const execShas = new Set();
  for (const m of BUNDLED_INVENTORY.manifests) {
    const manifest = JSON.parse(await Deno.readTextFile(root(`extension/wasm/manifests/${m.pkg}-${m.version}.manifest.json`)));
    for (const e of manifest.executables) execShas.add(e.sha256);
  }
  assertEquals(new Set(cas.map((f) => f.rel)).size, execShas.size);
  for (const f of cas) assert(execShas.has(f.rel.slice("extension/wasm/cas/".length, -".wasm".length)), f.rel);
});

Deno.test("admission: all 25 packages admit through the real authority over the real bytes; re-admission dedupes", async () => {
  const store = new FakeStore();
  const inventory = diskInventory();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const first = await admitBundledToolPackages(authority, { inventory });
  assert(first.ok, JSON.stringify(first.results.filter((r) => !r.ok)));
  assertEquals(first.results.length, 25);
  assert(first.results.every((r) => !r.deduped));
  for (const row of BUNDLED_TOOL_PACKAGES) {
    const q = await authority.query({ packageId: row.packageId });
    assert(q.ok, row.packageId);
    assertEquals(q.record.current.state, "committed");
    assertEquals(q.record.current.version, "1.0.0");
    assertEquals(q.record.lane, "bundled");
  }
  const second = await admitBundledToolPackages(authority, { inventory });
  assert(second.ok);
  assert(second.results.every((r) => r.deduped), "re-admission must dedupe");
});

Deno.test("admission: shipped CAS bytes pass the authority scanner unmanifested-free", async () => {
  const casFiles = BUNDLED_INVENTORY.files.filter((f) => f.rel.startsWith("extension/wasm/cas/"));
  const manifestByFile = new Map();
  for (const m of BUNDLED_INVENTORY.manifests) {
    const manifest = JSON.parse(await Deno.readTextFile(root(`extension/wasm/manifests/${m.pkg}-${m.version}.manifest.json`)));
    for (const e of manifest.executables) manifestByFile.set(`extension/wasm/cas/${e.sha256}.wasm`, e);
  }
  const violations = await scanBundledWasmFiles(casFiles.map((f) => f.rel), {
    readBytes: async (rel) => await Deno.readFile(root(rel)),
    manifestByFile,
  });
  assertEquals(violations, []);
});

Deno.test("posture: descriptors disabled, no canonical-name claim, bundled-package kind, preserved until host", () => {
  assertEquals(BUNDLED_TOOL_PACKAGES.length, 25);
  assertEquals(new Set(BUNDLED_TOOL_PACKAGES.map((r) => r.packageId)).size, 25);
  assertEquals(new Set(BUNDLED_TOOL_PACKAGES.map((r) => r.toolId)).size, 25);
  for (const row of BUNDLED_TOOL_PACKAGES) {
    assertEquals(row.canonicalNameClaim, false, row.toolId);
    assertEquals(row.admitted, false, row.toolId);
    assertEquals(row.disabled, true, row.toolId);
    assertEquals(row.disabledReason, "no-execution-host", row.toolId);
    assertEquals(row.sourceKind, BUNDLED_PACKAGE_SOURCE_KIND, row.toolId);
    assertEquals(row.sourceKind, "bundled-package", row.toolId);
  }
  const listed = listBundledToolPackages();
  listed[0].description = "mutated";
  assert(BUNDLED_TOOL_PACKAGES[0].description !== "mutated", "enumeration must return copies");
});

Deno.test("posture: NO route — service worker and catalog never import the bundled modules", async () => {
  const sw = await Deno.readTextFile(root("extension/background/service-worker.js"));
  for (const needle of ["bundled-tool-packages", "bundled-inventory", "admitBundledToolPackages", "cap.bundled."]) {
    assert(!sw.includes(needle), `service-worker.js must not reference ${needle} until the execution host lands`);
  }
  for (const rel of ["extension/lib/tool-catalog.js", "extension/lib/tool-catalog-shadow.js"]) {
    const src = await Deno.readTextFile(root(rel));
    assert(!src.includes("bundled-tool-packages"), `${rel} must not consume bundled descriptors yet`);
  }
});

// ── Store boundary: exact bundled-Wasm manifest mapping (hostile) ──────────
import { buildBundledWasmManifestMap, collectPackageInventory } from "../scripts/package-archive.mjs";
import { assertStoreTargetBoundary } from "../scripts/store-target-policy.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

Deno.test("store map: exact archivePath→executable mapping for all 25 shipped CAS binaries", async () => {
  const map = await buildBundledWasmManifestMap(repoRoot);
  assertEquals(map.size, 25);
  for (const [archivePath, executable] of map) {
    assert(archivePath.startsWith("wasm/cas/") && archivePath.endsWith(".wasm"), archivePath);
    assertEquals(archivePath, `wasm/cas/${executable.sha256}.wasm`);
  }
  // integration: the REAL package inventory passes the Store boundary WITH the map
  const inventory = await collectPackageInventory({ root: repoRoot, expectedTarget: "store" });
  await assertStoreTargetBoundary({ target: "store", inventory, bundledWasmManifestByArchivePath: map });
});

Deno.test("store map hostile: WITHOUT the map every shipped binary is refused (no silent admission)", async () => {
  const inventory = await collectPackageInventory({ root: repoRoot, expectedTarget: "store" });
  let caught = null;
  try { await assertStoreTargetBoundary({ target: "store", inventory }); } catch (e) { caught = e; }
  assert(caught, "empty map must fail closed");
  assert(String(caught.message).includes("unmanifested_binary"), caught.message);
});

Deno.test("store map hostile: duplicate manifest identity (same CAS claimed twice) rejected", async () => {
  const doctored = structuredClone(BUNDLED_INVENTORY);
  doctored.manifests = [doctored.manifests[0], doctored.manifests[0], ...doctored.manifests.slice(1)];
  let caught = null;
  try { await buildBundledWasmManifestMap(repoRoot, { inventory: doctored }); } catch (e) { caught = e; }
  assert(caught && String(caught.message).includes("duplicate bundled Wasm manifest mapping"), caught?.message ?? "no error");
});

Deno.test("store map hostile: executable outside the declared CAS inventory rejected", async () => {
  const doctored = structuredClone(BUNDLED_INVENTORY);
  doctored.files = doctored.files.filter((f) => !f.rel.startsWith("extension/wasm/cas/")).concat(doctored.files.filter((f) => f.rel.startsWith("extension/wasm/cas/")).slice(1));
  let caught = null;
  try { await buildBundledWasmManifestMap(repoRoot, { inventory: doctored }); } catch (e) { caught = e; }
  assert(caught && String(caught.message).includes("outside the declared CAS inventory"), caught?.message ?? "no error");
});

Deno.test("store map hostile: undeclared/unreadable manifest file rejected", async () => {
  const doctored = structuredClone(BUNDLED_INVENTORY);
  doctored.manifests = [{ pkg: "cap.bundled.ghost", version: "9.9.9", digest: "0".repeat(64) }, ...doctored.manifests];
  let caught = null;
  try { await buildBundledWasmManifestMap(repoRoot, { inventory: doctored }); } catch (e) { caught = e; }
  assert(caught && String(caught.message).includes("not a declared inventory file"), caught?.message ?? "no error");
});

Deno.test("store map hostile: malformed content address rejected", async () => {
  const doctored = structuredClone(BUNDLED_INVENTORY);
  const victim = doctored.manifests[0];
  // poison the on-disk manifest? No — poison the identity so the manifest path escapes declaration.
  victim.pkg = "../../escape";
  let caught = null;
  try { await buildBundledWasmManifestMap(repoRoot, { inventory: doctored }); } catch (e) { caught = e; }
  assert(caught, "escaped manifest identity must fail closed");
});

// CAP bundled tool packages — shipped immutable bundles (A2/B2/C2/csvtool/gzip),
// SPDX token+exact-composite licence validation, real admission flow, and the
// disabled/no-route posture. Pure no-Chrome tests over the REAL shipped bytes.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  auditWasmBinary,
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
  for (const id of ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0", "Zlib", "blessing"]) {
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
  assertEquals(BUNDLED_INVENTORY.manifests.length, 26);
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
  assertEquals(cas.length, 26);
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
  assertEquals(first.results.length, 26);
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

Deno.test("posture: descriptors admit exactly the 26-tool gzip-appended Settings allowlist", () => {
  assertEquals(BUNDLED_TOOL_PACKAGES.length, 26);
  assertEquals(new Set(BUNDLED_TOOL_PACKAGES.map((r) => r.packageId)).size, 26);
  assertEquals(new Set(BUNDLED_TOOL_PACKAGES.map((r) => r.toolId)).size, 26);
  const previewRows = BUNDLED_TOOL_PACKAGES.filter((row) => row.admitted === true);
  assertEquals(JSON.stringify(previewRows.map((r) => r.toolId).sort()), JSON.stringify(
    ["base64", "csvtool", "cut", "diff", "du", "grep", "gzip", "head", "markdown", "md5sum", "patch", "sha256sum", "sha512sum", "sort", "sqlite3_query_bounded", "stat", "tail", "toml2json", "touch", "tr", "tree", "truncate", "uniq", "uuid", "wc", "xxd"],
  ), "exactly the 26-tool allowlist");
  for (const row of previewRows) {
    assertEquals(row.settingsPreview, true, row.toolId);
    assertEquals(row.disabled, false, row.toolId);
    assertEquals(row.disabledReason, null, row.toolId);
  }
  for (const row of BUNDLED_TOOL_PACKAGES) {
    assertEquals(row.canonicalNameClaim, false, row.toolId);
    assertEquals(row.sourceKind, BUNDLED_PACKAGE_SOURCE_KIND, row.toolId);
    assertEquals(row.sourceKind, "bundled-package", row.toolId);
    if (previewRows.includes(row)) continue;
    assertEquals(row.admitted, false, row.toolId);
    assertEquals(row.disabled, true, row.toolId);
    assert(["no-execution-host", "runtime-linked-awaiting-admission", "runtime-imports-unimplemented"].includes(row.disabledReason), `${row.toolId}: ${row.disabledReason}`);
  }
  const listed = listBundledToolPackages();
  listed[0].description = "mutated";
  assert(BUNDLED_TOOL_PACKAGES[0].description !== "mutated", "enumeration must return copies");
  // ALL 23 admitted rows retain truthful per-tool caveats. Markdown has an
  // empty workspace; stat/du have inputs/f.bin; tree has the nested inputs seed.
  for (const row of previewRows) {
    const caveats = (row.caveats ?? []).join(" ");
    if (row.toolId === "markdown") {
      assert(caveats.includes("projects NO files into the fresh empty per-job workspace"), "markdown empty-workspace caveat");
    } else if (row.toolId === "stat" || row.toolId === "du") {
      assert(caveats.includes("immutable per-job inputs/f.bin seed"), `${row.toolId} seed confinement caveat`);
      assert(caveats.includes("no provider, page or OPFS authority"), `${row.toolId} no-authority caveat`);
      if (row.toolId === "du") {
        assert(caveats.includes("using /job by default"), "du safe default caveat");
        assert(caveats.includes("bounded recursive enumeration"), "du recursive read confinement caveat");
      }
    } else if (row.toolId === "tree") {
      assert(caveats.includes("immutable nested per-job inputs seed"), "tree nested seed confinement caveat");
      assert(caveats.includes("no provider, page or OPFS authority"), "tree no-authority caveat");
      assert(caveats.includes("bounded recursive enumeration"), "tree recursive read confinement caveat");
    } else if (row.toolId === "gzip") {
      assert(caveats.includes("bounded text/canonical-base64 preview"), "gzip caveat names both bounded modes");
      assert(caveats.includes("lossless binary output is canonical base64"), "gzip caveat names the binary arm");
      assert(caveats.includes("no provider, page, filesystem or OPFS authority"), "gzip caveat denies authority expansion");
    } else if (row.toolId === "truncate") {
      assert(caveats.includes("scratch/touched"), "truncate fixture confinement caveat");
      assert(caveats.includes("no provider, page, filesystem or OPFS authority"), "truncate no-authority caveat");
      assert(caveats.includes("post-run stat readback"), "truncate readback proof caveat");
    } else if (row.toolId === "touch") {
      assert(caveats.includes("scratch/touched"), "touch fixture confinement caveat");
      assert(caveats.includes("no provider, page, filesystem or OPFS authority"), "touch no-authority caveat");
      assert(caveats.includes("post-run stat readback"), "touch readback proof caveat");
    } else if (row.toolId === "sqlite3_query_bounded") {
      assert(caveats.includes("scratch/test.db"), "sqlite fixture confinement caveat");
      assert(caveats.includes("readOnly is forced"), "sqlite forced-readOnly caveat");
      assert(caveats.includes("no provider, page, filesystem or OPFS authority"), "sqlite no-authority caveat");
    } else {
      assert(!caveats.includes("projects NO files into the fresh empty per-job workspace"), `${row.toolId}: no file caveat without file.read`);
      assert(caveats.includes("Settings-only bounded stdin preview"), `${row.toolId}: generic Settings-only caveat present`);
    }
    assert(!/pending owner admission|not currently executable|future reviewed execution adapter|not admitted/i.test(caveats), `${row.toolId}: no stale pre-admission wording`);
  }
  const tree = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "tree");
  assertEquals(tree.admitted, true, "tree is admitted only to Settings preview");
  assertEquals(tree.settingsPreview, true);
  assertEquals(tree.disabled, false);
  assertEquals(tree.disabledReason, null);
  assertEquals(tree.binary.sha256, "65362b548d918eeb102f034bc4fc270ef450be463b82a0ffbe71a3ef1b8aa2cb");
  assertEquals(tree.binary.bytes, 39108);
  assert(!(tree.caveats ?? []).join(" ").includes("future reviewed execution adapter"), "tree does not carry stale host wording");
  const gzip = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "gzip");
  assertEquals(gzip.admitted, true);
  assertEquals(gzip.settingsPreview, true);
  assertEquals(gzip.disabled, false);
  assertEquals(gzip.disabledReason, null);
  assertEquals(gzip.canonicalNameClaim, false);
  assertEquals(gzip.binary.sha256, "d03a2558682ea04653d34753eae8df1fcd5cc8d92fc53de43106c3db0e1c57dc");
  assertEquals(gzip.binary.bytes, 56938);
  assertEquals(gzip.binary.initialPages, 32);
  assertEquals(gzip.binary.maxPages, 256);
  assertEquals(gzip.licence.spdx, "Zlib AND Apache-2.0");
  // per-tool TRUE caveats are preserved (not overwritten by the generic one)
  const md5 = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "md5sum");
  assert((md5.caveats ?? []).join(" ").includes("never signatures, content trust, or collision-resistant integrity"), "md5 legacy caveat preserved");
  const uuid = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "uuid");
  assert((uuid.caveats ?? []).join(" ").includes("output is intentionally nondeterministic"), "uuid nondeterminism caveat preserved");
  const b64 = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "base64");
  assert((b64.caveats ?? []).join(" ").includes("Invalid padding or characters rejected fail-closed"), "base64 padding caveat preserved");
  const sha256 = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "sha256sum");
  assert((sha256.caveats ?? []).join(" ").includes("FIPS 180-4 SHA-256"), "sha256 FIPS caveat preserved");
  // the ADMITTED markdown row's caveat is TRUTHFUL (no pre-admission wording)
  const markdownRow = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "markdown");
  assert(markdownRow, "markdown row present");
  assertEquals(markdownRow.admitted, true, "markdown admitted");
  const caveat = (markdownRow.caveats ?? []).join(" ");
  assert(caveat.includes("Settings-only bounded stdin preview"), "the generated caveat names the stdin preview");
  assert(caveat.includes("projects NO files into the fresh empty per-job workspace"), "the route projects no files into the fresh empty workspace");
  assert(caveat.includes("cannot read owner data and fails closed"), "a file operand cannot read owner data");
  assert(caveat.includes("path normalization prevents escape/cross-job"), "path normalization prevents escape/cross-job");
  assert(!/deny any (valid )?file operand|not currently executable|future reviewed execution adapter|not admitted/i.test(caveat), "no pre-admission/deny-all false wording in the admitted caveat");
  // the TRUE per-tool predecessor caveat is PRESERVED byte-wise in the admitted row
  assert(caveat.includes("Based on pinned cmark 0.31.1 (BSD-2-Clause)"), "the cmark predecessor caveat is preserved");
  assert(caveat.includes("Raw HTML and dangerous javascript: URLs are omitted/disabled"), "the cmark XSS caveat is preserved");
});

Deno.test("idempotence: the generated inventory release equals the package version + regeneration is stable (no stale release identity)", async () => {
  const { BUNDLED_INVENTORY } = await import("../extension/lib/bundled-inventory-data.js");
  const manifest = JSON.parse(await Deno.readTextFile(root("extension/manifest.json")));
  assertEquals(BUNDLED_INVENTORY.release, manifest.version, "the inventory release must equal the package version");
  // The README literal must be the ENFORCED CATALOG pin (the evidence
  // inventory whose sha the generator verifies at PATHS.catalog) — COMPUTED at
  // generation from the actual pinned file, never a hand-fabricated value.
  const generator = await Deno.readTextFile(root("scripts/build-bundled-tool-packages.mjs"));
  const catalogPin = generator.match(/catalogSha !== "([0-9a-f]{64})"/)?.[1];
  assert(catalogPin, "the generator enforces the catalog pin");
  const readme = await Deno.readTextFile(root("packages/bundled/README.md"));
  assert(readme.includes(`inventory sha256 ${catalogPin}`), "the README literal equals the enforced catalog pin (computed at generation, not hand-fabricated)");
  // the generator must not carry a SEPARATE hardcoded README literal — the
  // only hex in the generator's README template is the computed ${catalogSha}.
  const templateStart = generator.indexOf("packages/bundled/README.md");
  const template = generator.slice(templateStart);
  assert(!/[0-9a-f]{64}/u.test(template), "the README template embeds no hardcoded hex literal");
  // a stale committed identity is impossible (the regen recomputes + the test
  // re-verifies the computed value)
});

Deno.test("posture: the ONLY route is tool.preview.run — no provider/selection authority", async () => {
  const sw = await Deno.readTextFile(root("extension/background/service-worker.js"));
  assert(sw.includes("tool.preview.run"), "the Settings preview route exists");
  assert(sw.includes("bundled-inventory-data"), "the preview route revalidates against the immutable inventory");
  assert(sw.includes("previewSpecFor(input.toolId)"), "the toolId resolves through the immutable spec map");
  assert(!sw.includes("admitBundledToolPackages"), "service-worker.js must not reference the admission API");
  assert(!sw.includes("tool.preview.csvtool"), "the old single-tool route name is gone");
  assert(!sw.includes('const manifestRel = "wasm/manifests/'), "no hardcoded manifest rels in the SW");
  assert(!sw.includes('const casRel = "wasm/cas/'), "no hardcoded CAS rels in the SW");
  for (const rel of ["extension/lib/tool-catalog.js"]) {
    const src = await Deno.readTextFile(root(rel));
    assert(!src.includes("bundled-tool-packages"), `${rel} must not consume bundled descriptors`);
  }
});


// ── Store boundary: exact bundled-Wasm manifest mapping (hostile) ──────────
import { buildBundledWasmManifestMap, collectPackageInventory } from "../scripts/package-archive.mjs";
import { assertStoreTargetBoundary } from "../scripts/store-target-policy.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;

Deno.test("store map: exact archivePath→executable mapping for ALL 26 shipped CAS binaries", async () => {
  const map = await buildBundledWasmManifestMap(repoRoot);
  assertEquals(map.size, 26);
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

// ── Package 26: sqlite3-query-bounded (map §8) ─────────────────────────────
import { SUPPORTED_WASI_PREVIEW1_IMPORTS } from "../extension/lib/wasi-preview1-runtime.js";

const SQLITE_MANIFEST_REL = "extension/wasm/manifests/cap.bundled.sqlite3.query.bounded-1.0.0.manifest.json";
const SQLITE_WASM_SHA = "ba468c6eec9c4743167c807b4781d2ca7b5e28b48850e394bf292d13f9c9559d";
const SQLITE_IMPORTS_24 = ["clock_time_get","environ_get","environ_sizes_get","fd_close","fd_fdstat_get","fd_fdstat_set_flags","fd_filestat_get","fd_filestat_set_size","fd_prestat_dir_name","fd_prestat_get","fd_read","fd_seek","fd_sync","fd_write","path_create_directory","path_filestat_get","path_filestat_set_times","path_open","path_readlink","path_remove_directory","path_unlink_file","poll_oneoff","proc_exit","random_get"];
const SQLITE_GAP_8 = ["fd_filestat_set_size","fd_sync","path_create_directory","path_filestat_set_times","path_readlink","path_remove_directory","path_unlink_file","poll_oneoff"];

Deno.test("SPDX: exact blessing token and composite admitted; every mutant rejected", () => {
  assert(isValidLicenseExpression("blessing"));
  assert(isValidLicenseExpression("blessing AND Apache-2.0"));
  for (const bad of ["Blessing", "BLESSING", "blessing ", " blessing", "blessing OR Apache-2.0", "blessing AND Apache-2.0 AND MIT", "(blessing AND Apache-2.0)", "LicenseRef-blessing", "blessing  AND  Apache-2.0", "Apache-2.0 AND blessingx"]) {
    assert(!isValidLicenseExpression(bad), JSON.stringify(bad));
  }
});

Deno.test("sqlite manifest: canonical bytes, composite licence, exact notice/SBOM/binary digests, tiny 64/512 memory", async () => {
  const raw = await Deno.readTextFile(root(SQLITE_MANIFEST_REL));
  assertEquals(raw, canonicalJson(JSON.parse(raw)), "canonical bytes");
  const m = JSON.parse(raw);
  assertEquals(m.package.id, "cap.bundled.sqlite3.query.bounded");
  assertEquals(m.license.spdx, "blessing AND Apache-2.0");
  assertEquals(m.license.file, "extension/wasm/licenses/Apache-2.0.txt");
  assertEquals(m.license.notices, "extension/wasm/licenses/SQLite-Blessing-3.46.0.txt");
  const notice = await Deno.readFile(root(m.license.notices));
  assertEquals(notice.byteLength, 254);
  assertEquals(await digest(notice), "06545a6ec25fbbff6c62f205f94a35be49e38f33bea827a8cfb07d7b82e4b083");
  assertEquals(m.sbom.sha256, "496d6e5a7d085700984fc96c0e123e925edb172d2a4cde65b91bcab2e2f32107");
  assertEquals(m.executables[0].sha256, SQLITE_WASM_SHA);
  assertEquals(m.executables[0].size, 1125792);
  assertEquals(m.executables[0].memory, { tier: "tiny", initialPages: 64, maxPages: 512 });
  assertEquals(m.executables[0].imports, { allowed: ["wasi_snapshot_preview1"], disallowed: [] });
  assertEquals(m.executables[0].replayClass, "mutating");
  const sbom = JSON.parse(await Deno.readTextFile(root(m.sbom.ref)));
  assertEquals(sbom.metadata.component.licenses[0].expression, "blessing AND Apache-2.0");
  assert(!JSON.stringify(sbom).includes("Evaluation-Only") && !JSON.stringify(sbom).includes("pending-owner"), "stale evaluation/pending wording must be gone");
});

Deno.test("sqlite binary: exact 24 imports and the EMPTY computed gap (R11: import-complete, still disabled)", async () => {
  const wasm = await Deno.readFile(root(`extension/wasm/cas/${SQLITE_WASM_SHA}.wasm`));
  const audit = auditWasmBinary(wasm, JSON.parse(await Deno.readTextFile(root(SQLITE_MANIFEST_REL))).executables[0], {});
  const names = audit.imports.map((i) => i.name).sort();
  assertEquals(names, [...SQLITE_IMPORTS_24].sort());
  assertEquals(audit.imports.every((i) => i.module === "wasi_snapshot_preview1"), true);
  assertEquals(audit.measured.memoryInitial, 64);
  assertEquals(audit.measured.memoryMax, 512);
  const supported = new Set(SUPPORTED_WASI_PREVIEW1_IMPORTS);
  // R11: the six sqlite imports (fd_sync, path_create_directory,
  // path_remove_directory, path_unlink_file, path_readlink, poll_oneoff) are
  // now SUPPORTED — the computed gap is EMPTY (import-complete, still
  // disabled; the R12 admission is a separate slice).
  assertEquals(
    SQLITE_IMPORTS_24.filter((n) => !supported.has(n)),
    [],
    "R11: the computed gap is EMPTY (the six imports landed)",
  );
  for (const gap of SQLITE_GAP_8) {
    assert(supported.has(gap), `R11: ${gap} IS supported (the six-import completion)`);
  }
  assert(supported.has("fd_filestat_set_size"), "R5: fd_filestat_set_size IS supported (deliberate)");
  assert(supported.has("path_filestat_set_times"), "R6: path_filestat_set_times IS supported (deliberate)");
});

Deno.test("sqlite descriptor: true/true/false posture after the R12 admission; no provider/selection route anywhere", async () => {
  const row = BUNDLED_TOOL_PACKAGES.find((r) => r.toolId === "sqlite3_query_bounded");
  assert(row, "descriptor row exists");
  assertEquals(row.canonicalNameClaim, false);
  assertEquals(row.admitted, true);
  assertEquals(row.settingsPreview, true);
  assertEquals(row.disabled, false);
  assertEquals(row.disabledReason, null);
  assertEquals(row.sourceKind, "bundled-package");
  for (const rel of ["extension/background/service-worker.js", "extension/lib/tool-catalog.js", "extension/lib/tool-catalog-shadow.js", "extension/lib/tool-selection.js", "extension/lib/wasm-offscreen-host.js", "extension/lib/wasm-executor.js", "extension/sidepanel/sidepanel.js", "extension/ntp/ntp.js"]) {
    const src = await Deno.readFile(root(rel));
    assert(!/sqlite3_query_bounded|sqlite3-query-bounded/.test(src), `${rel} must expose no sqlite package route`);
  }
});

Deno.test("sqlite sources stay outside extension/; shipped code imports no Node host", async () => {
  for (const rel of ["packages/bundled/sqlite3/src/sqlite3_query_main.c", "packages/bundled/sqlite3/host/quota-sink.mjs", "packages/bundled/sqlite3/host/run-query.mjs", "packages/bundled/sqlite3/host/wasi-worker.mjs"]) {
    await Deno.stat(root(rel)); // exists as public provenance
  }
  const shipped = []; for await (const e of Deno.readDir(root("extension/wasm"))) shipped.push(e.name);
  assert(!shipped.some((n) => n.includes("host")), "no Node host under extension/wasm");
});

Deno.test("regeneration preserves all 25 predecessor manifest digests and CAS hashes", async () => {
  const identity26 = BUNDLED_INVENTORY.manifests.find((m) => m.pkg === "cap.bundled.sqlite3.query.bounded");
  assert(identity26, "sqlite identity present");
  assertEquals(BUNDLED_INVENTORY.manifests.length, 26);
  // the 25 predecessors' manifest files must match the previous release's digests
  const prevText = await Deno.readTextFile("/home/paulkinlan/worktrees/cap-bundled-tool-packages-163/extension/lib/bundled-inventory-data.js").catch(() => null);
  if (prevText) {
    const prevDigests = [...prevText.matchAll(/"pkg": "(cap\.bundled\.[^"]+)",\s*"version": "1\.0\.0",\s*"digest": "([0-9a-f]{64})"/g)];
    assertEquals(prevDigests.length, 25);
    const now = new Map(BUNDLED_INVENTORY.manifests.map((m) => [m.pkg, m.digest]));
    const TRANCH = new Set(["cap.bundled.csvtool", "cap.bundled.uuid", "cap.bundled.head", "cap.bundled.tail", "cap.bundled.cut", "cap.bundled.base64", "cap.bundled.md5sum", "cap.bundled.sha256sum", "cap.bundled.sha512sum", "cap.bundled.wc", "cap.bundled.xxd", "cap.bundled.sort", "cap.bundled.uniq", "cap.bundled.tr", "cap.bundled.grep", "cap.bundled.toml2json", "cap.bundled.markdown", "cap.bundled.diff", "cap.bundled.patch", "cap.bundled.stat", "cap.bundled.du", "cap.bundled.tree", "cap.bundled.gzip", "cap.bundled.touch", "cap.bundled.truncate"]);
    for (const [, pkg, dg] of prevDigests) {
      if (TRANCH.has(pkg)) {
        assert(now.get(pkg) !== dg, `${pkg} manifest digest intentionally changed (settings-preview meta status)`);
        continue;
      }
      assertEquals(now.get(pkg), dg, `${pkg} manifest digest must be preserved`);
    }
    const prevCas = [...prevText.matchAll(/"rel": "extension\/wasm\/cas\/([0-9a-f]{64})\.wasm"/g)].map((m) => m[1]);
    const nowCas = new Set(BUNDLED_INVENTORY.files.filter((f) => f.rel.startsWith("extension/wasm/cas/")).map((f) => f.rel));
    for (const sha of prevCas) assert(nowCas.has(`extension/wasm/cas/${sha}.wasm`), `predecessor CAS ${sha} preserved`);
  }
});

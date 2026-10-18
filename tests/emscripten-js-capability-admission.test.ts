// tests/emscripten-js-capability-admission.test.ts — admission invariant over
// the glue+adapter byte set (chrome-agent-platform-197jd).
//
// Verifies:
//   - The deny-list is ONE exported frozen constant with unique typed codes.
//   - Every deny-list entry has a hostile fixture, and every fixture names a
//     live entry (adding a capability without a fixture fails here).
//   - Each fixture is refused at admission with code `js_capability_denied`
//     and detail `<assetId>:<capability-code>`; clean bytes pass.
//   - The fetch/XHR preamble exemption is BYTE-EXACT (reviewed glue digests
//     only) and glue-only (adapters are never exempt); the hostile negative
//     glues — same idiom, different bytes — are refused.
//   - The two currently admitted adapters (cap-a0-numeric-v1,
//     cap-blake3-wasm-v1) still admit: graph audit passes, eligibility holds,
//     and the identity digests equal the pinned constants (the receipt field
//     is digest-neutral).
//   - Full authority admission records the verdict on the receipt
//     (`current.jsCapabilityAudit`), and a hostile glue is refused end-to-end
//     through `admitBundled` with the typed code.
//
// Residual honesty: these tests prove the TEXTUAL deny-list fires; they do
// not prove the absence of capabilities (docs/RISK-REGISTER.md R25).
// @ts-nocheck — browser stubs and dynamic envelopes are intentionally dynamic.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  EMSCRIPTEN_JS_CAPABILITY_DENY_LIST,
  auditEmscriptenJsCapabilities,
  isJsCapabilityAssetRole,
} from "../extension/lib/emscripten-js-capability-audit.js";
import {
  auditEmscriptenGraph,
  auditEmscriptenModule,
} from "../extension/lib/emscripten-module-audit.js";
import {
  buildNumericAcceptancePackage,
  NUMERIC_ACCEPTANCE_PINS,
} from "../scripts/lib/emscripten-numeric-acceptance.mjs";
import {
  buildBlake3AdmissionPackage,
} from "../scripts/lib/emscripten-blake3-admission.mjs";
import {
  canonicalJson,
  registerSchema2Surface,
  WasmPackageAuthority,
  WasmPackageAuthorityError,
} from "../extension/lib/wasm-package-authority.js";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  assertEmscriptenBlake3Eligibility,
  emscriptenIdentity,
} from "../extension/lib/emscripten-manifest.js";

// Static import graph edges for select-tests tracking:
// import("../extension/lib/emscripten-worker.js")
// import("../extension/about/about.html")

const HEX64 = /^[0-9a-f]{64}$/u;
const enc = new TextEncoder();

// ── Hostile fixtures: one per deny-list entry, each matching ONLY its entry ──
const FIXTURES = new Map(Object.entries({
  "navigator.storage": `export const q = () => navigator.storage.estimate();`,
  "getDirectoryHandle": `export const q = (dir) => dir.getDirectoryHandle("x");`,
  "getFileHandle": `export const q = (dir) => dir.getFileHandle("x");`,
  "createSyncAccessHandle": `export const q = (h) => h.createSyncAccessHandle();`,
  "createWritable": `export const q = (h) => h.createWritable();`,
  "caches": `export const q = () => caches.open("x");`,
  "indexedDB": `export const q = () => indexedDB.databases();`,
  "worker-construction": `export const q = () => new Worker("w.mjs", { type: "module" });`,
  "network-dynamic-import": `export const q = () => import("https://cdn.example.invalid/x.mjs");`,
  "fetch": `export const q = () => fetch("/x");`,
  "xhr": `export const q = () => new XMLHttpRequest();`,
}));

const CLEAN_SOURCE = `export const q = (a, b) => a + b;\n`;

/** Scan one synthetic asset; returns {ok, audit} or {ok:false, error}. */
function scanSource(source, { role = "glue", sha256 = "a".repeat(64), id = "glue" } = {}) {
  const path = `extension/wasm/runtime/pkg/1.0.0/${role}.mjs`;
  const bytes = enc.encode(source);
  const files = new Map([[path, bytes]]);
  const asset = { id, role, path, sha256, size: bytes.byteLength };
  try {
    return { ok: true, audit: auditEmscriptenJsCapabilities([asset], files) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function evidenceBytes(rel) {
  return await Deno.readFile(new URL(`../${rel}`, import.meta.url));
}

Deno.test("js-capability admission: the deny-list is one frozen constant with unique typed codes", () => {
  assert(Object.isFrozen(EMSCRIPTEN_JS_CAPABILITY_DENY_LIST), "deny-list must be frozen");
  const ids = EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id);
  const codes = EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.code);
  assertEquals(new Set(ids).size, ids.length, "entry ids must be unique");
  assertEquals(new Set(codes).size, codes.length, "refusal codes must be unique");
  for (const e of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
    assert(Object.isFrozen(e), `entry ${e.id} must be frozen`);
    assertEquals(typeof e.id, "string");
    assertEquals(typeof e.code, "string");
    assert(e.pattern instanceof RegExp, `entry ${e.id} needs a pattern`);
    assertEquals(e.pattern.global, false, `entry ${e.id} pattern must be stateless`);
    for (const digest of e.exemptGlue ?? []) assert(HEX64.test(digest), `entry ${e.id} exemptions must be sha256 digests`);
  }
  // The bead's documented list, all present.
  for (const required of [
    "navigator.storage", "getDirectoryHandle", "getFileHandle", "createSyncAccessHandle",
    "createWritable", "caches", "indexedDB", "worker-construction",
    "network-dynamic-import", "fetch", "xhr",
  ]) {
    assert(ids.includes(required), `deny-list must cover ${required}`);
  }
  // Only the two emscripten-preamble entries carry exemptions.
  assertEquals(
    EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.filter((e) => e.exemptGlue && e.exemptGlue.size).map((e) => e.id).sort(),
    ["fetch", "xhr"],
  );
  assertEquals(isJsCapabilityAssetRole("glue"), true);
  assertEquals(isJsCapabilityAssetRole("adapter"), true);
  assertEquals(isJsCapabilityAssetRole("main-wasm"), false);
});

Deno.test("js-capability admission: every deny-list entry has a fixture and every fixture names a live entry", () => {
  for (const entry of EMSCRIPTEN_JS_CAPABILITY_DENY_LIST) {
    assert(FIXTURES.has(entry.id), `deny-list entry "${entry.id}" has no hostile fixture — add one to FIXTURES`);
  }
  for (const id of FIXTURES.keys()) {
    assert(
      EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.some((e) => e.id === id),
      `fixture "${id}" names no live deny-list entry`,
    );
  }
});

Deno.test("js-capability admission: each fixture is refused with its typed code; clean bytes pass", () => {
  for (const [id, source] of FIXTURES) {
    const entry = EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.find((e) => e.id === id);
    const { ok, audit, error } = scanSource(source);
    assertEquals(ok, false, `fixture ${id} must be refused`);
    assertEquals(error instanceof WasmPackageAuthorityError, true, `fixture ${id} must refuse with the authority error`);
    assertEquals(error.code, "js_capability_denied", `fixture ${id}: wrong refusal code`);
    assertEquals(error.detail, `glue:${entry.code}`, `fixture ${id}: typed capability code must name the entry`);
    assertEquals(error.path, "wasm");
    assertEquals(audit, undefined);
  }
  const clean = scanSource(CLEAN_SOURCE);
  assertEquals(clean.ok, true);
  assertEquals(clean.audit.verdict, "pass");
  assertEquals(clean.audit.scanned, [{ asset: "glue", role: "glue", sha256: "a".repeat(64), exemptions: [] }]);
  assertEquals(clean.audit.denyList, EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
});

Deno.test("js-capability admission: the preamble exemption is byte-exact and glue-only", async () => {
  const reviewedGlue = [
    ["packages/bundled/evidence/emscripten-abi/build-a/numeric.mjs", NUMERIC_ACCEPTANCE_PINS.glue.sha256],
    ["packages/bundled/evidence/blake3-wasm/glue/blake3.mjs", "7d03777d994e39a8a619a8c9fe20c1bcb11710b114fc2f280022a2a103052878"],
    ["packages/bundled/evidence/emscripten-abi/build-a/image-resize.mjs", "3c1c0e4381fe914b33dd554905d28e8dc777f1bda4bd42dcf05edd1380d7bea0"],
    ["packages/bundled/evidence/emscripten-abi/build-a/link-main.mjs", "bcddb43afe69fc2fb90102bf3ab0fcf83395177098ce647659bf1ee707292d76"],
  ];
  for (const [rel, digest] of reviewedGlue) {
    const source = new TextDecoder().decode(await evidenceBytes(rel));
    assert(/fetch\s*\(/.test(source), `${rel} is expected to carry the reviewed fetch preamble`);
    const { ok, audit } = scanSource(source, { role: "glue", sha256: digest });
    assertEquals(ok, true, `reviewed glue ${rel} must admit`);
    assertEquals(audit.scanned[0].exemptions, ["fetch", "xhr"], `${rel}: preamble exemptions must be recorded`);
  }
  // The hostile negative glues carry the SAME idioms with DIFFERENT bytes:
  // no digest, no exemption.
  for (const rel of [
    "packages/bundled/evidence/emscripten-abi/build-a/negative-global.mjs",
    "packages/bundled/evidence/emscripten-abi/build-a/negative-main-em-asm.mjs",
    "packages/bundled/evidence/emscripten-abi/build-a/negative-main-em-js.mjs",
  ]) {
    const source = new TextDecoder().decode(await evidenceBytes(rel));
    const { ok, error } = scanSource(source, { role: "glue", sha256: "b".repeat(64) });
    assertEquals(ok, false, `hostile glue ${rel} must be refused`);
    assertEquals(error.code, "js_capability_denied");
  }
  // Adapters are never exempt — even with a reviewed digest.
  const { ok, error } = scanSource(FIXTURES.get("fetch"), { role: "adapter", sha256: NUMERIC_ACCEPTANCE_PINS.glue.sha256, id: "adapter" });
  assertEquals(ok, false, "adapter with fetch must be refused even under a reviewed digest");
  assertEquals(error.detail, "adapter:fetch_call");
});

function fileMapFor(out) {
  return new Map(
    out.files
      .filter((f) => out.manifest.assets.some((a) => a.path === f.rel))
      .map((f) => [f.rel, f.bytes]),
  );
}

Deno.test("js-capability admission: numeric acceptance package admits with unchanged digests and a pass receipt", async () => {
  const out = await buildNumericAcceptancePackage();
  const fileMap = fileMapFor(out);
  assertEquals(fileMap.size, 3);
  const graph = await auditEmscriptenGraph(
    { assets: out.manifest.assets, modules: out.manifest.modules, linkGraph: out.manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenNumericEligibility(out.manifest, graph);
  assertEquals(graph.jsAudit.verdict, "pass");
  assertEquals(graph.jsAudit.scanned.length, 2);
  assertEquals(graph.jsAudit.scanned[0].asset, "adapter");
  assertEquals(graph.jsAudit.scanned[0].exemptions, []);
  assertEquals(graph.jsAudit.scanned[1].asset, "glue");
  assertEquals(graph.jsAudit.scanned[1].exemptions, ["fetch", "xhr"]);
  // Digest-neutrality: identity derives from the manifest only, so the pinned
  // graph digest must be unchanged by the receipt field's existence.
  const identity = emscriptenIdentity(out.manifest);
  assertEquals(identity.graphDigest, out.identity.graphDigest);
  assertEquals(identity.graphDigest, "00544d07c39c5cee8473217ef1472d19dc8e0e60f36c3cbef4eb9f63833e7771");
  assertEquals(out.manifestDigest, "97621e5e889b272b79b7e0723a7f5b94254ac187be2cd896e02a35a3a2119343");
});

Deno.test("js-capability admission: blake3 acceptance package admits with unchanged digests and a pass receipt", async () => {
  const out = await buildBlake3AdmissionPackage();
  const fileMap = fileMapFor(out);
  assertEquals(fileMap.size, 3);
  const graph = await auditEmscriptenGraph(
    { assets: out.manifest.assets, modules: out.manifest.modules, linkGraph: out.manifest.linkGraph },
    fileMap,
  );
  assertEmscriptenBlake3Eligibility(out.manifest, graph);
  assertEquals(graph.jsAudit.verdict, "pass");
  assertEquals(graph.jsAudit.scanned[0].asset, "adapter");
  assertEquals(graph.jsAudit.scanned[1].asset, "glue");
  assertEquals(graph.jsAudit.scanned[1].exemptions, ["fetch", "xhr"]);
  const identity = emscriptenIdentity(out.manifest);
  assertEquals(identity.graphDigest, out.identity.graphDigest);
  assertEquals(identity.graphDigest, "529b2bd1bda57c6fc78b4af0c17ea32d7f9fbac639afea1e57f4af674dfbf45f");
  assertEquals(out.manifestDigest, "fecab10d5df322397812c0395df0a5ab35a5713a734f542eb539e2ed8163352f");
});

class FakeStore {
  constructor() {
    this.rows = new Map();
    this.version = 0;
  }
  async getStrict(key) { return this.rows.has(key) ? structuredClone(this.rows.get(key).value) : null; }
  async getVersion(key) { return this.rows.get(key)?.version ?? 0; }
  async setTrusted(key, value) {
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    return token;
  }
  async compareAndRestore(key, expectedVersion, value) {
    if ((this.rows.get(key)?.version ?? 0) !== expectedVersion) return false;
    const token = ++this.version;
    this.rows.set(key, { value: structuredClone(value), version: token });
    return true;
  }
}

async function shaHexBytes(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function registerRealSurface() {
  registerSchema2Surface({
    validateManifest: validateEmscriptenManifest,
    validateProvenance: validateEmscriptenProvenance,
    assertNumericEligibility: assertEmscriptenNumericEligibility,
    assertBlake3Eligibility: assertEmscriptenBlake3Eligibility,
    identity: emscriptenIdentity,
    auditGraph: auditEmscriptenGraph,
    auditModule: auditEmscriptenModule,
  });
}

function inventoryFor(files, manifestRow) {
  return {
    schemaVersion: 1,
    release: "0.3.616",
    signer: { lane: "bundled", keyId: "cap-bundled-release" },
    manifests: [manifestRow],
    files: [...files.entries()],
    evidence: [],
    revocations: [],
    listFiles: async () => [...files.keys()],
    readFile: async (rel) => files.get(rel),
  };
}

async function inventoryWithDigests(inventory) {
  inventory.files = await Promise.all(inventory.files.map(async ([rel, bytes]) => ({
    rel, sha256: await shaHexBytes(bytes), size: bytes.byteLength,
  })));
  return inventory;
}

Deno.test("js-capability admission: admitBundled records the verdict on the receipt", async () => {
  registerRealSurface();
  const out = await buildNumericAcceptancePackage();
  const files = new Map(out.files.map((f) => [f.rel, f.bytes]));
  // The manifest pins the shared CAP-authored license text; the builder does
  // not emit it, but _verifyBundle requires it in the inventory.
  files.set("extension/wasm/licenses/CAP-authored-Apache-2.0.txt", await evidenceBytes("extension/wasm/licenses/CAP-authored-Apache-2.0.txt"));
  const inventory = await inventoryWithDigests(inventoryFor(files, out.inventoryManifestRow));
  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const admission = await authority.admitBundled({ manifest: out.manifestCanonical, files: null });
  assertEquals(admission.ok, true);
  const current = admission.record.current;
  assertEquals(current.manifestDigest, out.manifestDigest);
  assertEquals(current.graphDigest, out.identity.graphDigest);
  // THE receipt: the JS capability verdict is visible at validate time.
  const audit = current.jsCapabilityAudit;
  assertEquals(audit?.verdict, "pass");
  assertEquals(audit.denyList, EMSCRIPTEN_JS_CAPABILITY_DENY_LIST.map((e) => e.id));
  assertEquals(audit.scanned.map((row) => row.asset), ["adapter", "glue"]);
  assertEquals(audit.scanned[1].exemptions, ["fetch", "xhr"]);
});

Deno.test("js-capability admission: a hostile glue is refused end-to-end through admitBundled", async () => {
  registerRealSurface();
  const out = await buildNumericAcceptancePackage();
  const hostileGlue = enc.encode(FIXTURES.get("caches"));
  const hostileDigest = await shaHexBytes(hostileGlue);
  const manifest = structuredClone(out.manifest);
  const glueAsset = manifest.assets.find((a) => a.role === "glue");
  glueAsset.sha256 = hostileDigest;
  glueAsset.size = hostileGlue.byteLength;
  const canonical = canonicalJson(manifest);
  const patchedDigest = new WasmPackageAuthority().manifestDigest(canonical);
  assert(patchedDigest !== out.manifestDigest, "patched manifest must have a new digest");

  const files = new Map(out.files.map((f) => [f.rel, f.bytes]));
  files.set(glueAsset.path, hostileGlue);
  const inventory = await inventoryWithDigests(inventoryFor(files, {
    pkg: NUMERIC_ACCEPTANCE_PINS.packageId,
    version: NUMERIC_ACCEPTANCE_PINS.packageVersion,
    digest: patchedDigest,
  }));
  const store = new FakeStore();
  const authority = new WasmPackageAuthority({ getStore: () => store, inventory, now: () => 1000 });
  const error = await authority.admitBundled({ manifest: canonical, files: null }).then(
    () => null,
    (e) => e,
  );
  assert(error, "hostile glue must be refused at admission");
  assertEquals(error instanceof WasmPackageAuthorityError, true);
  assertEquals(error.code, "js_capability_denied");
  assertEquals(error.detail, "glue:cache_storage");
  // The refusal precedes the registry write: nothing was admitted.
  const registryRaw = await store.getStrict("wasmPkg");
  assertEquals(registryRaw === null || Object.keys(registryRaw.packages ?? {}).length === 0, true);
});

Deno.test("js-capability admission: settings receipt pins (copy contract untouched, verdict element present)", async () => {
  // The loaded harness pins `.validation-status` copy byte-exactly
  // (parseValidationStatus requires SUCCESS_COPY === full text), so the
  // verdict MUST render in the sibling element, never in the status line.
  const componentSource = await Deno.readTextFile(
    new URL("../extension/shared/components-settings.js", import.meta.url),
  );
  assert(componentSource.includes('class="validation-status"'), "status element must remain");
  assert(componentSource.includes('class="validation-js-audit"'), "the verdict element must exist");
  assert(
    componentSource.includes("`Validation failed: ${value.error ?? \"unknown refusal\"}${where}.`"),
    "failure copy contract must stay parseable by parseValidationStatus",
  );
  assert(componentSource.includes("jsCapabilityAudit"), "the setter must read the receipt verdict");
  assert(componentSource.includes("js_capability_denied"), "the setter must render the typed refusal");
  const panelSource = await Deno.readTextFile(
    new URL("../extension/options/panels/tool-library.js", import.meta.url),
  );
  assert(panelSource.includes("detail: response?.detail ?? null"), "the panel must carry the typed refusal detail");
});

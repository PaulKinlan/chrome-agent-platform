// wjrgk: structural graph validity is not Emscripten execution eligibility.
// An eager graph must fail real bundled admission before any registry access.
// This fixture can materialize packed acceptance bytes, so it is NOT always-on.
// @ts-nocheck
import { assert, assertEquals, assertInstanceOf } from "jsr:@std/assert@1";
import { auditEmscriptenGraph } from "../extension/lib/emscripten-module-audit.js";
import {
  assertEmscriptenNumericEligibility,
  assertEmscriptenBlake3Eligibility,
} from "../extension/lib/emscripten-manifest.js";
import "../extension/lib/wasm-package-admission.js";
import {
  canonicalJson, WasmPackageAuthority, WasmPackageAuthorityError,
} from "../extension/lib/wasm-package-authority.js";
import { buildNumericAcceptancePackage } from "../scripts/lib/emscripten-numeric-acceptance.mjs";

const hashBytes = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((value) => value.toString(16).padStart(2, "0")).join("");

Deno.test("static-first: structurally eager graph is refused by both eligibilities and actual bundled admission", async () => {
  const out = await buildNumericAcceptancePackage();
  const manifest = structuredClone(out.manifest);
  manifest.linkGraph.policy = "eager";
  const files = new Map(out.files.map(({ rel, bytes }) => [rel, bytes]));
  files.set("extension/wasm/licenses/CAP-authored-Apache-2.0.txt",
    await Deno.readFile(new URL("../extension/wasm/licenses/CAP-authored-Apache-2.0.txt", import.meta.url)));
  const measured = await auditEmscriptenGraph({
    assets: manifest.assets, modules: manifest.modules, linkGraph: manifest.linkGraph,
  }, new Map(manifest.assets.map((asset) => [asset.path, files.get(asset.path)])));
  assert(measured, "structural validation deliberately permits eager; eligibility owns refusal");
  for (const eligibility of [assertEmscriptenNumericEligibility, assertEmscriptenBlake3Eligibility]) {
    let caught: unknown;
    try { eligibility(manifest, measured); } catch (error) { caught = error; }
    assertInstanceOf(caught, WasmPackageAuthorityError);
    assertEquals(caught.code, "link_runtime_unsupported", "pin the existing unprefixed typed code");
  }
  const canonical = canonicalJson(manifest);
  const digest = new WasmPackageAuthority().manifestDigest(canonical);
  const inventory = {
    schemaVersion: 1,
    release: "0.3.616",
    signer: { lane: "bundled", keyId: "cap-bundled-release" },
    manifests: [{ ...out.inventoryManifestRow, digest }],
    files: await Promise.all([...files].map(async ([rel, bytes]) => ({ rel, size: bytes.length, sha256: await hashBytes(bytes) }))),
    evidence: [], revocations: [],
    listFiles: async () => [...files.keys()],
    readFile: async (rel: string) => files.get(rel),
  };
  const authority = new WasmPackageAuthority({ inventory, getStore: () => { throw new Error("no registry access on refusal"); } });
  let caught: unknown;
  try { await authority.admitBundled({ manifest: canonical, files: null }); } catch (error) { caught = error; }
  assertInstanceOf(caught, WasmPackageAuthorityError);
  assertEquals(caught.code, "link_runtime_unsupported", "real admission must refuse before registry access");
});

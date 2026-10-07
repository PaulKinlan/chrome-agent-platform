// chrome-agent-platform-ltkj.2 — committed contract for the loaded admission
// acceptance harness (scripts/emscripten-admission-loaded.ts, class "manual").
// Pure functions + source pins only; no browser runs here. The harness itself:
//   - copies ONLY into disposable durable scratch (never writes the reviewed
//     tree), rebuilds with the explicit acceptance target, and removes the
//     copy only after teardownChrome confirms death (never-delete-live);
//   - drives the real Settings click → SW broker → options-host admission →
//     rendered receipt chain, positive and one-byte-mutation negatives.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  COPY_SKIP_DIRS,
  mutationPlan,
  planOffset,
  applyMutation,
  parseValidationStatus,
  assertPositiveRegistry,
  assertNegativeRegistry,
} from "../scripts/emscripten-admission-loaded.ts";
import { buildNumericAcceptancePackage, NUMERIC_ACCEPTANCE_PINS } from "../scripts/lib/emscripten-numeric-acceptance.mjs";

const enc = new TextEncoder();

Deno.test("harness: one-byte mutation plans are exact, unambiguous and non-trivial", async () => {
  const synthetic = enc.encode("prefix cap-emscripten-admission-provenance-v1 suffix");
  const sidecarPlan = mutationPlan("sidecar");
  const offset = planOffset(synthetic, sidecarPlan);
  assertEquals(synthetic[offset], 0x63); // first needle byte 'c' → 'C'
  const { mutated } = applyMutation(synthetic, sidecarPlan);
  let diff = 0;
  for (let i = 0; i < synthetic.length; i++) if (synthetic[i] !== mutated[i]) diff += 1;
  assertEquals(diff, 1);
  // Ambiguous needle: refused.
  const ambiguous = enc.encode("cap-emscripten-admission-provenance-v1 cap-emscripten-admission-provenance-v1");
  assertThrows(() => planOffset(ambiguous, sidecarPlan), Error, "found 2 times");
  // Absent needle: refused.
  assertThrows(() => planOffset(enc.encode("nothing here"), sidecarPlan), Error, "found 0 times");
  // Binary plan: fixed tail offset, length-preserving, refuses tiny files.
  const assetPlan = mutationPlan("asset");
  assertEquals(assetPlan.needle, null);
  const small = new Uint8Array([1, 2, 3]);
  assertThrows(() => planOffset(small, assetPlan), Error, "too small");
  const binary = new Uint8Array(64).fill(7);
  const binOut = applyMutation(binary, assetPlan);
  assertEquals(binOut.mutated.byteLength, 64);
  assertEquals(binOut.offset, 61);
  assertNotEqualBytes(binary, binOut.mutated);
  // A no-op xor is refused.
  assertThrows(() => applyMutation(binary, { ...assetPlan, xor: 0 }), Error, "no-op");
});

function assertNotEqualBytes(a: Uint8Array, b: Uint8Array) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff += 1;
  assertEquals(diff, 1);
}

Deno.test("harness: every negative plan mutates exactly one byte of the REAL emitted fixture and keeps JSON parseable", async () => {
  const out = await buildNumericAcceptancePackage();
  const byRel = new Map(out.files.map((f) => [f.rel, f.bytes]));
  for (const kind of ["asset", "manifest", "sidecar"] as const) {
    const plan = mutationPlan(kind);
    const original = byRel.get(plan.rel);
    assert(original, `plan targets a file the builder does not emit: ${plan.rel}`);
    const { mutated, offset } = applyMutation(original!, plan);
    assertEquals(mutated.byteLength, original!.byteLength, `${kind}: length must not change`);
    let diff = 0;
    for (let i = 0; i < mutated.length; i++) if (mutated[i] !== original![i]) diff += 1;
    assertEquals(diff, 1, `${kind}: exactly one byte may change`);
    assert(offset >= 0 && offset < mutated.length);
    if (kind !== "asset") {
      // Text fixtures stay valid JSON so the refusal comes from the inventory
      // hash layer (fail closed at the first layer that can see the drift),
      // not from a parse error.
      JSON.parse(new TextDecoder().decode(mutated));
    }
  }
});

Deno.test("harness: status copy classification is exact", () => {
  assertEquals(parseValidationStatus("Package validated. Execution is not enabled."), { state: "success" });
  assertEquals(parseValidationStatus("Validating package…"), { state: "busy" });
  assertEquals(parseValidationStatus(""), { state: "none" });
  assertEquals(parseValidationStatus(null), { state: "none" });
  assertEquals(parseValidationStatus("No Emscripten packages are available for validation in this build."), { state: "empty" });
  assertEquals(
    parseValidationStatus("Validation failed: inventory_mismatch (at extension/wasm/cas/fea83472b7e56292785f132d0c5f564048cf34ae047627334f504b28dd405503.wasm)."),
    { state: "failed", error: "inventory_mismatch", path: "extension/wasm/cas/fea83472b7e56292785f132d0c5f564048cf34ae047627334f504b28dd405503.wasm" },
  );
  assertEquals(parseValidationStatus("Validation failed: provenance_mismatch."), { state: "failed", error: "provenance_mismatch", path: undefined });
  assertEquals(parseValidationStatus("something else").state, "failed");
});

Deno.test("harness: positive registry assertions bind the pinned digests and refuse drift", () => {
  const good = {
    ok: true,
    record: {
      current: {
        state: "committed",
        version: NUMERIC_ACCEPTANCE_PINS.packageVersion,
        graphDigest: "00544d07c39c5cee8473217ef1472d19dc8e0e60f36c3cbef4eb9f63833e7771",
        manifestDigest: "97621e5e889b272b79b7e0723a7f5b94254ac187be2cd896e02a35a3a2119343",
      },
      history: [],
    },
  };
  const bound = assertPositiveRegistry(good);
  assertEquals(bound.state, "committed");
  assertThrows(() => assertPositiveRegistry({ ok: false, error: "absent" }), Error, "did not return a committed record");
  assertThrows(() => assertPositiveRegistry({ ...good, record: { ...good.record, current: { ...good.record.current, graphDigest: "0".repeat(64) } } }), Error, "graph digest drift");
  assertThrows(() => assertPositiveRegistry({ ...good, record: { ...good.record, current: { ...good.record.current, state: "prepared" } } }), Error, "not committed");
  assertThrows(() => assertPositiveRegistry({ ...good, record: { ...good.record, history: [{ v: 1 }] } }), Error, "empty history");
});

Deno.test("harness: negative registry assertions refuse any admitted record", () => {
  assertEquals(assertNegativeRegistry({ ok: false, error: "absent" }), "absent");
  assertThrows(() => assertNegativeRegistry({ ok: true, record: { current: { state: "committed" } } }), Error, "must not admit");
  assertThrows(() => assertNegativeRegistry({ ok: false, error: "revoked" }), Error, "unexpected registry refusal");
});

Deno.test("harness source pins: durable scratch, teardown-before-delete, acceptance-flag build, reviewed tree never written", async () => {
  const source = await Deno.readTextFile(new URL("../scripts/emscripten-admission-loaded.ts", import.meta.url));
  // Copy plan excludes the VCS + dependency trees.
  assert(COPY_SKIP_DIRS.has(".git") && COPY_SKIP_DIRS.has("node_modules"));
  // Durable directories for evidence, copy and profile (never /tmp).
  assert(source.includes('durableDir("astra", "ltkj2")'), "evidence must live under the durable root");
  assert(source.includes('durableDir("scratch")'), "the disposable copy must live under durable scratch");
  assert(source.includes('durableDir("chrome-profiles")'), "the profile must live under durable chrome-profiles");
  assert(!/makeTempDir\(\s*\)/u.test(source), "unrooted makeTempDir is banned");
  // Teardown runs in finally and precedes copy removal (never-delete-live).
  const finallyIdx = source.indexOf("} finally {");
  const teardownIdx = source.indexOf("await teardownChrome(chrome, profile)");
  const removeIdx = source.indexOf("await Deno.remove(dir, { recursive: true })");
  assert(finallyIdx > 0 && teardownIdx > finallyIdx && removeIdx > teardownIdx, "teardown must run before scratch removal inside finally");
  assert(source.includes("for (const dir of [copyRoot])"), "only the harness's own scratch copy may be removed");
  // The rebuild goes through the explicit acceptance target + env, and the
  // generated inventory import is REBUNDLED (no post-build injection).
  assert(source.includes('"--acceptance-emscripten-numeric"'), "generator must run with the explicit acceptance flag");
  assert(source.includes('CAP_ACCEPTANCE_EMSCRIPTEN_NUMERIC: "1"'), "the build must carry the acceptance env");
  assert(source.includes('"build.mjs", "--target=store"'), "the copy must rebuild through the real store build");
  assert(source.includes("validateDistCompleteMarker"), "the rebuilt copy must prove a complete store build");
  // The reviewed tree is never a write target.
  assert(!source.includes("Deno.writeFile(join(ROOT"), "harness must never write into the reviewed tree");
  assert(!source.includes("Deno.remove(ROOT"), "harness must never remove reviewed-tree paths");
  // Natural drain: no hard exit calls.
  assert(!source.includes("Deno.exit(") && !source.includes("process.exit("), "harness must drain naturally (of6z)");
  // Owner click drives the real button; receipt copy is the contract string.
  assert(source.includes("package-validate-btn"), "the harness must click the real validation button");
  assert(source.includes("Package validated. Execution is not enabled."), "success copy is the pinned contract string");
});

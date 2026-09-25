// lib/emscripten-admission.js — the schema-2 admission BROKER: options-document only.
//
// WHY THIS MODULE EXISTS (ycez / ltkj.2, 2026-09-25). The Emscripten schema-2 validator
// (`emscripten-manifest.js`) and the typed-graph auditor (`emscripten-module-audit.js`) must never be
// reachable from the service worker. `background/service-worker.js:75` imports
// `lib/tool-exec-preview.js`, which imports `lib/wasm-package-authority.js` — so an import of either
// module from the authority puts it in the SW bundle. Measured: with that wiring the Store SW bundle
// is 3,009,120 bytes against the unchanged 3,000,000 budget (over 9,120); clean main is 2,982,877.
// The independent contract review's CRITICAL pin says the same thing in words: the validation broker
// MUST run in the options document context (options.bundle.js) and NEVER be imported directly into
// service-worker.js.
//
// SO THE AUTHORITY TAKES THE SURFACE BY INJECTION: `registerSchema2Surface` (called HERE, once, at
// this module's load) supplies the validator, the provenance check, the numeric-eligibility check,
// the identity digest and the graph audit. In the SW the surface is absent and a schema-2 record
// refuses BY NAME (`schema2_broker_unavailable`) instead of validating partially. In the options
// document this module is loaded by the Settings validation action, which is the only surface that
// validates an Emscripten package today.
//
// It is not a size trick: no bytes disappear. The ~26KB moves to `options.bundle.js`, which the
// budget report covers but does not budget (only the SW bundle is gated), and the bytes genuinely run
// here rather than in the SW. `tests/reachability.test.ts` pins the exclusion so a later edit cannot
// quietly drag the two modules back into the service worker.
import {
  registerSchema2Surface,
  WasmPackageAuthority,
  parseCanonicalJson,
  canonicalJson,
} from "./wasm-package-authority.js";
import {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  emscriptenIdentity,
} from "./emscripten-manifest.js";
import { auditEmscriptenModule, auditEmscriptenGraph } from "./emscripten-module-audit.js";

registerSchema2Surface({
  validateManifest: validateEmscriptenManifest,
  validateProvenance: validateEmscriptenProvenance,
  assertNumericEligibility: assertEmscriptenNumericEligibility,
  identity: emscriptenIdentity,
  auditGraph: auditEmscriptenGraph,
  auditModule: auditEmscriptenModule,
});

/**
 * Validate one schema-2 admission record from its canonical JSON text.
 *
 * This is the Settings-only validation action's entry point: it reads and structurally checks a
 * record. It grants, registers and executes NOTHING — no inventory is loaded, no package is
 * admitted, and the returned verdict is the authority's own refusal vocabulary.
 */
export function validateSchema2Manifest(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { ok: false, error: "manifest_raw_required" };
  }
  return new WasmPackageAuthority().validateManifest(rawText);
}

export {
  validateEmscriptenManifest,
  validateEmscriptenProvenance,
  assertEmscriptenNumericEligibility,
  emscriptenIdentity,
  auditEmscriptenModule,
  auditEmscriptenGraph,
  parseCanonicalJson,
  canonicalJson,
};

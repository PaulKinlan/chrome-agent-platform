// Manually reviewed source identities for runtime JS that may bypass the
// authored-code AST scan. This is a THIRD anchor, independent of the generated
// bundled inventory and the manifest it indexes. Never derive these literals
// from the candidate tree: adding/changing an entry requires a source review
// of the named commit and bead. Metadata names that review; it is not a
// cryptographic attestation or a claim that arbitrary future bytes are safe.
// The default Store build currently ships no schema-2 runtime JS.
export const REVIEWED_RUNTIME_JS = Object.freeze({
  "wasm/runtime/cap_acceptance_a0_numeric/1.0.0/adapter.mjs": Object.freeze({
    packageId: "cap.acceptance.a0.numeric", version: "1.0.0", role: "adapter",
    sha256: "5f1ba5509267b0d7234fe508a10967be84451131d359f1eb1ab1b7e18dfe6a6b", size: 1751,
    sourceCommit: "4d01380683d8d56713f4aea27827a8a5902ca154",
    sourcePath: "packages/bundled/evidence/emscripten-abi/adapter/cap-a0-numeric-v1.mjs",
    reviewBead: "chrome-agent-platform-ltkj.2",
  }),
  "wasm/runtime/cap_acceptance_a0_numeric/1.0.0/glue.mjs": Object.freeze({
    packageId: "cap.acceptance.a0.numeric", version: "1.0.0", role: "glue",
    sha256: "921175ec0ad89d8af17dbdffc49e58033c8717a246fe80b458f32e4a5a8584a9", size: 6155,
    sourceCommit: "245cfdbbe9269f3ef7f60ed0a79465ac6f9d01e5",
    sourcePath: "packages/bundled/evidence/emscripten-abi/build-a/numeric.mjs",
    reviewBead: "chrome-agent-platform-ltkj.1",
  }),
});

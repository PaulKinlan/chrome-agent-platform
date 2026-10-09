// Literal adapter contract registry (chrome-agent-platform-ltkj.3). The broker
// selects the adapter; this registry is the ONLY binding between an admitted
// adapterId and the adapter module's factory export + operation methods.
// Unknown ids are an explicit unsupported error — never a generic loader.

export const EMSCRIPTEN_ADAPTER_CONTRACTS = Object.freeze({
  "cap-a0-numeric-v1": Object.freeze({
    factoryExport: "createNumericAdapter",
    operations: Object.freeze({
      "weighted_sum": "weightedSum",
    }),
  }),
  "cap-blake3-wasm-v1": Object.freeze({
    factoryExport: "createBlake3Adapter",
    operations: Object.freeze({
      "hash": "hash",
    }),
  }),
});

export function adapterContractFor(adapterId) {
  return Object.prototype.hasOwnProperty.call(EMSCRIPTEN_ADAPTER_CONTRACTS, adapterId)
    ? EMSCRIPTEN_ADAPTER_CONTRACTS[adapterId]
    : null;
}

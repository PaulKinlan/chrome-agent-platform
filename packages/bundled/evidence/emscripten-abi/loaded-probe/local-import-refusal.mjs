// Node-only regression for the engine import boundary; no browser/CSP claim.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

globalThis.self = globalThis;
const original = new URL("../build-a/", import.meta.url);
const loaded = new URL("./assets/", import.meta.url);
const adversaries = [
  {
    name: "negative-global.wasm",
    url: new URL("negative-global.wasm", original),
    symbol: "cap_ambient_global_probe",
  },
  {
    name: "unsafe-authority.wasm",
    url: new URL("unsafe-authority.wasm", loaded),
    symbol: "cap_attempt_browser_authority",
  },
];
const originalFetch = globalThis.fetch;
const fetchAttempts = [];
globalThis.fetch = async (url) => {
  fetchAttempts.push(String(url));
  throw new Error(
    `network forbidden during local import-refusal probe: ${url}`,
  );
};

try {
  let cases = 0;
  for (const adversary of adversaries) {
    const wasm = await readFile(adversary.url);
    assert.deepEqual(
      WebAssembly.Module.imports(await WebAssembly.compile(wasm)),
      [{
        module: "env",
        name: adversary.symbol,
        kind: "function",
      }],
    );
    for (const factoryName of ["numeric", "image-resize", "link-main"]) {
      const { default: factory } = await import(
        new URL(`${factoryName}.mjs`, original)
      );
      await assert.rejects(
        factory({ wasmBinary: wasm, printErr: () => {} }),
        (error) =>
          /LinkError/.test(String(error)) &&
          String(error).includes(adversary.symbol),
      );
      cases++;
    }
  }
  assert.equal(fetchAttempts.length, 0);
  console.log(JSON.stringify({
    environment: "Node only; no Chrome/CSP claim",
    cases,
    outcome: "refused-at-native-import-before-guest-execution",
    networkObservation: {
      instrumentedForFullProbeLifecycle: true,
      fetchAttempts,
    },
  }));
} finally {
  globalThis.fetch = originalFetch;
}

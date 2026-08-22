// lib/wasm-executor-bounds.js — the frozen bound constants for the Gate 2
// executor + offscreen transport. SOURCE ONLY.

export const EXECUTOR_BOUNDS = Object.freeze({
  maxWorkerStartupMs: 10_000,
  maxCallMs: 30_000,
  // The wasm BYTES get their own explicit cap = the allowed tiny-tier max
  // (WASM_PACKAGE_LIMITS.TIERS.tiny.maxBytes = 4 MiB): larger bundled tools
  // (sort/uniq/tr/grep/toml2json, 164–325 KB) must fit. The METADATA/request
  // JSON cap below stays 64 KiB — the wasm cap is enforced independently, so
  // there is NO unbounded raise.
  maxWasmBytes: 4 * 1024 * 1024,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 64 * 1024,
  maxTransportErrorBytes: 1024,
  maxSessionIdBytes: 256,
  maxWorkerInstanceIdBytes: 128,
  maxFileOpBytes: 1024 * 1024,
  maxWorkspaceRpcBytes: 64 * 1024,
  maxHandleIdBytes: 128,
});

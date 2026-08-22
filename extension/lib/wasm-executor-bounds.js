// lib/wasm-executor-bounds.js — the frozen bound constants for the Gate 2
// executor + offscreen transport. SOURCE ONLY.

export const EXECUTOR_BOUNDS = Object.freeze({
  maxWorkerStartupMs: 10_000,
  maxCallMs: 30_000,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 64 * 1024,
  maxTransportErrorBytes: 1024,
  maxSessionIdBytes: 256,
  maxWorkerInstanceIdBytes: 128,
  maxFileOpBytes: 1024 * 1024,
  maxWorkspaceRpcBytes: 64 * 1024,
  maxHandleIdBytes: 128,
});

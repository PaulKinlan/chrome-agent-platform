// lib/wasm-executor-bounds.js — the frozen bound constants for the Gate 2
// executor + offscreen transport. SOURCE ONLY.

// dptw (2026-09-03): every BYTE ceiling is removed (Infinity = no bound) —
// wasm binaries, request/response frames, file ops and workspace RPCs carry
// complete data at any size. What remains finite is TIME (startup/call
// budgets — a hung worker must still die) and ID grammar (session/instance/
// handle ids are bounded identifiers, not payload).
export const EXECUTOR_BOUNDS = Object.freeze({
  maxWorkerStartupMs: 10_000,
  maxCallMs: 30_000,
  maxWasmBytes: Number.POSITIVE_INFINITY,
  maxRequestBytes: Number.POSITIVE_INFINITY,
  maxResponseBytes: Number.POSITIVE_INFINITY,
  maxBinaryResponseBytes: Number.POSITIVE_INFINITY,
  maxBase64ResponseChars: Number.POSITIVE_INFINITY,
  maxTransportErrorBytes: Number.POSITIVE_INFINITY,
  maxSessionIdBytes: 256,
  maxWorkerInstanceIdBytes: 128,
  maxFileOpBytes: Number.POSITIVE_INFINITY,
  maxWorkspaceRpcBytes: Number.POSITIVE_INFINITY,
  maxHandleIdBytes: 128,
});

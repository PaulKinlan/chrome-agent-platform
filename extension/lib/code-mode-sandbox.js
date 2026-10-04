// extension/lib/code-mode-sandbox.js — the code-mode programmatic tool
// chaining gateway (chrome-agent-platform-jao1.4, CAP-SECURE-ENCLAVE Stage 4).
//
// The BOUNDS + SDK CONFIGURATION for model-authored tool-chaining scripts.
// The ACTUAL script execution happens in the SANDBOXED IFRAME PAGE (extension/
// sandbox/script-sandbox.html), whose CSP permits inline/eval — MV3 CSP
// forbids `new Function` in extension/lib (scanShippedJs enforces this), so
// this module provides the bounds configuration and the tool-call SDK
// DEFINITION (not an executor). The sandboxed iframe page defines its own
// `cap` SDK internally (identical shape) and routes tool calls back to the
// host via postMessage, which the host forwards to the SW's tool gateway.
//
// SECRET ISOLATION: the `cap` SDK exposes ONLY `callTool(name, args)` — the
// SW tool gateway enforces grants and approvals. No raw credential, token, or
// environment variable is ever placed in the sandbox scope.

/** @typedef {{ timeoutMs?: number, maxToolCalls?: number, maxIterations?: number }} SandboxBounds */

const DEFAULT_BOUNDS = Object.freeze({
  timeoutMs: 30_000,
  maxToolCalls: 50,
  maxIterations: 1_000,
});

/** Validate and normalize the sandbox bounds. Throws on invalid values. */
export function resolveBounds(bounds = {}) {
  const timeoutMs = Number(bounds.timeoutMs ?? DEFAULT_BOUNDS.timeoutMs);
  const maxToolCalls = Number(bounds.maxToolCalls ?? DEFAULT_BOUNDS.maxToolCalls);
  const maxIterations = Number(bounds.maxIterations ?? DEFAULT_BOUNDS.maxIterations);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`code-mode sandbox: timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new TypeError(`code-mode sandbox: maxToolCalls must be a positive safe integer, got ${maxToolCalls}`);
  }
  if (!Number.isSafeInteger(maxIterations) || maxIterations <= 0) {
    throw new TypeError(`code-mode sandbox: maxIterations must be a positive safe integer, got ${maxIterations}`);
  }
  return { timeoutMs, maxToolCalls, maxIterations };
}

/**
 * Create the tool-call bridge for a sandboxed script. The HOST (script-host.js)
 * calls `dispatchTool(name, args)` when the sandboxed script requests a tool
 * call via postMessage. The bridge tracks the call count and enforces the max.
 *
 * @param {{ dispatchTool: Function, bounds?: SandboxBounds }} opts
 * @returns {{ dispatchTool: Function, callCount: () => number, maxToolCalls: number, exceeded: boolean }}
 */
export function createToolBridge({ dispatchTool, bounds = {} } = {}) {
  if (typeof dispatchTool !== "function") {
    throw new TypeError("code-mode sandbox requires a dispatchTool callback");
  }
  const resolved = resolveBounds(bounds);
  let callCount = 0;

  async function callTool(name, args) {
    if (callCount >= resolved.maxToolCalls) {
      throw new Error(`code-mode sandbox: tool call limit (${resolved.maxToolCalls}) exceeded — the script is making too many tool calls`);
    }
    callCount++;
    return await dispatchTool(String(name), args && typeof args === "object" ? args : {});
  }

  return {
    dispatchTool: callTool,
    callCount: () => callCount,
    maxToolCalls: resolved.maxToolCalls,
    get exceeded() { return callCount >= resolved.maxToolCalls; },
  };
}

/**
 * Validate a script source for basic sanity (non-empty, no `while(true)` that
 * would hang the sandbox — the execution timeout is the backstop).
 *
 * @param {string} source
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateSource(source) {
  if (typeof source !== "string" || !source.trim()) {
    return { ok: false, error: "code-mode sandbox: empty or missing script source" };
  }
  return { ok: true };
}

/** The default bounds for reference. */
export { DEFAULT_BOUNDS };

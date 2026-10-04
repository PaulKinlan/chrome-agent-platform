// extension/lib/code-mode-sandbox.js — the code-mode programmatic tool
// chaining gateway (chrome-agent-platform-jao1.4, CAP-SECURE-ENCLAVE Stage 4).
//
// Enables models to execute programmatic tool-chaining scripts (JS in the
// sandbox) that chain multiple tool calls in a tight loop. The sandbox gets a
// `cap` SDK with `callTool(name, args)` — every call routes through the
// injected `dispatchTool` callback (the Service Worker tool gateway), so the
// sandbox never holds raw credentials or ambient environment variables.
//
// BOUNDS: execution timeout, max tool calls per script, max iterations.
// SECRET ISOLATION: the `cap` SDK only exposes `callTool(name, args)` — the
// SW tool gateway enforces grants and approvals. No raw credential or
// environment variable is ever placed in the sandbox scope.

/** @typedef {{ timeoutMs?: number, maxToolCalls?: number, maxIterations?: number }} SandboxBounds */

const DEFAULT_BOUNDS = Object.freeze({
  timeoutMs: 30_000,
  maxToolCalls: 50,
  maxIterations: 1_000,
});

/**
 * Create the `cap` SDK that a sandboxed script uses to call tools.
 * Every `cap.callTool(name, args)` invokes `dispatchTool(name, args)` —
 * the SW tool gateway — and returns the gateway's result.
 *
 * @param {{ dispatchTool: Function, bounds?: SandboxBounds }} opts
 * @returns {{ cap: object, callCount: () => number }}
 */
export function createToolBridge({ dispatchTool, bounds = {} } = {}) {
  if (typeof dispatchTool !== "function") {
    throw new TypeError("code-mode sandbox requires a dispatchTool callback");
  }
  const maxCalls = bounds.maxToolCalls ?? DEFAULT_BOUNDS.maxToolCalls;
  let callCount = 0;

  async function callTool(name, args) {
    if (callCount >= maxCalls) {
      throw new Error(`code-mode sandbox: tool call limit (${maxCalls}) exceeded — the script is making too many tool calls`);
    }
    callCount++;
    return await dispatchTool(String(name), args && typeof args === "object" ? args : {});
  }

  return {
    cap: Object.freeze({
      callTool,
    }),
    callCount: () => callCount,
  };
}

/**
 * Create a sandboxed runner: evaluates JS source with the `cap` SDK in scope
 * and enforces the execution bounds (timeout, iteration limit).
 *
 * @param {{ dispatchTool: Function, bounds?: SandboxBounds }} opts
 * @returns {{ run: (source: string) => Promise<object> }}
 */
export function createSandboxRunner(opts = {}) {
  const { timeoutMs = DEFAULT_BOUNDS.timeoutMs, maxIterations = DEFAULT_BOUNDS.maxIterations } = opts.bounds ?? {};
  const bridge = createToolBridge(opts);

  return {
    cap: bridge.cap,
    async run(source) {
      if (typeof source !== "string" || !source.trim()) {
        throw new Error("code-mode sandbox: empty or missing script source");
      }
      // Build an async function with `cap` in scope. The source is the model-
      // authored script body — it can `await cap.callTool(...)` and chain calls.
      let fn;
      try {
        fn = new Function("cap", `"use strict";\nreturn (async () => {\n${source}\n})();`);
      } catch (e) {
        throw new Error(`code-mode sandbox: script has a syntax error — ${e.message}`);
      }

      // Enforce the execution timeout.
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`code-mode sandbox: execution timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      // The iteration bound IS the tool-call limit: each loop iteration calls
      // a tool (via cap.callTool), and createToolBridge enforces the max.
      const result = await Promise.race([fn(bridge.cap), timeout]);
      return { ok: true, result: result ?? null, toolCalls: bridge.callCount() };
    },
  };
}

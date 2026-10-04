// tests/code-mode-sandbox.test.ts — chrome-agent-platform-jao1.4
// (CAP-SECURE-ENCLAVE Stage 4). The code-mode sandbox's contract:
// tool bridge (callTool routing), bounds enforcement, secret isolation.
//
// NOTE: the actual script EXECUTION happens in the sandboxed iframe page
// (which has CSP permitting eval — MV3 CSP forbids new Function in
// extension/lib). This test suite pins the BOUNDS and TOOL BRIDGE layers
// that run in the extension context. The end-to-end sandbox execution is
// verified by the real-browser drive.

import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createToolBridge, resolveBounds, validateSource, DEFAULT_BOUNDS } from "../extension/lib/code-mode-sandbox.js";

/** A fake tool gateway: records calls, returns scripted results. */
function fakeGateway() {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    dispatchTool: async (name: string, args: any) => {
      calls.push({ name, args });
      return { ok: true, data: `result for ${name}` };
    },
  };
}

Deno.test("jao1.4: tool bridge — callTool routes through the dispatchTool callback", async () => {
  const gw = fakeGateway();
  const bridge = createToolBridge({ dispatchTool: gw.dispatchTool });
  const result = await bridge.dispatchTool("list_tabs", {});
  assertEquals(result.ok, true);
  assertEquals(gw.calls.length, 1);
  assertEquals(gw.calls[0].name, "list_tabs");
  assertEquals(bridge.callCount(), 1);
});

Deno.test("jao1.4: tool bridge — max tool calls enforced (the bound throws before exceeding)", async () => {
  const gw = fakeGateway();
  const bridge = createToolBridge({ dispatchTool: gw.dispatchTool, bounds: { maxToolCalls: 3 } });
  for (let i = 0; i < 3; i++) await bridge.dispatchTool("noop", { i });
  assertEquals(bridge.callCount(), 3, "the call count is at the bound");
  await assertRejects(
    () => bridge.dispatchTool("noop", {}),
    Error,
    "tool call limit (3) exceeded",
  );
});

Deno.test("jao1.4: tool bridge — exceeded flag is readable for pre-flight checks", async () => {
  const gw = fakeGateway();
  const bridge = createToolBridge({ dispatchTool: gw.dispatchTool, bounds: { maxToolCalls: 2 } });
  await bridge.dispatchTool("a", {});
  await bridge.dispatchTool("b", {});
  assertEquals(bridge.exceeded, true, "the exceeded flag is true at the bound");
});

Deno.test("jao1.4: bounds resolution — defaults, overrides, and invalid values", () => {
  assertEquals(resolveBounds(), { timeoutMs: 30_000, maxToolCalls: 50, maxIterations: 1_000 });
  assertEquals(resolveBounds({ timeoutMs: 5000, maxToolCalls: 10, maxIterations: 200 }), { timeoutMs: 5000, maxToolCalls: 10, maxIterations: 200 });
  assertThrows(() => resolveBounds({ timeoutMs: -1 }), TypeError, "timeoutMs");
  assertThrows(() => resolveBounds({ maxToolCalls: 0 }), TypeError, "maxToolCalls");
  assertThrows(() => resolveBounds({ maxIterations: -5 }), TypeError, "maxIterations");
  assertEquals(DEFAULT_BOUNDS.timeoutMs, 30_000);
});

Deno.test("jao1.4: source validation — empty/missing source is rejected without eval", () => {
  assertEquals(validateSource("").ok, false);
  assertEquals(validateSource("   ").ok, false);
  assertEquals(validateSource("return 1 + 1").ok, true);
});

Deno.test("jao1.4: tool bridge — the SDK exposes ONLY the tool dispatch (secret isolation)", async () => {
  const gw = fakeGateway();
  const bridge = createToolBridge({ dispatchTool: gw.dispatchTool });
  // The bridge's dispatchTool is a wrapper — it carries no credentials,
  // tokens, or environment variables. The caller (sandboxed script) sees only
  // the tool-call function.
  assert(typeof bridge.dispatchTool === "function");
  assertEquals(typeof bridge.callCount, "function");
  assertEquals(bridge.maxToolCalls, 50);
  // No credential surfaces exist on the bridge.
  const keys = Object.keys(bridge);
  assert(!keys.includes("secret"), "no secret on the bridge");
  assert(!keys.includes("token"), "no token on the bridge");
  assert(!keys.includes("apiKey"), "no apiKey on the bridge");
});

Deno.test("jao1.4: tool bridge requires dispatchTool (fail closed)", () => {
  assertThrows(() => (createToolBridge as any)({}), TypeError, "dispatchTool");
});

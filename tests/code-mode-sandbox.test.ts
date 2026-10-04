// tests/code-mode-sandbox.test.ts — chrome-agent-platform-jao1.4
// (CAP-SECURE-ENCLAVE Stage 4). The code-mode sandbox's contract:
// multi-step tool chaining, secret isolation, bounds enforcement.

// @ts-nocheck
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { createToolBridge, createSandboxRunner } from "../extension/lib/code-mode-sandbox.js";

/** A fake tool gateway: records calls, returns scripted results. */
function fakeGateway(results = {}) {
  const calls: any[] = [];
  return {
    calls,
    dispatchTool: async (name: string, args: any) => {
      calls.push({ name, args });
      if (results[name] !== undefined) return results[name];
      return { ok: true, data: `result for ${name}` };
    },
  };
}

Deno.test("jao1.4: tool bridge — callTool routes through the dispatchTool callback", async () => {
  const gw = fakeGateway();
  const bridge = createToolBridge({ dispatchTool: gw.dispatchTool });
  const result = await bridge.cap.callTool("list_tabs", {});
  assertEquals(result.ok, true);
  assertEquals(gw.calls.length, 1);
  assertEquals(gw.calls[0].name, "list_tabs");
  assertEquals(bridge.callCount(), 1);
});

Deno.test("jao1.4: multi-step chaining — search -> extract in one script", async () => {
  const gw = fakeGateway({
    web_search: { results: [{ url: "https://example.com/data", title: "Data page" }] },
    read_page: { content: "the extracted data is 42" },
  });
  const runner = createSandboxRunner({
    dispatchTool: gw.dispatchTool,
    bounds: { timeoutMs: 5_000, maxToolCalls: 10, maxIterations: 100 },
  });
  const result = await runner.run(`
    const search = await cap.callTool("web_search", { query: "test data" });
    const url = search.results[0].url;
    const page = await cap.callTool("read_page", { url });
    return { extracted: page.content, chained: true };
  `);
  const data = result.result as any;
  assertEquals(data.chained, true);
  assertEquals(data.extracted, "the extracted data is 42");
  assertEquals(gw.calls.length, 2, "two tool calls chained");
  assertEquals(gw.calls[0].name, "web_search");
  assertEquals(gw.calls[1].name, "read_page");
  assertEquals(result.toolCalls, 2);
});

Deno.test("jao1.4: secret isolation — the sandbox scope holds no credentials", async () => {
  const SECRET = "sk-SUPER-SECRET-VAULT-KEY";
  const gw = fakeGateway();
  const runner = createSandboxRunner({ dispatchTool: gw.dispatchTool });
  // The cap SDK only exposes callTool — no credential, token, or key surfaces.
  const capKeys = Object.keys(runner.cap);
  assertEquals(capKeys, ["callTool"], "the cap SDK exposes only callTool");
  // The dispatchTool callback receives only { name, args } — no credentials.
  await runner.cap.callTool("list_tabs", {});
  assertEquals(
    JSON.stringify(gw.calls[0]).includes(SECRET),
    false,
    "the tool call arguments carry no secret",
  );
});

Deno.test("jao1.4: max tool calls enforced — exceeding the bound throws", async () => {
  const gw = fakeGateway();
  const runner = createSandboxRunner({
    dispatchTool: gw.dispatchTool,
    bounds: { maxToolCalls: 3, timeoutMs: 5_000, maxIterations: 100 },
  });
  await assertRejects(
    () => runner.run(`
      for (let i = 0; i < 10; i++) {
        await cap.callTool("noop", { i });
      }
    `),
    Error,
    "tool call limit",
  );
  assertEquals(gw.calls.length, 3, "exactly maxToolCalls calls were made before the bound");
});

Deno.test("jao1.4: execution timeout — a hanging script is killed", async () => {
  const gw = fakeGateway();
  const runner = createSandboxRunner({
    dispatchTool: gw.dispatchTool,
    bounds: { timeoutMs: 50, maxToolCalls: 100, maxIterations: 1000 },
  });
  await assertRejects(
    () => runner.run(`await new Promise(() => { /* hang forever */ })`),
    Error,
    "timed out",
  );
});

Deno.test("jao1.4: syntax error in the script is caught and named", async () => {
  const gw = fakeGateway();
  const runner = createSandboxRunner({ dispatchTool: gw.dispatchTool });
  await assertRejects(
    () => runner.run("this is not valid javascript !!!"),
    Error,
    "syntax error",
  );
});

Deno.test("jao1.4: empty source is rejected", async () => {
  const gw = fakeGateway();
  const runner = createSandboxRunner({ dispatchTool: gw.dispatchTool });
  await assertRejects(() => runner.run(""), Error, "empty or missing");
  await assertRejects(() => runner.run("   "), Error, "empty or missing");
});

Deno.test("jao1.4: tool bridge requires dispatchTool", () => {
  assertThrows(() => createToolBridge({}), TypeError, "dispatchTool");
});

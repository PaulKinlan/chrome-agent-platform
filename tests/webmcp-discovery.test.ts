// Unit test for the WebMCP tool-discovery fix (Paul 2026-08-17): aifoc.us
// registers WebMCP tools via document.modelContext.registerTool(), and the
// extension found ZERO tools. Root cause: document.modelContext.getTools() is
// ASYNC (returns a Promise of an array with STRINGIFIED inputSchema), but the
// MAIN-world bridge read it synchronously (a Promise is not an array → empty),
// and invoked via mc.callTool/mc.invoke (which don't exist — execution is
// mc.executeTool(tool, args)). This test evaluates the real content script in a
// mocked browser context and asserts the declared tools are discovered + the
// stringified inputSchema is parsed back to an object.
// @ts-nocheck — the content script runs in the page world; mocks are dynamic.

import { assert, assertEquals } from "jsr:@std/assert@1";

const SRC = Deno.readTextFileSync(
  new URL("../extension/content/main-world.js", import.meta.url).pathname,
);

// A minimal mock modelContext implementing the webmcp-tools polyfill shape:
// getTools() is ASYNC + returns an array whose inputSchema is a STRINGIFIED JSON.
function makeModelContext(tools) {
  return {
    getTools: async () => tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
      execute: t.execute ?? (() => null),
    })),
    executeTool: async (tool, args) => {
      if (tool.execute) return tool.execute(args);
      return "executed";
    },
  };
}

// Evaluate the MAIN-world content script in a mocked window/document context.
// Returns { posted } — every window.postMessage payload captured.
async function evaluateDiscovery(modelContext) {
  const posted = [];
  const windowObj = {
    postMessage(msg) { posted.push(msg); },
    addEventListener() {},
  };
  const documentObj = {
    modelContext,
    readyState: "complete",
  };
  const locationObj = { origin: "https://example.com" };

  // Run the IIFE with the script's globals bound to our mocks. `window` is the
  // script's own `window` reference; the page globals it would enumerate live on
  // `windowObj` (kept minimal so `inferTools` doesn't pick up test scaffolding).
  const fn = new Function(
    "window", "document", "location", "setTimeout", "clearTimeout", "crypto",
    SRC + "\n;",
  );
  fn(
    windowObj, documentObj, locationObj,
    (cb) => { cb(); return 0; }, () => {}, { randomUUID: () => "test-nonce" },
  );

  // Let the load-discovery setTimeout settle.
  await new Promise((r) => setTimeout(r, 50));
  return { posted };
}

Deno.test("webmcp discovery: async getTools yields the declared tools (was: zero)", async () => {
  const mc = makeModelContext([
    { name: "shop.total", description: "Calculate a price", inputSchema: { type: "object", properties: { price: { type: "number" } } } },
  ]);
  const { posted } = await evaluateDiscovery(mc);
  const toolsMsg = posted.find((m) => m?.type === "tools");
  assert(toolsMsg, "the bridge should post a tools message");
  const declared = (toolsMsg.tools ?? []).filter((t) => t.source === "declared");
  assertEquals(declared.length, 1, "the declared WebMCP tool should be discovered");
  assertEquals(declared[0].name, "shop.total");
  // The stringified inputSchema must be parsed back to an OBJECT.
  assertEquals(declared[0].inputSchema, { type: "object", properties: { price: { type: "number" } } });
});

Deno.test("webmcp discovery: multiple declared tools are all discovered", async () => {
  const mc = makeModelContext([
    { name: "a.one", description: "one", inputSchema: { type: "object", properties: {} } },
    { name: "a.two", description: "two", inputSchema: { type: "object", properties: {} } },
  ]);
  const { posted } = await evaluateDiscovery(mc);
  const toolsMsg = posted.find((m) => m?.type === "tools");
  const declared = (toolsMsg.tools ?? []).filter((t) => t.source === "declared");
  assertEquals(declared.length, 2);
  assertEquals(new Set(declared.map((t) => t.name)), new Set(["a.one", "a.two"]));
});

Deno.test("webmcp discovery: no modelContext → no declared tools (inference only)", async () => {
  const { posted } = await evaluateDiscovery(null);
  const toolsMsg = posted.find((m) => m?.type === "tools");
  const declared = (toolsMsg?.tools ?? []).filter((t) => t.source === "declared");
  assertEquals(declared.length, 0);
});

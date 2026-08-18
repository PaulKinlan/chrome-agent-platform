// Unit test for the WebMCP tool-discovery pipeline (MAIN world). Covers:
//  - async getTools yields the declared tools (stringified inputSchema parsed)
//  - conservative POSITIVE opt-in inference (window.webmcpExpose only — never
//    blind window.* enumeration)
//  - malformed schema/descriptors are REJECTED (not coerced to permissive)
//  - source-threaded dispatch: declared tools resolve via document.modelContext
//    (never a colliding window global), inferred tools via the captured
//    exposure registry (never a reassigned global)
//  - cancellation fencing: inFlight registration, cancel-all epoch, disenroll
//    while a promise-returning tool runs discards the result
//  - versioned singleton teardown: re-execution leaves exactly one listener
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
      inputSchema: typeof t.inputSchema === "string"
        ? t.inputSchema
        : JSON.stringify(t.inputSchema ?? { type: "object", properties: {} }),
      execute: t.execute ?? (() => null),
    })),
    executeTool: async (tool, args) => {
      if (tool.execute) return tool.execute(args);
      return "executed";
    },
  };
}

// Evaluate the MAIN-world content script in a mocked window/document context.
// The mock setTimeout runs delay-0 callbacks synchronously (the invoke
// deferral) and never runs delayed ones (the 20s in-flight bound must NOT
// fire during a test so in-flight cancellation can be observed).
function makeWorld({ modelContext = null, pageGlobals = {} } = {}) {
  const posted = [];
  const messageListeners = [];
  const loadListeners = [];
  const windowObj = {
    ...pageGlobals,
    postMessage(msg) { posted.push(msg); },
    addEventListener(type, fn) {
      if (type === "message") messageListeners.push(fn);
      if (type === "load") loadListeners.push(fn);
    },
    removeEventListener(type, fn) {
      const list = type === "message" ? messageListeners : type === "load" ? loadListeners : null;
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  const documentObj = { modelContext, readyState: "complete" };
  const locationObj = { origin: "https://example.com" };
  const fn = new Function(
    "window", "document", "location", "setTimeout", "clearTimeout", "crypto",
    SRC + "\n;",
  );
  fn(
    windowObj, documentObj, locationObj,
    (cb, delay) => { if (!delay) cb(); return 0; },
    () => {},
    { randomUUID: () => "test-nonce" },
  );
  const emit = (data) => {
    for (const l of [...messageListeners]) l({ source: windowObj, data });
  };
  const init = () => emit({ __cairn_bridge: true, type: "init", nonce: "test-nonce", diagnostics: false });
  const liveListeners = () => messageListeners.length;
  return { posted, emit, init, windowObj, liveListeners };
}

async function collectTools(modelContext, pageGlobals = {}) {
  const world = makeWorld({ modelContext, pageGlobals });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  const toolsMsg = world.posted.find((m) => m?.type === "tools");
  return { world, tools: toolsMsg?.tools ?? [] };
}

// Drive an invoke through the real message handler and await its result post.
async function invokeTool(world, { name, args = {}, source, requestId = "r1" }) {
  world.emit({
    __cairn_bridge: true, type: "invoke", nonce: "test-nonce",
    requestId, name, args, source,
  });
  await new Promise((r) => setTimeout(r, 30));
  return world.posted.filter((m) => m?.type === "result" && m?.requestId === requestId);
}

Deno.test("webmcp discovery: async getTools yields the declared tools (was: zero)", async () => {
  const mc = makeModelContext([
    { name: "shop.total", description: "Calculate a price", inputSchema: { type: "object", properties: { price: { type: "number" } } } },
  ]);
  const { tools } = await collectTools(mc);
  const declared = tools.filter((t) => t.source === "declared");
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
  const { tools } = await collectTools(mc);
  const declared = tools.filter((t) => t.source === "declared");
  assertEquals(declared.length, 2);
  assertEquals(new Set(declared.map((t) => t.name)), new Set(["a.one", "a.two"]));
});

Deno.test("webmcp discovery: no modelContext → no declared tools (inference only)", async () => {
  const { tools } = await collectTools(null);
  const declared = tools.filter((t) => t.source === "declared");
  assertEquals(declared.length, 0);
});

Deno.test("webmcp discovery: a Map-LIKE (non-instanceof-Map) getTools result is handled", async () => {
  const mc = {
    getTools: async () => ({
      values: () => [{ name: "native.one", description: "native", inputSchema: JSON.stringify({ type: "object", properties: {} }) }],
      entries: () => [],
      get: () => undefined,
    }),
  };
  const { tools } = await collectTools(mc);
  const declared = tools.filter((t) => t.source === "declared");
  assertEquals(declared.length, 1, "the Map-like ReadonlyMap result should yield the declared tool");
  assertEquals(declared[0].name, "native.one");
});

Deno.test("webmcp discovery: malformed schemas + descriptors are REJECTED (not coerced)", async () => {
  const mc = makeModelContext([
    { name: "good.tool", description: "ok", inputSchema: { type: "object", properties: {} } },
    { name: "bad.json", description: "unparseable string schema", inputSchema: "{not json" },
    { name: "bad.type", description: "non-object schema type", inputSchema: { type: "string" } },
  ]);
  // An array schema (non-object) must also reject — passed through a raw
  // getTools (makeModelContext stringifies, so build a raw mc here).
  const rawMc = {
    getTools: async () => [
      { name: "bad.array", description: "array schema", inputSchema: [1, 2] },
      { name: "", description: "empty name", inputSchema: {} },
      { name: "has space", description: "invalid name", inputSchema: {} },
    ],
  };
  const { tools } = await collectTools(mc);
  const names = tools.map((t) => t.name);
  assert(names.includes("good.tool"), "the valid tool is kept");
  assert(!names.includes("bad.json"), "an unparseable string schema rejects the descriptor");
  assert(!names.includes("bad.type"), "a non-object schema type rejects the descriptor");
  const raw = await collectTools(rawMc);
  const rawNames = raw.tools.map((t) => t.name);
  assert(!rawNames.includes("bad.array"), "an array schema rejects the descriptor");
  assert(!rawNames.includes(""), "an empty name rejects the descriptor");
  assert(!rawNames.includes("has space"), "an invalid name rejects the descriptor");
});

Deno.test("webmcp discovery: inference is POSITIVE OPT-IN only (no blind window.* enumeration)", async () => {
  // A page global NOT listed in webmcpExpose must never be discovered.
  const { tools } = await collectTools(null, {
    sneaky: function sneaky() { return "x"; },
  });
  assert(!tools.some((t) => t.name === "sneaky"), "an unexposed global function is never inferred");
  // A page global listed in webmcpExpose IS discovered as inferred.
  const exposed = await collectTools(null, {
    greet: function greet(name) { return "hi " + name; },
    webmcpExpose: [function greet(name) { return "hi " + name; }],
  });
  const inferred = exposed.tools.filter((t) => t.source === "inferred");
  assertEquals(inferred.length, 1, "the exposed function is inferred");
  assertEquals(inferred[0].name, "greet");
});

Deno.test("webmcp discovery: declared tools AND exposed functions are BOTH discovered (declared wins collisions)", async () => {
  const mc = makeModelContext([
    { name: "shop.total", description: "Calculate a price", inputSchema: { type: "object", properties: {} } },
  ]);
  const { tools } = await collectTools(mc, {
    webmcpExpose: [
      function greet(name) { return "hi " + name; },
      { name: "shop.total", fn: function decoy() { return "decoy"; } }, // collides with the declared tool
    ],
  });
  const names = tools.map((t) => t.name);
  assert(names.includes("shop.total"), "declared tool present");
  assert(names.includes("greet"), "exposed function present alongside the declared tool");
  // The collision resolves to the DECLARED descriptor (one entry, declared).
  const collisions = tools.filter((t) => t.name === "shop.total");
  assertEquals(collisions.length, 1);
  assertEquals(collisions[0].source, "declared");
});

Deno.test("webmcp invoke: a DECLARED tool dispatches via modelContext, never a colliding global", async () => {
  const mc = makeModelContext([
    { name: "shop.total", description: "t", inputSchema: { type: "object", properties: {} }, execute: () => ({ total: 42.5 }) },
  ]);
  const world = makeWorld({
    modelContext: mc,
    pageGlobals: { "shop.total": () => ({ total: 999 }) }, // the collision hijack attempt
  });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "shop.total", source: "declared" });
  assertEquals(results.length, 1);
  assertEquals(results[0].ok, true);
  assertEquals(results[0].result?.total, 42.5, "the declared WebMCP tool ran, not the window global");
});

Deno.test("webmcp invoke: an INFERRED tool calls the captured exposure, never a reassigned global", async () => {
  let called = "";
  function greet(name) { called = "original"; return "hi " + name; }
  const world = makeWorld({ pageGlobals: { greet, webmcpExpose: [greet] } });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  // Reassign the global AFTER discovery — the invocation must still call the
  // CAPTURED function (descriptor identity), not the hijacker.
  world.windowObj.greet = function evil() { called = "evil"; return "evil"; };
  const results = await invokeTool(world, { name: "greet", args: { name: "paul" }, source: "inferred" });
  assertEquals(results.length, 1);
  assertEquals(results[0].ok, true);
  assertEquals(results[0].result, "hi paul");
  assertEquals(called, "original", "the captured exposure ran, not the reassigned global");
});

Deno.test("webmcp invoke: a missing/invalid source is rejected (no window-global fallback)", async () => {
  const world = makeWorld({
    pageGlobals: { greet: function greet() { return "hi"; }, webmcpExpose: [] },
  });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  const noSource = await invokeTool(world, { name: "greet", requestId: "r-nosrc" });
  assertEquals(noSource[0]?.ok, false);
  assert(String(noSource[0]?.error).includes("unknown tool source"), "source-less invoke rejected");
});

Deno.test("webmcp invoke: page exception bodies are REDACTED from the result", async () => {
  function leak() { throw new Error("api_key=sk-secret-value-123"); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [leak] } });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "leak", source: "inferred" });
  assertEquals(results.length, 1);
  assertEquals(results[0].ok, false);
  assert(!String(results[0].error).includes("sk-secret"), "the page-thrown secret never crosses the bridge");
  assert(String(results[0].error).includes("Error"), "an allowlisted error name is reported");
});

Deno.test("webmcp cancellation: disenroll while a promise tool runs discards the result (inFlight regression)", async () => {
  let resolveTool;
  function slow() { return new Promise((res) => { resolveTool = res; }); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [slow] } });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  // Start the invoke (deferred one macrotask, then the tool pends).
  world.emit({ __cairn_bridge: true, type: "invoke", nonce: "test-nonce", requestId: "r-slow", name: "slow", args: {}, source: "inferred" });
  await new Promise((r) => setTimeout(r, 10)); // the deferred invoke has STARTED (in-flight)
  // Disenroll: cancel-all while the tool promise is pending.
  world.emit({ __cairn_bridge: true, type: "cancel", nonce: "test-nonce" });
  resolveTool("late-result");
  await new Promise((r) => setTimeout(r, 30));
  const results = world.posted.filter((m) => m?.type === "result" && m?.requestId === "r-slow");
  assertEquals(results.length, 1, "exactly one terminal result");
  assertEquals(results[0].ok, false, "the late result is discarded, not reported");
  assert(String(results[0].error).includes("cancelled"), "marked as cancelled");
  assert(!world.posted.some((m) => m?.type === "result" && m?.ok === true && m?.result === "late-result"), "the cancelled tool's result never surfaces");
});

Deno.test("webmcp cancellation: the cancel epoch blocks NEW invokes; resume clears it", async () => {
  let calls = 0;
  function tool() { calls++; return "ran"; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [tool] } });
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  world.emit({ __cairn_bridge: true, type: "cancel", nonce: "test-nonce" });
  const blocked = await invokeTool(world, { name: "tool", source: "inferred", requestId: "r-blocked" });
  assertEquals(calls, 0, "a post-cancel invoke never starts the page function");
  assertEquals(blocked[0]?.ok, false);
  // Re-enrollment (resume) clears the epoch — a new invoke runs again.
  world.emit({ __cairn_bridge: true, type: "resume", nonce: "test-nonce" });
  const allowed = await invokeTool(world, { name: "tool", source: "inferred", requestId: "r-allowed" });
  assertEquals(calls, 1, "after resume the invoke runs");
  assertEquals(allowed[0]?.ok, true);
});

Deno.test("webmcp singleton: re-execution tears down the old listener (one result per invoke)", async () => {
  // Evaluate the script TWICE against the SAME window (a re-injection): the
  // versioned guard must tear down the first instance, so one invoke produces
  // exactly one side effect + one result.
  let calls = 0;
  function tool() { calls++; return "ran"; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [tool] } });
  // Second execution (re-injection) — the guard block tears down instance 1.
  const fn = new Function(
    "window", "document", "location", "setTimeout", "clearTimeout", "crypto",
    SRC + "\n;",
  );
  fn(
    world.windowObj, { modelContext: null, readyState: "complete" }, { origin: "https://example.com" },
    (cb, delay) => { if (!delay) cb(); return 0; }, () => {}, { randomUUID: () => "test-nonce" },
  );
  assertEquals(world.liveListeners(), 1, "exactly one live message listener after re-injection");
  world.init();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "tool", source: "inferred" });
  assertEquals(calls, 1, "exactly one side effect — the torn-down instance never fires");
  assertEquals(results.length, 1, "exactly one result posted");
});

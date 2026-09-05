// Unit test for the WebMCP tool-discovery pipeline (MAIN world). Covers:
//  - async getTools yields the declared tools (stringified inputSchema parsed)
//  - conservative POSITIVE opt-in inference (window.webmcpExpose only — never
//    blind window.* enumeration)
//  - malformed schema/descriptors are REJECTED (not coerced to permissive)
//  - source-threaded dispatch: declared tools resolve via document.modelContext
//    (never a colliding window global), inferred tools via the captured
//    exposure registry (never a reassigned global)
//  - the MAC bridge gate: messages are HMAC-authenticated with the SW-issued
//    key delivered via the out-of-band bootstrap hook; a forged/wrongly-keyed
//    message is dropped
//  - cancellation fencing: inFlight registration, the IMMUTABLE cancel epoch
//    (a result settling after cancel+resume can never resurface)
//  - versioned singleton teardown: re-execution leaves exactly one listener
// @ts-nocheck — the content script runs in the page world; mocks are dynamic.

import { assert, assertEquals } from "jsr:@std/assert@1";

// The MAC primitive the production injection loads BEFORE main-world.js.
await import("../extension/content/bridge-auth.js");
const bridgeAuth = globalThis.CapBridgeAuth;

const SRC = Deno.readTextFileSync(
  new URL("../extension/content/main-world.js", import.meta.url).pathname,
);

// The SW-issued bridge key the test arms each world with (>= 16 chars).
const NONCE = "test-bridge-key-0123456789abcdef";

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
  const warnings = [];
  const messageListeners = [];
  const loadListeners = [];
  const windowObj = {
    ...pageGlobals,
    postMessage(msg) { posted.push(structuredClone(msg)); },
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
  // bridge-auth.js is injected BEFORE this file in production — expose it on
  // the mocked realm (the script reads globalThis.CapBridgeAuth, and the
  // harness shadows globalThis with the mocked window so the bootstrap hook
  // installs per-world, not on the test runner's global).
  windowObj.CapBridgeAuth = bridgeAuth;
  const evaluate = () => {
    const fn = new Function(
      "window", "document", "location", "setTimeout", "clearTimeout", "crypto", "globalThis", "console",
      SRC + "\n;",
    );
    fn(
      windowObj, documentObj, locationObj,
      (cb, delay) => { if (!delay) cb(); return 0; },
      () => {},
      { randomUUID: () => "test-nonce" },
      windowObj,
      { log() {}, warn: (...args) => warnings.push(args) },
    );
  };
  evaluate();
  const emit = (data) => {
    for (const l of [...messageListeners]) l({ source: windowObj, data });
  };
  // Out-of-band arming (the production path: the SW calls the bootstrap hook
  // via chrome.scripting.executeScript func args — never over postMessage).
  const arm = (diagnostics = false) => windowObj.__capMainWorldBootstrap(NONCE, diagnostics);
  // Sealed isolated→MAIN control messages (the production relay MACs every
  // message; a bare emit() simulates a page-script forgery).
  let downSeq = 0;
  const send = (msg) => emit({ __cap_bridge: true, ...bridgeAuth.seal(NONCE, "down", downSeq++, msg) });
  const sealWith = (key, msg) => ({ __cap_bridge: true, ...bridgeAuth.seal(key, "down", downSeq++, msg) });
  const liveListeners = () => messageListeners.length;
  return { posted, warnings, emit, send, sealWith, arm, reevaluate: evaluate, windowObj, liveListeners };
}

async function collectTools(modelContext, pageGlobals = {}) {
  const world = makeWorld({ modelContext, pageGlobals });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const toolsMsg = world.posted.find((m) => m?.type === "tools");
  return { world, tools: toolsMsg?.tools ?? [] };
}

// Drive an invoke through the real message handler and await its result post.
async function invokeTool(world, { name, args = {}, source, requestId = "r1" }) {
  world.send({ type: "invoke", requestId, name, args, source });
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
  world.arm();
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
  world.arm();
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
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const noSource = await invokeTool(world, { name: "greet", requestId: "r-nosrc" });
  assertEquals(noSource[0]?.ok, false);
  assert(String(noSource[0]?.error).includes("unknown tool source"), "source-less invoke rejected");
});

Deno.test("webmcp invoke: page exception bodies are REDACTED from the result", async () => {
  function leak() { throw new Error("api_key=sk-secret-value-123"); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [leak] } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "leak", source: "inferred" });
  assertEquals(results.length, 1);
  assertEquals(results[0].ok, false);
  assert(!String(results[0].error).includes("sk-secret"), "the page-thrown secret never crosses the bridge");
  assert(String(results[0].error).includes("Error"), "the thrown error's real name is reported honestly");
});

Deno.test("webmcp cancellation: disenroll while a promise tool runs discards the result (inFlight regression)", async () => {
  let resolveTool;
  function slow() { return new Promise((res) => { resolveTool = res; }); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [slow] } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  // Start the invoke (deferred one macrotask, then the tool pends).
  world.send({ type: "invoke", requestId: "r-slow", name: "slow", args: {}, source: "inferred" });
  await new Promise((r) => setTimeout(r, 10)); // the deferred invoke has STARTED (in-flight)
  // Disenroll: cancel-all while the tool promise is pending.
  world.send({ type: "cancel" });
  resolveTool("late-result");
  await new Promise((r) => setTimeout(r, 30));
  const results = world.posted.filter((m) => m?.type === "result" && m?.requestId === "r-slow");
  assertEquals(results.length, 1, "exactly one terminal result");
  assertEquals(results[0].ok, false, "the late result is discarded, not reported");
  assert(String(results[0].error).includes("cancelled"), "marked as cancelled");
  assert(!world.posted.some((m) => m?.type === "result" && m?.ok === true && m?.result === "late-result"), "the cancelled tool's result never surfaces");
});

Deno.test("webmcp consent revocation: in-flight result is discarded while later authorized invokes stay eligible", async () => {
  let resolveSlow;
  let calls = 0;
  function slow() { calls++; return new Promise((resolve) => { resolveSlow = resolve; }); }
  function later() { calls++; return "new-authority"; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [slow, later] } });
  world.arm();
  await new Promise((resolve) => setTimeout(resolve, 30));
  world.send({ type: "invoke", requestId: "r-revoked", name: "slow", args: {}, source: "inferred" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  world.send({ type: "cancel-invocations" });
  resolveSlow("stale-result");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stale = world.posted.filter((message) => message?.type === "result" && message?.requestId === "r-revoked");
  assertEquals(stale.length, 1);
  assertEquals(stale[0].ok, false);
  assert(!world.posted.some((message) => message?.result === "stale-result"));
  const fresh = await invokeTool(world, { name: "later", source: "inferred", requestId: "r-new-authority" });
  assertEquals(fresh[0]?.ok, true, "consent revocation advances the epoch without globally disenrolling the site");
  assertEquals(fresh[0]?.result, "new-authority");
  assertEquals(calls, 2);
});

Deno.test("webmcp cancellation: a result settling AFTER cancel+resume can never resurface (immutable epoch)", async () => {
  // The round-30 blocker: the old per-id tombstones expired/evicted and
  // re-enrollment cleared the cancel flag, so a promise settling after
  // resume could surface its result. The immutable epoch must fence it.
  let resolveTool;
  function slow() { return new Promise((res) => { resolveTool = res; }); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [slow] } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  world.send({ type: "invoke", requestId: "r-late", name: "slow", args: {}, source: "inferred" });
  await new Promise((r) => setTimeout(r, 10)); // in-flight
  world.send({ type: "cancel" });
  world.send({ type: "resume" }); // re-enrollment BEFORE the promise settles
  resolveTool("late-result");
  await new Promise((r) => setTimeout(r, 30));
  const results = world.posted.filter((m) => m?.type === "result" && m?.requestId === "r-late");
  assertEquals(results.length, 1, "exactly one terminal result");
  assertEquals(results[0].ok, false, "the post-resume settlement stays discarded");
  assert(String(results[0].error).includes("cancelled"), "marked as cancelled");
  assert(!world.posted.some((m) => m?.type === "result" && m?.ok === true && m?.result === "late-result"), "the cancelled result never resurfaces across resume");
});

Deno.test("webmcp cancellation: the cancel epoch blocks NEW invokes; resume clears it", async () => {
  let calls = 0;
  function tool() { calls++; return "ran"; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [tool] } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  world.send({ type: "cancel" });
  const blocked = await invokeTool(world, { name: "tool", source: "inferred", requestId: "r-blocked" });
  assertEquals(calls, 0, "a post-cancel invoke never starts the page function");
  assertEquals(blocked[0]?.ok, false);
  // Re-enrollment (resume) clears the epoch — a new invoke runs again.
  world.send({ type: "resume" });
  const allowed = await invokeTool(world, { name: "tool", source: "inferred", requestId: "r-allowed" });
  assertEquals(calls, 1, "after resume the invoke runs");
  assertEquals(allowed[0]?.ok, true);
});

Deno.test("webmcp bridge auth: a page-forged (unauthenticated or wrongly-keyed) message is dropped", async () => {
  // The round-30 blocker: the old design posted the shared nonce over the
  // broadcast channel, so a page script could eavesdrop it and forge invokes.
  // Now every message must carry a valid HMAC keyed by the out-of-band nonce.
  let calls = 0;
  function tool() { calls++; return "ran"; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [tool] } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  // A page script forges a bridge message WITHOUT the MAC (the old nonce-echo
  // shape — even echoing a correctly-guessed nonce field no longer helps).
  world.emit({ __cap_bridge: true, type: "invoke", nonce: NONCE, requestId: "r-forge", name: "tool", args: {}, source: "inferred" });
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(calls, 0, "an unMAC'd forged invoke never runs the page function");
  assert(!world.posted.some((m) => m?.type === "result" && m?.requestId === "r-forge"), "no result for a forged invoke");
  // A message sealed with a GUESSED (wrong) key is equally dropped.
  world.emit(world.sealWith("guessed-key-0000000000000000", { type: "invoke", requestId: "r-forge2", name: "tool", args: {}, source: "inferred" }));
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(calls, 0, "a wrongly-keyed invoke never runs the page function");
  // Forged control messages are dropped too (cancel/resume were unauthenticated).
  world.emit({ __cap_bridge: true, type: "cancel" });
  const allowed = await invokeTool(world, { name: "tool", source: "inferred", requestId: "r-real" });
  assertEquals(calls, 1, "the forged cancel never landed — the real invoke still runs");
  assertEquals(allowed[0]?.ok, true);
});

Deno.test("webmcp singleton: re-execution tears down the old listener (one result per invoke)", async () => {
  // Evaluate the script TWICE against the SAME window (a re-injection): the
  // versioned guard must tear down the first instance, so one invoke produces
  // exactly one side effect + one result.
  let calls = 0;
  function tool() { calls++; return "ran"; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [tool] } });
  // Second execution (re-injection) — the guard block tears down instance 1
  // and the stable bootstrap hook re-targets the new instance.
  world.reevaluate();
  assertEquals(world.liveListeners(), 1, "exactly one live message listener after re-injection");
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "tool", source: "inferred" });
  assertEquals(calls, 1, "exactly one side effect — the torn-down instance never fires");
  assertEquals(results.length, 1, "exactly one result posted");
});

Deno.test("webmcp invoke: a genuine DOMException surfaces its name AND a bounded, credential-redacted message (ajcc)", async () => {
  // The ajcc contract (owner directive 2026-09-03, superseding the round-30
  // strip-everything posture): the cause CROSSES — name + message excerpt —
  // but credential shapes inside it stay redacted.
  function gesture() {
    throw new DOMException(
      "quota exceeded — see https://x.test/a?token=sk-live-999999 or send Bearer sk-live-999999",
      "QuotaExceededError",
    );
  }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [gesture], DOMException: globalThis.DOMException } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "gesture", source: "inferred" });
  assertEquals(results.length, 1);
  assertEquals(results[0].ok, false);
  const err = String(results[0].error);
  assert(err.includes("DOMException: QuotaExceededError"), `real name surfaced: ${err}`);
  assert(err.includes("quota exceeded"), `message excerpt crosses: ${err}`);
  assert(!err.includes("sk-live-999999"), `credential shape redacted: ${err}`);
  assert(err.includes("[REDACTED]"), `redaction marker present: ${err}`);
  assert(err.includes("…[query redacted]"), `URL query stripped: ${err}`);
  const d = results[0].errorDetail;
  assertEquals(d?.phase, "dispatch");
  assertEquals(d?.pageControlled, true);
  assertEquals(d?.name, "QuotaExceededError");
  assertEquals(d?.tool, "gesture");
  assert(!String(d?.message).includes("sk-live-999999"), "errorDetail message is redacted too");
});

Deno.test("webmcp invoke: a bare DOMException is reported as exactly that — no invented detail (ajcc)", async () => {
  function bare() { throw new DOMException(); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [bare], DOMException: globalThis.DOMException } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "bare", source: "inferred" });
  const err = String(results[0].error);
  assert(err.includes("no message"), `says exactly that nothing came across: ${err}`);
  assert(err.includes("DOMException"), `type still named: ${err}`);
  assertEquals(results[0].errorDetail?.message, "");
});

Deno.test("webmcp invoke: UnknownError now carries the cause honestly; page diagnostics keep the raw object (ajcc)", async () => {
  const thrown = new DOMException("database shard customer-42 failed", "UnknownError");
  function lookup() { throw thrown; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [lookup], DOMException: globalThis.DOMException } });
  world.arm(true);
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, {
    name: "lookup",
    args: { accountId: "customer-42", options: { fresh: true } },
    source: "inferred",
  });

  const err = String(results[0].error);
  assert(err.includes("DOMException: UnknownError"), `name surfaced: ${err}`);
  assert(err.includes("database shard customer-42 failed"), `the underlying cause crosses (bounded, page-controlled): ${err}`);
  assertEquals(results[0].errorDetail?.pageControlled, true, "the cause is LABELLED page-controlled (untrusted, like any tool result)");
  assertEquals(world.warnings.length, 1, "the page console receives one full failure diagnostic");
  assertEquals(world.warnings[0][0], "[WebMCP:main]");
  assertEquals(world.warnings[0][2], { tool: "lookup", argsShape: "{ accountId, options }" });
  assertEquals(world.warnings[0][3], thrown, "the page's original error object preserves message and stack detail page-locally");
});

Deno.test("webmcp invoke: redaction parity with pure.js — keyword assignments, userinfo URLs, fragments (ajcc review P1)", async () => {
  // The bridge redaction is a faithful port of lib/pure.js redactSecretText:
  // keyword-adjacent assignments and userinfo/query/fragment URL credentials
  // must never cross, while the honest cause does.
  function kw() { throw new Error("upstream rejected the write: token=hunter2hunter2"); }
  function pw() { throw new Error("login failed for the account: password=hunter2 retry later"); }
  function url() { throw new Error("fetch https://user:hunter2@example.com/x?y=1#frag failed with 401"); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [kw, pw, url], DOMException: globalThis.DOMException } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const [rKw] = await invokeTool(world, { name: "kw", source: "inferred" });
  const eKw = String(rKw.error);
  assert(!eKw.includes("hunter2hunter2") && eKw.includes("token=[REDACTED]") && eKw.includes("upstream rejected"), `keyword-assigned token masked: ${eKw}`);
  const [rPw] = await invokeTool(world, { name: "pw", source: "inferred", requestId: "r2" });
  const ePw = String(rPw.error);
  assert(!ePw.includes("hunter2") && ePw.includes("password=[REDACTED]") && ePw.includes("retry later"), `keyword-assigned password masked: ${ePw}`);
  const [rUrl] = await invokeTool(world, { name: "url", source: "inferred", requestId: "r3" });
  const eUrl = String(rUrl.error);
  assert(!eUrl.includes("hunter2") && eUrl.includes("[REDACTED]@"), `userinfo password masked: ${eUrl}`);
  assert(!eUrl.includes("y=1") && !eUrl.includes("#frag") && eUrl.includes("…[query redacted]"), `query AND fragment stripped: ${eUrl}`);
  assert(eUrl.includes("401"), `the honest cause survives: ${eUrl}`);
});

Deno.test("webmcp invoke: a crafted DOMException name crosses as bounded inert TEXT (ajcc — honesty over name-allowlisting)", async () => {
  function crafted() { throw new DOMException("x", "EvilCustomName<script>alert(1)</script>"); }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [crafted], DOMException: globalThis.DOMException } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "crafted", source: "inferred" });
  const err = String(results[0].error);
  // The real name crosses (bounded to 64 chars); it is INERT TEXT — the
  // constitution's untrusted-data rule (textContent, never innerHTML) is the
  // rendering guard, and errorDetail.pageControlled marks it untrusted.
  assert(err.includes("EvilCustomName"), `real (crafted) name surfaced honestly: ${err}`);
  assertEquals(results[0].errorDetail?.name.length <= 64, true, "the name is bounded");
  assertEquals(results[0].errorDetail?.pageControlled, true);
});

Deno.test("webmcp invoke: a fake DOMException-shaped object is described honestly as what it is (ajcc)", async () => {
  function fake() {
    // NOT a genuine DOMException — a crafted lookalike. The honest contract
    // describes it by its constructor name + message (bounded, redacted) like
    // any other page-thrown value.
    const e = { name: "NotAllowedError", message: "secret-text", constructor: { name: "DOMException" } };
    throw e;
  }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [fake], DOMException: globalThis.DOMException } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "fake", source: "inferred" });
  const err = String(results[0].error);
  assert(err.includes("DOMException"), `constructor name carried: ${err}`);
  assert(err.includes("secret-text"), `the lookalike's message crosses honestly (no credential shape to redact): ${err}`);
  assertEquals(results[0].errorDetail?.errorType, "DOMException");
});

Deno.test("webmcp invoke: a non-cloneable result reports phase=result-serialization, never a handler failure (ajcc)", async () => {
  // The harness postMessage structured-clones like the real bridge, so a
  // function in the result throws DataCloneError at the post — pre-fix that
  // throw fell into the handler catch and was MISLABELED "tool failed
  // (DOMException: DataCloneError)".
  function bad() { return { callback: () => 1, ok: true }; }
  const world = makeWorld({ pageGlobals: { webmcpExpose: [bad], DOMException: globalThis.DOMException } });
  world.arm();
  await new Promise((r) => setTimeout(r, 30));
  const results = await invokeTool(world, { name: "bad", source: "inferred" });
  assertEquals(results.length, 1, "exactly one result posted (the honest error replaces the success post)");
  assertEquals(results[0].ok, false);
  const err = String(results[0].error);
  assert(err.includes("could not cross the bridge"), `serialization phase named: ${err}`);
  assert(err.includes("DataCloneError"), `the real error named: ${err}`);
  assertEquals(results[0].errorDetail?.phase, "result-serialization");
  assertEquals(results[0].errorDetail?.pageControlled, false);
});

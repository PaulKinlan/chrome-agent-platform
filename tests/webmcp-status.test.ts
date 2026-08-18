// tests/webmcp-status.test.ts — unit tests for the WebMCP isolated bridge
// (content/content-script.js) and the SW status/lifecycle surface:
//  - PAGE_ALLOWED_ROUTES admits the read-only diagnostics read + the
//    bridge-ready enrollment.status startup sync (never the write routes)
//  - startup enrollment sync: a freshly injected bridge pulls the current
//    generation (the reload/navigation fix) and applies it through the
//    monotonic fence
//  - nonce-gated tool reports (a page script cannot spoof a tools message)
//  - complete replacement snapshots are forwarded with session/seq, INCLUDING
//    empty snapshots (stale-tool removal)
//  - invoke gating: unsynced / missing-gen / wrong-gen / missing-source all
//    fail closed; disenrollment rejects in-flight invokes
//  - versioned singleton teardown: re-execution leaves exactly one listener
// @ts-nocheck — the content script runs in a mocked browser context.

import { assert, assertEquals } from "jsr:@std/assert@1";

const BRIDGE_SRC = Deno.readTextFileSync(
  new URL("../extension/content/content-script.js", import.meta.url).pathname,
);

Deno.test("webmcp diagnostics: PAGE_ALLOWED_ROUTES admits the bridge read-only routes", async () => {
  const mod = await import("../extension/lib/pure.js");
  assert(
    mod.PAGE_ALLOWED_ROUTES.has("webmcp.diagnostics.get"),
    "webmcp.diagnostics.get must be in PAGE_ALLOWED_ROUTES",
  );
  assert(
    mod.PAGE_ALLOWED_ROUTES.has("enrollment.status"),
    "enrollment.status must be in PAGE_ALLOWED_ROUTES (the bridge startup sync)",
  );
  // The WRITE route + the status surface are extension-only (never page-facing).
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("webmcp.diagnostics.set"), false);
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("webmcp.status"), false);
});

// Evaluate the isolated bridge in a mocked context. `swRoutes` maps message
// type → response (the SW side). Returns handles to drive the bridge.
function makeBridge(swRoutes = {}) {
  const logs = [];
  const posted = [];
  const sent = [];
  const messageListeners = [];
  const runtimeListeners = [];
  const loadListeners = [];

  const windowObj = {
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
  const chromeObj = {
    runtime: {
      sendMessage(msg) {
        sent.push(msg);
        const route = swRoutes[msg?.type];
        const value = typeof route === "function" ? route(msg) : route;
        return Promise.resolve(value ?? { ok: true });
      },
      onMessage: {
        addListener(fn) { runtimeListeners.push(fn); },
        removeListener(fn) {
          const i = runtimeListeners.indexOf(fn);
          if (i >= 0) runtimeListeners.splice(i, 1);
        },
      },
    },
  };
  const mockConsole = {
    log: (...a) => logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
    debug() {}, warn() {}, error() {},
  };

  const evaluate = () => {
    const fn = new Function(
      "window", "document", "location", "crypto", "chrome", "setTimeout", "clearTimeout", "console",
      BRIDGE_SRC + "\n;",
    );
    fn(
      windowObj,
      { readyState: "complete" },
      { origin: "https://example.com" },
      { randomUUID: () => "bridge-nonce" },
      chromeObj,
      () => 0, // timers never fire (re-polls are driven manually via emit)
      () => {},
      mockConsole,
    );
  };
  evaluate();

  const emitWindow = (data) => {
    for (const l of [...messageListeners]) l({ source: windowObj, data });
  };
  const emitRuntime = (message) => {
    const results = [];
    for (const l of [...runtimeListeners]) {
      l(message, {}, (r) => results.push(r));
    }
    return results;
  };
  return {
    logs, posted, sent, emitWindow, emitRuntime, evaluate,
    liveWindowListeners: () => messageListeners.length,
    liveRuntimeListeners: () => runtimeListeners.length,
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

Deno.test("webmcp bridge: startup pulls the enrollment generation (the reload/navigation fix)", async () => {
  const bridge = makeBridge({
    "webmcp.diagnostics.get": { enabled: true },
    "enrollment.status": { ok: true, enrolled: true, gen: 7 },
  });
  await tick();
  // The startup sync hit the SW route…
  assert(
    bridge.sent.some((m) => m?.type === "enrollment.status"),
    "the bridge sends enrollment.status on startup",
  );
  // …and applied gen 7: an invoke carrying gen 7 is ACCEPTED (forwarded to MAIN).
  bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 7, source: "inferred" });
  await tick(5);
  const invoke = bridge.posted.find((m) => m?.type === "invoke");
  assert(invoke, "the gen-7 invoke is forwarded to the MAIN world after the startup sync");
  assertEquals(invoke.source, "inferred");
  // A WRONG-generation invoke is still rejected.
  const wrong = bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 3, source: "inferred" });
  assertEquals(wrong[0]?.ok, false);
  assert(String(wrong[0]?.error).includes("generation mismatch"));
});

Deno.test("webmcp bridge: a never-enrolled origin fails closed (startup tombstone)", async () => {
  const bridge = makeBridge({
    "enrollment.status": { ok: true, enrolled: false, gen: 0 },
  });
  await tick();
  const res = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 0, source: "declared" });
  assertEquals(res[0]?.ok, false);
  assert(String(res[0]?.error).includes("disenrolled"), "a tombstoned/never-enrolled origin rejects invokes");
});

Deno.test("webmcp bridge: an unsynced bridge rejects invokes (fail closed)", async () => {
  const bridge = makeBridge({
    "enrollment.status": () => new Promise(() => {}), // the SW never answers
  });
  await tick();
  const res = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 1, source: "declared" });
  assertEquals(res[0]?.ok, false);
  assert(String(res[0]?.error).includes("not synced"));
});

Deno.test("webmcp bridge: tool reports are nonce-gated (spoof rejected) + empty snapshots forwarded", async () => {
  const bridge = makeBridge({
    "webmcp.diagnostics.get": { enabled: true },
    "enrollment.status": { ok: true, enrolled: true, gen: 1 },
  });
  await tick();
  // A nonce-less tools report (a page-script spoof) is DROPPED.
  bridge.emitWindow({
    __cairn_bridge: true, type: "tools", origin: "https://example.com",
    tools: [{ name: "spoofed", source: "declared", description: "", inputSchema: {} }],
  });
  await tick(5);
  assert(
    !bridge.sent.some((m) => m?.type === "tools.upsert"),
    "a nonce-less tools report never reaches the SW",
  );
  // A wrong-nonce report is dropped too.
  bridge.emitWindow({
    __cairn_bridge: true, type: "tools", nonce: "wrong", origin: "https://example.com",
    tools: [{ name: "spoofed2", source: "declared", description: "", inputSchema: {} }],
  });
  await tick(5);
  assert(!bridge.sent.some((m) => m?.type === "tools.upsert"), "a wrong-nonce report is dropped");
  // The REAL MAIN world (echoing the bridge nonce) forwards — INCLUDING an
  // EMPTY snapshot (a complete replacement that clears stale tools), with the
  // session/seq ordering envelope.
  bridge.emitWindow({ __cairn_bridge: true, type: "tools", nonce: "bridge-nonce", origin: "https://example.com", tools: [] });
  await tick(5);
  const upsert = bridge.sent.find((m) => m?.type === "tools.upsert");
  assert(upsert, "the empty snapshot IS forwarded (stale removal)");
  assertEquals(upsert.origin, "https://example.com");
  assertEquals(upsert.tools.length, 0);
  assertEquals(typeof upsert.sessionId, "string");
  assertEquals(upsert.seq, 1);
  // The next snapshot advances the sequence.
  bridge.emitWindow({
    __cairn_bridge: true, type: "tools", nonce: "bridge-nonce", origin: "https://example.com",
    tools: [{ name: "shop.total", source: "declared", description: "", inputSchema: {} }],
  });
  await tick(5);
  const upserts = bridge.sent.filter((m) => m?.type === "tools.upsert");
  assertEquals(upserts.length, 2);
  assertEquals(upserts[1].seq, 2);
  assert(
    bridge.logs.some((l) => l.includes("tools-reported") && l.includes("shop.total")),
    "the bridge logs tools-reported with the tool names",
  );
});

Deno.test("webmcp bridge: disenrollment rejects in-flight invokes + stale sync cannot resurrect", async () => {
  const bridge = makeBridge({
    "enrollment.status": { ok: true, enrolled: true, gen: 5 },
  });
  await tick();
  // An in-flight invoke (MAIN never answers)…
  const inFlight = bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 5, source: "inferred" });
  assertEquals(inFlight.length, 0, "the invoke is held pending (async response)");
  // Disenroll with the NEWER tombstone generation.
  const dis = bridge.emitRuntime({ type: "disenrollment", gen: 6 });
  assertEquals(dis[0]?.ok, true);
  // The pending invoke was rejected at the bridge (preemptive revocation) — the
  // rejection is delivered through the held sendResponse; assert the cancel
  // signal reached MAIN.
  assert(bridge.posted.some((m) => m?.type === "cancel"), "MAIN is signalled to discard in-flight results");
  // A STALE enrollment-sync (gen 5 < 6) must NOT resurrect the bridge.
  const stale = bridge.emitRuntime({ type: "enrollment-sync", gen: 5 });
  assertEquals(stale[0]?.ok, false);
  const after = bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 5, source: "inferred" });
  assertEquals(after[0]?.ok, false, "a stale-generation invoke is rejected after disenrollment");
  // A NEWER sync (re-enrollment, gen 9) resumes the bridge.
  const resume = bridge.emitRuntime({ type: "enrollment-sync", gen: 9 });
  assertEquals(resume[0]?.ok, true);
  bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 9, source: "inferred" });
  await tick(5);
  assert(bridge.posted.some((m) => m?.type === "invoke" && m?.gen === 9), "the re-enrolled invoke is forwarded");
});

Deno.test("webmcp bridge: a generationless lifecycle message fails closed (always)", async () => {
  const bridge = makeBridge({
    "enrollment.status": { ok: true, enrolled: true, gen: 2 },
  });
  await tick();
  const noGen = bridge.emitRuntime({ type: "enrollment-sync" });
  assertEquals(noGen[0]?.ok, false, "a generationless sync is rejected");
  const noGenInvoke = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, source: "declared" });
  assertEquals(noGenInvoke[0]?.ok, false, "a generationless invoke is rejected");
  const noSource = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 2 });
  assertEquals(noSource[0]?.ok, false, "a source-less invoke is rejected (no window-global fallback)");
});

Deno.test("webmcp bridge: re-execution is a singleton (one listener, one forward)", async () => {
  const bridge = makeBridge({
    "enrollment.status": { ok: true, enrolled: true, gen: 1 },
  });
  await tick();
  // Re-injection: evaluate the script AGAIN in the same world — the versioned
  // guard must tear down the first instance.
  bridge.evaluate();
  await tick();
  assertEquals(bridge.liveWindowListeners(), 1, "exactly one live window listener after re-injection");
  assertEquals(bridge.liveRuntimeListeners(), 1, "exactly one live runtime listener after re-injection");
  // One tools report → exactly one tools.upsert (the torn-down instance never fires).
  bridge.emitWindow({
    __cairn_bridge: true, type: "tools", nonce: "bridge-nonce", origin: "https://example.com",
    tools: [{ name: "a", source: "declared", description: "", inputSchema: {} }],
  });
  await tick(5);
  assertEquals(bridge.sent.filter((m) => m?.type === "tools.upsert").length, 1, "exactly one upsert per report");
});

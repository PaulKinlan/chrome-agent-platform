// tests/webmcp-status.test.ts — isolated WebMCP relay coverage:
//  - page-route allowlist stays read/report-only
//  - startup enrollment sync arms the relay with the SW-issued key + document epoch
//  - unauthenticated/wrongly-keyed/replayed page messages fail closed
//  - complete replacement snapshots include epoch + advancing sequence
//  - generation/source/disenrollment fencing and singleton teardown
// @ts-nocheck — the content script runs in a mocked browser context.

import { assert, assertEquals } from "jsr:@std/assert@1";

await import("../extension/content/bridge-auth.js");
const bridgeAuth = globalThis.CairnBridgeAuth;
const NONCE = "test-bridge-key-0123456789abcdef";
const BRIDGE_SRC = Deno.readTextFileSync(
  new URL("../extension/content/content-script.js", import.meta.url).pathname,
);

Deno.test("webmcp diagnostics: PAGE_ALLOWED_ROUTES admits only bridge read/report routes", async () => {
  const mod = await import("../extension/lib/pure.js");
  assert(mod.PAGE_ALLOWED_ROUTES.has("webmcp.diagnostics.get"));
  assert(mod.PAGE_ALLOWED_ROUTES.has("enrollment.status"));
  assert(mod.PAGE_ALLOWED_ROUTES.has("tools.upsert"));
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("tools.invoke"), false, "owner invocation stays extension-only");
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("tools.approve"), false);
  assertEquals(mod.PAGE_ALLOWED_ROUTES.has("webmcp.status"), false);
});

function makeBridge(swRoutes = {}) {
  const logs = [];
  const posted = [];
  const sent = [];
  const messageListeners = [];
  const runtimeListeners = [];

  const windowObj = {
    CairnBridgeAuth: bridgeAuth,
    postMessage(msg) { posted.push(msg); },
    addEventListener(type, fn) {
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== "message") return;
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
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
    log: (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
    debug() {}, warn() {}, error() {},
  };
  const evaluate = () => {
    const fn = new Function(
      "window", "document", "location", "crypto", "chrome", "setTimeout", "clearTimeout", "console", "globalThis",
      BRIDGE_SRC + "\n;",
    );
    fn(
      windowObj,
      { readyState: "complete" },
      { origin: "https://example.com" },
      { randomUUID: () => "unused-local-nonce" },
      chromeObj,
      () => 0,
      () => {},
      mockConsole,
      windowObj,
    );
  };
  evaluate();

  let upSeq = 0;
  const emitWindow = (msg, key = NONCE, seq = upSeq++) => {
    const sealed = bridgeAuth.seal(key, "up", seq, msg);
    for (const l of [...messageListeners]) l({ source: windowObj, data: { __cairn_bridge: true, ...sealed } });
  };
  const emitRawWindow = (data) => {
    for (const l of [...messageListeners]) l({ source: windowObj, data });
  };
  const emitRuntime = (message) => {
    const results = [];
    for (const l of [...runtimeListeners]) l(message, {}, (r) => results.push(r));
    return results;
  };
  const downSince = (start = 0) => {
    let last = -1;
    const messages = [];
    for (const data of posted.slice(start)) {
      const opened = bridgeAuth.open(NONCE, "down", last, data);
      if (!opened.ok) continue;
      last = opened.seq;
      messages.push(opened.msg);
    }
    return messages;
  };
  return {
    logs, posted, sent, emitWindow, emitRawWindow, emitRuntime, downSince, evaluate,
    liveWindowListeners: () => messageListeners.length,
    liveRuntimeListeners: () => runtimeListeners.length,
  };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const enrolledRoutes = (gen = 7, epoch = 3) => ({
  "webmcp.diagnostics.get": { enabled: true },
  "enrollment.status": { ok: true, enrolled: true, gen, epoch, nonce: NONCE },
});

Deno.test("webmcp bridge: startup sync arms key + epoch and forwards matching-generation invokes", async () => {
  const bridge = makeBridge(enrolledRoutes());
  await tick();
  assert(bridge.sent.some((m) => m?.type === "enrollment.status"));

  bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 7, source: "inferred" });
  await tick(5);
  const invoke = bridge.downSince().find((m) => m.type === "invoke");
  assert(invoke, "the matching-generation invoke is MAC'd and forwarded");
  assertEquals(invoke.source, "inferred");

  const wrong = bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 3, source: "inferred" });
  assertEquals(wrong[0]?.ok, false);
  assert(String(wrong[0]?.error).includes("generation mismatch"));
});

Deno.test("webmcp bridge: enrolled response without key/epoch remains unarmed (fail closed)", async () => {
  const bridge = makeBridge({ "enrollment.status": { ok: true, enrolled: true, gen: 1 } });
  await tick();
  const res = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 1, source: "declared" });
  assertEquals(res[0]?.ok, false);
  assert(String(res[0]?.error).includes("not armed"));
  bridge.emitRawWindow({ __cairn_bridge: true, type: "tools", tools: [] });
  await tick(5);
  assertEquals(bridge.sent.filter((m) => m.type === "tools.upsert").length, 0);
});

Deno.test("webmcp bridge: never-enrolled and unsynced origins fail closed", async () => {
  const never = makeBridge({ "enrollment.status": { ok: true, enrolled: false, gen: 0 } });
  await tick();
  const tomb = never.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 0, source: "declared" });
  assertEquals(tomb[0]?.ok, false);
  assert(String(tomb[0]?.error).includes("disenrolled"));

  const unsynced = makeBridge({ "enrollment.status": () => new Promise(() => {}) });
  await tick();
  const pending = unsynced.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 1, source: "declared" });
  assertEquals(pending[0]?.ok, false);
  assert(String(pending[0]?.error).includes("not synced"));
});

Deno.test("webmcp bridge: MAC gate rejects bare/wrong/replayed reports; empty snapshots carry epoch + seq", async () => {
  const bridge = makeBridge(enrolledRoutes(1, 11));
  await tick();
  bridge.emitRawWindow({ __cairn_bridge: true, type: "tools", nonce: NONCE, tools: [{ name: "spoofed" }] });
  bridge.emitWindow({ type: "tools", tools: [{ name: "wrong" }] }, "wrong-key-0000000000000000");
  await tick(5);
  assertEquals(bridge.sent.filter((m) => m.type === "tools.upsert").length, 0);

  bridge.emitWindow({ type: "tools", origin: "https://example.com", tools: [] });
  await tick(5);
  const first = bridge.sent.find((m) => m.type === "tools.upsert");
  assert(first, "an authenticated empty replacement snapshot is forwarded");
  assertEquals(first.origin, "https://example.com");
  assertEquals(first.tools, []);
  assertEquals(first.epoch, 11);
  assertEquals(first.seq, 1);
  assertEquals("sessionId" in first, false, "random session IDs no longer order snapshots");

  // Replay the already-consumed authenticated bridge sequence: relay drops it.
  bridge.emitWindow({ type: "tools", tools: [{ name: "replay" }] }, NONCE, 1);
  await tick(5);
  assertEquals(bridge.sent.filter((m) => m.type === "tools.upsert").length, 1);

  bridge.emitWindow({
    type: "tools",
    tools: [{ name: "shop.total", source: "declared", description: "", inputSchema: {} }],
  });
  await tick(5);
  const upserts = bridge.sent.filter((m) => m.type === "tools.upsert");
  assertEquals(upserts.length, 2);
  assertEquals(upserts[1].seq, 2);
});

Deno.test("webmcp bridge: disenrollment cancels pending invokes; stale sync cannot resurrect", async () => {
  const bridge = makeBridge(enrolledRoutes(5, 1));
  await tick();
  const baseline = bridge.posted.length;
  const inFlight = bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 5, source: "inferred" });
  assertEquals(inFlight.length, 0);
  const dis = bridge.emitRuntime({ type: "disenrollment", gen: 6 });
  assertEquals(dis[0]?.ok, true);
  assert(bridge.downSince(baseline).some((m) => m.type === "cancel"));

  const stale = bridge.emitRuntime({ type: "enrollment-sync", gen: 5 });
  assertEquals(stale[0]?.ok, false);
  const after = bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 5, source: "inferred" });
  assertEquals(after[0]?.ok, false);

  const resume = bridge.emitRuntime({ type: "enrollment-sync", gen: 9 });
  assertEquals(resume[0]?.ok, true);
  bridge.emitRuntime({ type: "invoke-tool", name: "greet", args: {}, gen: 9, source: "inferred" });
  await tick(5);
  assert(bridge.downSince(baseline).some((m) => m.type === "invoke" && m.gen === 9));
});

Deno.test("webmcp bridge: generationless lifecycle/invoke and source-less invoke fail closed", async () => {
  const bridge = makeBridge(enrolledRoutes(2, 0));
  await tick();
  assertEquals(bridge.emitRuntime({ type: "enrollment-sync" })[0]?.ok, false);
  assertEquals(bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, source: "declared" })[0]?.ok, false);
  assertEquals(bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 2 })[0]?.ok, false);
});

Deno.test("webmcp bridge: re-execution leaves one relay listener and one upsert", async () => {
  const bridge = makeBridge(enrolledRoutes(1, 4));
  await tick();
  bridge.evaluate();
  await tick();
  assertEquals(bridge.liveWindowListeners(), 1);
  assertEquals(bridge.liveRuntimeListeners(), 1);
  bridge.emitWindow({
    type: "tools",
    tools: [{ name: "a", source: "declared", description: "", inputSchema: {} }],
  });
  await tick(5);
  assertEquals(bridge.sent.filter((m) => m.type === "tools.upsert").length, 1);
});

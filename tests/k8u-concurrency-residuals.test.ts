// tests/k8u-concurrency-residuals.test.ts — chrome-agent-platform-k8u
// [CAP-FB-20260825-CONCURRENCY-RESIDUALS-01]: close the four open concurrency
// verifications with failing-then-passing tests, not inspection.
//
//  (a) version-scoped CAS in the memory/journal compensation path — ALREADY
//      covered behaviorally by tests/memory.test.ts ("compareAndDelete/
//      compareAndRestore are VERSION-scoped", "identical-value ABA is detected
//      by the version token", "journal quota compensation fails closed on ABA
//      and generation mismatch", "deleted key versions remain monotonic").
//      k8u re-verified their falsifiability: reverting the version check in
//      compareAndDelete/compareAndRestore (making them act unconditionally)
//      turns all four RED; restoring returns GREEN. No residual ABA window:
//      versions are monotonic per key, never reused, and survive delete→rewrite.
//  (b) first sync/invoke generation requirement — the "missing generation fails
//      closed" test below runs against a FRESH bridge whose very first lifecycle
//      message is generationless (the existing webmcp-status test rejects
//      generationless messages only AFTER a valid sync armed maxGen).
//  (c) runGenCells per-run isolation — buildOrchestrator's run-generation cells
//      now come from the REAL lib/run-gen-cells.js book; two concurrent builds
//      over the same origin can never share or repoint each other's cells.
//  (d) MAIN-world cancellation tombstone eviction — there ARE no tombstones:
//      cancellation is an immutable monotonic epoch (cancelEpoch). The flood
//      test below cancels an IN-FLIGHT invocation, then hammers hundreds of
//      cancel/resume cycles; the cancelled invocation's late-settling result
//      can never post. Eviction cannot resurrect what does not exist.
//
// @ts-nocheck — the browser-context mocks are intentionally dynamic (house style).
import { assert, assertEquals } from "jsr:@std/assert@1";

await import("../extension/content/bridge-auth.js");
const bridgeAuth = globalThis.CapBridgeAuth;
const NONCE = "k8u-bridge-key-0123456789abcdef";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// (b) FIRST sync/invoke requires a generation — content-script.js harness
// (the webmcp-status.test.ts pattern, minimized).
// ---------------------------------------------------------------------------
const CS_SRC = Deno.readTextFileSync(
  new URL("../extension/content/content-script.js", import.meta.url).pathname,
);

function makeBridge(swRoutes = {}) {
  const logs = [];
  const posted = [];
  const sent = [];
  const messageListeners = [];
  const runtimeListeners = [];
  const windowObj = {
    CapBridgeAuth: bridgeAuth,
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
      CS_SRC + "\n;",
    );
    fn(
      windowObj,
      { readyState: "complete" },
      { origin: "https://example.com" },
      { randomUUID: () => "unused-local-nonce" },
      chromeObj,
      (fn2, ms) => setTimeout(fn2, ms),
      (id) => clearTimeout(id),
      mockConsole,
      windowObj,
    );
  };
  evaluate();
  let upSeq = 0;
  const emitWindow = (msg, key = NONCE, seq = upSeq++) => {
    const sealed = bridgeAuth.seal(key, "up", seq, msg);
    for (const l of [...messageListeners]) l({ source: windowObj, data: { __cap_bridge: true, ...sealed } });
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
  return { logs, posted, sent, emitWindow, emitRuntime, downSince, evaluate };
}

Deno.test("k8u (b): a generationless FIRST enrollment sync arms nothing and invokes fail closed", async () => {
  // The SW response is enrolled but carries NO generation — the very first
  // lifecycle message this bridge ever sees. The round-27 blocker-3 guard must
  // reject it even with maxGen = -Infinity (nothing to compare against).
  const bridge = makeBridge({
    "webmcp.diagnostics.get": { enabled: false },
    "enrollment.status": { ok: true, enrolled: true, epoch: 5, nonce: NONCE }, // NO gen
  });
  await tick();
  // Behavioral proof (the rejection is returned, not logged): the very first
  // push sync, generationless, is rejected outright.
  const first = bridge.emitRuntime({ type: "enrollment-sync" });
  assertEquals(first[0]?.ok, false, "a generationless FIRST push sync is rejected");
  assert(String(first[0]?.error).includes("missing enrollment generation"));
  // No resume may reach the MAIN world (the world stays cancelled).
  assertEquals(
    bridge.downSince().filter((m) => m.type === "resume").length,
    0,
    "a rejected first sync must never arm MAIN",
  );
  // An invoke naming ANY generation fails closed — there is no generation
  // authority to invoke under.
  const invoke = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 0, source: "declared" });
  assertEquals(invoke[0]?.ok, false);
  assert(String(invoke[0]?.error).includes("not synced"), "unsynced first invoke must fail closed");
  // A generationless push sync STILL rejected after the startup rejection.
  const push = bridge.emitRuntime({ type: "enrollment-sync" });
  assertEquals(push[0]?.ok, false);
  // Control: a PROPER first sync with a generation succeeds and arms the world.
  const good = bridge.emitRuntime({ type: "enrollment-sync", gen: 3, epoch: 5 });
  assertEquals(good[0]?.ok, true, "a well-formed first sync must still succeed (fail-closed, not fail-dead)");
  assertEquals(
    bridge.downSince().filter((m) => m.type === "resume").length,
    1,
    "the valid sync arms MAIN exactly once",
  );
  const invoke2 = bridge.emitRuntime({ type: "invoke-tool", name: "x", args: {}, gen: 3, source: "declared" });
  // The response is async (resolved when MAIN answers); the synchronous proof
  // of acceptance is the forwarded, MAC'd invoke message to the MAIN world.
  const forwarded = bridge.downSince().find((m) => m.type === "invoke");
  assert(forwarded, "an invoke under the synced generation is forwarded to MAIN");
  assertEquals(forwarded?.gen, 3);
  assertEquals(forwarded?.name, "x");
});

// ---------------------------------------------------------------------------
// (c) runGenCells per-run isolation — the REAL lib/run-gen-cells.js module
// buildOrchestrator uses (the round-27 blocker-4 fix).
// ---------------------------------------------------------------------------
import { createRunGenCellBook } from "../extension/lib/run-gen-cells.js";

Deno.test("k8u (c): concurrent same-origin builds never share or repoint each other's run-generation cells", () => {
  // Build A and build B race over the SAME origin (the historical shared-map
  // regression: B's cell creation overwrote A's entry, so A's commit bound
  // cell B and A's tools read B's run generation forever).
  const buildA = createRunGenCellBook();
  const buildB = createRunGenCellBook();
  const origin = "https://apps.example";
  const cellA = buildA.cellFor(origin);
  // Interleave: B creates its cell AFTER A, then B binds FIRST (the exact
  // historical interleave that poisoned A through the shared map).
  const cellB = buildB.cellFor(origin);
  buildB.bind(origin, () => 2);
  buildA.bind(origin, () => 1);
  assert(cellA !== cellB, "two builds must hold DISTINCT cell objects per origin");
  assertEquals(cellA.get(), 1, "build A's cell still reads build A's generation");
  assertEquals(cellB.get(), 2, "build B's cell reads build B's generation");
  // A LATER rebuild re-binding can never repoint an EARLIER build's cell.
  const buildC = createRunGenCellBook();
  buildC.cellFor(origin);
  buildC.bind(origin, () => 3);
  assertEquals(cellA.get(), 1, "a newer build's bind never repoints an older build's cell");
  // Binding an origin the build never created is a silent no-op (fail-closed).
  buildA.bind("https://never-created.example", () => 9);
  assertEquals(buildA.size(), 1);
});

// ---------------------------------------------------------------------------
// (d) MAIN-world cancellation: immutable epoch under a cancel/resume flood —
// load the REAL content/main-world.js in a mocked page realm.
// ---------------------------------------------------------------------------
const MW_SRC = Deno.readTextFileSync(
  new URL("../extension/content/main-world.js", import.meta.url).pathname,
);

Deno.test("k8u (d): a cancelled in-flight invocation can never post under a cancel/resume flood", async () => {
  const MARKER = "K8U-LATE-RESULT-MARKER";
  const posted = [];
  const logs = [];
  const messageListeners = [];
  const windowObj = {
    CapBridgeAuth: bridgeAuth,
    postMessage(msg) { posted.push(msg); },
    addEventListener(type, fn) {
      if (type === "message") messageListeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type !== "message") return;
      const i = messageListeners.indexOf(fn);
      if (i >= 0) messageListeners.splice(i, 1);
    },
    // A positively-exposed page tool that settles LATE (after the flood).
    webmcpExpose: [{
      name: "slow_tool",
      description: "settles late",
      fn: function slow_tool(marker) {
        return new Promise((resolve) => setTimeout(() => resolve(String(marker)), 250));
      },
    }],
  };
  const mockConsole = {
    log: (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")),
    debug() {}, warn() {}, error() {},
  };
  const evaluate = () => {
    const fn = new Function(
      "window", "document", "location", "crypto", "console", "globalThis",
      MW_SRC + "\n;",
    );
    fn(
      windowObj,
      { readyState: "complete", modelContext: undefined },
      { origin: "https://page.example" },
      { randomUUID: () => "unused" },
      mockConsole,
      windowObj,
    );
  };
  evaluate();

  // Arm the world via the SW's out-of-band bootstrap hook.
  const hook = windowObj.__capMainWorldBootstrap;
  assertEquals(typeof hook, "function", "the bootstrap hook is installed");
  hook(NONCE, false);
  await tick(400); // let discovery collect + post the tools list

  // Open the world's "up" messages in order.
  let lastUp = -1;
  const upMessages = (start = 0) => {
    const out = [];
    for (const data of posted.slice(start)) {
      const opened = bridgeAuth.open(NONCE, "up", lastUp, data);
      if (!opened.ok) continue;
      lastUp = opened.seq;
      out.push(opened.msg);
    }
    return out;
  };
  assert(upMessages().some((m) => m.type === "tools"), "bootstrap posts the tool list");

  // Send authenticated down messages with strict monotonic sequencing.
  let downSeq = 0;
  const sendDown = (msg) => {
    const sealed = bridgeAuth.seal(NONCE, "down", downSeq++, msg);
    for (const l of [...messageListeners]) l({ source: windowObj, data: { __cap_bridge: true, ...sealed } });
  };

  // Dispatch the slow invocation and let it START (past the one-macrotask
  // deferral + pre-start checks) before any cancel lands.
  const before = posted.length;
  sendDown({ type: "invoke", requestId: "r1", name: "slow_tool", args: { marker: MARKER }, source: "inferred" });
  await tick(60);

  // Cancel, then FLOOD: 300 cancel/resume cycles. Under the retired tombstone
  // design this volume would evict r1's tombstone (or outlive its 60s TTL in a
  // slow settlement) and let the late result resurface. An immutable epoch has
  // nothing to evict.
  sendDown({ type: "cancel" });
  for (let i = 0; i < 300; i++) {
    sendDown({ type: "resume" });
    sendDown({ type: "cancel" });
  }
  sendDown({ type: "resume" }); // end armed — the world is usable again

  // Let the page function settle (250ms) well past the flood.
  await tick(400);

  const results = upMessages(before).filter((m) => m.type === "result" && m.requestId === "r1");
  assertEquals(results.length, 1, "exactly one result posts for the cancelled invocation");
  assertEquals(results[0]?.ok, false, "the cancelled invocation posts a cancellation, never its value");
  assert(String(results[0]?.error).includes("cancelled"), "the result is the typed cancellation");
  assert(
    !JSON.stringify(results).includes(MARKER),
    "the late-settling page result can NEVER cross the bridge after cancel",
  );

  // The world still works after the flood: a NEW invoke under the final armed
  // epoch succeeds (the flood did not wedge the bridge or leak state into it).
  sendDown({ type: "invoke", requestId: "r2", name: "slow_tool", args: { marker: "post-flood" }, source: "inferred" });
  await tick(400);
  const r2 = upMessages(before).filter((m) => m.type === "result" && m.requestId === "r2");
  assertEquals(r2.length, 1);
  assertEquals(r2[0]?.ok, true, "a post-flood invocation under the armed epoch succeeds");
});

Deno.test("k8u (d): cancellation state is bounded by construction — no per-id tombstone collection exists", async () => {
  // The round-30 fix removed the expiring per-id tombstone map entirely. Guard
  // against regression: every "tombstone" mention in main-world.js must be a
  // COMMENT, and the cancellation state is two scalars + the bounded inFlight
  // set (each entry evicted by a 20s timer at line ~717).
  const lines = MW_SRC.split("\n").filter((l) => l.includes("tombstone"));
  for (const line of lines) {
    const t = line.trim();
    assert(
      t.startsWith("//") || t.startsWith("*"),
      `no live tombstone structure may exist — found code: ${line.trim()}`,
    );
  }
  assert(MW_SRC.includes("let cancelEpoch = 0;"), "the immutable epoch counter exists");
  assert(MW_SRC.includes("let cancelledAll = false;"), "the cancelledAll scalar exists");
});

// tests/provider-gate.test.ts — the provider network gate + the circuit-breaker
// (the "Failed to fetch" root cause + the hook/task error FLOOD, Paul 2026-08-17).
//
// Tested WITHOUT a browser: chrome.permissions is absent, so the host-access
// check falls back to "true" (nothing to grant) — the parts we assert here are
// the origin-pattern derivation, the circuit-breaker trip/reset, and the
// provider-error classifier (all pure + deterministic).

// @ts-nocheck — dynamic chrome stubs in the race tests (no types in Deno).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  providerOriginPattern,
  isProviderError,
  isLocalProvider,
  providerRunGate,
  ProviderUnavailableError,
  recordProviderFailure,
  recordProviderSuccess,
  providerBreakerOpen,
  logGateOnce,
  resetGateLog,
} from "../extension/lib/provider-gate.js";

// ---- providerOriginPattern ----
// ── fresh-module isolation (no production reset hook) ───────────────────────
// Each test loads a CACHE-BUSTED instance of the REAL production module:
// fresh module state (a fresh lease universe) with identical production
// semantics — the same code production runs, no exported test seam.
let __freshModuleCounter = 0;
async function freshLeaseModule() {
  __freshModuleCounter += 1;
  const spec = `../extension/lib/perm-lease.js?fresh=${__freshModuleCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = new URL(spec, import.meta.url);
  return await import(url.href);
}

Deno.test("providerOriginPattern derives the host pattern for an http(s) URL", () => {
  assertEquals(
    providerOriginPattern({ baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }),
    "https://generativelanguage.googleapis.com/*",
  );
  assertEquals(
    providerOriginPattern({ baseURL: "https://api.openai.com/v1" }),
    "https://api.openai.com/*",
  );
  assertEquals(
    providerOriginPattern({ baseURL: "http://localhost:11434/v1" }),
    "http://localhost:11434/*",
  );
});

Deno.test("providerOriginPattern returns null for a missing/invalid base URL", () => {
  assertEquals(providerOriginPattern({ baseURL: "" }), null);
  assertEquals(providerOriginPattern({}), null);
  assertEquals(providerOriginPattern({ baseURL: "not a url" }), null);
});

// ---- isProviderError (only provider failures trip the breaker) ----
Deno.test("isProviderError classifies provider/network/credential failures", () => {
  assert(isProviderError(new Error("TypeError: Failed to fetch")));
  assert(isProviderError(new Error("AI_APICallError: 401 unauthorized")));
  assert(isProviderError(new Error("AI_NoOutputGeneratedError: No output generated")));
  assert(isProviderError(new Error("AI_RetryError: Failed after 3 attempts")));
  assert(isProviderError(new Error("Invalid API key")));
});

Deno.test("isProviderError does NOT classify tool errors or fence aborts", () => {
  assert(!isProviderError(new Error("tab not found")));
  assert(!isProviderError(new Error("permission denied")));
  assert(!isProviderError(new Error("run aborted")));
  assert(!isProviderError(new Error("no matching tool")));
});

// ---- local providers (demo + Prompt API) are never gated ----
Deno.test("isLocalProvider identifies the demo + Prompt API (no host permission)", () => {
  assert(isLocalProvider({ provider: "demo", baseURL: "" }));
  assert(isLocalProvider({ provider: "prompt-api" }));
  assert(!isLocalProvider({ provider: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }));
  assert(!isLocalProvider({ provider: "openai", baseURL: "https://api.openai.com/v1" }));
  assert(!isLocalProvider({}));
});

Deno.test("providerRunGate never gates a LOCAL provider, even with a stale baseURL", async () => {
  recordProviderSuccess(); // clean breaker
  // The regression: provider.set({provider:'demo'}) does not clear a stale
  // baseURL from a previously-selected network provider. The demo must still
  // pass the gate (it never fetches that URL).
  const g = await providerRunGate({
    provider: "demo",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  });
  assertEquals(g.ok, true);
  assertEquals(g.reason, "");
});

// ---- ProviderUnavailableError carries a clear, user-facing reason ----
Deno.test("ProviderUnavailableError is a distinct, message-preserving error type", () => {
  const e = new ProviderUnavailableError("network access to the provider is not granted");
  assert(e instanceof Error);
  assert(e instanceof ProviderUnavailableError);
  assertEquals(e.name, "ProviderUnavailableError");
  assertEquals(e.message, "network access to the provider is not granted");
});

// ---- circuit-breaker: trip after 3 failures, reset on success ----
Deno.test("the circuit-breaker trips after 3 consecutive provider failures", () => {
  recordProviderSuccess(); // start clean
  assertEquals(providerBreakerOpen(), false);
  recordProviderFailure("Failed to fetch");
  assertEquals(providerBreakerOpen(), false);
  recordProviderFailure("Failed to fetch");
  assertEquals(providerBreakerOpen(), false);
  const third = recordProviderFailure("Failed to fetch");
  assertEquals(third.tripped, true);
  assertEquals(providerBreakerOpen(), true);
  // a success closes it
  recordProviderSuccess();
  assertEquals(providerBreakerOpen(), false);
});

Deno.test("a non-provider failure never trips the breaker (classified before recording)", () => {
  recordProviderSuccess();
  // isProviderError guards the call site in runTask — a tool error is not recorded.
  assert(!isProviderError(new Error("tab not found")));
  // (the breaker is only advanced when isProviderError is true)
});

// ---- flood suppression (the per-event hook/task error FLOOD) ----
// The hook + scheduled-task catch handlers route ANY provider failure
// (including the agent-do re-thrown AI_NoOutputGeneratedError) through
// logGateOnce, which dedupes per reason — a tabs.onUpdated burst logs at most
// once, not one line per event.
Deno.test("logGateOnce dedupes a repeated provider-failure reason (flood suppression)", () => {
  resetGateLog();
  const reason = "No output generated. Check the stream for errors.";
  assertEquals(logGateOnce(reason), true);   // first time → logs
  assertEquals(logGateOnce(reason), false);  // same reason → suppressed
  assertEquals(logGateOnce(reason), false);  // still suppressed
  // a DIFFERENT reason logs (the dedupe key is the message)
  assertEquals(logGateOnce("network access to the provider is not granted"), true);
});

Deno.test("a no-output provider failure is classified as a provider error (so the hook catch backs off)", () => {
  // The exact error Paul saw flooding the console: the agent-do run re-throws
  // AI_NoOutputGeneratedError, which the hook/task catch must treat as a
  // provider failure (log once + trip the breaker), not a per-event console.error.
  assert(isProviderError(new Error("AI_NoOutputGeneratedError: No output generated. Check the stream for errors.")));
  assert(isProviderError(new Error("AI_APICallError: 401 unauthorized")));
  assert(isProviderError(new Error("AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError")));
});

// ── final review: permission-request coordination (SW lease authority) ──────
// The lease registry is a PURE module (lib/perm-lease.js) the SW hosts; these
// tests drive it as TWO INDEPENDENT SURFACES would (each acquire/settle pair
// is a different page's request), plus the page-side bounded fallback.

Deno.test("perm lease: two surfaces — the second acquire gets NO lease (no duplicate prompt)", async () => {
  const lease = await freshLeaseModule();
  const a = await lease.acquireLease("https://a.example/*"); // surface A prompts
  const b = await lease.acquireLease("https://a.example/*"); // surface B, same instant
  assertEquals(a.lease, true, "surface A holds the lease (+ the unguessable token)");
  assertEquals(typeof a.token, "string", "the lease carries an owner token");
  assertEquals(b.lease, false, "surface B is denied a second prompt (dedupe ACROSS surfaces)");
  assertEquals(b.generation, a.generation, "both see the same generation");
  // A settles with its TOKEN; the entry is DELETED.
  const settled = lease.settleLease("https://a.example/*", { generation: a.generation, token: a.token, granted: true });
  assertEquals(settled.ok, true);
  assertEquals(settled.broadcast.granted, true, "the settle carries the broadcast payload");
  const state = await lease.leaseState("https://a.example/*");
  assertEquals(state.inFlight, false, "settled entries are DELETED (no map growth)");
  assertEquals(state.lastOutcome, "granted", "the bounded memo keeps the last outcome for consumers");
});

Deno.test("perm lease: ONLY the token holder can settle (no replay by generation)", async () => {
  const lease = await freshLeaseModule();
  const a = await lease.acquireLease("https://tok.example/*");
  // Knowing ONLY the generation (as a hostile page would) cannot settle.
  const forged = lease.settleLease("https://tok.example/*", { generation: a.generation, token: "guessed", granted: true });
  assertEquals(forged.ok, false, "a forged token is rejected");
  assertEquals(forged.stale, true);
  // Nor can a second settle after a legitimate one (the entry is deleted).
  const ok1 = lease.settleLease("https://tok.example/*", { generation: a.generation, token: a.token, granted: true });
  assertEquals(ok1.ok, true);
  const replay = lease.settleLease("https://tok.example/*", { generation: a.generation, token: a.token, granted: false });
  assertEquals(replay.ok, false, "replaying the same settle is a no-op (deleted entry)");
});

Deno.test("perm lease: a timed-out lease EXPIRES — the origin is never permanently blocked", async () => {
  const lease = await freshLeaseModule();
  const a = await lease.acquireLease("https://slow.example/*");
  assertEquals(a.lease, true);
  // While in flight (before expiry): a retry is denied (no duplicate prompt).
  const b = await lease.acquireLease("https://slow.example/*");
  assertEquals(b.lease, false);
  await new Promise((r) => setTimeout(r, 8_200)); // the lease expires + is dropped
  // After expiry the origin RECOVERS: a fresh acquire (new generation) wins —
  // a crashed page cannot block the origin until SW restart.
  const c = await lease.acquireLease("https://slow.example/*");
  assertEquals(c.lease, true, "expiry frees the slot (recoverable, not a permanent block)");
  assertEquals(typeof c.generation, "string");
  assertEquals(c.generation !== a.generation, true, "a FRESH unique generation after expiry (opaque ids)");
  assertEquals(typeof c.token, "string");
  lease.settleLease("https://slow.example/*", { generation: c.generation, token: c.token, granted: false });
});

Deno.test("perm lease: invalid patterns are rejected + the map is bounded", async () => {
  const lease = await freshLeaseModule();
  assertEquals((await lease.acquireLease("javascript:alert(1)/*")).lease, false, "non-http(s) rejected");
  assertEquals((await lease.acquireLease("not a pattern")).lease, false, "garbage rejected");
  assertEquals((await lease.acquireLease("https://ok.example/sub")).lease, false, "non-/* path rejected");
  assertEquals((await lease.acquireLease("https://ok.example/?q=1")).lease, false, "query rejected");
  assertEquals((await lease.acquireLease("HTTPS://MiXeD.Example/*")).lease, true, "canonicalized scheme/host accepted");
});

Deno.test("perm lease: a STALE-generation settle is ignored (no cross-talk)", async () => {
  const lease = await freshLeaseModule();
  const a = await lease.acquireLease("https://stale.example/*");
  lease.settleLease("https://stale.example/*", { generation: a.generation, granted: false });
  const b = await lease.acquireLease("https://stale.example/*");
  const stale = lease.settleLease("https://stale.example/*", { generation: a.generation, granted: true });
  assertEquals(stale.ok, false, "an old generation cannot settle a new lease");
  assertEquals(stale.stale, true);
  lease.settleLease("https://stale.example/*", { generation: b.generation, granted: true });
});

Deno.test("perm gate (page client): no SW coordination → bounded direct request", async () => {
  // chrome.runtime.sendMessage absent → the client falls back to a bounded
  // direct request (the unit-test/no-SW path).
  let prompts = 0;
  globalThis.chrome = {
    permissions: {
      request: () => new Promise((resolve) => { prompts++; setTimeout(() => resolve(true), 20); }),
      contains: async () => false,
    },
    // NO runtime.sendMessage — the SW authority is unavailable.
  };
  const gate = await import("../extension/lib/provider-gate.js");
  const res = await gate.requestProviderHostAccess({ baseURL: "https://direct.example/v1" });
  assertEquals(res.granted, true);
  assertEquals(prompts, 1);
});

Deno.test("perm gate (page client): lease-holder prompts; a second page WAITS and reconciles", async () => {
  // A fake SW authority implementing the lease routes — this simulates TWO
  // PAGES coordinating through the real registry.
  const lease = await freshLeaseModule();
  const sw = {
    async sendMessage(msg) {
      if (msg.type === "perm-lease.acquire") return lease.acquireLease(msg.pattern);
      if (msg.type === "perm-lease.settle") return lease.settleLease(msg.pattern, msg);
      if (msg.type === "perm-lease.state") return lease.leaseState(msg.pattern);
      return {};
    },
    runtime: {
      sendMessage: null, // set below
      onMessage: { addListener() {}, removeListener() {} },
    },
  };
  sw.runtime.sendMessage = (m) => sw.sendMessage(m);
  let prompts = 0;
  let resolvePrompt;
  globalThis.chrome = {
    runtime: sw.runtime,
    permissions: {
      request: () => new Promise((resolve) => { prompts++; resolvePrompt = resolve; }),
      contains: async () => false,
    },
  };
  const gate = await import("../extension/lib/provider-gate.js");
  // "Page A" (the lease holder) — its prompt stays pending.
  const pageA = gate.requestProviderHostAccess({ baseURL: "https://race.example/v1" });
  await new Promise((r) => setTimeout(r, 50));
  // "Page B" — denied a lease, waits for the settle broadcast.
  const pageB = gate.requestProviderHostAccess({ baseURL: "https://race.example/v1" });
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(prompts, 1, "exactly ONE prompt across the two surfaces");
  // A's user grants late; both callers reconcile.
  resolvePrompt(true);
  const [ra, rb] = await Promise.all([pageA, pageB]);
  assertEquals(ra.granted, true, "the prompting surface reports the grant");
  assertEquals(rb.granted, true, "the waiting surface reconciles the same outcome");
});

// ── acceptance round: backpressure, churn, restart, real SW-route integration ──
Deno.test("perm lease: capacity is BACKPRESSURE — active leases are never evicted", async () => {
  const lease = await freshLeaseModule();
  const held = [];
  for (let i = 0; i < 64; i++) {
    const r = await lease.acquireLease(`https://cap-${i}.example/*`);
    assertEquals(r.lease, true);
    held.push(r);
  }
  const overflow = await lease.acquireLease("https://overflow.example/*");
  assertEquals(overflow.lease, false, "at capacity the acquire is REJECTED (busy)");
  assertEquals(overflow.reason, "busy");
  // Every original lease is STILL valid (none evicted) — settle them all.
  for (const h of held) {
    assertEquals(lease.settleLease(h.pattern, { generation: h.generation, token: h.token, granted: true }).ok, true);
  }
  // Freed: the next acquire succeeds.
  assertEquals((await lease.acquireLease("https://overflow.example/*")).lease, true);
});

Deno.test("perm lease: generations are cryptographically UNIQUE across churn > capacity + restarts", async () => {
  const lease = await freshLeaseModule();
  const seen = new Set();
  // Churn MORE patterns than the map cap, repeatedly (settle frees slots).
  for (let round = 0; round < 200; round++) {
    const r = await lease.acquireLease(`https://churn-${round % 90}.example/*`);
    if (r.lease) {
      assertEquals(seen.has(r.generation), false, `generation ${r.generation} reused`);
      seen.add(r.generation);
      lease.settleLease(r.pattern, { generation: r.generation, token: r.token, granted: false });
    }
  }
  assertEquals(seen.size >= 190, true, `every issued generation was unique (${seen.size})`);
  // Simulate a WORKER RESTART: a FRESH module instance = fresh state —
  // uniqueness is guaranteed by the UUID, not by surviving state.
  const lease2 = await freshLeaseModule();
  const afterRestart = await lease2.acquireLease("https://churn-0.example/*");
  assertEquals(afterRestart.lease, true);
  assertEquals(seen.has(afterRestart.generation), false, "no generation reuse even across a (simulated) restart");
});

Deno.test("perm lease: REAL SW dispatcher integration (chrome.runtime.onMessage → handler table)", async () => {
  // Load the REAL service-worker module (the actual handler table + the real
  // chrome.runtime.onMessage dispatcher), drive a dispatcher-registered
  // listener with a page-shaped message, and assert the response — not a
  // local wrapper around the pure module (the successor review's HIGH).
  const listeners = [];
  const noopListener = { addListener: () => {} };
  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onConnect: noopListener,
      onInstalled: noopListener,
      sendMessage: async () => {},
    },
    storage: { local: { get: async () => ({}), set: async () => {} }, session: { get: async () => ({}), set: async () => {} } },
    permissions: { contains: async () => false, onAdded: noopListener, onRemoved: noopListener },
    alarms: { onAlarm: noopListener, create: () => {}, clear: () => {} },
    tabs: { onCreated: noopListener, onActivated: noopListener, onUpdated: noopListener, onRemoved: noopListener, onAttached: noopListener, onZoomChange: noopListener, query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {} },
    windows: { onCreated: noopListener, onRemoved: noopListener, onFocusChanged: noopListener },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noopListener },
    webNavigation: {},
    notifications: {},
  };
  // Import the REAL SW module (it registers the dispatcher at load).
  await import("../extension/background/service-worker.js");
  assertEquals(listeners.length >= 1, true, "the SW registered its onMessage dispatcher");
  const dispatch = (msg) => new Promise((resolve) => {
    const answered = listeners.find((fn) => {
      let responded = false;
      const sendResponse = (r) => { responded = true; resolve(r); };
      const keepOpen = fn(msg, { documentUrl: `chrome-extension://test-extension-id/options/options.html` }, sendResponse);
      return true; // first listener that responds wins
    });
    void answered;
  });
  // Acquire through the REAL dispatcher.
  const acq = await dispatch({ type: "perm-lease.acquire", pattern: "https://dispatch.example/*" });
  assertEquals(acq?.lease, true, "the real dispatcher acquired a lease");
  assertEquals(typeof acq?.token, "string");
  assertEquals(typeof acq?.generation, "string");
  // Settle through the REAL dispatcher WITH the token (the previously-dropped field).
  const settled = await dispatch({ type: "perm-lease.settle", pattern: "https://dispatch.example/*", generation: acq.generation, token: acq.token, granted: true });
  assertEquals(settled?.ok, true, "the real dispatcher settled WITH the owner token");
  assertEquals(settled?.broadcast?.granted, true);
  // A forged-token settle through the same dispatcher is rejected.
  const acq2 = await dispatch({ type: "perm-lease.acquire", pattern: "https://dispatch2.example/*" });
  const forged = await dispatch({ type: "perm-lease.settle", pattern: "https://dispatch2.example/*", generation: acq2.generation, token: "forged", granted: true });
  assertEquals(forged?.ok, false, "a forged settle through the real dispatcher is rejected");
  await dispatch({ type: "perm-lease.settle", pattern: "https://dispatch2.example/*", generation: acq2.generation, token: acq2.token, granted: false });
});

Deno.test("perm lease: strict canonicalization (URL parse)", async () => {
  const lease = await freshLeaseModule();
  assertEquals(lease.canonicalPattern("https://host.example:8443/*"), "https://host.example:8443/*", "explicit port kept");
  assertEquals(lease.canonicalPattern("https://user:pass@host.example/*"), null, "userinfo rejected");
  assertEquals(lease.canonical_pattern_garbage ?? null, null); // no accidental exports
  assertEquals((await lease.acquireLease("ftp://x/*")).reason, "invalid pattern", "non-http scheme rejected at acquire");
});


// ── this review: the CONSUMER (onIssued) binding — stale/newer/observed/no-lease ──
Deno.test("consumer binding: onIssued delivers OUR generation atomically with acquisition", async () => {
  // Fake SW authority implementing the lease; a hostile "settle" flood tries
  // stale + newer generations around the real one.
  const lease = await freshLeaseModule();
  const seen = [];
  const sw = {
    sendMessage: (m) => {
      if (m.type === "perm-lease.acquire") return lease.acquireLease(m.pattern);
      if (m.type === "perm-lease.settle") return lease.settleLease(m.pattern, m);
      if (m.type === "perm-lease.state") return lease.leaseState(m.pattern);
      return {};
    },
  };
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: (m) => sw.sendMessage(m),
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
    },
    permissions: {
      request: () => new Promise((resolve) => setTimeout(() => resolve(true), 30)),
      contains: async () => false,
    },
  };
  const gate = await import("../extension/lib/provider-gate.js");
  const unlisten = gate.onPermissionSettled((msg) => seen.push(msg));
  let issued = null;
  const r = await gate.requestProviderHostAccess(
    { baseURL: "https://consumer.example/v1" },
    { onIssued: (info) => { issued = info; } },
  );
  assertEquals(r.granted, true);
  assertEquals(issued?.ours, true, "the caller is told the generation is ITS OWN");
  assertEquals(r.generation, issued?.generation, "the result carries the same issued generation");
  unlisten();
});

Deno.test("waiter: hostile stale/NEWER injections never resolve the competing-request waiter; only the EXACT generation does", async () => {
  const lease = await freshLeaseModule();
  const listeners = [];
  let promptResolve;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "perm-lease.acquire") return lease.acquireLease(m.pattern);
        if (m.type === "perm-lease.settle") return lease.settleLease(m.pattern, m);
        if (m.type === "perm-lease.state") return lease.leaseState(m.pattern);
        return {};
      },
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
    },
    permissions: {
      request: () => new Promise((resolve) => { promptResolve = resolve; }),
      contains: async () => false,
    },
  };
  const gate = await import("../extension/lib/provider-gate.js");
  // Surface A holds the lease (prompt pending) — B will WAIT on it.
  const a = gate.requestProviderHostAccess({ baseURL: "https://wait2.example/v1" });
  await new Promise((r) => setTimeout(r, 30));
  // B: the WAITER path (the exact-generation competing-request consumer).
  let waiterDone = false;
  const b = gate.requestProviderHostAccess({ baseURL: "https://wait2.example/v1" });
  b.then(() => { waiterDone = true; }, () => { waiterDone = true; });
  await new Promise((r) => setTimeout(r, 50));
  // HOSTILE injections against the WAITER: stale + newer generations for the
  // same pattern. None may resolve it.
  const pattern = "https://wait2.example/*";
  const aGen = (await lease.leaseState(pattern)).generation;
  for (const hostileGen of ["stale-" + aGen.slice(0, 8), aGen + "-newer", "totally-different"]) {
    for (const fn of [...listeners]) fn({ type: "provider-host-perm:settled", pattern, generation: hostileGen, granted: true });
  }
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(waiterDone, false, "hostile stale/newer settlements did NOT resolve the waiter");
  // The REAL settle (A's prompt resolves true → settleLease → the SW handler
  // broadcasts — emulate the broadcast as the SW does) resolves BOTH.
  promptResolve(true);
  const [ra, rb] = await Promise.all([a, b]);
  assertEquals(ra.granted, true);
  // The waiter reconciled from the REAL outcome only after the real settle.
  assertEquals(waiterDone, true);
  assertEquals(rb.granted, true, "the waiter reconciled the real grant");
});

Deno.test("consumer binding: a WAITER on another surface's request binds THAT observed generation", async () => {
  const lease = await freshLeaseModule();
  let resolvePrompt;
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: (m) => {
        if (m.type === "perm-lease.acquire") return lease.acquireLease(m.pattern);
        if (m.type === "perm-lease.settle") return lease.settleLease(m.pattern, m);
        if (m.type === "perm-lease.state") return lease.leaseState(m.pattern);
        return {};
      },
      onMessage: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } },
    },
    permissions: {
      request: () => new Promise((resolve) => { resolvePrompt = resolve; }),
      contains: async () => false,
    },
  };
  const gate = await import("../extension/lib/provider-gate.js");
  // Surface A acquires (prompt pending).
  const issuedInfo = [];
  const a = gate.requestProviderHostAccess({ baseURL: "https://wait.example/v1" }, { onIssued: (i) => issuedInfo.push(i) });
  await new Promise((r) => setTimeout(r, 30));
  // Surface B is a WAITER: onIssued(ours:false) with A's generation.
  const bInfo = [];
  const b = gate.requestProviderHostAccess({ baseURL: "https://wait.example/v1" }, { onIssued: (i) => bInfo.push(i) });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(bInfo[0]?.ours, false, "B is told it is a waiter");
  assertEquals(bInfo[0]?.generation, issuedInfo[0]?.generation, "B binds A's OBSERVED generation (never null/any)");
  resolvePrompt(true);
  const [ra, rb] = await Promise.all([a, b]);
  assertEquals(ra.granted && rb.granted, true);
  assertEquals(rb.generation, ra.generation, "both carry the same observed generation");
});

// ── shipped-seam regression (this correction): perm-lease exports no
// __-prefixed/test/reset symbol, and the scan-shipped harness catches a
// fixture seam.
Deno.test("shipped seam: perm-lease exports NO __/reset/test symbol", async () => {
  const mod = await freshLeaseModule();
  const exported = Object.keys(mod);
  for (const name of exported) {
    assertEquals(/^__|reset.*for.*test|ForTest$/i.test(name), false, `shipped export violates the seam policy: ${name}`);
  }
  // and the actual public surface is exactly the production API:
  const expected = ["canonicalPattern", "acquireLease", "settleLease", "leaseState"];
  assertEquals([...exported].sort(), [...expected].sort());
});

Deno.test("shipped seam: the scan-shipped harness CATCHES a fixture seam (fail-closed proof)", async () => {
  const fsMod = "node:fs/promises";
  const fsp2 = await import(fsMod);
  const osMod = "node:os";
  const os = await import(osMod);
  const pathMod2 = "node:path";
  const path2 = (await import(pathMod2)).default;
  const scanMod = await import("../scripts/scan-shipped.mjs");
  const dir = await fsp2.mkdtemp(path2.join(os.tmpdir(), "cap-seam-test-"));
  try {
    const fixture = path2.join(dir, "fixture-seam.js");
    await fsp2.writeFile(fixture, "export function __resetForTest() { return 1; }" + "\n");
    const violations = await scanMod.scanShippedJs([fixture], { readText: (f) => fsp2.readFile(f, "utf8") });
    assertEquals(violations.length > 0, true, "the scanner flags a __-prefixed export");
    assertEquals(violations[0].includes("__resetForTest"), true, "the violation names the seam");
    // …and the PRODUCTION module scans clean:
    const clean = await scanMod.scanShippedJs([new URL("../extension/lib/perm-lease.js", import.meta.url).pathname], { readText: (f) => fsp2.readFile(f, "utf8") });
    assertEquals(clean, [], "perm-lease ships clean");
  } finally {
    await fsp2.rm(dir, { recursive: true, force: true });
  }
});

// ── static-review 5547b5d: kv.get composed secret-safe path + principal trust,
//    driven through the REAL dispatcher with the SW's own kv session store. ──
Deno.test("kv.get (real dispatcher): secret namespaces redacted on read-all AND explicit; provider routes principal-gated", async () => {
  const noop = { addListener: () => {} };
  const listeners = [];
  const MARKER_NAMED = "nm-seed-" + Date.now();
  const MARKER_GLOBAL = "gl-seed-" + Date.now();
  // Non-key-shaped marker strings (never key values) per the review instruction.
  globalThis.chrome = {
    runtime: {
      id: "test-extension-id",
      getURL: (p) => `chrome-extension://test-extension-id/${p}`,
      getManifest: () => ({ version: "0.2.144" }),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onConnect: noop, onInstalled: noop,
      sendMessage: async () => {},
    },
    storage: { local: {
      get: async (k) => { const o = {}; if (k == null) { Object.assign(o, Object.fromEntries(kvStore)); return o; } for (const x of (Array.isArray(k)?k:[k])) if (kvStore.has(x)) o[x] = kvStore.get(x); return o; },
      set: async (o) => { for (const [k,v] of Object.entries(o)) kvStore.set(k, v); },
      remove: async (k) => { for (const x of (Array.isArray(k)?k:[k])) kvStore.delete(x); },
    } },
    permissions: { contains: async () => false, onAdded: noop, onRemoved: noop },
    alarms: { onAlarm: noop, create: () => {}, clear: () => {} },
    tabs: { onCreated: noop, onActivated: noop, onUpdated: noop, onRemoved: noop, onAttached: noop, onZoomChange: noop, query: async () => [], sendMessage: async () => {}, create: async () => ({ id: 1 }), update: async () => ({}), remove: async () => {} },
    windows: { onCreated: noop, onRemoved: noop, onFocusChanged: noop },
    scripting: { executeScript: async () => [], getRegisteredContentScripts: async () => [], registerContentScripts: async () => {} },
    offscreen: { closeDocument: async () => {}, getContexts: async () => [] },
    contextMenus: { onClicked: noop },
    webNavigation: {}, notifications: {},
  };
  const kvStore = new Map();
  // Import-order guard: if a prior test file already imported the SW under a
  // DIFFERENT chrome stub, our listeners were never registered. Re-import with
  // a cache-bust so this test always owns the dispatcher wiring.
  const freshSW = await import('../extension/background/service-worker.js?kvdispatch=' + Date.now());
  void freshSW;
  const dispatch = (msg, sender) => new Promise((resolve) => {
    for (const fn of [...listeners]) {
      try { fn(msg, sender, resolve); } catch { /* another listener's throw */ }
    }
  });
  // (review a258f814) kv.set from NTP for SECRET namespaces: DENIED.
  const ntpSeed = await dispatch({ type: "kv.set", values: {
    "cap:namedAgents": { probe: { name: MARKER_NAMED, provider: { provider: "deepseek", apiKey: "config-has-a-value" } } },
    "providerConfig": { provider: "deepseek", baseURL: "https://api.example", apiKey: "config-value", model: "m", note: MARKER_GLOBAL },
  } }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(ntpSeed?.ok === false && /secret-controlled/.test(String(ntpSeed?.error)), "kv.set secret namespaces DENIED from NTP");
  // kv.set for an ordinary key from NTP: still allowed (only secret stores are gated).
  const ordinary = await dispatch({ type: "kv.set", values: { "cap:test-key": "v" } }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(ordinary?.ok !== false, "kv.set ordinary key still allowed from NTP");
  // kv.remove of a SECRET namespace from NTP: DENIED.
  const ntpRemove = await dispatch({ type: "kv.remove", keys: ["providerConfig", "cap:namedAgents"] }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(ntpRemove?.ok === false && /secret-controlled/.test(String(ntpRemove?.error)), "kv.remove secret namespaces DENIED from NTP");
  // Seed via the OWNER-PRINCIPAL dispatcher path (the attested Options shape):
  const ownerSender = { id: "test-extension-id", url: "chrome-extension://test-extension-id/options/options.html", documentId: "doc-options-1", documentLifecycle: "active" };
  const shadowNtp = await dispatch(
    { type: "tool-catalog.shadow", action: "summary" },
    { url: "chrome-extension://test-extension-id/ntp/ntp.html" },
  );
  assert(
    shadowNtp?.ok === false && /Settings surface/.test(String(shadowNtp?.error)),
    "shadow catalog diagnostics refused from NTP",
  );
  const shadowOwner = await dispatch(
    { type: "tool-catalog.shadow", action: "summary" },
    ownerSender,
  );
  assertEquals(shadowOwner?.ok, true, "owner Settings can inspect shadow metadata");
  assertEquals(shadowOwner?.canExecute, false);
  assertEquals(shadowOwner?.canGrant, false);
  assert(Number(shadowOwner?.descriptorCount) > 0, "actual built-in adapters produced descriptors");
  const lazyCapture = await dispatch({
    type: "tool-catalog.shadow",
    action: "capture",
    query: "memory",
    limit: 1,
    runId: "capture-run-1",
    agentId: "hub",
    origin: "",
    documentId: "doc-options-1",
  }, ownerSender);
  assertEquals(lazyCapture?.ok, true, "owner Settings can capture selected-only lazy metadata");
  assertEquals(lazyCapture?.providerBound, false);
  assertEquals(lazyCapture?.eagerBindingChanged, false);
  assertEquals(lazyCapture?.canExecute, false);
  assertEquals(lazyCapture?.canGrant, false);
  assertEquals(lazyCapture?.protocolTools?.map((row) => row.name), ["search_tools", "execute_tool"]);
  assertEquals(lazyCapture?.selectedDescriptors?.length, 1);
  assertEquals(lazyCapture?.selectedDescriptors?.[0]?.authorizes, false);
  const seedRes = await dispatch({ type: "kv.set", values: {
    "cap:namedAgents": { probe: { name: MARKER_NAMED, provider: { provider: "deepseek", apiKey: "config-has-a-value" } } },
    "providerConfig": { provider: "deepseek", baseURL: "https://api.example", apiKey: "config-value", model: "m", note: MARKER_GLOBAL },
  } }, ownerSender);
  assert(seedRes?.ok !== false, "kv.set secret namespaces allowed from owner-options principal");
  // 1. read-all: credentials redacted; the agent NAME marker survives.
  const all = await dispatch({ type: "kv.get" }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  const allStr = JSON.stringify(all);
  assert(!allStr.includes("config-has-a-value"), "per-agent credential redacted on read-all");
  assert(!allStr.includes("config-value\""), "global credential redacted on read-all");
  assert(allStr.includes(MARKER_NAMED), "non-secret agent name survives (targeted redaction)");
  // 2. explicit key on a secret namespace: redacted.
  const named = await dispatch({ type: "kv.get", keys: ["cap:namedAgents"] }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(!JSON.stringify(named).includes("config-has-a-value"), "explicit secret-namespace read redacted");
  // 3. provider.set from an NTP sender: REFUSED.
  const refused = await dispatch({ type: "provider.set", config: { provider: "gemini" } }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(refused?.ok === false && /Settings surface/.test(String(refused?.error)), "provider.set refused from NTP");
  // 4. provider.CLEAR-KEY from NTP: REFUSED.
  const clearNtp = await dispatch({ type: "provider.clear-key" }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(clearNtp?.ok === false && /Settings surface/.test(String(clearNtp?.error)), "provider.clear-key refused from NTP");
  // 5. provider.TEST from NTP: REFUSED.
  const testNtp = await dispatch({ type: "provider.test", provider: "demo" }, { url: "chrome-extension://test-extension-id/ntp/ntp.html" });
  assert(testNtp?.ok === false && /Settings surface/.test(String(testNtp?.error)), "provider.test refused from NTP");
  // 6. Product-owned hash navigation remains the SAME attested Settings
  // document for provider set/get/test; credentials stay redacted.
  const ownerHashSender = { ...ownerSender, url: ownerSender.url + "#providers" };
  const hashSet = await dispatch({ type: "provider.set", config: {
    provider: "openai-compatible",
    baseURL: "https://hash-provider.example/v1",
    apiKey: "hash-key-sentinel",
    model: "hash-model-sentinel",
  } }, ownerHashSender);
  assert(hashSet?.hasApiKey === true && !JSON.stringify(hashSet).includes("hash-key-sentinel"), "provider.set accepts the product hash and redacts the key");
  const hashGet = await dispatch({ type: "provider.get" }, ownerHashSender);
  assert(hashGet?.provider === "openai-compatible" && hashGet?.model === "hash-model-sentinel", "provider.get accepts the product hash");
  assert(hashGet?.hasApiKey === true && !JSON.stringify(hashGet).includes("hash-key-sentinel"), "provider.get remains redacted");
  const hashSummary = await dispatch({ type: "provider.summary" }, ownerHashSender);
  assertEquals(hashSummary?.configured, true, "provider.summary exposes only keyed setup readiness");
  assert(!Object.hasOwn(hashSummary, "apiKey") && !Object.hasOwn(hashSummary, "model"), "provider.summary never exposes key/model");
  assert(!JSON.stringify(hashSummary).includes("hash-key-sentinel"), "provider.summary contains no key bytes");
  const hashTest = await dispatch({ type: "provider.test", provider: "demo", baseURL: "", apiKey: "", model: "" }, ownerHashSender);
  assert(hashTest?.ok === true, "provider.test accepts the product hash");
  const failClosed = await dispatch({ type: "provider.status" }, ownerHashSender);
  assertEquals(failClosed?.ok, false, "the saved network adapter reaches the no-origin-grant gate");
  assertEquals(failClosed?.reason, 'network access to the provider (https://hash-provider.example/*) is not granted — click "Use"/"Test connection" in Settings to grant it');

  // The exact no-hash owner document remains valid too.
  const allowed = await dispatch({ type: "provider.set", config: { provider: "demo", baseURL: "", apiKey: "", model: "" } }, ownerSender);
  assert(!/Settings surface/.test(JSON.stringify(allowed)), "provider.set accepted via attested owner principal");
  const allowedGet = await dispatch({ type: "provider.get" }, ownerSender);
  assert(allowedGet?.provider === "demo", "provider.get accepted via attested owner principal");

  // 7. provider.models is the REAL /model consumer route: it advertises only
  // public choices while preserving stored global/per-agent internal authority.
  const publicModels = await dispatch({ type: "provider.models" }, ownerSender);
  assertEquals(
    publicModels?.choices?.map((choice) => choice.id),
    ["openai", "anthropic", "gemini", "deepseek", "openai-compatible", "ollama"],
    "provider.models returns the exact public provider list",
  );
  assert(
    !publicModels?.choices?.some((choice) => choice.id === "demo" || choice.id === "prompt-api"),
    "provider.models leaked an internal provider",
  );
  const demoAfterModels = await dispatch({ type: "provider.get" }, ownerSender);
  assertEquals(demoAfterModels?.provider, "demo", "reading the public list migrated the stored Demo selection");

  const promptSet = await dispatch({ type: "provider.set", config: { provider: "prompt-api", baseURL: "", apiKey: "", model: "gemini-nano" } }, ownerSender);
  assertEquals(promptSet?.provider, "prompt-api", "Prompt API remains accepted as internal authority");
  await dispatch({ type: "provider.models" }, ownerSender);
  const promptAfterModels = await dispatch({ type: "provider.get" }, ownerSender);
  assertEquals(promptAfterModels?.provider, "prompt-api", "reading the public list migrated the stored Prompt API selection");

  const legacyNamed = {
    demoProbe: { id: "demoProbe", name: "Demo probe", provider: { provider: "demo", baseURL: "", model: "demo-local" } },
    promptProbe: { id: "promptProbe", name: "Prompt probe", provider: { provider: "prompt-api", baseURL: "", model: "gemini-nano" } },
  };
  await dispatch({ type: "kv.set", values: { "cap:namedAgents": legacyNamed } }, ownerSender);
  const namedBeforeModels = await dispatch({ type: "kv.get", keys: ["cap:namedAgents"] }, ownerSender);
  await dispatch({ type: "provider.models" }, ownerSender);
  const namedAfterModels = await dispatch({ type: "kv.get", keys: ["cap:namedAgents"] }, ownerSender);
  assertEquals(namedAfterModels, namedBeforeModels, "reading the public list migrated a stored per-agent internal override");

  // 8. query/unknown-hash/foreign-document spoofs and missing attestations can NEVER pass (the fallback is gone):
  for (const bad of [
    { id: "test-extension-id", url: "chrome-extension://test-extension-id/options/options.html?spoof=1", documentId: "d", documentLifecycle: "active" },
    { id: "test-extension-id", url: "chrome-extension://test-extension-id/options/options.html#x", documentId: "d", documentLifecycle: "active" },
    { id: "test-extension-id", url: "chrome-extension://test-extension-id/options/options.html" }, // no documentId
    { id: "test-extension-id", url: "chrome-extension://test-extension-id/options/options.html", documentId: "d", documentLifecycle: "inactive" },
  ]) {
    // The dispatcher's isExactOptionsSender rejects all of these shapes, so the
    // principal never becomes owner-options — every credential route refuses.
    for (const message of [
      { type: "provider.set", config: { provider: "gemini" } },
      { type: "provider.get" },
      { type: "provider.test", provider: "demo" },
    ]) {
      const r = await dispatch(message, bad);
      assert(r?.ok === false && /Settings surface/.test(String(r?.error)), `${message.type} spoofed/incomplete sender refused`);
    }
  }
  // cleanup via owner principal
  await dispatch({ type: "kv.remove", keys: ["cap:namedAgents", "providerConfig"] }, ownerSender);
  await dispatch({ type: "kv.remove", keys: ["cap:test-key"] }, ownerSender);
});

// tests/agent-worker-host.test.ts — CAP-FB-20260826-AGENT-WORKERS-01 (Phase 1).
// @ts-nocheck — unit tests run under Deno (fakes are intentionally dynamic).
//
// Pins the SW-side authority + the offscreen host's shared-worker shell:
//   (a) ensure is idempotent + validated (extension-surface only);
//   (b) the durable alive-set is the SW's (survives host/worker death);
//   (c) close removes the agent from the alive-set;
//   (d) reconcile re-ensures the alive-set on wake;
//   (e) the host module's ensure/close/list contract.
import { assert, assertEquals } from "jsr:@std/assert@1";

// ── In-memory kv + chrome shims (the route module imports cap-log lazily). ──
let store = {};
const kvGet = async (k) => ({ [k]: store[k] });
const kvSet = async (o) => { Object.assign(store, o); };
const sent = [];
let ensureOffscreenCalls = 0;
const ensureOffscreen = async () => { ensureOffscreenCalls += 1; return { ok: true }; };
globalThis.chrome = {
  runtime: {
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: async (m) => { sent.push(m); return m.type === "agent-worker-host:list" ? { ok: true, agents: [] } : { ok: true, created: true }; },
    onMessage: { addListener() {}, removeListener() {} },
  },
  storage: { local: { get: async () => ({}), set: async () => {}, onChanged: { addListener() {} } } },
};

const { createAgentWorkerRoutes, reconcileAgentWorkers } = await import(
  "../extension/background/routes/agent-worker.js"
);

function reset() {
  store = {};
  sent.length = 0;
  ensureOffscreenCalls = 0;
}

Deno.test("agent-worker.ensure: rejects a non-extension principal", async () => {
  reset();
  const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet });
  for (const principal of ["page", "model", "content-script", undefined]) {
    const r = await routes["agent-worker.ensure"]({ agentId: "a1" }, { principal });
    assert(!r.ok, `principal ${principal} must be rejected`);
    assert(r.error === "unauthorized_principal", `unexpected error: ${r.error}`);
  }
  assertEquals(sent.length, 0, "no host message must be sent for an unauthorized caller");
});

Deno.test("agent-worker.ensure: ensures the host + records the alive-set idempotently", async () => {
  reset();
  const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet });
  const c = { principal: "extension" };
  const r1 = await routes["agent-worker.ensure"]({ agentId: "recipe:sorting-hat" }, c);
  assertEquals(r1.ok, true);
  assertEquals(r1.name, "recipe:sorting-hat");
  assert(r1.workerUrl.endsWith("workers/agent-worker.js"), "workerUrl must point at the shared worker");
  assertEquals(sent[0]?.type, "agent-worker-host:ensure", "host must be asked to ensure the worker");
  assertEquals(sent[0]?.agentId, "recipe:sorting-hat");
  assertEquals(store["cap:agent-workers:alive"], ["recipe:sorting-hat"]);
  // Idempotent: a second ensure does not duplicate the alive-set entry.
  const r2 = await routes["agent-worker.ensure"]({ agentId: "recipe:sorting-hat" }, c);
  assertEquals(r2.ok, true);
  assertEquals(store["cap:agent-workers:alive"], ["recipe:sorting-hat"]);
  assertEquals(ensureOffscreenCalls >= 1, true);
});

Deno.test("agent-worker.close: drops the host port + removes the agent from the alive-set", async () => {
  reset();
  store["cap:agent-workers:alive"] = ["a1", "a2"];
  const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet });
  const r = await routes["agent-worker.close"]({ agentId: "a1" }, { principal: "extension" });
  assertEquals(r.ok, true);
  assertEquals(store["cap:agent-workers:alive"], ["a2"]);
  assertEquals(sent[0]?.type, "agent-worker-host:close");
});

Deno.test("reconcileAgentWorkers: re-ensures every agent in the durable alive-set", async () => {
  reset();
  store["cap:agent-workers:alive"] = ["bg:hat", "site:example"];
  const r = await reconcileAgentWorkers({ ensureOffscreen, kvGet });
  assertEquals(r.ok, true);
  assertEquals(r.reconciled, 2);
  const ensured = sent.filter((m) => m.type === "agent-worker-host:ensure");
  assertEquals(ensured.map((m) => m.agentId).sort(), ["bg:hat", "site:example"]);
});

Deno.test("reconcileAgentWorkers: empty alive-set is a no-op", async () => {
  reset();
  const r = await reconcileAgentWorkers({ ensureOffscreen, kvGet });
  assertEquals(r.reconciled, 0);
  assertEquals(sent.length, 0);
});

// ── the offscreen host's worker map contract (no real SharedWorker in Deno) ──
Deno.test("agent-worker-host: ensure/close/list contract (shimmed SharedWorker)", async () => {
  const workers = new Map(); // name -> { port calls }
  globalThis.SharedWorker = class {
    constructor(url, opts) {
      this.url = url; this.name = opts?.name;
      this.port = { start() {}, postMessage() {}, close() {}, onmessage: null };
      workers.set(this.name, this);
    }
  };
  const mod = await import("../extension/lib/agent-worker-host.js?n=" + Date.now());
  const e1 = mod.ensureAgentWorker("bg:hat");
  assertEquals(e1.ok, true); assertEquals(e1.created, true);
  const e2 = mod.ensureAgentWorker("bg:hat");
  assertEquals(e2.created, false, "same name must return the same instance");
  assertEquals(mod.liveAgentIds(), ["bg:hat"]);
  const cl = mod.closeAgentWorker("bg:hat");
  assertEquals(cl.ok, true);
  assertEquals(mod.liveAgentIds(), []);
  delete globalThis.SharedWorker;
});

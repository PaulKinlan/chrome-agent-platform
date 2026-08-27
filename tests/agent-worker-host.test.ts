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

Deno.test("P2 agent-worker.run + agent-worker.tool: validate principal + authority split", async () => {
  reset();
  let executed = [];
  const routes = createAgentWorkerRoutes({
    ensureOffscreen,
    kvGet,
    kvSet,
    executeTool: async (name, args, context) => { executed.push({ name, args, context }); return { ok: true, result: `ran ${name}` }; },
  });
  const c = { principal: "extension" };

  // run kick: posts a run descriptor through the host (stubbed sendMessage).
  const run = await routes["agent-worker.run"]({ agentId: "bg:hat", runId: "r1", task: "@demo-tools" }, c);
  assertEquals(run.ok, true);
  assertEquals(run.runId, "r1");
  assert(sent.some((m) => m.type === "agent-worker-host:post" && m.msg?.type === "agent-worker:run"), "run descriptor must be posted to the host");

  // tool bridge: the SW executes through the injected executor (authority).
  const tool = await routes["agent-worker.tool"]({ toolName: "memory_set", args: { k: "v" } }, c);
  assertEquals(tool.ok, true);
  assertEquals(executed[0]?.name, "memory_set");
  // The route must pass the CALLER CONTEXT through to the executor (the SW's
  // executeWorkerTool uses it to bind management-tool dispatch to the right
  // principal) — this is the P2 tool-wiring seam.
  assertEquals(executed[0]?.context, c);

  // unauthorized principal: both routes refuse before any host/executor work.
  executed = [];
  for (const principal of ["model", "page", undefined]) {
    const r1 = await routes["agent-worker.run"]({ agentId: "a", runId: "x" }, { principal });
    assertEquals(r1.error, "unauthorized_principal");
    const r2 = await routes["agent-worker.tool"]({ toolName: "memory_set" }, { principal });
    assertEquals(r2.error, "unauthorized_principal");
  }
  assertEquals(executed.length, 0, "no tool may execute for an unauthorized caller");
});

Deno.test("P2 agent-worker.tool: empty toolName refused before the executor; a throwing executor is a bounded error", async () => {
  reset();
  let called = 0;
  const routes = createAgentWorkerRoutes({
    ensureOffscreen, kvGet, kvSet,
    executeTool: async () => { called += 1; throw new Error("boom " + "x".repeat(300)); },
  });
  const c = { principal: "extension" };
  // empty toolName → invalid, executor never called
  const empty = await routes["agent-worker.tool"]({ toolName: "" }, c);
  assertEquals(empty.error, "invalid toolName");
  assertEquals(called, 0);
  // a throwing executor surfaces a bounded error (never a raw long throw)
  const boom = await routes["agent-worker.tool"]({ toolName: "memory_set" }, c);
  assertEquals(boom.ok, false);
  assert(boom.error.length <= 200, "executor error must be bounded");
});

Deno.test("P2 agent-worker.tool: honest error when the executor is not wired", async () => {
  reset();
  const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet });
  const r = await routes["agent-worker.tool"]({ toolName: "memory_set" }, { principal: "extension" });
  assertEquals(r.ok, false);
  assertEquals(r.error, "tool execution not wired in this context");
});

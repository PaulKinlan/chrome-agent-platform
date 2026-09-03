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

// ── review r6 falsification gates (gpt-5.6-sol:high, r5) ─────────────────────
// Each fails on the r5 tree:
//  r6 P1-1: agent-worker.run/dispatch registered the live run AFTER the host
//    post — a worker that completes + relays agent-worker.result while the
//    route still awaits the host response unregistered nothing and left a
//    COMPLETED run live forever; register() failure was silently accepted.
//  r6 P1-2: agent-worker.steer returned ok:true on a bare host "posted" — a
//    steer_buffer_full refusal reached only the worker port and the owner was
//    told the agent saw the steer.
import { createRunControl } from "../extension/lib/run-control.js";

function kvPair() {
  const mem = {};
  return { kvGet: async () => mem, kvSet: async (o) => Object.assign(mem, o) };
}

const R6_RUN_ID = "exec:r6-1111-2222-4333-8444-555555555555";

Deno.test("r6 P1-1 agent-worker.run: REFUSES when the live-run registry cannot register (no run is posted)", async () => {
  reset();
  // A full/duplicate register returns null — the route must refuse the kick,
  // never accept an unsteerable run. ensure is allowed; the run POST must
  // never happen.
  const posts = [];
  const chromeStub = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "agent-worker-host:ensure") return { ok: true, created: true };
        if (m.type === "agent-worker-host:post") posts.push(m);
        return { ok: true };
      },
    },
  };
  const prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  try {
    const routes = createAgentWorkerRoutes({
      ensureOffscreen, kvGet, kvSet,
      runControl: { register: () => null, unregister: () => {}, get: () => null },
    });
    const r = await routes["agent-worker.run"]({ agentId: "bg:hat", runId: R6_RUN_ID, task: "x" }, { principal: "extension" });
    assertEquals(r.ok, false, "a refused registration must refuse the worker run");
    assertEquals(r.code, "run_control_full");
    assertEquals(posts.length, 0, "no run descriptor may be posted when registration was refused");
  } finally {
    globalThis.chrome = prev;
  }
});

Deno.test("r6 P1-1 agent-worker.run: registers BEFORE the host post, and a failed post releases the record", async () => {
  reset();
  const ctl = createRunControl();
  let sawLiveDuringPost = null;
  const chromeStub = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "agent-worker-host:ensure") return { ok: true, created: true };
        if (m.type === "agent-worker-host:post") {
          // The host answers AFTER the worker is already live in the control
          // plane: register-before-post means the record exists HERE.
          sawLiveDuringPost = ctl.get(m.msg.runId) ?? null;
          return { ok: false, error: "no such agent worker" }; // the post FAILS
        }
        return { ok: true };
      },
    },
  };
  const prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  try {
    const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
    const r = await routes["agent-worker.run"]({ agentId: "bg:hat", runId: R6_RUN_ID, task: "x" }, { principal: "extension" });
    assertEquals(r.ok, false, "a failed host post must fail the run route");
    assertEquals(sawLiveDuringPost?.executionId, R6_RUN_ID, "the run must be registered BEFORE the descriptor is posted");
    assertEquals(ctl.get(R6_RUN_ID), null, "a failed post must release the live record — no phantom steerable run");
  } finally {
    globalThis.chrome = prev;
  }
});

Deno.test("r6 P1-2 agent-worker.steer: reports the WORKER's refusal, not a bare host posted", async () => {
  reset();
  const ctl = createRunControl();
  assert(ctl.register({ executionId: R6_RUN_ID, surface: "agent-worker:bg:hat", kind: "worker" }), "seed the live run");
  const chromeStub = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "agent-worker-host:ensure") return { ok: true, created: true };
        if (m.type === "agent-worker-host:post") {
          // The host relays the worker's honest steer-refused (buffer full).
          assertEquals(m.expectReply.keyField, "steerId", "steer posts must ask for the worker's own reply");
          return { ok: true, posted: true, relayed: { type: "agent-worker:steer-refused", runId: R6_RUN_ID, steerId: m.msg.steerId, error: "steer_buffer_full" } };
        }
        return { ok: true };
      },
    },
  };
  const prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  try {
    const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
    const r = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode: "inject", text: "nudge" }, { principal: "extension" });
    assertEquals(r.ok, false, "a worker steer_buffer_full refusal must reach the caller as ok:false");
    assertEquals(r.code, "steer_buffer_full");
    assert(r.steerId, "the refusal must carry the correlation id");
  } finally {
    globalThis.chrome = prev;
  }
});

Deno.test("r6 P1-2 agent-worker.steer: reports the worker's steered ack, host post failures, and unconfirmed timeouts honestly", async () => {
  reset();
  const ctl = createRunControl();
  assert(ctl.register({ executionId: R6_RUN_ID, surface: "agent-worker:bg:hat", kind: "worker" }), "seed the live run");

  // (a) the worker accepted → steered:true with the correlation id.
  let mode = "inject";
  let hostReply = { ok: true, posted: true, relayed: { type: "agent-worker:steered", runId: R6_RUN_ID, steerId: "s-1", mode } };
  let chromeStub = {
    runtime: { sendMessage: async (m) => (m.type === "agent-worker-host:post" ? hostReply : { ok: true }) },
  };
  let prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  let routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
  try {
    const ok = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode, text: "nudge", steerId: "s-1" }, { principal: "extension" });
    assertEquals(ok.ok, true);
    assertEquals(ok.steered, true);
    assertEquals(ok.steerId, "s-1", "the caller's steer id must ride the confirmation");
  } finally { globalThis.chrome = prev; }

  // (b) the host itself refused the post (no such worker) → honest error.
  hostReply = { ok: false, error: "no such agent worker" };
  prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
  try {
    const fail = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode, text: "nudge" }, { principal: "extension" });
    assertEquals(fail.ok, false, "a failed host post must never be reported as steered");
    assert(fail.code === "steer_unconfirmed" || fail.error, "the route must surface the post failure");
  } finally { globalThis.chrome = prev; }

  // (c) the worker never answered (host timeout) → unconfirmed, never "steered".
  hostReply = { ok: false, posted: true, error: "worker_reply_timeout" };
  prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
  try {
    const timeout = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode, text: "nudge" }, { principal: "extension" });
    assertEquals(timeout.ok, false, "an unanswered steer must be reported unconfirmed");
    assertEquals(timeout.code, "steer_unconfirmed");
  } finally { globalThis.chrome = prev; }

  // (d) stop-run: the worker's aborted ack confirms the stop; a silent worker does not.
  hostReply = { ok: true, posted: true, relayed: { type: "agent-worker:aborted", runId: R6_RUN_ID, agentId: "bg:hat" } };
  prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
  try {
    const stopped = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode: "stop-run" }, { principal: "extension" });
    assertEquals(stopped.ok, true);
    assertEquals(stopped.stopped, true);
  } finally { globalThis.chrome = prev; }

  hostReply = { ok: false, posted: true, error: "worker_reply_timeout" };
  prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
  try {
    const unstopped = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode: "stop-run" }, { principal: "extension" });
    assertEquals(unstopped.ok, false, "an unconfirmed stop must not be reported stopped");
    assertEquals(unstopped.code, "stop_unconfirmed");
  } finally { globalThis.chrome = prev; }

  // (e) stop-run (r7 P1-1): the worker REFUSED the abort (no live run / a
  // different run is live) — the refusal must reach the caller as ok:false,
  // never the fabricated aborted ack the r6 route test handed back.
  hostReply = { ok: true, posted: true, relayed: { type: "agent-worker:abort-refused", runId: R6_RUN_ID, agentId: "bg:hat", error: "run_not_live" } };
  prev = globalThis.chrome;
  globalThis.chrome = chromeStub;
  routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });
  try {
    const refused = await routes["agent-worker.steer"]({ runId: R6_RUN_ID, mode: "stop-run" }, { principal: "extension" });
    assertEquals(refused.ok, false, "a worker abort-refusal must reach the caller as ok:false — never stopped:true");
    assertEquals(refused.code, "run_not_live");
  } finally { globalThis.chrome = prev; }
});

Deno.test("agent-worker-host (host): posts with expectReply resolve with the WORKER's relayed reply", async () => {
  const workers = new Map();
  globalThis.SharedWorker = class {
    constructor(url, opts) {
      this.url = url;
      this.name = opts?.name;
      this.port = { start() {}, postMessage() {}, close() {}, onmessage: null };
      workers.set(this.name, this);
    }
  };
  const mod = await import("../extension/lib/agent-worker-host.js?r6-host=" + Date.now());
  try {
    mod.ensureAgentWorker("bg:relay");
    const worker = workers.get("bg:relay");
    assertEquals(typeof worker.port.onmessage, "function", "the host must listen on its keep-alive port for worker replies");

    // A steer post that awaits the worker's decision: the promise stays open
    // until the worker's reply arrives on the host port.
    let resolved = null;
    const pending = mod.postAgentWorkerMessage("bg:relay", { type: "agent-worker:steer", runId: "r1", steerId: "s-42", mode: "inject", text: "hi" }, {
      expectReply: { types: ["agent-worker:steered", "agent-worker:steer-refused"], keyField: "steerId", timeoutMs: 2000 },
    });
    pending.then((v) => { resolved = v; });
    assertEquals(resolved, null, "the post must not resolve on a bare postMessage");
    // (worker side) the reply comes back over the host's own port.
    worker.port.onmessage({ data: { type: "agent-worker:steered", runId: "r1", agentId: "bg:relay", steerId: "s-42", mode: "inject" } });
    const out = await pending;
    assertEquals(out.ok, true);
    assertEquals(out.posted, true);
    assertEquals(out.relayed.type, "agent-worker:steered");
    assertEquals(out.relayed.steerId, "s-42", "the relay must carry the keyed steer id");

    // A REFUSED reply relays the refusal the same way (never a silent ok).
    const pending2 = mod.postAgentWorkerMessage("bg:relay", { type: "agent-worker:steer", runId: "r1", steerId: "s-43", mode: "inject", text: "more" }, {
      expectReply: { types: ["agent-worker:steered", "agent-worker:steer-refused"], keyField: "steerId", timeoutMs: 2000 },
    });
    worker.port.onmessage({ data: { type: "agent-worker:steer-refused", runId: "r1", steerId: "s-43", error: "steer_buffer_full" } });
    const refused = await pending2;
    assertEquals(refused.relayed.type, "agent-worker:steer-refused");
    assertEquals(refused.relayed.error, "steer_buffer_full");

    // A reply for a DIFFERENT key does not satisfy the waiter.
    const pending3 = mod.postAgentWorkerMessage("bg:relay", { type: "agent-worker:steer", runId: "r1", steerId: "s-44", mode: "inject", text: "third" }, {
      expectReply: { types: ["agent-worker:steered", "agent-worker:steer-refused"], keyField: "steerId", timeoutMs: 2000 },
    });
    worker.port.onmessage({ data: { type: "agent-worker:steered", runId: "r1", steerId: "s-OTHER", mode: "inject" } });
    worker.port.onmessage({ data: { type: "agent-worker:steered", runId: "r1", steerId: "s-44", mode: "inject" } });
    const matched = await pending3;
    assertEquals(matched.relayed.steerId, "s-44", "only the keyed reply may resolve the waiter");

    // Unknown agent: refused before anything is posted.
    const ghost = await mod.postAgentWorkerMessage("bg:ghost", { type: "agent-worker:steer", runId: "r1", steerId: "s-45" }, {
      expectReply: { types: ["agent-worker:steered"], keyField: "steerId", timeoutMs: 2000 },
    });
    assertEquals(ghost.ok, false);
    assertEquals(ghost.error, "no such agent worker");
  } finally {
    delete globalThis.SharedWorker;
  }
});

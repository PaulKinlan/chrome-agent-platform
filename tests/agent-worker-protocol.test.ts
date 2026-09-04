// tests/agent-worker-protocol.test.ts — chrome-agent-platform-afiu, review r5
// P1-1. Drives the ACTUAL worker message protocol (extension/workers/
// agent-worker.js — the file is evaluated as a module under a faked
// self/BroadcastChannel/chrome, so the REAL connect handler, handleRun, steer
// handling and terminal relay run — not a re-implementation of the loop).
//
// Falsification gates (each fails on the r4 tree):
//  1. a run round-trip completes AND relays its terminal to the SW
//     (agent-worker.result → the SW route's runControl.unregister). On r4 the
//     worker touched the undeclared steerBuffer before its try: handleRun
//     rejected on EVERY run — no run-done ever arrived and no terminal was
//     ever relayed (worker runs stayed steerable + consumed a live-registry
//     seat forever);
//  2. a steer naming a run this worker is NOT running is REFUSED with a
//     structured reply (on r4 the steer case called the undeclared
//     pushSteer — a TypeError instead of an honest refusal);
//  3. a steer for the ACTIVE run is accepted (bounded buffer) and the run
//     still completes.
// @ts-nocheck — the worker shell + fakes are deliberately dynamic.
import { assert, assertEquals } from "jsr:@std/assert@1";

const RUN_ID = "exec:11111111-2222-4333-8444-555555555555";
const OTHER_RUN_ID = "exec:99999999-8888-4777-8666-555555555555";

function fakePort() {
  const sent = [];
  const port = {
    sent,
    onmessage: null,
    onmessageerror: null,
    start() {},
    postMessage(m) { sent.push(m); },
    close() {},
    emit(msg) { if (typeof this.onmessage === "function") this.onmessage({ data: msg }); },
  };
  return port;
}

let loadSeq = 0;
/** Evaluate a FRESH instance of the worker module under fakes. Returns the
 * captured connect handler, the fake port factory, and the SW-bound message
 * log (chrome.runtime.sendMessage). */
async function loadWorker() {
  loadSeq += 1;
  const connectHandlers = [];
  const fakeSelf = {
    name: "agent-protocol",
    addEventListener(type, fn) { if (type === "connect") connectHandlers.push(fn); },
    close() {},
  };
  // Deno's main-scope `self` is a read-only facade: replace it outright so
  // the worker module's top-level `self.addEventListener("connect", …)`
  // binds OUR handler (assignment alone is swallowed).
  Object.defineProperty(globalThis, "self", { value: fakeSelf, configurable: true, writable: true });
  const swMessages = [];
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => { swMessages.push(m); return { ok: true }; },
    },
  };
  await import(`../extension/workers/agent-worker.js?protocol=${loadSeq}-${Date.now()}`);
  assertEquals(connectHandlers.length, 1, "the worker must register its connect handler");
  return { connect: connectHandlers[0], swMessages };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, { timeoutMs = 10_000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = fn();
    if (hit) return hit;
    await wait(stepMs);
  }
  return null;
}

const find = (list, type) => list.find((m) => m?.type === type) ?? null;

Deno.test("worker protocol: a run round-trips AND relays its terminal to the SW (agent-worker.result)", async () => {
  const { connect, swMessages } = await loadWorker();
  const port = fakePort();
  connect({ ports: [port] });

  port.emit({ type: "agent-worker:run", runId: RUN_ID, task: "say hello", modelKind: "demo", maxIterations: 2 });
  const started = await until(() => find(port.sent, "agent-worker:run-started"));
  assert(started, "the SW must receive the run-started acknowledgement");

  const done = await until(() => find(port.sent, "agent-worker:run-done"));
  assert(done, "the run must actually complete (r4: undeclared steerBuffer rejected every run)");
  assertEquals(done.ok, true);

  const relay = await until(() => find(swMessages, "agent-worker.result"));
  assert(relay, "the terminal must be relayed to the SW so agent-worker.result unregisters the live run");
  assertEquals(relay.executionId, RUN_ID);
  assertEquals(relay.ok, true);
  assertEquals(relay.agentId, "agent-protocol");

  // The port also saw the terminal on the conversation channel (run-done), and
  // no further relay/spurious run events follow.
  await wait(30);
  const relays = swMessages.filter((m) => m?.type === "agent-worker.result");
  assertEquals(relays.length, 1, "exactly one terminal relay per run");
});

Deno.test("worker protocol: a steer naming a run this worker is NOT running is REFUSED honestly", async () => {
  const { connect } = await loadWorker();
  const port = fakePort();
  connect({ ports: [port] });

  // No run is live at all.
  port.emit({ type: "agent-worker:steer", runId: RUN_ID, mode: "inject", text: "nudge" });
  const refused = await until(() => find(port.sent, "agent-worker:steer-refused"));
  assert(refused, "a stale steer must be refused (r4: the undeclared pushSteer threw instead)");
  assertEquals(refused.error, "run_not_live");
  assert(!find(port.sent, "agent-worker:steered"), "a stale steer must never be acknowledged as steered");

  // A steer for a DIFFERENT run while another run is active is also refused.
  port.emit({ type: "agent-worker:run", runId: RUN_ID, task: "say hello", modelKind: "demo", maxIterations: 2 });
  assert(await until(() => find(port.sent, "agent-worker:run-started")), "run must start");
  port.emit({ type: "agent-worker:steer", runId: OTHER_RUN_ID, mode: "inject", text: "not for this run" });
  const refused2 = await until(() => [...port.sent].reverse().find((m) => m?.type === "agent-worker:steer-refused" && m?.runId === OTHER_RUN_ID));
  assert(refused2, "a steer naming the wrong runId must be refused while another run is live");
  assertEquals(refused2.runId, OTHER_RUN_ID);
  assertEquals(refused2.error, "run_not_live");
  // Let the active run finish cleanly.
  const done = await until(() => find(port.sent, "agent-worker:run-done"));
  assert(done, "the refused steer must not disturb the active run");
});

Deno.test("worker protocol: a steer for the ACTIVE run is accepted and the run still completes", async () => {
  const { connect } = await loadWorker();
  const port = fakePort();
  connect({ ports: [port] });

  port.emit({ type: "agent-worker:run", runId: RUN_ID, task: "say hello", modelKind: "demo", maxIterations: 2 });
  assert(await until(() => find(port.sent, "agent-worker:run-started")), "run must start");
  // Same synchronous turn: the run is live, so the steer is accepted.
  port.emit({ type: "agent-worker:steer", runId: RUN_ID, mode: "inject", text: "be brief", steerId: "st-1" });
  const steered = await until(() => find(port.sent, "agent-worker:steered"));
  assert(steered, "a steer for the active run must be acknowledged");
  assertEquals(steered.mode, "inject");
  assert(!find(port.sent, "agent-worker:steer-refused"), "the active-run steer must not be refused");
  const done = await until(() => find(port.sent, "agent-worker:run-done"));
  assert(done, "the steered run must still complete");
  assertEquals(done.ok, true);
});

// ── review r6 P1-1 (gpt-5.6-sol:high, r5): the worker-run REGISTER race ─────
// On the r5 tree agent-worker.run registered the live run AFTER the host post
// resolved. The worker runs in another realm: it can complete and relay
// agent-worker.result while the route still awaits the host-post response —
// that result unregisters nothing, and the route then registers a COMPLETED
// run forever (steerable, 64-slot seat consumed). This test drives the REAL
// worker module + the REAL route + a REAL runControl over a fake host whose
// post response is held open until the worker's terminal relay has been
// processed by the SW — the exact race — and asserts no live record remains.
import { createRunControl } from "../extension/lib/run-control.js";
import { createAgentWorkerRoutes } from "../extension/background/routes/agent-worker.js";

Deno.test("r6 P1-1: a worker that completes before the host-post response leaves NO live run record", async () => {
  const runId = RUN_ID;
  const ctl = createRunControl();
  const mem = {};
  const kvGet = async () => mem;
  const kvSet = async (o) => Object.assign(mem, o);
  const ensureOffscreen = async () => ({ ok: true });
  const routes = createAgentWorkerRoutes({ ensureOffscreen, kvGet, kvSet, runControl: ctl });

  // Load a FRESH worker instance whose chrome.runtime.sendMessage routes
  // through the fake host + SW dispatch below.
  const connectHandlers = [];
  const fakeSelf = {
    name: "race-agent",
    addEventListener(type, fn) { if (type === "connect") connectHandlers.push(fn); },
    close() {},
  };
  Object.defineProperty(globalThis, "self", { value: fakeSelf, configurable: true, writable: true });
  const relays = [];
  const port = fakePort();
  const originalSend = globalThis.chrome?.runtime?.sendMessage;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (m) => {
        if (m.type === "agent-worker-host:ensure") return { ok: true, created: true };
        if (m.type === "agent-worker-host:post") {
          // The HOST hands the descriptor to the worker…
          port.emit(m.msg);
          // …and holds its post response open until the worker's terminal
          // relay has reached (and been processed by) the SW — forcing the
          // result to land BEFORE the awaiting run route resumes.
          const relayed = await until(() => relays.length > 0);
          if (!relayed) throw new Error("worker never relayed its terminal");
          return { ok: true, posted: true };
        }
        if (m.type === "agent-worker.result") {
          relays.push(m);
          return routes["agent-worker.result"](m, { principal: "extension" });
        }
        return { ok: true };
      },
    },
  };
  loadSeq += 1;
  await import(`../extension/workers/agent-worker.js?race=${loadSeq}-${Date.now()}`);
  assertEquals(connectHandlers.length, 1, "the worker must register its connect handler");
  connectHandlers[0]({ ports: [port] });

  try {
    const kicked = await routes["agent-worker.run"](
      { agentId: "race-agent", runId, task: "say hello", modelKind: "demo", maxIterations: 2 },
      { principal: "extension" },
    );
    assertEquals(kicked.ok, true, "the run must be accepted");
    assertEquals(relays.length, 1, "the race must actually occur: the worker's result arrived before the host-post response");
    assertEquals(relays[0].executionId, runId);
    // The early result released the live record — a completed run must never
    // stay registered (r5: register-after-post left it forever).
    assertEquals(ctl.get(runId), null, "no COMPLETED run may remain in the live run-control plane");
    assert(!find(port.sent, "agent-worker:steered"), "nothing may remain steerable");
  } finally {
    if (originalSend) globalThis.chrome = { runtime: { sendMessage: originalSend } };
    else delete globalThis.chrome;
  }
});

Deno.test("r6 P1-2: the worker's steer replies carry the correlation id (steered AND refused)", async () => {
  const { connect } = await loadWorker();
  const port = fakePort();
  connect({ ports: [port] });

  port.emit({ type: "agent-worker:run", runId: RUN_ID, task: "say hello", modelKind: "demo", maxIterations: 2 });
  assert(await until(() => find(port.sent, "agent-worker:run-started")), "run must start");

  // Accepted steer: the reply echoes steerId so the host can relay THIS reply
  // to the SW request that posted it.
  port.emit({ type: "agent-worker:steer", runId: RUN_ID, mode: "inject", text: "be brief", steerId: "st-9" });
  const steered = await until(() => find(port.sent, "agent-worker:steered"));
  assert(steered, "the active-run steer must be acknowledged");
  assertEquals(steered.steerId, "st-9", "the accepted reply must echo the steer id");

  // Refused steer (wrong run): the refusal also echoes steerId + the reason.
  port.emit({ type: "agent-worker:steer", runId: "exec:99999999-8888-4777-8666-555555555555", mode: "inject", text: "late", steerId: "st-10" });
  const refused = await until(() => [...port.sent].reverse().find((m) => m?.type === "agent-worker:steer-refused"));
  assert(refused, "the stale steer must be refused");
  assertEquals(refused.steerId, "st-10", "the refusal must echo the steer id");
  assertEquals(refused.error, "run_not_live");

  // Let the run finish cleanly.
  const done = await until(() => find(port.sent, "agent-worker:run-done"));
  assert(done, "the refused steer must not disturb the active run");
});

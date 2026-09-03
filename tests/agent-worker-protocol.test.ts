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

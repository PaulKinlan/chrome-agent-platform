// @ts-nocheck
// Phase 4 KATs: the agent-worker.tool bridge (CAP-FB-20260826-BROWSER-SINGLE-DRIVER-01,
// revised by CAP-FB-20260830-BROWSER-LEASE-DEADLOCK-01: the single-driver
// browser-command lease was removed — the bridge is a principal-gated pass-
// through to the SW's real tool executor, which applies the grant lock and the
// run fence itself).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgentWorkerRoutes } from "../extension/background/routes/agent-worker.js";

function makeKv() {
  const store = new Map();
  const kvGet = async (k) => (store.has(k) ? { [k]: store.get(k) } : {});
  const kvSet = async (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) store.delete(k);
      else store.set(k, v);
    }
  };
  return { store, kvGet, kvSet };
}

Deno.test("agent-worker.tool: destructive and read-only tools both reach the executor without a lease", async () => {
  const { store, kvGet, kvSet } = makeKv();
  const calls = [];
  const runControl = { get: (id) => id === "exec:worker-live" ? { kind: "worker", surface: "agent-worker:instance-a" } : null };
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet,
    kvSet,
    runControl,
    executeTool: (name, args) => { calls.push(name); return { ok: true, name }; },
  });
  const ctx = { principal: "extension" };
  const envelope = { runId: "exec:worker-live", agentId: "instance-a" };

  const d = await routes["agent-worker.tool"]({ ...envelope, toolName: "open_tab", args: {} }, ctx);
  assertEquals(d.ok, true, "destructive tool executes (the grant + fence gate lives in the executor)");
  const r = await routes["agent-worker.tool"]({ ...envelope, toolName: "list_tabs", args: {} }, ctx);
  assertEquals(r.ok, true, "read-only tool executes");
  assertEquals(calls, ["open_tab", "list_tabs"]);
  assertEquals(store.has("cap:browser-command-lease"), false, "the bridge never writes a lease");
});

Deno.test("agent-worker.tool: missing run-control authority always fails closed", async () => {
  const { kvGet, kvSet } = makeKv();
  let called = false;
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }), kvGet, kvSet,
    executeTool: () => { called = true; return { ok: true }; },
  });
  assertEquals(await routes["agent-worker.tool"]({ runId: "exec:live", agentId: "instance-a", toolName: "list_tabs" }, { principal: "extension" }), { ok: false, error: "run_not_live" });
  assertEquals(called, false);
});

Deno.test("agent-worker.tool: production run-control binds immutable model run and agent identity", async () => {
  const { kvGet, kvSet } = makeKv();
  const calls = [];
  const runControl = {
    get: (id) => id === "exec:live" ? { kind: "worker", surface: "agent-worker:instance-a" } : null,
  };
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }), kvGet, kvSet, runControl,
    resolveAgentIdentity: async (id) => id === "friendly-a" ? "instance-a" : id,
    executeTool: (_name, _args, context) => { calls.push(context); return { ok: true }; },
  });
  const ctx = { principal: "extension", documentId: "trusted-worker-host" };

  const ok = await routes["agent-worker.tool"]({ runId: "exec:live", agentId: "friendly-a", toolName: "list_tabs", args: {} }, ctx);
  assertEquals(ok.ok, true);
  assertEquals(calls, [{
    principal: "model",
    documentId: "trusted-worker-host",
    executionId: "exec:live",
    runId: "exec:live",
    agentId: "instance-a",
  }]);

  const forgedRun = await routes["agent-worker.tool"]({ runId: "exec:other", agentId: "friendly-a", toolName: "list_tabs" }, ctx);
  const forgedAgent = await routes["agent-worker.tool"]({ runId: "exec:live", agentId: "instance-b", toolName: "list_tabs" }, ctx);
  const overlongAlias = await routes["agent-worker.tool"]({ runId: `exec:live${"x".repeat(200)}`, agentId: "friendly-a", toolName: "list_tabs" }, ctx);
  const coerciveRun = await routes["agent-worker.tool"]({ runId: { toString() { throw new Error("must not coerce"); } }, agentId: "friendly-a", toolName: "list_tabs" }, ctx);
  assertEquals(forgedRun, { ok: false, error: "run_not_live" });
  assertEquals(forgedAgent, { ok: false, error: "run_not_live" });
  assertEquals(overlongAlias, { ok: false, error: "run_not_live" });
  assertEquals(coerciveRun, { ok: false, error: "run_not_live" });
  assertEquals(calls.length, 1, "forged envelopes never reach the executor");
});

Deno.test("agent-worker.tool: principal gate is first", async () => {
  const { kvGet, kvSet } = makeKv();
  const calls = [];
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }), kvGet, kvSet,
    executeTool: (name) => { calls.push(name); return { ok: true }; },
  });
  const r = await routes["agent-worker.tool"]({ toolName: "open_tab", args: {} }, { principal: "content-script" });
  assertEquals(r.ok, false, "non-extension principal refused");
  assertEquals(r.error, "unauthorized_principal");
  assertEquals(calls.length, 0, "tool not executed");
});

Deno.test("agent-worker.lease: the lease route no longer exists", async () => {
  const { kvGet, kvSet } = makeKv();
  const routes = createAgentWorkerRoutes({ ensureOffscreen: async () => ({ ok: true }), kvGet, kvSet });
  assert(!("agent-worker.lease" in routes), "no lease route");
});

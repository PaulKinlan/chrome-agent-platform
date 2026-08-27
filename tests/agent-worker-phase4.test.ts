// @ts-nocheck
// Phase 4 KATs: single-driver browser-command lease + the agent-worker.tool
// lease gate + the UI port client (CAP-FB-20260826-BROWSER-SINGLE-DRIVER-01).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  acquireBrowserCommandLease,
  readBrowserCommandLease,
  releaseBrowserCommandLease,
  withBrowserCommandLease,
} from "../extension/lib/browser-command-lease.js";
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

Deno.test("lease: exactly one surface acquires; a competitor is honestly refused", async () => {
  const { kvGet, kvSet } = makeKv();
  const a = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "ntp-1", runId: "r1" });
  assertEquals(a.ok, true, "first acquire wins");
  const b = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "ntp-2", runId: "r2" });
  assertEquals(b.ok, false, "second acquire refused");
  assert(/another surface/.test(b.error), "honest reason");
  assertEquals(b.holder.surfaceId, "ntp-1");
});

Deno.test("lease: release frees the slot; wrong-holder release is refused; expiry frees", async () => {
  const { kvGet, kvSet } = makeKv();
  const a = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "s1", runId: "r1" });
  // wrong holder cannot release
  const wrong = await releaseBrowserCommandLease(kvGet, kvSet, "nope");
  assertEquals(wrong.ok, false);
  // right holder releases
  const rel = await releaseBrowserCommandLease(kvGet, kvSet, a.lease.id);
  assertEquals(rel.released, true);
  const b = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "s2" });
  assertEquals(b.ok, true, "slot free after release");
  await releaseBrowserCommandLease(kvGet, kvSet, b.lease.id);

  // expiry frees (a closed surface never holds forever): force the stored
  // lease's expiresAt into the past, then a new acquire must succeed.
  const c = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "s3" });
  assertEquals(c.ok, true);
  await kvSet({ "cap:browser-command-lease": { ...c.lease, expiresAt: Date.now() - 1000 } });
  const d = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "s4" });
  assertEquals(d.ok, true, "expired lease frees the slot");
});

Deno.test("lease: withBrowserCommandLease releases in finally even when the run throws", async () => {
  const { kvGet, kvSet } = makeKv();
  let threw = false;
  try {
    await withBrowserCommandLease(kvGet, kvSet, { surfaceId: "s1" }, () => {
      throw new Error("boom");
    });
  } catch (e) {
    threw = /boom/.test(e.message);
  }
  assert(threw, "run error propagates");
  const next = await acquireBrowserCommandLease(kvGet, kvSet, { surfaceId: "s2" });
  assertEquals(next.ok, true, "lease released despite run throw (no deadlock)");
});

Deno.test("agent-worker.tool: destructive tool requires a held lease; read-only does not", async () => {
  const { kvGet, kvSet } = makeKv();
  const calls = [];
  const routes = createAgentWorkerRoutes({
    ensureOffscreen: async () => ({ ok: true }),
    kvGet,
    kvSet,
    executeTool: (name, args) => { calls.push(name); return { ok: true, name }; },
  });
  const ctx = { principal: "extension" };

  // destructive WITHOUT a lease → refused (no execution)
  const d = await routes["agent-worker.tool"]({ toolName: "open_tab", args: {} }, ctx);
  assertEquals(d.ok, false, "destructive without lease refused");
  assertEquals(calls.length, 0, "tool not executed");

  // acquire the lease, then destructive WITH the matching leaseId → allowed
  const acq = await routes["agent-worker.lease"]({ action: "acquire", surfaceId: "ntp-1" }, ctx);
  assertEquals(acq.ok, true);
  const d2 = await routes["agent-worker.tool"]({ toolName: "open_tab", args: {}, leaseId: acq.lease.id }, ctx);
  assertEquals(d2.ok, true, "destructive with matching lease allowed");
  assertEquals(calls, ["open_tab"]);

  // read-only needs no lease
  const r = await routes["agent-worker.tool"]({ toolName: "list_tabs", args: {} }, ctx);
  assertEquals(r.ok, true, "read-only tool un-gated");
});

Deno.test("agent-worker.lease: principal gate is first", async () => {
  const { kvGet, kvSet } = makeKv();
  const routes = createAgentWorkerRoutes({ ensureOffscreen: async () => ({ ok: true }), kvGet, kvSet });
  const r = await routes["agent-worker.lease"]({ action: "acquire", surfaceId: "x" }, { principal: "content-script" });
  assertEquals(r.ok, false, "non-extension principal refused");
  assertEquals(r.error, "unauthorized_principal");
});

// @ts-nocheck — small extension chrome.storage.local admission fixture.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  MASTER_JOURNAL_CUTOVER_FENCE_KEY,
  readJournalAdmissionFence,
} from "../extension/lib/master-journal-cutover-admission.js";
import { admitDurableRun } from "../extension/lib/durable-quota.js";
import { createDurableRunRegistry } from "../extension/lib/durable-runs.js";

function localFixture() {
  const items = new Map();
  return {
    items,
    async get(key) {
      const out = {};
      for (const name of Array.isArray(key) ? key : [key]) {
        if (items.has(name)) out[name] = items.get(name);
      }
      return out;
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) items.delete(key);
    },
  };
}

Deno.test("owner WAL cutover admission fence persists after boot restore-fence cleanup and refuses malformed present values", async () => {
  const local = localFixture();
  assertEquals(await readJournalAdmissionFence(local), null);
  local.items.set("cap:restoreFence", 100);
  assertEquals(await readJournalAdmissionFence(local), "restore");
  local.items.set(MASTER_JOURNAL_CUTOVER_FENCE_KEY, false);
  assertEquals(await readJournalAdmissionFence(local), "master_journal_cutover",
    "present-but-malformed durable owner fence must fail closed");
  await local.remove(["cap:restoreFence", "cap:restoreClaim", "cap:restoreHeartbeat"]);
  assertEquals(await readJournalAdmissionFence(local), "master_journal_cutover",
    "boot recovery must not silently disarm the independent owner fence");
  await local.remove(MASTER_JOURNAL_CUTOVER_FENCE_KEY); // Explicit owner repair only.
  assertEquals(await readJournalAdmissionFence(local), null);
});

Deno.test("register-task route refuses owner cutover before scheduling", async () => {
  const worker = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  const start = worker.indexOf('async "register-task"(m)');
  const end = worker.indexOf('async "run-task"(m)', start);
  assert(start >= 0 && end > start);
  const route = worker.slice(start, end);
  assert(route.includes('await readJournalAdmissionFence(chrome.storage.local)'));
  assert(route.includes('fence === "master_journal_cutover"'));
  assert(route.includes('throw new Error("Cannot register task: master journal cutover'));
  assert(route.indexOf('fence === "master_journal_cutover"') < route.indexOf("registerAlarm(m.task)"));
});

Deno.test("owner WAL cutover fence blocks both quota admission and direct registry start", async () => {
  const local = localFixture();
  local.items.set(MASTER_JOURNAL_CUTOVER_FENCE_KEY, { schemaVersion: 1, phase: "armed" });
  const before = globalThis.chrome;
  globalThis.chrome = { storage: { local } };
  let started = 0;
  try {
    const refused = await admitDurableRun({ start: async () => { started++; } }, { executionId: "exec_fence_demo" });
    assertEquals(refused?.code, "master_journal_cutover_in_progress");
    assertEquals(started, 0);
    const registry = createDurableRunRegistry({
      store: { keys: async () => [], get: async () => null },
      fenceCheck: () => readJournalAdmissionFence(local),
    });
    await assertRejects(() => registry.start({ executionId: "exec_fence_demo" }), Error, "master journal cutover fence is active");
  } finally {
    globalThis.chrome = before;
  }
});

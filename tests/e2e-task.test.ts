// tests/e2e-task.test.ts — END-TO-END task-completion verification (PLAN.md).
//
// This is the "the whole loop works" acceptance: a task runs a real LanguageModel
// (the deterministic demo model — a controlled fake over the REAL agent-do loop),
// produces a result, records usage, and the progress stream reaches a "done"
// event that the thread surface renders. No chrome/extension harness is needed —
// the model loop + the usage ledger run against the same in-memory kv + memory
// fakes the unit suites use.
// @ts-nocheck — the chrome/kv mocks are intentionally dynamic (no types in Deno).

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import { getUsage } from "../extension/lib/usage.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

// ---- chrome.storage mock (the usage ledger writes here) ----
const store = new Map();
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
globalThis.chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key) => {
        const out = {};
        for (const k of (Array.isArray(key) ? key : [key])) {
          if (store.has(k)) out[k] = clone(store.get(k));
        }
        return out;
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v === undefined) store.delete(k);
          else store.set(k, clone(v));
        }
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k);
      },
    },
  },
};

// ---- in-memory memory fake (the agent's memory toolset) ----
function fakeMemory() {
  const m = new Map();
  return {
    async get(key) {
      return m.has(key) ? m.get(key) : undefined;
    },
    async has(key) {
      return m.has(key);
    },
    async set(key, value) {
      m.set(key, value);
      return value;
    },
    async list() {
      return [...m.keys()].map((key) => ({ key, value: m.get(key) }));
    },
    async keys() {
      return [...m.keys()];
    },
  };
}

Deno.test("e2e: a task runs end-to-end — result + usage recorded + done event", async () => {
  clearRunFence();
  store.clear();

  const events = [];
  const model = createDemoModel();
  const agent = createAgent({
    model: { model, modelId: "demo-local", providerName: "demo" },
    id: "hub",
    name: "hub",
    memory: fakeMemory(),
    taskId: "e2e-1",
    onProgress: (e) => events.push(e),
  });

  const result = await agent.run("Summarise the page and save the summary to memory");

  // 1. The run produces a result (a string, not an error object).
  assert(typeof result === "string", `result must be a string, got ${typeof result}`);
  assert(result.length > 0, "result must be non-empty");

  // 2. The progress stream reached "done" with the text (what the thread renders).
  const done = events.find((e) => e.type === "done");
  assert(done, "the progress stream must emit a done event");
  assert(typeof done.text === "string" && done.text.length > 0, "done.text must be non-empty");

  // 3. Usage was recorded to the ledger (the onUsage hook → recordUsage).
  const usage = await getUsage();
  const rows = Array.isArray(usage?.rows) ? usage.rows : [];
  const hubRows = rows.filter((r) => r.agentId === "hub");
  assert(hubRows.length >= 1, `usage must record at least one hub row, got ${rows.length} total`);
  const first = hubRows[0];
  assertEquals(first.provider, "demo");
  assertEquals(first.model, "demo-local");
  assert((first.inputTokens ?? 0) + (first.outputTokens ?? 0) > 0, "usage must carry non-zero tokens");
});

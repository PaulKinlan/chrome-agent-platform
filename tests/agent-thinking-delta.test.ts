// @ts-nocheck — the agent factory is untyped JS (the same pattern as agent-text-delta.test.ts)
// tests/agent-thinking-delta.test.ts — chrome-agent-platform-h0iy.
// The orchestrator's model wrapper tees every doStream and forwards the
// provider's reasoning-delta parts to the progress callback as bounded
// `thinking-delta` events BEFORE the answer's text-deltas, so the
// conversation can stream the thinking trace live. Falsification: revert the
// reasoning-delta forwarding in lib/agent.js and every positive assertion
// here goes RED.

import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel, DEMO_THINKING_TRACE } from "../extension/lib/models/demo-model.js";
import { clearRunFence } from "../extension/lib/run-fence.js";

function __reset() { resetFakeIdb(); installFakeIdb(); resetFakeLocks(); installFakeLocks(); resetUsageMigration(); clearRunFence(); }

const store = new Map();
const clone = (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
(globalThis as any).chrome = {
  permissions: { contains: async () => true },
  storage: {
    local: {
      get: async (key: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of (Array.isArray(key) ? key : [key])) if (store.has(k)) out[k] = clone(store.get(k));
        return out;
      },
      set: async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) { if (v === undefined) store.delete(k); else store.set(k, clone(v)); }
      },
      remove: async (keys: string | string[]) => { for (const k of (Array.isArray(keys) ? keys : [keys])) store.delete(k); },
    },
  },
};

function fakeMemory() {
  const m = new Map();
  return {
    async get(key: string) { return m.has(key) ? m.get(key) : undefined; },
    async has(key: string) { return m.has(key); },
    async set(key: string, value: unknown) { m.set(key, value); return value; },
    async list() { return [...m.keys()].map((key) => ({ key, value: m.get(key) })); },
    async keys() { return [...m.keys()]; },
  };
}

async function runDemo(task: string) {
  __reset();
  store.clear();
  const events: any[] = [];
  const agent = createAgent({
    model: { model: createDemoModel(), modelId: "demo-local", providerName: "demo" },
    id: "hub",
    name: "hub",
    memory: fakeMemory(),
    taskId: `think-${Math.random().toString(36).slice(2, 8)}`,
    onProgress: (ev: any) => events.push(ev),
  });
  const result = await agent.run(task);
  return { events, result };
}

Deno.test("thinking trace: reasoning-delta parts stream as bounded thinking-delta events before the answer", async () => {
  const { events, result } = await runDemo("@demo-think sum this up");
  const thinking = events.filter((e) => e.type === "thinking-delta");
  assert(thinking.length > 0, "the demo thinking stream produces thinking-delta events");
  assertEquals(thinking[0].start, true, "the first thinking delta of the attempt carries start:true");
  assert(thinking.slice(1).every((e) => e.start === undefined), "only the first delta carries start");
  assertEquals(
    thinking.map((e) => e.delta).join(""),
    DEMO_THINKING_TRACE,
    "the coalesced thinking deltas concatenate to the exact trace",
  );
  const firstThinking = events.findIndex((e) => e.type === "thinking-delta");
  const firstText = events.findIndex((e) => e.type === "text-delta");
  assert(firstThinking >= 0 && firstText > firstThinking, "thinking streams BEFORE the answer text");
  assert(typeof result === "string" && result.length > 0, "the run still answers");
});

Deno.test("thinking trace: a run whose provider emits no reasoning produces ZERO thinking-delta events", async () => {
  const { events } = await runDemo("just a plain question");
  assertEquals(events.filter((e) => e.type === "thinking-delta").length, 0,
    "no reasoning parts → no events → no trace surface");
});

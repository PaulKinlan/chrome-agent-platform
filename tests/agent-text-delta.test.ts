// @ts-nocheck — the agent factory is untyped JS (the same pattern as e2e-task.test.ts)
// tests/agent-text-delta.test.ts — CAP-FB-20260830-TRANSCRIPT-STREAMING-01.
// The orchestrator's model wrapper tees every doStream and forwards the
// provider's text-delta chunks to the progress callback as bounded
// `text-delta` events BEFORE the step's `text` event, so the transcript can
// grow while the model is still answering. Falsification: revert the tee in
// lib/agent.js and "text-delta events precede the step text" goes RED.

import { installFakeIdb, resetFakeIdb } from "./fake-idb.js";
import { installFakeLocks, resetFakeLocks } from "./fake-locks.js";
import { resetUsageMigration } from "../extension/lib/usage-store.js";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createAgent } from "../extension/lib/agent.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";
import { clearRunFence } from "../extension/lib/run-fence.js";
import { createTextDeltaCoalescer } from "../extension/lib/text-delta-coalescer.js";
import { createRunTextTracker } from "../extension/lib/run-text-steps.js";

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
    taskId: `stream-${Math.random().toString(36).slice(2, 8)}`,
    onProgress: (e: any) => events.push(e),
  });
  const result = await agent.run(task);
  return { events, result };
}

Deno.test("streaming: text-delta events precede the step text and concatenate to it (paced demo answer)", async () => {
  const { events, result } = await runDemo("@demo-stream tell me about the platform");
  const textIdx = events.findIndex((e) => e.type === "text");
  assert(textIdx >= 0, "the step must end in a text event");
  const deltas = events.slice(0, textIdx).filter((e) => e.type === "text-delta");
  assert(deltas.length >= 5, `at least 5 text-delta events must precede the step text, got ${deltas.length}`);
  for (const d of deltas) {
    assert(typeof d.delta === "string" && d.delta.length > 0, "every delta carries text");
    assertEquals(d.step, events[textIdx].step, "every delta is attributed to its step");
    assert(!("text" in d), "a delta never carries the accumulated text (bounded payloads)");
  }
  const joined = deltas.map((d) => d.delta).join("");
  assertEquals(joined, events[textIdx].text, "the concatenated deltas equal the step's final text");
  assertEquals(result, events[textIdx].text, "the run result is the streamed text");
  // Deltas only ever arrive after the step's thinking event.
  const thinkingIdx = events.findIndex((e) => e.type === "thinking");
  assert(deltas.every(() => thinkingIdx < events.indexOf(deltas[0])), "deltas follow the step start");
});

Deno.test("streaming: a plain (unpaced) demo answer still streams and concatenates exactly", async () => {
  const { events } = await runDemo("Summarise the page");
  const textIdx = events.findIndex((e) => e.type === "text");
  const deltas = events.slice(0, textIdx).filter((e) => e.type === "text-delta");
  assert(deltas.length >= 1, "at least one delta precedes the step text");
  assertEquals(deltas.map((d) => d.delta).join(""), events[textIdx].text);
});

Deno.test("streaming: an answered tool step ends the run — no continuation reply exists to hide, and the answer streamed", async () => {
  // CAP-FB-20260830-MODEL-CALL-ECONOMY-01: the loop no longer sends agent-do's
  // "Continue working on the task…" after a tool step that already answered,
  // so the demo tool flow ends on the answer itself. This is the guard that a
  // returning nudge would trip: a hidden (nudge-reply) text event means an
  // extra model call was made for nothing.
  const { events } = await runDemo("@demo-tools list my open tabs");
  const hidden = events.filter((e) => e.type === "text" && e.hidden === true);
  assertEquals(hidden.length, 0, "no continuation call after the tool step's answer — nothing to hide");
  // The substantive tool-step answer is the run's LAST text event and it streamed.
  const substantive = events.find((e) => e.type === "text" && e.persist === true);
  assert(substantive, "the tool step's answer is the persisted text");
  const texts = events.filter((e) => e.type === "text");
  assertEquals(texts.at(-1)?.step, substantive.step, "the answer is the final step — no step follows it");
  const streamed = events.filter((e) => e.type === "text-delta" && e.step === substantive.step);
  assert(streamed.length >= 1, "the substantive answer streams");
  assertEquals(streamed.map((d) => d.delta).join(""), substantive.text);
  // The stream hold for a would-be nudge step still exists (the tracker unit
  // below); it simply never engages when no continuation is sent.
  assert(!events.some((e) => e.type === "text-delta" && e.step > substantive.step), "no deltas after the answer");
});

Deno.test("coalescer: the first delta flushes immediately; later deltas batch by time and by 8 KiB", async () => {
  const out: any[] = [];
  let now = 0;
  const c = createTextDeltaCoalescer((chunk: string) => out.push(chunk), { intervalMs: 50, maxBytes: 8192, now: () => now });
  c.push("hello ");
  assertEquals(out, ["hello "], "the first delta of a step is forwarded at once (TTFVT)");
  c.push("a"); c.push("b");
  assertEquals(out.length, 1, "deltas inside the interval are buffered");
  now = 60;
  c.push("c");
  assertEquals(out, ["hello ", "abc"], "the interval elapsing flushes the batch");
  c.push("x".repeat(8192));
  assertEquals(out.length, 3, "a full 8 KiB buffer flushes without waiting");
  c.push("tail");
  c.flush();
  assertEquals(out.at(-1), "tail", "flush drains the remainder");
  c.flush();
  assertEquals(out.length, 4, "an empty flush emits nothing");
});

Deno.test("run text tracker: a text-only step after an inner-step-limit boundary is the real answer, never hidden (CAP-FB-20260830-MODEL-CALL-ECONOMY-01)", () => {
  // The boundary step wrote text AND still had tool calls queued (finish
  // "tool-calls"): the continuation that follows carries the digest and the
  // model's next text is its answer — the run's result, streamed, persisted.
  const t = createRunTextTracker();
  t.step({ step: 0, hasToolCalls: true, text: "Read 24 tabs so far…", finishedWithToolCalls: true });
  assertEquals(t.nextStepMayBeNudge(), false, "no stream hold after a boundary");
  const answer = t.step({ step: 1, hasToolCalls: false, text: "Every tab: listed 30, read 30 of 30." });
  assertEquals(answer.hidden, false, "the answer after a boundary is never hidden");
  assertEquals(t.finalText("Every tab: listed 30, read 30 of 30."), "Every tab: listed 30, read 30 of 30.");
  assertEquals(t.endedOnNudge(), false);
});

Deno.test("run text tracker: the step after a tool step that ended in text is a nudge candidate", () => {
  const t = createRunTextTracker();
  assertEquals(t.nextStepMayBeNudge(), false);
  t.step({ step: 0, hasToolCalls: true, text: "here is the list" });
  assertEquals(t.nextStepMayBeNudge(), true);
  t.step({ step: 1, hasToolCalls: false, text: "Task complete" });
  assertEquals(t.nextStepMayBeNudge(), false);
  const u = createRunTextTracker();
  u.step({ step: 0, hasToolCalls: true, text: "" });
  assertEquals(u.nextStepMayBeNudge(), false, "a tool step WITHOUT text is followed by the real answer — it must stream");
});

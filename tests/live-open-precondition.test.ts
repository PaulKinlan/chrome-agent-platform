import { assertEquals } from "jsr:@std/assert@1";
import { selectLiveOpenExecution } from "../scripts/lib/live-open-precondition.ts";

const prior = { executionId: "old", threadId: "clicked", phase: "terminal", updatedAt: 10 };
const newRun = { executionId: "new", threadId: "clicked", phase: "running", updatedAt: 20 };

Deno.test("ly7n: a new running execution of the clicked task admits the measurement", () => {
  assertEquals(selectLiveOpenExecution({ threadId: "clicked", priorIds: ["old"], runs: [prior, newRun] }),
    { ok: true, executionId: "new", phase: "running" });
});

Deno.test("ly7n: an absorbed send cannot reuse the prior terminal execution", () => {
  assertEquals(selectLiveOpenExecution({ threadId: "clicked", priorIds: ["old"], runs: [prior] }),
    { ok: false, reason: "send_absorbed" });
  assertEquals(selectLiveOpenExecution({ threadId: "other", priorIds: ["old"], runs: [prior, newRun] }),
    { ok: false, reason: "send_absorbed" }, "another thread's running execution must not count");
});

Deno.test("ly7n: a new execution that settled before click cannot count as live", () => {
  assertEquals(selectLiveOpenExecution({ threadId: "clicked", priorIds: ["old"], runs: [prior, { ...newRun, phase: "terminal" }] }),
    { ok: false, reason: "settled_before_click", executionId: "new", phase: "terminal" });
});

Deno.test("ly7n: page-bound actionable run wins over a newer terminal row", () => {
  const oldLive = { executionId: "live", threadId: "clicked", phase: "running", updatedAt: 30 };
  const newTerminal = { executionId: "settled", threadId: "clicked", phase: "terminal", updatedAt: 40 };
  assertEquals(selectLiveOpenExecution({ threadId: "clicked", priorIds: [], runs: [newTerminal, oldLive] }),
    { ok: true, executionId: "live", phase: "running" });
});

Deno.test("ly7n: a fresh running row is refused if a different older run is page-bound", () => {
  const stale = { executionId: "stale", threadId: "clicked", phase: "running", updatedAt: 50 };
  assertEquals(selectLiveOpenExecution({ threadId: "clicked", priorIds: ["stale"], runs: [stale, newRun] }),
    { ok: false, reason: "different_live_run", executionId: "new", phase: "running" });
});

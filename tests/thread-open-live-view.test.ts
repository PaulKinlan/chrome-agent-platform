// @ts-nocheck — the view's deps are structurally injected fakes
// tests/thread-open-live-view.test.ts — a RUNNING execution's log is not read
// in the blocking thread view (bead chrome-agent-platform-h638).
//
// Measured cause: `listLogs` runs under the shared lock, which awaits the write
// chain and then flushes the buffer, so while a run streams its OWN log read
// costs ~1 s instead of ~3 ms (same execution, running vs settled). Opening a
// running task therefore waited on the live execution's read — 1890 ms to first
// transcript paint against 27 ms for the same task settled, 986 ms of it that
// one read.
//
// The rule this file pins: an ACTIVELY WRITING execution (running / settling /
// resume-dispatching / cancel-requested) is marked `logsPending` and NOT read;
// every other phase — including the PAUSED ones whose cards the owner needs on
// open — is read exactly as before. Nothing is dropped: a live run's rows stream
// in through the surface's own live transcript, and the next view build (the
// page re-renders on run snapshots) reads them once the phase settles.

import { assertEquals, assert } from "jsr:@std/assert@1";
import { buildThreadRunView } from "../extension/lib/thread-run-view.js";

/** A thread body with one turn marker per execution (the shape the view reads). */
function threadWith(executionIds) {
  return {
    id: "t_live",
    name: "live task",
    status: "running",
    messages: executionIds.flatMap((id, i) => ([
      { role: "user", content: `turn ${i}`, executionId: id, ts: 1000 + i * 10 },
      ...(i === 0 ? [{ role: "assistant", content: "first answer", executionId: id, ts: 1001 }] : []),
    ])),
  };
}

function depsFor(records) {
  const reads = [];
  return {
    reads,
    deps: {
      listThreadExecutions: async () => records.map((r) => ({ executionId: r.executionId, at: r.at ?? 1, record: r })),
      listLogs: async (executionId) => {
        reads.push(executionId);
        return [{ type: "tool-call", callId: `c_${executionId}`, tool: "search", at: 10 },
          { type: "tool-result", callId: `c_${executionId}`, tool: "search", result: "r", ok: true, at: 11 }];
      },
      commitTerminal: () => {},
      recordFailure: () => {},
    },
  };
}

Deno.test("a RUNNING execution's log is NOT read in the blocking view (and is not dropped)", async () => {
  const records = [
    { executionId: "e_done", phase: "terminal", terminal: { ok: true, result: "first answer", at: 5 } },
    { executionId: "e_live", phase: "running" },
  ];
  const { reads, deps } = depsFor(records);
  const view = await buildThreadRunView(threadWith(["e_done", "e_live"]), deps);

  assertEquals(reads.includes("e_live"), false, `the live execution's log must not be read, saw ${JSON.stringify(reads)}`);
  assertEquals(reads.includes("e_done"), true, "a settled execution is still read");
  // The turn markers are all there: the skip is about LOG rows, never about the
  // thread's own turns.
  assert(view.messages.some((m) => m.role === "user" && m.content === "turn 0"), "the first turn is in the view");
  assert(view.messages.some((m) => m.role === "user" && m.content === "turn 1"), "the live turn is in the view");
  assert(view.messages.some((m) => m.role === "assistant" && m.content === "first answer"), "the settled answer is in the view");
});

Deno.test("every ACTIVELY WRITING phase is skipped; a paused execution is still read in full", async () => {
  const records = [
    { executionId: "e_running", phase: "running" },
    { executionId: "e_settling", phase: "settling" },
    { executionId: "e_resume", phase: "resume-dispatching" },
    { executionId: "e_cancel", phase: "cancel-requested" },
    { executionId: "e_paused", phase: "paused-permission", pause: { kind: "permission" } },
    { executionId: "e_paused_provider", phase: "paused-provider-change" },
    { executionId: "e_unknown", phase: null },
  ];
  const { reads, deps } = depsFor(records);
  await buildThreadRunView(threadWith(records.map((r) => r.executionId)), deps);

  for (const skipped of ["e_running", "e_settling", "e_resume", "e_cancel"]) {
    assertEquals(reads.includes(skipped), false, `${skipped} is actively writing and must be skipped, saw ${JSON.stringify(reads)}`);
  }
  for (const read of ["e_paused", "e_paused_provider", "e_unknown"]) {
    assertEquals(reads.includes(read), true, `${read} must still be read (its producer is stopped / the phase is unknown), saw ${JSON.stringify(reads)}`);
  }
});

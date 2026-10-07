import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { isDemoProviderConfigured, requirePriorOpenReads, requireRunningOpenTrace, requireSettledOpenTrace, requireTraceMeasures, selectLiveOpenExecution } from "../scripts/lib/live-open-precondition.ts";

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

Deno.test("ly7n: provider.set success is a redacted config without ok, not an {ok:true} envelope", () => {
  assertEquals(isDemoProviderConfigured({ provider: "demo", baseURL: "", apiKey: "", model: "", hasApiKey: false }), true);
  assertEquals(isDemoProviderConfigured({ ok: false, error: "unknown provider", provider: "demo" }), false);
  assertEquals(isDemoProviderConfigured({ ok: true }), false, "kv.set-style reply cannot masquerade as provider setup");
  assertEquals(isDemoProviderConfigured({ __error: "port closed" }), false);
});

Deno.test("ly7n: a successful trace carries measurable perf rows", () => {
  const rows = [{ name: "cap:thread-view:logs:old", count: 1 }];
  assertEquals(requireTraceMeasures({ ok: true, perf: { measures: rows } }), rows);
});

Deno.test("ly7n: failed or absent trace measures cannot masquerade as no live log reads", () => {
  for (const dump of [{ __error: "message port closed" }, { ok: true, perf: null }, { ok: true, perf: { measures: {} } }, null]) {
    let refused = false;
    try { requireTraceMeasures(dump); } catch (error) { refused = String(error).includes("observability.dumpTrace failed"); }
    assertEquals(refused, true, `invalid trace must fail closed: ${JSON.stringify(dump)}`);
  }
});

Deno.test("ly7n: a fresh running row is refused if a different older run is page-bound", () => {
  const stale = { executionId: "stale", threadId: "clicked", phase: "running", updatedAt: 50 };
  assertEquals(selectLiveOpenExecution({ threadId: "clicked", priorIds: ["stale"], runs: [stale, newRun] }),
    { ok: false, reason: "different_live_run", executionId: "new", phase: "running" });
});

Deno.test("g4k5: running delta must positively contain a measured thread-view projection", () => {
  const valid = { rawSpans: [{ name: "thread-view:project", count: 1 }], liveLogReads: 0 };
  requireRunningOpenTrace(valid, "live");
  for (const invalid of [
    { rawSpans: [], liveLogReads: 0 },
    { rawSpans: [{ name: "thread-view:project", count: 0 }], liveLogReads: 0 },
    { rawSpans: [{ name: "thread.get:read", count: 1 }], liveLogReads: 0 },
  ]) assertThrows(() => requireRunningOpenTrace(invalid, "live"), Error, "no running thread-view:project span");
  assertThrows(() => requireRunningOpenTrace({ ...valid, liveLogReads: 1 }, "live"), Error, "view read live execution");
});

Deno.test("g4k5: settled control requires the SAME execution's positive log-read span", () => {
  requireSettledOpenTrace({ rawSpans: [{ name: "thread-view:logs:live", count: 1 }] }, "live");
  for (const rawSpans of [[], [{ name: "thread-view:logs:other", count: 1 }], [{ name: "thread-view:logs:live", count: 0 }]]) {
    assertThrows(() => requireSettledOpenTrace({ rawSpans }, "live"), Error, "missing positive log-read span");
  }
});

Deno.test("g4k5: direct view probe must read prior logs and skip the running execution", () => {
  requirePriorOpenReads({ reads: ["old"] }, "live");
  for (const probe of [{ reads: [] }, { reads: ["old", "live"] }, { __error: "port closed" }, null]) {
    assertThrows(() => requirePriorOpenReads(probe, "live"), Error, "viewProbe must read prior logs");
  }
});

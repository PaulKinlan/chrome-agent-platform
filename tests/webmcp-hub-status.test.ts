// tests/webmcp-hub-status.test.ts — CAP-FB-20260824-SITE-AGENTS-STATUS-01:
// the hub's WebMCP discovery status is a STRUCTURED card (a pure view-model +
// labeled rows + <time> elements), never a run-on " · " string; the
// refreshing state and the stale-report marker are DISTINCT signals.
// @ts-nocheck
import { assert, assertEquals } from "jsr:@std/assert@1";
import { formatWebmcpHubStatus } from "../extension/shared/site-agent-copy.js";

const BASE = {
  origin: "https://googlechromelabs.github.io",
  scriptStatus: "injected",
  scriptStatusAt: 1_756_000_000_000,
  lastReport: { toolCount: 1, declaredCount: 1, inferredCount: 0, at: 1_756_000_003_000 },
};

Deno.test("clean status card: origin, counts, and timestamps are separate fields (no run-on string)", () => {
  const vm = formatWebmcpHubStatus(BASE);
  assertEquals(vm.origin, "https://googlechromelabs.github.io");
  assertEquals(vm.state, "active");
  assertEquals(vm.stateLabel, "Scripts injected");
  assertEquals(vm.scriptAt, BASE.scriptStatusAt, "numeric timestamp preserved for <time datetime>");
  assertEquals(vm.report, { toolCount: 1, declaredCount: 1, inferredCount: 0, at: 1_756_000_003_000 });
  assertEquals(vm.reportStale, false, "the report is NEWER than the script event — not stale");
  assert(Object.isFrozen(vm) && Object.isFrozen(vm.report), "the view-model is immutable");
});

Deno.test("stale vs refreshing are DISTINCT: an in-flight refresh is a state, a stale report is an independent marker", () => {
  // refreshing: the script lifecycle is in flight (registered/injection-partial)
  for (const scriptStatus of ["registered", "injection-partial"]) {
    const vm = formatWebmcpHubStatus({ ...BASE, scriptStatus });
    assertEquals(vm.state, "refreshing", `${scriptStatus} → refreshing`);
    assertEquals(vm.stateLabel, "Scripts refreshing…");
    assertEquals(vm.reportStale, false, "no staleness without an ordering inversion");
  }
  // stale: the page report PREDATES the latest script event — marked even on an ACTIVE script
  const stale = formatWebmcpHubStatus({
    ...BASE,
    lastReport: { ...BASE.lastReport, at: BASE.scriptStatusAt - 60_000 },
  });
  assertEquals(stale.state, "active", "the script state is still honestly active");
  assertEquals(stale.reportStale, true, "the stale marker is independent of the state badge");
  // BOTH at once: refreshing AND stale report — two distinct fields, never merged
  const both = formatWebmcpHubStatus({
    ...BASE,
    scriptStatus: "injection-partial",
    lastReport: { ...BASE.lastReport, at: BASE.scriptStatusAt - 60_000 },
  });
  assertEquals(both.state, "refreshing");
  assertEquals(both.reportStale, true, "refreshing + stale coexist as distinct signals");
});

Deno.test("failure + not-run states map honestly; malformed records degrade to the empty state", () => {
  for (const scriptStatus of ["injection-failed", "injection-error"]) {
    assertEquals(formatWebmcpHubStatus({ ...BASE, scriptStatus }).state, "failed");
  }
  assertEquals(formatWebmcpHubStatus({ ...BASE, scriptStatus: "no-open-tabs" }).stateLabel, "No open tabs");
  assertEquals(formatWebmcpHubStatus({ ...BASE, scriptStatus: "none" }).state, "none");
  assertEquals(formatWebmcpHubStatus(null), null, "no record → the empty-state copy");
  assertEquals(formatWebmcpHubStatus({}).origin, "this site", "bare record → this site");
  // zero/negative/missing timestamps render no <time>
  const noTimes = formatWebmcpHubStatus({ origin: "https://x.example", scriptStatus: "injected", scriptStatusAt: 0, lastReport: null });
  assertEquals(noTimes.scriptAt, null);
  assertEquals(noTimes.report, null);
  // non-numeric counts bound to 0, never NaN into the UI
  const dirty = formatWebmcpHubStatus({ ...BASE, lastReport: { toolCount: "many", at: NaN } });
  assertEquals(dirty.report.toolCount, 0);
  assertEquals(dirty.report.at, null);
  assertEquals(dirty.reportStale, false, "no staleness without a valid report timestamp");
});

Deno.test("the renderer is structured DOM — no run-on join remains in ntp.js", async () => {
  const ntpJs = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
  const fnStart = ntpJs.indexOf("async function renderWebmcpHubStatus");
  const body = ntpJs.slice(fnStart, fnStart + 3200);
  assert(!body.includes('join(" · ")'), "the run-on separator is gone from the status renderer");
  assert(body.includes('document.createElement("time")'), "timestamps are <time> elements");
  assert(body.includes('document.createElement("dl")'), "the card is a labeled description list");
  assert(body.includes("formatWebmcpHubStatus("), "the renderer consumes the pure view-model");
  assert(!body.includes("innerHTML"), "no innerHTML — text nodes only");
});

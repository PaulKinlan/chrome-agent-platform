// tests/observability-routes-module.test.ts — chrome-agent-platform-atxc6 slice 5.
//
// This slice is the first with ZERO injections, and that is exactly what needs pinning: the 500-entry
// page-measure ring used to be worker module state (`const pageMeasuresBuffer = []`) shared with the routes;
// it now lives inside the module with them. Two things could silently regress:
//   1. the ring's BOUND — a page that reports thousands of measures must not grow the worker's heap, and the
//      drop-oldest behaviour is the only thing enforcing that;
//   2. the AUTHORITY — `observability.page-measures` is extension/owner-options only. A trace surface that any
//      principal could push into is a way to forge what the owner sees when debugging.
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createObservabilityRoutes } from "../extension/background/routes/observability.js";

Deno.test("observability routes: four routes, frozen map, no injected dependencies", () => {
  const routes = createObservabilityRoutes();
  assertEquals(Object.keys(routes).sort(), [
    "observability.clearTrace",
    "observability.dumpTrace",
    "observability.page-measures",
    "observability.setVerbosity",
  ]);
  assert(Object.isFrozen(routes), "the route map must be frozen, like every other routes/*.js map");
  for (const [name, handler] of Object.entries(routes)) {
    assertEquals(typeof handler, "function", `${name} must be a handler`);
  }
});

Deno.test("observability routes: page-measures is extension-only and the ring is bounded at 500", async () => {
  const routes = createObservabilityRoutes();

  // Authority first: a model/site principal cannot push measures into the trace the owner reads.
  for (const principal of ["model", "site:https://example.test", undefined]) {
    const refused = await routes["observability.page-measures"]({ measures: [{ name: "x", ms: 1 }] }, { principal });
    assertEquals(refused.ok, false, `principal ${String(principal)} must not write page measures`);
  }

  // Bound second, in TWO layers, because the handler has two of them and only pinning one would let the other
  // regress: each call accepts at most 100 measures, and the cumulative ring keeps at most 500.
  const burst = Array.from({ length: 1200 }, (_, i) => ({ name: `m${i}`, ms: i }));
  const accepted = await routes["observability.page-measures"]({ measures: burst }, { principal: "extension" });
  assertEquals(accepted.ok, true);
  assertEquals(accepted.accepted, 1200, "the route reports what the page SENT, not what it kept");
  let after = (await routes["observability.dumpTrace"]()).perf.measures;
  assertEquals(after.filter((m) => /^m\d+$/.test(String(m.name ?? ""))).length, 100,
    "one call must never accept more than 100 measures");

  // Eight full batches is 800 measures: the ring must stop at 500 and keep the newest.
  for (let batch = 1; batch < 8; batch += 1) {
    const next = Array.from({ length: 100 }, (_, i) => ({ name: `n${batch}-${i}`, ms: i }));
    await routes["observability.page-measures"]({ measures: next }, { principal: "extension" });
  }
  after = (await routes["observability.dumpTrace"]()).perf.measures;
  const mine = after.filter((m) => /^[mn]\d+(-\d+)?$/.test(String(m.name ?? "")));
  assertEquals(mine.length, 500, "the ring must stay bounded no matter how much a page reports");
  assertEquals(mine.at(-1).name, "n7-99", "the newest measure survives; the oldest are dropped");
});

Deno.test("observability routes: clearTrace empties the ring the routes own", async () => {
  const routes = createObservabilityRoutes();
  await routes["observability.page-measures"]({ measures: [{ name: "before-clear", ms: 1 }] }, { principal: "extension" });
  const cleared = await routes["observability.clearTrace"]();
  assertEquals(cleared.ok, true);
  const trace = await routes["observability.dumpTrace"]();
  const names = trace.perf.measures.map((m) => String(m.name ?? ""));
  assert(!names.includes("before-clear"), "clearTrace must clear the SAME ring page-measures writes to");
});

Deno.test("observability routes: setVerbosity keeps its {ok:false,error} refusal shape", async () => {
  const routes = createObservabilityRoutes();
  const out = await routes["observability.setVerbosity"]({ level: "not-a-level" });
  assert(typeof out === "object" && out !== null, "setVerbosity must always return an object");
  assert(typeof out.ok === "boolean", "the Settings panel branches on ok");
  if (out.ok === false) assertEquals(typeof out.error, "string", "a refusal must carry a message for the panel");
});

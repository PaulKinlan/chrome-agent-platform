// tests/memory-admin-routes-module.test.ts — chrome-agent-platform-atxc6 (third slice of the
// service-worker split by domain: the memory ADMIN routes joined memory.get/set/list/clear in
// extension/background/routes/memory.js).
//
// What is worth asserting is not the explorer's formatting; it is WHO may reach a destructive route once
// the route stops living inside the worker:
//   1. the module owns exactly the five admin routes, and the map is frozen like every other route map;
//   2. `memory.purgeJournals` and `memory.sweepOrphans` are OWNER-ONLY. Both return a refusal for any other
//      principal, and neither reaches the store — the guard travelled with the handler, so extracting the
//      route cannot quietly widen the caller set;
//   3. the exploit the guard exists for: an extension page (principal other than `owner-options`) cannot
//      delete agent journals by calling the route with a forged `target`.
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createMemoryAdminRoutes } from "../extension/background/routes/memory.js";

Deno.test("memory admin routes: the module owns exactly the five admin routes and freezes its map", () => {
  const routes = createMemoryAdminRoutes({ memoryOverview: async () => ({ keys: 0 }) });
  assertEquals(Object.keys(routes).sort(), [
    "memory.origins",
    "memory.overview",
    "memory.purgeJournals",
    "memory.stores",
    "memory.sweepOrphans",
  ]);
  assert(Object.isFrozen(routes), "the route map must be frozen, like every other routes/*.js map");
  for (const [name, handler] of Object.entries(routes)) {
    assertEquals(typeof handler, "function", `${name} must be a handler`);
  }
});

Deno.test("memory admin routes: the destructive routes refuse every principal but the Settings surface", async () => {
  const routes = createMemoryAdminRoutes({ memoryOverview: async () => ({}) });
  for (const principal of ["model", "extension", "site:https://example.test", undefined]) {
    for (const name of ["memory.purgeJournals", "memory.sweepOrphans"]) {
      const out = await routes[name]({ target: "agent:victim" }, { principal });
      assertEquals(out.ok, false, `${name} must refuse principal ${String(principal)}`);
      assert(
        /Settings surface/.test(String(out.error)),
        `${name} must name the Settings surface as the only caller, got ${out.error}`,
      );
    }
  }
});

Deno.test("memory admin routes: overview reads the injected summariser for the master and every origin", async () => {
  const seen = [];
  const routes = createMemoryAdminRoutes({
    memoryOverview: async (store) => {
      seen.push(store);
      return { keys: seen.length };
    },
  });
  const out = await routes["memory.overview"]({});
  assertEquals(out.ok, true);
  assert(seen.length >= 1, "the master store must be summarised");
  assertEquals(typeof out.overview.master, "object");
});

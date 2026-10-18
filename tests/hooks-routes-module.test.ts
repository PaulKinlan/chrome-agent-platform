// tests/hooks-routes-module.test.ts — chrome-agent-platform-atxc6 (first slice of the service-worker
// split by domain: the system-hooks routes moved from the 5,010-line inline route map into
// extension/background/routes/hooks.js).
//
// The extraction is a MOVE, so what is worth asserting is the seam itself, not the handler logic
// (tests/hooks.test.ts covers the hook library and tests/hook-subscribe-approval.test.ts drives the real
// `hooks.subscribe` member out of the module against the real approval store):
//   1. the module owns exactly the four hook routes, and the map is frozen like every other route map;
//   2. it FAILS CLOSED when the injected approval machinery is missing — a route module that silently
//      degrades to an ungated handler would be a security regression, not a wiring mistake;
//   3. the owner-only gate on the deny list travels with the handler (the whole reason `hooks.deny` may
//      not be reachable from an agent principal).
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createHooksRoutes } from "../extension/background/routes/hooks.js";

const deps = { requireOwnerApproval: async () => ({ ok: true }), payloadFields: () => ({}) };

Deno.test("hooks routes: the module owns exactly the four hook routes and freezes its map", () => {
  const routes = createHooksRoutes(deps);
  assertEquals(Object.keys(routes).sort(), [
    "hooks.deny",
    "hooks.status",
    "hooks.subscribe",
    "hooks.unsubscribe",
  ]);
  assert(Object.isFrozen(routes), "the route map must be frozen, like every other routes/*.js map");
  for (const [name, handler] of Object.entries(routes)) {
    assertEquals(typeof handler, "function", `${name} must be a handler`);
  }
});

Deno.test("hooks routes: a missing approval helper fails closed, never an ungated route", () => {
  assertThrows(
    () => createHooksRoutes({ payloadFields: deps.payloadFields }),
    Error,
    "requireOwnerApproval",
  );
  assertThrows(
    () => createHooksRoutes({ requireOwnerApproval: deps.requireOwnerApproval }),
    Error,
    "payloadFields",
  );
});

Deno.test("hooks routes: the deny list stays owner-only from the module", async () => {
  const routes = createHooksRoutes(deps);
  for (const principal of [undefined, "extension", "model", "settings"]) {
    const out = await routes["hooks.deny"]({ hookId: "before-run", denied: true }, { principal });
    assertEquals(
      out,
      { ok: false, error: "hook policy is owned by Settings" },
      `principal ${String(principal)} must not be able to change the deny list`,
    );
  }
});

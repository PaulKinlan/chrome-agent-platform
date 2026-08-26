// @ts-nocheck
// API-availability hardening KATs (owner P1, follow-on to observability):
// a tool that touches chrome.<api> must return an HONEST STRUCTURED ERROR when
// the namespace is unavailable — never a raw "Cannot read properties of
// undefined". Proves the chromeApi()/tabGroupsApi() guards added across
// list_windows, get/set_action_state, list_commands, sessions (3), tabGroups.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { browserToolset } from "../extension/lib/browser-tools.js";

// Minimal chrome shim: permissions present (so no permission gate short-circuits),
// the TARGET namespace deliberately ABSENT (the unavailable-API scenario).
function withMissing(namespaces, fn) {
  const saved = globalThis.chrome;
  globalThis.chrome = {
    permissions: {
      contains: async () => true,
      request: async () => true,
      getAll: async () => ({ permissions: [], origins: [] }),
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    // deliberately NO windows/action/commands/sessions/tabGroups namespaces
  };
  try {
    return fn();
  } finally {
    globalThis.chrome = saved;
  }
}

Deno.test("API availability: guarded tools return honest errors, never throw, when the namespace is missing", async () => {
  await withMissing(["windows", "action", "commands", "sessions", "tabGroups"], async () => {
    const tools = browserToolset(false);
    for (const [name, args] of [
      ["list_windows", {}],
      ["get_action_state", {}],
      ["set_action_state", { badgeText: "1" }],
      ["list_commands", {}],
      ["list_recently_closed", {}],
      ["list_synced_devices", {}],
      ["restore_closed", { sessionId: "s1" }],
      ["list_tab_groups", {}],
    ]) {
      let out;
      let threw = null;
      try {
        out = await tools[name].execute(args);
      } catch (e) {
        threw = e;
      }
      assert(!threw, `${name} must not throw on unavailable API — got: ${threw?.message}`);
      assert(out && typeof out.error === "string", `${name} must return a structured error, got: ${JSON.stringify(out)}`);
      assert(!/Cannot read properties of undefined/i.test(out.error), `${name} error must be honest, not the raw TypeError: ${out.error}`);
    }
  });
});

Deno.test("API availability: tabGroups mutations fail honest when chrome.tabGroups is missing", async () => {
  await withMissing(["tabGroups"], async () => {
    const tools = browserToolset(false);
    for (const [name, args] of [
      ["update_tab_group", { groupId: 1, title: "x" }],
    ]) {
      let threw = null;
      let out;
      try { out = await tools[name].execute(args); } catch (e) { threw = e; }
      // update_tab_group goes through withTabGroupGrant which checks tabs permission
      // first — with the shim granting permissions, it reaches the API guard.
      assert(!threw, `${name} must not throw on unavailable API — got: ${threw?.message}`);
      assert(out && typeof out.error === "string", `${name} must return a structured error`);
    }
  });
});

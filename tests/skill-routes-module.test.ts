// tests/skill-routes-module.test.ts — chrome-agent-platform-atxc6 slice 4 (designed in zln9d).
//
// The skill family moved out of the worker, and unlike the earlier slices it carries WRITES
// (installImportedSkill writes files, then the memory index). So the properties worth pinning are the seam
// and the authority, not the catalog formatting:
//   1. the module owns exactly the ten skill routes, frozen like every other route map — and `skill.run` is
//      NOT among them, because it calls runTask and belongs to the run core;
//   2. `site-skills.set` stays Settings-only: `requireSettingsSender` travels with the handler, so moving the
//      route cannot widen who can write a site playbook;
//   3. `skills.set` still calls `invalidateAgent` — the whole reason that injection exists is that a skills
//      change must rebuild the running orchestrator's system prompt rather than leave a stale one cached;
//   4. the file STORE is shared, not copied: this module and the worker import the same object from
//      lib/skill-files.js, so a moved route can never write through a different store than the catalog reads.
// @ts-nocheck — unit tests run under Deno.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createSkillRoutes } from "../extension/background/routes/skills.js";
import { skillFileStore } from "../extension/lib/skill-files.js";

function harness() {
  const events = [];
  const routes = createSkillRoutes({
    masterMemory: () => {
      events.push("masterMemory");
      return {};
    },
    invalidateAgent: () => events.push("invalidateAgent"),
    broadcastRegistryChanged: () => events.push("broadcastRegistryChanged"),
  });
  return { routes, events };
}

Deno.test("skill routes: the module owns exactly the ten skill routes and freezes its map", () => {
  const { routes } = harness();
  assertEquals(Object.keys(routes).sort(), [
    "site-skills.get",
    "site-skills.set",
    "skill.delete",
    "skill.discover",
    "skill.import",
    "skill.importBatch",
    "skill.list",
    "skills.all",
    "skills.get",
    "skills.set",
  ]);
  assert(Object.isFrozen(routes), "the route map must be frozen, like every other routes/*.js map");
  assert(!("skill.run" in routes), "skill.run must stay in the worker: it resolves a skill and calls runTask");
  for (const [name, handler] of Object.entries(routes)) {
    assertEquals(typeof handler, "function", `${name} must be a handler`);
  }
});

Deno.test("skill routes: site-skills.set stays Settings-only and REJECTS before any write", async () => {
  const { routes } = harness();
  // The guard is `requireSettingsSender(context)`, which throws — and it is the FIRST statement in the
  // handler, so a non-Settings caller never reaches `setSiteNote`. Moving the route must not change that.
  await assertRejects(
    () => routes["site-skills.set"]({ origin: "https://example.test", notes: "hi" }, { principal: "model" }),
    Error,
    "Settings",
  );
});

Deno.test("skill routes: skills.set invalidates the cached orchestrator prompt (the reason for the injection)", async () => {
  // Pinned on the handler BODY, not on a full storage round-trip: setSkills needs a real memory store, and
  // what this route adds to it is exactly one line — the notification. A skills change that does not rebuild
  // the orchestrator leaves a stale system prompt, which is the regression 51cd-adjacent and this seam exist
  // for. Reading the source is the only place that line is observable without an OPFS fixture.
  const source = await Deno.readTextFile("extension/background/routes/skills.js");
  const body = source.slice(
    source.indexOf('async "skills.set"('),
    source.indexOf('async "skills.get"('),
  );
  assert(/await setSkills\(/.test(body), "skills.set must still delegate storage to setSkills");
  assert(/invalidateAgent\(\)/.test(body), "skills.set must call the injected invalidateAgent after a successful write");
  assert(body.indexOf("invalidateAgent()") > body.indexOf("await setSkills("),
    "the invalidation must follow the write, never precede it");
});

Deno.test("skill routes: the file store is SHARED with the worker's catalog, never a copy", () => {
  assert(Object.isFrozen(skillFileStore), "the store is a frozen single definition");
  assertEquals(Object.keys(skillFileStore).sort(), ["removeSkillFiles", "writeSkillFiles"]);
  assert(typeof skillFileStore.writeSkillFiles === "function");
  assert(typeof skillFileStore.removeSkillFiles === "function");
  // A copy in the module would defeat the point: the module must IMPORT it, which the diff can show but the
  // runtime can only observe as identity with the library's own object.
  const worker = Deno.readTextFileSync("extension/background/service-worker.js");
  assert(/import \{[^}]*skillFileStore[^}]*\} from "\.\.\/lib\/skill-files\.js"/.test(worker),
    "the worker must import the shared store rather than define its own");
  assert(!/^const skillFileStore = \{/m.test(worker), "the worker must not keep a second definition");
});

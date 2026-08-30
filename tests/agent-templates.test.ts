// tests/agent-templates.test.ts — agent template catalogue + collaboration
// skill pack (docs/AGENT-PRODUCT-GAPS.md G1+G2+G10, phase 1). The catalogue is
// DATA (like recipes): templates pre-fill the create form and stay fully
// editable; the collaboration skills are recipe entries, never code.
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_COUNT,
  STARTER_TEMPLATE_IDS,
  agentTemplateById,
  templatePrefill,
} from "../extension/lib/agent-templates.js";
import { RECIPES, getRecipe, agentSkillIds, mergeRunSkills } from "../extension/lib/recipes.js";
import { composeSystemPrompt } from "../extension/lib/system-prompts.js";

Deno.test("templates: the catalogue ships 21 starting agents with unique ids/names", () => {
  assertEquals(AGENT_TEMPLATES.length, 21);
  assertEquals(AGENT_TEMPLATE_COUNT, 21);
  const ids = new Set(AGENT_TEMPLATES.map((t) => t.id));
  const names = new Set(AGENT_TEMPLATES.map((t) => t.name));
  assertEquals(ids.size, AGENT_TEMPLATES.length);
  assertEquals(names.size, AGENT_TEMPLATES.length);
  // The owner's named top-3 are all present.
  for (const id of ["chief-of-staff", "research-analyst", "site-auditor"]) {
    assertExists(agentTemplateById(id), `missing top-3 template: ${id}`);
  }
});

Deno.test("templates: every referenced skill id exists in RECIPES (no dangling suggestions)", () => {
  const recipeIds = new Set(RECIPES.map((r) => r.id));
  for (const t of AGENT_TEMPLATES) {
    assert(t.skills.length > 0, `${t.id}: no suggested skills`);
    for (const s of t.skills) {
      assert(recipeIds.has(s), `${t.id} suggests "${s}" — not a recipe id`);
    }
  }
});

Deno.test("templates: role personas follow the docker-agent-test shape (Identity/Instructions/Output Format)", () => {
  for (const t of AGENT_TEMPLATES) {
    assert(t.role.includes("## Identity"), `${t.id}: no Identity section`);
    assert(t.role.includes("## Instructions"), `${t.id}: no Instructions section`);
    assert(t.role.includes("## Output Format"), `${t.id}: no output contract`);
    assert(t.role.length > 300, `${t.id}: persona suspiciously thin`);
    assert(typeof t.firstTask === "string" && t.firstTask.trim().length > 10, `${t.id}: no usable first task`);
  }
});

Deno.test("templates: honest scope — no promises of agent-to-agent delegation or per-agent MCP (G4/G5)", () => {
  const banned = /\bmcp\b/i;
  for (const t of AGENT_TEMPLATES) {
    assert(!banned.test(t.description), `${t.id}: description promises MCP (G4 is not built)`);
  }
  // delegate-and-collect discloses the delegation limitation inside the skill.
  const d = getRecipe("delegate-and-collect");
  assertExists(d);
  assert(d.prompt.includes("not available yet"), "delegate-and-collect must disclose agent-to-agent is coming");
});

Deno.test("templates: prefill is a pure mapping (starting point, fully editable afterwards)", () => {
  const t = agentTemplateById("chief-of-staff");
  assertExists(t);
  const pre = templatePrefill(t);
  assertExists(pre);
  assertEquals(pre.name, t.name);
  assertEquals(pre.role, t.role);
  assertEquals(pre.skills, t.skills);
  assertEquals(pre.firstTask, t.firstTask);
  // The prefill is a COPY — mutating it must not touch the catalogue.
  pre.skills.push("sneaky");
  assertEquals(t.skills.includes("sneaky"), false);
  assertEquals(templatePrefill(null), null);
});

Deno.test("collaboration pack: all 12 skills exist as DATA recipes in the collaboration category", () => {
  const expected = [
    "review-work",
    "delegate-and-collect",
    "red-team",
    "research-and-report",
    "browser-research-playbook",
    "manager-check",
    "handoff-brief",
    "evidence-pack",
    "form-playbook",
    "change-digest",
    "claim-crosscheck",
    "export-artifact",
  ];
  for (const id of expected) {
    const r = getRecipe(id);
    assertExists(r, `missing collaboration skill: ${id}`);
    assertEquals(r.category, "collaboration");
    assertEquals(r.mode, "on-demand");
    assert(typeof r.prompt === "string" && r.prompt.length > 100, `${id}: prompt too thin`);
  }
});

Deno.test("collaboration pack: the recipes stay DATA — prompts are inert strings", () => {
  const pack = ["review-work", "red-team", "manager-check"];
  for (const id of pack) {
    const r = getRecipe(id);
    assertExists(r);
    // No executable-looking payloads: the prompt never contains script/script-injection seams.
    assert(!/<script/i.test(r.prompt), `${id}: prompt contains a script tag`);
    assert(!/\beval\s*\(/.test(r.prompt), `${id}: prompt contains eval`);
  }
});

Deno.test("G1: the agent's role reaches the composed system prompt as the persona layer", () => {
  const persona = "## Agent role\nYou coordinate the owner's browser as chief of staff.";
  const composed = composeSystemPrompt({
    baseId: null,
    role: "You coordinate the owner's browser as chief of staff.",
  });
  assert(
    composed.text.includes(persona),
    "the composed prompt must carry the agent-role layer",
  );
  // And a blank role contributes no role layer.
  const blank = composeSystemPrompt({ baseId: null, role: "" });
  assert(!blank.text.includes("## Agent role"), "blank role must not add an empty role layer");
});

Deno.test("templates: honest capabilities — NO template names a tool that does not exist (P1-d)", () => {
  // The search_tools accuracy contract: one wrong tool name invalidates a
  // prompt candidate. jq/sed/awk/htmlq are NOT in the bundled inventory (the
  // shipped set is csvtool/toml2json/sqlite3_query_bounded + the text tools).
  const banned = /\b(jq|awk|sed|htmlq)\b/;
  for (const t of AGENT_TEMPLATES) {
    assert(!banned.test(t.description), `${t.id}: description names a nonexistent tool`);
    assert(!banned.test(t.role), `${t.id}: persona names a nonexistent tool`);
    assert(!banned.test(t.firstTask), `${t.id}: first task names a nonexistent tool`);
  }
  // The Data Wrangler (the fixed offender) now cites real shipped tools.
  const dw = agentTemplateById("data-wrangler");
  assertExists(dw);
  assert(dw.description.includes("csvtool"), "data-wrangler must cite the real CSV tool");
  assert(dw.role.includes("csvtool") && dw.role.includes("sqlite3_query_bounded"), "data-wrangler persona cites shipped tools");
});

Deno.test("templates: background templates carry a schedule (period + recurring prompt); on-demand ones do not", () => {
  for (const t of AGENT_TEMPLATES) {
    if (t.mode === "background") {
      assertExists(t.schedule, `${t.id}: background mode without a schedule`);
      assert(Number.isInteger(t.schedule.periodInMinutes) && t.schedule.periodInMinutes >= 1, `${t.id}: bad period`);
      assert(typeof t.schedule.prompt === "string" && t.schedule.prompt.length > 20, `${t.id}: no recurring prompt`);
    } else {
      assertEquals(t.schedule, undefined, `${t.id}: on-demand template must not prefill a schedule`);
    }
  }
});

Deno.test("templates: Advanced Web Developer has the required interactive persona fields", () => {
  const t = agentTemplateById("advanced-web-developer");
  assertExists(t);
  assertEquals(t.name, "Advanced Web Developer");
  assert(t.description.length > 20);
  assertEquals(t.mode, "on-demand");
  assertEquals(t.schedule, undefined);
  assertEquals(t.skills, [
    "multi-tab-researcher",
    "page-summary",
    "accessibility-checker",
    "performance-reporter",
    "screenshot-annotate",
  ]);
  assert(t.firstTask.length > 10);
  assert(t.role.includes("current documentation"));
  assert(t.role.includes("Baseline"));
  assert(t.role.includes("View Transitions"));
  assert(t.role.includes("Core Web Vitals"));
});

Deno.test("templates: the starter set is the owner's curated seven, all resolve from the catalogue", () => {
  assertEquals([...STARTER_TEMPLATE_IDS], [
    "chief-of-staff",
    "research-analyst",
    "advanced-web-developer",
    "site-auditor",
    "critic",
    "webapp-test-pilot",
    "skill-smith",
  ]);
  for (const id of STARTER_TEMPLATE_IDS) {
    assertExists(agentTemplateById(id), `starter template missing: ${id}`);
  }
});

Deno.test("templates: prefill carries mode + schedule (a COPY — mutating it never touches the catalogue)", () => {
  const t = agentTemplateById("tab-janitor");
  assertExists(t);
  const pre = templatePrefill(t);
  assertExists(pre);
  assertEquals(pre.mode, "background");
  assertExists(pre.schedule);
  assertExists(t.schedule);
  assertEquals(pre.schedule.periodInMinutes, t.schedule.periodInMinutes);
  pre.schedule.periodInMinutes = 1;
  assert(t.schedule.periodInMinutes !== 1, "the prefill schedule is a copy");
  const od = templatePrefill(agentTemplateById("chief-of-staff"));
  assertExists(od);
  assertEquals(od.schedule, null, "on-demand templates prefill no schedule");
});

Deno.test("P1-c: an agent's SAVED skills resolve and compose into the run skill list (falsification: removal changes it)", () => {
  // agentSkillIds normalizes the record shape ({id,...} objects or strings).
  const agent = { skills: [{ id: "reader-mode", name: "Reader Mode" }, "page-summary"] };
  const ids = agentSkillIds(agent);
  assertEquals(ids, ["reader-mode", "page-summary"]);
  // Resolved through the REAL registry and merged — the same list the run path
  // composes into the system prompt.
  const resolved = ids.map((id) => getRecipe(id)).filter(Boolean);
  assertEquals(resolved.length, 2, "both saved skills resolve to real recipes");
  const merged = mergeRunSkills(resolved, []);
  assert(merged.some((r) => r.id === "reader-mode" && typeof r.prompt === "string" && r.prompt.length > 0),
    "the saved skill's goal/steps (prompt body) are IN the composition");
  // Falsification: removing the skill from the agent changes the composition.
  const without = mergeRunSkills(agentSkillIds({ skills: [] }).map((id) => getRecipe(id)).filter(Boolean), []);
  assert(!without.some((r) => r.id === "reader-mode"), "without the saved skill the composition drops it");
  // Dedup: a /skill: reference duplicating a saved skill composes ONCE.
  const dup = mergeRunSkills(resolved, [getRecipe("reader-mode")]);
  assertEquals(dup.filter((r) => r.id === "reader-mode").length, 1, "saved skill + same /skill: ref = one composition");
});

Deno.test("P1-c wiring: named-agent.run resolves saved skills and runTask merges them with /skill: refs", async () => {
  const sw = await Deno.readTextFile(new URL("../extension/background/service-worker.js", import.meta.url));
  assert(/agentSkills:\s*await resolveAgentSkills\(agent\)/.test(sw),
    "named-agent.run must pass the agent's resolved saved skills into runTask");
  assert(/mergeRunSkills\(agentSkills, await resolveSkillRefs\(task\)\)/.test(sw),
    "runTask must merge saved skills with /skill:<id> references");
  // The set-schedule route is the extracted factory (routes/agent-schedule.js),
  // merged into the SW handlers.
  const routeSrc = await Deno.readTextFile(new URL("../extension/background/routes/agent-schedule.js", import.meta.url));
  assert(/async\s+"named-agent\.set-schedule"/.test(routeSrc), "the set-schedule route exists (extracted factory)");
  assert(sw.includes("agentScheduleRoutes"), "the SW merges the extracted schedule routes");
  assert(/alarm\.name\.startsWith\("agent:"\)/.test(sw),
    "the scheduler fire path routes agent:<slug> schedules as real named-agent runs");
});

// CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01 — a background recipe renders
// as a template card WITHOUT duplicating its data: the adapter is a pure
// projection, so choosing a recipe card pre-fills the create form through the
// same templatePrefill path as a curated template (one code path, not two).
Deno.test("recipeAsTemplate maps a background recipe to a template with mode background and its schedule", async () => {
  const mod: any = await import("../extension/lib/agent-templates.js");
  const recipeAsTemplate = mod.recipeAsTemplate;
  assertExists(recipeAsTemplate, "recipeAsTemplate is exported");
  const recipe: any = RECIPES.find((r: any) => r.mode === "background" && r.schedule?.periodInMinutes);
  assertExists(recipe);
  const t: any = recipeAsTemplate({ ...recipe, enabled: false });
  assertExists(t);
  assertEquals(t.id, recipe.id);
  assertEquals(t.name, recipe.name);
  assertEquals(t.description, recipe.description);
  assertEquals(t.mode, "background");
  assertEquals(t.source, "recipe");
  assertEquals(t.schedule, { periodInMinutes: recipe.schedule.periodInMinutes, prompt: recipe.prompt });
  assertEquals(t.skills, []);
  // The prefill the create form applies is the ordinary one — schedule text
  // "every N minutes" comes from the same field the dialog already parses.
  const pre: any = templatePrefill(t);
  assertEquals(pre.schedule.periodInMinutes, recipe.schedule.periodInMinutes);
  assertEquals(pre.name, recipe.name);
  assertEquals(pre.mode, "background");
  // Not a recipe → null; an on-demand recipe → null (only scheduled work is a
  // scheduled template).
  assertEquals(recipeAsTemplate(null), null);
  const onDemand = RECIPES.find((r) => r.mode !== "background");
  assertEquals(recipeAsTemplate(onDemand), null);
});

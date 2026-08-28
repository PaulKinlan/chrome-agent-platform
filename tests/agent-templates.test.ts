// tests/agent-templates.test.ts — agent template catalogue + collaboration
// skill pack (docs/AGENT-PRODUCT-GAPS.md G1+G2+G10, phase 1). The catalogue is
// DATA (like recipes): templates pre-fill the create form and stay fully
// editable; the collaboration skills are recipe entries, never code.
import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import {
  AGENT_TEMPLATES,
  AGENT_TEMPLATE_COUNT,
  agentTemplateById,
  templatePrefill,
} from "../extension/lib/agent-templates.js";
import { RECIPES, getRecipe } from "../extension/lib/recipes.js";
import { composeSystemPrompt } from "../extension/lib/system-prompts.js";

Deno.test("templates: the catalogue ships 19 starting agents with unique ids/names", () => {
  assertEquals(AGENT_TEMPLATES.length, 19);
  assertEquals(AGENT_TEMPLATE_COUNT, 19);
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

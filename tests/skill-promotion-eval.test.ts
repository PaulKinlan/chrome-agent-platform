// skill-promotion-eval.test.ts — chrome-agent-platform-ve67.
//
// The eval harness for the skill PROMOTION layer: given a task and the skill
// catalog, the composed system prompt either gains a bounded promotion section
// naming the relevant adoptable skills, or stays clean (no relevant skill /
// everything already adopted). Each scenario asserts the COMPOSED prompt's
// signal, RED before the fix (the seam that threads the promotion section
// into the composition is absent → the section is missing) and GREEN after.
// @ts-nocheck — dynamic catalog records.
import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import { promoteSkills, skillKeywords, relevanceScore, PROMOTION_BUDGET } from "../extension/lib/skill-promotion.js";
import { appendSkillsLayer, baselineSystemPrompt, PROTECTED_CONSTRAINTS } from "../extension/lib/system-prompts.js";
import { createDemoModel } from "../extension/lib/models/demo-model.js";

// A catalog shaped like skillCatalog() rows (name/description/refId) — a few
// on-demand built-ins + one imported skill, mirroring the real recipe set.
const CATALOG = [
  { id: "tab-hygiene", refId: "builtin:tab-hygiene", name: "Tab hygiene", description: "Find duplicate/stale tabs and close or group them." },
  { id: "page-summary", refId: "builtin:page-summary", name: "Summarise this page", description: "Read the active tab and give a tight summary." },
  { id: "browser-testing", refId: "imported:browser-testing", name: "Browser testing", description: "Control the browser: open tabs, navigate, click, capture screenshots." },
  { id: "save-quote", refId: "builtin:save-quote", name: "Save quote", description: "Save selected text as a quote with source attribution." },
  { id: "link-collector", refId: "builtin:link-collector", name: "Collect links", description: "Gather the outbound links from the active page." },
];

// The run seam composes exactly the way the agent boundary does: the baseline
// hub prompt, then the run's skills, then the promotion text, all re-inserted
// BEFORE the trailing protected policy.
function compose(task, { skills = [], promotion = null } = {}) {
  return appendSkillsLayer(baselineSystemPrompt("cap.hub.master"), skills, undefined, null, promotion);
}

// ── relevance heuristic unit checks ─────────────────────────────────────────
Deno.test("promotion: keyword relevance is deterministic and term-aware", () => {
  assertEquals(relevanceScore("control the browser and open a new tab", CATALOG[2]), 4, "browser-testing matches browser/control/open/tab");
  assertEquals(relevanceScore("close duplicate tabs", CATALOG[0]), 3, "tab-hygiene matches tab/duplicate/close");
  assertEquals(relevanceScore("write a poem about the sea", CATALOG[0]), 0, "no overlap → zero");
  // Plural de-pluralization: "tabs" → "tab" matches the skill name "Tab hygiene".
  assertEquals(relevanceScore("how do I merge duplicate tabs", CATALOG[0]), 2, "tabs → tab + duplicate");
});

// ── EVAL SCENARIO 1: task mentions browser control → browser skill promoted ─
Deno.test("eval: a browser-control task promotes the browser skill, bounded", () => {
  const task = "Go to example.com, click the buy button, and capture a screenshot.";
  const promo = promoteSkills({ task, catalog: CATALOG });
  assert(promo !== null, "a promotion section exists");
  assertStringIncludes(promo, "browser-testing");
  assertStringIncludes(promo, "adopt with /skill:imported:browser-testing");
  assertStringIncludes(promo, "skill_read");
  assert(promo.length <= PROMOTION_BUDGET, `section stays within budget (${promo.length} ≤ ${PROMOTION_BUDGET})`);
  // The section never leaks skill BODIES — only name + one-line description.
  assert(!/adopt with \/skill:.*(?:open tabs, navigate|— .{0,30}— .{0,30}—)/.test(promo), "no body text leaks");
  // And the COMPOSED prompt carries the section, before the protected block —
  // exactly once (a double composition can never double-insert it).
  const composed = compose(task, { promotion: promo });
  assertStringIncludes(composed, "## Skills you can adopt for this task");
  assertStringIncludes(composed, "browser-testing");
  assertEquals(composed.split("## Skills you can adopt for this task").length - 1, 1, "the section composes exactly once");
  assert(composed.endsWith(PROTECTED_CONSTRAINTS), "protected policy stays the final layer");
});

// ── EVAL SCENARIO 2: task with no relevant skill → NO promotion section ────
Deno.test("eval: a task with no matching skill yields no promotion section", () => {
  const promo = promoteSkills({ task: "Write a haiku about autumn leaves", catalog: CATALOG });
  assertEquals(promo, null, "no relevant skill → null");
  const composed = compose("Write a haiku about autumn leaves", { promotion: promo });
  assert(!composed.includes("Skills you can adopt"), "composed prompt stays clean");
});

// ── EVAL SCENARIO 3: adopted skill → body composes, NO promotion for it ────
Deno.test("eval: an adopted skill composes its body and is never re-promoted", () => {
  const adopted = new Set(["builtin:tab-hygiene"]);
  const promo = promoteSkills({ task: "Clean up my duplicate tabs", catalog: CATALOG, adoptedIds: adopted });
  assert(promo !== null, "other skills may still be promoted");
  assert(!promo.includes("tab-hygiene"), "adopted skill is not re-promoted");
  const composed = compose("Clean up my duplicate tabs", {
    skills: [{ name: "Tab hygiene", description: "Find duplicate/stale tabs", prompt: "FULL BODY: close duplicates." }],
    promotion: promo,
  });
  assertStringIncludes(composed, "FULL BODY: close duplicates.");
  assert(
    composed.indexOf("FULL BODY") < composed.indexOf("Skills you can adopt"),
    "the adopted skill body composes BEFORE the promotion section",
  );
  assert(composed.endsWith(PROTECTED_CONSTRAINTS), "protected block stays last");
});

// ── EVAL SCENARIO 4: skill_read works for an UNADOPTED catalog skill ───────
// (documented in the promotion section: read on demand without adopting)
Deno.test("eval: promotion text teaches the on-demand read path (skill_read)", () => {
  const promo = promoteSkills({ task: "Summarise this page", catalog: CATALOG });
  assert(promo !== null);
  assertStringIncludes(promo, "read via skill_read");
  assertStringIncludes(promo, "or read it on demand with skill_read without adopting");
});

// ── EVAL SCENARIO 5: ALL relevant skills adopted → no promotion section ────
Deno.test("eval: when every relevant skill is adopted, no promotion is emitted", () => {
  const adopted = new Set(CATALOG.map((s) => s.refId));
  const promo = promoteSkills({ task: "control the browser and merge my tabs", catalog: CATALOG, adoptedIds: adopted });
  assertEquals(promo, null, "nothing left to promote");
});

// ── EVAL SCENARIO 6: budget is honored under a skill-heavy task ────────────
Deno.test("eval: a task naming many skills stays within the char budget", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `skill-${i}`,
    refId: `builtin:skill-${i}`,
    name: `Skill number ${i}`,
    description: `Handle concern ${i}: tabs, browser, screenshots, links, quotes, reading.`,
  }));
  const promo = promoteSkills({ task: "tabs browser screenshots links quotes reading", catalog: many });
  assert(promo !== null);
  assert(promo.length <= PROMOTION_BUDGET, `budget respected (${promo.length} ≤ ${PROMOTION_BUDGET})`);
  assertStringIncludes(promo, "## Skills you can adopt for this task");
  assertStringIncludes(promo, "skill_read", "instructions survive the trim");
});

// ── EVAL SCENARIO 7: composition order — promotion between skills and policy ─
Deno.test("eval: the promotion layer lands between skills and the protected block", () => {
  const promo = promoteSkills({ task: "control the browser", catalog: CATALOG });
  const composed = compose("control the browser", {
    skills: [{ name: "Save quote", description: "Save selected text" }],
    promotion: promo,
  });
  const iSkill = composed.indexOf("Save quote");
  const iPromo = composed.indexOf("Skills you can adopt");
  const iPolicy = composed.indexOf("Safety constraints");
  assert(iSkill > -1 && iPromo > -1 && iPolicy > -1, "all three sections present");
  assert(iSkill < iPromo && iPromo < iPolicy, "skills → promotion → protected block order");
});

// ── EVAL SCENARIO 8: the promotion marker reports the wire, once ───────────
// @demo-promotion is the DI test surface: the demo model echoes ONLY its own
// system prompt, so the report is evidence the promotion text reached the
// wire. The double-fire guard re-emits the prior report verbatim, so a
// resumed/re-driven run can never produce a SECOND, different report.
Deno.test("eval: the promotion marker reports the section from the wire, without double-fire", async () => {
  const model = createDemoModel();
  const heading = "## Skills you can adopt for this task\n- Browser testing — Control the browser. (adopt with /skill:imported:browser-testing or read via skill_read)";
  const withSection = [
    { role: "system", content: [{ type: "text", text: `hub manual\n\n${heading}\n\nSafety constraints` }] },
    { role: "user", content: [{ type: "text", text: "@demo-promotion control the browser and capture a screenshot" }] },
  ];
  const first = await model.doGenerate({ prompt: withSection });
  const firstText = first.content.find((p) => p.type === "text")?.text ?? "";
  assert(/\[demo model\] promotion: present/.test(firstText), `reports the section: ${firstText}`);
  assertStringIncludes(firstText, "browser-testing");

  // A second invocation carrying the first report (a resumed run) re-emits
  // the SAME report — the marker never double-fires a fresh one. The system
  // prompt changing between turns (e.g. the skill was adopted, so the section
  // is gone) must NOT flip the report to "absent": the single first answer is
  // authoritative. Without the prior-report guard this invocation would
  // recompute and contradict run 1 (RED); with it, the exact report returns.
  const resumed = [
    { role: "system", content: [{ type: "text", text: "hub manual\n\nSafety constraints" }] },
    { role: "user", content: [{ type: "text", text: "@demo-promotion control the browser and capture a screenshot" }] },
    { role: "assistant", content: [{ type: "text", text: firstText }] },
    { role: "user", content: [{ type: "text", text: "continue working on the task" }] },
  ];
  const second = await model.doGenerate({ prompt: resumed });
  const secondText = second.content.find((p) => p.type === "text")?.text ?? "";
  assertEquals(secondText, firstText, "the prior report is re-emitted verbatim — no double-fire");
});

// ── EVAL SCENARIO 9: the marker reports ABSENT when no section composed ────
Deno.test("eval: an unrelated task's wire carries no promotion (marker reports absent)", async () => {
  const model = createDemoModel();
  const noSection = [
    { role: "system", content: [{ type: "text", text: "hub manual\n\nSafety constraints" }] },
    { role: "user", content: [{ type: "text", text: "@demo-promotion write a haiku about autumn" }] },
  ];
  const out = await model.doGenerate({ prompt: noSection });
  const text = out.content.find((p) => p.type === "text")?.text ?? "";
  assert(/\[demo model\] promotion: absent/.test(text), `reports absent: ${text}`);
});

// ── FALSIFICATION: revert the seam → scenario 1 goes RED ───────────────────
Deno.test("eval falsification: without the promotion seam the browser scenario has no section", () => {
  // Simulates the pre-fix code path: the composed prompt is built WITHOUT the
  // promotion text threaded through — the section must be absent.
  const composed = compose("Go to example.com and capture a screenshot.", { promotion: null });
  assert(!composed.includes("Skills you can adopt"), "pre-fix composed prompt carries no promotion section");
  // And with the seam wired, it does (the RED→GREEN proof for scenario 1).
  const promo = promoteSkills({ task: "Go to example.com and capture a screenshot.", catalog: CATALOG });
  assert(promo !== null);
  assertStringIncludes(compose("Go to example.com and capture a screenshot.", { promotion: promo }), "## Skills you can adopt for this task");
});

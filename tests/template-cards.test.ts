// tests/template-cards.test.ts — the template GALLERY is the first-class way to
// create an agent (CAP-FB-20260830-AGENT-TEMPLATES-INTEGRATION-01; reverses the
// select-only direction of the abandoned CAP-FB-20260829-TEMPLATE-CARDS-01 on
// the owner's 2026-08-30 "integrate the templates" directive). The card and the
// gallery are shared components; the create dialog composes them; the old
// "Start from a template" select is gone (replaced, not duplicated).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { AGENT_TEMPLATES, STARTER_TEMPLATE_IDS } from "../extension/lib/agent-templates.js";

const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
const gallery = await Deno.readTextFile(new URL("../docs/components.html", import.meta.url));

Deno.test("template cards: shared component renders persona, bounded skill badges, starter state and Use", () => {
  assertStringIncludes(components, 'customElements.define("agent-template-card"');
  assertStringIncludes(components, "skills.slice(0, 3)");
  assertStringIncludes(components, "skills.length - shownSkills.length");
  assertStringIncludes(components, ">Starter</span>");
  assertStringIncludes(components, 'this._emit("use", { id: this.hasAttribute("blank") ? "" : String(template?.id ?? ""), template })');
  assertStringIncludes(components, '<button class="use" type="button"');
});

Deno.test("template cards: selected state, display-name chips, blank variant and whole-card activation", () => {
  const card = components.slice(components.indexOf("class AgentTemplateCard"), components.indexOf('customElements.define("agent-template-card"'));
  assertStringIncludes(card, 'return ["starter", "selected", "blank"]');
  assertStringIncludes(card, 'aria-pressed="${selected ? "true" : "false"}"', "the Use button exposes the selected state");
  assertStringIncludes(card, "set skillNames(", "skill chips take display names from the skills registry");
  assertStringIncludes(card, "Custom agent", "the blank variant is the start-from-scratch card");
  assertStringIncludes(card, 'article?.addEventListener("click"', "the whole card activates the Use button");
  assert(!card.includes("innerHTML ="), "no innerHTML assignment in the card");
});

Deno.test("template gallery: one shared component with filters, a grid and roving tabindex", () => {
  assertStringIncludes(components, 'customElements.define("agent-template-gallery"');
  const gal = components.slice(components.indexOf("class AgentTemplateGallery"), components.indexOf('customElements.define("agent-template-gallery"'));
  assertStringIncludes(gal, "repeat(auto-fill, minmax(");
  assertStringIncludes(gal, 'aria-pressed', "filter buttons expose their pressed state");
  assertStringIncludes(gal, "ArrowRight", "arrow keys move focus between cards (roving tabindex)");
  assertStringIncludes(gal, "tabindex", "one tab stop for the grid");
  for (const f of ["starter", "all", "scheduled"]) assertStringIncludes(gal, `"${f}"`);
});

Deno.test("create-agent dialog composes the gallery and the template select is gone", () => {
  assertEquals(STARTER_TEMPLATE_IDS.length, 7);
  assert(AGENT_TEMPLATES.length >= STARTER_TEMPLATE_IDS.length);
  assertStringIncludes(ntp, 'document.createElement("agent-template-gallery")');
  assertStringIncludes(ntp, "recipeAsTemplate");
  assertStringIncludes(ntp, 'gallery.addEventListener("use"');
  // Replaced, not duplicated: the select-based picker is gone for good.
  assert(!ntp.includes('id = "agent-template-select"'), "the template select must not come back");
  assert(!ntp.includes('templateSelect.setAttribute("placeholder", "Custom agent")'));
  // "Add starter agents" no longer creates seven agents silently — it opens the
  // gallery on the Starter filter.
  assert(!/for \(const id of STARTER_TEMPLATE_IDS\) \{\s*const t = agentTemplateById\(id\);/.test(ntp), "no silent seven-agent creation");
  assertStringIncludes(ntp, "Choose a template or start from scratch.");
});

Deno.test("Settings offers the same scheduled catalogue through the same gallery component", () => {
  assertStringIncludes(options, 'document.createElement("agent-template-gallery")');
  assertStringIncludes(options, 'setAttribute("filters", "scheduled")');
  assert(!options.includes('empty.textContent = "Choose a background agent…"'), "the select-based picker is replaced");
});

Deno.test("template cards + gallery: component gallery documents the reusable primitives", () => {
  assertStringIncludes(gallery, "&lt;agent-template-card&gt;");
  assertStringIncludes(gallery, 'id="agent-template-demo"');
  assertStringIncludes(gallery, "&lt;agent-template-gallery&gt;");
  assertStringIncludes(gallery, 'id="agent-template-gallery-demo"');
});

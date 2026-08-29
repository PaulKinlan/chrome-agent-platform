import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { AGENT_TEMPLATES, STARTER_TEMPLATE_IDS } from "../extension/lib/agent-templates.js";

const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const gallery = await Deno.readTextFile(new URL("../docs/components.html", import.meta.url));

Deno.test("template cards: shared component renders persona, bounded skill badges, starter state and Use", () => {
  assertStringIncludes(components, 'customElements.define("agent-template-card"');
  assertStringIncludes(components, "skills.slice(0, 3)");
  assertStringIncludes(components, "skills.length - shownSkills.length");
  assertStringIncludes(components, ">Starter</span>");
  assertStringIncludes(components, 'this._emit("use", { id: template.id })');
  assertStringIncludes(components, '<button class="use" type="button"');
});

Deno.test("template cards: picker is a starter-first visual gallery using the landed catalogue", () => {
  assertEquals(STARTER_TEMPLATE_IDS.length, 7);
  assert(AGENT_TEMPLATES.length >= STARTER_TEMPLATE_IDS.length);
  assertStringIncludes(ntp, 'document.createElement("agent-template-card")');
  assertStringIncludes(ntp, 'card.toggleAttribute("starter", starterIds.has(t.id))');
  assertStringIncludes(ntp, 'card.addEventListener("use"');
  assertStringIncludes(ntp, "STARTER_TEMPLATE_IDS.map(agentTemplateById)");
  assertStringIncludes(ntp, 'firstTemplateUse.focus()');
  assert(!ntp.includes('const tplSelect = document.createElement("select")'), "plain select picker must be removed");
});

Deno.test("template cards: component gallery documents the reusable primitive", () => {
  assertStringIncludes(gallery, "&lt;agent-template-card&gt;");
  assertStringIncludes(gallery, 'id="agent-template-demo"');
});

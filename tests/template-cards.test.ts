// tests/template-cards.test.ts — the template CATALOGUE (CAP-FB-20260830-
// AGENT-TEMPLATES-INTEGRATION-01) is the first-class way to create an agent.
// The card + gallery remain the SHARED catalogue components (Settings' scheduled
// gallery uses them); the CREATE dialog now offers the catalogue as a native,
// searchable, grouped <select> (CAP-FB-20260831-TEMPLATE-CUSTOM-SELECT-01 —
// owner directive: customizable-select elements, keeping the Starter / Other /
// Scheduled grouping).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { AGENT_TEMPLATES, STARTER_TEMPLATE_IDS } from "../extension/lib/agent-templates.js";

const components = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));
const ntp = await Deno.readTextFile(new URL("../extension/ntp/ntp.js", import.meta.url));
const options = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
const gallery = await Deno.readTextFile(new URL("../docs/components.html", import.meta.url));
const picker = await Deno.readTextFile(new URL("../extension/lib/agent-template-select.js", import.meta.url));

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

Deno.test("create-agent dialog composes the template SELECT; the gallery grid is gone from the create flow", () => {
  assertEquals(STARTER_TEMPLATE_IDS.length, 7);
  assert(AGENT_TEMPLATES.length >= STARTER_TEMPLATE_IDS.length);
  // The create dialog offers the catalogue through the searchable grouped
  // native select (owner directive, CAP-FB-20260831-TEMPLATE-CUSTOM-SELECT-01).
  assertStringIncludes(ntp, 'import { buildTemplateSelect } from "../lib/agent-template-select.js"');
  assertStringIncludes(ntp, "blankLabel: \"Custom agent — start from a blank agent.\"");
  assertStringIncludes(ntp, "recipeAsTemplate");
  // The gallery grid is no longer composed in the CREATE dialog (Settings'
  // scheduled gallery still uses it — a different surface, same catalogue).
  assert(!ntp.includes('document.createElement("agent-template-gallery")'), "the create dialog no longer builds the gallery grid");
  // "Add starter agents" no longer creates seven agents silently — it opens
  // the create flow with the grouped select (Starter group first).
  assert(!/for \(const id of STARTER_TEMPLATE_IDS\) \{\s*const t = agentTemplateById\(id\);/.test(ntp), "no silent seven-agent creation");
  assertStringIncludes(ntp, "Choose a template or start from scratch.");
});

Deno.test("template select module: grouping, filtering, feature-detect and option labels", async () => {
  const mod = await import("../extension/lib/agent-template-select.js");
  assertStringIncludes(picker, "appearance\", \"base-select\")", "feature-detects the Customizable Select API");
  assertStringIncludes(picker, 'document.createElement("selectedcontent")', "the select button mirrors the chosen option");
  assertStringIncludes(picker, 'optgroup', "options are grouped");
  const grouped = mod.groupTemplates([
    { id: "a", name: "A", starter: true },
    { id: "b", name: "B" },
    { id: "c", name: "C", mode: "background" },
  ] as Array<Record<string, unknown>>);
  assertEquals(grouped.map((g) => g.label), ["Starter", "Other", "Scheduled"]);
  assertEquals(grouped[0].items.map((t) => String((t as { id: string }).id)), ["a"]);
  assertEquals(grouped[1].items.map((t) => String((t as { id: string }).id)), ["b"]);
  assertEquals(grouped[2].items.map((t) => String((t as { id: string }).id)), ["c"]);
  assert(mod.templateMatchesQuery({ name: "Price watcher", description: "alert me" }, "price"));
  assert(!mod.templateMatchesQuery({ name: "Price watcher" }, "zebra"));
  const filtered = mod.filterGroupedTemplates(grouped, "c");
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].label, "Scheduled");
  assert(mod.supportsCustomSelect() === false, "jsr/deno has no CSS.supports — the pure fallback is false");
  assertEquals(mod.optionLabel({ name: "X", description: "Y" }), "X — Y");
  assertEquals(mod.optionLabel({ name: "X" }), "X");
});

Deno.test("template select module: WCAG contrast is real math and rejects a low-contrast fixture", async () => {
  const mod = await import("../extension/lib/agent-template-select.js");
  // Good pair: dark text on white passes AA (>= 4.5).
  assert(mod.wcagContrast([29, 27, 24], [255, 255, 255]) >= mod.CONTRAST_AA_TEXT, "near-black on white is readable");
  // Light text on the dark panel also passes.
  assert(mod.wcagContrast([234, 230, 222], [35, 33, 29]) >= mod.CONTRAST_AA_TEXT, "near-white on charcoal is readable");
  // DELIBERATE LOW-CONTRAST FIXTURE: mid-grey on white must FAIL AA (the RED
  // detector — the journey check uses this exact math, so a regressed token
  // pair that drops below 4.5 turns the journey red).
  assert(mod.wcagContrast([160, 160, 160], [255, 255, 255]) < mod.CONTRAST_AA_TEXT, "grey-on-white is not AA text");
  assertEquals(mod.relativeLuminance([0, 0, 0]), 0, "black has zero luminance");
  assertEquals(mod.relativeLuminance([255, 255, 255]), 1, "white has full luminance");
  // parseRgb handles rgb()/rgba()/hex/space-separated/srgb and alpha compositing.
  assertEquals(mod.parseRgb("rgb(255, 255, 255)"), [255, 255, 255]);
  assertEquals(mod.parseRgb("rgb(29 27 24)"), [29, 27, 24]);
  assertEquals(mod.parseRgb("#1d1b18"), [29, 27, 24]);
  assertEquals(mod.parseRgb("color(srgb 1 0.5 0)"), [255, 128, 0]);
  assertEquals(mod.parseRgb("rgba(0, 0, 0, 0.5)", [255, 255, 255]), [128, 128, 128]);
  assertEquals(mod.parseRgb("bogus"), null);
});

Deno.test("template select module: selection survives filtering (retained hidden option) and the picker is styled for dark", async () => {
  const mod = await import("../extension/lib/agent-template-select.js");
  // P1a (sol r1): the refresh rebuild must retain a filtered-out selection as
  // a hidden option so the native value never silently resets. The source
  // pins the retained-option branch (kept value + hidden option re-appended).
  assertStringIncludes(picker, 'retained.hidden = true', "a filtered-out selection is retained as a hidden option");
  assertStringIncludes(picker, 'const keep = select.value;', "the current value is preserved across re-renders");
  assertStringIncludes(picker, 'select.value = keep || "";', "the preserved value is re-applied after the rebuild");
  // P1b (sol r1, hardened r5): the customizable picker popup is styled with
  // EXPLICIT scheme blocks (light defaults + a prefers-color-scheme dark
  // override) so the open popup is never a white-on-white/low-contrast popup
  // in dark mode even where light-dark() doesn't resolve in the picker pseudo.
  assertStringIncludes(picker, "::picker(select)", "the picker popup is styled");
  assertStringIncludes(picker, "prefers-color-scheme: dark", "an explicit dark scheme block styles the popup");
  assertStringIncludes(picker, "#23211d", "the dark popup background is the charcoal panel token");
  assertStringIncludes(picker, "#eae6de", "the dark popup text is the light text token");
  // The light-dark() tokens are ALSO present (alongside the explicit blocks) so
  // engines that resolve them get the identical scheme (r6 REVISE: the
  // reviewer flagged light-dark() absence — both forms are now declared).
  assertStringIncludes(picker, "light-dark(#ffffff, #23211d)", "light-dark() popup background is declared alongside the explicit block");
  assertStringIncludes(picker, "light-dark(#1d1b18, #eae6de)", "light-dark() popup text is declared");
  assertStringIncludes(picker, "option:hover", "picker option hover state is styled");
  assertStringIncludes(picker, "option:checked", "picker option checked state is styled");
  // r5 P2: exactly one chevron — the browser default ::picker-icon is
  // suppressed so only the custom button icon renders.
  assertStringIncludes(picker, "::picker-icon { display: none; }", "the duplicate default chevron is suppressed");
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

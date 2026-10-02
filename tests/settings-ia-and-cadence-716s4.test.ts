// tests/settings-ia-and-cadence-716s4.test.ts — Settings IA, templates disclosure, cadence formatter (chrome-agent-platform-716s.4)
import { assert, assertEquals } from "jsr:@std/assert@1";
import { formatCadenceMinutes } from "../extension/lib/next-run-label.js";

const HTML = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
const CSS = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));
const JS = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));
const COMPONENTS_JS = await Deno.readTextFile(new URL("../extension/shared/components.js", import.meta.url));

Deno.test("716s.4 cadence formatter: humanises period in minutes to plain English labels", () => {
  assertEquals(formatCadenceMinutes(1440), "daily");
  assertEquals(formatCadenceMinutes(60), "hourly");
  assertEquals(formatCadenceMinutes(360), "every 6 hours");
  assertEquals(formatCadenceMinutes(10080), "weekly");
  assertEquals(formatCadenceMinutes(15), "every 15 min");
  assertEquals(formatCadenceMinutes(120), "every 2 hours");
  assertEquals(formatCadenceMinutes(2880), "every 2 days");
  assertEquals(formatCadenceMinutes(20160), "every 2 weeks");
});

Deno.test("716s.4 AgentTemplateCard: uses formatCadenceMinutes and secondary Use button (no 1440 min or accent fill)", () => {
  assert(!COMPONENTS_JS.includes("every ${minutes} min"), "AgentTemplateCard must not use raw 'every ${minutes} min'");
  assert(COMPONENTS_JS.includes("formatCadenceMinutes"), "AgentTemplateCard must use formatCadenceMinutes");
  // Check that the Use button is styled as a calm secondary button, not filled accent
  const cardStyles = COMPONENTS_JS.slice(COMPONENTS_JS.indexOf("class AgentTemplateCard"), COMPONENTS_JS.indexOf("class AgentTemplateGallery"));
  assert(!cardStyles.includes("background:var(--accent"), "AgentTemplateCard .use button must not be filled accent background");
});

Deno.test("716s.4 Settings navigation IA: nav shows 6 group headings and retains all 15 sections", () => {
  const groupHeadings = [...HTML.matchAll(/<span\s+class="nav-group-title"[^>]*>([^<]+)<\/span>/g)].map((m) => m[1].replace(/&amp;/g, "&").trim());
  assertEquals(groupHeadings.length, 6, "nav must have exactly 6 architectural group headings");
  assertEquals(groupHeadings, [
    "Models & spend",
    "Agents",
    "Skills & tools",
    "Automation",
    "Permissions & folders",
    "Data & backup",
  ]);

  // Group headers must be collapsible buttons with aria-expanded
  const headers = [...HTML.matchAll(/<button[^>]*class="nav-group-header"[^>]*aria-expanded="true"[^>]*>/g)];
  assertEquals(headers.length, 6, "each group must have an accordion header button with aria-expanded='true'");

  // All 15 section panels are preserved and match navigation in order
  const sections = [...HTML.matchAll(/<section\s+id="([^"]+)"\s+class="panel(?:\s+active)?"/g)].map((m) => m[1]);
  const navItems = [...HTML.matchAll(/<a\s+href="#([^"]+)"\s+class="nav-item"\s+data-section="\1"/g)].map((m) => m[1]);
  assertEquals(sections.length, 15, "all 15 panels exist");
  assertEquals(navItems.length, 15, "all 15 nav items exist");
  assertEquals(navItems, sections, "nav items and sections must match in panel order");
});

Deno.test("716s.4 Starter templates disclosure: agent and skill templates wrap in collapsed details", () => {
  // options.js must wrap background agent gallery in starter-templates-disclosure
  assert(
    JS.includes('class="starter-templates-disclosure"') || JS.includes("starter-templates-disclosure"),
    "options.js must use starter-templates-disclosure",
  );
  assert(
    JS.includes("Browse starter templates…") || JS.includes("starter-templates-disclosure"),
    "options.js must provide starter templates disclosure summary",
  );

  // CSS must style .starter-templates-disclosure
  assert(CSS.includes(".starter-templates-disclosure"), "options.css must style .starter-templates-disclosure");
});

Deno.test("716s.4 Usage panel: hides estimated cost line when cost is 0", () => {
  const usageRender = JS.slice(JS.indexOf("async function renderUsage"), JS.indexOf("// ── Charts"));
  assert(
    usageRender.includes("safe.estimatedCost > 0") || usageRender.includes("estimatedCost > 0"),
    "renderUsage must conditionally include estimated cost only when > 0",
  );
});

Deno.test("716s.4 Skills filter bar and max-height: search input, count, and constrained list", async () => {
  const SKILLS_PANEL_JS = await Deno.readTextFile(new URL("../extension/skills/skills-panel.js", import.meta.url));
  assert(HTML.includes('class="skills-filter-bar"'), "options.html has skills-filter-bar");
  assert(HTML.includes("skills-search"), "options.html has skills-search input");
  assert(HTML.includes("skills-count"), "options.html has skills-count status span");
  assert(SKILLS_PANEL_JS.includes(".skills-search"), "skills-panel.js wires search input");
  assert(SKILLS_PANEL_JS.includes(".skills-count"), "skills-panel.js updates count status");
  assert(CSS.includes("#skills .skills-list"), "options.css styles #skills .skills-list");
  assert(CSS.includes("max-height: 960px"), "options.css constrains #skills .skills-list to under 1600px");
});

Deno.test("716s.4 Nav group accordions & keyboard: wireNavGroupAccordions and expandNavGroup", () => {
  assert(JS.includes("wireNavGroupAccordions"), "options.js exports wireNavGroupAccordions");
  assert(JS.includes("expandNavGroup"), "options.js exports expandNavGroup");
  assert(JS.includes("collapseNavGroup"), "options.js exports collapseNavGroup");
  assert(JS.includes("ArrowDown") && JS.includes("ArrowUp"), "options.js supports arrow key navigation");
});

Deno.test("716s.4 Deep link journey: every previous #section ID resolves to a valid panel and nav item", () => {
  const SECTIONS = [
    "providers",
    "usage",
    "agents",
    "board-permissions",
    "skills",
    "mcp-servers",
    "user-wasm",
    "tool-library",
    "hooks",
    "prompts",
    "browser",
    "permissions",
    "local-folders",
    "data",
    "about",
  ];
  for (const id of SECTIONS) {
    assert(HTML.includes('id="' + id + '"'), `panel #${id} must exist in options.html`);
    assert(HTML.includes('href="#' + id + '"'), `nav link for #${id} must exist in options.html`);
    assert(HTML.includes('data-section="' + id + '"'), `data-section="${id}" must exist in options.html`);
  }
});


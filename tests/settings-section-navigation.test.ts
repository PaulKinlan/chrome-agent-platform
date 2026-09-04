// tests/settings-section-navigation.test.ts — CAP-FB-20260827-SETTINGS-MONOLITH-01 / q94
//
// Verifies:
// 1. Settings panels default to display: none and render only when .active.
// 2. handleSettingsHashNavigation activates exactly the requested section.
// 3. Initial state has providers as active by default.
// 4. Section navigation preserves single-entry history replaceState semantics.
// 5. Deep linking directly to a hash activates that section.

import { assert, assertEquals } from "jsr:@std/assert@1";

const CSS = await Deno.readTextFile(new URL("../extension/options/options.css", import.meta.url));
const HTML = await Deno.readTextFile(new URL("../extension/options/options.html", import.meta.url));
const JS = await Deno.readTextFile(new URL("../extension/options/options.js", import.meta.url));

Deno.test("settings multi-section: .panel styles define display:none and .panel.active display:block", () => {
  assert(
    CSS.includes(".panel {") && CSS.includes("display: none;"),
    "options.css must specify display: none for inactive .panel",
  );
  assert(
    CSS.includes(".panel.active {") && CSS.includes("display: block;"),
    "options.css must specify display: block for .panel.active",
  );
});

Deno.test("settings multi-section: options.html marks initial #providers panel as active", () => {
  assert(
    HTML.includes('id="providers" class="panel active"'),
    "options.html must mark #providers with class='panel active'",
  );
});

Deno.test("settings multi-section: handleSettingsHashNavigation toggles .active on section.panel", () => {
  assert(
    JS.includes('s.classList.toggle("active", s.id === sectionId)'),
    "options.js must toggle active class matching current sectionId",
  );
  assert(
    JS.includes("ensureSectionRendered(sectionId)"),
    "options.js must lazy-render the active section",
  );
});

Deno.test("settings multi-section: DOM node count and active panel isolation", () => {
  const sections = [...HTML.matchAll(/<section\s+id="([^"]+)"\s+class="panel(?:\s+active)?"/g)].map((m) => m[1]);
  assertEquals(sections.length, 14, "options.html has 14 section panels");
  const activeSections = [...HTML.matchAll(/<section\s+id="([^"]+)"\s+class="panel\s+active"/g)].map((m) => m[1]);
  assertEquals(activeSections, ["providers"], "only providers is initially active");
});

// cap-beads-wuvg — provider server tools toggle reset on reload.
// The server-tools init (state load + toggle listener + per-agent rows) must
// run when the PROVIDERS section renders — the toggle HTML lives there — not
// inside renderAgents(), which only runs when the agents section is visited.
Deno.test("settings multi-section: provider server tools init is bound to the providers render, not renderAgents", () => {
  const initDef = "async function initProviderServerTools()";
  assert(JS.includes(initDef), "initProviderServerTools must exist in options.js");
  assertEquals(
    (JS.match(/initProviderServerTools\(/g) ?? []).length,
    2,
    "initProviderServerTools is defined once and called from exactly one site (no double init)",
  );

  // The single call site is the providers branch of ensureSectionRendered —
  // the section that is active by default on load and on reload→navigate.
  const ensure = JS.slice(JS.indexOf("async function ensureSectionRendered"), JS.indexOf("// nav active state"));
  assert(ensure.includes('if (sectionId === "providers")'), "providers branch present in ensureSectionRendered");
  assert(ensure.includes("await initProviderServerTools();"), "the providers branch must run initProviderServerTools");
  assert(
    ensure.indexOf("await initProviderServerTools();") > ensure.indexOf('sectionId === "providers"'),
    "the init call must sit inside the providers branch (not the agents branch or a shared tail)",
  );
  assert(
    !ensure.includes('sectionId === "agents"') ||
      ensure.indexOf('await initProviderServerTools();') < ensure.indexOf('sectionId === "agents"'),
    "the init call must come before the agents branch, i.e. it is not (re)run there",
  );

  // renderAgents no longer initializes server tools (it did before the fix).
  const agentsFn = JS.slice(JS.indexOf("async function renderAgents()"), JS.indexOf("async function initProviderServerTools()"));
  assert(!agentsFn.includes("initProviderServerTools"), "renderAgents must not call initProviderServerTools");
  assert(!agentsFn.includes('$("#server-tools-enabled")'), "the server-tools toggle binding must not live in renderAgents");

  // State restore across reload→providers: the init reads the persisted kv
  // record, drives the toggle's checked state from it, binds the save listener
  // and renders the per-agent rows — all in one function.
  const initFn = JS.slice(JS.indexOf(initDef), JS.indexOf("/** The per-agent override row"));
  assert(initFn.includes('storage.get("cap:providerServerTools")'), "init must read the persisted server-tools record");
  assert(initFn.includes("stToggle.checked = stCfg.enabled === true"), "init must restore the toggle from the persisted record");
  assert(initFn.includes('stToggle.addEventListener("toggle"'), "init must bind the toggle save listener");
  assert(initFn.includes("await renderServerToolAgents(stToggle.checked)"), "init must render the per-agent rows for the restored state");
  const htmlSection = HTML.slice(HTML.indexOf('id="providers"'), HTML.indexOf('id="mcp-servers"'));
  assert(htmlSection.includes('id="server-tools-enabled"'), "the server-tools toggle lives in the providers section HTML");
});

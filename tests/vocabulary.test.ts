// tests/vocabulary.test.ts — CAP-FB-20260828-NOUN-DISCIPLINE-01.
//
// One name per concept. Two halves:
//
//  1. FALSIFICATION. Every rule in scripts/check-vocabulary.mjs is fed the
//     EXACT pre-fix source that shipped (the "Assets" sidebar button, the two
//     openView titles for one view, the drawer's "Recent assets", the
//     "Agents"-inside-"Agents" card, the duplicated aria-label) and must report
//     a violation. A guard that has never been observed firing is not a guard,
//     and the corresponding "clean" input must report nothing so the rule is
//     not just returning true.
//
//  2. THE SHIPPED SURFACES. Positive pins on the names that are now correct, so
//     a future edit that reintroduces the old noun fails here as well as in the
//     build gate.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkVocabulary, scanSource } from "../scripts/check-vocabulary.mjs";

const ruleIds = (violations: Array<{ rule: string }>) => violations.map((v) => v.rule);

// ── 1. falsification ──────────────────────────────────────────────────────

Deno.test("falsification: the shipped 'Assets' sidebar button is REPORTED", () => {
  // Verbatim from ntp.html before this change.
  const before = `<div class="side-foot">
    <button class="btn ghost foot-btn" id="open-assets" type="button" title="Assets" aria-label="Assets">
      <span class="btn-label">Assets</span>
    </button>
    <asset-quick-drawer id="asset-quick-drawer" auto origin="master" label="Quick access assets"></asset-quick-drawer>
  </div>`;
  const found = scanSource("extension/ntp/ntp.html", before);
  assert(
    ruleIds(found).includes("banned-term:assets"),
    `the pre-fix Assets button must be reported, got ${JSON.stringify(ruleIds(found))}`,
  );

  const after = `<div class="side-foot">
    <button class="btn ghost foot-btn" id="open-artifacts" type="button" title="Artifacts" aria-label="Artifacts">
      <span class="btn-label">Artifacts</span>
    </button>
    <artifact-quick-drawer id="artifact-quick-drawer" auto origin="master" label="Quick access artifacts"></artifact-quick-drawer>
  </div>`;
  assertEquals(scanSource("extension/ntp/ntp.html", after), [], "the fixed markup must report nothing");
});

Deno.test("falsification: ONE view opened with TWO titles is REPORTED", () => {
  // The exact defect named in PRODUCT.md: ntp.js opened artifacts/index.html
  // with the title "Assets" at one call site and "Artifacts" at another.
  const before = `openView("artifacts/index.html", "Assets");
openView("artifacts/index.html", "Artifacts", e.currentTarget);`;
  const found = scanSource("extension/ntp/ntp.js", before);
  assert(ruleIds(found).includes("banned-term:assets"), "the second name for the same view must be reported");

  const after = `openView("artifacts/index.html", "Artifacts");
openView("artifacts/index.html", "Artifacts", e.currentTarget);`;
  assertEquals(scanSource("extension/ntp/ntp.js", after), [], "one view, one title, reports nothing");
});

Deno.test("falsification: the drawer's rendered 'assets' copy is REPORTED (template + sinks)", () => {
  const before = 'summary.textContent = "Loading assets…";\n' +
    "const t = `<h2 id=\"asset-quick-title\">Recent assets</h2><button class=\"browse\">Browse all assets</button>`;";
  const found = scanSource("extension/shared/components.js", before);
  assert(ruleIds(found).filter((r) => r === "banned-term:assets").length >= 2, "both the sink and the template must be reported");

  const after = 'summary.textContent = "Loading artifacts…";\n' +
    "const t = `<h2 id=\"artifact-quick-title\">Recent artifacts</h2><button class=\"browse\">Browse all artifacts</button>`;";
  assertEquals(scanSource("extension/shared/components.js", after), [], "the renamed copy reports nothing");
});

Deno.test("falsification: a banned word hiding inside a template hole is REPORTED", () => {
  // `${n === 1 ? "asset" : "assets"}` is user-facing copy, not an identifier —
  // collapsing interpolations must not blind the rule to it.
  const before = 'summary.textContent = `${total} ${total === 1 ? "asset" : "assets"}.`;';
  assert(
    ruleIds(scanSource("extension/shared/components.js", before)).includes("banned-term:assets"),
    "copy written inside an interpolation must still be checked",
  );
  // …while a plain identifier reference must NOT be reported (no false positive).
  const identifierOnly = 'meta.textContent = `${asset.type} · ${asset.size} B`;';
  assertEquals(
    scanSource("extension/shared/components.js", identifierOnly),
    [],
    "an identifier inside a hole is data, not vocabulary",
  );
});

Deno.test("falsification: 'Agents' as a card heading AND a row inside it is REPORTED", () => {
  // Verbatim from ntp.html before this change.
  const before = `<section aria-label="Agents">
  <div class="panel">
    <div class="panel-head"><h2 class="t">Agents</h2></div>
    <div class="panel-subhead"><span>Agents</span><span class="hint">your agents</span></div>
    <div class="panel-subhead"><span>Site Agents</span></div>
  </div>
</section>`;
  const found = ruleIds(scanSource("extension/ntp/ntp.html", before));
  assert(found.includes("noun-nesting"), `the nested Agents/Agents must be reported, got ${JSON.stringify(found)}`);
  assert(found.includes("duplicate-accessible-name"), "the aria-label duplicating the heading must be reported");

  const after = `<section aria-labelledby="agents-panel-title">
  <div class="panel">
    <div class="panel-head"><h2 class="t" id="agents-panel-title">Agents</h2></div>
    <div class="panel-subhead"><span>Yours</span></div>
    <div class="panel-subhead"><span>Site Agents</span></div>
  </div>
</section>`;
  assertEquals(scanSource("extension/ntp/ntp.html", after), [], "one heading, distinct group labels, reports nothing");
});

Deno.test("falsification: a nested <section> does not inflate its parent's noun count", () => {
  // The sidebar nests <section id=\"failed-runs\"> inside the tasks section. A
  // naive scan would double-count across the boundary and report a false
  // positive, which is how a checker gets deleted instead of obeyed.
  const nested = `<section aria-labelledby="a"><h2 id="a">Tasks</h2>
    <section aria-label="Failed runs"><span>Tasks</span></section>
  </section>`;
  assertEquals(ruleIds(scanSource("extension/ntp/ntp.html", nested)), [], "each section is counted on its own");
});

Deno.test("falsification: a Skills DESTINATION in the sidebar is REPORTED", () => {
  const before = `<button class="btn ghost foot-btn" id="open-recipes" type="button" title="Skills">
    <span class="btn-label">Skills</span></button>`;
  assert(
    ruleIds(scanSource("extension/ntp/ntp.html", before)).includes("skills-is-not-a-destination"),
    "a sidebar Skills destination must be reported — skills live in Settings",
  );
  const beforeJs = `document.getElementById("open-recipes")?.addEventListener("click", () => openView("recipes/index.html", "Skills"));`;
  assert(
    ruleIds(scanSource("extension/ntp/ntp.js", beforeJs)).includes("skills-is-not-a-destination"),
    "opening the retired standalone Skills view must be reported",
  );
  // The permitted REDIRECT of a stale deep link is not a destination.
  const redirect = `if (String(path).split(/[?#]/, 1)[0] === "recipes/index.html") { path = "options/options.html#skills"; }`;
  assertEquals(
    ruleIds(scanSource("extension/ntp/ntp.js", redirect)).filter((r) => r === "skills-is-not-a-destination"),
    [],
    "the redirect that rescues an old deep link is allowed",
  );
});

Deno.test("falsification: user-facing 'recipe' copy is REPORTED", () => {
  const before = `<p class="muted">Agents that run quietly on a schedule (each wraps a recipe).</p>`;
  assert(
    ruleIds(scanSource("extension/options/options.html", before)).includes("banned-term:recipes"),
    "user-facing 'recipe' must be reported — the nav says Skills",
  );
  const after = `<p class="muted">Agents that run quietly on a schedule (each wraps a skill).</p>`;
  assertEquals(scanSource("extension/options/options.html", after), [], "the renamed copy reports nothing");
});

// ── 2. the shipped surfaces ───────────────────────────────────────────────

Deno.test("the shipped surfaces are clean (the gate that npm run check:vocabulary runs)", async () => {
  const violations = await checkVocabulary();
  assertEquals(
    violations,
    [],
    `vocabulary violations on the shipped surfaces:\n${
      violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join("\n")
    }`,
  );
});

Deno.test("noun discipline: Artifacts is the sidebar destination, and it has ONE title", async () => {
  const html = await Deno.readTextFile("extension/ntp/ntp.html");
  const js = await Deno.readTextFile("extension/ntp/ntp.js");

  assert(html.includes('id="open-artifacts"'), "the sidebar button is open-artifacts");
  assert(html.includes('<span class="btn-label">Artifacts</span>'), "its visible label is Artifacts");
  assert(html.includes("<artifact-quick-drawer"), "the quick drawer element is artifact-quick-drawer");
  assert(!/id="open-assets"|>Assets</.test(html), "no Assets button survives");

  // Every call site that opens the artifacts view passes the SAME title.
  const titles = [...js.matchAll(/openView\(\s*"artifacts\/index\.html"\s*,\s*"([^"]*)"/g)].map((m) => m[1]);
  assert(titles.length >= 3, `expected every artifacts openView call site, found ${titles.length}`);
  assertEquals([...new Set(titles)], ["Artifacts"], "one view must have exactly one title");
});

Deno.test("noun discipline: the quick drawer speaks artifacts (element, events, exports)", async () => {
  const components = await Deno.readTextFile("extension/shared/components.js");
  assert(
    components.includes('customElements.define("artifact-quick-drawer", ArtifactQuickDrawer)'),
    "the element is registered as artifact-quick-drawer",
  );
  for (const evt of ['"browse-artifacts"', '"artifact-open"', '"artifact-reuse"']) {
    assert(components.includes(evt), `the drawer must emit ${evt}`);
  }
  for (const exported of ["ARTIFACT_QUICK_LIMITS", "selectQuickArtifacts", "quickArtifactOwner"]) {
    assert(components.includes(`export ${exported.startsWith("select") || exported.startsWith("quick") ? "function " : "const "}${exported}`), `${exported} must be the exported name`);
  }
  assert(!components.includes("asset-quick-drawer"), "the old element name must be gone");

  // The wire ROUTE deliberately keeps its name — a persisted security boundary.
  assert(components.includes('RUNTIME_SEND("asset.list"'), "the asset.list route is intentionally unchanged");
});

Deno.test("noun discipline: agent context files do not borrow the artifact noun", async () => {
  const js = await Deno.readTextFile("extension/ntp/ntp.js");
  assert(js.includes('assetsLegend.textContent = "Context files"'), "the agent editor says Context files");
  assert(!/textContent = "Core assets"/.test(js), "the Core assets label must be gone");
  // The PERSISTED field name is unchanged — renaming stored agent data is not
  // part of a vocabulary change.
  assert(js.includes("coreAssets"), "the persisted coreAssets field is untouched");
});

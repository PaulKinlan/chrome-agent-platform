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

// ── CAP-FB-20260830-USER-VOICE-COPY-01: the system's words ────────────────

Deno.test("falsification (USER-VOICE-COPY-01): system words in a user-facing paragraph are REPORTED", () => {
  // The exact bodies the product shipped (ntp.js delete dialog + hub status).
  const before = `<section id="agents"><p class="muted">This will permanently remove the agent registry entry, its memory store, system prompt override, and custom provider configuration.</p></section>`;
  assert(
    ruleIds(scanSource("extension/options/options.html", before)).includes("banned-term:system-words"),
    "a paragraph naming a registry entry / override must be reported",
  );
  const js = 'el.textContent = "Discovery has not run yet.";\nbody: `This will cancel its scheduled task and remove the recurring alarm.`,';
  const found = scanSource("extension/ntp/ntp.js", js);
  assert(
    ruleIds(found).filter((r) => r === "banned-term:system-words").length >= 2,
    `both the status line and the dialog body must be reported, got ${JSON.stringify(found)}`,
  );
  // The user-voice replacements report nothing.
  const after = `<section id="agents"><p class="muted">Its memory and history are removed. Artifacts it made are kept.</p></section>`;
  assertEquals(scanSource("extension/options/options.html", after), []);
  assertEquals(scanSource("extension/ntp/ntp.js", 'el.textContent = "Open a site and I\'ll look for tools you can use.";'), []);
});

Deno.test("falsification (USER-VOICE-COPY-01): Advanced keeps its technical words — and only Advanced", () => {
  // A developer-only section (Settings → Advanced) may say the system's words.
  const advanced = `<section id="prompts" class="panel" data-developer="true"><h2>Advanced</h2><p>The runtime adds its attestation to the catalog generation.</p></section>`;
  assertEquals(scanSource("extension/options/options.html", advanced), [], "Advanced is exempt");
  // …but the SAME words in a sibling user-facing section are reported.
  const sibling = advanced + `<section id="agents" class="panel"><p>The runtime adds its attestation to the catalog generation.</p></section>`;
  assertEquals(ruleIds(scanSource("extension/options/options.html", sibling)), ["banned-term:system-words"], "the sibling is NOT exempt");
  // An element marked data-vocab="advanced" is exempt as a subtree (depth-aware).
  const marked = `<div class="webmcp-status" data-vocab="advanced"><h3>Site Agent diagnostics</h3><div><p>Runtime lifecycle</p></div></div><p>Diagnostics for you</p>`;
  const markedFound = scanSource("extension/options/options.html", marked);
  assertEquals(markedFound.length, 1, `only the paragraph OUTSIDE the marked element is reported, got ${JSON.stringify(markedFound)}`);
  assert(markedFound[0].detail.includes("Diagnostics for you"));
  // JS: a marked line and a marked region are exempt; the rest of the file is not.
  const jsSrc = [
    'a.textContent = "catalog generation"; // vocab:advanced',
    "/* vocab:advanced:start */",
    'b.textContent = "runtime lifecycle";',
    "/* vocab:advanced:end */",
    'c.textContent = "Discovery has not run yet.";',
  ].join("\n");
  const jsFound = scanSource("extension/shared/components.js", jsSrc);
  assertEquals(jsFound.length, 1, `only the unmarked sink is reported, got ${JSON.stringify(jsFound)}`);
  assertEquals(jsFound[0].line, 5);
  // The exemption is scoped to the system-words rule: "asset" stays wrong inside Advanced.
  const assetInAdvanced = `<section id="prompts" data-developer="true"><p>Recent assets</p></section>`;
  assertEquals(ruleIds(scanSource("extension/options/options.html", assetInAdvanced)), ["banned-term:assets"]);
});

Deno.test("user voice (USER-VOICE-COPY-01): the shipped surfaces no longer speak the system's words", async () => {
  const violations = await checkVocabulary();
  assertEquals(violations.filter((v) => v.rule === "banned-term:system-words"), [], "no shipped surface may carry a system word outside Advanced");
  const ntp = await Deno.readTextFile("extension/ntp/ntp.js");
  assert(ntp.includes("Open a site and I'll look for tools you can use."), "the hub's site-tools empty state says what to do next");
  assert(!ntp.includes("Discovery has not run yet."), "the system's status line is gone");
  const options = await Deno.readTextFile("extension/options/options.html");
  assert(!/When off, the hub is a single agent/.test(options), "the Multiple agents toggle explains what turning it on does");
});

Deno.test("retired surfaces (ONE-SHELL-01): chat/chat.html, chat.js, memory/explorer.html, explorer.js, and composer.css do not exist", async () => {
  const violations = await checkVocabulary();
  assertEquals(violations.filter((v) => v.rule === "retired-surface"), [], "no retired surfaces may exist on disk");
  for (const path of [
    "extension/recipes/index.html",
    "extension/chat/chat.html",
    "extension/chat/chat.js",
    "extension/memory/explorer.html",
    "extension/memory/explorer.js",
    "extension/shared/composer.css",
  ]) {
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, `${path} must be deleted`);
  }
});

Deno.test("CSP hygiene: shipped extension pages ship NO inline scripts (MV3 script-src 'self' blocks them)", async () => {
  const shippedHtml = [
    "extension/options/options.html",
    "extension/artifacts/index.html",
    "extension/directory/directory.html",
    "extension/ntp/ntp.html",
    "extension/sidepanel/sidepanel.html",
    "extension/privacy/privacy.html",
    "extension/artifact/artifact.html",
    "extension/sandbox/script-sandbox.html",
    "extension/sandbox/artifact-preview.html",
    "extension/offscreen/offscreen.html",
  ];
  for (const file of shippedHtml) {
    const source = await Deno.readTextFile(file);
    const inline = [...source.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)];
    assert(inline.length === 0, `${file} ships ${inline.length} inline <script> block(s) — MV3 CSP blocks them; move the code to an external file`);
  }
  // The shared boot file exists and sets the embedded attribute (the inline
  // blocks it replaced all did exactly this).
  const boot = await Deno.readTextFile("extension/shared/embedded-boot.js");
  assert(boot.includes('dataset.embedded = "1"'), "embedded-boot.js must set data-embedded");
});

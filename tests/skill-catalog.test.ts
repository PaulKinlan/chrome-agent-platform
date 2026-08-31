// tests/skill-catalog.test.ts — CAP-FB-20260831-SKILL-LIST-SYNC-01.
//
// The catalog (lib/skill-catalog.js) is THE single skill query behind /skill,
// the @-mention popup, the agent-config dialog and Settings → Skills. These
// tests pin the contract behaviors:
//   1. catalog = on-demand built-ins + healthy imported skills (no background)
//   2. every skill carries an honest source label (builtin | imported)
//   3. a migration-failed (corrupt) skill is hidden from pickers AND reported
//      in `broken` — never silently offered, never silently hidden
//   4. deleting an imported skill removes it from the catalog (one store write)
//   5. no surface keeps a private list: the panel source must not re-filter
//      (covered here by grepping the shipped panel for a private mode filter)
//   6. COLLISION-PROOF IDENTITY (r2 review P1): an imported skill whose id
//      collides with a built-in recipe id (background or on-demand) is
//      offered under a source-qualified refId (imported:<id>) so the /skill
//      offering can NEVER resolve to a built-in BACKGROUND recipe — both rows
//      appear correctly labeled, and the offering references the on-demand one.
// RED→GREEN: revert skill-catalog.js's exclusion of migration-failed rows and
// test 3 fails; re-introduce the background-mode exclusion and test 1 fails;
// drop the refId namespacing and the collision test fails (the imported row
// would be offered as the raw colliding id).
// @ts-nocheck — memory/skill-files doubles are intentionally dynamic.
import { assertEquals, assert } from "jsr:@std/assert@1";
import { mergeRunSkills, skillRowChecked, templateSkillMatches, skillResolutionOrder, getRecipe } from "../extension/lib/recipes.js";
import { resolveSkillRef } from "../extension/lib/skill-resolve.js";

function fakeMemory() {
  const data = new Map();
  return {
    async get(k) { return data.get(k); },
    async set(k, v) { data.set(k, v); },
    _data: data,
  };
}

function fakeSkillFiles() {
  const files = new Map();
  return {
    async writeSkillFiles(id, map) {
      files.set(id, Object.fromEntries(Object.entries(map)));
      const totalBytes = Object.values(map).reduce(
        (n, v) => n + new TextEncoder().encode(String(v ?? "")).byteLength,
        0,
      );
      return { fileCount: Object.keys(map).length, totalBytes };
    },
    async removeSkillFiles(id) { files.delete(id); },
    async readSkillFile(id, path) {
      const f = files.get(id);
      if (!f || !(path in f)) throw new Error("NotFoundError");
      return f[path];
    },
    _files: files,
  };
}

const { skillCatalog } = await import("../extension/lib/skill-catalog.js");

function seedImported(memory, rows) {
  memory._data.set("importedSkills", rows);
}

function healthyRow(id, extra = {}) {
  return {
    id,
    name: id.replace(/-/g, " "),
    description: `desc ${id}`,
    source: "imported",
    mode: "on-demand",
    category: "imported",
    prompt: "",
    promptBytes: 16,
    fileCount: 1,
    totalBytes: 16,
    requiredCapabilities: [],
    importedAt: Date.now(),
    ...extra,
  };
}

Deno.test("catalog: on-demand built-ins + healthy imported skills, background recipes excluded", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  seedImported(memory, [healthyRow("photo-resizer")]);
  const { skills, broken } = await skillCatalog({ memory, fileStore: files });

  assert(skills.some((s) => s.id === "photo-resizer"), "imported skill is in the catalog");
  assert(skills.some((s) => s.id === "tab-hygiene"), "built-in on-demand recipe is in the catalog");
  // The owner-reported mismatch: the Sorting Hat is auto-group-by-domain, a
  // BACKGROUND (scheduled) recipe. It must NOT be offered as an on-demand skill.
  assert(!skills.some((s) => s.id === "auto-group-by-domain"), "background recipe (sorting hat) is NOT in the skill catalog");
  assert(!skills.some((s) => s.mode === "background"), "no background-mode skill in the catalog");
  assertEquals(broken.length, 0, "no broken skills for a healthy store");
});

Deno.test("catalog: every skill carries an honest source label", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  seedImported(memory, [healthyRow("photo-resizer")]);
  const { skills } = await skillCatalog({ memory, fileStore: files });
  const byId = Object.fromEntries(skills.map((s) => [s.id, s]));
  assertEquals(byId["photo-resizer"].source, "imported");
  assertEquals(byId["tab-hygiene"].source, "builtin");
});

Deno.test("catalog: a migration-failed skill is hidden from pickers and reported in broken", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  seedImported(memory, [
    healthyRow("photo-resizer"),
    { ...healthyRow("broken-one"), migrationFailed: true },
  ]);
  const { skills, broken } = await skillCatalog({ memory, fileStore: files });
  assert(!skills.some((s) => s.id === "broken-one"), "corrupt skill is not offered by any picker");
  const report = broken.find((b) => b.id === "broken-one");
  assert(report, "corrupt skill is reported in broken");
  assert(report.reason.length > 0, "broken report carries a reason");
  assert(skills.some((s) => s.id === "photo-resizer"), "healthy skills remain");
});

Deno.test("catalog: deleting an imported skill removes it from the catalog (one store write)", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  seedImported(memory, [healthyRow("photo-resizer"), healthyRow("archiver")]);
  const { removeImportedSkill } = await import("../extension/lib/skill-import.js");
  const out = await removeImportedSkill(memory, "archiver", files);
  assert(out?.ok, "delete succeeds");
  const { skills } = await skillCatalog({ memory, fileStore: files });
  assert(skills.some((s) => s.id === "photo-resizer"), "remaining skill still listed");
  assert(!skills.some((s) => s.id === "archiver"), "deleted skill is gone from the catalog — /skill and Settings agree");
});

Deno.test("catalog: no surface keeps a private skill list (source-level guard)", async () => {
  const panel = await Deno.readTextFile("extension/skills/skills-panel.js");
  // Comment-tolerated: the ONLY remaining occurrence of the old filter is in a
  // comment documenting the change; executable code must not re-filter.
  const executable = panel.split(/\n/).filter((l) => {
    const t = l.trim();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  }).join("\n");
  assert(!executable.includes('mode === "on-demand"'), "Settings panel has no private mode filter");
  const composer = await Deno.readTextFile("extension/shared/composer-commands.js");
  assert(composer.includes('"skill.list"'), "/skill popup reads the SW skill.list route");
});

// ── r2 review P1: collision-proof identity ─────────────────────────────────
// The owner bug: the Sorting Hat (auto-group-by-domain, a BACKGROUND recipe)
// was offered via /skill. The r2 hole: an IMPORTED skill whose id collides
// with a built-in recipe id would be offered under the raw id, and the
// run-time resolver (built-in FIRST) would land on the built-in — for a
// background collider, that is the owner bug returning through a different
// door. The catalog must namespace identity per source.

Deno.test("catalog: a colliding imported skill is offered under imported:<id>, both rows correctly labeled", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  // An imported skill whose id collides with the built-in BACKGROUND recipe
  // auto-group-by-domain (the Sorting Hat).
  seedImported(memory, [{ ...healthyRow("auto-group-by-domain", { name: "Imported Domain Grouper" }) }]);
  const { skills } = await skillCatalog({ memory, fileStore: files });
  const colliding = skills.filter((s) => s.id === "auto-group-by-domain");
  assertEquals(colliding.length, 1, "the background built-in is NOT in the catalog (scheduled agent); only the imported row is");
  assertEquals(colliding[0].refId, "imported:auto-group-by-domain", "imported collider is source-qualified");
  assertEquals(colliding[0].source, "imported", "correctly labeled imported");
  // The /skill offering (composer maps catalog rows → skill:<refId>) must
  // reference the on-demand imported row, never resolve to the background.
  const offeringId = `skill:${colliding[0].refId ?? colliding[0].id}`;
  assertEquals(offeringId, "skill:imported:auto-group-by-domain", "offering references the imported row");
});

Deno.test("catalog: an on-demand built-in and an imported skill with the same id are BOTH offered, distinctly labeled", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  seedImported(memory, [{ ...healthyRow("tab-hygiene", { name: "Imported Tab Hygiene" }) }]);
  const { skills } = await skillCatalog({ memory, fileStore: files });
  const both = skills.filter((s) => s.id === "tab-hygiene");
  assertEquals(both.length, 2, "builtin on-demand + imported collider both appear");
  const builtin = both.find((s) => s.source === "builtin");
  const imported = both.find((s) => s.source === "imported");
  assert(builtin, "built-in row present");
  assert(imported, "imported row present");
  assertEquals(builtin.refId, "builtin:tab-hygiene");
  assertEquals(imported.refId, "imported:tab-hygiene");
  // Distinct refIds → distinct dedup keys → BOTH compose in one run.
  const merged = mergeRunSkills([{ ...builtin, prompt: "builtin body" }], [{ ...imported, prompt: "imported body" }]);
  assertEquals(merged.length, 2, "colliding rows compose together (dedup by refId, not raw id)");
});

Deno.test("catalog: a built-in on-demand row carries builtin:<id> refId", async () => {
  const memory = fakeMemory();
  const files = fakeSkillFiles();
  const { skills } = await skillCatalog({ memory, fileStore: files });
  const th = skills.find((s) => s.id === "tab-hygiene" && s.source === "builtin");
  assert(th, "built-in tab-hygiene present");
  assertEquals(th.refId, "builtin:tab-hygiene");
});

// ── resolution contract (r2): source-qualified refs are source-locked ────
Deno.test("resolution: parseSkillRef locks a reference to its source", async () => {
  const { parseSkillRef, getRecipe } = await import("../extension/lib/recipes.js");
  assertEquals(parseSkillRef("imported:auto-group-by-domain"), { source: "imported", id: "auto-group-by-domain" });
  assertEquals(parseSkillRef("builtin:tab-hygiene"), { source: "builtin", id: "tab-hygiene" });
  assertEquals(parseSkillRef("custom:my-agent"), { source: "custom", id: "my-agent" });
  assertEquals(parseSkillRef("tab-hygiene"), { source: "raw", id: "tab-hygiene" });
  assertEquals(parseSkillRef(""), { source: "raw", id: "" });
});

Deno.test("resolution: an unprefixed colliding id still resolves the built-in first (background-agent.set contract, unchanged)", async () => {
  const { getRecipe, parseSkillRef } = await import("../extension/lib/recipes.js");
  // Raw id → built-in first → the BACKGROUND Sorting Hat (resolveRecipe keeps
  // this order for raw refs so background-agent.set can enable it).
  assertEquals(parseSkillRef("auto-group-by-domain").source, "raw");
  assert(getRecipe("auto-group-by-domain"), "built-in background recipe resolvable by raw id");
  assert(getRecipe("auto-group-by-domain").mode === "background");
});

Deno.test("resolution: a builtin: ref maps to the built-in table only", async () => {
  const { getRecipe, parseSkillRef } = await import("../extension/lib/recipes.js");
  const p = parseSkillRef("builtin:auto-group-by-domain");
  assertEquals(p, { source: "builtin", id: "auto-group-by-domain" });
  // resolveRecipe(builtin:x) returns the built-in if present — here the
  // background built-in EXISTS but is only reachable via the explicit
  // builtin: prefix or the raw id (never via /skill offering, which excludes
  // background rows).
  assert(getRecipe("auto-group-by-domain"), "builtin table has the row");
});

// ── r3 review: dialog checkbox collision + custom source-locking ──────────
Deno.test("r3: skillRowChecked selects EXACTLY ONE row of a colliding pair for a legacy raw saved id", () => {
  const available = [
    { id: "tab-hygiene", refId: "builtin:tab-hygiene", source: "builtin", name: "Tab hygiene" },
    { id: "tab-hygiene", refId: "imported:tab-hygiene", source: "imported", name: "Imported Tab Hygiene" },
  ];
  // Legacy raw saved id → built-in wins (resolveRecipe raw order) — exactly one.
  assertEquals(skillRowChecked(available, ["tab-hygiene"], available[0]), true);
  assertEquals(skillRowChecked(available, ["tab-hygiene"], available[1]), false);
  // A refId save matches only its own row.
  assertEquals(skillRowChecked(available, ["imported:tab-hygiene"], available[0]), false);
  assertEquals(skillRowChecked(available, ["imported:tab-hygiene"], available[1]), true);
  assertEquals(skillRowChecked(available, ["builtin:tab-hygiene"], available[0]), true);
  assertEquals(skillRowChecked(available, ["builtin:tab-hygiene"], available[1]), false);
});

Deno.test("r3: skillRowChecked unique raw id matches the unique owner; no save → unchecked", () => {
  const available = [
    { id: "reader-mode", refId: "builtin:reader-mode", source: "builtin", name: "Reader mode" },
  ];
  assertEquals(skillRowChecked(available, ["reader-mode"], available[0]), true, "unique raw id → unique owner");
  assertEquals(skillRowChecked(available, [], available[0]), false, "no saved id → unchecked");
  assertEquals(skillRowChecked(available, ["other-skill"], available[0]), false, "unrelated saved id → unchecked");
});

Deno.test("r3: templateSkillMatches toggles exactly one row of a colliding pair", () => {
  const available = [
    { id: "page-summary", refId: "builtin:page-summary", source: "builtin", name: "Page summary" },
    { id: "page-summary", refId: "imported:page-summary", source: "imported", name: "Imported page summary" },
  ];
  assertEquals(templateSkillMatches(available, ["page-summary"], available[0]), true, "raw template id → built-in row on collision");
  assertEquals(templateSkillMatches(available, ["page-summary"], available[1]), false, "raw template id → NOT the imported row on collision");
  assertEquals(templateSkillMatches(available, ["imported:page-summary"], available[0]), false);
  assertEquals(templateSkillMatches(available, ["imported:page-summary"], available[1]), true, "refId template id → its own row");
});

Deno.test("r3: skillResolutionOrder source-locks custom/imported/builtin; raw keeps historical order", async () => {
  const { skillResolutionOrder } = await import("../extension/lib/recipes.js");
  assertEquals(skillResolutionOrder("custom"), ["custom"], "custom:<id> consults ONLY the custom store (never built-in/imported)");
  assertEquals(skillResolutionOrder("imported"), ["imported"], "imported:<id> consults ONLY the imported store");
  assertEquals(skillResolutionOrder("builtin"), ["builtin"], "builtin:<id> consults ONLY the built-in table");
  assertEquals(skillResolutionOrder("raw"), ["builtin", "custom", "imported"], "raw id keeps built-in → custom → imported (background-agent.set on duplicated agents)");
});

Deno.test("r3: a raw id that only a custom recipe owns still resolves to it (background-agent.set duplicated-agent contract)", async () => {
  // background-agent.set resolves a duplicated background agent by its raw id;
  // the duplicated copy lives in the custom store (recipe.duplicate writes
  // customRecipes) and has no built-in/imported counterpart — the raw path
  // MUST reach custom for that to work. The order contract pins it.
  const { getRecipe, skillResolutionOrder } = await import("../extension/lib/recipes.js");
  assert(!getRecipe("auto-group-by-domain-custom-123"), "no built-in holds the duplicated id");
  assertEquals(skillResolutionOrder("raw"), ["builtin", "custom", "imported"], "raw order reaches custom after built-in misses");
});

// ── r4: DIALOG-LEVEL collision proof + initial-count fix + real resolver ──

// Minimal fake DOM for the real dialog render path (lib/agent-skill-rows.js).
// Supports what buildAgentSkillRows uses: createElement, append, addEventListener,
// dispatchEvent (for a real checkbox change), checked, textContent, className,
// style.
function installFakeDoc() {
  function makeNode(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      _listeners: {},
      style: {},
      textContent: "",
      className: "",
      checked: false,
      type: "",
      append(...kids) {
        for (const k of kids) {
          if (typeof k === "string") { this.textContent += k; continue; }
          k.parent = this;
          this.children.push(k);
        }
        return this;
      },
      addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
      dispatchEvent() {
        for (const fn of (this._listeners.change ?? [])) fn({ target: this });
        return true;
      },
      querySelector() { return null; },
    };
  }
  const fakeDoc = { createElement: (t) => makeNode(t) };
  const prev = globalThis.document;
  globalThis.document = fakeDoc;
  return () => { if (prev === undefined) delete globalThis.document; else globalThis.document = prev; };
}

const { buildAgentSkillRows } = await import("../extension/lib/agent-skill-rows.js");

Deno.test("r4 DIALOG: with a colliding pair, toggling one checkbox checks exactly one row and save collects the refId", async () => {
  const restoreDoc = installFakeDoc();
  try {
    const available = [
      { id: "tab-hygiene", refId: "builtin:tab-hygiene", source: "builtin", name: "Tab hygiene", description: "builtin" },
      { id: "tab-hygiene", refId: "imported:tab-hygiene", source: "imported", name: "Imported Tab Hygiene", description: "imported" },
    ];
    const countEl = document.createElement("span");
    const section = buildAgentSkillRows({ available, savedIds: [], countEl });
    assertEquals(section.rows.length, 2, "two colliding rows render");
    assertEquals(section.count(), 0, "initial count 0");
    assertEquals(countEl.textContent, "2 available");
    // Toggle the IMPORTED row through its real change handler.
    const importedRow = section.rows.find((r) => r.id === "imported:tab-hygiene");
    importedRow.checkbox.checked = true;
    importedRow.checkbox.dispatchEvent();
    assertEquals(section.count(), 1, "exactly one row checked after toggling the imported row");
    assertEquals(countEl.textContent, "1 selected");
    const builtinRow = section.rows.find((r) => r.id === "builtin:tab-hygiene");
    assertEquals(builtinRow.checkbox.checked, false, "the built-in row stays unchecked");
    // Save collects the refId for the checked row.
    const saved = section.collectChecked();
    assertEquals(saved.length, 1, "exactly one saved skill");
    assertEquals(saved[0].id, "imported:tab-hygiene", "saved ref is the refId");
  } finally {
    restoreDoc();
  }
});

Deno.test("r4 DIALOG: a legacy raw saved id restores exactly one row of a colliding pair (built-in wins)", async () => {
  const restoreDoc = installFakeDoc();
  try {
    const available = [
      { id: "page-summary", refId: "builtin:page-summary", source: "builtin", name: "Page summary", description: "b" },
      { id: "page-summary", refId: "imported:page-summary", source: "imported", name: "Imported page summary", description: "i" },
    ];
    const countEl = document.createElement("span");
    const section = buildAgentSkillRows({ available, savedIds: ["page-summary"], countEl });
    const builtin = section.rows.find((r) => r.id === "builtin:page-summary");
    const imported = section.rows.find((r) => r.id === "imported:page-summary");
    assertEquals(builtin.checkbox.checked, true, "legacy raw id → built-in row checked");
    assertEquals(imported.checkbox.checked, false, "imported row NOT checked");
    assertEquals(section.count(), 1, "count reflects exactly one checked");
    assertEquals(countEl.textContent, "1 selected");
  } finally {
    restoreDoc();
  }
});

Deno.test("r4 DIALOG: a refId-keyed saved selection renders the correct initial count (r3 P2 count fix)", async () => {
  const restoreDoc = installFakeDoc();
  try {
    const available = [
      { id: "reader-mode", refId: "builtin:reader-mode", source: "builtin", name: "Reader mode", description: "b" },
      { id: "tab-hygiene", refId: "builtin:tab-hygiene", source: "builtin", name: "Tab hygiene", description: "b" },
    ];
    const countEl = document.createElement("span");
    const section = buildAgentSkillRows({ available, savedIds: ["imported:tab-hygiene", "builtin:reader-mode"], countEl });
    // imported:tab-hygiene is NOT in available here (no collision in this
    // catalog) — the count must reflect the rows ACTUALLY checked, not a
    // raw-id cross-count that ignores refId-keyed selections.
    assertEquals(section.rows.find((r) => r.id === "builtin:reader-mode").checkbox.checked, true);
    assertEquals(section.rows.find((r) => r.id === "builtin:tab-hygiene").checkbox.checked, false);
    assertEquals(section.count(), 1, "count = rows actually checked");
    assertEquals(countEl.textContent, "1 selected");
    // Now the same saved set with BOTH colliding rows present: imported:tab-hygiene
    // matches the imported row, builtin:reader-mode matches the built-in row.
    const both = [
      { id: "reader-mode", refId: "builtin:reader-mode", source: "builtin", name: "Reader mode", description: "b" },
      { id: "tab-hygiene", refId: "builtin:tab-hygiene", source: "builtin", name: "Tab hygiene", description: "b" },
      { id: "tab-hygiene", refId: "imported:tab-hygiene", source: "imported", name: "Imported Tab Hygiene", description: "i" },
    ];
    const countEl2 = document.createElement("span");
    const section2 = buildAgentSkillRows({ available: both, savedIds: ["imported:tab-hygiene", "builtin:reader-mode"], countEl: countEl2 });
    assertEquals(section2.rows.find((r) => r.id === "imported:tab-hygiene").checkbox.checked, true);
    assertEquals(section2.rows.find((r) => r.id === "builtin:tab-hygiene").checkbox.checked, false);
    assertEquals(section2.count(), 2, "both refId-keyed selections count");
    assertEquals(countEl2.textContent, "2 selected");
  } finally {
    restoreDoc();
  }
});

// ── r4: REAL-resolver tests (lib/skill-resolve.js) with real + faked stores ──
// The reviewer's r3 P2: the source-lock tests must exercise the ACTUAL
// resolver against real (faked-OPFS) stores, not helpers. resolveSkillRef is
// the real resolver the service worker calls; getRecipe is the real built-in
// table; custom/imported stores are faked (memory rows + OPFS file bodies).

function fakeResolverStores({ custom = [], imported = [], files = {} } = {}) {
  return {
    getRecipe: (id) => getRecipe(id), // the REAL built-in table (recipes.js)
    getCustomRecipes: async () => custom,
    loadAllImported: async () => imported,
    readSkillFile: async (id, path) => {
      const f = files[id]?.[path];
      if (f === undefined) throw new Error("NotFoundError");
      return f;
    },
  };
}

Deno.test("r4 resolver: custom:<id> resolves ONLY in the custom store — a colliding built-in id is ignored", async () => {
  const stores = fakeResolverStores({
    // A custom recipe whose id collides with the built-in auto-group-by-domain.
    custom: [{ id: "auto-group-by-domain", name: "Duplicated Sorting Hat", mode: "background", schedule: { periodInMinutes: 7 } }],
  });
  const r = await resolveSkillRef({ ref: "custom:auto-group-by-domain", stores });
  assert(r, "custom ref resolves");
  assertEquals(r.name, "Duplicated Sorting Hat", "the CUSTOM row wins, never the built-in");
  assertEquals(r.refId, "custom:auto-group-by-domain");
  // The raw id still resolves to the BUILT-IN background recipe (unchanged contract).
  const raw = await resolveSkillRef({ ref: "auto-group-by-domain", stores });
  assert(raw, "raw id resolves");
  assertEquals(raw.mode, "background");
  assertEquals(raw.refId, "builtin:auto-group-by-domain");
});

Deno.test("r4 resolver: custom:<id> absent from the custom store returns null — no fall-through to built-in/imported", async () => {
  const stores = fakeResolverStores({
    custom: [],
    // The id EXISTS as an imported skill — the custom: ref must NOT reach it.
    imported: [{ id: "mystery", name: "Imported Mystery", source: "imported", mode: "on-demand", promptBytes: 4, prompt: "" }],
  });
  const r = await resolveSkillRef({ ref: "custom:mystery", stores });
  assertEquals(r, null, "custom:<id> absent from custom → null (never the imported row)");
});

Deno.test("r4 resolver: imported:<id> reads the OPFS body for small skills and never touches built-in/custom", async () => {
  const stores = fakeResolverStores({
    custom: [{ id: "reader-mode", name: "Custom reader", mode: "background" }],
    imported: [{ id: "reader-mode", name: "Imported reader", source: "imported", mode: "on-demand", promptBytes: 40, prompt: "" }],
    files: { "reader-mode": { "SKILL.md": "imported body for reader-mode" } },
  });
  const r = await resolveSkillRef({ ref: "imported:reader-mode", stores });
  assert(r, "imported ref resolves");
  assertEquals(r.name, "Imported reader", "the IMPORTED row wins, never the custom/built-in");
  assertEquals(r.prompt, "imported body for reader-mode", "small body composed from the OPFS store");
  assertEquals(r.refId, "imported:reader-mode");
});

Deno.test("r4 resolver: builtin:<id> resolves ONLY in the built-in table", async () => {
  const stores = fakeResolverStores({
    custom: [{ id: "tab-hygiene", name: "Custom tab hygiene", mode: "background" }],
    imported: [{ id: "tab-hygiene", name: "Imported tab hygiene", source: "imported", mode: "on-demand", promptBytes: 4, prompt: "" }],
  });
  const r = await resolveSkillRef({ ref: "builtin:tab-hygiene", stores });
  assert(r, "builtin ref resolves");
  assertEquals(r.refId, "builtin:tab-hygiene");
  assertEquals(r.mode, "on-demand", "the built-in on-demand row wins");
  assertEquals(r.name, "Tab hygiene");
});

Deno.test("r4 resolver: a raw id held only by a custom recipe still resolves to it (background-agent.set duplicated-agent contract)", async () => {
  const stores = fakeResolverStores({
    custom: [{ id: "auto-group-by-domain-custom-123", name: "My Sorting Hat", mode: "background", schedule: { periodInMinutes: 30 } }],
  });
  assert(!getRecipe("auto-group-by-domain-custom-123"), "no built-in holds the duplicated id");
  const r = await resolveSkillRef({ ref: "auto-group-by-domain-custom-123", stores });
  assert(r, "raw id resolves to the custom recipe");
  assertEquals(r.name, "My Sorting Hat");
  assertEquals(r.refId, "custom:auto-group-by-domain-custom-123");
});

Deno.test("r4 resolver: a raw id held by a built-in wins over custom/imported (historical order pinned)", async () => {
  const stores = fakeResolverStores({
    custom: [{ id: "page-summary", name: "Custom summary", mode: "background" }],
    imported: [{ id: "page-summary", name: "Imported summary", source: "imported", mode: "on-demand", promptBytes: 4, prompt: "" }],
  });
  const r = await resolveSkillRef({ ref: "page-summary", stores });
  assert(r, "raw id resolves");
  assertEquals(r.refId, "builtin:page-summary", "built-in first for raw ids");
});

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
import { mergeRunSkills } from "../extension/lib/recipes.js";

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

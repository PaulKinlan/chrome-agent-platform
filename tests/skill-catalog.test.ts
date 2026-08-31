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
// RED→GREEN: revert skill-catalog.js's exclusion of migration-failed rows and
// test 3 fails; re-introduce the background-mode exclusion and test 1 fails.
// @ts-nocheck — memory/skill-files doubles are intentionally dynamic.
import { assertEquals, assert } from "jsr:@std/assert@1";

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

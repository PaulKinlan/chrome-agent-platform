// skill-import.test.ts — the external skill import (the chaos skill-loader
// pattern): frontmatter parsing, id slugging, and the install-into-master-store
// round trip. The fetch-from-GitHub path is network-dependent (covered by the
// e2e journey / a manual acceptance), so the pure + store parts are asserted here.
// @ts-nocheck — the memory mock + frontmatter meta are intentionally dynamic.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  parseFrontmatter,
  slugifySkillId,
  installImportedSkill,
} from "../extension/lib/skill-import.js";

function fakeMemory() {
  const data = new Map();
  return {
    async get(k) { return data.get(k); },
    async set(k, v) { data.set(k, v); },
    _data: data,
  };
}

Deno.test("parseFrontmatter extracts name/description + body", () => {
  const md = `---\nname: PR Reviewer\ndescription: Reviews pull requests\n---\n\n# Instructions\nDo the thing.`;
  const { meta, body } = parseFrontmatter(md);
  assertEquals(meta.name, "PR Reviewer");
  assertEquals(meta.description, "Reviews pull requests");
  assertStringIncludes(body, "# Instructions");
});

Deno.test("parseFrontmatter tolerates no frontmatter", () => {
  const { meta, body } = parseFrontmatter("# Just markdown");
  assertEquals(meta.name, undefined);
  assertEquals(body, "# Just markdown");
});

Deno.test("slugifySkillId makes a stable safe id", () => {
  assertEquals(slugifySkillId("PR Reviewer"), "pr-reviewer");
  assertEquals(slugifySkillId("  Tab Hygiene!  "), "tab-hygiene");
  assertEquals(slugifySkillId(""), "imported-skill");
});

Deno.test("installImportedSkill stores a /skill-referenceable skill", async () => {
  const mem = fakeMemory();
  const skill = await installImportedSkill(mem, {
    files: { "SKILL.md": "---\nname: PR Reviewer\n---\n\nInstructions" },
    meta: { name: "PR Reviewer", description: "Reviews PRs", author: "paul" },
  });
  assertEquals(skill.id, "pr-reviewer");
  assertEquals(skill.mode, "on-demand");
  assertEquals(skill.source, "imported");
  assertStringIncludes(skill.prompt, "Instructions");

  const stored = await mem.get("importedSkills");
  assertEquals(stored.length, 1);
  assertEquals(stored[0].id, "pr-reviewer");

  // A second install of the SAME id replaces, not duplicates.
  await installImportedSkill(mem, {
    files: { "SKILL.md": "---\nname: PR Reviewer\n---\n\nUpdated" },
    meta: { name: "PR Reviewer", description: "Updated", author: "paul" },
  });
  const stored2 = await mem.get("importedSkills");
  assertEquals(stored2.length, 1);
  assertStringIncludes(stored2[0].prompt, "Updated");
});

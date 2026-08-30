// skill-import.test.ts — the external skill import (the chaos skill-loader
// pattern): frontmatter parsing, id slugging, the install-into-master-store
// round trip, and the SKILLS-UNCAPPED-01 rules (large skills accepted,
// multi-file files map persisted, generous physical budgets reject honestly).
// The fetch-from-GitHub path is network-dependent (covered by the e2e journey
// / a manual acceptance), so the pure + store parts are asserted here.
// @ts-nocheck — the memory mock + frontmatter meta are intentionally dynamic.
import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import {
  parseFrontmatter,
  slugifySkillId,
  installImportedSkill,
  fetchSkillFromUrl,
  loadImportedSkill,
  loadAllImportedSkills,
} from "../extension/lib/skill-import.js";

function fakeMemory() {
  const data = new Map();
  return {
    async get(k) { return data.get(k); },
    async set(k, v) { data.set(k, v); },
    _data: data,
  };
}

/** In-memory skill-files store (the OPFS store's test double). */
function fakeSkillFiles() {
  const files = new Map(); // id → { path: text }
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
  const fs = fakeSkillFiles();
  const skill = await installImportedSkill(mem, {
    files: { "SKILL.md": "---\nname: PR Reviewer\n---\n\nInstructions" },
    meta: { name: "PR Reviewer", description: "Reviews PRs", author: "paul" },
  }, fs);
  assertEquals(skill.id, "pr-reviewer");
  assertEquals(skill.mode, "on-demand");
  assertEquals(skill.source, "imported");
  assertEquals(skill.prompt, ""); // metadata-only index row
  assertEquals(skill.promptBytes, new TextEncoder().encode("---\nname: PR Reviewer\n---\n\nInstructions").byteLength);

  const stored = await mem.get("importedSkills");
  assertEquals(stored.length, 1);
  assertEquals(stored[0].id, "pr-reviewer");
  // the body went to the file store, not the memory row
  assertEquals(stored[0].prompt, "");
  assertEquals(fs._files.get("pr-reviewer")["SKILL.md"], "---\nname: PR Reviewer\n---\n\nInstructions");

  // A second install of the SAME id replaces, not duplicates.
  await installImportedSkill(mem, {
    files: { "SKILL.md": "---\nname: PR Reviewer\n---\n\nUpdated" },
    meta: { name: "PR Reviewer", description: "Updated", author: "paul" },
  }, fs);
  const stored2 = await mem.get("importedSkills");
  assertEquals(stored2.length, 1);
  assertEquals(fs._files.get("pr-reviewer")["SKILL.md"], "---\nname: PR Reviewer\n---\n\nUpdated");
});

// ── CAP-FB-20260830-SKILLS-UNCAPPED-01 ─────────────────────────────────────
// The owner's directive: "I don't want arbitrary constraints, especially
// around skills" — a 64KiB import cap rejected real skills (303729 bytes).
// Large skills + multi-file skills must install; the remaining budgets are
// PHYSICAL (per-file / total-bytes), and rejection is honest, never a silent
// truncate.

Deno.test("installImportedSkill accepts a LARGE (>64KiB) SKILL.md and a multi-file map", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();
  const bigBody = "# Big skill\n\n" + "lorem ipsum dolor sit amet\n".repeat(8000); // ~300KiB
  const fetched = {
    files: {
      "SKILL.md": `---\nname: Big Skill\n---\n\n${bigBody}`,
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "references/guide.md": "# Reference\n\nDetails\n",
    },
    meta: { name: "Big Skill", description: "A large multi-file skill", author: "cloudflare" },
  };
  const skill = await installImportedSkill(mem, fetched, fs);
  assertEquals(skill.id, "big-skill");
  assert(bigBody.length > 64 * 1024, "fixture must exceed the OLD 64KiB cap");
  assertEquals(skill.fileCount, 3);
  assert(skill.totalBytes > 64 * 1024);
  assert(skill.promptBytes > 64 * 1024);

  // The installed record persists the whole map in the FILE store (skill_read
  // can serve any file on demand) while the memory row stays metadata-only.
  const stored = await mem.get("importedSkills");
  assertEquals(stored[0].fileCount, 3);
  assertEquals(stored[0].prompt, "");
  assertEquals(fs._files.get("big-skill")["scripts/run.sh"], "#!/bin/sh\necho hi\n");
  assertEquals(fs._files.get("big-skill")["references/guide.md"], "# Reference\n\nDetails\n");
  assert((fs._files.get("big-skill")["SKILL.md"] ?? "").length > 64 * 1024);
});

Deno.test("installImportedSkill handles an empty files map honestly", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();
  const skill = await installImportedSkill(mem, {
    files: {},
    meta: { name: "Empty", description: "" },
  }, fs);
  assertEquals(skill.prompt, "");
  assertEquals(skill.fileCount, 0); // no files → 0 files, honest
  assertEquals(skill.promptBytes, 0);
});

// ── the multi-file GitHub walk (deterministic, OFFLINE: a stubbed fetch
// serves a fake api.github.com repo tree — SKILL.md + scripts/ + references/)
Deno.test("fetchSkillFromUrl walks a GitHub skill tree and collects every file within budget", async () => {
  const tree = {
    "": [
      { type: "dir", name: "skills", path: "skills" },
      { type: "file", name: "README.md", path: "README.md", download_url: "https://raw.githubusercontent.com/cloudflare/skills/main/README.md" },
    ],
    "skills": [
      { type: "file", name: "SKILL.md", path: "skills/SKILL.md", download_url: "https://raw.githubusercontent.com/cloudflare/skills/main/skills/SKILL.md" },
      { type: "dir", name: "scripts", path: "skills/scripts" },
      { type: "dir", name: "references", path: "skills/references" },
    ],
    "skills/scripts": [{ type: "file", name: "run.sh", path: "skills/scripts/run.sh", download_url: "https://raw.githubusercontent.com/cloudflare/skills/main/skills/scripts/run.sh" }],
    "skills/references": [{ type: "file", name: "guide.md", path: "skills/references/guide.md", download_url: "https://raw.githubusercontent.com/cloudflare/skills/main/skills/references/guide.md" }],
  };
  const bodies = {
    "skills/SKILL.md": "---\nname: Multi File\n---\n\n# Instructions\nDo the thing.\n",
    "skills/scripts/run.sh": "#!/bin/sh\necho hi\n",
    "skills/references/guide.md": "# Reference\n\nDetails\n",
    "README.md": "# repo readme (not part of the skill)\n",
  };
  const priorFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const gh = u.match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)\?ref=([^&]+)/);
      if (gh) {
        const p = decodeURIComponent(gh[3]).replace(/\/$/, "");
        const items = tree[p] ?? [];
        return new Response(JSON.stringify(items), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const dl = u.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (dl) {
        const p = decodeURIComponent(dl[4]);
        return new Response(bodies[p] ?? "", { status: bodies[p] ? 200 : 404 });
      }
      return priorFetch ? priorFetch(url, init) : new Response("", { status: 500 });
    };
    const fetched = await fetchSkillFromUrl("https://github.com/cloudflare/skills/tree/main/skills");
    const files = fetched.files ?? {};
    assertEquals(files["SKILL.md"], bodies["skills/SKILL.md"]);
    // relative paths: the SKILL.md parent is the key prefix
    assertEquals(files["scripts/run.sh"], "#!/bin/sh\necho hi\n");
    assertEquals(files["references/guide.md"], "# Reference\n\nDetails\n");
    assertEquals(files["README.md"], undefined, "files OUTSIDE the SKILL.md parent are not part of the skill");
    assertEquals(fetched.meta.name, "Multi File");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

// ── review P1: a supporting-file BUDGET rejection must FAIL the import ─────
// (the walk previously swallowed budget errors and silently returned a
// partial skill — honest errors, never silent)
Deno.test("fetchSkillFromUrl FAILS loudly when a supporting file busts the total import budget", async () => {
  const big = "x".repeat(1843200); // 1.8MiB < 2MiB per-file, but 5 files = 9MiB > 8MiB total
  const files = ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"];
  const tree = {
    "": [{ type: "dir", name: "skills", path: "skills" }],
    "skills": [
      { type: "file", name: "SKILL.md", path: "skills/SKILL.md", download_url: "https://raw.githubusercontent.com/o/r/main/skills/SKILL.md" },
      ...files.map((n) => ({ type: "file", name: n, path: `skills/${n}`, download_url: `https://raw.githubusercontent.com/o/r/main/skills/${n}` })),
    ],
  };
  const bodies = { "skills/SKILL.md": "---\nname: Budget Bust\n---\n\n# Instructions\n" };
  for (const n of files) bodies[`skills/${n}`] = big;
  const priorFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const u = String(url);
      const gh = u.match(/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.*)\?ref=([^&]+)/);
      if (gh) {
        const p = decodeURIComponent(gh[3]).replace(/\/$/, "");
        return new Response(JSON.stringify(tree[p] ?? []), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const dl = u.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
      if (dl) {
        const p = decodeURIComponent(dl[4]);
        return new Response(bodies[p] ?? "", { status: bodies[p] ? 200 : 404 });
      }
      return new Response("", { status: 500 });
    };
    let threw = null;
    try {
      await fetchSkillFromUrl("https://github.com/cloudflare/skills/tree/main/skills");
    } catch (e) {
      threw = String(e?.message ?? e);
    }
    assert(threw !== null, "the import must REJECT, not silently drop the oversized files");
    assertStringIncludes(threw, "total budget");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

// ── review P1: legacy imported rows (inline body, pre-OPFS) migrate on read ─
Deno.test("loadImportedSkill migrates a legacy inline body into the file store (never lost)", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();
  const legacy = {
    id: "old-skill",
    name: "Old Skill",
    description: "pre-OPFS import",
    source: "imported",
    mode: "on-demand",
    category: "imported",
    prompt: "---\nname: Old Skill\n---\n\nLegacy instructions", // inline body, NO promptBytes
    requiredCapabilities: [],
    importedAt: 1,
  };
  await mem.set("importedSkills", [legacy]);
  const migrated = await loadImportedSkill(mem, legacy, fs);
  // enriched + metadata-only row
  assert(Number.isInteger(migrated.promptBytes) && migrated.promptBytes > 0);
  assertEquals(migrated.prompt, "");
  assertEquals(migrated.fileCount, 1);
  // body landed in the file store
  assertEquals(fs._files.get("old-skill")["SKILL.md"], "---\nname: Old Skill\n---\n\nLegacy instructions");
  // the index row was persisted as migrated (future reads skip the write)
  const stored = (await mem.get("importedSkills"))[0];
  assertEquals(stored.prompt, "");
  assert(Number.isInteger(stored.promptBytes));
});

Deno.test("loadImportedSkill keeps a legacy row INTACT when the file store is unavailable (never destructive)", async () => {
  const mem = fakeMemory();
  const legacy = {
    id: "old-skill",
    name: "Old Skill",
    description: "d",
    source: "imported",
    mode: "on-demand",
    category: "imported",
    prompt: "---\nname: Old Skill\n---\n\nLegacy instructions",
    requiredCapabilities: [],
    importedAt: 1,
  };
  await mem.set("importedSkills", [legacy]);
  const breakingStore = {
    async writeSkillFiles() { throw new Error("OPFS unavailable"); },
    async removeSkillFiles() {},
  };
  const out = await loadImportedSkill(mem, legacy, breakingStore);
  assertEquals(out.prompt, "---\nname: Old Skill\n---\n\nLegacy instructions", "inline body survives");
  assertEquals(out.promptBytes, undefined);
  assertEquals(out.migrationFailed, true, "the failure is FLAGGED so the caller can warn and the prompt composer can avoid a dead skill_read marker");
});

Deno.test("loadAllImportedSkills migrates every legacy row; fresh rows pass through untouched", async () => {
  const mem = fakeMemory();
  const fs = fakeSkillFiles();
  const fresh = { id: "new-skill", name: "New", prompt: "", promptBytes: 5, source: "imported", mode: "on-demand", category: "imported", fileCount: 1, totalBytes: 5, requiredCapabilities: [], importedAt: 2 };
  const legacy = { id: "old-skill", name: "Old", source: "imported", mode: "on-demand", category: "imported", prompt: "legacy body", requiredCapabilities: [], importedAt: 1 };
  await mem.set("importedSkills", [fresh, legacy]);
  const out = await loadAllImportedSkills(mem, fs);
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  assertEquals(byId["new-skill"].promptBytes, 5, "fresh row untouched");
  assert(Number.isInteger(byId["old-skill"].promptBytes), "legacy row migrated");
  assertEquals(fs._files.get("old-skill")["SKILL.md"], "legacy body");
});

// skills-uncapped.test.ts — CAP-FB-20260830-SKILLS-UNCAPPED-01: large and
// multi-file imported skills are first-class. Asserts (1) the skill_read
// tool's bounded, paginated, path-confined reads and (2) the progressive-
// disclosure rule in renderBoundarySkills (small bodies compose, large
// imported bodies become a skill_read marker).
// @ts-nocheck — the z-validated tool wrapper + dynamic skill records.
import { assertEquals, assertStringIncludes, assert } from "jsr:@std/assert@1";
import { skillReadToolset } from "../extension/lib/agent.js";
import { appendSkillsLayer } from "../extension/lib/system-prompts.js";

function fakeSkillStore(records) {
  return async () => records;
}

function bigBody(n = 20 * 1024) {
  return "# Big\n\n" + "a".repeat(n);
}

Deno.test("skillReadToolset: absent store ⇒ no tool", () => {
  assertEquals(Object.keys(skillReadToolset(null)), []);
  assertEquals(Object.keys(skillReadToolset(undefined)), []);
});

Deno.test("skill_read returns a large SKILL.md body, bounded per read, paginated", async () => {
  const body = bigBody(); // ~20KiB > 16KiB read limit
  const store = fakeSkillStore([{
    id: "big-skill",
    name: "Big Skill",
    prompt: body,
    files: { "SKILL.md": body, "scripts/run.sh": "#!/bin/sh\necho hi\n" },
    source: "imported",
  }]);
  const { skill_read } = skillReadToolset(store);
  const r1 = await skill_read.execute({ skill: "big-skill" });
  assertEquals(r1.ok, true);
  assertEquals(r1.untrusted, true, "imported content must ride the untrusted channel");
  assertEquals(r1.totalBytes, body.length);
  assertEquals(r1.bytes, 16 * 1024, "one read returns at most the 16KiB projection bound");
  assertEquals(r1.truncated, true);
  assertEquals(r1.nextOffset, 16 * 1024);
  // The chunk is the FIRST 16KiB, not a silently truncated tail.
  assertEquals(r1.text, body.slice(0, 16 * 1024));

  // Page 2: offset resumes exactly where page 1 stopped.
  const r2 = await skill_read.execute({ skill: "big-skill", offset: r1.nextOffset });
  assertEquals(r2.ok, true);
  assertEquals(r2.offset, 16 * 1024);
  assertEquals(r2.bytes, body.length - 16 * 1024);
  assertEquals(r2.truncated, false);
  assertEquals(r2.nextOffset, null);
  assertEquals(r2.text, body.slice(16 * 1024));
});

Deno.test("skill_read serves a stored supporting file by path", async () => {
  const store = fakeSkillStore([{
    id: "multi",
    name: "Multi",
    prompt: "small body",
    files: {
      "SKILL.md": "small body",
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
      "references/guide.md": "# Reference\n\nDetails\n",
    },
    source: "imported",
  }]);
  const { skill_read } = skillReadToolset(store);
  const r = await skill_read.execute({ skill: "multi", path: "references/guide.md" });
  assertEquals(r.ok, true);
  assertEquals(r.path, "references/guide.md");
  assertEquals(r.text, "# Reference\n\nDetails\n");
  assertEquals(r.untrusted, true);
});

Deno.test("skill_read fails honestly: unknown skill, unknown file, leading-slash path", async () => {
  const store = fakeSkillStore([{ id: "one", name: "One", prompt: "body", files: { "SKILL.md": "body" }, source: "imported" }]);
  const { skill_read } = skillReadToolset(store);
  const missing = await skill_read.execute({ skill: "nope" });
  assertEquals(missing.ok, false);
  assertStringIncludes(missing.error, "no imported skill");
  const badPath = await skill_read.execute({ skill: "one", path: "SKILL.md" });
  assertEquals(badPath.ok, true);
  const outside = await skill_read.execute({ skill: "one", path: "/etc/passwd" });
  assertEquals(outside.ok, false, "a path outside the files map is a miss, never a filesystem read");
  assertStringIncludes(outside.error, "not safe");
  // leading slashes are REJECTED at the tool boundary (never normalized away)
  const leading = await skill_read.execute({ skill: "one", path: "/SKILL.md" });
  assertEquals(leading.ok, false, "absolute paths are refused");
  assertStringIncludes(leading.error, "not safe");
});

Deno.test("skill_read store failure is honest (ok:false), never a throw", async () => {
  const { skill_read } = skillReadToolset(async () => { throw new Error("store gone"); });
  const r = await skill_read.execute({ skill: "x" });
  assertEquals(r.ok, false);
  assertStringIncludes(r.error, "no imported skill");
});

Deno.test("skill_read works against the {list, read} store shape (index rows + OPFS bodies)", async () => {
  const body = bigBody();
  const store = {
    list: async () => [{
      id: "big-skill",
      name: "Big Skill",
      description: "a big one",
      prompt: "",
      promptBytes: body.length,
      fileCount: 2,
      totalBytes: body.length + 16,
      source: "imported",
    }],
    read: async (id, path) => {
      if (id !== "big-skill") throw new Error("no such skill");
      return path === "SKILL.md" ? body : "#!/bin/sh\necho hi\n";
    },
  };
  const { skill_read } = skillReadToolset(store);
  const r1 = await skill_read.execute({ skill: "big-skill" });
  assertEquals(r1.ok, true);
  assertEquals(r1.untrusted, true);
  assertEquals(r1.totalBytes, body.length);
  assertEquals(r1.truncated, true);
  assertEquals(r1.text, body.slice(0, 16 * 1024));
  const r2 = await skill_read.execute({ skill: "big-skill", path: "scripts/run.sh" });
  assertEquals(r2.ok, true);
  assertEquals(r2.path, "scripts/run.sh");
  assertEquals(r2.text, "#!/bin/sh\necho hi\n");
  const r3 = await skill_read.execute({ skill: "big-skill", path: "../etc/passwd" });
  assertEquals(r3.ok, false, "path traversal is rejected at the tool boundary");
  assertStringIncludes(r3.error, "not safe");
});

// ── progressive disclosure (renderBoundarySkills) ──────────────────────────

Deno.test("renderBoundarySkills composes a small imported body fully", () => {
  const out = appendSkillsLayer("", [
    { id: "small", name: "Small", description: "d", prompt: "do the thing", source: "imported", files: { "SKILL.md": "do the thing" } },
  ]);
  assertStringIncludes(out, "## Skill: Small");
  assertStringIncludes(out, "do the thing");
  assert(!out.includes("skill_read"), "small bodies compose directly, no loader marker");
});

Deno.test("renderBoundarySkills replaces a LARGE imported body with a skill_read marker", () => {
  const body = bigBody();
  const out = appendSkillsLayer("", [
    { id: "big-skill", name: "Big Skill", description: "a big one", prompt: "", promptBytes: body.length, source: "imported" },
  ]);
  assertStringIncludes(out, "Big Skill");
  assertStringIncludes(out, "skill_read");
  assertStringIncludes(out, `skill:"big-skill"`);
  assertStringIncludes(out, String(body.length));
  assert(!out.includes("## Skill: Big Skill"), "the large body must NOT be composed");
  assert(out.length < body.length, "the marker must be far smaller than the body");
});

Deno.test("renderBoundarySkills still composes large NON-imported (owner-authored) bodies", () => {
  const body = bigBody();
  const out = appendSkillsLayer("", [
    { id: "custom", name: "Custom", description: "owner", prompt: body, source: "custom" },
  ]);
  assertStringIncludes(out, body.slice(0, 80), "owner-authored content keeps full composition (no dangling loader)");
  assert(!out.includes("skill_read"));
});

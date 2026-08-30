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

Deno.test("skill_read pagination operates on UTF-8 BYTES (emoji/CJK across a boundary)", async () => {
  // 6000 CJK chars (3 bytes each = 18000) — the 16KiB read boundary falls
  // INSIDE the CJK run, so a multi-byte char splits at the page edge.
  const cjk = "\u4e2d".repeat(6000); // 18000 bytes
  const body = cjk + "\u{1F600}" + "tail-\u00e9\u00e9"; // +4 + 9 bytes = 18013
  const store = { list: async () => [{ id: "cjk", name: "CJK", prompt: "", promptBytes: 18013, source: "imported" }], read: async () => body };
  const { skill_read } = skillReadToolset(store);
  const r1 = await skill_read.execute({ skill: "cjk" });
  assertEquals(r1.ok, true);
  assertEquals(r1.totalBytes, 18013, "totalBytes is UTF-8 bytes");
  assertEquals(r1.bytes, 16 * 1024, "one read is exactly the byte limit");
  assertEquals(r1.truncated, true);
  // page 2 resumes at the BYTE offset — no gap, no overlap, no corruption
  const r2 = await skill_read.execute({ skill: "cjk", offset: r1.nextOffset });
  assertEquals(r2.ok, true);
  assertEquals(r2.offset, 16 * 1024);
  assertEquals(r2.totalBytes, 18013);
  assertEquals(r2.truncated, false);
  assertEquals(r2.bytes, 18013 - 16 * 1024);
  const recombined = r1.text + r2.text;
  // the reassembled text keeps the offset math byte-exact: the ONE split
  // multi-byte char decodes as exactly three U+FFFD (decode-with-replacement:
  // its leading byte ends page 1, its two continuation bytes start page 2),
  // everything else survives byte-for-byte
  const replacements = (recombined.match(/\uFFFD/gu) ?? []).length;
  assertEquals(replacements, 3, "exactly the split char degrades");
  assertEquals(recombined.replace(/\uFFFD/gu, ""), body.slice(0, 5461) + body.slice(5462), "offset math stays byte-exact");
  // the tail emoji survives intact when NOT split
  assertStringIncludes(r2.text, "\u{1F600}");
  assertStringIncludes(r2.text, "tail-\u00e9\u00e9");
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

Deno.test("renderBoundarySkills composes a small imported body fully (untrusted-fenced)", () => {
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

// ── untrusted fencing of IMPORTED skills (review P1) ───────────────────────
// Imported (remote) skill content is UNTRUSTED: its composed body and its
// marker/metadata must carry the run's untrusted boundary, exactly like other
// remote content. Owner-authored content stays unfenced (the trust model).
const FENCE_RE = /<<<UNTRUSTED run:([A-Za-z0-9]+)>>>[\s\S]*?<<<END run:\1>>>/gu;

Deno.test("imported skill content is untrusted-FENCED; owner-authored is not (fence wrapper)", () => {
  const out = appendSkillsLayer("", [
    { id: "small-imp", name: "Small Imp", description: "d", prompt: "remote instructions", source: "imported" },
    { id: "large-imp", name: "Large Imp", description: "l", prompt: "", promptBytes: 99999, source: "imported" },
    { id: "own", name: "Own", description: "o", prompt: "owner instructions", source: "custom" },
  ], undefined, "abc123token");
  const fenced = [...out.matchAll(FENCE_RE)].map((m) => m[0]);
  assert(fenced.length === 2, `exactly the two imported blocks are fenced (got ${fenced.length})`);
  // the imported small body is wrapped + names the token
  assert(fenced.some((b) => b.includes("remote instructions") && b.includes("<<<UNTRUSTED run:abc123token>>>")));
  // the imported large marker is wrapped too
  assert(fenced.some((b) => b.includes("Large Imp") && b.includes("skill_read")));
  // the owner-authored body is NOT inside any fence
  assert(!fenced.some((b) => b.includes("owner instructions")), "owner content must not be fenced");
  assert(out.includes("## Skill: Own\nowner instructions"), "owner body composes plain");
});

Deno.test("imported fence falls back to the placeholder token when absent (preview path)", () => {
  const out = appendSkillsLayer("", [
    { id: "imp", name: "Imp", description: "d", prompt: "body", source: "imported" },
  ]);
  assertStringIncludes(out, "<<<UNTRUSTED run:<run-token>>>");
  assertStringIncludes(out, "<<<END run:<run-token>>>");
});

Deno.test("imported skill with NO body still fences its metadata line", () => {
  const out = appendSkillsLayer("", [
    { id: "empty-imp", name: "Empty Imp", description: "no body", prompt: "", source: "imported" },
  ], undefined, "tok123");
  assertStringIncludes(out, "no body");
  assertStringIncludes(out, "<<<UNTRUSTED run:tok123>>>");
});

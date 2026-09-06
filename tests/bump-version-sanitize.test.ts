// tests/bump-version-sanitize.test.ts — the What's new line that
// scripts/bump-version.mjs derives from a commit subject (chrome-agent-platform-y6z6).
//
// The post-commit hook turns the commit subject into the changelog bullet via
// sanitizeEntry: conventional prefixes, bead ids, SHAs and tracker ids are
// stripped. Until y6z6 it assumed AT MOST ONE leading bead id. A subject that
// closes two beads at once ("<id> + <id>: the change") lost both ids to the
// unanchored id strip and kept the joiner, so the bullet read "- + : the
// change". Nothing downstream rejected that shape either (the companion rule
// lives in changelog-filter.js), so the leak was shippable.
//
// sanitizeEntry is not exported (the script is top-level side effects), so
// every case runs the UNMODIFIED script in a complete scratch mirror — the
// same approach as the bump tests in named-agents-provider.test.ts — and reads
// the bullet it actually wrote.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_SCRIPTS = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts");

// A complete scratch mirror: the real bump + sync scripts, every version
// surface, a changelog with one prior entry. Returns the bump outcome, the
// version the mirror ended on, and the bullet the canonical changelog gained
// (null when nothing was written).
async function bump(message: string, ...flags: string[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-y6z6-"));
  try {
    await mkdir(path.join(dir, "scripts"), { recursive: true });
    for (const f of ["bump-version.mjs", "sync-changelog.mjs"]) {
      await copyFile(path.join(REPO_SCRIPTS, f), path.join(dir, "scripts", f));
    }
    await mkdir(path.join(dir, "extension"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.2.3" }, null, 2));
    await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ name: "t", version: "1.2.3", packages: { "": { name: "t", version: "1.2.3" } } }, null, 2));
    await writeFile(path.join(dir, "extension", "manifest.json"), JSON.stringify({ manifest_version: 3, version: "1.2.3", version_name: "1.2.3" }, null, 2));
    const changelog = "# Changelog\n\n## [1.2.3] — 2026-01-01\n- init\n";
    await writeFile(path.join(dir, "CHANGELOG.md"), changelog);
    await writeFile(path.join(dir, "extension", "CHANGELOG.md"), changelog);
    const r = spawnSync("node", [path.join(dir, "scripts", "bump-version.mjs"), "patch", ...flags, "--message", message], { cwd: dir, encoding: "utf8" });
    const canon = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    const version = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).version as string;
    // Everything the bump prepended sits above the prior entry.
    const head = canon.split("## [1.2.3]")[0];
    const line = head.includes("## [1.2.4]") ? head.split("\n").find((l) => l.startsWith("- ")) : undefined;
    return { status: r.status, stderr: String(r.stderr), version, bullet: line === undefined ? null : line.slice(2) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const WORDS = "the browser self-test now reports failures honestly";

Deno.test("bump-version y6z6: a subject that closes two beads at once yields a bullet that starts with the words, not the joiner", async () => {
  const r = await bump(`chrome-agent-platform-3yfs + chrome-agent-platform-39br: ${WORDS}`);
  assertEquals(r.status, 0, r.stderr);
  assertEquals(r.bullet, WORDS);
});

Deno.test("bump-version y6z6: every joiner shape, id-colon-id, and a three-way subject all strip to the words", async () => {
  const subjects = [
    `chrome-agent-platform-3yfs & chrome-agent-platform-39br: ${WORDS}`,
    `chrome-agent-platform-3yfs, chrome-agent-platform-39br: ${WORDS}`,
    `chrome-agent-platform-3yfs / chrome-agent-platform-39br: ${WORDS}`,
    `chrome-agent-platform-3yfs — chrome-agent-platform-39br: ${WORDS}`,
    `chrome-agent-platform-3yfs: chrome-agent-platform-39br: ${WORDS}`,
    `chrome-agent-platform-a1 + chrome-agent-platform-b2 + chrome-agent-platform-c3: ${WORDS}`,
  ];
  for (const subject of subjects) {
    const r = await bump(subject);
    assertEquals(r.bullet, WORDS, subject);
    assert(/^\w/.test(r.bullet ?? ""), `starts with a word character: ${subject}`);
  }
});

Deno.test("bump-version y6z6: a single-id subject and a leading slash command are untouched", async () => {
  const single = await bump(`chrome-agent-platform-3yfs: ${WORDS}`);
  assertEquals(single.bullet, WORDS);
  // A slash glued to a word is copy (the /folder command), not a joiner: only
  // punctuation FOLLOWED BY WHITESPACE is a leaked joiner.
  const copy = "/folder work — attach a granted local folder as a task reference";
  const slash = await bump(copy);
  assertEquals(slash.bullet, copy);
});

Deno.test("bump-version y6z6: skip-on-empty is unchanged — a merge subject, and a two-id subject with nothing after the joiner, consume no version and write no entry", async () => {
  for (const subject of ["Merge branch 'cap-x' into main", "chrome-agent-platform-3yfs + chrome-agent-platform-39br:"]) {
    const r = await bump(subject, "--skip-if-no-note");
    assertEquals(r.status, 0, subject);
    assertEquals(r.version, "1.2.3", `no version consumed: ${subject}`);
    assertEquals(r.bullet, null, `no entry written: ${subject}`);
    assert(/NOT bumping/.test(r.stderr), `loud notice: ${subject}`);
  }
});

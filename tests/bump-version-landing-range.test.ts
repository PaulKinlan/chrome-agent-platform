// tests/bump-version-landing-range.test.ts — chrome-agent-platform-a4o1s
//
// THE DEFECT. `bump-version --landing --from <sha>` read ONE commit's
// `Release-note:` trailers. The merger passes the commit it is landing, and for
// a multi-commit landing that is a TIP, so the stamp described one commit and
// called it a release: main 88b0dc8b6 was stamped v0.3.753 with the CHANGELOG
// entry "- none." while the release carried the vault-encryption feature. The
// tool behaved as written; the interface invited the error.
//
// WHAT THIS ASSERTS (the bead's acceptance, one test each):
//   (a) stamping a RANGE whose tip declares "none." but whose parent carries a
//       note produces the PARENT's note — a commit's declaration suppresses
//       only itself;
//   (b) a range that collects no note at all REFUSES to stamp rather than
//       writing "- none.";
//   (c) the single-sha path still works but says loudly that it reads one
//       commit and names the range form — the deprecation the bead allows;
//   plus the two properties the range must not lose: notes are deduplicated in
//   commit order, and a re-run of the same range is idempotent (the batch's tip
//   is what the ancestry guard sees).
//
// The fixture is a scratch mirror of the real script (the same shape
// tests/post-commit-hook.test.ts uses), so nothing here touches the repo tree.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { declaresNoUserFacingChange } from "../scripts/lib/release-note.mjs";
import { durableDir } from "../scripts/lib/durable-root.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
const VERSION = "1.2.3";
const surfaces: Record<string, (v: string) => string> = {
  "package.json": (v) => JSON.stringify({ name: "fixture", version: v }) + "\n",
  "package-lock.json": (v) => JSON.stringify({ name: "fixture", version: v, packages: { "": { version: v } } }) + "\n",
  "extension/manifest.json": (v) => JSON.stringify({ manifest_version: 3, version: v, version_name: v }) + "\n",
  "extension/lib/bundled-inventory-data.js": (v) => `export default {\n  "release": "${v}",\n};\n`,
};

function run(dir: string, program: string, args: string[]) {
  return spawnSync(program, args, { cwd: dir, encoding: "utf8" });
}
function git(dir: string, ...args: string[]): string {
  const result = run(dir, "git", args);
  assertEquals(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function mirror(): Promise<string> {
  // Each fixture is a unique scratch git repository under the DURABLE root (the
  // house convention: no tmpdir/tmpfs allocations), removed in finally. Only
  // this fixture's own paths are written — see the EXEMPTIONS entry in
  // scripts/test-partition.mjs.
  const dir = mkdtempSync(path.join(durableDir("bump-version-landing-range"), "run-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "commit.gpgsign", "false");
  for (const rel of ["scripts/lib", "extension/lib", "extension/options"]) {
    await mkdir(path.join(dir, rel), { recursive: true });
  }
  for (const rel of ["scripts/bump-version.mjs", "scripts/sync-changelog.mjs", "scripts/lib/release-note.mjs", "extension/options/changelog-filter.js"]) {
    await copyFile(path.join(ROOT, rel), path.join(dir, rel));
  }
  for (const [rel, render] of Object.entries(surfaces)) await writeFile(path.join(dir, rel), render(VERSION));
  const changelog = `# Changelog\n\n## [${VERSION}] — 2026-01-01\n- initial release\n`;
  await writeFile(path.join(dir, "CHANGELOG.md"), changelog);
  await writeFile(path.join(dir, "extension/CHANGELOG.md"), changelog);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial release");
  return dir;
}
async function changelog(dir: string): Promise<string> {
  return await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
}
async function version(dir: string): Promise<string> {
  return JSON.parse(await readFile(path.join(dir, "extension/manifest.json"), "utf8")).version;
}
async function assertUnstamped(dir: string): Promise<void> {
  assertEquals(await version(dir), VERSION);
  assertEquals(git(dir, "status", "--porcelain"), "");
  assert(!(await changelog(dir)).includes("[1.2.4]"), "nothing may be stamped");
}
/** The bullet lines of ONE version section, in file order (sections are newest first). */
function sectionBullets(log: string, version: string): string[] {
  const lines = log.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  assert(start >= 0, `no [${version}] section in ${log}`);
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## [")) break;
    if (line.startsWith("- ")) bullets.push(line);
  }
  return bullets;
}
function commit(dir: string, message: string, note?: string): string {  const args = ["commit", "-q", "--allow-empty", "-m", message];
  if (note !== undefined) args.push("-m", `Release-note: ${note}`);
  const result = run(dir, "git", args);
  assertEquals(result.status, 0, result.stderr);
  return git(dir, "rev-parse", "HEAD");
}
function stamp(dir: string, ...args: string[]) {
  return run(dir, "node", ["scripts/bump-version.mjs", "patch", "--landing", ...args]);
}

Deno.test("a4o1s (a): a range whose TIP declares 'none.' still carries its parent's note", async () => {
  const dir = await mirror();
  try {
    const base = git(dir, "rev-parse", "HEAD");
    commit(dir, "feat: encryption at rest", "saved service keys are encrypted at rest with a vault passphrase");
    // The r2 CSS fix that was actually passed as --from on main 88b0dc8b6.
    const tip = commit(dir, "fix: banner surface token", "none.");
    const result = stamp(dir, "--from", `${base}..${tip}`);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(dir), "1.2.4");
    const log = await changelog(dir);
    assertEquals((log.match(/## \[1\.2\.4\]/g) ?? []).length, 1, log);
    assert(log.includes("- saved service keys are encrypted at rest with a vault passphrase"),
      `the parent's copy must be the release note: ${log}`);
    assert(!/^- none\.?$/m.test(log), `a tip's 'none.' must never become the release note: ${log}`);
    assert(result.stderr.includes("dropped for that commit only"), "the dropped declaration is named on stderr");

    // The range TIP is the candidate identity the ancestry guard sees, so a
    // re-run of the same batch is the idempotent no-op it must be (x0vas).
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): 1.2.4");
    const rerun = stamp(dir, "--from", `${base}..${tip}`);
    assertEquals(rerun.status, 0, rerun.stderr);
    assert(rerun.stderr.includes("already released"), rerun.stderr);
    assertEquals(await version(dir), "1.2.4");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("a4o1s (b): a range that collects no note at all REFUSES to stamp", async () => {
  const dir = await mirror();
  try {
    const base = git(dir, "rev-parse", "HEAD");
    commit(dir, "chore: reformat");
    const tip = commit(dir, "test: add fixture");
    const result = stamp(dir, "--from", `${base}..${tip}`);
    assert(result.status !== 0, `refused, not stamped 'none': ${result.stderr}`);
    assert(result.stderr.includes("would be stamped"), result.stderr);
    assert(result.stderr.includes("--user-note"), "the remedy is named");
    await assertUnstamped(dir);

    // An explicit --user-note is the decision that unblocks it.
    const withNote = stamp(dir, "--from", `${base}..${tip}`, "--user-note", "the board remembers the last filter you used");
    assertEquals(withNote.status, 0, withNote.stderr);
    assertEquals(await version(dir), "1.2.4");
    assert((await changelog(dir)).includes("- the board remembers the last filter you used"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("a4o1s (c): the single-sha path still works but is LOUD about reading one commit", async () => {
  const dir = await mirror();
  try {
    const sha = commit(dir, "feat: one thing", "you can pin a tab to the board");
    const result = stamp(dir, "--from", sha);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(dir), "1.2.4");
    assert(result.stderr.includes("reads ONE commit"), result.stderr);
    assert(result.stderr.includes("--from <base>..<tip>"), "the range form is named as the remedy");
    assert((await changelog(dir)).includes("- you can pin a tab to the board"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("a4o1s: range notes are deduplicated in COMMIT ORDER, and a 'none.' in the middle drops only itself", async () => {
  const dir = await mirror();
  try {
    const base = git(dir, "rev-parse", "HEAD");
    commit(dir, "feat: first", "you can export conversations");
    commit(dir, "fix: internal", "none.");
    commit(dir, "feat: second", "you can clear conversations");
    commit(dir, "test: duplicate copy", "you can export conversations");
    const tip = commit(dir, "docs: more copy", "you can search the journal");
    const result = stamp(dir, "--from", `${base}..${tip}`);
    assertEquals(result.status, 0, result.stderr);
    const log = await changelog(dir);
    assertEquals((log.match(/## \[1\.2\.4\]/g) ?? []).length, 1, log);
    const bullets = sectionBullets(log, "1.2.4");
    assertEquals(bullets, [
      "- you can export conversations",
      "- you can clear conversations",
      "- you can search the journal",
    ], log);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("a4o1s: a named candidate's 'none.' still aborts the union (the a4o1s fix does not weaken 2rfyx)", async () => {
  // The literal trailer the merger passed on 2026-11-14 was `none.` — a full
  // stop after the word — and the predicate read that full stop as prose, so the
  // landing was stamped "- none.". The spelling is a declaration, not a note.
  assertEquals(declaresNoUserFacingChange("none."), true, "'none.' is the word plus punctuation");
  assertEquals(declaresNoUserFacingChange("none ."), true);
  assertEquals(declaresNoUserFacingChange("none"), true);
  assertEquals(declaresNoUserFacingChange("none of the saved keys are ever sent"), false,
    "prose that merely starts with the word is not a declaration");
  const dir = await mirror();
  try {
    commit(dir, "feat: visible", "you can export conversations");
    const bad = commit(dir, "fix: internal", "none.");
    const result = stamp(dir, "--from", bad);
    assert(result.status !== 0, `a named 'none.' candidate is still refused: ${result.stderr}`);
    assert(/declares no user-facing change/.test(result.stderr), result.stderr);
    await assertUnstamped(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("a4o1s + g0bfz: a MID-BODY note inside a range is still collected (body view), and the disagreement is named", async () => {
  const dir = await mirror();
  try {
    const base = git(dir, "rev-parse", "HEAD");
    // The note is real but NOT a trailer block: a paragraph follows it, so git's
    // own parser sees nothing while the stamp's body scan does (g0bfz, measured
    // on 0740d9df0). A range must not lose it: the same body view that served
    // one commit serves every commit in the batch.
    const made = run(dir, "git", [
      "commit", "-q", "--allow-empty",
      "-m", "feat: journal search",
      "-m", "Release-note: you can search the journal",
      "-m", "A closing paragraph that is not a trailer, which is what makes the note mid-body.",
    ]);
    assertEquals(made.status, 0, made.stderr);
    const tip = git(dir, "rev-parse", "HEAD");
    const result = stamp(dir, "--from", `${base}..${tip}`);
    assertEquals(result.status, 0, result.stderr);
    assert(sectionBullets(await changelog(dir), "1.2.4").includes("- you can search the journal"),
      "the mid-body note is collected from the range, not silently dropped");
    assert(result.stderr.includes("WARNING: candidate"), "the shape disagreement is still reported per commit");
    assert(result.stderr.includes("git's trailer parser"), "and it names the parser that cannot see it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("rfy90: --internal IS the remedy a fully-internal range needs — the refusal only fires for an undeclared batch", async () => {
  const dir = await mirror();
  try {
    const base = git(dir, "rev-parse", "HEAD");
    const one = commit(dir, "chore: reformat");
    const two = commit(dir, "test: add fixture");
    const tip = commit(dir, "docs: more prose");
    const range = `${base}..${tip}`;

    // 1. The refusal NAMES the commits still undeclared, so the printed remedy is actionable.
    const partial = stamp(dir, "--from", range, "--internal", one);
    assert(partial.status !== 0, `still refused while two commits are undeclared: ${partial.stderr}`);
    assert(partial.stderr.includes("2 of 3 range commit(s) are not declared yet"), partial.stderr);
    assert(partial.stderr.includes("--user-note"), "the copy is offered first");
    await assertUnstamped(dir);

    // 2. A batch where EVERY commit is declared internal mints NO release (exit 0, nothing written) —
    //    the same answer a single internal candidate already gets. Before rfy90 the message asked for
    //    --internal and then refused anyway, so the advertised exit from the refusal did not exist.
    const allInternal = stamp(dir, "--from", range, "--internal", one, "--internal", two, "--internal", tip);
    assertEquals(allInternal.status, 0, allInternal.stderr);
    await assertUnstamped(dir);
    assertEquals(await version(dir), VERSION, "an internal-only batch does not consume a version");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

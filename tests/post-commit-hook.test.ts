// Release identity belongs to the merger, not a feature branch (uikt5).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
const VERSION = "1.2.3";
const surfaces: Record<string, (v: string) => string> = {
  "package.json": (v) => JSON.stringify({ name: "fixture", version: v }) + "\n",
  "package-lock.json": (v) => JSON.stringify({ name: "fixture", version: v, packages: { "": { version: v } } }) + "\n",
  "extension/manifest.json": (v) => JSON.stringify({ manifest_version: 3, version: v, version_name: v }) + "\n",
  "extension/lib/bundled-inventory-data.js": (v) => `export default {\n  "release": "${v}",\n};\n`,
};
function run(dir: string, program: string, args: string[], env = {}) {
  return spawnSync(program, args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}
function git(dir: string, ...args: string[]) {
  const result = run(dir, "git", args);
  assertEquals(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function mirror() {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-landing-stamp-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "fixture@example.invalid");
  git(dir, "config", "user.name", "fixture");
  git(dir, "config", "commit.gpgsign", "false");
  for (const rel of ["scripts/git-hooks", "extension/options", "extension/lib"]) {
    await mkdir(path.join(dir, rel), { recursive: true });
  }
  for (const rel of ["scripts/bump-version.mjs", "scripts/sync-changelog.mjs", "extension/options/changelog-filter.js"]) {
    await copyFile(path.join(ROOT, rel), path.join(dir, rel));
  }
  for (const [rel, render] of Object.entries(surfaces)) await writeFile(path.join(dir, rel), render(VERSION));
  const changelog = `# Changelog\n\n## [${VERSION}] — 2026-01-01\n- initial release\n`;
  await writeFile(path.join(dir, "CHANGELOG.md"), changelog);
  await writeFile(path.join(dir, "extension/CHANGELOG.md"), changelog);
  const hook = path.join(dir, ".git/hooks/post-commit");
  await copyFile(path.join(ROOT, "scripts/git-hooks/post-commit"), hook);
  await chmod(hook, 0o755);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial release");
  return dir;
}
async function version(dir: string) {
  return JSON.parse(await readFile(path.join(dir, "extension/manifest.json"), "utf8")).version;
}
async function assertUnstamped(dir: string) {
  assertEquals(await version(dir), VERSION);
  assertEquals(git(dir, "status", "--porcelain"), "");
  assert(!(await readFile(path.join(dir, "CHANGELOG.md"), "utf8")).includes("[1.2.4]"));
}
function commit(dir: string, message: string, note?: string, env = {}) {
  const args = ["commit", "-q", "--allow-empty", "-m", message];
  if (note !== undefined) args.push("-m", `Release-note: ${note}`);
  const result = run(dir, "git", args, env);
  assertEquals(result.status, 0, result.stderr);
  return git(dir, "rev-parse", "HEAD");
}
function stamp(dir: string, ...args: string[]) {
  return run(dir, "node", ["scripts/bump-version.mjs", "patch", "--landing", ...args]);
}

Deno.test("uikt5: every lane commit stays unstamped, even with trailer or CAP_USER_NOTE", async () => {
  const dir = await mirror();
  try {
    commit(dir, "visible work", "you can export conversations");
    await assertUnstamped(dir);
    commit(dir, "internal work", undefined, { CAP_USER_NOTE: "you can clear conversations" });
    await assertUnstamped(dir);
    assertEquals(stamp(dir).status, 0, "no note produces no release");
    await assertUnstamped(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("uikt5: two trailed branch commits become ONE landing release with both bullets", async () => {
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    const second = commit(dir, "another branch", "you can clear conversations");
    await assertUnstamped(dir);
    const result = stamp(dir, "--from", first, "--from", second);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(dir), "1.2.4");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.4\]/g) ?? []).length, 1, log);
    assert(log.includes("- you can export conversations"));
    assert(log.includes("- you can clear conversations"));
    for (const [rel] of Object.entries(surfaces)) {
      assert((await readFile(path.join(dir, rel), "utf8")).includes("1.2.4"), rel);
    }
    assertEquals(git(dir, "show", "HEAD:extension/manifest.json").includes("1.2.4"), false,
      "the merger must commit the stamp itself, not rewrite branch commits");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("x0vas: re-running the same landing batch is idempotent — no duplicate release", async () => {
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    const result = stamp(dir, "--from", first);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(dir), "1.2.4");
    // The merger commits the stamp; a later re-run of step 3a (amended landing
    // message, retried batch) reads the COMMITTED release and must no-op. The
    // UNCOMMITTED stamp is the other legitimate re-run (gate failure before the
    // stamp commit): the tree-state equality is the evidence there (66voq).
    const rerunUncommitted = stamp(dir, "--from", first);
    assertEquals(rerunUncommitted.status, 0, rerunUncommitted.stderr);
    assert(rerunUncommitted.stderr.includes("already released"), rerunUncommitted.stderr);
    assertEquals(await version(dir), "1.2.4");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): 1.2.4");
    const rerun = stamp(dir, "--from", first);
    assertEquals(rerun.status, 0, rerun.stderr);
    assert(rerun.stderr.includes("already released"), rerun.stderr);
    assertEquals(await version(dir), "1.2.4");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.4\]/g) ?? []).length, 1, log);
    assertEquals(git(dir, "status", "--porcelain"), "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("x0vas: a batch with a NEW effect still stamps after an earlier release", async () => {
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    assertEquals(stamp(dir, "--from", first).status, 0);
    const second = commit(dir, "another branch", "you can clear conversations");
    const result = stamp(dir, "--from", second);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(dir), "1.2.5");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.5\]/g) ?? []).length, 1, log);
    assert(log.includes("- you can clear conversations"), log);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("66voq: a DIFFERENT batch reusing the same Release-note text must STAMP, never skip", async () => {
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    assertEquals(stamp(dir, "--from", first).status, 0);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): 1.2.4");
    // A second union carries an IDENTICAL note line. Note-text matching alone
    // (the 66voq hole) silently skipped it as "already released"; the ancestry
    // check must see that this new sha is NOT in the newest section's history.
    const second = commit(dir, "another branch", "you can export conversations");
    assert(second !== first, "fixture must produce a distinct sha");
    const result = stamp(dir, "--from", second);
    assertEquals(result.status, 0, result.stderr);
    assert(result.stderr.includes("NOT produced by this batch"), result.stderr);
    assertEquals(await version(dir), "1.2.5", "the second batch gets its own release");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.5\]/g) ?? []).length, 1, log);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("p0ll0: an unrelated DIRTY CHANGELOG edit is not an uncommitted stamp — the batch STAMPS", async () => {
  // Review of 178298b4d: after an ancestry miss the old probe asked "does
  // CHANGELOG.md differ from HEAD?" — which ANY unrelated local edit satisfies —
  // and exited 0 claiming an UNCOMMITTED same-batch stamp. A clean, committed
  // section plus a dirty two-line edit lost the release, the direction that must
  // never happen. Only "HEAD does not carry this section yet" is that evidence.
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    assertEquals(stamp(dir, "--from", first).status, 0);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): 1.2.4");
    // A genuinely NEW batch carrying identical copy: ancestry cannot match it.
    const second = commit(dir, "another union", "you can export conversations");
    assert(second !== first, "fixture must produce a distinct sha");
    // …and the tree is dirty for a reason that has nothing to do with this batch.
    // The destination is written LITERALLY as path.join(dir, ...) on purpose:
    // the partition guard inspects every write site, and an indirection through
    // a local name revokes this file's reviewed scratch-fixture exemption.
    const before = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    await writeFile(path.join(dir, "CHANGELOG.md"), `${before}\n- an unrelated hand edit\n`);
    assertEquals(git(dir, "status", "--porcelain"), "M CHANGELOG.md",
      "the fixture must actually leave CHANGELOG.md dirty");
    const result = stamp(dir, "--from", second);
    assertEquals(result.status, 0, result.stderr);
    assert(!result.stderr.includes("UNCOMMITTED"), result.stderr);
    assertEquals(await version(dir), "1.2.5",
      "a dirty-but-unrelated CHANGELOG must never swallow a release");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.5\]/g) ?? []).length, 1, log);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("axtv2: a section introduced by a MERGE commit is attributed — the same batch's re-run skips", async () => {
  // The merger resolved a landing INTO the merge commit: the section exists only
  // in the merge's own diff. Plain `git log -S` skips merges, so without `-m`
  // the introducer reads null and the re-run loses the release. With `-m` the
  // introducer is the merge and the batch's ancestry decides.
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    git(dir, "checkout", "-q", "-b", "side");
    commit(dir, "unrelated side change");
    git(dir, "checkout", "-q", "-");
    git(dir, "merge", "--no-ff", "--no-commit", "side");
    const changelog = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    const stamped = changelog.replace(
      /# Changelog\n/,
      `# Changelog\n\n## [1.2.4] — 2026-01-02\n- you can export conversations\n`,
    );
    assert(stamped !== changelog, "fixture must actually add the section");
    await writeFile(path.join(dir, "CHANGELOG.md"), stamped);
    // The merge carries the WHOLE stamp (merger reality): every version surface.
    for (const [rel, render] of Object.entries(surfaces)) {
      await writeFile(path.join(dir, rel), render("1.2.4"));
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "merge landing: the section lives only in this merge commit");
    assertEquals(git(dir, "status", "--porcelain"), "", "the stamp is COMMITTED — this is not an uncommitted restamp");
    const rerun = stamp(dir, "--from", first);
    assertEquals(rerun.status, 0, rerun.stderr);
    assert(rerun.stderr.includes("already released"), rerun.stderr);
    // Discriminator against the inverted fallback: the skip must be ATTRIBUTED
    // to the merge commit, not inferred from tree-state equality (which is what
    // the axtv2 bug did — and which read this clean tree as "uncommitted").
    assert(rerun.stderr.includes("produced by this exact batch"), rerun.stderr);
    assert(rerun.stderr.includes("introducer"), rerun.stderr);
    assert(!rerun.stderr.includes("UNCOMMITTED"), rerun.stderr);
    assertEquals(await version(dir), "1.2.4", "the re-run must not double-stamp past the merge-carried section (stay at 1.2.4, never 1.2.5)");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.4\]/g) ?? []).length, 1, log);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("axtv2: a TRUNCATED (shallow) history never degrades into a skipped release", async () => {
  // The merger's clone can be shallow: the commit that introduced the newest
  // section is outside the fetched history. Attribution then rests on the
  // shallow boundary commit, and a genuinely NEW batch must still STAMP. The
  // inverted fallback (current === changelogVersion ⇒ "uncommitted stamp") read
  // this state as a re-run and dropped the release.
  const dir = await mirror();
  const shallowParent = await mkdtemp(path.join(tmpdir(), "cap-shallow-"));
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    assertEquals(stamp(dir, "--from", first).status, 0);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): 1.2.4");
    const shallow = path.join(shallowParent, "clone");
    git(dir, "clone", "-q", "--depth", "1", `file://${dir}`, shallow);
    assertEquals(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
    assertEquals(git(shallow, "rev-list", "--count", "HEAD"), "1", "the fixture must REALLY truncate history");
    git(shallow, "config", "user.email", "fixture@example.invalid");
    git(shallow, "config", "user.name", "fixture");
    git(shallow, "config", "commit.gpgsign", "false");
    const second = commit(shallow, "another union", "you can export conversations");
    const result = stamp(shallow, "--from", second);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(shallow), "1.2.5", "truncated history must never suppress a release");
    const log = await readFile(path.join(shallow, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.5\]/g) ?? []).length, 1, log);
  } finally {
    await rm(shallowParent, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

Deno.test("axtv2: an UNATTRIBUTABLE section (git cannot answer) STAMPS, never skips", async () => {
  // axtv2's inverted fallback: `introducer === null && current === changelogVersion`
  // is true on EVERY clean checkout, so a git failure during attribution turned a
  // genuinely unreleased batch into a silent skip. A duplicate stamp is the
  // acceptable failure direction; a lost release is not.
  const dir = await mirror();
  try {
    const first = commit(dir, "one branch", "you can export conversations");
    assertEquals(stamp(dir, "--from", first).status, 0);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore(release): 1.2.4");
    // Fault injection: a git that answers everything EXCEPT the pickaxe
    // attribution query (`log ... -S`), which is exactly the git-error case.
    const realGit = run(dir, "sh", ["-c", "command -v git"]).stdout.trim();
    assert(realGit, "fixture needs a real git to delegate to");
    const faultBin = path.join(dir, "faultbin");
    await mkdir(path.join(dir, "faultbin"), { recursive: true });
    await writeFile(path.join(dir, "faultbin", "git"), `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    -S*) echo "fatal: simulated attribution failure" >&2; exit 128;;\n  esac\ndone\nexec "$GIT_REAL" "$@"\n`);
    await chmod(path.join(dir, "faultbin", "git"), 0o755);
    const env = { PATH: `${faultBin}:${process.env.PATH}`, GIT_REAL: realGit };
    const result = run(dir, "node", ["scripts/bump-version.mjs", "patch", "--landing", "--from", first], env);
    assertEquals(result.status, 0, result.stderr);
    assert(result.stderr.includes("unattributable"), result.stderr);
    assertEquals(await version(dir), "1.2.5", "an unattributable section must not swallow the release");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.5\]/g) ?? []).length, 1, log);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("3er9j: mixed union refuses a trailer-less candidate unless named internal", async () => {
  const dir = await mirror();
  try {
    const first = commit(dir, "visible branch", "you can share conversations");
    const second = commit(dir, "download button for artifacts");
    const refused = stamp(dir, "--from", first, "--from", second);
    assert(refused.status !== 0, "missing trailer in mixed batch must block landing");
    assert(refused.stderr.includes(second), `must name the missing candidate: ${refused.stderr}`);
    assert(refused.stderr.includes("--internal"), refused.stderr);
    await assertUnstamped(dir);
    const allowed = stamp(dir, "--from", first, "--from", second, "--internal", second);
    assertEquals(allowed.status, 0, allowed.stderr);
    assertEquals(await version(dir), "1.2.4");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assert(log.includes("- you can share conversations"));
    assert(!log.includes("download button for artifacts"), "explicitly internal candidate adds no invented bullet");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("3er9j: unmatched or trailed --internal candidate fails without stamping", async () => {
  const dir = await mirror();
  try {
    const trailed = commit(dir, "visible", "you can share conversations");
    const missing = stamp(dir, "--from", trailed, "--internal", trailed);
    assert(missing.status !== 0 && missing.stderr.includes(trailed), missing.stderr);
    const stray = stamp(dir, "--from", trailed, "--internal", git(dir, "rev-parse", "HEAD~1"));
    assert(stray.status !== 0 && stray.stderr.includes("not a --from candidate"), stray.stderr);
    await assertUnstamped(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("uikt5: legacy one-patch surface skew reconciles during landing without a hand reset", async () => {
  const dir = await mirror();
  try {
    const candidate = commit(dir, "visible", "you can export conversations");
    for (const [rel, render] of Object.entries(surfaces)) {
      await writeFile(path.join(dir, rel), render("1.2.4"));
    }
    const result = stamp(dir, "--reconcile-merge", "--from", candidate);
    assertEquals(result.status, 0, result.stderr);
    assertEquals(await version(dir), "1.2.4");
    const log = await readFile(path.join(dir, "CHANGELOG.md"), "utf8");
    assertEquals((log.match(/## \[1\.2\.4\]/g) ?? []).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

Deno.test("uikt5: a self-declared internal note aborts the entire union before stamping", async () => {
  const dir = await mirror();
  try {
    const good = commit(dir, "visible", "you can export conversations");
    const bad = commit(dir, "internal", "none: internal tooling");
    const result = stamp(dir, "--from", good, "--from", bad);
    assert(result.status !== 0);
    assert(/none: internal/.test(result.stderr), result.stderr);
    await assertUnstamped(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

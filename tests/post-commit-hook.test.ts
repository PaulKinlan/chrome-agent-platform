// tests/post-commit-hook.test.ts — the post-commit bump policy (chrome-agent-platform-8nec).
//
// The hook used to turn the commit SUBJECT into the release note. That was wrong in both
// directions: a bookkeeping subject with no jargon word consumed a version and wrote a
// changelog entry the user would never see, and a genuinely user-facing subject that named a
// component (harness, bridge) was declined, so the change shipped with no note. It was also
// once per COMMIT, so a second commit on a branch bumped again.
//
// The policy now:
//   A. only an explicit note bumps — a `Release-note: ...` line in the commit body, or
//      CAP_USER_NOTE in the environment. The subject is never a note source.
//   B. one bump per BRANCH — when the working version no longer matches origin/main's, the
//      branch already carries the bump (or is behind main) and nothing is written.
//
// These tests install the REFERENCE hook in a real scratch repository and make real commits:
// the policy is the hook shell and the script together, and a test of either half alone can
// pass while the pair misbehaves.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(new URL(import.meta.url))), "..");
const REPO_SCRIPTS = path.join(REPO_ROOT, "scripts");

const INITIAL = "1.2.3";
const SURFACES: Record<string, (version: string) => string> = {
  "package.json": (v) => JSON.stringify({ name: "t", version: v }, null, 2) + "\n",
  "package-lock.json": (v) =>
    JSON.stringify({ name: "t", version: v, packages: { "": { name: "t", version: v } } }, null, 2) + "\n",
  "extension/manifest.json": (v) =>
    JSON.stringify({ manifest_version: 3, version: v, version_name: v }, null, 2) + "\n",
  "extension/lib/bundled-inventory-data.js": (v) => `export default {\n  "release": "${v}",\n};\n`,
};
const changelogFor = (version: string) =>
  `# Changelog\n\n## [${version}] — 2026-01-01\n- init\n`;

function git(dir: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A scratch mirror carrying everything the hook and bump-version touch, a real git repository
// with the reference hook installed, and origin/main pinned at the initial commit.
async function mirror() {
  const dir = await mkdtemp(path.join(tmpdir(), "cap-8nec-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "8nec@example.invalid");
  git(dir, "config", "user.name", "8nec fixture");
  git(dir, "config", "commit.gpgsign", "false");
  await mkdir(path.join(dir, "scripts", "git-hooks"), { recursive: true });
  await mkdir(path.join(dir, "extension", "options"), { recursive: true });
  await mkdir(path.join(dir, "extension", "lib"), { recursive: true });
  for (const file of ["bump-version.mjs", "sync-changelog.mjs"]) {
    await copyFile(path.join(REPO_SCRIPTS, file), path.join(dir, "scripts", file));
  }
  await copyFile(
    path.join(REPO_ROOT, "extension", "options", "changelog-filter.js"),
    path.join(dir, "extension", "options", "changelog-filter.js"),
  );
  for (const [rel, render] of Object.entries(SURFACES)) {
    await writeFile(path.join(dir, rel), render(INITIAL));
  }
  await writeFile(path.join(dir, "CHANGELOG.md"), changelogFor(INITIAL));
  await writeFile(path.join(dir, "extension", "CHANGELOG.md"), changelogFor(INITIAL));
  const hook = path.join(dir, ".git", "hooks", "post-commit");
  await copyFile(path.join(REPO_SCRIPTS, "git-hooks", "post-commit"), hook);
  await chmod(hook, 0o755);

  // The fixture's own initial commit: the hook runs, finds no explicit note and bumps nothing.
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture: initial tree with no release note");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  return dir;
}

function commit(dir: string, subject: string, body?: string, env: Record<string, string> = {}) {
  const args = ["commit", "-q", "--allow-empty", "-m", subject];
  if (body) args.push("-m", body);
  return spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

async function workingVersion(dir: string) {
  return JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")).version as string;
}

async function commitVersion(dir: string) {
  return JSON.parse(git(dir, "show", "HEAD:extension/manifest.json")).version as string;
}

class Scratch {
  dir = "";
  async setup() {
    this.dir = await mirror();
    return this;
  }
  async cleanup() {
    if (this.dir) await rm(this.dir, { recursive: true, force: true });
  }
  async changelog() {
    return readFile(path.join(this.dir, "CHANGELOG.md"), "utf8");
  }
}

Deno.test("8nec A: a plain user-facing subject with no explicit note consumes no version", async () => {
  const scratch = await new Scratch().setup();
  try {
    const r = commit(scratch.dir, "the browser self-test now reports failures honestly");
    assertEquals(r.status, 0, r.stderr);
    assertEquals(await workingVersion(scratch.dir), INITIAL, "the subject must not bump");
    assert(!(await scratch.changelog()).includes("[1.2.4]"));
    assert(/NOT bumping/.test(String(r.stderr)), `a loud notice is required: ${r.stderr}`);
  } finally {
    await scratch.cleanup();
  }
});

Deno.test("8nec A: the bookkeeping subject that burned a version before no longer bumps", async () => {
  const scratch = await new Scratch().setup();
  try {
    const r = commit(scratch.dir, "delete the journal guess instead of guarding");
    assertEquals(r.status, 0, r.stderr);
    assertEquals(await workingVersion(scratch.dir), INITIAL);
    assert(!(await scratch.changelog()).includes("[1.2.4]"));
  } finally {
    await scratch.cleanup();
  }
});

Deno.test("8nec A: a jargon subject with a Release-note trailer bumps with the trailer copy", async () => {
  const scratch = await new Scratch().setup();
  try {
    const note = "external agents can call every browser tool, and the ones that need approval still ask";
    const r = commit(scratch.dir, "fix(harness): rework the bridge transport", `Release-note: ${note}`);
    assertEquals(r.status, 0, r.stderr);
    assertEquals(await workingVersion(scratch.dir), "1.2.4");
    assertEquals(await commitVersion(scratch.dir), "1.2.4",
      "the hook's amend must leave HEAD carrying the bumped surfaces");
    const log = await scratch.changelog();
    assert(log.includes("## [1.2.4]"), log);
    assert(log.includes(`- ${note}`), log);
  } finally {
    await scratch.cleanup();
  }
});

Deno.test("8nec A: CAP_USER_NOTE bumps without a trailer", async () => {
  const scratch = await new Scratch().setup();
  try {
    const note = "you can clear one conversation without clearing the rest";
    const r = commit(scratch.dir, "fix: internal subject", undefined, { CAP_USER_NOTE: note });
    assertEquals(r.status, 0, r.stderr);
    assertEquals(await workingVersion(scratch.dir), "1.2.4");
    assert((await scratch.changelog()).includes(`- ${note}`));
  } finally {
    await scratch.cleanup();
  }
});

Deno.test("8nec B: a second Release-note commit on the branch does not bump again", async () => {
  const scratch = await new Scratch().setup();
  try {
    const first = "external agents can call every browser tool, and the ones that need approval still ask";
    commit(scratch.dir, "fix: first", `Release-note: ${first}`);
    assertEquals(await workingVersion(scratch.dir), "1.2.4");

    const second = "you can export all your memory to a file";
    const r = commit(scratch.dir, "fix: second", `Release-note: ${second}`);
    assertEquals(r.status, 0, r.stderr);
    assertEquals(await workingVersion(scratch.dir), "1.2.4", "one bump per branch");
    assert(/NOT bumping again/.test(String(r.stderr)), `explain the skip: ${r.stderr}`);
    const log = await scratch.changelog();
    assertEquals((log.match(/\[1\.2\.4\]/g) ?? []).length, 1, "exactly one bump entry");
    assert(!log.includes(second), "the second note must not be published");
  } finally {
    await scratch.cleanup();
  }
});

Deno.test("8nec B: a branch behind origin/main refuses to consume a version", async () => {
  const scratch = await new Scratch().setup();
  try {
    // Main moves on: its version is now 1.2.4.
    for (const [rel, render] of Object.entries(SURFACES)) {
      await writeFile(path.join(scratch.dir, rel), render("1.2.4"));
    }
    await writeFile(
      path.join(scratch.dir, "CHANGELOG.md"),
      "# Changelog\n\n## [1.2.4] — 2026-01-02\n- main moved\n\n## [1.2.3] — 2026-01-01\n- init\n",
    );
    await writeFile(
      path.join(scratch.dir, "extension", "CHANGELOG.md"),
      "# Changelog\n\n## [1.2.4] — 2026-01-02\n- main moved\n\n## [1.2.3] — 2026-01-01\n- init\n",
    );
    git(scratch.dir, "add", "-A");
    git(scratch.dir, "commit", "-q", "-m", "main moves to 1.2.4");
    git(scratch.dir, "update-ref", "refs/remotes/origin/main", "HEAD");

    // The feature branch was cut before that: its tree is 1.2.3 and must not bump.
    git(scratch.dir, "checkout", "-q", "-b", "feature", "HEAD~1");
    const note = "you can export all your memory to a file";
    const r = commit(scratch.dir, "fix: feature work", `Release-note: ${note}`);
    assertEquals(r.status, 0, r.stderr);
    assertEquals(await workingVersion(scratch.dir), "1.2.3", "rebase before bumping");
    assert(/origin\/main is at 1\.2\.4/.test(String(r.stderr)), `name the cause: ${r.stderr}`);
    assert(!(await scratch.changelog()).includes("[1.2.4]"), "no entry on a stale branch");
  } finally {
    await scratch.cleanup();
  }
});

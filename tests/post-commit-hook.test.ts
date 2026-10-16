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

// tests/chrome-profile-location.test.ts — chrome-agent-platform-9t1b
//
// A live Chrome profile is a directory the browser mutates continuously: it
// creates and unlinks `Default/DIPS-journal`, lock files and WAL segments while
// it runs. When that directory sits INSIDE the working tree
// (`${ROOT}.cache/kat-<name>-<stamp>`, ~32 harnesses), anything that copies,
// packages, archives or measures the tree races the browser and loses — and the
// failure reads as a defect in whatever happened to be copying:
//
//   cp: cannot stat '<repo>/.cache/kat-bgagent-delete-1788697263982/Default/
//   DIPS-journal': No such file or directory
//
// That is exactly how `tests/cdp-client.test.ts` went red during a full
// `npm test` once chrome-agent-platform-uzik let harnesses overlap.
//
// So: profiles live outside the repo, on disk, one per instance. These tests
// pin all four properties, plus the live race itself — a real browser holding a
// profile while the whole tree is copied.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  chromeProfileDir,
  isInsideRepo,
  PROFILE_ROOT_NAME,
  pruneChromeProfileDirs,
  repoRoot,
} from "../scripts/lib/chrome-profile-dir.ts";
import { durableRoot, isRamBacked } from "../scripts/lib/durable-root.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const SCRIPTS = `${ROOT}/scripts`;

function scriptFiles(dir = SCRIPTS, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isDirectory) out.push(...scriptFiles(`${dir}/${e.name}`, `${prefix}${e.name}/`));
    else if (/\.(ts|mjs)$/u.test(e.name)) out.push(`${prefix}${e.name}`);
  }
  return out;
}

Deno.test("9t1b: no Chrome profile in scripts/ lives inside the repository", () => {
  // Every `--user-data-dir=` value, in every harness, must not be repo-relative.
  // The repo-relative forms are the ones that race a copy: `${ROOT}.cache/…`,
  // anything derived from import.meta.url, and bare relative paths.
  const offenders: string[] = [];
  let sites = 0;
  for (const rel of scriptFiles()) {
    const src = Deno.readTextFileSync(`${SCRIPTS}/${rel}`);
    src.split("\n").forEach((line, i) => {
      const at = line.indexOf("--user-data-dir=");
      if (at < 0) return;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      sites++;
      const value = line.slice(at + "--user-data-dir=".length)
        .split(/[`'"]/u)[0].split(",")[0].replace(/[\s)\];]+$/u, "").trim();
      const repoRelative =
        value.includes("${ROOT}") ||
        value.includes("ROOT}") ||
        value.includes("import.meta.url") ||
        /^\.\.?\//u.test(value);
      if (repoRelative) offenders.push(`${rel}:${i + 1} → ${value}`);
    });
  }
  assert(sites >= 40, `the scan found the launch sites (${sites})`);
  assertEquals(
    offenders,
    [],
    "a Chrome profile still lives inside the repo — a whole-tree copy races a live browser " +
      "(cp: cannot stat '…/.cache/kat-*/Default/DIPS-journal'). Use chromeProfileDir() " +
      "from scripts/lib/chrome-profile-dir.ts:\n" + offenders.join("\n"),
  );
});

Deno.test("9t1b: chromeProfileDir is outside the repo, on disk, and unique per call", () => {
  const a = chromeProfileDir("kat-test-profile");
  const b = chromeProfileDir("kat-test-profile");
  assert(a !== b, "two calls must never share a profile (Chrome's SingletonLock)");
  assertEquals(isInsideRepo(a), false, `the profile is outside the repo: ${a}`);
  assertEquals(isRamBacked(a), false, `the profile is on disk, not tmpfs: ${a}`);
  assert(a.startsWith(`${durableRoot()}/${PROFILE_ROOT_NAME}/`), `under the durable profile root: ${a}`);
  assert(a.includes(`-${Deno.pid}-`), `carries the pid, so two lanes cannot collide: ${a}`);
  assertEquals(Deno.statSync(a).isDirectory, true, "created and ready to pass to Chrome");
  // The name is validated because it becomes a path segment.
  for (const bad of ["../escape", "a/b", "", "UPPER", "lead-dash-", "x".repeat(80), "spaced name"]) {
    let threw = false;
    try { chromeProfileDir(bad); } catch { threw = true; }
    assert(threw, `chromeProfileDir refuses ${JSON.stringify(bad)}`);
  }
  Deno.removeSync(a, { recursive: true });
  Deno.removeSync(b, { recursive: true });
});

Deno.test("9t1b: isInsideRepo sees through a symlink into the tree", () => {
  assertEquals(isInsideRepo(ROOT), true, "the repo root is inside the repo");
  assertEquals(isInsideRepo(`${ROOT}/scripts`), true);
  assertEquals(isInsideRepo(`${durableRoot()}/${PROFILE_ROOT_NAME}`), false);
  // A symlink OUTSIDE the tree that points INTO it is still inside: realpath
  // decides, so a profile cannot be smuggled into the copy by indirection.
  const outside = Deno.makeTempDirSync({ prefix: "9t1b-link-" });
  const link = `${outside}/into-cache`;
  try {
    Deno.mkdirSync(`${ROOT}/.cache`, { recursive: true });
    Deno.symlinkSync(`${ROOT}/.cache`, link, { type: "dir" });
    assertEquals(isInsideRepo(`${link}/profile`), true, "a symlink into the tree resolves into the tree");
  } finally {
    Deno.removeSync(link, { recursive: true });
    Deno.removeSync(outside, { recursive: true });
  }
  assertEquals(repoRoot().length > 0, true);
  assertEquals(repoRoot().endsWith("/"), false, "no trailing slash (prefix checks stay exact)");
});

Deno.test("9t1b: a REAL browser holds its profile while the whole tree is copied", async () => {
  // The race, driven for real: launch Chrome with a profile from the helper,
  // keep it alive, and copy the WHOLE working tree underneath it — the exact
  // command that failed in tests/cdp-client.test.ts (`cp -a <repo>/. <dst>/.`).
  // Before this bead the profile was inside the tree, so the copy died on files
  // Chrome unlinked mid-copy. It costs a few seconds of I/O; that is the point.
  const { launchChrome } = await import("../scripts/lib/chrome-launch.ts");
  const profile = chromeProfileDir("kat-live-copy");
  const scratch = Deno.makeTempDirSync({ prefix: "9t1b-copy-" });
  const lockScope = await Deno.makeTempFile({ prefix: "9t1b-scope-" });
  let proc: Deno.ChildProcess | null = null;
  try {
    const launched = await launchChrome({
      extension: `${ROOT}/extension`,
      profile,
      timeoutMs: 25000,
      lockPath: lockScope, // a unit-scope lock: never queue behind a real gate
    });
    proc = launched.proc;
    // Chrome is up and mutating its profile: prove it, then copy the tree.
    await new Promise((r) => setTimeout(r, 1500));
    const entries = [...Deno.readDirSync(profile)].map((e) => e.name);
    assert(entries.length > 0, `the profile is live: ${entries.slice(0, 5).join(",")}`);
    const cp = await new Deno.Command("cp", {
      args: ["-a", `${ROOT}/.`, `${scratch}/.`],
      stdout: "piped", stderr: "piped",
    }).output();
    assertEquals(cp.code, 0, `copying the tree under a live browser: ${new TextDecoder().decode(cp.stderr)}`);
    // And the tree holds no Chrome profile. KATs still keep EVIDENCE (screenshots,
    // verdicts) under `.cache/kat-<name>/`, which is fine — a file written once
    // is not a directory a browser mutates continuously. What must be gone is
    // the profile signature: Chrome's `Default/`, `SingletonLock`, `Local State`.
    const looksLikeProfile = (dir: string) =>
      ["Default", "SingletonLock", "Local State", "GrShaderCache"].some((marker) => {
        try { Deno.lstatSync(`${dir}/${marker}`); return true; } catch { return false; }
      });
    const offenders: string[] = [];
    for (const entry of Deno.readDirSync(ROOT)) {
      if (!entry.isDirectory) continue;
      for (const inner of Deno.readDirSync(`${ROOT}/${entry.name}`)) {
        if (!inner.isDirectory) continue;
        const path = `${ROOT}/${entry.name}/${inner.name}`;
        if (looksLikeProfile(path)) offenders.push(`${entry.name}/${inner.name}`);
        // One level deeper: `.cache/kat-x/profile/Default`.
        for (const deep of Deno.readDirSync(path)) {
          if (deep.isDirectory && looksLikeProfile(`${path}/${deep.name}`)) {
            offenders.push(`${entry.name}/${inner.name}/${deep.name}`);
          }
        }
      }
    }
    assertEquals(offenders, [], "a live Chrome profile is still inside the working tree");
  } finally {
    if (proc) {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
      try { await proc.status; } catch { /* reaped */ }
    }
    await new Promise((r) => setTimeout(r, 500));
    Deno.removeSync(scratch, { recursive: true });
    Deno.removeSync(profile, { recursive: true });
    await Deno.remove(lockScope).catch(() => {});
  }
});

Deno.test("9t1b: stale profiles prune by age, and a fresh one is never touched", async () => {
  const fresh = chromeProfileDir("kat-prune-fresh");
  const stale = chromeProfileDir("kat-prune-stale");
  try {
    // Backdate the stale profile's mtime by 7 hours (threshold is 6).
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    Deno.utimeSync(stale, old, old);
    const r = await pruneChromeProfileDirs();
    assertEquals(r.removed >= 1, true, `the stale profile was removed: ${JSON.stringify(r)}`);
    assertEquals(Deno.statSync(fresh).isDirectory, true, "a fresh profile survives (a live browser is minutes old)");
    let gone = false;
    try { Deno.statSync(stale); } catch { gone = true; }
    assertEquals(gone, true, "the backdated profile is gone");
    assertEquals(r.errors, [], "no removal errors");
  } finally {
    // The prune already removed the stale one; cleanup must not fail on that.
    for (const dir of [fresh, stale]) {
      try { Deno.removeSync(dir, { recursive: true }); } catch { /* already gone */ }
    }
  }
  // Pruning an absent root is a no-op, not a crash.
  const none = await pruneChromeProfileDirs({ olderThanMs: -1 });
  assertEquals(Array.isArray(none.errors), true);
});

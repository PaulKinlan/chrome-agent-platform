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
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  chromeProfileDir,
  isInsideRepo,
  PROFILE_ROOT_NAME,
  profileLiveness,
  pruneChromeProfileDirs,
  repoRoot,
  SHARED_ROOT_MIN_OLDER_THAN_MS,
} from "../scripts/lib/chrome-profile-dir.ts";
import { durableRoot, isRamBacked } from "../scripts/lib/durable-root.mjs";

/** The file's ONE browser-dependent test, named where the refusal counts it. */
const BROWSER_DEPENDENT_TESTS = ["9t1b: a REAL browser holds its profile while the whole tree is copied"];

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const SCRIPTS = `${ROOT}/scripts`;

// A PID above the kernel's pid_max cannot belong to any live process (xvco:
// 999999 is below pid_max=4194304 on 64-bit Linux, so it could collide with a
// real PID). Read /proc/sys/kernel/pid_max on Linux and fall back to 4194304.
const PID_MAX = (() => {
  try {
    const n = Number(Deno.readTextFileSync("/proc/sys/kernel/pid_max").trim());
    if (Number.isSafeInteger(n) && n > 0) return n;
  } catch { /* non-Linux (macOS pid_max is 99999) */ }
  return 4_194_304;
})();
const DEAD_PID = PID_MAX + 1;


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
  // chrome-agent-platform-hlgr: this file's ONE browser-dependent test. On a host with no resolvable
  // browser it must refuse ENVIRONMENTALLY — NAMED and COUNTED — never a silent ignore (which reads as
  // a pass) and never a product red (which blames the tree for an environment difference). The verdict
  // lives in scripts/lib/browser-refusal.ts so its wording and count are unit-testable without a
  // browser; resolveChromiumBinaryReport is the repo's resolver that distinguishes "resolved" from
  // "fell through to a default that may not exist".
  // (review P2: the block that used to precede this one was a duplicate of it and was deleted.)
  const { launchChrome, resolveChromiumBinaryReport, teardownChrome } = await import("../scripts/lib/chrome-launch.ts");
  // (review P2 delta: refuseWithoutBrowser was imported here and never used in this test — the refusal
  // is emitted by the LAST test in the file, which imports it for itself.)
  // chrome-agent-platform-hlgr review P1: do NOT exit from here. This test sits before five STATIC
  // tests in this file, and Deno.exit(75) would abort them, losing coverage that needs no browser at
  // all. Without a browser this test declines to assert and the refusal is emitted by the LAST test in
  // the file, which runs after every static one has had its chance.
  //
  // review P1 (delta): a REPORTED binary is not a RESOLVED one. resolveChromiumBinaryReport trusts a
  // CAP_CHROMIUM override without checking the path, so testing `.binary` here let a missing (or a
  // directory, or a non-executable) override through, and this test then died ENOENT/EISDIR/EACCES —
  // a product red for an environment difference, which is the exact class this bead removes.
  // browserRefusal() owns that judgement, so ask IT rather than the resolver.
  const { browserRefusal } = await import("../scripts/lib/browser-refusal.ts");
  if (browserRefusal(resolveChromiumBinaryReport(), BROWSER_DEPENDENT_TESTS)) return;
  // The race, driven for real: launch Chrome with a profile from the helper,
  // keep it alive, and copy the WHOLE working tree underneath it — the exact
  // command that failed in tests/cdp-client.test.ts (`cp -a <repo>/. <dst>/.`).
  // Before this bead the profile was inside the tree, so the copy died on files
  // Chrome unlinked mid-copy. It costs a few seconds of I/O; that is the point.
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
      await teardownChrome(proc, profile);
    }
    await new Promise((r) => setTimeout(r, 500));
    Deno.removeSync(scratch, { recursive: true });
    Deno.removeSync(profile, { recursive: true });
    await Deno.remove(lockScope).catch(() => {});
  }
});

Deno.test("9t1b: stale profiles prune by age, and a fresh one is never touched", async () => {
  // Isolated fixture root (xvco item 7): no unit test may prune the shared
  // profile root where concurrent lanes keep live Chrome profiles.
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-age-fixture-${Deno.pid}-${Date.now()}`;
  const fresh = `${root}/kat-prune-fresh-${Deno.pid}-${Date.now()}`;
  const stale = `${root}/kat-prune-stale-${Deno.pid}-${Date.now()}`;
  for (const dir of [fresh, stale]) Deno.mkdirSync(dir, { recursive: true });
  try {
    // Backdate the stale profile's mtime by 7 hours (threshold is 6).
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    Deno.utimeSync(stale, old, old);
    const r = await pruneChromeProfileDirs({ root });
    assertEquals(r.removed, 1, `the stale profile was removed: ${JSON.stringify(r)}`);
    assertEquals(r.kept, 1, `the fresh profile was kept: ${JSON.stringify(r)}`);
    assertEquals(Deno.statSync(fresh).isDirectory, true, "a fresh profile survives (a live browser is minutes old)");
    let gone = false;
    try { Deno.statSync(stale); } catch { gone = true; }
    assertEquals(gone, true, "the backdated profile is gone");
    assertEquals(r.errors, [], "no removal errors");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
  // Pruning an ABSENT root is a no-op, not a crash — and it must run against a
  // fixture root that cannot exist (z5ym).
  const absentRoot = `${durableRoot()}/${PROFILE_ROOT_NAME}-absent-fixture-${Deno.pid}`;
  const none = await pruneChromeProfileDirs({ olderThanMs: 0, root: absentRoot });
  assertEquals(none.errors, []);
  assertEquals(none.removed, 0, "an absent root removes nothing");
});

Deno.test("9t1b/z5ym/xvco: the lock classifier is THREE states, including EPERM (pid 1) as live and pid_max+1 as unknown", () => {
  // Direct three-state classifier table (z5ym + xvco items 3 & 5):
  // - live:      this process's PID, AND PID 1 (owned by root -> EPERM/PermissionDenied)
  // - absent:    no SingletonLock
  // - unknown:   dead PID (pid_max + 1), malformed target, foreign host, unreadable dir lock
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-classify-fixture-${Deno.pid}-${Date.now()}`;
  const live = `${root}/live`;
  const eperm = `${root}/eperm-pid1`;
  const absent = `${root}/absent`;
  const dead = `${root}/dead`;
  const malformed = `${root}/malformed`;
  const foreign = `${root}/foreign`;
  const asDirectory = `${root}/lock-is-a-dir`;
  for (const dir of [live, eperm, absent, dead, malformed, foreign, asDirectory]) {
    Deno.mkdirSync(dir, { recursive: true });
  }
  Deno.symlinkSync(`${hostname()}-${Deno.pid}`, `${live}/SingletonLock`);
  Deno.symlinkSync(`${hostname()}-1`, `${eperm}/SingletonLock`);
  Deno.symlinkSync(`${hostname()}-${DEAD_PID}`, `${dead}/SingletonLock`);
  Deno.symlinkSync("not-a-lock-target", `${malformed}/SingletonLock`);
  Deno.symlinkSync("some-other-host-12345", `${foreign}/SingletonLock`);
  Deno.mkdirSync(`${asDirectory}/SingletonLock`); // readlink -> EINVAL (unreadable)
  try {
    assertEquals(profileLiveness(live), "live", "an alive owner pid on this host is LIVE");
    assertEquals(
      profileLiveness(eperm),
      "live",
      "a lock naming pid 1 (EPERM / PermissionDenied) is LIVE — never treated as absent or unknown (xvco item 3)",
    );
    assertEquals(profileLiveness(absent), "absent", 'no lock is the only positive "not running" state');
    assertEquals(profileLiveness(dead), "unknown", `a dead pid (${DEAD_PID} > pid_max) is UNKNOWN — not live, not stale`);
    assertEquals(profileLiveness(malformed), "unknown", "a malformed target is UNKNOWN");
    assertEquals(profileLiveness(foreign), "unknown", "another host's lock is UNKNOWN");
    assertEquals(profileLiveness(asDirectory), "unknown", "an unreadable lock is UNKNOWN");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("9t1b/z5ym/xvco: root containment and threshold guards refuse unsafe pruneChromeProfileDirs calls", async () => {
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-guard-fixture-${Deno.pid}`;
  // 1. Negative / non-finite thresholds are refused on any root (z5ym).
  await assertRejects(
    () => pruneChromeProfileDirs({ olderThanMs: -1, root }),
    Error,
    "olderThanMs must be a non-negative finite number",
  );
  await assertRejects(
    () => pruneChromeProfileDirs({ olderThanMs: Number.NaN, root }),
    Error,
    "olderThanMs must be a non-negative finite number",
  );
  await assertRejects(
    () => pruneChromeProfileDirs({ olderThanMs: Number.POSITIVE_INFINITY, root }),
    Error,
    "olderThanMs must be a non-negative finite number",
  );

  // 2. Shared profile root enforces SHARED_ROOT_MIN_OLDER_THAN_MS so olderThanMs
  //    0 or 1 cannot wipe a just-created lockless profile before Chrome writes
  //    SingletonLock (xvco item 4).
  await assertRejects(
    () => pruneChromeProfileDirs({ olderThanMs: 0 }),
    Error,
    `must be >= ${SHARED_ROOT_MIN_OLDER_THAN_MS} ms`,
  );
  await assertRejects(
    () => pruneChromeProfileDirs({ olderThanMs: 1 }),
    Error,
    `must be >= ${SHARED_ROOT_MIN_OLDER_THAN_MS} ms`,
  );

  // 3. Injectable root containment (xvco item 1): passing durableRoot() (one
  //    level too high) or any directory whose basename is not cap-chrome-profiles
  //    or cap-chrome-profiles-* is refused BEFORE touching the filesystem.
  await assertRejects(
    () => pruneChromeProfileDirs({ root: durableRoot() }),
    Error,
    `basename must be "${PROFILE_ROOT_NAME}" or "${PROFILE_ROOT_NAME}-*"`,
  );
  await assertRejects(
    () => pruneChromeProfileDirs({ root: `${durableRoot()}/${PROFILE_ROOT_NAME}-` }),
    Error,
    `basename must be "${PROFILE_ROOT_NAME}" or "${PROFILE_ROOT_NAME}-*"`,
  );
  await assertRejects(
    () => pruneChromeProfileDirs({ root: `${durableRoot()}/../${PROFILE_ROOT_NAME}` }),
    Error,
    `basename must be "${PROFILE_ROOT_NAME}" or "${PROFILE_ROOT_NAME}-*"`,
  );

  // Prove a rejected parent root never removes its child directories even when
  // backdated by 7 hours.
  const parentBox = Deno.makeTempDirSync({ prefix: "xvco-wrong-level-" });
  const victim = `${parentBox}/unrelated-evidence`;
  Deno.mkdirSync(victim, { recursive: true });
  const old = new Date(Date.now() - 7 * 60 * 60_000);
  Deno.utimeSync(victim, old, old);
  try {
    await assertRejects(
      () => pruneChromeProfileDirs({ olderThanMs: 0, root: parentBox }),
      Error,
      `basename must be "${PROFILE_ROOT_NAME}" or "${PROFILE_ROOT_NAME}-*"`,
    );
    assertEquals(Deno.statSync(victim).isDirectory, true, "victim directory under rejected root was never touched");
  } finally {
    Deno.removeSync(parentBox, { recursive: true });
  }
});

Deno.test("9t1b/z5ym/xvco: a LIVE profile (same-user or EPERM pid 1) is never pruned, whatever threshold says", async () => {
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-live-fixture-${Deno.pid}-${Date.now()}`;
  const live = `${root}/live-browser`;
  const eperm = `${root}/eperm-browser`;
  const noLock = `${root}/no-lock`;
  for (const dir of [live, eperm, noLock]) Deno.mkdirSync(dir, { recursive: true });
  Deno.symlinkSync(`${hostname()}-${Deno.pid}`, `${live}/SingletonLock`);
  Deno.symlinkSync(`${hostname()}-1`, `${eperm}/SingletonLock`);
  try {
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    for (const dir of [live, eperm, noLock]) Deno.utimeSync(dir, old, old);
    const r = await pruneChromeProfileDirs({ olderThanMs: 0, root });
    const exists = (dir: string) => {
      try { return Deno.statSync(dir).isDirectory; } catch { return false; }
    };
    assertEquals(exists(live), true, "a live profile survives an all-deleting prune");
    assertEquals(exists(eperm), true, "an EPERM (pid 1) profile survives an all-deleting prune");
    assertEquals(exists(noLock), false, "the same call still prunes a lockless profile (the pin is not vacuous)");
    assertEquals(r.removed, 1, JSON.stringify(r));
    assertEquals(r.kept, 2, JSON.stringify(r));
    assertEquals(r.unknown, 0, JSON.stringify(r));
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("9t1b/z5ym/xvco: an UNKNOWN lock is kept AND reported, never deleted by the age rule", async () => {
  const root = `${durableRoot()}/${PROFILE_ROOT_NAME}-unknown-fixture-${Deno.pid}-${Date.now()}`;
  const dead = `${root}/dead-browser`;
  const malformed = `${root}/malformed-lock`;
  const foreign = `${root}/foreign-host`;
  for (const dir of [dead, malformed, foreign]) Deno.mkdirSync(dir, { recursive: true });
  Deno.symlinkSync(`${hostname()}-${DEAD_PID}`, `${dead}/SingletonLock`);
  Deno.symlinkSync("not-a-lock-target", `${malformed}/SingletonLock`);
  Deno.symlinkSync("some-other-host-12345", `${foreign}/SingletonLock`);
  try {
    const old = new Date(Date.now() - 7 * 60 * 60_000);
    for (const dir of [dead, malformed, foreign]) Deno.utimeSync(dir, old, old);
    const r = await pruneChromeProfileDirs({ olderThanMs: 0, root });
    const exists = (dir: string) => {
      try { return Deno.statSync(dir).isDirectory; } catch { return false; }
    };
    assertEquals(exists(dead), true, "a dead-pid lock does NOT authorize deletion on its own");
    assertEquals(exists(malformed), true, "a malformed lock is never deleted");
    assertEquals(exists(foreign), true, "another host's profile is never deleted");
    assertEquals(r.removed, 0, JSON.stringify(r));
    assertEquals(r.kept, 3, JSON.stringify(r));
    assertEquals(r.unknown, 3, `the unclassifiable residue is REPORTED, not hidden in kept: ${JSON.stringify(r)}`);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }

  // And kat-runner.ts + AGENTS.md surface `unknown` rather than hiding it (xvco item 2).
  const runnerSrc = Deno.readTextFileSync(`${SCRIPTS}/kat-runner.ts`);
  assert(
    runnerSrc.includes("pruned.unknown > 0") && runnerSrc.includes("unknown lock(s) retained"),
    "scripts/kat-runner.ts logs retained unknown profile locks",
  );
  const agentsDoc = Deno.readTextFileSync(`${ROOT}/AGENTS.md`);
  assert(
    agentsDoc.includes("Lockless profiles") && agentsDoc.includes("`unknown`"),
    "AGENTS.md documents that lockless profiles self-prune while unknown locked profiles are retained and logged",
  );
});

// chrome-agent-platform-hlgr: the environmental verdict is emitted HERE, last, so a browserless host
// still runs every static test above before the file reports that its browser test was refused. The
// refusal NAMES the reason and COUNTS what went unverified, and exits 75 — the repo's third verdict,
// distinguishable from a pass (0) and from a product failure (1).
Deno.test("hlgr: no resolvable browser => the environmental refusal (named, counted, exit 75)", async () => {
  const { refuseWithoutBrowser } = await import("../scripts/lib/browser-refusal.ts");
  const { resolveChromiumBinaryReport } = await import("../scripts/lib/chrome-launch.ts");
  refuseWithoutBrowser(resolveChromiumBinaryReport(), BROWSER_DEPENDENT_TESTS);
});

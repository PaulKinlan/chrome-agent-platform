// tests/chrome-lock-fixture-scope.test.ts — unit tests never hold the machine's
// REAL Chrome gate as a fixture (chrome-agent-platform-1qr3).
//
// The canonical serialized-Chrome lock (`cap-serialized-chrome-acceptance.lock`
// on tmpfs) and the bounded-concurrency slot files (`cap-chrome-slot-N.lock`)
// coordinate REAL browsers across every lane on this machine. Four lock-machinery unit
// tests used to flock the real canonical path as their "another lane holds the
// gate" fixture. Three things were wrong with that: a real opt-in holder
// (chrome-journeys.ts, the security supervisor) starting meanwhile queued
// behind a unit test; the fixture's premise ("the gate is busy") could be met by
// a FOREIGN holder, so the pin was not self-contained; and a SIGKILLed runner
// left `flock … sleep 60` holding the real gate until the sleep ended. Measured
// on 2026-09-06 with an inotify watch on the real file (never opened by the
// watcher itself): 8 opens during one run of the two files, 0 with no tests
// running, 0 after the fixtures moved to their own scratch file
// (cap-evidence/cap-1qr3/inotify-real-lock-{BASELINE,BEFORE,AFTER}.log).
//
// The rule: a test may name a real coordination path only to ASSERT it (the
// launcher's default, the tmpfs allowlist). It never passes one — directly, or
// through an identifier bound to one — to a hold helper, a flock spawn, a
// launchChrome lockPath, or CAP_CHROME_LOCK_PATH. A fixture holds a
// Deno.makeTempFile path and points CAP_CHROME_LOCK_PATH at it: the launcher
// resolves the canonical path from the env PER CALL (canonicalLockPath() in
// scripts/lib/chrome-launch.ts), so it treats the fixture's file exactly as it
// would the real one, and the pin keeps its teeth without touching the machine.

import { assert, assertEquals } from "jsr:@std/assert@1";

const TESTS_DIR = new URL("./", import.meta.url).pathname;

/** The machine-wide coordination files real browsers use (tmpfs by design). */
const REAL_PATH_RE = /^\/tmp\/cap-(?:serialized-chrome-acceptance\.lock|chrome-slot-[\w.-]+)$/;

/** The lock-machinery tests this guard exists for: each must still be present
 *  and each must still show the scanner at least two hold sites, or the guard
 *  has gone blind rather than the hazard having gone away. */
const LOCK_TEST_FILES = ["chrome-launch-lock.test.ts", "chrome-launch-lock-scope.test.ts", "chrome-slot-semaphore.test.ts"];

function stripComments(src: string): string {
  // Block comments become blanks that keep their newlines (so a reported line
  // number is the file's real line), then line comments that start a line or
  // follow whitespace go (so a `ws://` inside a string survives).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Identifiers bound (const/let/var) to a real coordination path literal. */
function realBound(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`\n]*)\2/g)) {
    if (REAL_PATH_RE.test(m[3]!)) out.add(m[1]!);
  }
  return out;
}

/** Does this site text name a real path — as a literal or via a bound identifier? */
function namesReal(text: string, bound: Set<string>): boolean {
  for (const m of text.matchAll(/(["'`])([^"'`\n]*)\1/g)) if (REAL_PATH_RE.test(m[2]!)) return true;
  for (const id of bound) if (new RegExp(`(?<![\\w$])${id}(?![\\w$])`).test(text)) return true;
  return false;
}

type Site = { kind: string; line: number; text: string };

/** Every place a test can direct a hold at a path. */
function holdSites(src: string): Site[] {
  const sites: Site[] = [];
  const lineOf = (index: number) => src.slice(0, index).split("\n").length;
  const push = (kind: string, m: RegExpMatchArray) => sites.push({ kind, line: lineOf(m.index ?? 0), text: m[0].replace(/\s+/g, " ").trim() });
  // A hold helper call (holdConfirmed / holdLock / holdFile …), one nesting level of args.
  for (const m of src.matchAll(/(?<![\w$.])hold\w*\s*\(((?:[^()]|\([^()]*\))*)\)/g)) push("hold helper", m);
  // A flock spawned directly.
  for (const m of src.matchAll(/new\s+Deno\.Command\(\s*"flock"\s*,\s*\{([^}]*)\}/g)) push("flock spawn", m);
  // The launcher told to take an exclusive lock on a path.
  for (const m of src.matchAll(/launchChrome\(\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    const lockPath = m[1]!.match(/lockPath\s*:\s*([^,}\n]+)/);
    if (lockPath) sites.push({ kind: "launchChrome lockPath", line: lineOf(m.index ?? 0), text: lockPath[0].trim() });
  }
  // The launcher's canonical path redirected (an object entry or an env set).
  for (const m of src.matchAll(/CAP_CHROME_LOCK_PATH\s*:\s*([^,}\n]+)/g)) push("CAP_CHROME_LOCK_PATH entry", m);
  for (const m of src.matchAll(/Deno\.env\.set\(\s*"CAP_CHROME_LOCK_PATH"\s*,\s*([^)]+)\)/g)) push("CAP_CHROME_LOCK_PATH set", m);
  return sites;
}

function offendersIn(source: string, name = "<inline>"): { offenders: string[]; sites: number; bound: Set<string> } {
  const src = stripComments(source);
  const bound = realBound(src);
  const sites = holdSites(src);
  const offenders = sites.filter((s) => namesReal(s.text, bound)).map((s) => `${name}:${s.line} (${s.kind}): ${s.text.slice(0, 120)}`);
  return { offenders, sites: sites.length, bound };
}

const SELF = new URL(import.meta.url).pathname.split("/").pop()!;

function testFiles(): string[] {
  // This file is skipped: its inline samples are the shapes the scanner must
  // catch — strings inside an assertion, never holds (the honesty test below
  // covers them, and the repo scan asserts this file spawns nothing at all).
  return [...Deno.readDirSync(TESTS_DIR)]
    .filter((e) => e.isFile && /\.test\.ts$/.test(e.name) && e.name !== SELF)
    .map((e) => e.name)
    .sort();
}

Deno.test("1qr3 detector honesty: the scanner fires on every shape it exists to catch, and stays quiet on an assertion-only citation", () => {
  const REAL = "/tmp/cap-serialized-chrome-acceptance.lock";
  const mustFire = [
    `const CANONICAL = "${REAL}";\nconst h = await holdConfirmed(CANONICAL);`,
    `const holder = holdLock("${REAL}", 20);`,
    `new Deno.Command("flock", { args: ["-o", "/tmp/cap-chrome-slot-0.lock", "sleep", "60"] })`,
    `const G = "${REAL}";\nwithEnv({ CAP_CHROME_MAX_CONCURRENT: "4", CAP_CHROME_LOCK_PATH: G }, fn)`,
    `Deno.env.set("CAP_CHROME_LOCK_PATH", "${REAL}");`,
    `const L = "${REAL}";\nawait launchChrome({ binary: fake, args: [], timeoutMs: 5000, lockPath: L });`,
    `const CANONICAL = "${REAL}";\nconst canonical = await holdConfirmed(CANONICAL);\nconst slot = await holdConfirmed(slotFile(0));`,
  ];
  const mustStayQuiet = [
    // The launcher's default, ASSERTED in a clean subprocess — the literal is cited, never held.
    `const CANONICAL = "${REAL}";\nassertEquals(seen.CHROME_LOCK_PATH_DEFAULT, CANONICAL, "the opt-in canonical lock keeps its path");`,
    // The correct fixture shape: a scratch file, held, and the launcher pointed at it.
    `const SCOPE = await Deno.makeTempFile({ prefix: "cap-x-" });\nconst h = await holdConfirmed(SCOPE);\nDeno.env.set("CAP_CHROME_LOCK_PATH", SCOPE);\nwithEnv({ CAP_CHROME_LOCK_PATH: SCOPE }, fn);`,
    // A guard-file FIELD the security supervisor consumes (it is the canonical holder by design) — data, not a hold.
    `const LOCK = "${REAL}";\nconst baseGuard = { schemaVersion: 1, lockPath: LOCK, issuedAt: Date.now() };`,
    // The tmpfs allowlist cites the paths in an array.
    `const TMPFS_ONLY = ["${REAL}", "/tmp/cap-chrome-slot-0.lock"];`,
    // A mention in a comment is not a hold.
    `// holdConfirmed(CANONICAL) was the old shape\nconst CANONICAL = "${REAL}"; // cited below\n/* holdLock(CANONICAL, 20) */`,
    // Slot files computed from the (redirected) slot dir are the fixture's own.
    `const holders = [await holdConfirmed(slotFile(0)), await holdConfirmed(slotFile(1))];`,
  ];
  for (const s of mustFire) assert(offendersIn(s).offenders.length > 0, `must fire:\n${s}`);
  for (const s of mustStayQuiet) assertEquals(offendersIn(s).offenders, [], `must stay quiet:\n${s}`);
});

Deno.test("1qr3: no unit test holds, spawns flock on, locks through the launcher, or points CAP_CHROME_LOCK_PATH at the machine's real Chrome coordination files", () => {
  const offenders: string[] = [];
  const sitesByFile = new Map<string, number>();
  let boundSomewhere = 0;
  for (const name of testFiles()) {
    const r = offendersIn(Deno.readTextFileSync(TESTS_DIR + name), name);
    offenders.push(...r.offenders);
    sitesByFile.set(name, r.sites);
    boundSomewhere += r.bound.size;
  }
  assertEquals(offenders, [],
    "a unit test directed a hold at a REAL coordination file. Hold a Deno.makeTempFile path and point CAP_CHROME_LOCK_PATH at it " +
    "(canonicalLockPath() reads the env per call) — the machine's gate belongs to real browsers.");
  // The guard is only as good as its detectors: the files it polices are present
  // and still show it their hold sites, and the literal-binding detector still
  // sees the literals the retained assertions keep.
  for (const f of LOCK_TEST_FILES) {
    assert(sitesByFile.has(f), `${f}: the lock-machinery test this guard polices still exists`);
    assert((sitesByFile.get(f) ?? 0) >= 2, `${f}: the scanner sees its hold sites (${sitesByFile.get(f)})`);
  }
  assert(boundSomewhere > 0, "the scanner still sees at least one identifier bound to a real path (the literals kept for assertions)");
  // The self-exclusion is not a loophole: this guard is a static scanner that
  // never runs a process, so it cannot hold anything.
  const self = Deno.readTextFileSync(TESTS_DIR + SELF);
  assert(!/\.spawn\(\)|\.output\(\)|\.outputSync\(\)|spawnSync\(/.test(self), `${SELF} runs no process`);
});

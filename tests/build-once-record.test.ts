// tests/build-once-record.test.ts — bead chrome-agent-platform-jjsz (round-2 review N1).
//
// scripts/lib/build-once-record.mjs is the ONE writer of the build-once record: the file that says
// "this build exited 0", which tests/fixtures/build-once.mjs trusts so a later serial test file
// (build-smoke, store-doc-denial) reuses this build's captured output instead of paying for another
// build. A record written for a build that did NOT exit 0 lets build-smoke pass a failed build — the
// P1 this bead exists to prevent.
//
// Round 1 pinned the CALL SITE in the build script structurally (tests/build-parallel-discipline.test.ts,
// rule B), but nothing EXECUTED the writer, so a weakened gate inside it, a swapped operator or a
// path-traversing key went unnoticed (review finding N1). This file runs the real function against
// real files:
//
//   * a table over record x buildSucceeded x exitCode, judged by an oracle written independently of the
//     production gate (it never imports shouldRecordBuild): a file appears ONLY for a valid record of
//     a build with buildSucceeded === true AND exitCode === 0;
//   * a refused call creates NOTHING, not even the directory: every case gets its own parent directory
//     that does not exist yet, and a refused case must leave it nonexistent;
//   * the written bytes are exactly JSON.stringify({ code: 0, stdout, at }) — the shape the fixture reads;
//   * a key is one safe path segment, so no key can write outside the record directory;
//   * an fs (or clock) failure is NON-FATAL cache population: `write-failed`, never a throw;
//   * the DEFAULT directory (<durable root>/serial-build-once) is exercised in a child process, so this
//     test never mutates the environment of the process the other test files share.
//
// NOT pinned here (said plainly): that the build script CALLS the writer with its live values after its
// last try/finally (rule B in tests/build-parallel-discipline.test.ts), and that an unusable durable
// root is non-fatal when it is unusable because it is RAM-backed (a portable test cannot create one;
// the regular-file root below covers the other way the default directory can fail).
import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { parse } from "npm:acorn";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { BUILD_ONCE_RECORD_DIR_NAME, writeBuildOnceRecord } from "../scripts/lib/build-once-record.mjs";

// deno-lint-ignore no-explicit-any
type Loose = any;
type Outcome = { written: boolean; reason: string };

/** The writer, typed loosely on purpose: the tables feed it values its JSDoc types forbid. */
const write = writeBuildOnceRecord as unknown as (args?: Loose) => Promise<Outcome>;

const FIXED_ISO = "2026-10-07T12:34:56.789Z";
const fixedNow = () => new Date(FIXED_ISO);

// A realistic key: the dist.complete marker's commit (40 to 64 lowercase hex) + "-" + its sha256 digest.
const COMMIT_40 = "0123456789abcdef".repeat(2) + "01234567";
const COMMIT_64 = "0123456789abcdef".repeat(4);
const DIGEST_64 = "fedcba9876543210".repeat(4);
const REAL_KEY = `${COMMIT_40}-${DIGEST_64}`;
const STDOUT = "built dist ATOMICALLY (one dist dir; dist.complete marker)\n";

const show = (value: unknown) => Deno.inspect(value);
const expectedText = (stdout: string) => JSON.stringify({ code: 0, stdout, at: FIXED_ISO });

function freshScratch(label: string): string {
  return durableDir("scratch", `build-once-record-${label}-${crypto.randomUUID()}`);
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function sameOutcome(actual: Outcome, expected: Outcome): boolean {
  return Object.keys(actual).sort().join() === "reason,written" &&
    actual.written === expected.written && actual.reason === expected.reason;
}

// ---------------------------------------------------------------------------------------------------
// The table: record x buildSucceeded x exitCode.
// ---------------------------------------------------------------------------------------------------

type Shape = "valid" | "absent" | "invalid";
interface Variant {
  label: string;
  record: unknown;
  shape: Shape;
}
const valid = (label: string, record: unknown): Variant => ({ label, record, shape: "valid" });
const absent = (label: string, record: unknown): Variant => ({ label, record, shape: "absent" });
const invalid = (label: string, record: unknown): Variant => ({ label, record, shape: "invalid" });

// Everything a caller could pass for the two gate inputs that is NOT the one accepted pair.
const BUILD_SUCCEEDED_VALUES: unknown[] = [true, false, undefined, null, "true", 1, 0, "", {}, []];
const EXIT_CODE_VALUES: unknown[] = [
  0,
  -0, // the number zero: -0 === 0, so it is accepted exactly like 0
  1,
  -1,
  2,
  255,
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  "0",
  "",
  false,
  true,
  [],
  0n,
  Number.MIN_VALUE, // not zero
];

/** The writer's whole contract as an oracle that does NOT import the production gate. */
function expectedOutcome(shape: Shape, buildSucceeded: unknown, exitCode: unknown): Outcome {
  if (shape === "absent") return { written: false, reason: "no-record" };
  if (!(buildSucceeded === true && exitCode === 0)) return { written: false, reason: "build-did-not-exit-0" };
  if (shape === "invalid") return { written: false, reason: "invalid-record" };
  return { written: true, reason: "written" };
}

/** Run every variant through the full gate grid; return every disagreement with the oracle. */
async function runTable(variants: Variant[]): Promise<string[]> {
  const scratch = freshScratch("table");
  const mismatches: string[] = [];
  let caseNumber = 0;
  try {
    for (const variant of variants) {
      for (const buildSucceeded of BUILD_SUCCEEDED_VALUES) {
        for (const exitCode of EXIT_CODE_VALUES) {
          const caseRoot = join(scratch, `c${caseNumber++}`);
          const recordDir = join(caseRoot, "records");
          const where = `${variant.label} | buildSucceeded=${show(buildSucceeded)} exitCode=${show(exitCode)}`;
          const expected = expectedOutcome(variant.shape, buildSucceeded, exitCode);
          let outcome: Outcome;
          try {
            outcome = await write({ record: variant.record, buildSucceeded, exitCode, recordDir, now: fixedNow });
          } catch (error) {
            mismatches.push(`${where}: THREW ${show(error instanceof Error ? error.message : error)}`);
            continue;
          }
          if (!sameOutcome(outcome, expected)) {
            mismatches.push(`${where}: returned ${show(outcome)}, expected ${show(expected)}`);
          }
          if (expected.written) {
            const { key, stdout } = variant.record as { key: string; stdout: string };
            const listing = existsSync(recordDir) ? readdirSync(recordDir) : null;
            if (listing === null || listing.length !== 1 || listing[0] !== `${key}.json`) {
              mismatches.push(`${where}: the record directory holds ${show(listing)}, expected only ${key}.json`);
            } else if (readFileSync(join(recordDir, listing[0]), "utf8") !== expectedText(stdout)) {
              mismatches.push(`${where}: the file bytes are not JSON.stringify({ code: 0, stdout, at })`);
            }
          } else if (existsSync(caseRoot)) {
            mismatches.push(`${where}: a refused call touched the disk (${show(readdirSync(caseRoot))})`);
          }
        }
      }
    }
  } finally {
    cleanup(scratch);
  }
  return mismatches;
}

const assertTableClean = (mismatches: string[], what: string) =>
  assertEquals(mismatches.slice(0, 8), [], `${what}: ${mismatches.length} disagreement(s) with the oracle (first 8 shown)`);

Deno.test("writeBuildOnceRecord table: a valid record is written ONLY for buildSucceeded === true and exitCode === 0, with the exact bytes", async () => {
  assertTableClean(
    await runTable([
      valid("realistic key <40-hex commit>-<64-hex digest>", { key: REAL_KEY, stdout: STDOUT }),
      valid("key with the longest commit the marker allows (64 hex)", { key: `${COMMIT_64}-${DIGEST_64}`, stdout: STDOUT }),
      valid("one-character key", { key: "a", stdout: STDOUT }),
      valid("digit-leading key", { key: "0", stdout: STDOUT }),
      valid("upper-case key", { key: "Key.With-Caps_9", stdout: STDOUT }),
      valid("key using every allowed punctuation . _ -", { key: "a.b_c-d", stdout: STDOUT }),
      valid("empty stdout is still a string", { key: "k", stdout: "" }),
      valid("stdout that needs JSON escaping", {
        key: "k",
        stdout: "caf\u00e9 \"quoted\" back\\slash\r\nline\u2028end\u0000nul",
      }),
      // A record is DATA about a build, not a vote on whether to record it: whatever it claims about
      // itself, only the live buildSucceeded/exitCode arguments open the gate, and only code: 0 is written.
      valid("extra record properties are ignored: a record cannot vouch for itself", {
        key: "k",
        stdout: STDOUT,
        code: 99,
        at: "never",
        extra: [1],
        force: true,
        ok: true,
        success: true,
        buildSucceeded: true,
        exitCode: 0,
      }),
    ]),
    "valid records",
  );
});

Deno.test("writeBuildOnceRecord table: an absent record (null, undefined) is never written and never touches the disk", async () => {
  assertTableClean(await runTable([absent("null", null), absent("undefined", undefined)]), "absent records");
});

Deno.test("writeBuildOnceRecord table: an unsafe string key is refused as invalid-record and creates nothing", async () => {
  const unsafeKeys = [
    "../escape",
    "../../escape",
    "a/../../escape",
    "a/b",
    "/absolute",
    "a\\b",
    "",
    ".",
    "..",
    "...",
    ".hidden",
    "-lead",
    "_lead",
    " lead",
    "trail\n",
    "a b",
    "a\u0000b",
    "caf\u00e9",
    "\uff11", // a full-width digit one: not an ASCII digit
    "a:b",
    "a*b",
    "a?b",
    "a%2e%2e",
    "~root",
  ];
  assertTableClean(
    await runTable(unsafeKeys.map((key) => invalid(`unsafe key ${show(key)}`, { key, stdout: STDOUT }))),
    "unsafe keys",
  );
});

Deno.test("writeBuildOnceRecord table: a non-string key is refused even when it stringifies to a valid key", async () => {
  // RegExp.prototype.test coerces its argument with ToString, so a regex alone would let 42, ["abc"]
  // and a toString object through as the file names 42.json and abc.json.
  const keys: Array<[string, unknown]> = [
    ["number 42 (stringifies to 42)", 42],
    ["number 0", 0],
    ["null", null],
    ["undefined", undefined],
    ["empty object", {}],
    ["array [\"abc\"] (stringifies to abc)", ["abc"]],
    ["true", true],
    // deno-lint-ignore no-new-wrappers
    ["String object (stringifies to abc)", new String("abc")],
    ["object whose toString returns a valid key", { toString: () => "abc" }],
    ["symbol", Symbol("k")],
  ];
  assertTableClean(
    await runTable(keys.map(([label, key]) => invalid(`key is ${label}`, { key, stdout: STDOUT }))),
    "non-string keys",
  );
});

Deno.test("writeBuildOnceRecord table: a non-string stdout is refused as invalid-record", async () => {
  const stdouts: Array<[string, unknown]> = [
    ["number", 42],
    ["null", null],
    ["undefined", undefined],
    ["object", {}],
    ["array", ["x"]],
    // deno-lint-ignore no-new-wrappers
    ["String object", new String("x")],
    ["Uint8Array of the bytes", new TextEncoder().encode("x")],
    ["symbol", Symbol("s")],
  ];
  assertTableClean(
    await runTable(stdouts.map(([label, stdout]) => invalid(`stdout is ${label}`, { key: "k", stdout }))),
    "non-string stdout",
  );
});

Deno.test("writeBuildOnceRecord table: a record that is not an object is refused as invalid-record, not mistaken for an absent one", async () => {
  // Only null and undefined mean "no record". 0, "", false and NaN are falsy but ARE records (broken ones):
  // a truthiness check would report them as no-record.
  const records: Array<[string, unknown]> = [
    ["0", 0],
    ["empty string", ""],
    ["false", false],
    ["NaN", NaN],
    ["42", 42],
    ["a string", "a string"],
    ["true", true],
    ["an array", []],
    ["a function", () => {}],
    ["an object without a prototype", Object.create(null)],
  ];
  assertTableClean(await runTable(records.map(([label, record]) => invalid(`record is ${label}`, record))), "odd records");
});

Deno.test("writeBuildOnceRecord: called with no argument or an empty object it reports no-record and does not throw", async () => {
  assertEquals(await write(), { written: false, reason: "no-record" });
  assertEquals(await write({}), { written: false, reason: "no-record" });
  assertEquals(await write({ record: undefined, buildSucceeded: true, exitCode: 0 }), { written: false, reason: "no-record" });
});

// ---------------------------------------------------------------------------------------------------
// Named, human-readable neighbours of the gate and of the disk-state promises (the table covers them
// too; these say WHICH promise broke when one does).
// ---------------------------------------------------------------------------------------------------

Deno.test("gate: only (buildSucceeded === true, exitCode === 0) opens it — every neighbour is refused with build-did-not-exit-0", async () => {
  const rows: Array<[unknown, unknown, boolean]> = [
    [true, 0, true],
    [true, -0, true],
    [false, 0, false], // a build that died in a finalizer after a clean exit code
    [true, 1, false], // a build that set process.exitCode (lock release failed, staging cleanup failed)
    [false, 1, false],
    [true, 2, false],
    [true, undefined, false],
    [undefined, 0, false],
    [null, 0, false],
    ["true", 0, false],
    [1, 0, false],
    [true, "0", false],
    [true, "", false],
    [true, null, false],
    [true, NaN, false],
    [true, Infinity, false],
    [true, false, false],
  ];
  const scratch = freshScratch("gate");
  try {
    for (const [index, [buildSucceeded, exitCode, opens]] of rows.entries()) {
      const caseRoot = join(scratch, `g${index}`);
      const outcome = await write({
        record: { key: REAL_KEY, stdout: STDOUT },
        buildSucceeded,
        exitCode,
        recordDir: join(caseRoot, "records"),
        now: fixedNow,
      });
      const row = `buildSucceeded=${show(buildSucceeded)} exitCode=${show(exitCode)}`;
      assertEquals(
        outcome,
        opens ? { written: true, reason: "written" } : { written: false, reason: "build-did-not-exit-0" },
        row,
      );
      assertStrictEquals(existsSync(caseRoot), opens, `${row}: the record directory must exist iff the gate opened`);
    }
  } finally {
    cleanup(scratch);
  }
});

Deno.test("refused calls leave no trace: no-record, a failed build and an invalid record never create the directory", async () => {
  const scratch = freshScratch("refused");
  try {
    const refusals: Array<[string, Loose, string]> = [
      ["no record", { record: null, buildSucceeded: true, exitCode: 0 }, "no-record"],
      ["failed build", { record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 1 }, "build-did-not-exit-0"],
      ["build not succeeded", { record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: false, exitCode: 0 }, "build-did-not-exit-0"],
      ["invalid key", { record: { key: "../x", stdout: STDOUT }, buildSucceeded: true, exitCode: 0 }, "invalid-record"],
      ["invalid stdout", { record: { key: "k", stdout: 7 }, buildSucceeded: true, exitCode: 0 }, "invalid-record"],
    ];
    for (const [index, [label, args, reason]] of refusals.entries()) {
      const caseRoot = join(scratch, `r${index}`);
      const outcome = await write({ ...args, recordDir: join(caseRoot, "nested", "records"), now: fixedNow });
      assertEquals(outcome, { written: false, reason }, label);
      assertStrictEquals(existsSync(caseRoot), false, `${label}: a refused call must not even create the parent directories`);
    }
  } finally {
    cleanup(scratch);
  }
});

Deno.test("the written file is exactly JSON.stringify({ code: 0, stdout, at }) for the injected clock, and it is the only file", async () => {
  const scratch = freshScratch("bytes");
  try {
    const recordDir = join(scratch, "deep", "records");
    const outcome = await write({ record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 0, recordDir, now: fixedNow });
    assertEquals(outcome, { written: true, reason: "written" });
    assertEquals(readdirSync(recordDir), [`${REAL_KEY}.json`]);
    const text = readFileSync(join(recordDir, `${REAL_KEY}.json`), "utf8");
    assertStrictEquals(text, JSON.stringify({ code: 0, stdout: STDOUT, at: FIXED_ISO }));
    // The same facts, read the way the fixture reads them (property names and order are part of the format).
    const parsed = JSON.parse(text);
    assertEquals(Object.keys(parsed), ["code", "stdout", "at"]);
    assertStrictEquals(parsed.code, 0);
    assertStrictEquals(parsed.at, FIXED_ISO);
    assertStrictEquals(parsed.stdout, STDOUT);
  } finally {
    cleanup(scratch);
  }
});

Deno.test("keys that would escape the record directory are refused and nothing is created outside it", async () => {
  const scratch = freshScratch("traversal");
  try {
    const recordDir = join(scratch, "records");
    mkdirSync(recordDir);
    const escaping = ["../escape", "../../escape", "a/../../escape", "sub/dir", "/absolute-escape", "a/b", "a\\b", "..", ".", "..."];
    for (const key of escaping) {
      const outcome = await write({ record: { key, stdout: STDOUT }, buildSucceeded: true, exitCode: 0, recordDir, now: fixedNow });
      assertEquals(outcome, { written: false, reason: "invalid-record" }, `key ${show(key)}`);
      assertEquals(readdirSync(scratch), ["records"], `key ${show(key)}: nothing may appear next to the record directory`);
      assertEquals(readdirSync(recordDir), [], `key ${show(key)}: nothing may appear inside the record directory either`);
    }
  } finally {
    cleanup(scratch);
  }
});

Deno.test("re-recording the same key replaces the record in place, a refused call leaves it alone, and unrelated files survive", async () => {
  const scratch = freshScratch("replace");
  try {
    const recordDir = join(scratch, "records");
    mkdirSync(recordDir);
    writeFileSync(join(recordDir, "unrelated.json"), "keep me");
    const args = { record: { key: REAL_KEY, stdout: "first\n" }, buildSucceeded: true, exitCode: 0, recordDir };
    assertEquals(await write({ ...args, now: () => new Date("2026-01-01T00:00:00.000Z") }), { written: true, reason: "written" });
    assertEquals(await write({ ...args, record: { key: REAL_KEY, stdout: "second\n" }, now: fixedNow }), { written: true, reason: "written" });
    const file = join(recordDir, `${REAL_KEY}.json`);
    assertStrictEquals(readFileSync(file, "utf8"), expectedText("second\n"));
    // A later FAILED build of the same tree must not delete or corrupt the earlier good record.
    assertEquals(await write({ ...args, record: { key: REAL_KEY, stdout: "third\n" }, exitCode: 1, now: fixedNow }), {
      written: false,
      reason: "build-did-not-exit-0",
    });
    assertStrictEquals(readFileSync(file, "utf8"), expectedText("second\n"));
    assertEquals(readdirSync(recordDir).sort(), [`${REAL_KEY}.json`, "unrelated.json"].sort());
    assertStrictEquals(readFileSync(join(recordDir, "unrelated.json"), "utf8"), "keep me");
  } finally {
    cleanup(scratch);
  }
});

// ---------------------------------------------------------------------------------------------------
// fs and clock failures: NON-FATAL cache population.
// ---------------------------------------------------------------------------------------------------

Deno.test("write-failed: a record directory under a regular file is reported, not thrown, and the file is untouched", async () => {
  const scratch = freshScratch("under-file");
  try {
    const regularFile = join(scratch, "a-regular-file");
    writeFileSync(regularFile, "still a file");
    const outcome = await write({
      record: { key: REAL_KEY, stdout: STDOUT },
      buildSucceeded: true,
      exitCode: 0,
      recordDir: join(regularFile, "records"),
      now: fixedNow,
    });
    assertEquals(outcome, { written: false, reason: "write-failed" });
    assertStrictEquals(readFileSync(regularFile, "utf8"), "still a file");
  } finally {
    cleanup(scratch);
  }
});

Deno.test("write-failed: a record directory that IS a regular file is reported, not thrown", async () => {
  const scratch = freshScratch("is-file");
  try {
    const regularFile = join(scratch, "records");
    writeFileSync(regularFile, "squatting");
    const outcome = await write({
      record: { key: REAL_KEY, stdout: STDOUT },
      buildSucceeded: true,
      exitCode: 0,
      recordDir: regularFile,
      now: fixedNow,
    });
    assertEquals(outcome, { written: false, reason: "write-failed" });
    assertStrictEquals(readFileSync(regularFile, "utf8"), "squatting");
  } finally {
    cleanup(scratch);
  }
});

Deno.test("write-failed: a directory squatting on <key>.json is reported, not thrown, and survives", async () => {
  const scratch = freshScratch("squatter");
  try {
    const recordDir = join(scratch, "records");
    mkdirSync(join(recordDir, `${REAL_KEY}.json`), { recursive: true });
    const outcome = await write({ record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 0, recordDir, now: fixedNow });
    assertEquals(outcome, { written: false, reason: "write-failed" });
    assertEquals(readdirSync(recordDir), [`${REAL_KEY}.json`]);
    assertStrictEquals(Deno.statSync(join(recordDir, `${REAL_KEY}.json`)).isDirectory, true);
  } finally {
    cleanup(scratch);
  }
});

Deno.test("write-failed: a broken clock is reported, not thrown, and leaves not even the directory behind", async () => {
  // Everything that can throw WITHOUT touching the disk is computed before the first disk operation, so
  // a failure there cannot leave a half-made record directory.
  const scratch = freshScratch("clock");
  try {
    const clocks: Array<[string, () => unknown]> = [
      ["throws", () => {
        throw new Error("clock exploded");
      }],
      ["returns an invalid Date", () => new Date(Number.NaN)],
      ["returns a string, not a Date", () => FIXED_ISO],
      ["returns null", () => null],
    ];
    for (const [index, [label, now]] of clocks.entries()) {
      const caseRoot = join(scratch, `k${index}`);
      const outcome = await write({
        record: { key: REAL_KEY, stdout: STDOUT },
        buildSucceeded: true,
        exitCode: 0,
        recordDir: join(caseRoot, "records"),
        now,
      });
      assertEquals(outcome, { written: false, reason: "write-failed" }, `clock ${label}`);
      assertStrictEquals(existsSync(caseRoot), false, `clock ${label}: no directory may be created`);
    }
  } finally {
    cleanup(scratch);
  }
});

// ---------------------------------------------------------------------------------------------------
// The DEFAULT directory, in a child process: <durable root>/serial-build-once.
// ---------------------------------------------------------------------------------------------------

const HELPER_URL = new URL("../scripts/lib/build-once-record.mjs", import.meta.url).href;
const CHILD_SOURCE = [
  "const { writeBuildOnceRecord } = await import(process.env.HELPER_URL);",
  "const outcome = await writeBuildOnceRecord(JSON.parse(process.env.WRITE_ARGS));",
  "process.stdout.write(JSON.stringify(outcome));",
].join("\n");

/**
 * Run the writer under node with the durable root pointed at `root` and no recordDir override.
 *
 * The child gets its OWN empty working directory (never the checkout the suite runs in): a writer that
 * resolved its record directory against the working directory instead of the durable root would otherwise
 * drop a stray serial-build-once/ into the repository. The directory must still be empty afterwards.
 */
async function runInChild(root: string, args: Loose): Promise<{ code: number; stdout: string; stderr: string }> {
  const cwd = freshScratch("child-cwd");
  try {
    const output = await new Deno.Command("node", {
      args: ["--input-type=module", "-e", CHILD_SOURCE],
      cwd,
      env: { CAP_DURABLE_ROOT: root, HELPER_URL, WRITE_ARGS: JSON.stringify(args) },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(readdirSync(cwd), [], "the writer must not create anything in the process's working directory");
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } finally {
    cleanup(cwd);
  }
}

Deno.test("default directory: a good build's record lands in <durable root>/serial-build-once/<key>.json with the real clock", async () => {
  const root = freshScratch("default-dir");
  try {
    const before = Date.now();
    const run = await runInChild(root, { record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 0 });
    const after = Date.now();
    assertEquals(run.code, 0, run.stderr);
    assertEquals(JSON.parse(run.stdout), { written: true, reason: "written" });
    assertEquals(readdirSync(root), [BUILD_ONCE_RECORD_DIR_NAME]);
    assertEquals(readdirSync(join(root, BUILD_ONCE_RECORD_DIR_NAME)), [`${REAL_KEY}.json`]);
    const parsed = JSON.parse(readFileSync(join(root, BUILD_ONCE_RECORD_DIR_NAME, `${REAL_KEY}.json`), "utf8"));
    assertEquals(Object.keys(parsed), ["code", "stdout", "at"]);
    assertStrictEquals(parsed.code, 0);
    assertStrictEquals(parsed.stdout, STDOUT);
    const at = Date.parse(parsed.at);
    assertStrictEquals(new Date(at).toISOString(), parsed.at, "at must be an ISO timestamp");
    assert(at >= before - 2000 && at <= after + 2000, `at ${parsed.at} must be the real clock at the time of the write`);
  } finally {
    cleanup(root);
  }
});

Deno.test("default directory: a failed build, an unsafe key and a missing record create nothing under the durable root", async () => {
  const root = freshScratch("default-refused");
  try {
    const refusals: Array<[string, Loose, string]> = [
      ["failed build", { record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 1 }, "build-did-not-exit-0"],
      ["build not succeeded", { record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: false, exitCode: 0 }, "build-did-not-exit-0"],
      ["unsafe key", { record: { key: "../x", stdout: STDOUT }, buildSucceeded: true, exitCode: 0 }, "invalid-record"],
      ["no record", { record: null, buildSucceeded: true, exitCode: 0 }, "no-record"],
    ];
    for (const [label, args, reason] of refusals) {
      const run = await runInChild(root, args);
      assertEquals(run.code, 0, `${label}: ${run.stderr}`);
      assertEquals(JSON.parse(run.stdout), { written: false, reason }, label);
      assertEquals(readdirSync(root), [], `${label}: the durable root must stay empty`);
    }
  } finally {
    cleanup(root);
  }
});

Deno.test("default directory: an unusable durable root is NON-FATAL — the process exits 0 with write-failed", async () => {
  const scratch = freshScratch("default-unusable");
  try {
    const root = join(scratch, "durable-root-that-is-a-file");
    writeFileSync(root, "not a directory");
    const run = await runInChild(root, { record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 0 });
    assertEquals(run.code, 0, `a record that cannot be written must never fail the build: ${run.stderr}`);
    assertEquals(JSON.parse(run.stdout), { written: false, reason: "write-failed" });
    assertStrictEquals(readFileSync(root, "utf8"), "not a directory");
  } finally {
    cleanup(scratch);
  }
});

// ---------------------------------------------------------------------------------------------------
// The fixture tie: the reader that trusts this record.
// ---------------------------------------------------------------------------------------------------

function* walk(root: unknown): Generator<Loose> {
  if (Array.isArray(root)) {
    for (const child of root) yield* walk(child);
    return;
  }
  if (root === null || typeof root !== "object") return;
  const node = root as Loose;
  if (typeof node.type !== "string") return;
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "type" || key === "start" || key === "end") continue;
    yield* walk(value);
  }
}

const isIdentifier = (node: Loose, name: string) => node?.type === "Identifier" && node.name === name;

Deno.test("round trip: a record the writer produced is read back the way the fixture checks it (code === 0, stdout a string)", async () => {
  const scratch = freshScratch("round-trip");
  try {
    const recordDir = join(scratch, "records");
    assertEquals(
      await write({ record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 0, recordDir, now: fixedNow }),
      { written: true, reason: "written" },
    );
    // The fixture: JSON.parse(readFileSync(join(recordDir(), `${key}.json`))) then
    //   record?.code === 0 && typeof record?.stdout === "string"  =>  trusted, stdout reused.
    const record = JSON.parse(readFileSync(join(recordDir, `${REAL_KEY}.json`), "utf8"));
    assert(record?.code === 0 && typeof record?.stdout === "string", "the fixture would not trust this record");
    assertStrictEquals(record.stdout, STDOUT);
  } finally {
    cleanup(scratch);
  }
});

Deno.test("fixture tie: tests/fixtures/build-once.mjs reads the writer's directory, file name and fields — and writes the same shape itself", () => {
  const source = Deno.readTextFileSync(new URL("./fixtures/build-once.mjs", import.meta.url));
  const all = [...walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }))];

  // (1) the directory the reader looks in is the directory the writer writes to.
  const dirNames = all.filter((n) => n.type === "VariableDeclarator" && isIdentifier(n.id, "RECORD_DIR_NAME"));
  assertEquals(dirNames.length, 1, "the fixture must declare exactly one RECORD_DIR_NAME");
  assertEquals(dirNames[0].init?.type, "Literal", "RECORD_DIR_NAME must be a string literal");
  assertStrictEquals(
    dirNames[0].init.value,
    BUILD_ONCE_RECORD_DIR_NAME,
    "the fixture reads a different directory than the writer writes (the record would never be found)",
  );

  // (2) the file name is `<key>.json` everywhere the fixture builds one.
  const fileNames = all.filter((n) =>
    n.type === "TemplateLiteral" && n.quasis.length > 0 && n.quasis[n.quasis.length - 1].value.cooked === ".json"
  );
  assert(fileNames.length >= 1, "the fixture must build <key>.json file names");
  for (const template of fileNames) {
    assertEquals(template.quasis.map((q: Loose) => q.value.cooked), ["", ".json"]);
    assertEquals(template.expressions.length, 1, "the file name must be exactly <key>.json");
  }

  // (3) the record shape: the fixture's own writer and the helper agree on property names AND order, and
  //     the fixture's reader reads nothing the helper does not write.
  const stringifies = all.filter((n) =>
    n.type === "CallExpression" && n.callee.type === "MemberExpression" && isIdentifier(n.callee.object, "JSON") &&
    isIdentifier(n.callee.property, "stringify")
  );
  assertEquals(stringifies.length, 1, "the fixture must have exactly one JSON.stringify (its own record writer)");
  assertEquals(stringifies[0].arguments[0]?.type, "ObjectExpression");
  const fixtureWrites: string[] = stringifies[0].arguments[0].properties.map((p: Loose) => p.key.name);
  assertEquals(fixtureWrites, ["code", "stdout", "at"]);

  const readProperties = new Set<string>();
  for (const node of all) {
    if (node.type === "MemberExpression" && !node.computed && isIdentifier(node.object, "record")) {
      readProperties.add(node.property.name);
    }
  }
  assert(readProperties.has("code") && readProperties.has("stdout"), "the fixture reader must check record.code and record.stdout");
  for (const name of readProperties) {
    assert(fixtureWrites.includes(name), `the fixture reads record.${name}, which the record writer does not write`);
  }
});

Deno.test("fixture tie: the helper writes exactly the property list the fixture's own writer writes", async () => {
  const scratch = freshScratch("shape-parity");
  try {
    const recordDir = join(scratch, "records");
    await write({ record: { key: REAL_KEY, stdout: STDOUT }, buildSucceeded: true, exitCode: 0, recordDir, now: fixedNow });
    const written = JSON.parse(readFileSync(join(recordDir, `${REAL_KEY}.json`), "utf8"));
    assertEquals(Object.keys(written), ["code", "stdout", "at"]);
  } finally {
    cleanup(scratch);
  }
});

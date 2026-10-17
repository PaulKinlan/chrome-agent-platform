// tests/build-concurrency.test.ts — bead chrome-agent-platform-jjsz.
//
// The two policies the parallel build pipeline leans on (scripts/lib/build-concurrency.mjs):
//   settleAll       — every sibling quiesces BEFORE a failure surfaces, so the rollback that removes
//                     the staging tree never runs under a sibling still writing into it; the FIRST
//                     rejection in DECLARATION order is the one reported; later ones are not dropped.
//   resolveGcGraceMs — the version-GC grace parser (CAP_BUILD_GC_GRACE_MS).
//
// Determinism: none of these tests depends on a timer winning a race. The quiescence assertions
// compare "the sibling finished" against "the rejection surfaced": allSettled makes that true by
// construction, while a bare Promise.all surfaces the rejection in a microtask, long before a 25 ms
// timer can fire — so the mutant is RED every time, and the correct code is green every time.
import { assert, assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import {
  DEFAULT_GC_GRACE_MS,
  MAX_GC_GRACE_MS,
  resolveGcGraceMs,
  settleAll,
} from "../scripts/lib/build-concurrency.mjs";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `fn`, return what it threw (and whether it threw at all: a reason may be `undefined`). */
async function thrownBy(fn: () => Promise<unknown>): Promise<{ threw: boolean; reason: unknown }> {
  try {
    await fn();
    return { threw: false, reason: undefined };
  } catch (reason) {
    return { threw: true, reason };
  }
}

Deno.test("settleAll: a sibling is DONE before the failure surfaces (the rollback never runs under a live writer)", async () => {
  let siblingFinished = false;
  const slowSibling = (async () => {
    await sleep(25);
    siblingFinished = true;
    return "wrote";
  })();
  const failsAtOnce = Promise.reject(new Error("bundle exploded"));

  const { threw, reason } = await thrownBy(() => settleAll([failsAtOnce, slowSibling]));

  assert(threw, "a rejected task must reject the whole fan-out");
  assertEquals((reason as Error).message, "bundle exploded");
  assertStrictEquals(
    siblingFinished,
    true,
    "the failure surfaced while a sibling was still running: a rollback now would race its writes",
  );
});

Deno.test("settleAll: the reported cause is the FIRST rejection in DECLARATION order, not the first to happen", async () => {
  const declaredFirstButLate = (async () => {
    await sleep(25);
    throw new Error("declared first (fails late)");
  })();
  const declaredSecondButImmediate = Promise.reject(new Error("declared second (fails at once)"));
  const { reason } = await thrownBy(() =>
    settleAll([declaredFirstButLate, declaredSecondButImmediate], () => {})
  );
  assertEquals(
    (reason as Error).message,
    "declared first (fails late)",
    "the cause must not depend on which task lost a race",
  );
});

Deno.test("settleAll: every later rejection is reported with its index, never silently dropped", async () => {
  const reported: Array<[string, number]> = [];
  const { reason } = await thrownBy(() =>
    settleAll(
      [
        Promise.reject(new Error("zero")),
        Promise.resolve("fine"),
        Promise.reject(new Error("two")),
        Promise.reject(new Error("three")),
      ],
      (why, index) => reported.push([(why as Error).message, index]),
    )
  );
  assertEquals((reason as Error).message, "zero", "the first in declaration order is thrown");
  assertEquals(reported, [["two", 2], ["three", 3]], "exactly the later failures are reported, by index");
});

Deno.test("settleAll: the default reporter writes the later failure to stderr naming its index and message", async () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await thrownBy(() =>
      settleAll([Promise.reject(new Error("first")), Promise.reject(new Error("second one"))])
    );
  } finally {
    console.error = original;
  }
  assertEquals(lines.length, 1, "one secondary failure -> one stderr line");
  assert(lines[0].includes("#1"), `the line must name the task index: ${lines[0]}`);
  assert(lines[0].includes("second one"), `the line must carry the failure text: ${lines[0]}`);
});

Deno.test("settleAll: success returns the values in DECLARATION order even when completion order differs", async () => {
  const slowFirst = (async () => {
    await sleep(20);
    return "a";
  })();
  const quickSecond = Promise.resolve("b");
  assertEquals(await settleAll([slowFirst, quickSecond, "c"]), ["a", "b", "c"]);
  assertEquals(await settleAll([]), []);
});

Deno.test("settleAll: a falsy rejection reason (undefined, 0, empty string) still rejects the fan-out and is rethrown as-is", async () => {
  for (const falsy of [undefined, 0, ""]) {
    const { threw, reason } = await thrownBy(() => settleAll([Promise.reject(falsy), Promise.resolve(1)]));
    assert(threw, `a task rejecting with ${JSON.stringify(falsy) ?? "undefined"} must still fail the fan-out`);
    assertStrictEquals(reason, falsy);
  }
});

// ---------------------------------------------------------------- the version-GC grace (b0ld8)
//
// The grace exists so a process that resolved the PREVIOUS dist just before a rebuild published the
// new one can finish reading before the old version directory is removed. This asserts the PROPERTY,
// in BOTH directions so it cannot pass vacuously:
//   positive: a grace that outlasts the reader keeps the old tree readable across the swap;
//   negative: with NO grace the same reader loses the tree mid-read (if it did not, the positive half
//             would be asserting nothing).
// Deterministic by CONSTRUCTION, not by a timer winning a race: the reader is paced, so it always has
// unread files left when the swap lands, and the positive case's grace is many times the reader's
// remaining work, so load can slow the reader without changing either outcome.
//
// Scope, stated honestly: this pins the CONTRACT (a grace must outlive a reader). That build.mjs
// actually waits `gcGraceMs` before its rm is pinned separately by build-parallel-discipline.test.ts:804;
// together they cover the product path without adding a third 40s production build to the build tier.
Deno.test("b0ld8: a reader that pinned the OLD version dir survives a publish+GC when the grace outlasts it, and is torn down with no grace", async () => {
  // durableDir, not os.tmpdir(): /tmp on the build host is RAM-backed and tests/durable-root.test.ts
  // fails closed on real tmpdir usage (this test was caught by that guard on its first gate run).
  const root = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "b0ld8-grace-" });
  const versions = path.join(root, "dist-versions");
  const dist = path.join(root, "dist");
  const oldDir = path.join(versions, "v-old-1-1");
  const newDir = path.join(versions, "v-new-2-2");
  const NAMES = Array.from({ length: 8 }, (_, i) => `f${i}.js`);
  const seed = async () => {
    await mkdir(oldDir, { recursive: true });
    for (const n of NAMES) await writeFile(path.join(oldDir, n), `old-${n}`);
    await rm(dist, { force: true });
    await symlink(path.relative(root, oldDir), dist); // build.mjs's shape: a RELATIVE link
  };
  // build.mjs's publish order: symlink a next link, atomically rename it over dist, wait the grace
  // only when a prior version exists, then GC every other version directory.
  const publishAndGc = async (graceMs: number) => {
    const next = `${dist}.next`;
    await rm(next, { force: true }).catch(() => {});
    await symlink(path.relative(root, newDir), next);
    await rename(next, dist);
    if (graceMs > 0) await sleep(graceMs);
    for (const e of await readdir(versions, { withFileTypes: true })) {
      const full = path.join(versions, e.name);
      if (full !== newDir) await rm(full, { recursive: true, force: true });
    }
  };
  // A reader resolves the tree ONCE (as resolveDist / copy-built-tree do), then reads it slowly.
  const readPinned = async (dir: string) => {
    const lost: string[] = [];
    for (const n of NAMES) {
      try {
        await readFile(path.join(dir, n));
      } catch {
        lost.push(n);
      }
      await sleep(15); // paced: 8 files = 120ms, so ~100ms of work remains when the swap lands
    }
    return lost;
  };

  try {
    await mkdir(newDir, { recursive: true });
    await writeFile(path.join(newDir, "f0.js"), "new");

    // POSITIVE: grace (600ms) is many times the reader's remaining work (~100ms).
    await seed();
    const pin1 = await realpath(dist);
    assertEquals(pin1, oldDir, "the reader must pin the OLD version directory");
    const positive = readPinned(pin1);
    await sleep(20);
    await publishAndGc(600);
    assertEquals(
      await positive,
      [],
      "a grace that outlasts the reader must keep the old tree readable across the swap",
    );

    // NEGATIVE CONTROL: same reader, no grace. The tree is removed mid-read, so the files it had
    // not reached are gone. This is what makes the positive half non-vacuous.
    await seed();
    const pin2 = await realpath(dist);
    assertEquals(pin2, oldDir);
    const negative = readPinned(pin2);
    await sleep(20);
    await publishAndGc(0);
    const lost = await negative;
    assert(
      lost.length >= NAMES.length - 2,
      `with no grace the reader MUST lose the unread files, else the positive half proves nothing (lost ${lost.length}/${NAMES.length})`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

Deno.test("resolveGcGraceMs: the default is the MEASURED 1000 ms (b0ld8; the old 50 ms was an unmeasured guess)", () => {
  assertEquals(DEFAULT_GC_GRACE_MS, 1_000);
  assertEquals(resolveGcGraceMs({}), 1_000);
  assertEquals(resolveGcGraceMs(undefined), 1_000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: undefined }), 1_000);
});

Deno.test("resolveGcGraceMs: an unusable value falls back to the default and is never read as 'no grace'", () => {
  for (const bad of ["", "   ", "-1", "-0.5", "abc", "NaN", "Infinity", "-Infinity", "12px", "1,5"]) {
    assertEquals(
      resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: bad }),
      DEFAULT_GC_GRACE_MS,
      `"${bad}" must fall back to the default, not to 0 or a clamp`,
    );
  }
});

Deno.test("resolveGcGraceMs: an explicit value is honoured — 0 means no grace, 2000 restores the previous behaviour", () => {
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "0" }), 0, "explicit 0 disables the grace");
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "2000" }), 2000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: " 250 " }), 250, "surrounding whitespace is ignored");
  // N9 (round-2 review) INVERTED this row on purpose: "1e3" used to be read as 1000 because the
  // parser was Number(raw). Only plain decimal digits are a number now, so exponent notation is a
  // bad value and falls back to the default; spell 1000 as "1000".
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1e3" }), DEFAULT_GC_GRACE_MS);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1000" }), 1000);
});

Deno.test("resolveGcGraceMs: an explicit grace is capped so a typo cannot stall every build", () => {
  assertEquals(MAX_GC_GRACE_MS, 60_000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "60000" }), 60_000);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "60001" }), 60_000);
  // N9: was "1e9"; exponent notation is a bad value now (see the not-canonical table below), so the
  // same magnitude is spelled in plain digits to keep the cap itself covered.
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1000000000" }), 60_000);
});

// ── N9 (round-2 review): only a plain run of decimal digits is a number ──────────────────────────
//
// The parser used to be `Number(raw)`, which also reads `-0` (as -0: NO grace, although the doc table
// promises a bad value is never read as no grace), `0x10` (16), `0b101` (5), `0o7` (7), `1e3` (1000),
// `12.5` and `+5`. After trim(), ONLY /^\d+$/ is a number now; everything else falls back to the
// default. One test PER ROW so the failing row names itself: each row below whose behaviour differs
// from the old `Number(raw)` parse is RED against it (mutation drill M1 in the N9 report).
const NOT_A_PLAIN_DECIMAL: Array<[input: string, why: string]> = [
  ["-0", "negative zero used to come back as -0, i.e. no grace"],
  ["+5", "a sign is not a digit; Number() read it as 5"],
  ["0x10", "hex; Number() read it as 16"],
  ["0b101", "binary; Number() read it as 5"],
  ["0o7", "octal; Number() read it as 7"],
  ["1e3", "exponent; Number() read it as 1000"],
  ["1e9", "exponent; Number() read it as 1e9 (then capped to 60000)"],
  ["12.5", "fractional milliseconds; Number() read it as 12.5"],
  [".5", "leading-dot fraction; Number() read it as 0.5"],
  ["1.", "trailing dot; Number() read it as 1"],
  ["Infinity", "not finite"],
  ["-Infinity", "not finite"],
  ["NaN", "not a number"],
  ["1_000", "numeric separators are source syntax, not a value"],
  ["12 5", "internal whitespace"],
  ["5\n5", "internal newline: `$` is end-of-input in JS, never before a trailing newline"],
  ["٥", "a non-ASCII digit is not a digit here (\\d is [0-9])"],
  ["５", "a fullwidth digit is not a digit here"],
];
for (const [input, why] of NOT_A_PLAIN_DECIMAL) {
  Deno.test(`resolveGcGraceMs N9: ${JSON.stringify(input)} is not a plain decimal integer -> default, never a number (${why})`, () => {
    const got = resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: input });
    assertEquals(got, DEFAULT_GC_GRACE_MS, `${JSON.stringify(input)} must fall back to the default`);
    assert(!Object.is(got, -0), "a bad value must never come back as negative zero");
  });
}

Deno.test("resolveGcGraceMs N9: plain decimal digits are honoured exactly; zero is +0; leading zeros are decimal, never octal", () => {
  const rows: Array<[input: string, expected: number]> = [
    ["0", 0],
    ["00", 0],
    ["7", 7],
    ["007", 7],
    ["010", 10], // a legacy-octal reading would be 8
    ["50", 50],
    ["250", 250],
    ["2000", 2000],
    ["60000", 60_000],
  ];
  for (const [input, expected] of rows) {
    const got = resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: input });
    assertEquals(got, expected, `${JSON.stringify(input)} -> ${expected}`);
    assert(Object.is(got, expected), `${JSON.stringify(input)} must be exactly ${expected} (not -0)`);
  }
  // surrounding whitespace of every kind is trimmed first (unchanged behaviour)
  for (const padded of [" 250 ", "\t250\n", "\u00a0250\u00a0"]) {
    assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: padded }), 250, `${JSON.stringify(padded)} trims to 250`);
  }
});

Deno.test("resolveGcGraceMs N9: digits above the cap are capped, but digit strings that overflow to Infinity are a bad value (default), not a clamp", () => {
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "60001" }), MAX_GC_GRACE_MS);
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "9".repeat(20) }), MAX_GC_GRACE_MS, "1e20 is finite: capped");
  // The exact finite/overflow boundary of a double: 1e308 (a 1 and 308 zeros, 309 digits) is finite, 1e309 is Infinity.
  assertEquals(
    resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1" + "0".repeat(308) }),
    MAX_GC_GRACE_MS,
    "1e308 is finite, so it is capped like any other large number",
  );
  assertEquals(
    resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "1" + "0".repeat(309) }),
    DEFAULT_GC_GRACE_MS,
    "1e309 overflows to Infinity: unusable, so the default (never 'no grace', never the cap)",
  );
  assertEquals(resolveGcGraceMs({ CAP_BUILD_GC_GRACE_MS: "9".repeat(400) }), DEFAULT_GC_GRACE_MS);
});

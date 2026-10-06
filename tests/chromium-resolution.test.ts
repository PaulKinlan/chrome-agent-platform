// tests/chromium-resolution.test.ts — the shared browser resolution
// (chrome-agent-platform-fyvc): ONE order for every consumer —
//   CAP_CHROMIUM env → chrome-for-testing cache (bare dirs included, wvg) →
//   /usr/bin/chromium last resort —
// plus the resolution REPORT the RPC census consumes (an unresolvable box is a
// FAILED census, never a silent green) and the chrome-lock parent-directory fix
// (a caller-owned lockPath under a scratch dir that does not exist yet used to
// die in ~400ms blaming another lane's browser).
//
// RED honesty: on the unfixed tree this file cannot import its subjects at all
// (the exports do not exist), so its own RED is an import error. The
// intended-reason REDs for the change live in (a) the bare-version-dir test in
// tests/chrome-for-testing.test.ts (assertion-level RED on the old versionOf)
// and (b) the census wiring pins at the bottom of this file. The order pins
// below are the teeth for any future re-ordering of the resolution chain.
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { BrowserUnresolvedError, CHROMIUM, resolveChromiumBinary, resolveChromiumBinaryReport, acquireChromeLock } from "../scripts/lib/chrome-launch.ts";

/** Unique suffix for the durable scratch dirs below, so a repeated call cannot collide. */
let tmpSeq = 0;

/** A fixture puppeteer cache holding one executable fake browser. */
function fixtureCache(version: string): string {
  // Durable, not a bare temp-dir factory: this host's scratch filesystem is RAM-backed tmpfs and
  // tests/durable-root.test.ts polices it (chrome-agent-platform-fyvc's own new test added these and
  // tripped that guard, which no gate selected because the guard is NOT in ALWAYS_ON). Removed by the
  // caller's finally, so nothing is retained.
  const root = durableDir(`fyvc-resolution-cache-${Deno.pid}-${tmpSeq++}`);
  const dir = `${root}/${version}/chrome-linux64`;
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(`${dir}/chrome`, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(`${dir}/chrome`, 0o755);
  return root;
}

const envOf = (kv: Record<string, string>) => (name: string) => kv[name];
const noEnv = envOf({});

Deno.test("fyvc/oy4m resolution: a USABLE override wins, the cache is next, the default is the last resort, and an unresolvable browser THROWS rather than returning a doomed path", () => {
  // chrome-agent-platform-oy4m CHANGED THIS PIN DELIBERATELY. It used to assert that the override "is never
  // existence-checked: a wrong override surfaces as a loud spawn error", and that justification is exactly
  // what failed in the original defect: an environment difference reached the user as a product-shaped
  // ENOENT instead of a named environmental refusal. The sibling now takes the s7wr shape.
  //
  // 1. A USABLE override wins over everything.
  assertEquals(
    resolveChromiumBinary({
      envGet: envOf({ CAP_CHROMIUM: "/opt/a-chrome" }),
      exists: () => true,
      usable: () => true,
    }),
    "/opt/a-chrome",
  );
  // An UNUSABLE override cannot silently resolve into a launch: it throws with the tried list.
  const missing = assertThrows(
    () =>
      resolveChromiumBinary({
        envGet: envOf({ CAP_CHROMIUM: "/opt/a-chrome" }),
        exists: () => false,
        usable: () => false,
      }),
    BrowserUnresolvedError,
  );
  assertStringIncludes(missing.message, "CAP_CHROMIUM=/opt/a-chrome (missing)");
  // A BARE name is resolved through $PATH (the s7wr review's false-refusal lesson), and a trailing space is
  // trimmed rather than stat'ed as part of the filename.
  assertEquals(
    resolveChromiumBinary({
      envGet: envOf({ CAP_CHROMIUM: "chromium ", PATH: "/one:/two" }),
      usable: (p) => p === "/two/chromium",
    }),
    "/two/chromium",
  );
  // 2. A whitespace-only override is not an override (and with no cache in play, the last resort is the result).
  assertEquals(
    resolveChromiumBinary({
      envGet: envOf({ CAP_CHROMIUM: "   " }),
      cacheRoot: "/nonexistent-fyvc-probe",
      exists: () => true,
    }),
    CHROMIUM,
    "a whitespace-only override is not an override",
  );

  const cache = fixtureCache("150.0.1.1");
  try {
    // 3. A resolvable cache beats the default literal…
    assertEquals(
      resolveChromiumBinary({ envGet: noEnv, cacheRoot: cache }),
      `${cache}/150.0.1.1/chrome-linux64/chrome`,
    );
    // …but never a usable override, and an unusable override does NOT silently pick the cache.
    const refused = assertThrows(
      () => resolveChromiumBinary({
        envGet: envOf({ CAP_CHROMIUM: "/not-installed/chromium" }),
        cacheRoot: cache,
        exists: () => false,
        usable: () => false,
      }),
      BrowserUnresolvedError,
    );
    assertStringIncludes(refused.message, "CAP_CHROMIUM=/not-installed/chromium (missing)");
    assertEquals(refused.tried, ["CAP_CHROMIUM=/not-installed/chromium (missing)"]);
    assertEquals(
      resolveChromiumBinary({
        envGet: envOf({ CAP_CHROMIUM: "/opt/a-chrome" }),
        cacheRoot: cache,
        exists: () => true,
        usable: () => true,
      }),
      "/opt/a-chrome",
    );
  } finally {
    Deno.removeSync(cache, { recursive: true });
  }

  // 4. No override, no cache, a present last resort → the documented literal (the ONE place it lives now).
  assertEquals(
    resolveChromiumBinary({ envGet: noEnv, cacheRoot: "/nonexistent-fyvc-probe", exists: () => true }),
    CHROMIUM,
  );
  // 5. …and NOTHING present → the NAMED throw, not a path that dies ENOENT at the spawn. This is the half of
  // oy4m the old contract could not express: a string-returning resolver has no way to refuse.
  const nothing = assertThrows(
    () => resolveChromiumBinary({ envGet: noEnv, cacheRoot: "/nonexistent-fyvc-probe", exists: () => false }),
    BrowserUnresolvedError,
  );
  assertStringIncludes(nothing.message, "ENVIRONMENT: no usable browser resolved");
  assertStringIncludes(nothing.message, "missing on this box");
});

Deno.test("fyvc/s7wr report: names every step it tried; a null binary when the OVERRIDE is unusable or the last resort is missing", () => {
  // chrome-agent-platform-s7wr CHANGED THIS PIN. It previously asserted the opposite - "reported as the
  // override, no existence games" - and that trust WAS the defect: a reported-but-missing override made
  // the hlgr environmental refusal unreachable and the launch died ENOENT, i.e. an environment difference
  // surfacing as a product-shaped red. An unusable override now REFUSES, naming the path and the reason.
  const missing = resolveChromiumBinaryReport({
    envGet: envOf({ CAP_CHROMIUM: "/opt/c" }), exists: () => false, usable: () => false,
  });
  assertEquals(missing, { binary: null, tried: ["CAP_CHROMIUM=/opt/c (missing)"] });
  const notExecutable = resolveChromiumBinaryReport({
    envGet: envOf({ CAP_CHROMIUM: "/opt/c" }), exists: () => true, usable: () => false,
  });
  assertEquals(notExecutable, { binary: null, tried: ["CAP_CHROMIUM=/opt/c (not executable)"] });
  // A USABLE override still resolves - the falsification that the check did not break the happy path.
  const usableOverride = resolveChromiumBinaryReport({
    envGet: envOf({ CAP_CHROMIUM: "/opt/c" }), exists: () => true, usable: () => true,
  });
  assertEquals(usableOverride, { binary: "/opt/c", tried: ["CAP_CHROMIUM=/opt/c"] });

  // Nothing anywhere, and the last resort missing: null + a tried-list that
  // SAYS it is missing, so the census's failure message names what to fix.
  const r2 = resolveChromiumBinaryReport({ envGet: noEnv, cacheRoot: "/nonexistent-fyvc-probe", exists: () => false });
  assertEquals(r2.binary, null);
  assertStringIncludes(r2.tried.join(";"), "missing on this box", "the report says the default is absent, not that nothing was tried");

  // Nothing but a present last resort: resolved, tried-list names the default.
  const r3 = resolveChromiumBinaryReport({ envGet: noEnv, cacheRoot: "/nonexistent-fyvc-probe", exists: () => true });
  assertEquals(r3.binary, CHROMIUM);
  assertEquals(r3.tried, [`default ${CHROMIUM}`]);
});

Deno.test("s7wr: an unusable override does NOT fall through to an available cache or default", () => {
  // The refusal is the point: quietly using a DIFFERENT browser behind an explicit override would hide the
  // operator's misconfiguration. The fixture cache here is REAL and usable, so a fall-through would resolve.
  const cache = fixtureCache("1.2.3");
  try {
    const r = resolveChromiumBinaryReport({
      envGet: envOf({ CAP_CHROMIUM: "/opt/c" }),
      cacheRoot: cache,
      usable: () => false,
    });
    assertEquals(r, { binary: null, tried: ["CAP_CHROMIUM=/opt/c (missing)"] });
  } finally {
    Deno.removeSync(cache, { recursive: true });
  }
});

Deno.test("s7wr: the REAL filesystem predicate refuses a non-executable override and accepts an executable one", async () => {
  // No injection at all: this pins the actual statSync + execute-bit behaviour, including the shape that
  // the refusal module's review already caught once (a real file with no execute bit is as absent as a
  // missing one).
  const dir = durableDir(`s7wr-usable-${Deno.pid}-${tmpSeq++}`);
  const plain = `${dir}/not-executable`;
  const runnable = `${dir}/runnable`;
  Deno.writeTextFileSync(plain, "not a browser\n");
  Deno.writeTextFileSync(runnable, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(plain, 0o644);
  Deno.chmodSync(runnable, 0o755);
  try {
    const refused = resolveChromiumBinaryReport({ envGet: envOf({ CAP_CHROMIUM: plain }) });
    assertEquals(refused.binary, null, "a non-executable override must refuse, not resolve");
    assertEquals(refused.tried, [`CAP_CHROMIUM=${plain} (not executable)`]);
    const resolved = resolveChromiumBinaryReport({ envGet: envOf({ CAP_CHROMIUM: runnable }) });
    assertEquals(resolved, { binary: runnable, tried: [`CAP_CHROMIUM=${runnable}`] });
    // oy4m: drive the string variant through the REAL filesystem, not merely injected predicates.
    const notExecutable = assertThrows(
      () => resolveChromiumBinary({ envGet: envOf({ CAP_CHROMIUM: plain }) }),
      BrowserUnresolvedError,
    );
    assertStringIncludes(notExecutable.message, `CAP_CHROMIUM=${plain} (not executable)`);
    assertEquals(resolveChromiumBinary({ envGet: envOf({ CAP_CHROMIUM: runnable }) }), runnable);
    const directory = assertThrows(
      () => resolveChromiumBinary({ envGet: envOf({ CAP_CHROMIUM: dir }) }),
      BrowserUnresolvedError,
    );
    assertStringIncludes(directory.message, `CAP_CHROMIUM=${dir} (a directory)`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fyvc lock: a lockPath under a not-yet-existing directory acquires — the parent is created, never the misleading other-lane blame", async () => {
  const dir = durableDir(`fyvc-lock-${Deno.pid}-${tmpSeq++}`);
  try {
    const lockPath = `${dir}/deep/nested/chrome.lock`;
    const lock = await acquireChromeLock(lockPath);
    try {
      assert(Deno.statSync(lockPath).isFile, "the lock file exists — its parent directory was created");
    } finally {
      lock.release();
      // Give the flock holder a beat to exit on its closed stdin.
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fyvc lock: an uncreatable parent fails with the REAL reason, not another lane's browser", async () => {
  const dir = durableDir(`fyvc-lock-real-${Deno.pid}-${tmpSeq++}`);
  try {
    Deno.writeTextFileSync(`${dir}/a-file`, "in the way\n");
    const error = await assertRejects(
      () => acquireChromeLock(`${dir}/a-file/child/chrome.lock`),
      Error,
      "cannot create the chrome-lock directory",
    );
    assertStringIncludes(error.message, "filesystem problem, not another lane's browser");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("s7wr review: a BARE override resolves through $PATH, is trimmed, and a directory names itself", async () => {
  // (review finding 2) A bare name is NOT a filesystem path: a spawn resolves it through $PATH, so stat'ing
  // it against the CWD would refuse a configuration that always worked - a false refusal introduced by the
  // verification itself. The check follows the spawn's own rule and reports the absolute path it found.
  const onPath = resolveChromiumBinaryReport({
    envGet: envOf({ CAP_CHROMIUM: "chromium", PATH: "/one:/two" }),
    usable: (p) => p === "/two/chromium",
  });
  assertEquals(onPath, {
    binary: "/two/chromium",
    tried: ["CAP_CHROMIUM=chromium (resolved on $PATH: /two/chromium)"],
  });
  const absent = resolveChromiumBinaryReport({
    envGet: envOf({ CAP_CHROMIUM: "chromium", PATH: "/one:/two" }),
    usable: () => false,
  });
  assertEquals(absent, { binary: null, tried: ["CAP_CHROMIUM=chromium (not found on $PATH)"] });

  // (findings 3 and 4) Against the REAL filesystem, with no injection: a directory override is NAMED as a
  // directory rather than "missing", and a trailing space in the value does not make a real browser look
  // missing (the trimmed value is both checked and reported).
  const dir = durableDir(`s7wr-review-${Deno.pid}-${tmpSeq++}`);
  const runnable = `${dir}/runnable`;
  Deno.writeTextFileSync(runnable, "#!/bin/sh\nexit 0\n");
  Deno.chmodSync(runnable, 0o755);
  try {
    const asDirectory = resolveChromiumBinaryReport({ envGet: envOf({ CAP_CHROMIUM: dir }) });
    assertEquals(asDirectory, { binary: null, tried: [`CAP_CHROMIUM=${dir} (a directory)`] });
    const withSpace = resolveChromiumBinaryReport({ envGet: envOf({ CAP_CHROMIUM: `${runnable} ` }) });
    assertEquals(withSpace, { binary: runnable, tried: [`CAP_CHROMIUM=${runnable}`] });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

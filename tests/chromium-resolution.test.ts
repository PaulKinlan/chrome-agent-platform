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
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { CHROMIUM, resolveChromiumBinary, resolveChromiumBinaryReport, acquireChromeLock } from "../scripts/lib/chrome-launch.ts";

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

Deno.test("fyvc resolution: CAP_CHROMIUM wins outright, the cache is next, /usr/bin/chromium is the last resort", () => {
  // 1. The explicit override wins over everything (it is never
  // existence-checked: a wrong override surfaces as a loud spawn error).
  assertEquals(resolveChromiumBinary({ envGet: envOf({ CAP_CHROMIUM: "/opt/a-chrome" }) }), "/opt/a-chrome");
  // An override that is only whitespace does not count as one (and with no
  // cache in play, the last resort is the deterministic result).
  assertEquals(
    resolveChromiumBinary({ envGet: envOf({ CAP_CHROMIUM: "   " }), cacheRoot: "/nonexistent-fyvc-probe" }),
    CHROMIUM,
    "a whitespace-only override is not an override",
  );

  const cache = fixtureCache("150.0.1.1");
  try {
    // 2. A resolvable cache beats the default literal…
    assertEquals(
      resolveChromiumBinary({ envGet: noEnv, cacheRoot: cache }),
      `${cache}/150.0.1.1/chrome-linux64/chrome`,
    );
    // …but never the override.
    assertEquals(
      resolveChromiumBinary({ envGet: envOf({ CAP_CHROMIUM: "/opt/a-chrome" }), cacheRoot: cache }),
      "/opt/a-chrome",
    );
  } finally {
    Deno.removeSync(cache, { recursive: true });
  }

  // 3. No override, no cache → the documented last resort (the ONE place the
  // literal lives now; every other site imports this resolution).
  assertEquals(resolveChromiumBinary({ envGet: noEnv, cacheRoot: "/nonexistent-fyvc-probe" }), CHROMIUM);
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

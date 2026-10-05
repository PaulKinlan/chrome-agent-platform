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
import { CHROMIUM, resolveChromiumBinary, resolveChromiumBinaryReport, acquireChromeLock } from "../scripts/lib/chrome-launch.ts";

/** A fixture puppeteer cache holding one executable fake browser. */
function fixtureCache(version: string): string {
  const root = Deno.makeTempDirSync({ prefix: "fyvc-resolution-cache-" });
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

Deno.test("fyvc report: names every step it tried; a null binary only when the last resort is missing", () => {
  // Override path: reported as the override, no existence games.
  const r1 = resolveChromiumBinaryReport({ envGet: envOf({ CAP_CHROMIUM: "/opt/c" }), exists: () => false });
  assertEquals(r1, { binary: "/opt/c", tried: ["CAP_CHROMIUM=/opt/c"] });

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

Deno.test("fyvc lock: a lockPath under a not-yet-existing directory acquires — the parent is created, never the misleading other-lane blame", async () => {
  const dir = Deno.makeTempDirSync({ prefix: "fyvc-lock-" });
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
  const dir = Deno.makeTempDirSync({ prefix: "fyvc-lock-real-" });
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

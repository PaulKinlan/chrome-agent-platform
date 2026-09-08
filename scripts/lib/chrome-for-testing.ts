// scripts/lib/chrome-for-testing.ts — resolve Chrome for Testing from the puppeteer
// cache instead of pinning a version directory (bead chrome-agent-platform-icf1).
//
// WHY THIS EXISTS. Harnesses and one test pinned an absolute
// `.cache/puppeteer/chrome/linux-<one-version>/chrome-linux64/chrome` literal. That is
// the defect class tests/machine-path-honesty.test.ts guards: a path that exists on
// exactly one machine, so on every other checkout the gate either fails loudly or —
// worse — skips behind a catch and reports PASS having asserted nothing (AGENTS.md
// "Test honesty" mode 5, CONDITIONAL DEATH). A version pin rots a second way: the day
// the cache is refreshed, every harness that names the old version stops finding a
// browser at all.
//
// THE RULE. Resolve from the cache glob `$HOME/.cache/puppeteer/chrome/*/chrome-
// linux64/chrome`, newest version first, and return null when nothing resolves so the
// CALLER makes the honest choice for its own context: a test reports itself `ignore`d
// (visible in the runner's tally, never a silent pass), a harness exits non-zero with a
// reason. Nothing here names a user, a machine, or a browser version.
//
// SCOPE, stated rather than hidden: the layout is the Linux one puppeteer's installer
// writes (`chrome-linux64`). On another platform nothing resolves and the caller skips
// or fails with its reason — this never guesses a path it cannot verify.

/** The cache directory puppeteer's installer writes Chrome for Testing into.
 *  Assembled from `$HOME` at call time so no literal machine path exists in source. */
export function chromeForTestingCacheRoot(): string {
  const home = Deno.env.get("HOME");
  return home ? `${home}/.cache/puppeteer/chrome` : "";
}

/** `linux-140.0.7339.82` → [140, 0, 7339, 82]; null when the entry is not a version
 *  directory (a partial download, a temp dir, another channel's tree). */
function versionOf(dirName: string): number[] | null {
  const m = /^linux-(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(dirName);
  return m ? m.slice(1).map(Number) : null;
}

/** Descending NUMERIC compare. A lexicographic sort ranks `linux-99.x` above
 *  `linux-100.x` and hands the caller the wrong browser — tests/chrome-for-testing
 *  .test.ts pins both the ordering and that specific trap. */
function byVersionDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest executable Chrome for Testing binary in the puppeteer cache, or null when
 *  this box has none. `cacheRoot` is injectable so the ordering and the miss cases are
 *  testable against a fixture tree instead of against whatever this machine happens to
 *  have installed. */
export function resolveChromeForTesting(opts: { cacheRoot?: string } = {}): string | null {
  const root = opts.cacheRoot ?? chromeForTestingCacheRoot();
  if (!root) return null;

  let names: string[];
  try {
    names = [...Deno.readDirSync(root)].filter((e) => e.isDirectory).map((e) => e.name);
  } catch {
    // No puppeteer cache here. That is an environment fact, not an error: the caller
    // decides what an absent browser means (a test ignores itself; a harness fails).
    return null;
  }

  const ranked = names
    .map((name) => ({ name, version: versionOf(name) }))
    .filter((c): c is { name: string; version: number[] } => c.version !== null)
    .sort((a, b) => byVersionDesc(a.version, b.version));

  for (const c of ranked) {
    const binary = `${root}/${c.name}/chrome-linux64/chrome`;
    try {
      // Existence AND the executable bit: an interrupted install leaves the directory
      // behind without a runnable binary, and spawning that surfaces as a confusing
      // EACCES instead of "this candidate is incomplete, try the next newest".
      const st = Deno.statSync(binary);
      if (st.isFile && ((st.mode ?? 0) & 0o111) !== 0) return binary;
    } catch {
      /* incomplete candidate — fall through to the next newest */
    }
  }
  return null;
}

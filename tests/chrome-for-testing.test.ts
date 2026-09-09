// chrome-for-testing.test.ts — the resolver's teeth (bead chrome-agent-platform-icf1).
//
// The resolver replaced an absolute, version-pinned Chrome for Testing path — the
// machine-path defect class, and the reason a real-browser gate could report PASS on a
// box where it never ran. These tests pin the two properties that make the replacement
// trustworthy, against a FIXTURE cache tree (never against whatever this machine happens
// to have, which is how the original pin went unnoticed):
//
//   1. it returns the NEWEST version, compared NUMERICALLY — a lexicographic sort ranks
//      99 above 100 and hands back the wrong browser;
//   2. it returns null — never a guess, never a throw — when this box has no usable
//      binary, so the caller can report an honest skip instead of a silent pass;
//   3. it names no machine, no user and no version in its own source.
//
// Nothing here writes a literal absolute path to a filesystem call, so the machine-path
// guard scans this file clean with an empty allowlist.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { cacheRootForHome, chromeForTestingCacheRoot, resolveChromeForTesting } from "../scripts/lib/chrome-for-testing.ts";

/** Build a fixture puppeteer cache. Failure shapes an interrupted install really leaves
 *  behind, each one pinned by a test: `incomplete` — the version directory with no
 *  binary at all; `notExecutable` — the binary written but never chmodded;
 *  `dirAtBinaryPath` — a DIRECTORY at the binary path (what a partial `mkdir -p` leaves);
 *  `symlinked` — the version directory is a symlink (a shared cache's space-saving
 *  shape). */
function fakeCache(
  versions: string[],
  opts: {
    incomplete?: string[];
    notExecutable?: string[];
    dirAtBinaryPath?: string[];
    symlinked?: string[];
    extraDirs?: string[];
  } = {},
): { root: string; done: () => void } {
  const root = Deno.makeTempDirSync({ prefix: "cft-cache-" });
  const mk = (name: string): string => {
    const dir = `${root}/${name}/chrome-linux64`;
    Deno.mkdirSync(dir, { recursive: true });
    return `${dir}/chrome`;
  };
  for (const v of versions) {
    if ((opts.symlinked ?? []).includes(v)) {
      // The real tree lives under a dot-prefixed sibling; the cache entry is a link.
      const real = `${root}/.real-${v}`;
      Deno.mkdirSync(`${real}/chrome-linux64`, { recursive: true });
      Deno.writeTextFileSync(`${real}/chrome-linux64/chrome`, "#!/bin/sh\nexit 0\n");
      Deno.chmodSync(`${real}/chrome-linux64/chrome`, 0o755);
      Deno.symlinkSync(real, `${root}/${v}`);
      continue;
    }
    if ((opts.dirAtBinaryPath ?? []).includes(v)) {
      Deno.mkdirSync(`${root}/${v}/chrome-linux64/chrome`, { recursive: true });
      continue;
    }
    if ((opts.incomplete ?? []).includes(v)) {
      Deno.mkdirSync(`${root}/${v}/chrome-linux64`, { recursive: true });
      continue;
    }
    const bin = mk(v);
    Deno.writeTextFileSync(bin, "#!/bin/sh\nexit 0\n");
    Deno.chmodSync(bin, (opts.notExecutable ?? []).includes(v) ? 0o644 : 0o755);
  }
  for (const d of opts.extraDirs ?? []) Deno.mkdirSync(`${root}/${d}`, { recursive: true });
  return { root, done: () => Deno.removeSync(root, { recursive: true }) };
}

const rel = (root: string, resolved: string | null): string | null =>
  resolved === null ? null : resolved.slice(root.length + 1);

Deno.test("chrome-for-testing: resolves the NEWEST cached version", () => {
  const cache = fakeCache([
    "linux-132.0.6834.83", "linux-140.0.7339.80", "linux-140.0.7339.82",
    "linux-146.0.7680.153", "linux-148.0.7778.97", "linux-150.0.7871.24",
  ]);
  try {
    assertEquals(
      rel(cache.root, resolveChromeForTesting({ cacheRoot: cache.root })),
      "linux-150.0.7871.24/chrome-linux64/chrome",
      "a machine with several cached builds must get the newest, not whichever readdir yielded first",
    );
  } finally { cache.done(); }
});

Deno.test("chrome-for-testing: versions rank NUMERICALLY, so 100 beats 99", () => {
  // The lexicographic mutant: "linux-99…" sorts ABOVE "linux-100…" as text, so a
  // name-sorted resolver returns the older browser and every gate that trusts it drives
  // a version nobody chose. Two directories, and the wrong answer is unambiguous.
  const cache = fakeCache(["linux-99.0.0.0", "linux-100.0.0.0"]);
  try {
    assertEquals(
      rel(cache.root, resolveChromeForTesting({ cacheRoot: cache.root })),
      "linux-100.0.0.0/chrome-linux64/chrome",
      "a numeric compare is required: as text, 99 outranks 100",
    );
  } finally { cache.done(); }

  // And the same trap on a real-shaped pair of minors/builds.
  const cache2 = fakeCache(["linux-140.0.9999.9", "linux-140.0.10000.1"]);
  try {
    assertEquals(
      rel(cache2.root, resolveChromeForTesting({ cacheRoot: cache2.root })),
      "linux-140.0.10000.1/chrome-linux64/chrome",
      "build numbers rank numerically too",
    );
  } finally { cache2.done(); }
});

Deno.test("chrome-for-testing: nothing usable resolves to null, never a guess and never a throw", () => {
  // No cache directory at all — the hermetic-CI case the callers must report honestly.
  const emptyRoot = fakeCache([]);
  const missing = `${emptyRoot.root}/no-such-cache`;
  try {
    assertEquals(resolveChromeForTesting({ cacheRoot: missing }), null, "an absent cache root is null");

    // Present but empty.
    assertEquals(resolveChromeForTesting({ cacheRoot: emptyRoot.root }), null, "an empty cache root is null");

    // Present but only directories that are not version dirs (another channel's tree, a
    // partial download): guessing one of these would hand a harness a binary that is not
    // Chrome for Testing at all.
    const junk = fakeCache([], { extraDirs: ["linux-stable", "tmp-install-9931", "chrome-headless-shell"] });
    try {
      assertEquals(resolveChromeForTesting({ cacheRoot: junk.root }), null, "a non-version directory is never resolved");
    } finally { junk.done(); }

    // An empty root STRING (what a missing $HOME produces) is null — the guard branch in
    // the resolver, not a read of a relative path that happens to exist.
    assertEquals(resolveChromeForTesting({ cacheRoot: "" }), null, "an empty root string is null, never a cwd-relative scan");
  } finally { emptyRoot.done(); }
});

Deno.test("chrome-for-testing: an incomplete newest build falls back to the next usable one", () => {
  const noBinary = fakeCache(["linux-149.0.0.0", "linux-148.0.7778.97"], { incomplete: ["linux-149.0.0.0"] });
  try {
    assertEquals(
      rel(noBinary.root, resolveChromeForTesting({ cacheRoot: noBinary.root })),
      "linux-148.0.7778.97/chrome-linux64/chrome",
      "a version directory without a binary (interrupted install) must not wedge every gate",
    );
  } finally { noBinary.done(); }

  const notExec = fakeCache(["linux-149.0.0.0", "linux-148.0.7778.97"], { notExecutable: ["linux-149.0.0.0"] });
  try {
    assertEquals(
      rel(notExec.root, resolveChromeForTesting({ cacheRoot: notExec.root })),
      "linux-148.0.7778.97/chrome-linux64/chrome",
      "a binary without the executable bit is not a usable browser",
    );
  } finally { notExec.done(); }

  // Every candidate incomplete → null (the honest skip), not the first path tried.
  const allBad = fakeCache(["linux-150.0.0.0", "linux-149.0.0.0"], { incomplete: ["linux-150.0.0.0", "linux-149.0.0.0"] });
  try {
    assertEquals(resolveChromeForTesting({ cacheRoot: allBad.root }), null, "no usable binary anywhere is null");
  } finally { allBad.done(); }

  // A DIRECTORY at the binary path is not a browser either — precisely what an
  // interrupted `mkdir -p` install leaves, and the shape the resolver's own comment says
  // the isFile guard exists to refuse. It must fall through to the next usable build.
  const dirAtBinary = fakeCache(["linux-149.0.0.0", "linux-148.0.7778.97"], { dirAtBinaryPath: ["linux-149.0.0.0"] });
  try {
    assertEquals(
      rel(dirAtBinary.root, resolveChromeForTesting({ cacheRoot: dirAtBinary.root })),
      "linux-148.0.7778.97/chrome-linux64/chrome",
      "a directory at the binary path falls through to the next newest",
    );
  } finally { dirAtBinary.done(); }

  const onlyDir = fakeCache(["linux-149.0.0.0"], { dirAtBinaryPath: ["linux-149.0.0.0"] });
  try {
    assertEquals(resolveChromeForTesting({ cacheRoot: onlyDir.root }), null, "a directory at the binary path is never handed back as the browser");
  } finally { onlyDir.done(); }
});

Deno.test("chrome-for-testing: a symlinked version directory resolves to the binary it points at", () => {
  // Deno reports a symlink-to-directory as isDirectory:false, so a filter on isDirectory
  // alone drops a shared/managed cache's entries and every journey on that box becomes an
  // unexplained skip. The link must be followed — and what it points at is still
  // validated by the stat + exec-bit check.
  const cache = fakeCache(["linux-150.0.7871.24", "linux-140.0.7339.82"], { symlinked: ["linux-150.0.7871.24"] });
  try {
    assertEquals(
      rel(cache.root, resolveChromeForTesting({ cacheRoot: cache.root })),
      "linux-150.0.7871.24/chrome-linux64/chrome",
      "the newest entry must resolve through a symlink, not be filtered out",
    );
  } finally { cache.done(); }

  // And a symlinked-only cache resolves, rather than degrading to an unexplained null.
  const onlyLink = fakeCache(["linux-150.0.7871.24"], { symlinked: ["linux-150.0.7871.24"] });
  try {
    assert(resolveChromeForTesting({ cacheRoot: onlyLink.root }) !== null, "a symlink-only cache must still resolve");
  } finally { onlyLink.done(); }
});

Deno.test("chrome-for-testing: equal versions break ties by name, so the pick does not depend on readdir order", () => {
  // Two zero-padded spellings of one version parse to the same tuple; the winner must be
  // deterministic (raw name descending) rather than whichever the kernel read first.
  const cache = fakeCache(["linux-140.0.7339.082", "linux-140.0.7339.82"]);
  try {
    assertEquals(
      rel(cache.root, resolveChromeForTesting({ cacheRoot: cache.root })),
      "linux-140.0.7339.82/chrome-linux64/chrome",
      "an equal-version tie is broken by name, descending",
    );
  } finally { cache.done(); }
});

Deno.test("chrome-for-testing: the cache root is $HOME-derived, absolute-only, and empty without a usable home", () => {
  // The joiner takes a REQUIRED home, so these branches are asserted directly instead of
  // by mutating the process environment (a parallel-phase hazard). A relative home is
  // REFUSED: `HOME=.` would otherwise make the root follow the process cwd, and this repo
  // has a `.cache/` of its own.
  assertEquals(cacheRootForHome(undefined), "", "no home at all is an empty root, never `/.cache/…` and never `undefined/…`");
  assertEquals(cacheRootForHome(""), "", "an empty home is an empty root");
  assertEquals(cacheRootForHome("."), "", "a relative home is refused, so the root cannot follow the cwd");
  assertEquals(cacheRootForHome("home/paul"), "", "a relative path that merely contains `home` is refused");
  assertEquals(cacheRootForHome("/home/x"), "/home/x/.cache/puppeteer/chrome", "an absolute home joins into the puppeteer cache root");
  assertEquals(chromeForTestingCacheRoot(), cacheRootForHome(Deno.env.get("HOME")), "the default root is the joiner over the live $HOME");
});

Deno.test("chrome-for-testing: the resolved path stays inside the cache root it was given", () => {
  const cache = fakeCache(["linux-150.0.7871.24"]);
  try {
    const resolved = resolveChromeForTesting({ cacheRoot: cache.root });
    assert(resolved !== null, "the fixture build must resolve");
    assert(resolved.startsWith(`${cache.root}/`), `the result must be under the cache root: ${resolved}`);
    assertMatch(resolved, /\/chrome-linux64\/chrome$/, "the puppeteer Linux layout is the only one guessed");
  } finally { cache.done(); }
});

Deno.test("chrome-for-testing: the resolver's own source names no machine, no user and no version", async () => {
  // The point of the bead: the literal path went away. An absence pin over the CODE is
  // what keeps it away. Comments are stripped first (a line starting `//`, `/*`, `/**` or
  // `*`) so the history and the worked examples that teach the rule cannot trip the rule
  // — the convention machine-path-honesty uses — and the strip is proven below not to
  // blind the pin to real code.
  const codeOnly = (src: string): string => src.split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith("//") || t.startsWith("/*") || t.startsWith("*"));
    })
    .join("\n");

  const offences = (code: string): string[] => [
    [code.match(/\/(?:home|root|Users)\/[^"'`\s]*/), "a literal home-directory path is the defect this module exists to remove"],
    [code.match(/linux-\d+\.\d+/), "a version directory may not be named in source — rank what the cache holds"],
    [code.match(/\bpaulkinlan\b|\bkinlan\b/), "no user name in source"],
  ].filter(([m]) => m !== null).map(([m, why]) => `${JSON.stringify(m![0])} — ${why}`);
  // Rule 3 is assembled here too, so THIS file never carries the name it forbids
  // (and so the probe really does exercise the rule — it must produce a string the
  // rule matches, or the assertion below would pass vacuously).
  const userName = ["kin", "lan"].join("");

  const src = await Deno.readTextFile(new URL("../scripts/lib/chrome-for-testing.ts", import.meta.url));
  const code = codeOnly(src);
  assertEquals(offences(code), [], "the resolver must resolve, never name a machine");
  assertMatch(code, /Deno\.env\.get\("HOME"\)/, "the root is assembled from $HOME at call time");

  // TEETH: the same pin over a re-introduced literal must fire — otherwise the strip above
  // is hiding code and this test is decoration. Assembled at runtime so this file's own
  // text never carries a literal home path (the machine-path guard scans test text).
  const home = (rest: string): string => `/home/probe/${rest}`;
  const pinned = [
    `// a comment naming ${home("x")} and linux-140.0.7339.82 is legal prose`,
    `const CHROMIUM = "${home(".cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome")}";`,
    `export const b = CHROMIUM; // worked on by ${userName}`,
  ].join("\n");
  assertEquals(offences(codeOnly(pinned)).length, 3, "a re-introduced machine path, its version pin AND a user name must all be caught");
  assertEquals(offences(codeOnly(pinned.split("\n")[0])), [], "the comment line on its own is legal");
});

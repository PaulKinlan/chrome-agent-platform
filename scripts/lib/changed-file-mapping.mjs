// changed-file-mapping.mjs — why a changed file has no reachable test, and what
// covers it anyway. chrome-agent-platform-nco2.
//
// THE PROBLEM: scripts/select-tests.mjs proves subset coverage through the
// STATIC IMPORT GRAPH. Two file classes have no import edges at all, so the
// picker cannot prove coverage and falls back to the whole suite — measured
// twice in one evening at 218 s and 214 s for two-file harness repairs, against
// the 4-10 s AGENTS.md advertises. Worse, the message said only "no reachable
// test", which reads identically for three different causes.
//
// THE TWO CLASSES, measured at 98cc8c8a:
//
//   1. UNIMPORTED HARNESSES. scripts/a11y-audit.ts, scripts/sidebar-parity.ts and
//      scripts/constrained-width-layout.ts are uncovered; scripts/lib/composer-target.ts
//      and scripts/lib/css-padding.ts are COVERED, because a test imports them.
//      So it is not "any scripts/** change" — it is precisely the files nothing
//      imports. What covers them instead is the tree-walking guards, which
//      enumerate scripts/ at RUNTIME (harnessFiles() does a readDirSync) and so
//      never appear as import edges.
//
//      Why mapping these is not a weakening, measured: NO unit test executes
//      them. For a11y-audit, sidebar-parity and constrained-width-layout, the
//      tests that so much as mention them contain zero Deno.Command/spawnSync/
//      execFileSync. The full suite therefore adds NOTHING for this class over
//      the guards below — running 494 files instead of these is cost without
//      coverage.
//
//   2. VERSION-ONLY BOOKKEEPING JSON. The post-commit hook bumps package.json,
//      package-lock.json and extension/manifest.json on every commit. JSON is
//      not imported, so all three are uncovered at EVERY tree (verified at both
//      98cc8c8a and d0f01545 — the classification is deterministic and
//      base-independent; see the bead for what that corrected).
//
//      Mapping here is narrower on purpose: ONLY a diff confined to version
//      fields is mapped. A package.json that gains a dependency or a script is a
//      real change and keeps failing closed. `versionOnlyJsonChange` decides
//      that by PARSING BOTH SIDES and comparing flattened key paths — never by
//      grepping for lines containing "version", which is the mistake that would
//      hide a nested dependency bump (proven in chrome-agent-platform-mo2f.3: a
//      line filter passes `"version": "1.2.3" -> "9.9.9"` on a dependency as
//      cleanly as on the project's own version).
//
// Everything else stays FAIL CLOSED, and now says which file and which mechanism
// forced it.

/** Tests that enumerate the scripts/ tree at runtime. These are what actually
 *  cover a harness nobody imports, and they have no import edge to it. */
export const HARNESS_TREE_GUARDS = Object.freeze([
  "tests/harness-registry.test.ts",
  "tests/scripts-exit-codes.test.ts",
  "tests/substring-pin-honesty.test.ts",
  "tests/durable-root.test.ts",
  "tests/quiet-window.test.ts",
  "tests/chrome-profile-isolation.test.ts",
  "tests/chrome-profile-location.test.ts",
  "tests/machine-path-honesty.test.ts",
  "tests/harness-debug-port.test.ts",
  "tests/test-partition-guard.test.ts",
  "tests/chrome-test-contract.test.ts",
]);

/** Tests that read the release/bookkeeping files as DATA (by literal path), so
 *  they are the coverage a version bump actually has.
 *
 *  Every entry was checked to CONTAIN the literal path of a file it is claimed
 *  to cover — tests/changed-file-mapping.test.ts asserts exactly that, and it
 *  caught two entries I had added on reputation rather than measurement:
 *  changelog-shipping.test.ts (references no bookkeeping file at all — it reads
 *  .gitignore, build.mjs and the packaging scripts) and build-bootstrap.test.ts
 *  (its only "version" matches are the `dist-versions` directory name). Both are
 *  removed. A guard that does not read the file cannot be its coverage. */
export const BOOKKEEPING_GUARDS = Object.freeze([
  "tests/manifest-permissions.test.ts",
  "tests/package-scripts-exist.test.ts",
  "tests/changelog.test.ts",
  "tests/bump-version-sanitize.test.ts",
  "tests/bundled-tool-packages.test.ts",
]);

/** The three files the post-commit version hook rewrites. */
export const BOOKKEEPING_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "extension/manifest.json",
]);

/** Key paths whose change is "just a version bump". Exact paths, not a token
 *  match: `packages..version` is package-lock's root self-entry (its own
 *  version mirror), and nothing else in the lockfile may move. */
const VERSION_KEY_PATHS = Object.freeze(new Set([
  "version",           // package.json, package-lock.json, manifest.json
  "version_name",      // extension/manifest.json
  "packages..version", // package-lock.json root self-entry
]));

/** Flatten an object to `path -> primitive`. */
function flatten(value, prefix = "", out = {}) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

/**
 * Is the difference between two JSON texts confined to version fields?
 *
 * Returns `false` for anything it cannot prove — unparseable text, a missing
 * side, a changed key set, a changed nested value. FAILS CLOSED by construction:
 * the only `true` is "parsed both sides and every differing key path is a
 * declared version field".
 */
export function versionOnlyJsonChange(beforeText, afterText) {
  if (typeof beforeText !== "string" || typeof afterText !== "string") return false;
  let before, after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return false; // unparseable: never claim it is only a version bump
  }
  const fa = flatten(before);
  const fb = flatten(after);
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)]);
  let differing = 0;
  for (const k of keys) {
    if (fa[k] === fb[k]) continue;
    if (!VERSION_KEY_PATHS.has(k)) return false; // a real change hides here
    differing++;
  }
  return differing > 0; // identical files are not a "version-only change"
}

/** A harness under scripts/ that no test imports (the mechanism-1 shape). */
export function isScriptsHarness(rel) {
  return /^scripts[\\/].+\.(ts|mjs|js)$/.test(rel);
}

export function isBookkeepingFile(rel) {
  return BOOKKEEPING_FILES.includes(rel.replace(/\\/g, "/"));
}

/**
 * Why this uncovered file is uncovered, and what covers it instead.
 *
 * `versionOnly` is supplied by the caller (it needs git to read the base blob),
 * so this function stays pure and testable. When a bookkeeping file's diff is
 * NOT version-only, it is deliberately left unmappable: that is a real change.
 *
 * Returns `{ mechanism, tests }`; `tests` empty means FAIL CLOSED and the
 * mechanism is the reason to print.
 */
export function classifyUncovered(rel, { versionOnly = false } = {}) {
  const path = rel.replace(/\\/g, "/");
  if (isBookkeepingFile(path)) {
    return versionOnly
      ? {
        mechanism: "version-only bookkeeping JSON (the post-commit hook's bump)",
        tests: [...BOOKKEEPING_GUARDS],
      }
      : {
        mechanism:
          "bookkeeping JSON with a NON-version change — a dependency, script or " +
          "permission edit cannot be proved by a subset",
        tests: [],
      };
  }
  if (isScriptsHarness(path)) {
    return {
      mechanism: "harness under scripts/ that no test imports (covered by the tree-walking guards)",
      tests: [...HARNESS_TREE_GUARDS],
    };
  }
  return {
    mechanism: "no reachable test and no declared mapping — genuinely unmappable statically",
    tests: [],
  };
}

/**
 * Map a whole uncovered list. `versionOnlyFor(rel)` is injected so the caller
 * owns git access.
 *
 * `mapped` is `[{ file, mechanism, tests }]`; `unmappable` is the same shape
 * with no tests, and its presence means the caller must run the full suite and
 * print every entry — a full-suite run that says why it ran.
 */
export function mapUncovered(uncovered, versionOnlyFor = () => false) {
  const mapped = [];
  const unmappable = [];
  for (const file of uncovered) {
    const verdict = classifyUncovered(file, { versionOnly: versionOnlyFor(file) });
    (verdict.tests.length ? mapped : unmappable).push({ file, ...verdict });
  }
  return { mapped, unmappable };
}

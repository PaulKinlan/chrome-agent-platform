// changed-file-mapping.mjs — why a changed file has no reachable test, and what
// covers it anyway. chrome-agent-platform-nco2.
//
// THE PROBLEM: scripts/select-tests.mjs proves subset coverage through the
// STATIC IMPORT GRAPH. Two file classes have no import edges at all, so the
// picker cannot prove coverage and falls back to the whole suite. Worse, the
// previous message said only "no reachable test", which read identically for
// three different causes.
//
// THE TWO CLASSES:
//
//   1. UNIMPORTED HARNESSES. scripts/a11y-audit.ts, scripts/sidebar-parity.ts and
//      scripts/constrained-width-layout.ts are uncovered; scripts/lib/composer-target.ts
//      and scripts/lib/css-padding.ts are COVERED, because a test imports them.
//      So it is not "any scripts/** change" — it is precisely the files nothing
//      imports. What covers top-level scripts/*.ts instead is the tree-walking
//      guards, which enumerate scripts/*.ts at RUNTIME (harnessFiles() does a
//      readdirSync for scripts/*.ts) and so never appear as static import edges.
//
//      Why mapping these is not a weakening: NO unit test executes them. The full
//      suite adds nothing for this class over the tree-walking guards.
//      A .mjs helper or anything in a subdirectory (scripts/lib/...) is NOT
//      inspected by those guards, so it fails closed to the full suite.
//
//   2. VERSION-ONLY BOOKKEEPING JSON. The post-commit hook bumps package.json,
//      package-lock.json and extension/manifest.json on every commit. JSON is
//      not imported, so all three are uncovered at every commit.
//
//      Mapping here is narrower on purpose: ONLY a diff confined to version
//      fields is mapped. A package.json that gains a dependency or a script is a
//      real change and keeps failing closed. `versionOnlyJsonChange` decides
//      that by PARSING BOTH SIDES and structurally comparing both sides after
//      stripping the declared version fields — never by grepping for lines
//      containing "version" (which passes nested dependency bumps).
//
// Everything else stays FAIL CLOSED, and now says which file and which mechanism
// forced it.

/** Tests that enumerate the scripts/*.ts tree at runtime. These are what actually
 *  cover a top-level harness nobody imports, and they have no import edge to it. */
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
 *  they are the coverage a version bump actually has. */
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

/**
 * The root fields a version bump is allowed to move, PER FILE.
 *
 * The authority is what the hook ACTUALLY writes (scripts/bump-version.mjs:145-155):
 *   package.json            → root `version`
 *   package-lock.json       → root `version` AND `packages[""].version` (mirror)
 *   extension/manifest.json → root `version` AND `version_name`
 *
 * A path not listed here has NO approved fields, so every difference counts and
 * the predicate fails closed. A nested dependency's `version` is deliberately
 * not approved anywhere — that is a real change.
 */
export const VERSION_FIELDS_BY_FILE = Object.freeze({
  "package.json": Object.freeze(["version"]),
  "package-lock.json": Object.freeze(["version"]),
  "extension/manifest.json": Object.freeze(["version", "version_name"]),
});

/**
 * Strip the approved version fields and return a STRUCTURE-PRESERVING canonical
 * form. Everything else — object vs array, empty containers, key identity — must
 * survive, because the only safe `true` is "nothing outside those fields moved".
 */
function strippedCanonical(value, rel) {
  const path = String(rel ?? "").replace(/\\/g, "/");
  const fields = VERSION_FIELDS_BY_FILE[path] ?? [];
  const clone = structuredClone(value);
  if (clone && typeof clone === "object" && !Array.isArray(clone)) {
    for (const field of fields) delete clone[field];
    if (path === "package-lock.json") {
      const rootEntry = clone.packages && typeof clone.packages === "object" && !Array.isArray(clone.packages)
        ? clone.packages[""]
        : null;
      if (rootEntry && typeof rootEntry === "object" && !Array.isArray(rootEntry)) delete rootEntry.version;
    }
  }
  return canonicalJson(clone);
}

/** Deterministic JSON with object keys sorted, so key ORDER is not a difference
 *  while structure and identity still are. Arrays keep their order (it is
 *  meaningful); objects and arrays stay distinguishable; empty containers are
 *  represented explicitly. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Is the difference between two JSON texts confined to version fields?
 *
 * Returns `false` for anything it cannot prove — unparseable text, a missing
 * side, a changed key set, a changed nested value. FAILS CLOSED by construction:
 * the only `true` is "parsed both sides and every differing key path is a
 * declared version field".
 */
export function versionOnlyJsonChange(beforeText, afterText, rel) {
  if (typeof beforeText !== "string" || typeof afterText !== "string") return false;
  const path = String(rel ?? "").replace(/\\/g, "/");
  if (!VERSION_FIELDS_BY_FILE[path]) return false;
  let before, after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return false; // unparseable: never claim it is only a version bump
  }
  // Everything OUTSIDE this file's approved fields must be structurally identical.
  if (strippedCanonical(before, path) !== strippedCanonical(after, path)) return false;
  // …and at least one approved field must actually have moved: two identical
  // files are not a "version-only CHANGE".
  return canonicalJson(before) !== canonicalJson(after);
}

/** A harness under scripts/ that no test imports. */
export function isScriptsHarness(rel) {
  return /^scripts[\\/].+\.(ts|mjs|js)$/.test(rel.replace(/\\/g, "/"));
}

/**
 * Is this script ENUMERATED by the tree-walking guards?
 * `harnessFiles()` in scripts/lib/harness-registry.ts enumerates
 * `scripts/*.ts` ONLY: top level, `.ts` extension.
 */
export function isGuardEnumeratedScript(rel) {
  return /^scripts[\\/][^\\/]+\.ts$/.test(rel.replace(/\\/g, "/"));
}

/**
 * The selector's OWN machinery. A change here invalidates the selector's
 * authority to narrow anything, so it always runs the full suite — whether or
 * not the import graph happens to reach the file.
 */
export const SELECTOR_INFRASTRUCTURE = Object.freeze([
  "scripts/run-tests.mjs", // the full-suite runner (readdir + two-phase execution)
  "scripts/select-tests.mjs", // the subset picker itself
  "scripts/test-partition.mjs", // decides serial vs parallel for both runners
  "scripts/lib/serial-phase.mjs", // executes the serial phase for both runners
  "scripts/lib/changed-file-mapping.mjs", // this file: the mapping the subset trusts
]);

export function isSelectorInfrastructure(rel) {
  return SELECTOR_INFRASTRUCTURE.includes(rel.replace(/\\/g, "/"));
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
  // The selector's own machinery is never subset-mappable. Checked FIRST so
  // no later branch can bless it, and duplicated at the caller because an
  // import-reachable infrastructure file never arrives here at all.
  if (isSelectorInfrastructure(path)) {
    return {
      mechanism:
        "the test selector's OWN machinery — a subset chosen by the thing under test " +
        "cannot validate it (measured: a broken readdir in run-tests.mjs kills `npm test` " +
        "instantly while test:changed stayed green over a 21-file subset)",
      tests: [],
    };
  }
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
    if (isGuardEnumeratedScript(path)) {
      return {
        mechanism: "top-level scripts/*.ts enumerated by the tree-walking guards (harnessFiles scans scripts/*.ts)",
        tests: [...HARNESS_TREE_GUARDS],
      };
    }
    // NOT guard-enumerated: harnessFiles() scans scripts/*.ts only, so a .mjs
    // helper or a subdirectory file is NOT inspected by those guards.
    // Fails closed to the full suite.
    return {
      mechanism:
        "scripts/ file not enumerated by the tree-walking guards (they scan top-level scripts/*.ts only) " +
        "and with no import edge — fails closed to the full suite",
      tests: [],
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

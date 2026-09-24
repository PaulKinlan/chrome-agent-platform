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

/** The fields a version bump is allowed to move. ROOT ONLY, plus package-lock's
 *  root self-entry (`packages[""].version`, its own version mirror). A nested
 *  dependency's `version` is deliberately NOT here — that is a real change. */
export const VERSION_FIELDS = Object.freeze(["version", "version_name", "release"]);

/**
 * Strip the approved version fields and return a STRUCTURE-PRESERVING canonical
 * form. Everything else — object vs array, empty containers, key identity — must
 * survive, because the only safe `true` is "nothing outside those fields moved".
 *
 * WHY NOT A FLATTENED KEY MAP (the defect this replaces, found by cap-astra's
 * independent review of 39314910): flattening to `path -> primitive` loses two
 * things, and both produced FALSE POSITIVES on real repository files —
 *   • EMPTY CONTAINERS VANISH. Adding `overrides: {}` to package.json, or
 *     `web_accessible_resources: []` to the manifest, changed nothing in the
 *     flattened map, so a genuine structural edit mapped as "version-only".
 *     `{}` → `[]` was likewise invisible.
 *   • KEY PATHS COLLIDE. `dependencies.foo` and a literal top-level key named
 *     `"dependencies.foo"` flatten identically, as do `permissions[0]` and a
 *     key named `"permissions[0]"`. So MOVING a real dependency or permission
 *     out of its container and into a dotted/bracketed top-level key — a
 *     materially different manifest — compared equal.
 * A deep structural comparison after narrowly deleting the approved fields has
 * neither hole, and is simpler than any leaf encoding that tries to escape them.
 */
function strippedCanonical(value) {
  const clone = structuredClone(value);
  if (clone && typeof clone === "object" && !Array.isArray(clone)) {
    // Root release fields, deleted by EXACT key — never by a name match at
    // arbitrary depth (a nested dependency's `version` must still count).
    delete clone.version;
    delete clone.version_name;
    delete clone.release;
    // package-lock's root self-entry mirrors the project's own version.
    const rootEntry = clone.packages && typeof clone.packages === "object" && !Array.isArray(clone.packages)
      ? clone.packages[""]
      : null;
    if (rootEntry && typeof rootEntry === "object" && !Array.isArray(rootEntry)) delete rootEntry.version;
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
export function versionOnlyJsonChange(beforeText, afterText) {
  if (typeof beforeText !== "string" || typeof afterText !== "string") return false;
  let before, after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return false; // unparseable: never claim it is only a version bump
  }
  // Everything OUTSIDE the approved fields must be structurally identical.
  if (strippedCanonical(before) !== strippedCanonical(after)) return false;
  // …and at least one approved field must actually have moved: two identical
  // files are not a "version-only CHANGE".
  return canonicalJson(before) !== canonicalJson(after);
}

/** A harness under scripts/ that no test imports (the mechanism-1 shape). */
export function isScriptsHarness(rel) {
  return /^scripts[\\/].+\.(ts|mjs|js)$/.test(rel);
}

/**
 * Is this script ENUMERATED by the tree-walking guards?
 *
 * R1, from cap-astra's independent review of 39314910: the first version mapped
 * EVERY import-unreachable file under `scripts/` to the eleven generic guards,
 * on the theory that those guards scan the tree. They do — but
 * `harnessFiles()` in scripts/lib/harness-registry.ts enumerates
 * `scripts/*.ts` ONLY: top level, `.ts` extension. So a `.mjs` helper, or
 * anything in a subdirectory, was being mapped to guards that never look at it.
 *
 * The measured counterexample: `tests/acp-service-harness-default.test.ts`
 * builds `join(ROOT, "scripts", "acp-service.mjs")` and SPAWNS it with
 * `install --dry-run`. Restoring the old unsupported `harness || "pi"` default
 * took that file from 5/0 to 1 passed / 4 failed — a real executed regression —
 * while `test:changed` returned exit 0 over 28 files WITHOUT selecting it.
 * A mapping that drops a test the full suite would have run is a weakening,
 * which is exactly what this helper exists to prevent.
 */
export function isGuardEnumeratedScript(rel) {
  return /^scripts[\\/][^\\/]+\.ts$/.test(rel.replace(/\\/g, "/"));
}

/**
 * Tests that name this script LITERALLY — the coverage a static import graph
 * cannot see. `testFiles` is `[{ rel, text }]`, injected so this stays pure.
 *
 * A computed path (`join(ROOT, "scripts", "acp-service.mjs")`) still contains
 * the basename as a string literal, so matching the basename finds it. The
 * basename is matched rather than the full path because that is how these tests
 * actually spell it.
 */
export function referencingTests(rel, testFiles = []) {
  const path = rel.replace(/\\/g, "/");
  const base = path.split("/").pop() ?? path;
  if (!base) return [];
  const out = [];
  for (const entry of testFiles) {
    const text = entry?.text ?? "";
    if (text.includes(path) || text.includes(`"${base}"`) || text.includes(`'${base}'`)) {
      out.push(entry.rel);
    }
  }
  return out.sort();
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
export function classifyUncovered(rel, { versionOnly = false, testFiles = [] } = {}) {
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
    // Any test that NAMES this script literally is its real coverage — a
    // spawned dry-run has no import edge but is the strongest check it has.
    const named = referencingTests(path, testFiles);
    if (isGuardEnumeratedScript(path)) {
      return {
        mechanism: named.length
          ? `top-level scripts/*.ts enumerated by the tree-walking guards, plus ${named.length} test(s) naming it directly`
          : "top-level scripts/*.ts enumerated by the tree-walking guards (harnessFiles scans scripts/*.ts)",
        tests: [...new Set([...HARNESS_TREE_GUARDS, ...named])],
      };
    }
    // NOT guard-enumerated: harnessFiles() scans scripts/*.ts only, so a .mjs
    // helper or a subdirectory file is NOT inspected by those guards. Map it
    // only to tests that genuinely name it; with none, FAIL CLOSED rather than
    // claim coverage that does not exist.
    return named.length
      ? {
        mechanism: `scripts/ file the tree-walking guards do NOT enumerate (they scan scripts/*.ts), covered by ${named.length} test(s) naming it directly`,
        tests: named,
      }
      : {
        mechanism:
          "scripts/ file with no importer, not enumerated by the tree-walking guards " +
          "(harnessFiles scans scripts/*.ts), and no test names it — nothing proves it covered",
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
export function mapUncovered(uncovered, versionOnlyFor = () => false, testFiles = []) {
  const mapped = [];
  const unmappable = [];
  for (const file of uncovered) {
    const verdict = classifyUncovered(file, { versionOnly: versionOnlyFor(file), testFiles });
    (verdict.tests.length ? mapped : unmappable).push({ file, ...verdict });
  }
  return { mapped, unmappable };
}

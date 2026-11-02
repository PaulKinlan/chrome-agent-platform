// changed-file-mapping.mjs — why a changed file has no reachable test, and what
// covers it anyway. chrome-agent-platform-nco2.
//
// THE PROBLEM: scripts/select-tests.mjs proves subset coverage through the
// STATIC IMPORT GRAPH. Certain file classes have no static import edges, so the
// picker cannot prove coverage through imports alone and would otherwise fall
// back to the whole suite. This module classifies those classes and maps them
// to the guards that actually cover them.
//
// THE CLASSES:
//
//   1. UNIMPORTED HARNESSES. scripts/a11y-audit.ts and scripts/sidebar-parity.ts
//      are uncovered; scripts/kat-constrained-width-layout.ts (via tests/harness-marks.test.ts),
//      scripts/lib/composer-target.ts and scripts/lib/css-padding.ts are COVERED,
//      because a test imports them.
//      What covers top-level scripts/*.ts instead is the tree-walking
//      guards, which enumerate scripts/*.ts at RUNTIME (harnessFiles() does a
//      readdirSync for scripts/*.ts) and so never appear as static import edges.
//      Why mapping these is not a weakening: NO unit test executes them. The full
//      suite adds nothing for this class over the tree-walking guards.
//
//   2. TWO EXPORT ENTRY HTML DOCUMENTS (3p3e.12). These have no import graph
//      edge, but tests/thread-export-entry-html.test.ts reads their actual
//      button/label/initial-state and the loaded script's exact route wiring.
//      The Export JS entry scripts DO have import/URL edges; selector-level
//      tests pin their real guard selection instead of declaring dead mappings.
//
//   3. UNIMPORTED FIXTURES (tests/fixtures/**, chrome-agent-platform-oeqvx).
//      These files have no static import edge. When test files mention their path
//      (or specific basename), referrersFor() resolves them to their referring
//      test suites. Limitation: matching uses literal path/substring or specific
//      basename (>=10 chars), so globbing consumers or helper-mediated dynamic
//      paths are not selected (unreferenced fixtures fail closed).
//
//   4. TEXT-REFERENCED SCRIPTS (scripts/**, chrome-agent-platform-oeqvx).
//      Scripts referenced by tests via text/content mentions (common causes:
//      subprocess invocation, join(ROOT, ...), or raw file reads) rather than
//      static or URL-instrumented imports (e.g. scripts/check-changelog.mjs
//      referenced by tests/changelog.test.ts). When test files reference them,
//      referrersFor() maps them to referring tests (and tree-walking guards for
//      enumerated harnesses). Unreferenced scripts without tree guards fail closed.
//
//   5. BUNDLED WASM MANIFESTS, SBOMS, AND LICENSES (extension/wasm/{manifests,sbom,licenses}/**,
//      chrome-agent-platform-3aq3v).
//      These files have no static JS import edge. They are inspected at runtime by
//      Wasm tree-walking guards (tests/bundled-tool-packages.test.ts,
//      tests/wasm-manifest-assets.test.ts, tests/wasm-package-authority-static.test.ts,
//      tests/wasm-catalogue-status-truth.test.ts) which validate all manifests,
//      SBOM identities, checksums, and license notices, plus any specific test
//      referencing the path via referrersFor().
//
// Everything else stays FAIL CLOSED, and now says which file and which mechanism
// forced it.

/** Tests that enumerate the scripts/*.ts tree at runtime. These are what actually
 *  cover a top-level harness nobody imports, and they have no import edge to it. */
export const HARNESS_TREE_GUARDS = Object.freeze([
  "tests/harness-registry.test.ts",
  "tests/lifeline-reap-rule.test.ts",
  "tests/scripts-exit-codes.test.ts",
  "tests/substring-pin-honesty.test.ts",
  "tests/durable-root.test.ts",
  "tests/quiet-window-static.test.ts",
  "tests/chrome-profile-isolation.test.ts",
  "tests/chrome-profile-static.test.ts",
  "tests/machine-path-honesty.test.ts",
  "tests/harness-debug-port.test.ts",
  "tests/test-partition-guard.test.ts",
  "tests/chrome-test-contract.test.ts",
]);

/** Tests that inspect and validate the extension/wasm/manifests/ directory. */
export const WASM_MANIFEST_GUARDS = Object.freeze([
  "tests/bundled-tool-packages.test.ts",
  "tests/wasm-manifest-assets.test.ts",
  "tests/wasm-package-authority-static.test.ts",
  "tests/wasm-catalogue-status-truth.test.ts",
]);

/** Tests that inspect and validate the extension/wasm/sbom/ directory. */
export const WASM_SBOM_GUARDS = Object.freeze([
  "tests/wasm-package-authority-static.test.ts",
  "tests/bundled-tool-packages.test.ts",
]);

/** Tests that inspect and validate the extension/wasm/licenses/ directory. */
export const WASM_LICENSE_GUARDS = Object.freeze([
  "tests/bundled-tool-packages.test.ts",
]);

/** Exact documents with an executable static DOM-entry + script-wiring guard.
 * Never match a directory, wildcard, or sibling HTML page. */
export const HTML_EXPORT_ENTRY_GUARDS = Object.freeze({
  "extension/ntp/ntp.html": Object.freeze(["tests/thread-export-entry-html.test.ts"]),
  "extension/artifact/artifact.html": Object.freeze(["tests/thread-export-entry-html.test.ts"]),
});

/**
 * The three files the post-commit version hook rewrites.
 *
 * chrome-agent-platform-lezl0: these are still the class this module FAILS CLOSED, and that is the
 * point — `classifyUncovered` is the floor, not the selector. A dependency delta is certified (or
 * named un-certifiable) from its BYTES by scripts/lib/lockfile-delta.mjs before this mapping is
 * consulted; anything the classifier cannot name arrives here and lands on this refusal, so the
 * fail-closed direction is preserved for every shape nobody has opened yet.
 */
export const BOOKKEEPING_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "extension/manifest.json",
]);

/** A harness under scripts/ that no test imports. */
export function isScriptsHarness(rel) {
  return /^scripts[\\/].+\.(ts|mjs|js)$/.test(rel.replace(/\\/g, "/"));
}

/** A fixture under tests/fixtures/ that no test imports statically. */
export function isTestsFixture(rel) {
  return /^tests[\\/]fixtures[\\/].+/.test(rel.replace(/\\/g, "/"));
}

/** A bundled Wasm package manifest under extension/wasm/manifests/. */
export function isWasmManifest(rel) {
  return /^extension[\\/]wasm[\\/]manifests[\\/].+\.manifest\.json$/.test(rel.replace(/\\/g, "/"));
}

/** An SBOM document under extension/wasm/sbom/. */
export function isWasmSbom(rel) {
  return /^extension[\\/]wasm[\\/]sbom[\\/].+\.(cdx|spdx)\.json$/.test(rel.replace(/\\/g, "/"));
}

/** A license notice text file under extension/wasm/licenses/. */
export function isWasmLicense(rel) {
  return /^extension[\\/]wasm[\\/]licenses[\\/].+\.txt$/.test(rel.replace(/\\/g, "/"));
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
  "scripts/lib/parallel-plan.mjs", // plans parallel execution and failure/refusal handling
  "scripts/lib/environmental-verdict.mjs", // canonical environmental refusal definitions and exit code combination
  "scripts/lib/changed-file-mapping.mjs", // this file: the mapping the subset trusts
  // chrome-agent-platform-lezl0: the Class-1 lockfile classifier decides WHICH suites certify a
  // dependency delta, i.e. it is part of the machinery a subset's authority rests on, so editing it
  // must fail closed to the full suite exactly like the selector itself.
  "scripts/lib/lockfile-delta.mjs",
  // chrome-agent-platform-0eq00: the gate's build decision and its coverage ledger. Both decide what
  // a green record MEANS, so a change to either must fail closed to the full suite rather than be
  // validated by a subset they themselves chose.
  "scripts/build-if-needed.mjs", // decides whether the FAST gate builds at all
  "scripts/gate-full.mjs", // verifies the exact-tip build before both FULL gate tiers
  "scripts/lib/gate-manifest.mjs", // the coverage ledger every gate record carries
  "scripts/lib/content-exemptions.mjs", // shared policy for which changed files the selector/ledger skip
  "tests/coverage-contract.json", // fleet's independent placement policy cannot subset-certify itself
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
 * Returns `{ mechanism, tests }`; `tests` empty means FAIL CLOSED and the
 * mechanism is the reason to print.
 */
export function classifyUncovered(rel, { referrers = [] } = {}) {
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
  if (Object.hasOwn(HTML_EXPORT_ENTRY_GUARDS, path)) {
    return {
      mechanism: "exact HTML Export entry read and wired by the focused DOM-entry contract test",
      tests: [...HTML_EXPORT_ENTRY_GUARDS[path]],
    };
  }
  if (isBookkeepingFile(path)) {
    return {
      mechanism: "release/version JSON belongs to the merger; a lane change here cannot be subset-certified",
      tests: [],
    };
  }
  if (isTestsFixture(path)) {
    if (referrers.length) {
      return {
        mechanism:
          "tests/fixtures/ file named by tests (no static import edge; " +
          "selects tests that mention the path; globbing consumers not selected)",
        tests: [...referrers],
      };
    }
    return {
      mechanism:
        "tests/fixtures/ file with no static import edge and no referencing test — " +
        "genuinely unmappable statically",
      tests: [],
    };
  }
  if (isWasmManifest(path)) {
    const tests = [...new Set([...referrers, ...WASM_MANIFEST_GUARDS])];
    return {
      mechanism:
        "extension/wasm/manifests/ manifest validated by bundled-tool-packages, " +
        "wasm-manifest-assets, and authority static guards (plus referring tests)",
      tests,
    };
  }
  if (isWasmSbom(path)) {
    const tests = [...new Set([...referrers, ...WASM_SBOM_GUARDS])];
    return {
      mechanism:
        "extension/wasm/sbom/ CycloneDX/SPDX SBOM validated by authority static " +
        "and bundled-tool-packages guards (plus referring tests)",
      tests,
    };
  }
  if (isWasmLicense(path)) {
    const tests = [...new Set([...referrers, ...WASM_LICENSE_GUARDS])];
    return {
      mechanism:
        "extension/wasm/licenses/ license notice validated by bundled-tool-packages " +
        "guard (plus referring tests)",
      tests,
    };
  }
  if (isScriptsHarness(path)) {
    if (referrers.length) {
      const tests = isGuardEnumeratedScript(path)
        ? [...new Set([...referrers, ...HARNESS_TREE_GUARDS])]
        : [...referrers];
      return {
        mechanism:
          "scripts/ file named by tests (content reference with no static import edge; " +
          "selects tests that mention the path; globbing consumers not selected)",
        tests,
      };
    }
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
 * Map a whole uncovered list. The caller supplies git access and the CURRENT
 * worktree's declared-test and mapped-source existence checks. All are required:
 * assuming a guard or an exact mapped HTML entry exists can silently bless core-only coverage.
 *
 * `mapped` is `[{ file, mechanism, tests }]`; `unmappable` is the same shape
 * with no tests, and its presence means the caller must run the full suite and
 * print every entry — a full-suite run that says why it ran.
 */
export function mapUncovered(
  uncovered,
  declaredTestExists,
  declaredSourceExists,
  referrersFor = () => [],
) {
  if (typeof declaredTestExists !== "function" || typeof declaredSourceExists !== "function") {
    throw new Error("mapUncovered: declared guard and source existence predicates are required");
  }
  const mapped = [];
  const unmappable = [];
  for (const file of uncovered) {
    const referrers = typeof referrersFor === "function" ? referrersFor(file) : [];
    const verdict = classifyUncovered(file, { referrers });
    const missing = verdict.tests.filter((test) => !declaredTestExists(test));
    if (missing.length) {
      unmappable.push({
        file,
        mechanism: `${verdict.mechanism}; ${file} declared guard missing or not a file: ${missing.join(", ")}`,
        tests: [],
      });
      continue;
    }
    if (Object.hasOwn(HTML_EXPORT_ENTRY_GUARDS, file) && !declaredSourceExists(file)) {
      unmappable.push({
        file,
        mechanism: `${verdict.mechanism}; deleted declared HTML entry ${file} is missing or not a file; ${verdict.tests.join(", ")} cannot certify its absence`,
        tests: [],
      });
      continue;
    }
    (verdict.tests.length ? mapped : unmappable).push({ file, ...verdict });
  }
  return { mapped, unmappable };
}

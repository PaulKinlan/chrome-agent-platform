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

/** chrome-agent-platform-853x8: the default-locale catalogue's policing suite. i18n-foundation
 * validates _locales/en/messages.json (parse, catalogue shape, manifest.default_locale, and the
 * byte-identical embedded-fallback drift guard) but reaches it by a URL path read, which the
 * import graph cannot count — the classification is the deliberate binding, exactly like the
 * wasm data files below (en is the only locale in the tree). */
export const LOCALE_CATALOGUE_GUARDS = Object.freeze([
  "tests/i18n-foundation.test.ts",
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

/** Files whose coverage is a DEDICATED guard suite that no import edge can select, by
 *  exact path.
 *
 *  WHY THIS TABLE EXISTS (chrome-agent-platform-h346c): five landed deltas in two days
 *  edited a file whose dedicated guard was NOT in the selection, and the plan still
 *  reported `kind: "subset"` — a certificate for a tree the selection never covered.
 *  lrhyl/khwi9/cac6c on extension/background/service-worker.js (a P1 reply-before-trust
 *  dispatcher hole reached main), ibdr4 on extension/lib/script-host.js, and the
 *  qjoji+5b9mp landing whose manifest was missing sandbox-egress-confinement while the
 *  union was certified green over a red main. Every one of those files was
 *  import-REACHABLE (so `classifyUncovered` never looked at it) — which is exactly why
 *  the guard tables that only feed the uncovered path cannot close this hole. The rule
 *  this table serves is applied to EVERY changed file, covered or not.
 *
 *  TWO PROPERTIES ARE LOAD-BEARING, both learned from the incidents:
 *  - It is keyed by FILE PATH only. Never a line number (khwi9 moved the policed
 *    listener from 13393 to 13407 and any line-keyed entry rotted instantly — cac6c).
 *  - The map is by OWNERSHIP, not by filename: service-worker.js owns
 *    onmessage-sender-guard.test.ts, which shares no basename with it, so a naming
 *    convention would never have found it.
 *
 *  An entry here is a claim that the suite POLICES the file, not merely that it imports
 *  it. Adding one costs that suite's runtime to every delta touching the file, so it is
 *  a deliberate list, not a generated one. */
export const DEDICATED_FILE_GUARDS = Object.freeze({
  // j5xbi: the refusal module (when a starved box may refuse a browser harness) is exercised by the
  // legs in serial-phase-resilience.test.ts, which drive it as DATA — there is no import edge from the
  // module to the suite's own subject, so without this entry the file maps to nothing and the gate
  // reports it as an unmapped coverage gap on every landing that touches it (measured twice).
  "scripts/lib/browser-harness-refusal.mjs": Object.freeze([
    "tests/serial-phase-resilience.test.ts",
  ]),
  // 2syam: the site-delegation journey runs in a SPAWNED harness, so nothing has an import edge to it —
  // the wrapper test names it as a subprocess argument and the gate reported it as an unmapped coverage
  // gap on the delta that wired it. Three suites police it: the wrapper that spawns and asserts it, the
  // retry guard that reads its source (zq76k), and the teardown census that lists it as a spawned
  // real-browser harness. Each is cheap, and the alternative is a landing over a harness nobody ran.
  "scripts/kat-site-delegation-attachments.ts": Object.freeze([
    "tests/site-agent-delegation-attachments.test.ts",
    "tests/transient-context-retry.test.ts",
    "tests/real-browser-teardown.test.ts",
  ]),
  // yqhb2: the write-visibility primitive is driven as DATA by the guard that enforces its rule (no
  // catch may swallow a write, and an unaccounted attempt is named). No import edge exists from the
  // module to the sweep that scans for its use, so it is declared here for the same reason as above.
  "scripts/lib/best-effort-write.mjs": Object.freeze([
    "tests/best-effort-write-guard.test.ts",
  ]),
  "extension/background/service-worker.js": Object.freeze([
    // cac6c: the AST census of EVERY runtime.onMessage listener in extension/. It walks
    // the tree with fs.readdirSync, so it has no static import edge from the file it
    // polices, and three consecutive sw.js deltas never selected it.
    "tests/onmessage-sender-guard.test.ts",
    // 4iyck/67xsg: this suite READS service-worker.js as DATA (Deno.readTextFile + body
    // extraction) to drive the cap:fetch route through its refusal legs. It is selected today
    // only because the test file happens to contain the path as a literal — an incidental text
    // match, not an ownership claim. A read that moves (dist, a helper, a computed path) drops
    // it out of the selection SILENTLY, and the SW's credential-echo and redirect-refusal
    // contract then has no selected guard at all.
    "tests/cap-fetch-deny.test.ts",
    // 4iyck/c60vo: the dispatcher's denial paths are driven by an extracted harness in this
    // suite (it reads service-worker.js as text too). A refusal that stops emitting a
    // securityEvent, or a dead branch that never runs, is visible only here.
    "tests/settings-session.test.ts",
  ]),
  "scripts/lib/serial-runner.mjs": Object.freeze([
    // lzccc: the readiness/grace runner is a CLI that spawnSync-EXECUTES at import time
    // (it spawns `deno test` from its own top-level statements), so no suite can import it
    // — importing would run a test file. Its guard is therefore invisible to the static
    // reverse map, and the gate reported it as an unmapped changed file on the lzccc delta.
    "tests/serial-phase-resilience.test.ts",
    "tests/serial-phase-timeout.test.ts",
  ]),
  "extension/lib/script-host.js": Object.freeze([
    // The egress-confinement journey imports script-host dynamically INSIDE a test body,
    // so the static reverse map cannot see it either (a detection gap filed as ff920).
    "tests/sandbox-egress-confinement.test.ts",
  ]),
  // 4iyck/v8n9b: the trusted-SW sender predicate is DUPLICATED into the content script (a classic
  // script cannot import ES modules) and the canonical copy moved out of pure.js into pure-trust.js
  // (gzkmx). The fence that compares the two bodies has no import edge to either in the direction it
  // polices, and nothing selected it for a change to EITHER side of the pair — so the port could
  // drift from the predicate it claims to mirror with every gate green. Both ends are registry keys:
  // a change to the port and a change to the canonical predicate must both carry the fence.
  "extension/content/content-script.js": Object.freeze([
    "tests/trusted-sender-port-fence.test.ts",
  ]),
  "extension/lib/pure-trust.js": Object.freeze([
    "tests/trusted-sender-port-fence.test.ts",
  ]),
  // wwgnm: two user-facing surfaces whose ONLY selected suite reaches them by an incidental
  // instrument, which is the 4iyck/67xsg argument verbatim — the edge exists today because a path
  // literal happens to be in the file, so it disappears SILENTLY the moment that read moves into a
  // helper, a computed path or a fixture (exactly how cap-fetch-deny fell out of the SW's selection).
  // Both files are otherwise reachable, so these entries are about the DRIFT, not today's coverage.
  "extension/options/settings-view.js": Object.freeze([
    // The only suite that touches the settings view at all: it imports the module by a
    // DYNAMIC specifier inside a test body (`await import("../extension/options/settings-view.js")`),
    // which the graph counts only because the string is right there. A rewrite to a helper drops the
    // edge and this surface then has no selected guard at all. Basename-legal (settings-view is not a
    // substring of settings-client-view), so the table's anti-coincidence rule allows the claim.
    "tests/settings-client-view.test.ts",
  ]),
  // chrome-agent-platform-wwgnm r3 (1jkwf): the round-2 entry here was FALSE —
  // tests/directory-client-view.test.ts reads the module as TEXT (readTextFile + substring
  // asserts) and no suite in the tree imports it; the only runtime edge is ntp.js's STATIC
  // import, which the import graph already counts. A binding whose suite cannot red on a
  // regression is worse than none, and the runtime-verified carve-out that admitted it is
  // gone with it. The file is DECLARED below with the transitive mechanism.
  // 4iyck/28hwd+qnci3: runbooks are PASSIVE CONTENT to the selector (isPassiveContentFile matches
  // .md), so before this entry a landing-recipe change selected the always-on core and nothing that
  // read it: a runbook could prescribe an unbounded raw `bd dolt push`, or lose the failed-helper
  // fallback, with every gate green. The guard is one small suite shared by the three documents
  // because they are one claim (AGENTS.md states the routing rule; the two runbooks are the
  // instruction set that must not contradict it).
  "docs/MERGER-PLAYBOOK.md": Object.freeze([
    "tests/runbook-sync-commands.test.ts",
  ]),
  ".agents/skills/beads-flow/SKILL.md": Object.freeze([
    "tests/runbook-sync-commands.test.ts",
  ]),
  "AGENTS.md": Object.freeze([
    "tests/runbook-sync-commands.test.ts",
  ]),
});

/** Every dedicated guard the changed file owns — the ONE answer to "does this file own a
 *  guard, and which?". Both tables are consulted so callers never have to know that the
 *  HTML entries live in their own table (h346c: a rule that only read one of them would
 *  have re-created the gap it exists to close). */
/**
 * chrome-agent-platform-wwgnm round 2 (coord acceptance 3): the files the changed-file
 * map deliberately does NOT bind, each with a FILE-based reason — what actually polices
 * it and by which mechanism. This is the loud answer to "why is this file unmapped";
 * an import-graph rationale ("something reaches it") is not a reason and does not
 * belong here. planSelection refuses a product file that has neither an entry in
 * DEDICATED_FILE_GUARDS nor a declaration here, naming it — silence is the defect
 * the review found.
 *
 * chrome-agent-platform-wwgnm r3 (1mcws): a declaration must be TRUE, not merely
 * plausible — tests/changed-file-mapping.test.ts verifies each reason's claimed edge in
 * SOURCE (a named suite that mentions the file, a barrel that really re-exports it, a
 * MAPPED claim that has its entry, or a named intermediate module that imports the file
 * while a named suite polices THAT module). Existence-only validation was the defect:
 * a false declaration passed the pin green.
 */
export const DECLARED_NO_GUARD = Object.freeze({
  // wwgnm r2, measured: the suite imports the module with a runtime specifier
  // (`await import("../extension/ntp/ntp.js?exec=...")`) — it EXECUTES ntp.js per boot.
  // ntp-boot-staging polices ntp-boot-scheduler.js and ntp-sidebar-collapsible polices
  // pure.js re-exports; neither changes when ntp.js does, so binding them here would
  // cost their runtime for no coverage gain.
  "extension/ntp/ntp.js":
    "runtime-exercised by tests/ntp-agent-route-execution.test.ts (dynamic import, per-boot execution)",
  "extension/lib/pure-hash.js":
    "re-exported through the pure.js barrel (single-source invariant, tests/single-source-helpers.test.ts ALWAYS_ON); its functions are pinned via the barrel in tests/pure.test.ts",
  "extension/lib/pure-redact.js":
    "re-exported through the pure.js barrel; redaction behaviour pinned via the barrel in tests/secret-redaction.test.ts and tests/pure.test.ts",
  "extension/lib/pure-schema.js":
    "re-exported through the pure.js barrel; schema behaviour pinned via the barrel in tests/pure.test.ts",
  "extension/lib/pure-tabs.js":
    "re-exported through the pure.js barrel; pinned via the barrel in tests/pure.test.ts",
  "extension/lib/pure-text.js":
    "re-exported through the pure.js barrel; pinned via the barrel in tests/pure.test.ts",
  // wwgnm r3 (1jkwf): NO suite imports this module (every reference in tests/ is
  // readTextFile text inspection); the runtime edge is the STATIC import from ntp.js
  // (renderDirectoryContent), which the import graph already counts — declared, not bound.
  "extension/directory/directory.js":
    "statically imported by extension/ntp/ntp.js (renderDirectoryContent), which tests/ntp-agent-route-execution.test.ts executes per boot — the suite polices ntp.js, ntp.js imports this file; every direct reference in tests/ is text inspection",
  "extension/shared/components-core.js":
    "statically imported and rendered by tests/a11y-structure.test.ts and tests/activity-liveness.test.ts (measured reverse closure)",
  "extension/shared/components-hub.js":
    "statically imported and rendered by tests/a11y-structure.test.ts and tests/activity-liveness.test.ts (measured reverse closure)",
  "extension/lib/table-extractor.js":
    "statically imported by tests/extract-tables-3p3e8.test.ts, which drives the extractor directly",
  "extension/lib/user-wasm-host.js":
    "statically imported by tests/user-wasm-execution.test.ts, which drives the host directly",
  "extension/lib/thread-export-redact.js":
    "statically imported by tests/thread-export-html.test.ts, which drives the redaction directly",
  "extension/lib/schedule-preview.js":
    "exercised by tests/agent-alarms.test.ts (the schedule-preview rendering legs; the bead's extension/options path was a typo — this module never existed there)",
  "scripts/check-reachability.mjs":
    "statically imported by tests/main-module-check-guard.test.ts (ALWAYS_ON core), which executes the checker",
  "extension/shared/schedule-parser.js":
    "statically imported by tests/schedule-parser.test.ts, which drives the parser directly",
});
export function guardsForChangedFile(rel, tables = { dedicated: DEDICATED_FILE_GUARDS, html: HTML_EXPORT_ENTRY_GUARDS }) {
  const path = String(rel ?? "").replace(/\\/g, "/");
  const out = [];
  if (Object.hasOwn(tables.dedicated ?? {}, path)) out.push(...tables.dedicated[path]);
  if (Object.hasOwn(tables.html ?? {}, path)) out.push(...tables.html[path]);
  return [...new Set(out)];
}

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

/**
 * Repo metadata: a change here that no suite in this repo can execute.
 *
 * chrome-agent-platform-fhh50. These paths are COLLECTED by the selector and
 * reported as `not-applicable` with a reason, never filtered out of the changed
 * set. Dropping them made a beads-sync or .gitignore change indistinguishable
 * from "nothing changed" in the gate log, which is the same silent-accounting
 * shape as an unmapped changed file: the ledger said nothing, and a reader
 * could not tell that from "coverage proved".
 */
export function isRepoMetadata(rel) {
  const path = rel.replace(/\\/g, "/");
  return /^\.beads\//.test(path) || /^\.codex\//.test(path) || /^\.gitignore$/.test(path) ||
    /^\.gitattributes$/.test(path) || /^\.gitmodules$/.test(path);
}

/**
 * Agent-skill tooling under `.agents/` (the impeccable design launchers, the
 * beads-flow helpers). It ships with no code the extension bundle contains, and
 * nothing in `tests/` imports it statically — but tests DO execute some of it by
 * path, so a changed file here maps to the tests that name it and fails closed
 * when none does (chrome-agent-platform-fhh50).
 */
export function isAgentTooling(rel) {
  return /^\.agents[\\/]/.test(rel.replace(/\\/g, "/"));
}

/** A harness under scripts/ that no test imports. Includes .sh: git hooks and
 * shell wrappers (scripts/git-hooks/beads-push.sh, scripts/bd-sync-bound.sh) are
 * spawned by path exactly like the .ts/.mjs harnesses, and before maqob they
 * fell through to the generic unmappable default even when a test literally
 * referenced them — making every shell-script change fast-uncertifiable. */
export function isScriptsHarness(rel) {
  return /^scripts[\\/].+\.(ts|mjs|js|sh)$/.test(rel.replace(/\\/g, "/"));
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
  if (/^extension[\\/]_locales[\\/][^\\/]+[\\/]messages\.json$/.test(path)) {
    return {
      mechanism:
        "locale catalogue validated by tests/i18n-foundation.test.ts (parse, catalogue " +
        "shape, manifest.default_locale, byte-identical embedded-fallback drift guard) " +
        "via a URL path read the import graph cannot count (chrome-agent-platform-853x8)",
      tests: [...new Set([...referrers, ...LOCALE_CATALOGUE_GUARDS])],
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
  if (isAgentTooling(path)) {
    if (referrers.length) {
      return {
        mechanism:
          "agent-skill tooling under .agents/ named by tests (executed by path, so it has no static " +
          "import edge; selects the suites that name it)",
        tests: [...referrers],
      };
    }
    return {
      mechanism:
        "agent-skill tooling under .agents/ that no test names — no suite in this repo executes it, so a " +
        "selection cannot certify it; fails closed to the full suite",
      tests: [],
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
    // helper, a subdirectory file, or a .sh hook/wrapper is NOT inspected by
    // those guards. Fails closed to the full suite.
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

// tests/changed-file-mapping.test.ts — chrome-agent-platform-nco2.
//
// THE PROPERTY: `test:changed` may only map an import-unreachable changed file
// to the guards that actually cover it, and must keep failing closed for
// everything else — while NAMING which file and which mechanism forced a full
// suite.
//
// The dangerous direction is the mapping, not the fallback: a mapping that is
// too generous turns a real change (a new dependency, a weakened CSP, an added
// permission) into a 22-file subset that cannot see it. Every negative below is
// therefore a real edit shape, not a synthetic one.
// @ts-nocheck

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  BOOKKEEPING_FILES,
  classifyUncovered,
  HARNESS_TREE_GUARDS,
  HTML_EXPORT_ENTRY_GUARDS,
  isGuardEnumeratedScript,
  isScriptsHarness,
  isSelectorInfrastructure,
  isTestsFixture,
  isWasmLicense,
  isWasmManifest,
  isWasmSbom,
  mapUncovered,
  SELECTOR_INFRASTRUCTURE,
  WASM_LICENSE_GUARDS,
  WASM_MANIFEST_GUARDS,
  WASM_SBOM_GUARDS,
} from "../scripts/lib/changed-file-mapping.mjs";
import {
  buildReverseGraph,
  changedWithoutCoverage,
  clearReferrersCache,
  mergeBaseOf,
  referrersFor,
  selectTestFiles,
  testFilesWithContent,
} from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const declaredGuardExists = (rel: string) => {
  try { return Deno.statSync(`${ROOT}${rel}`).isFile; } catch { return false; }
};

Deno.test("nco2: classification names the mechanism, and only maps what it can justify", () => {
  const harness = classifyUncovered("scripts/a11y-audit.ts");
  assert(harness.tests.length > 0, "an unimported harness maps to its tree-walking guards");
  assert(/enumerated by the tree-walking guards/.test(harness.mechanism), harness.mechanism);

  const bump = classifyUncovered("package.json");
  assertEquals(bump.tests, [], "bookkeeping JSON must fail closed on a lane");
  assert(/belongs to the merger/.test(bump.mechanism), bump.mechanism);

  const unknown = classifyUncovered("some/unknown-thing.json");
  assertEquals(unknown.tests, [], "an unrecognised file still fails closed");
  assert(/genuinely unmappable/.test(unknown.mechanism), unknown.mechanism);
});

Deno.test("x0vas: every bookkeeping file fails closed BY NAME — no version-only mapping survives", () => {
  assertEquals(BOOKKEEPING_FILES.length, 3);
  for (const rel of BOOKKEEPING_FILES) {
    const verdict = classifyUncovered(rel);
    assertEquals(verdict.tests, [], `${rel} must fail closed`);
    assert(
      /belongs to the merger/.test(verdict.mechanism),
      `${rel} mechanism must name the merger: ${verdict.mechanism}`,
    );
  }
  // A FUNCTIONAL edit (the permission change o65r shipped, a dependency bump, a
  // weakened CSP) gets the SAME fail-closed verdict as a version edit: the class
  // that used to tell them apart is gone, and the mechanism no longer pretends
  // the selector could certify any of them.
  const functional = classifyUncovered("extension/manifest.json", { referrers: [] });
  assertEquals(functional.tests, []);
  assert(/belongs to the merger/.test(functional.mechanism), functional.mechanism);
});

Deno.test("nco2: unenumerated scripts under scripts/ fail closed", () => {
  // Top-level .ts is enumerated by harnessFiles()
  assertEquals(isGuardEnumeratedScript("scripts/a11y-audit.ts"), true);
  // .mjs or subdirectories are NOT enumerated by harnessFiles()
  assertEquals(isGuardEnumeratedScript("scripts/acp-service.mjs"), false);
  assertEquals(isGuardEnumeratedScript("scripts/lib/composer-target.ts"), false);

  const mjs = classifyUncovered("scripts/acp-service.mjs");
  assertEquals(mjs.tests, [], "unenumerated .mjs script must fail closed");
  assert(/not enumerated/.test(mjs.mechanism), mjs.mechanism);

  const libHelper = classifyUncovered("scripts/lib/some-helper.ts");
  assertEquals(libHelper.tests, [], "subdirectory helper must fail closed");
  assert(/not enumerated/.test(libHelper.mechanism), libHelper.mechanism);
});

Deno.test("3p3e.12: ONLY the two shipped Export HTML documents map to the exact DOM-entry guard", () => {
  const allowed = ["extension/ntp/ntp.html", "extension/artifact/artifact.html"];
  assertEquals(Object.keys(HTML_EXPORT_ENTRY_GUARDS).sort(), allowed.sort());
  for (const file of allowed) {
    const v = classifyUncovered(file);
    assertEquals(v.tests, ["tests/thread-export-entry-html.test.ts"]);
    const html = Deno.readTextFileSync(`${ROOT}${file}`);
    const guard = Deno.readTextFileSync(`${ROOT}tests/thread-export-entry-html.test.ts`);
    assert(guard.includes(file.slice("extension/".length)), `${file} must be read by the mapped guard`);
    assert(/<button\b[^>]*\bid="export-(?:thread|html)"/.test(html), `${file} owns a real Export button`);
  }
  for (const file of ["extension/ntp/index.html", "extension/artifact/preview.html", "extension/options/options.html", "scripts/lib/changed-file-mapping.mjs"]) {
    assertEquals(classifyUncovered(file).tests, [], `${file} must still fail closed`);
  }
});

Deno.test("y546u: Export JS guards are reached through real selector edges, not dead uncovered-file mappings", () => {
  const reverse = buildReverseGraph();
  const exact = new Map([
    ["extension/artifact/artifact.js", "tests/thread-export-entry-html.test.ts"],
    ["extension/background/service-worker.js", "tests/thread-export-sw-entry.test.ts"],
    ["extension/ntp/ntp.js", "tests/thread-export-entry-html.test.ts"],
    ["scripts/check-reachability.mjs", "tests/reachability.test.ts"],
  ]);
  for (const [file, guard] of exact) {
    assertEquals(changedWithoutCoverage([file], reverse), [], `${file} already has a real reverse-import edge`);
    assertEquals(classifyUncovered(file).tests, [], `${file} must not claim an unreachable-file mapping`);
    assert(
      selectTestFiles([file], reverse).includes(guard),
      `${file} must select its executable Export guard via the actual selector, not only classifyUncovered()`,
    );
  }
  for (const file of [
    "extension/ntp/other.js", "extension/artifact/other.js", "extension/background/other.js",
    "scripts/other.mjs", "scripts/lib/other-helper.mjs", "scripts/lib/changed-file-mapping.mjs",
  ]) {
    assertEquals(classifyUncovered(file).tests, [], `${file} must remain full-gate unmappable`);
  }
});

Deno.test("nco2: mapUncovered splits mapped from unmappable and carries the reason", () => {
  const { mapped, unmappable } = mapUncovered(
    ["package.json", "extension/manifest.json", "scripts/a11y-audit.ts", "some/unknown-thing.json"],
    declaredGuardExists,
    () => true,
  );
  assertEquals(mapped.map((m) => m.file), ["scripts/a11y-audit.ts"]);
  assertEquals(unmappable.map((u) => u.file).sort(), ["extension/manifest.json", "package.json", "some/unknown-thing.json"]);
  for (const entry of [...mapped, ...unmappable]) {
    assert(entry.mechanism && entry.mechanism.length > 10, `every entry names its mechanism: ${entry.file}`);
  }
  assert(unmappable.length > 0);
});

Deno.test("cqsim: absent declared guard refuses subset and names both source and missing test", () => {
  const source = "extension/ntp/ntp.html";
  const guard = "tests/thread-export-entry-html.test.ts";
  const missing = mapUncovered([source], () => false, () => true);
  assertEquals(missing.mapped, []);
  assertEquals(missing.unmappable.map((entry: any) => entry.file), [source]);
  assert(missing.unmappable[0].mechanism.includes(source));
  assert(missing.unmappable[0].mechanism.includes(guard));
  assertThrows(() => mapUncovered([source], () => false), Error, "declared guard and source existence predicates are required");
  const present = mapUncovered([source], declaredGuardExists, () => true);
  assertEquals(present.unmappable, []);
  assertEquals(present.mapped[0].tests, [guard]);
});

Deno.test("9l5z4: deleted exact HTML entries fail closed with source and declared guard named", () => {
  const guard = "tests/thread-export-entry-html.test.ts";
  for (const source of Object.keys(HTML_EXPORT_ENTRY_GUARDS)) {
    const missing = mapUncovered([source], declaredGuardExists, () => false);
    assertEquals(missing.mapped, [], source);
    assertEquals(missing.unmappable.map((entry: any) => entry.file), [source]);
    assert(missing.unmappable[0].mechanism.includes(source));
    assert(missing.unmappable[0].mechanism.includes(guard));
    const present = mapUncovered([source], declaredGuardExists, () => true);
    assertEquals(present.unmappable, []);
    assertEquals(present.mapped[0].tests, [guard]);
  }
  assertThrows(
    () => mapUncovered(["extension/ntp/ntp.html"], declaredGuardExists),
    Error,
    "declared guard and source existence predicates are required",
  );
});

Deno.test("nco2: every declared guard EXISTS and actually reads the tree it guards", () => {
  assert(
    !HARNESS_TREE_GUARDS.includes("tests/chrome-profile-location.test.ts"),
    "HARNESS_TREE_GUARDS must NOT include tests/chrome-profile-location.test.ts (real-browser test must not be launched by generic harness changes)",
  );
  assert(
    HARNESS_TREE_GUARDS.includes("tests/chrome-profile-static.test.ts"),
    "HARNESS_TREE_GUARDS must include tests/chrome-profile-static.test.ts (browser-free static scan)",
  );

  for (const rel of HARNESS_TREE_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(/scripts/.test(src), `${rel} must reference the scripts/ tree it is claimed to guard`);
    assert(
      /readDir|readDirSync|readTextFile|harnessFiles|walk/.test(src),
      `${rel} must READ the tree (that is why it has no import edge)`,
    );
  }
  // chrome-agent-platform-x0vas: the BOOKKEEPING_GUARDS list is gone with the
  // version-only mapping. The bookkeeping files' fail-closed coverage is pinned
  // by the always-on guards directly (manifest-permissions, package-scripts-exist,
  // changelog, bump-version-sanitize, bundled-tool-packages,
  // first-run-onboarding-composition) — see tests/select-tests-always-on.test.ts.
  for (const rel of WASM_MANIFEST_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(/manifests|manifest/i.test(src), `${rel} must reference Wasm manifests`);
  }
  for (const rel of WASM_SBOM_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(/sbom|cdx|spdx/i.test(src), `${rel} must reference Wasm SBOMs`);
  }
  for (const rel of WASM_LICENSE_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(/license/i.test(src), `${rel} must reference licenses`);
  }
});

Deno.test("nco2: the changed set is scoped to the MERGE-BASE, never the moving tip", () => {
  assertEquals(mergeBaseOf("origin/main", () => "abc123\n"), "abc123", "uses the merge-base when git resolves one");
  assertEquals(mergeBaseOf("origin/main", () => "   "), "origin/main", "empty merge-base falls back to the ref");
  assertEquals(
    mergeBaseOf("origin/main", () => {
      throw new Error("fatal: refusing to work with unrelated histories");
    }),
    "origin/main",
    "a throwing git falls back to the ref rather than crashing the picker",
  );
  assert(/^[0-9a-f]{40}$/.test(mergeBaseOf("origin/main")), "resolves a real merge-base in this repo");
});

Deno.test("nco2/R1b: the selector's OWN machinery can never be subset-mapped", () => {
  for (const rel of SELECTOR_INFRASTRUCTURE) {
    assert(isSelectorInfrastructure(rel), `${rel} is declared infrastructure`);
    const v = classifyUncovered(rel);
    assertEquals(v.tests, [], `${rel} must never map to a subset`);
    assert(/OWN machinery/.test(v.mechanism), v.mechanism);
  }
  for (const rel of SELECTOR_INFRASTRUCTURE) {
    assert(Deno.statSync(`${ROOT}${rel}`).isFile, `${rel} must exist`);
  }
  assert(SELECTOR_INFRASTRUCTURE.includes("scripts/run-tests.mjs"));
  assert(SELECTOR_INFRASTRUCTURE.includes("scripts/select-tests.mjs"));
  assert(SELECTOR_INFRASTRUCTURE.includes("scripts/gate-full.mjs"));
  assert(SELECTOR_INFRASTRUCTURE.includes("tests/coverage-contract.json"));

  const src = Deno.readTextFileSync(`${ROOT}scripts/select-tests.mjs`);
  assert(
    /changed\.filter\(\(f\) => isSelectorInfrastructure\(f\)\)/.test(src),
    "select-tests.mjs must test the CHANGED set for infrastructure, not the uncovered set",
  );
  assert(
    /failClosedPlan\({\s*list,\s*unmappable,\s*header:/.test(src),
    "select-tests.mjs must route infrastructure fail-closed through failClosedPlan",
  );
});

Deno.test("nco2/R3: the CALLER uses the merge-base — a caller-only revert must fail here", async () => {
  const src = await Deno.readTextFile(`${ROOT}scripts/select-tests.mjs`);
  const cut = (start: string, end: string) => {
    const a = src.indexOf(start);
    const b = src.indexOf(end, a);
    assert(a >= 0 && b > a, `source not found: ${start}`);
    return src.slice(a, b);
  };
  const helper = cut("export function mergeBaseOf(", "\nfunction changedFiles(");
  const caller = cut("function changedFiles(base)", "\n// ---- static import graph ----");

  const calls: string[][] = [];
  const fakeGit = (args: string[]) => {
    calls.push(args);
    if (args[0] === "merge-base") return "MERGE_BASE_SHA\n";
    if (args[0] === "diff") return "extension/lib/agent.js\n";
    return "";
  };
  const compiled = new Function(
    "git",
    "normalize",
    "isBuildResidue",
    `${helper.replaceAll("export function", "function")}\n${caller}\nreturn changedFiles;`,
  )(fakeGit, (p: string) => p, () => false);

  const changed = compiled("origin/main");
  const diffCall = calls.find((c) => c[0] === "diff");
  assert(diffCall, `changedFiles must run a git diff; calls: ${JSON.stringify(calls)}`);
  assertEquals(
    diffCall![2],
    "MERGE_BASE_SHA",
    "the diff must be taken against the MERGE-BASE, not the moving tip ref",
  );
  assert(calls.some((c) => c[0] === "merge-base"), "the caller must ask git for the merge-base");
  assertEquals(changed, ["extension/lib/agent.js"], "the changed set still comes back through the filter");
});

Deno.test("nco2: the mapping is a SUBSET of the full suite, never an invention", () => {
  for (const rel of [...HARNESS_TREE_GUARDS]) {
    assert(
      Deno.statSync(`${ROOT}${rel}`).isFile,
      `${rel} must exist — a mapping to a missing test selects nothing and proves nothing`,
    );
  }
});

Deno.test("ugvyo: every harness mentioned in changed-file-mapping.mjs header exists on disk", () => {
  const header = Deno.readTextFileSync(`${ROOT}scripts/lib/changed-file-mapping.mjs`);
  const matches = [...header.matchAll(/scripts\/[a-z0-9-]+\.ts/g)].map((m) => m[0]);
  assert(matches.length > 0, "must cite example harnesses");
  for (const path of matches) {
    assert(
      Deno.statSync(`${ROOT}${path}`).isFile,
      `cited harness ${path} in changed-file-mapping.mjs must exist on disk (chrome-agent-platform-ugvyo)`,
    );
  }
});

Deno.test("oeqvx: isTestsFixture identifies fixtures under tests/fixtures/", () => {
  assertEquals(isTestsFixture("tests/fixtures/security-suite-fake-runner.mjs"), true);
  assertEquals(isTestsFixture("tests/fixtures/acp-fake-adapter.mjs"), true);
  assertEquals(isTestsFixture("tests/fixtures/crumb-v1.html"), true);
  assertEquals(isTestsFixture("tests/fixtures/artifact-tx-4eaf0d34/memory.js"), true);
  assertEquals(isTestsFixture("scripts/chrome-journeys.ts"), false);
  assertEquals(isTestsFixture("tests/changed-file-mapping.test.ts"), false);
  assertEquals(isTestsFixture("extension/background/service-worker.js"), false);
});

Deno.test("oeqvx: classifyUncovered maps fixtures and text-read scripts when referrers exist, and fails closed when absent", () => {
  // Fixture with referrers: mapped
  const fixtureWithRefs = classifyUncovered("tests/fixtures/security-suite-fake-runner.mjs", {
    referrers: ["tests/security-suite-custody.test.ts", "tests/file-url-root-guard.test.ts"],
  });
  assertEquals(fixtureWithRefs.tests, [
    "tests/security-suite-custody.test.ts",
    "tests/file-url-root-guard.test.ts",
  ]);
  assert(fixtureWithRefs.mechanism.includes("tests/fixtures/ file named by tests"), fixtureWithRefs.mechanism);
  assert(fixtureWithRefs.mechanism.includes("globbing consumers not selected"), fixtureWithRefs.mechanism);

  // Fixture without referrers: fails closed
  const fixtureNoRefs = classifyUncovered("tests/fixtures/security-suite-fake-runner.mjs", { referrers: [] });
  assertEquals(fixtureNoRefs.tests, []);
  assert(fixtureNoRefs.mechanism.includes("no static import edge and no referencing test"), fixtureNoRefs.mechanism);

  // Text-referenced script with referrers: mapped (and includes HARNESS_TREE_GUARDS for top-level enumerated scripts)
  const scriptWithRefs = classifyUncovered("scripts/chrome-journeys.ts", {
    referrers: ["tests/journey-focus-fail-closed.test.ts"],
  });
  assert(scriptWithRefs.tests.includes("tests/journey-focus-fail-closed.test.ts"));
  assert(scriptWithRefs.tests.includes("tests/harness-registry.test.ts"));
  assert(scriptWithRefs.mechanism.includes("scripts/ file named by tests"), scriptWithRefs.mechanism);
  assert(scriptWithRefs.mechanism.includes("content reference"), scriptWithRefs.mechanism);

  // Subprocess-invoked script (check-changelog.mjs): mapped to referrers
  const changelogWithRefs = classifyUncovered("scripts/check-changelog.mjs", {
    referrers: ["tests/changelog.test.ts"],
  });
  assertEquals(changelogWithRefs.tests, ["tests/changelog.test.ts"]);
  assert(changelogWithRefs.mechanism.includes("content reference"), changelogWithRefs.mechanism);

  // Unenumerated script with referrers: mapped to referrers
  const subHelperWithRefs = classifyUncovered("scripts/lib/some-helper.mjs", {
    referrers: ["tests/some-test.test.ts"],
  });
  assertEquals(subHelperWithRefs.tests, ["tests/some-test.test.ts"]);
  assert(subHelperWithRefs.mechanism.includes("scripts/ file named by tests"), subHelperWithRefs.mechanism);

  // Unenumerated script without referrers: fails closed
  const subHelperNoRefs = classifyUncovered("scripts/lib/some-helper.mjs", { referrers: [] });
  assertEquals(subHelperNoRefs.tests, []);
  assert(subHelperNoRefs.mechanism.includes("not enumerated by the tree-walking guards"), subHelperNoRefs.mechanism);
});

Deno.test("oeqvx: referrersFor finds suites that mention fixtures or text-read scripts", () => {
  const fakeRunnerRefs = referrersFor("tests/fixtures/security-suite-fake-runner.mjs");
  assert(
    fakeRunnerRefs.includes("tests/security-suite-custody.test.ts"),
    "security-suite-custody.test.ts references security-suite-fake-runner.mjs",
  );
  assert(
    fakeRunnerRefs.includes("tests/file-url-root-guard.test.ts"),
    "file-url-root-guard.test.ts references security-suite-fake-runner.mjs",
  );

  const acpAdapterRefs = referrersFor("tests/fixtures/acp-fake-adapter.mjs");
  assert(
    acpAdapterRefs.includes("tests/acp-child-env-wiring.test.ts"),
    "acp-child-env-wiring.test.ts references acp-fake-adapter.mjs",
  );
  assert(
    acpAdapterRefs.includes("tests/acp-bridge-security.test.ts"),
    "acp-bridge-security.test.ts references acp-fake-adapter.mjs",
  );

  const journeyRefs = referrersFor("scripts/chrome-journeys.ts");
  assert(
    journeyRefs.includes("tests/journey-focus-fail-closed.test.ts"),
    "journey-focus-fail-closed.test.ts references chrome-journeys.ts",
  );

  const crumbRefs = referrersFor("tests/fixtures/crumb-v1.html");
  assert(
    crumbRefs.includes("tests/components.test.ts"),
    "components.test.ts references crumb-v1.html",
  );

  const orphanBase = "non_existent_orphan_" + "xyz_unreferenced_probe.mjs";
  const orphan = "tests/fixtures/" + orphanBase;
  const orphanRefs = referrersFor(orphan);
  assertEquals(orphanRefs, [], "non-existent or unmentioned fixture has zero referrers");

  // Subprocess-invoked script with join(ROOT, ...) or spawn in tests
  const chkRefs = referrersFor("scripts/check-changelog.mjs");
  assert(
    chkRefs.includes("tests/changelog.test.ts"),
    "changelog.test.ts references scripts/check-changelog.mjs",
  );
});

Deno.test("2yc3j: clearReferrersCache clears cached content so subsequent call repopulates", () => {
  // Prime cache
  const cached = testFilesWithContent();
  const sentinel = { file: "tests/__sentinel_fake_test__.test.ts", content: "sentinel_marker_content" };
  cached.push(sentinel);
  assert(testFilesWithContent().some((entry) => entry.file === sentinel.file));

  // clearReferrersCache must discard the cached array reference
  clearReferrersCache();
  const repopulated = testFilesWithContent();
  assert(
    !repopulated.some((entry) => entry.file === sentinel.file),
    "cleared cache must repopulate fresh without the injected sentinel",
  );
});

Deno.test("3aq3v: Wasm manifest, SBOM, and license predicates and mapping", () => {
  assertEquals(isWasmManifest("extension/wasm/manifests/cap.bundled.hash.keccak.256-1.0.0.manifest.json"), true);
  assertEquals(isWasmManifest("extension/wasm/manifests/cap.bundled.avif-1.0.0.manifest.json"), true);
  assertEquals(isWasmManifest("extension/manifest.json"), false);

  assertEquals(isWasmSbom("extension/wasm/sbom/hash_keccak_256.cdx.json"), true);
  assertEquals(isWasmSbom("extension/wasm/sbom/c2.spdx.json"), true);
  assertEquals(isWasmSbom("package.json"), false);

  assertEquals(isWasmLicense("extension/wasm/licenses/hash-wasm-MIT.txt"), true);
  assertEquals(isWasmLicense("extension/wasm/licenses/0BSD.txt"), true);
  assertEquals(isWasmLicense("extension/wasm/cas/1234.wasm"), false);

  // Manifest mapping without explicit referrers
  const manifestVerdict = classifyUncovered(
    "extension/wasm/manifests/cap.bundled.hash.keccak.256-1.0.0.manifest.json",
    { referrers: [] },
  );
  assert(manifestVerdict.tests.includes("tests/bundled-tool-packages.test.ts"));
  assert(manifestVerdict.tests.includes("tests/wasm-manifest-assets.test.ts"));
  assert(manifestVerdict.mechanism.includes("extension/wasm/manifests/ manifest validated"), manifestVerdict.mechanism);

  // Manifest mapping with explicit referrers (e.g. tests/wasm-shared-cas-claims.test.ts)
  const manifestWithRefs = classifyUncovered(
    "extension/wasm/manifests/cap.bundled.hash.sha3.256-1.0.0.manifest.json",
    { referrers: ["tests/wasm-shared-cas-claims.test.ts"] },
  );
  assert(manifestWithRefs.tests.includes("tests/wasm-shared-cas-claims.test.ts"));
  assert(manifestWithRefs.tests.includes("tests/bundled-tool-packages.test.ts"));

  // SBOM mapping
  const sbomVerdict = classifyUncovered(
    "extension/wasm/sbom/hash_keccak_256.cdx.json",
    { referrers: [] },
  );
  assert(sbomVerdict.tests.includes("tests/wasm-package-authority-static.test.ts"));
  assert(sbomVerdict.tests.includes("tests/bundled-tool-packages.test.ts"));
  assert(sbomVerdict.mechanism.includes("extension/wasm/sbom/"), sbomVerdict.mechanism);

  // License mapping
  const licenseVerdict = classifyUncovered(
    "extension/wasm/licenses/hash-wasm-MIT.txt",
    { referrers: [] },
  );
  assert(licenseVerdict.tests.includes("tests/bundled-tool-packages.test.ts"));
  assert(licenseVerdict.mechanism.includes("extension/wasm/licenses/"), licenseVerdict.mechanism);

  // mapUncovered integration
  const mapped = mapUncovered(
    [
      "extension/wasm/manifests/cap.bundled.hash.keccak.256-1.0.0.manifest.json",
      "extension/wasm/sbom/hash_keccak_256.cdx.json",
      "extension/wasm/licenses/hash-wasm-MIT.txt",
    ],
    declaredGuardExists,
    () => true,
    referrersFor,
  );
  assertEquals(mapped.unmappable, [], "Wasm manifests, SBOMs, and licenses must be mapped, not unmappable");
  assertEquals(mapped.mapped.length, 3);
});

Deno.test("oeqvx: mapUncovered maps fixture when referrersFor is supplied and fails closed when empty (mutant)", () => {
  const fixture = "tests/fixtures/security-suite-fake-runner.mjs";
  const mappedResult = mapUncovered(
    [fixture],
    declaredGuardExists,
    () => true,
    referrersFor,
  );
  assertEquals(mappedResult.unmappable, [], "fixture with referrers must not be unmappable");
  assertEquals(mappedResult.mapped.length, 1);
  assertEquals(mappedResult.mapped[0].file, fixture);
  assert(
    mappedResult.mapped[0].tests.includes("tests/security-suite-custody.test.ts"),
    "must include security-suite-custody.test.ts",
  );

  // Non-equivalent mutant: when referrersFor returns [] (or mapping removed), fixture fails closed
  const mutantResult = mapUncovered(
    [fixture],
    declaredGuardExists,
    () => true,
    () => [],
  );
  assertEquals(mutantResult.mapped, [], "fixture without referrers must not be mapped");
  assertEquals(mutantResult.unmappable.length, 1);
  assertEquals(mutantResult.unmappable[0].file, fixture);
  assert(
    mutantResult.unmappable[0].mechanism.includes("no static import edge and no referencing test"),
    mutantResult.unmappable[0].mechanism,
  );
});


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
//
// MEASURED CONTEXT (98cc8c8a) that justifies mapping at all:
//   • scripts/a11y-audit.ts, sidebar-parity.ts, constrained-width-layout.ts are
//     uncovered by the import graph; scripts/lib/composer-target.ts and
//     css-padding.ts are COVERED, because a test imports them. The rule is
//     "nothing imports it", never "it is under scripts/".
//   • NO unit test executes those three: the tests that mention them contain
//     zero Deno.Command/spawnSync/execFileSync. The full suite adds nothing for
//     that class over the tree-walking guards.
//   • package.json / package-lock.json / extension/manifest.json are uncovered
//     at EVERY tree — verified at 98cc8c8a and d0f01545, three identical runs
//     each, so the classification is deterministic and base-independent.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  BOOKKEEPING_FILES,
  BOOKKEEPING_GUARDS,
  classifyUncovered,
  executingTests,
  HARNESS_TREE_GUARDS,
  isGuardEnumeratedScript,
  isSelectorInfrastructure,
  mapUncovered,
  referencingTests,
  SELECTOR_INFRASTRUCTURE,
  VERSION_FIELDS_BY_FILE,
  versionOnlyJsonChange,
} from "../scripts/lib/changed-file-mapping.mjs";
import { mergeBaseOf } from "../scripts/select-tests.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE = JSON.stringify({
  name: "chrome-agent-platform",
  version: "0.3.474",
  dependencies: { ai: "7.0.66", zod: "3.25.76" },
  scripts: { test: "node scripts/run-tests.mjs" },
});
const withBase = (mutate: (o: any) => void) => {
  const o = JSON.parse(BASE);
  mutate(o);
  return JSON.stringify(o);
};

// R2b: the approved fields are a property of the FILE, so every call names one.
// A call WITHOUT a path fails closed by design, which means an assertion that
// omits it would pass for the wrong reason — see the dedicated block below.
const PKG = "package.json";
const MAN = "extension/manifest.json";
const LOCK = "package-lock.json";

Deno.test("nco2: a pure version bump is mappable", () => {
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => o.version = "0.3.475"), PKG), true);
  // manifest carries a second version field.
  const man = JSON.stringify({ version: "1.0", version_name: "1.0", permissions: ["storage"] });
  const bumped = JSON.stringify({ version: "1.1", version_name: "1.1", permissions: ["storage"] });
  assertEquals(versionOnlyJsonChange(man, bumped, MAN), true);
  // package-lock's root self-entry mirrors the project version.
  const lock = JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" }, "node_modules/ai": { version: "7.0.66" } } });
  const lockBumped = JSON.stringify({ version: "1.1", packages: { "": { version: "1.1" }, "node_modules/ai": { version: "7.0.66" } } });
  assertEquals(versionOnlyJsonChange(lock, lockBumped, LOCK), true);
});

Deno.test("nco2: a NESTED dependency bump is NOT mappable (the line-grep trap)", () => {
  // mo2f.3 proved a line filter on `"version"` passes a dependency bump exactly
  // as cleanly as a project bump. Parsing both sides is what closes that hole,
  // so this is the assertion that must never be relaxed into a token match.
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => o.dependencies.ai = "9.9.9"), PKG), false);
  const lock = JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" }, "node_modules/ai": { version: "7.0.66" } } });
  const sneaky = JSON.stringify({ version: "1.1", packages: { "": { version: "1.1" }, "node_modules/ai": { version: "9.9.9" } } });
  assertEquals(versionOnlyJsonChange(lock, sneaky, LOCK), false, "a nested dependency bump hidden behind a real version bump");
});

Deno.test("nco2: security-relevant manifest edits are NOT mappable", () => {
  // cap-astra's caveat (seq89), asserted rather than trusted: root-only
  // normalization must not suppress a CSP or permission change.
  const man = JSON.stringify({
    version: "1.0",
    version_name: "1.0",
    permissions: ["storage"],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'" },
  });
  const weakenedCsp = JSON.stringify({
    version: "1.1",
    version_name: "1.1",
    permissions: ["storage"],
    content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" },
  });
  const newPermission = JSON.stringify({
    version: "1.1",
    version_name: "1.1",
    permissions: ["storage", "debugger"],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'" },
  });
  assertEquals(versionOnlyJsonChange(man, weakenedCsp, MAN), false, "a weakened CSP must force the full suite");
  assertEquals(versionOnlyJsonChange(man, newPermission, MAN), false, "a new permission must force the full suite");
});

Deno.test("nco2: STRUCTURE is preserved — empty containers and key identity are real changes", () => {
  // R2, from cap-astra's independent review of 39314910. The first
  // implementation flattened both documents to `path -> primitive` and compared
  // the maps. That lost two things, and BOTH produced false positives on real
  // repository files — each case below mapped as "version-only" and would have
  // run a 22-file subset instead of the full suite.
  //
  // These are not synthetic shapes: the reviewer produced them against the
  // actual package.json and extension/manifest.json (probe-json.mjs /
  // json-probes.json, 5 of 12 cases mismatching). The nine tests that shipped
  // with the defect all passed, which is why these exist as their own block.

  // (a) EMPTY CONTAINERS VANISHED when flattened — they have no leaves.
  assertEquals(
    versionOnlyJsonChange(BASE, withBase((o) => { o.version = "0.3.999"; o.overrides = {}; }), PKG),
    false,
    "adding an empty `overrides: {}` is a structural change, not a version bump",
  );
  const manifest = JSON.stringify({ version: "1.0", version_name: "1.0", permissions: ["storage"] });
  assertEquals(
    versionOnlyJsonChange(
      manifest,
      JSON.stringify({ version: "1.1", version_name: "1.1", permissions: ["storage"], web_accessible_resources: [] }),
      MAN,
    ),
    false,
    "adding an empty `web_accessible_resources: []` is a structural change",
  );
  // …including a container that changes TYPE while staying empty.
  assertEquals(
    versionOnlyJsonChange(
      JSON.stringify({ version: "1.0", overrides: {} }),
      JSON.stringify({ version: "1.1", overrides: [] }),
      PKG,
    ),
    false,
    "`{}` becoming `[]` is a structural change — a flattened map cannot see it",
  );

  // (b) KEY PATHS COLLIDED: `dependencies.ai` and a literal top-level key named
  //     "dependencies.ai" flattened identically, so MOVING a real dependency out
  //     of its container compared equal to leaving it there.
  assertEquals(
    versionOnlyJsonChange(
      BASE,
      withBase((o) => {
        o.version = "0.3.999";
        o["dependencies.ai"] = o.dependencies.ai;
        delete o.dependencies.ai;
      }),
      PKG,
    ),
    false,
    "moving a dependency to a dotted top-level key is a real change, not a bump",
  );
  // The same collision with bracket syntax and a real permissions array.
  assertEquals(
    versionOnlyJsonChange(
      manifest,
      JSON.stringify({ version: "1.1", version_name: "1.1", "permissions[0]": "storage" }),
      MAN,
    ),
    false,
    "replacing an array with same-valued indexed keys is a real change",
  );

  // And the ordinary positives still map: key ORDER is not a difference.
  assertEquals(
    versionOnlyJsonChange(
      JSON.stringify({ name: "x", version: "1.0", dependencies: { ai: "7.0.66" } }),
      JSON.stringify({ dependencies: { ai: "7.0.66" }, version: "1.1", name: "x" }),
      PKG,
    ),
    true,
    "reordered keys with only the version moved is still a version-only change",
  );
});

Deno.test("nco2/R2b: the approved fields are PER FILE — `release` is not one of them anywhere", () => {
  // R2b, from cap-astra's re-review of 014177de, and a defect in the R2 fix
  // itself: that fix deleted a GENERIC ["version", "version_name", "release"]
  // from every bookkeeping file. Both extra names were wrong.
  //
  // The authority is what the hook ACTUALLY writes (scripts/bump-version.mjs):
  //   :145      pkg.version = next                          → package.json
  //   :147-148  lock.version + lock.packages[""].version    → package-lock.json
  //   :150-151  manifest.version + manifest.version_name    → extension/manifest.json
  //   :178-192  a `release` MIRROR into extension/lib/bundled-inventory-data.js,
  //             so the bundled-tool-packages guard can assert
  //             inventory.release === manifest.version.
  //             (Named WITHOUT its tests/ path on purpose: the partition guard's
  //             DRIVER_REF_RE treats any `tests/<name>.test.ts` literal as a
  //             SPAWNED DRIVER and merges that file's text into this one's
  //             hazard classification. That guard spawns the bundled-tool
  //             generator, so a prose mention of it made this pure-unit file
  //             classify as a build-artifact hazard and fail the partition
  //             guard. Filed as chrome-agent-platform-f94p; this is its first
  //             live case.)
  // `release` therefore never appears in any of the three JSON files, and
  // `version_name` only in the manifest. Deleting them anyway ERASED real edits:
  // measured through the actual CLI, adding a release CONFIG object to any of
  // the three selected a 21-file subset instead of the full suite.
  assertEquals(VERSION_FIELDS_BY_FILE[PKG], ["version"]);
  assertEquals(VERSION_FIELDS_BY_FILE[LOCK], ["version"]);
  assertEquals(VERSION_FIELDS_BY_FILE[MAN], ["version", "version_name"]);
  for (const [file, fields] of Object.entries(VERSION_FIELDS_BY_FILE)) {
    assert(!fields.includes("release"), `${file} must not approve \`release\` — the hook never writes it there`);
  }

  // A release CONFIG object is a real change in all three, with no version moved.
  const rel = (o: any) => { o.release = { branches: ["preview"], plugins: ["x"] }; };
  assertEquals(versionOnlyJsonChange(BASE, withBase(rel), PKG), false, "package.json release config");
  const man = JSON.stringify({ version: "1.0", version_name: "1.0", permissions: ["storage"] });
  assertEquals(
    versionOnlyJsonChange(man, JSON.stringify({ version: "1.0", version_name: "1.0", permissions: ["storage"], release: { permissions: ["debugger"] } }), MAN),
    false,
    "a manifest `release` object is not a manifest version field",
  );
  const lock = JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" } } });
  assertEquals(
    versionOnlyJsonChange(lock, JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" } }, release: { enabled: false } }), LOCK),
    false,
    "a lock `release` object is not a lock version field",
  );

  // package.json has no `version_name`, so writing one is a real change there…
  assertEquals(
    versionOnlyJsonChange(BASE, withBase((o) => { o.version_name = "not-a-package-version"; }), PKG),
    false,
    "package.json does not carry version_name — writing one is a real change",
  );
  // …while the manifest's IS approved, because the hook writes it.
  assertEquals(
    versionOnlyJsonChange(man, JSON.stringify({ version: "1.1", version_name: "1.1", permissions: ["storage"] }), MAN),
    true,
    "the manifest's version_name moves with its version",
  );

  // packages[""] is stripped for the LOCK ONLY. The same shape elsewhere is not
  // a version mirror, and treating it as one would erase a real change.
  const shaped = JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" } } });
  const shapedMoved = JSON.stringify({ version: "1.1", packages: { "": { version: "9.9.9" } } });
  assertEquals(versionOnlyJsonChange(shaped, shapedMoved, LOCK), true, "the lock's self-mirror moves with the version");
  assertEquals(
    versionOnlyJsonChange(shaped, shapedMoved, PKG),
    false,
    "the same shape in package.json is NOT a version mirror",
  );
});

Deno.test("nco2: anything unprovable is NOT mappable (fails closed)", () => {
  assertEquals(versionOnlyJsonChange(BASE, "{not json", PKG), false, "unparseable after");
  assertEquals(versionOnlyJsonChange("{not json", BASE, PKG), false, "unparseable before");
  assertEquals(versionOnlyJsonChange(BASE, BASE, PKG), false, "identical files are not a version-only CHANGE");
  assertEquals(versionOnlyJsonChange(undefined, BASE, PKG), false, "missing side");
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => o.scripts.evil = "rm -rf /"), PKG), false, "an added script");
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => delete o.dependencies.zod), PKG), false, "a removed dependency");
  // R2b: a call that does not name a file cannot know which fields are approved,
  // so it FAILS CLOSED rather than falling back to a generic list. That fallback
  // is exactly what shipped the release/version_name defect, and this assertion
  // is what stops a future caller from reintroducing it by dropping the argument.
  const realBump = withBase((o) => o.version = "0.3.999");
  assertEquals(versionOnlyJsonChange(BASE, realBump, PKG), true, "control: WITH a path this is version-only");
  assertEquals(versionOnlyJsonChange(BASE, realBump), false, "the same change with NO path fails closed");
  assertEquals(versionOnlyJsonChange(BASE, realBump, "some/other.json"), false, "an undeclared path fails closed");
});

Deno.test("nco2: classification names the mechanism, and only maps what it can justify", () => {
  const harness = classifyUncovered("scripts/a11y-audit.ts");
  assert(harness.tests.length > 0, "an unimported harness maps to its tree-walking guards");
  assert(/enumerated by the tree-walking guards/.test(harness.mechanism), harness.mechanism);

  const bump = classifyUncovered("package.json", { versionOnly: true });
  assertEquals(bump.tests, [...BOOKKEEPING_GUARDS]);
  assert(/version-only/.test(bump.mechanism), bump.mechanism);

  // The SAME file with a real change is deliberately unmappable.
  const realChange = classifyUncovered("package.json", { versionOnly: false });
  assertEquals(realChange.tests, [], "a non-version package.json change must fail closed");
  assert(/NON-version/.test(realChange.mechanism), realChange.mechanism);

  const unknown = classifyUncovered("some/unknown-thing.json");
  assertEquals(unknown.tests, [], "an unrecognised file still fails closed");
  assert(/genuinely unmappable/.test(unknown.mechanism), unknown.mechanism);
});

Deno.test("nco2: mapUncovered splits mapped from unmappable and carries the reason", () => {
  const { mapped, unmappable } = mapUncovered(
    ["package.json", "extension/manifest.json", "scripts/a11y-audit.ts", "some/unknown-thing.json"],
    (f) => f === "package.json", // only package.json is a version-only diff
  );
  assertEquals(mapped.map((m) => m.file).sort(), ["package.json", "scripts/a11y-audit.ts"]);
  assertEquals(unmappable.map((u) => u.file).sort(), ["extension/manifest.json", "some/unknown-thing.json"]);
  for (const entry of [...mapped, ...unmappable]) {
    assert(entry.mechanism && entry.mechanism.length > 10, `every entry names its mechanism: ${entry.file}`);
  }
  // A single unmappable file is enough to force the full suite — that is the
  // fail-closed contract, and the message must be able to name it.
  assert(unmappable.length > 0);
});

Deno.test("nco2: every declared guard EXISTS and actually reads the tree it guards", () => {
  // A mapping to a test that does not exist, or that never reads the file class
  // it is claimed to cover, would be a silent weakening: the subset would go
  // green having asserted nothing about the changed file.
  for (const rel of HARNESS_TREE_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(/scripts/.test(src), `${rel} must reference the scripts/ tree it is claimed to guard`);
    assert(
      /readDir|readDirSync|readTextFile|harnessFiles|walk/.test(src),
      `${rel} must READ the tree (that is why it has no import edge)`,
    );
  }
  for (const rel of BOOKKEEPING_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    // EXACT literal only. A looser check (/manifest|version/) passed two guards
    // that cover nothing of the sort — changelog-shipping.test.ts reads
    // .gitignore and the packaging scripts, and build-bootstrap.test.ts matched
    // only on the `dist-versions` directory name. Both were in my first mapping
    // list and this assertion is what removed them, so it must not be relaxed.
    assert(
      BOOKKEEPING_FILES.some((f) => src.includes(f)),
      `${rel} must contain the literal path of a bookkeeping file it is claimed to cover`,
    );
  }
});

Deno.test("nco2: the changed set is scoped to the MERGE-BASE, never the moving tip", () => {
  // Mechanism 3. `git diff --name-only origin/main` lists everything that
  // differs from the TIP, so a lane that branched an hour ago inherits every
  // file another lane landed since — and one of those can force a full suite on
  // a change that never touched it (measured: bead cgei's
  // cap-evidence/constrained-width-layout.ts appeared in a cwy2 run's
  // fail-closed list). The git call is injected so the three branches are
  // executable without manufacturing a divergent repository.
  assertEquals(mergeBaseOf("origin/main", () => "abc123\n"), "abc123", "uses the merge-base when git resolves one");
  // FAIL SAFE, both directions: an empty result or a throwing git must fall
  // back to the raw ref. Refusing to compute a changed set would be worse than
  // computing a wide one — the subset would silently select nothing.
  assertEquals(mergeBaseOf("origin/main", () => "   "), "origin/main", "empty merge-base falls back to the ref");
  assertEquals(
    mergeBaseOf("origin/main", () => {
      throw new Error("fatal: refusing to work with unrelated histories");
    }),
    "origin/main",
    "a throwing git falls back to the ref rather than crashing the picker",
  );
  // And against the real repository it resolves to a real commit id.
  assert(/^[0-9a-f]{40}$/.test(mergeBaseOf("origin/main")), "resolves a real merge-base in this repo");
});

Deno.test("nco2/R1: a script the guards do NOT enumerate maps to the tests that NAME it, or fails closed", () => {
  // R1, from cap-astra's independent review of 39314910, and the most serious
  // of the three findings. The first version mapped EVERY import-unreachable
  // file under scripts/ to the eleven tree-walking guards. But harnessFiles()
  // in scripts/lib/harness-registry.ts enumerates `scripts/*.ts` ONLY: top
  // level, .ts extension. A .mjs helper was therefore mapped to guards that
  // never look at it, and the subset DROPPED a test the full suite would run.
  //
  // Measured counterexample: restoring the old unsupported `harness || "pi"`
  // default in scripts/acp-service.mjs took
  // tests/acp-service-harness-default.test.ts from 5/0 to 1 passed / 4 failed —
  // a real executed regression — while test:changed returned exit 0 over 28
  // files without ever selecting it.

  // The boundary is exactly harnessFiles()'s glob.
  assertEquals(isGuardEnumeratedScript("scripts/a11y-audit.ts"), true, "top-level .ts IS enumerated");
  assertEquals(isGuardEnumeratedScript("scripts/acp-service.mjs"), false, ".mjs is NOT enumerated");
  assertEquals(isGuardEnumeratedScript("scripts/lib/quiet-window.ts"), false, "a subdirectory is NOT enumerated");

  // A literal reference is found even when the path is COMPUTED at runtime.
  // That is why the reverse graph misses these: there is no import edge, but
  // the basename is still a string literal in the test's source. The fixture
  // mirrors the real shape — bind the path, then put the identifier in argv.
  const SPAWNS_IT = [
    'const SCRIPT = join(ROOT, "scripts", "acp-service.mjs");',
    'const args = [SCRIPT, "install", "--dry-run"];',
    'const res = new Deno.Command("node", { args }).outputSync();',
  ].join("\n");
  const corpus = [
    { rel: "tests/acp-service-harness-default.test.ts", text: SPAWNS_IT },
    { rel: "tests/unrelated.test.ts", text: "const x = 1;" },
  ];
  assertEquals(referencingTests("scripts/acp-service.mjs", corpus), ["tests/acp-service-harness-default.test.ts"]);

  // THE FIX: an unenumerated script maps to the tests that EXECUTE it...
  const acp = classifyUncovered("scripts/acp-service.mjs", { testFiles: corpus });
  assertEquals(acp.tests, ["tests/acp-service-harness-default.test.ts"], "the spawning test is selected");
  assert(/do NOT enumerate/.test(acp.mechanism), acp.mechanism);

  // ...and FAILS CLOSED when nothing runs it, rather than claiming guard
  // coverage that does not exist. This assertion is what would have caught the
  // original defect.
  const orphan = classifyUncovered("scripts/lib/no-such-helper.mjs", { testFiles: corpus });
  assertEquals(orphan.tests, [], "an unenumerated script no test executes must fail closed");
  assert(/no test names it/.test(orphan.mechanism), orphan.mechanism);

  // An enumerated script keeps its guards AND gains any executing tests.
  const enumerated = classifyUncovered("scripts/a11y-audit.ts", {
    testFiles: [{
      rel: "tests/runs-it.test.ts",
      text: 'const res = new Deno.Command("deno", { args: ["run", "-A", "scripts/a11y-audit.ts"] });',
    }],
  });
  assert(enumerated.tests.includes("tests/runs-it.test.ts"), "an executing test is added to the guards");
  for (const g of HARNESS_TREE_GUARDS) assert(enumerated.tests.includes(g), `${g} is still selected`);
});

Deno.test("nco2/R1b: a MENTION is not coverage — only a test that EXECUTES the script counts", () => {
  // R1b, from cap-astra's re-review of 014177de, and the more serious of that
  // review's two findings. The R1 fix treated any literal mention as coverage,
  // so changing scripts/run-tests.mjs — the SUITE RUNNER — mapped to two tests
  // that never run it:
  //   tests/00-use-npm-test_test.ts names it inside `await Deno.readTextFile(…)`
  //     + assertStringIncludes. It inspects SOURCE for two marker strings. It
  //     does spawn a subprocess, but it spawns Deno.execPath() against a
  //     throwaway temp repo — which is why "the file contains a spawn" is not
  //     the rule (cap-astra's constraint: an unrelated spawn must not bind an
  //     unrelated mention).
  //   tests/changed-file-mapping.test.ts names it in SYNTHETIC package data.
  // Measured: readdirSync("tests") → a missing directory makes `npm test` die
  // instantly with ENOENT while `npm run test:changed` exited 0 over a 21-file
  // subset.

  const inspectsSource = [
    'for (const runner of ["scripts/run-tests.mjs", "scripts/select-tests.mjs"]) {',
    "  const src = await Deno.readTextFile(`${ROOT}${runner}`);",
    '  assertStringIncludes(src, "deno.runner.jsonc");',
    "}",
    'const out = await new Deno.Command(Deno.execPath(), { args, cwd: dir }).output();',
  ].join("\n");
  const syntheticData = 'const pkg = { scripts: { test: "node scripts/run-tests.mjs" } };\nnew Deno.Command("x", { args: [] });';
  const corpus = [
    { rel: "tests/00-use-npm-test_test.ts", text: inspectsSource },
    { rel: "tests/changed-file-mapping.test.ts", text: syntheticData },
  ];

  // Both MENTION it — that was the old, too-weak signal…
  assertEquals(referencingTests("scripts/run-tests.mjs", corpus).length, 2);
  // …and NEITHER executes it, which is the signal that decides coverage.
  assertEquals(executingTests("scripts/run-tests.mjs", corpus), [], "a read + a synthetic string are not execution");

  // THE BINDING ASSERTION. Testing the two helpers apart from the classifier is
  // not enough — that is the R3 mistake repeated: swapping the call site back to
  // `referencingTests(path, testFiles)` left every other assertion in this file
  // green (measured: 16 passed / 0 failed with the mutant in place). So this
  // drives classifyUncovered on a NON-infrastructure script with a corpus where
  // the two helpers DISAGREE, which is the only shape that can detect the swap.
  const inspectsOnly = [{
    rel: "tests/inspects.test.ts",
    text: 'const src = await Deno.readTextFile("scripts/acp-service.mjs");\nnew Deno.Command(Deno.execPath(), { args: ["unrelated"] });',
  }];
  assertEquals(
    referencingTests("scripts/acp-service.mjs", inspectsOnly),
    ["tests/inspects.test.ts"],
    "the helpers must genuinely disagree here, or this assertion proves nothing",
  );
  assertEquals(executingTests("scripts/acp-service.mjs", inspectsOnly), []);
  assertEquals(
    classifyUncovered("scripts/acp-service.mjs", { testFiles: inspectsOnly }).tests,
    [],
    "classifyUncovered must consult EXECUTION, not mention — a source-inspecting test is not coverage",
  );

  // A read of the file must never count even when it is the whole line.
  assertEquals(
    executingTests("scripts/run-tests.mjs", [
      { rel: "tests/a.test.ts", text: 'const src = readFileSync("scripts/run-tests.mjs");\nnew Deno.Command("x", { args: [] });' },
    ]),
    [],
    "readFileSync(script) is inspection, not execution",
  );
  // Executed DIRECTLY in an argv array — coverage.
  assertEquals(
    executingTests("scripts/run-tests.mjs", [
      { rel: "tests/b.test.ts", text: 'new Deno.Command("node", { args: ["scripts/run-tests.mjs"] });' },
    ]),
    ["tests/b.test.ts"],
    "a literal in an argv array is execution",
  );
  // Bound to an identifier that reaches argv — coverage (the real ACP shape).
  assertEquals(
    executingTests("scripts/run-tests.mjs", [{
      rel: "tests/c.test.ts",
      text: 'const S = join(ROOT, "run-tests.mjs");\nconst args = [S];\nnew Deno.Command("node", { args });',
    }]),
    ["tests/c.test.ts"],
    "a bound path reaching an argv position is execution",
  );

  // AGAINST THE REAL TREE, which is what the selector actually reads: the two
  // ACP tests really do spawn acp-service.mjs, and nothing runs the runners.
  const real: Array<{ rel: string; text: string }> = [];
  for (const ent of Deno.readDirSync(`${ROOT}tests`)) {
    if (!ent.isFile || !/\.(test\.ts|mjs|ts)$/.test(ent.name)) continue;
    real.push({ rel: `tests/${ent.name}`, text: Deno.readTextFileSync(`${ROOT}tests/${ent.name}`) });
  }
  assert(referencingTests("scripts/run-tests.mjs", real).length >= 2, "the runner IS mentioned in the real tree");
  // The two REAL spawners of acp-service.mjs are found.
  for (const t of ["tests/acp-service-doctor.test.ts", "tests/acp-service-harness-default.test.ts"]) {
    assert(executingTests("scripts/acp-service.mjs", real).includes(t), `${t} really spawns acp-service.mjs`);
  }

  // A KNOWN LIMIT, asserted rather than hidden. On the real tree
  // executingTests() also returns THIS FILE for run-tests.mjs, acp-service.mjs
  // and a11y-audit.ts — because the fixtures above contain argv-shaped literals
  // like `args: ["scripts/run-tests.mjs"]` as DATA. No text heuristic can
  // separate a fixture string from real code; a test file can bless a script by
  // describing how one would run it.
  //
  // Two reasons that is acceptable, and both are asserted rather than asserted-
  // about:
  //   1. For the files where a wrong answer would be dangerous — the selector's
  //      own machinery — SELECTOR_INFRASTRUCTURE fails closed BY NAME before
  //      coverage is ever consulted, so the self-blessing is inert. Asserted
  //      immediately below, and again in the next test.
  //   2. For every other script the error direction is OVER-selection: a test
  //      that mentions a script in an argv-shaped literal gets run and proves
  //      nothing. That wastes time. It never DROPS a test, which is the failure
  //      this whole mapping exists to prevent.
  assert(
    executingTests("scripts/run-tests.mjs", real).includes("tests/changed-file-mapping.test.ts"),
    "this file's own fixture data reads as execution — the heuristic cannot see intent",
  );
  assertEquals(
    classifyUncovered("scripts/run-tests.mjs", { testFiles: real }).tests,
    [],
    "…and it is INERT: the infrastructure rule fails closed before coverage is consulted",
  );
});

Deno.test("nco2/R1b: the selector's OWN machinery can never be subset-mapped", () => {
  // A subset chosen BY the thing under test cannot validate that thing. Every
  // entry must fail closed with a mechanism that says so — including when a
  // test would otherwise look like coverage.
  for (const rel of SELECTOR_INFRASTRUCTURE) {
    assert(isSelectorInfrastructure(rel), `${rel} is declared infrastructure`);
    const v = classifyUncovered(rel, {
      testFiles: [{ rel: "tests/pretend.test.ts", text: `new Deno.Command("node", { args: ["${rel}"] });` }],
    });
    assertEquals(v.tests, [], `${rel} must never map to a subset, even with an executing test`);
    assert(/OWN machinery/.test(v.mechanism), v.mechanism);
  }
  // Declared-but-absent would be a rule that silently covers nothing.
  for (const rel of SELECTOR_INFRASTRUCTURE) {
    assert(Deno.statSync(`${ROOT}${rel}`).isFile, `${rel} must exist`);
  }
  // The list must name the runner and the picker — the two the mutant proved.
  assert(SELECTOR_INFRASTRUCTURE.includes("scripts/run-tests.mjs"));
  assert(SELECTOR_INFRASTRUCTURE.includes("scripts/select-tests.mjs"));

  // And the CALLER enforces it over the CHANGED set, not the uncovered set:
  // measured, only run-tests.mjs is import-unreachable, so a check living only
  // in classifyUncovered would miss the other four entirely.
  const src = Deno.readTextFileSync(`${ROOT}scripts/select-tests.mjs`);
  assert(
    /changed\.filter\(\(f\) => isSelectorInfrastructure\(f\)\)/.test(src),
    "select-tests.mjs must test the CHANGED set for infrastructure, not the uncovered set",
  );
});

Deno.test("nco2/R1: the REAL repository's spawned-script test is selected for its script", () => {
  // The same property against the actual tree rather than a fixture, so a
  // future test that spawns a script is covered without anyone editing a list.
  const corpus: Array<{ rel: string; text: string }> = [];
  for (const ent of Deno.readDirSync(`${ROOT}tests`)) {
    if (!ent.isFile || !/\.(test\.ts|mjs|ts)$/.test(ent.name)) continue;
    corpus.push({ rel: `tests/${ent.name}`, text: Deno.readTextFileSync(`${ROOT}tests/${ent.name}`) });
  }
  const acp = classifyUncovered("scripts/acp-service.mjs", { testFiles: corpus });
  assert(
    acp.tests.includes("tests/acp-service-harness-default.test.ts"),
    `the test that SPAWNS acp-service.mjs must be selected for it; got ${JSON.stringify(acp.tests)}`,
  );
});

Deno.test("nco2/R3: the CALLER uses the merge-base — a caller-only revert must fail here", async () => {
  // R3, from the same review. My first merge-base test injected git into
  // mergeBaseOf() but never established that changedFiles() USES the returned
  // value. Reverting just the call site from `mergeBaseOf(base)` to `base`,
  // leaving the helper intact, passed all 13 tests — the test's name promised a
  // behaviour it did not bind. That is the exact failure class this file exists
  // to prevent, committed in this file.
  //
  // The fix EXECUTES the real caller: changedFiles is source-extracted and
  // compiled with its collaborators injected (the house pattern from
  // tests/journey-cdp-timeout.test.ts), then the recorded git argv is asserted.
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
    `${helper.replace("export function", "function")}\n${caller}\nreturn changedFiles;`,
  )(fakeGit, (p: string) => p);

  const changed = compiled("origin/main");
  const diffCall = calls.find((c) => c[0] === "diff");
  assert(diffCall, `changedFiles must run a git diff; calls: ${JSON.stringify(calls)}`);
  // THE BINDING ASSERTION. With the caller reverted to `base` this reads
  // "origin/main" and the test fails — which is what the previous version could
  // not detect.
  assertEquals(
    diffCall![2],
    "MERGE_BASE_SHA",
    "the diff must be taken against the MERGE-BASE, not the moving tip ref",
  );
  assert(calls.some((c) => c[0] === "merge-base"), "the caller must ask git for the merge-base");
  assertEquals(changed, ["extension/lib/agent.js"], "the changed set still comes back through the filter");
});

Deno.test("nco2: the mapping is a SUBSET of the full suite, never an invention", () => {
  // Every mapped test must be a real file the full suite also runs. A mapping
  // that names a nonexistent test would quietly select nothing.
  for (const rel of [...HARNESS_TREE_GUARDS, ...BOOKKEEPING_GUARDS]) {
    assert(
      Deno.statSync(`${ROOT}${rel}`).isFile,
      `${rel} must exist — a mapping to a missing test selects nothing and proves nothing`,
    );
  }
});

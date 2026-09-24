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
  HARNESS_TREE_GUARDS,
  isGuardEnumeratedScript,
  mapUncovered,
  referencingTests,
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

Deno.test("nco2: a pure version bump is mappable", () => {
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => o.version = "0.3.475")), true);
  // manifest carries a second version field.
  const man = JSON.stringify({ version: "1.0", version_name: "1.0", permissions: ["storage"] });
  const bumped = JSON.stringify({ version: "1.1", version_name: "1.1", permissions: ["storage"] });
  assertEquals(versionOnlyJsonChange(man, bumped), true);
  // package-lock's root self-entry mirrors the project version.
  const lock = JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" }, "node_modules/ai": { version: "7.0.66" } } });
  const lockBumped = JSON.stringify({ version: "1.1", packages: { "": { version: "1.1" }, "node_modules/ai": { version: "7.0.66" } } });
  assertEquals(versionOnlyJsonChange(lock, lockBumped), true);
});

Deno.test("nco2: a NESTED dependency bump is NOT mappable (the line-grep trap)", () => {
  // mo2f.3 proved a line filter on `"version"` passes a dependency bump exactly
  // as cleanly as a project bump. Parsing both sides is what closes that hole,
  // so this is the assertion that must never be relaxed into a token match.
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => o.dependencies.ai = "9.9.9")), false);
  const lock = JSON.stringify({ version: "1.0", packages: { "": { version: "1.0" }, "node_modules/ai": { version: "7.0.66" } } });
  const sneaky = JSON.stringify({ version: "1.1", packages: { "": { version: "1.1" }, "node_modules/ai": { version: "9.9.9" } } });
  assertEquals(versionOnlyJsonChange(lock, sneaky), false, "a nested dependency bump hidden behind a real version bump");
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
  assertEquals(versionOnlyJsonChange(man, weakenedCsp), false, "a weakened CSP must force the full suite");
  assertEquals(versionOnlyJsonChange(man, newPermission), false, "a new permission must force the full suite");
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
    versionOnlyJsonChange(BASE, withBase((o) => { o.version = "0.3.999"; o.overrides = {}; })),
    false,
    "adding an empty `overrides: {}` is a structural change, not a version bump",
  );
  const manifest = JSON.stringify({ version: "1.0", version_name: "1.0", permissions: ["storage"] });
  assertEquals(
    versionOnlyJsonChange(
      manifest,
      JSON.stringify({ version: "1.1", version_name: "1.1", permissions: ["storage"], web_accessible_resources: [] }),
    ),
    false,
    "adding an empty `web_accessible_resources: []` is a structural change",
  );
  // …including a container that changes TYPE while staying empty.
  assertEquals(
    versionOnlyJsonChange(
      JSON.stringify({ version: "1.0", overrides: {} }),
      JSON.stringify({ version: "1.1", overrides: [] }),
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
    ),
    false,
    "moving a dependency to a dotted top-level key is a real change, not a bump",
  );
  // The same collision with bracket syntax and a real permissions array.
  assertEquals(
    versionOnlyJsonChange(
      manifest,
      JSON.stringify({ version: "1.1", version_name: "1.1", "permissions[0]": "storage" }),
    ),
    false,
    "replacing an array with same-valued indexed keys is a real change",
  );

  // And the ordinary positives still map: key ORDER is not a difference.
  assertEquals(
    versionOnlyJsonChange(
      JSON.stringify({ name: "x", version: "1.0", dependencies: { ai: "7.0.66" } }),
      JSON.stringify({ dependencies: { ai: "7.0.66" }, version: "1.1", name: "x" }),
    ),
    true,
    "reordered keys with only the version moved is still a version-only change",
  );
});

Deno.test("nco2: anything unprovable is NOT mappable (fails closed)", () => {
  assertEquals(versionOnlyJsonChange(BASE, "{not json"), false, "unparseable after");
  assertEquals(versionOnlyJsonChange("{not json", BASE), false, "unparseable before");
  assertEquals(versionOnlyJsonChange(BASE, BASE), false, "identical files are not a version-only CHANGE");
  assertEquals(versionOnlyJsonChange(undefined, BASE), false, "missing side");
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => o.scripts.evil = "rm -rf /")), false, "an added script");
  assertEquals(versionOnlyJsonChange(BASE, withBase((o) => delete o.dependencies.zod)), false, "a removed dependency");
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
  // the basename is still a string literal in the test's source.
  const corpus = [
    { rel: "tests/acp-service-harness-default.test.ts", text: 'const SCRIPT = join(ROOT, "scripts", "acp-service.mjs");' },
    { rel: "tests/unrelated.test.ts", text: "const x = 1;" },
  ];
  assertEquals(referencingTests("scripts/acp-service.mjs", corpus), ["tests/acp-service-harness-default.test.ts"]);

  // THE FIX: an unenumerated script maps to the tests that name it...
  const acp = classifyUncovered("scripts/acp-service.mjs", { testFiles: corpus });
  assertEquals(acp.tests, ["tests/acp-service-harness-default.test.ts"], "the spawning test is selected");
  assert(/do NOT enumerate/.test(acp.mechanism), acp.mechanism);

  // ...and FAILS CLOSED when nothing names it, rather than claiming guard
  // coverage that does not exist. This assertion is what would have caught the
  // original defect.
  const orphan = classifyUncovered("scripts/lib/no-such-helper.mjs", { testFiles: corpus });
  assertEquals(orphan.tests, [], "an unenumerated script with no naming test must fail closed");
  assert(/no test names it/.test(orphan.mechanism), orphan.mechanism);

  // An enumerated script keeps its guards AND gains any naming tests.
  const enumerated = classifyUncovered("scripts/a11y-audit.ts", {
    testFiles: [{ rel: "tests/names-it.test.ts", text: '"a11y-audit.ts"' }],
  });
  assert(enumerated.tests.includes("tests/names-it.test.ts"), "a naming test is added to the guards");
  for (const g of HARNESS_TREE_GUARDS) assert(enumerated.tests.includes(g), `${g} is still selected`);
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

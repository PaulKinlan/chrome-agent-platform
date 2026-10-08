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

import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import {
  BOOKKEEPING_FILES,
  BOOKKEEPING_GUARDS,
  classifyUncovered,
  HARNESS_TREE_GUARDS,
  isGuardEnumeratedScript,
  isScriptsHarness,
  isSelectorInfrastructure,
  mapUncovered,
  SELECTOR_INFRASTRUCTURE,
  VERSION_FIELDS_BY_FILE,
  versionOnlyJsonChange,
} from "../scripts/lib/changed-file-mapping.mjs";
import { mergeBaseOf, versionOnlyAgainst } from "../scripts/select-tests.mjs";

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

Deno.test("nco2: mapUncovered splits mapped from unmappable and carries the reason", () => {
  const { mapped, unmappable } = mapUncovered(
    ["package.json", "extension/manifest.json", "scripts/a11y-audit.ts", "some/unknown-thing.json"],
    (f) => f === "package.json",
  );
  assertEquals(mapped.map((m) => m.file).sort(), ["package.json", "scripts/a11y-audit.ts"]);
  assertEquals(unmappable.map((u) => u.file).sort(), ["extension/manifest.json", "some/unknown-thing.json"]);
  for (const entry of [...mapped, ...unmappable]) {
    assert(entry.mechanism && entry.mechanism.length > 10, `every entry names its mechanism: ${entry.file}`);
  }
  assert(unmappable.length > 0);
});

Deno.test("nco2: every declared guard EXISTS and actually reads the tree it guards", () => {
  assert(
    BOOKKEEPING_GUARDS.includes("tests/first-run-onboarding-composition.test.ts"),
    "BOOKKEEPING_GUARDS must include tests/first-run-onboarding-composition.test.ts to catch cross-file version skew",
  );
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
  for (const rel of BOOKKEEPING_GUARDS) {
    const src = Deno.readTextFileSync(`${ROOT}${rel}`);
    assert(
      BOOKKEEPING_FILES.some((f) => src.includes(f)),
      `${rel} must contain the literal path of a bookkeeping file it is claimed to cover`,
    );
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

Deno.test("nco2/R2-caller: versionOnlyAgainst uses the merge-base and passes rel path", async () => {
  const calls: string[][] = [];
  const fakeGit = (args: string[]) => {
    calls.push(args);
    if (args[0] === "show") return JSON.stringify({ name: "test", version: "0.1.0" });
    return "";
  };

  // Test that versionOnlyAgainst calls git with the expected ref:rel
  const res = versionOnlyAgainst("MERGE_BASE_SHA", "package.json", fakeGit);
  assert(calls.some((c) => c[0] === "show" && c[1] === "MERGE_BASE_SHA:package.json"), "calls git show with ref:path");
});

Deno.test("nco2: the mapping is a SUBSET of the full suite, never an invention", () => {
  for (const rel of [...HARNESS_TREE_GUARDS, ...BOOKKEEPING_GUARDS]) {
    assert(
      Deno.statSync(`${ROOT}${rel}`).isFile,
      `${rel} must exist — a mapping to a missing test selects nothing and proves nothing`,
    );
  }
});

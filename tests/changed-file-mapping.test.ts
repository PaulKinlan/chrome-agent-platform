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
  mapUncovered,
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
  assert(/no test imports/.test(harness.mechanism), harness.mechanism);

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

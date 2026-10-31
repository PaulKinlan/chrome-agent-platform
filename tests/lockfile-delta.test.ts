// tests/lockfile-delta.test.ts — Class-1 lockfile certification (chrome-agent-platform-lezl0,
// contract: ADR chrome-agent-platform-gx0wg; findings ke9rp and fuixm).
//
// THE PROPERTY: a dependency delta is certified by exactly the suite set a machine-checked closure of
// ITS OWN BYTES selects — and anything the classifier cannot name stays FAIL CLOSED with the reason
// named. The dangerous direction is the SUBSET, not the refusal: a version stamp or an integrity pin
// change that wrongly reads as a dependency change is a wasted full suite, but a real dependency
// change that wrongly reads as a version stamp is a subset gate that never looks at the new graph.
// Every pin below therefore comes in both directions, and the mutants at the end prove the pins bite.
//
// INDEPENDENCE: the classifier is pure (bytes in, verdict out) and takes its closure as an argument,
// so nothing here depends on git state, on another agent's tree, or on test order. The two real-repo
// pins read tracked files and build the reverse graph; both are order-free.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DECLARED_PIN_READERS,
  DEPENDENCY_LOCK_GUARDS,
  LOCKFILE_CLASS_FILES,
  LOCKFILE_DELTA_LEDGER_PREFIX,
  classifyLockfileDelta,
  isLockfileClassFile,
  isVersionCounterOnly,
  lockfileDeltaLedgerLines,
  packageNameFromLockPath,
  packageNameFromNpmKey,
  packageNameFromSpecifier,
  RELEASE_IDENTITY_GUARD,
  specifierNamesPackage,
} from "../scripts/lib/lockfile-delta.mjs";
import { LOCKFILE_DELTA_PREFIX as GATE_LOCKFILE_DELTA_PREFIX } from "../scripts/lib/gate-manifest.mjs";
import { SELECTOR_INFRASTRUCTURE } from "../scripts/lib/changed-file-mapping.mjs";
import {
  LOCKFILE_DELTA_REFUSAL,
  ROOT,
  bareSpecifierIndex,
  clearBareSpecifierCache,
  packageImporters,
  planLockfileDelta,
  planRows,
  planSelection,
} from "../scripts/select-tests.mjs";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
const VERSION = "0.0.1";

function bump(o: Record<string, unknown>, version = "9.9.9"): string {
  return JSON.stringify({ ...o, version }, null, 2);
}

function npmLock({ zodVersion = "3.24.0", rootRange = "^3.24.0" } = {}): string {
  return JSON.stringify({
    name: "chrome-agent-platform",
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "chrome-agent-platform", version: VERSION, dependencies: { zod: rootRange } },
      "node_modules/zod": {
        version: zodVersion,
        resolved: `https://registry.npmjs.org/zod/-/zod-${zodVersion}.tgz`,
        integrity: `sha512-${zodVersion}`,
      },
    },
  }, null, 2);
}

function denoLock({
  integrity = "sha512-aa",
  resolved = "3.24.0",
  npmKey = "zod@3.24.0",
  npm = {},
  jsr = {},
  extra = {},
} = {}): string {
  return JSON.stringify({
    version: "5",
    specifiers: { "npm:zod@^3": resolved },
    npm: { [npmKey]: { integrity }, ...npm },
    ...(Object.keys(jsr).length ? { jsr } : {}),
    workspace: { packageJson: { dependencies: ["npm:zod@^3.24.0"] } },
    ...extra,
  }, null, 2);
}

/** A closure that attributes every name to one importer and one suite. */
const closureStub = (importers: Record<string, string[]> = {}, suites: string[] = ["tests/closure.test.ts"]) =>
  (names: string[]) => ({
    importers: Object.fromEntries(names.map((name) => [name, importers[name] ?? []])),
    suites: names.some((name) => (importers[name] ?? []).length) ? suites : [],
    unattributed: names.filter((name) => !(importers[name] ?? []).length),
  });

const CORE = ["tests/security.test.ts", "tests/vocabulary.test.ts"];

// ── the class itself ─────────────────────────────────────────────────────────────────────────
Deno.test("lezl0: the class is the four files, and the classifier is selector infrastructure", () => {
  assertEquals([...LOCKFILE_CLASS_FILES].sort(), [
    "deno.lock",
    "extension/manifest.json",
    "package-lock.json",
    "package.json",
  ]);
  for (const rel of LOCKFILE_CLASS_FILES) assert(isLockfileClassFile(rel), `${rel} is in the class`);
  // A file outside the class never reaches the classifier.
  for (const rel of ["extension/lib/agent.js", "docs/DESIGN.md", "tests/lockfile-delta.test.ts"]) {
    assertEquals(isLockfileClassFile(rel), false, `${rel} is not a lockfile class file`);
  }
  // ADR gx0wg + the selector-machinery rule: editing the classifier must fail closed to the FULL
  // suite, because it decides which suites certify every dependency delta.
  assert(
    SELECTOR_INFRASTRUCTURE.includes("scripts/lib/lockfile-delta.mjs"),
    "the lockfile classifier is part of the selector's own machinery",
  );
  // Review round 1 (finding 1): the class has THREE declared readers, not one. Each is a suite that
  // reads these files BY PATH — no import edge reaches any of them — so a missing one is a silent gap.
  for (const reader of [...DEPENDENCY_LOCK_GUARDS, RELEASE_IDENTITY_GUARD]) {
    assert(existsSync(join(ROOT, reader)), `${reader} is a declared reader and must exist`);
  }
  assert(DEPENDENCY_LOCK_GUARDS.includes("tests/bundle-budget.test.ts"), "bundle-budget parses BOTH locks");
  // The ledger prefix is a fleet contract (log consumers grep it), so the constant and the literal used
  // by tests/gate-manifest.test.ts's parent-tree-RED pin cannot drift apart.
  assertEquals(LOCKFILE_DELTA_LEDGER_PREFIX, "lockfile-delta:");
  // Two constants, one contract: the classifier labels its lines "lockfile-delta:" and the gate log adds
  // its separator ("lockfile-delta: "), so the log prefix must remain the label plus exactly one space.
  assertEquals(GATE_LOCKFILE_DELTA_PREFIX, `${LOCKFILE_DELTA_LEDGER_PREFIX} `);
  assertEquals(RELEASE_IDENTITY_GUARD, "tests/first-run-onboarding-composition.test.ts");
});

Deno.test("lezl0: name extraction reads lock paths, npm keys and specifiers (scoped, subpath, scheme)", () => {
  assertEquals(packageNameFromLockPath("node_modules/@scope/x"), "@scope/x");
  assertEquals(packageNameFromLockPath("node_modules/a/node_modules/b"), "b");
  assertEquals(packageNameFromLockPath(""), null, "the root entry names no package");
  assertEquals(packageNameFromNpmKey("@ai-sdk/anthropic@4.0.45_zod@3.25.76"), "@ai-sdk/anthropic");
  assertEquals(packageNameFromNpmKey("zod@3.25.76"), "zod");
  assertEquals(packageNameFromSpecifier("npm:@ai-sdk/provider@4.0.8"), "@ai-sdk/provider");
  assertEquals(packageNameFromSpecifier("@std/assert@1"), "@std/assert");
  assertEquals(packageNameFromSpecifier("jsr:@scope/pkg@1"), "@scope/pkg");
  assertEquals(packageNameFromSpecifier("pkg/sub"), "pkg");
  assertEquals(packageNameFromSpecifier("./relative.js"), null);
  assertEquals(packageNameFromSpecifier("https://deno.land/x/a/mod.ts"), null);
  assert(specifierNamesPackage("zod", "zod"));
  assert(specifierNamesPackage("zod/v4", "zod"));
  assert(specifierNamesPackage("npm:zod@^3", "zod"));
  assert(specifierNamesPackage("jsr:@std/assert@1", "@std/assert"));
  assertEquals(specifierNamesPackage("zodx", "zod"), false, "a prefix is not the package");
  assertEquals(specifierNamesPackage("zod-fork", "zod"), false);
});

// ── 1. the landing stamp ─────────────────────────────────────────────────────────────────────
Deno.test("lezl0: a version-counter-only trio is PASSIVE bookkeeping — a subset, never the full suite", () => {
  const pkg = { name: "chrome-agent-platform", version: VERSION, dependencies: { zod: "^3.24.0" } };
  const lock = JSON.parse(npmLock());
  const lockBump = { ...lock, version: "9.9.9", packages: { ...lock.packages, "": { ...lock.packages[""], version: "9.9.9" } } };
  const manifest = { manifest_version: 3, name: "Chrome Agent Platform", version: VERSION };

  for (const [rel, base, tip] of [
    ["package.json", JSON.stringify(pkg), bump(pkg)],
    ["package-lock.json", JSON.stringify(lock), JSON.stringify(lockBump)],
    ["extension/manifest.json", JSON.stringify(manifest), bump(manifest)],
  ] as const) {
    assertEquals(isVersionCounterOnly(rel, { base, tip }), true, `${rel}: a version stamp is not a dependency change`);
  }

  const verdict = classifyLockfileDelta({
    packageJson: { base: JSON.stringify(pkg), tip: bump(pkg) },
    packageLock: { base: JSON.stringify(lock), tip: JSON.stringify(lockBump) },
    manifest: { base: JSON.stringify(manifest), tip: bump(manifest) },
  }, { coreSuites: CORE });
  assertEquals(verdict.kind, "subset", "a landing stamp must never cost the full suite");
  assertEquals(verdict.passive, true);
  assertEquals(verdict.packages, [], "no package changed");
  assertEquals(verdict.suites, [...CORE, RELEASE_IDENTITY_GUARD].sort(), "always-on + the release-identity reader");
  assert(verdict.suites.includes(RELEASE_IDENTITY_GUARD), "the stamp's real reader is selected (finding 1)");
  for (const guard of DEPENDENCY_LOCK_GUARDS) {
    assert(!verdict.suites.includes(guard), `no dependency reader is owed for a stamp: ${guard}`);
  }
  assertStringIncludes(verdict.notes.join("\n"), "version-counter-only");
});

Deno.test("lezl0: DECLARED_PIN_READERS matches what the readers actually assert (drift pin)", () => {
  // The declared-reader table is the ONLY thing that lets an entry with no importer be certified, so it
  // is exactly the kind of list that rots: a new row in a reader's patch table must arrive here in the
  // same commit, and a row here must point at a reader that really names that package. Both directions
  // are computed from the readers' own source rather than restated.
  const locksSrc = readFileSync(join(ROOT, "tests/security-dependency-locks.test.ts"), "utf8");
  const budgetSrc = readFileSync(join(ROOT, "tests/bundle-budget.test.ts"), "utf8");

  const patchedRows = [...locksSrc.matchAll(/\{\s*name:\s*"([^"]+)",\s*floor:/g)].map((m) => m[1]);
  assert(patchedRows.length >= 4, `the behrd patch table must be found: ${patchedRows.join(", ")}`);
  const lockPackages = [...locksSrc.matchAll(/packages\["node_modules\/([^"]+)"\]/g)].map((m) => m[1]);
  const budgetPackages = [...budgetSrc.matchAll(/packages\["node_modules\/([^"]+)"\]/g)].map((m) => m[1]);

  const expected = [...new Set([...patchedRows, ...lockPackages, ...budgetPackages])].sort();
  assertEquals(
    [...Object.keys(DECLARED_PIN_READERS)].sort(),
    expected,
    "every entry a reader asserts is declared, and every declared entry is really asserted",
  );
  // Each declared suite must be a reader that ASKED about that package, not just any reader.
  for (const [name, readers] of Object.entries(DECLARED_PIN_READERS)) {
    for (const reader of readers) {
      const src = reader === "tests/bundle-budget.test.ts" ? budgetSrc : locksSrc;
      assert(
        src.includes(`node_modules/${name}`) || src.includes(`name: "${name}"`),
        `${reader} must really assert ${name}`,
      );
    }
  }
});

Deno.test("lezl0: a REAL landing stamp is passive — the exact counter set bump-version.mjs writes", () => {
  // This pin replicates scripts/bump-version.mjs's stamp against the REAL files on disk, because a
  // synthetic trio is exactly how the first version of this module missed a field: the merger's stamp
  // also rewrites extension/manifest.json's `version_name`, so a real landing classified as
  // "field 'version_name' changed" and escalated the landing itself back to the FULL suite. The
  // source assertions below fail loudly if the stamp grows a field the classifier has not been taught.
  const src = readFileSync(join(ROOT, "scripts/bump-version.mjs"), "utf8");
  for (const assignment of [
    "pkg.version = next",
    "lock.version = next",
    'lock.packages[""].version = next',
    "manifest.version = next",
    "manifest.version_name = next",
  ]) {
    assertStringIncludes(src, assignment);
  }

  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const manifest = JSON.parse(read("extension/manifest.json"));
  const next = "99.0.0";

  const pkgTip = { ...pkg, version: next };
  const lockTip = { ...lock, version: next, packages: { ...lock.packages, "": { ...lock.packages[""], version: next } } };
  const manifestTip = { ...manifest, version: next, version_name: next };

  const verdict = classifyLockfileDelta({
    packageJson: { base: JSON.stringify(pkg), tip: JSON.stringify(pkgTip) },
    packageLock: { base: JSON.stringify(lock), tip: JSON.stringify(lockTip) },
    manifest: { base: JSON.stringify(manifest), tip: JSON.stringify(manifestTip) },
  }, { coreSuites: CORE });
  assertEquals(verdict.kind, "subset", `a real landing stamp must not escalate: ${verdict.reason}`);
  assertEquals(verdict.passive, true);
  assertEquals(verdict.suites, [...CORE, RELEASE_IDENTITY_GUARD].sort(), "always-on + the release-identity reader");

  // The manifest counter is only passive as a COUNTER: anything else in it still refuses.
  const widened = classifyLockfileDelta({
    manifest: { base: JSON.stringify(manifest), tip: JSON.stringify({ ...manifestTip, version_name: next, permissions: [...(manifest.permissions ?? []), "tabs"] }) },
  }, { coreSuites: CORE });
  assertEquals(widened.kind, "full", "a permission change inside the same file still fails closed");
});

// ── 2. an npm package set change ─────────────────────────────────────────────────────────────
Deno.test("lezl0: an npm package bump selects its importer closure + the declared-reader guard + core", () => {
  const closure = closureStub({ zod: ["extension/lib/agent.js"] });
  const verdict = classifyLockfileDelta(
    { packageLock: { base: npmLock(), tip: npmLock({ zodVersion: "3.25.0" }) } },
    { coreSuites: CORE, closureFor: closure },
  );
  assertEquals(verdict.kind, "subset");
  assertEquals(verdict.packages, ["zod"], "the changed package is named");
  assertEquals(verdict.importers.zod, ["extension/lib/agent.js"]);
  for (const suite of [...CORE, ...DEPENDENCY_LOCK_GUARDS, "tests/closure.test.ts"]) {
    assert(verdict.suites.includes(suite), `the verdict must select ${suite}: ${verdict.suites.join(", ")}`);
  }
  assertEquals(
    verdict.suites.length,
    CORE.length + DEPENDENCY_LOCK_GUARDS.length + 1,
    "every declared reader + the closure, nothing invented",
  );
});

Deno.test("lezl0: the ledger names package -> importers -> suites", () => {
  const verdict = classifyLockfileDelta(
    { packageLock: { base: npmLock(), tip: npmLock({ zodVersion: "3.25.0" }) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  const lines = lockfileDeltaLedgerLines({ verdict, files: ["package-lock.json"], suites: verdict.suites });
  assert(lines.length >= 2, "one line per package plus a summary");
  for (const line of lines) assertStringIncludes(line, LOCKFILE_DELTA_LEDGER_PREFIX);
  assertStringIncludes(lines[0], "zod");
  assertStringIncludes(lines[0], "extension/lib/agent.js");
  assertStringIncludes(lines[0], "importers:");
  assertStringIncludes(lines.at(-1)!, "suite(s) selected");
});

Deno.test("lezl0: a dependency bump that rides with the landing stamp is still a dependency delta", () => {
  const lock = JSON.parse(npmLock());
  const stamped = {
    ...lock,
    version: "9.9.9",
    packages: {
      ...lock.packages,
      "": { ...lock.packages[""], version: "9.9.9" },
      "node_modules/zod": { ...lock.packages["node_modules/zod"], version: "3.25.0", integrity: "sha512-3.25.0" },
    },
  };
  const verdict = classifyLockfileDelta(
    { packageLock: { base: JSON.stringify(lock), tip: JSON.stringify(stamped) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  assertEquals(verdict.kind, "subset");
  assertEquals(verdict.passive, false, "a stamp riding along must not hide the dependency change");
  assertEquals(verdict.packages, ["zod"]);
});

// ── 3. deno.lock ─────────────────────────────────────────────────────────────────────────────
Deno.test("lezl0 ROUND 2: a HASH-ONLY change is FULL — no suite verifies lockfile bytes (the reviewer's case)", () => {
  // Coord's ruling on review round 2, from the reviewer's own counterexample: change
  // packages["node_modules/zod"].integrity to a different hash at the same version and every reader
  // still passes — they compare versions, integrity PRESENCE and advisory floors, never a hash value.
  // Nothing runs `npm ci`; deno.runner.jsonc sets "lock": false. So this is FULL, named, not a subset.
  const lock = JSON.parse(npmLock());
  const repinned = JSON.parse(JSON.stringify(lock));
  repinned.packages["node_modules/zod"] = { ...repinned.packages["node_modules/zod"], integrity: "sha512-different" };
  const verdict = classifyLockfileDelta(
    { packageLock: { base: npmLock(), tip: JSON.stringify(repinned) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  assertEquals(verdict.kind, "full", "an identical version with a different hash is not certifiable by a subset");
  assertStringIncludes(verdict.reason, "integrity/hash-only");
  assertStringIncludes(verdict.reason, "zod");
  assert(verdict.unresolved.includes("zod"), "the refusal names the entry");
});

Deno.test("lezl0 ROUND 2: an importer does NOT make a hash-only change certifiable (naming is not inspection)", () => {
  // The second half of the ruling: the previous revision NAMED a hash-only entry and treated the name
  // as inspection. An importer runs the code, and the code does not check the pin, so this stays FULL.
  const verdict = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ integrity: "sha512-bb" }) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  assertEquals(verdict.kind, "full");
  assertStringIncludes(verdict.reason, "zod");
});

Deno.test("lezl0 ROUND 2: a JSR hash-only change is FULL, and so is a remote URL re-pin", () => {
  const base = denoLock({ jsr: { "@std/assert@1.0.0": { integrity: "aaa" } } });
  const tip = denoLock({ jsr: { "@std/assert@1.0.0": { integrity: "bbb" } } });
  const jsr = classifyLockfileDelta(
    { denoLock: { base, tip } },
    { coreSuites: CORE, closureFor: closureStub({ "@std/assert": ["tests/assert-user.test.ts"] }) },
  );
  assertEquals(jsr.kind, "full", "a jsr hash move has no verifying suite either");
  assertStringIncludes(jsr.reason, "@std/assert");

  const remote = classifyLockfileDelta(
    {
      denoLock: {
        base: denoLock({ extra: { remote: { "https://deno.land/x/thing@1/mod.ts": "aaaa" } } }),
        tip: denoLock({ extra: { remote: { "https://deno.land/x/thing@1/mod.ts": "bbbb" } } }),
      },
    },
    { coreSuites: CORE, closureFor: closureStub({}) },
  );
  assertEquals(remote.kind, "full", "a value-only remote re-pin is bytes-only");
  assertStringIncludes(remote.reason, "deno.land");
});

Deno.test("lezl0 ROUND 2: a VERSION bump stays on the fast path — attributable, with or without importers", () => {
  // The win the ruling protects: version/declaration deltas are certifiable. zod has real importers;
  // undici has none but IS version-asserted by its reader's advisory floor (DECLARED_PIN_READERS).
  const withImporters = classifyLockfileDelta(
    { packageLock: { base: npmLock(), tip: npmLock({ zodVersion: "3.25.0" }) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  assertEquals(withImporters.kind, "subset", withImporters.reason);
  assert(withImporters.suites.includes("tests/closure.test.ts"));

  const pinsOnly = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ npm: { "undici@7.29.2": { integrity: "sha512-u2" } } }) } },
    { coreSuites: CORE, closureFor: closureStub({}) },
  );
  assertEquals(pinsOnly.kind, "subset", pinsOnly.reason);
  assertStringIncludes(pinsOnly.notes.join("\n"), "inspected by tests/security-dependency-locks.test.ts");
});

Deno.test("lezl0: a deno.lock specifier change resolves the changed name to its importer closure", () => {
  const seen: string[][] = [];
  const verdict = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ resolved: "3.25.0" }) } },
    {
      coreSuites: CORE,
      closureFor: (names: string[]) => {
        seen.push(names);
        return closureStub({ zod: ["extension/lib/agent.js"] })(names);
      },
    },
  );
  assertEquals(verdict.kind, "subset");
  assertEquals(verdict.integrityOnly, false);
  assert(seen.length === 1 && seen[0].includes("zod"), `the closure must be asked about zod: ${JSON.stringify(seen)}`);
  assert(verdict.suites.includes("tests/closure.test.ts"), "the importer closure is selected");
  for (const guard of DEPENDENCY_LOCK_GUARDS) assert(verdict.suites.includes(guard));
});

Deno.test("lezl0: a package.json DECLARATION change selects the declared name's importer closure (follow-up pin)", () => {
  // The review's other missing pin: a declaration-only delta (no lock movement) must still name the
  // package and select what imports it — the closure comes from the declaration, not from a lock entry.
  const pkg = { name: "chrome-agent-platform", version: VERSION, dependencies: { zod: "^3.24.0" } };
  const declared = { ...pkg, dependencies: { zod: "^3.25.0" } };
  const verdict = classifyLockfileDelta(
    { packageJson: { base: JSON.stringify(pkg), tip: JSON.stringify(declared) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  assertEquals(verdict.kind, "subset");
  assertEquals(verdict.packages, ["zod"]);
  assert(verdict.suites.includes("tests/closure.test.ts"), "the declaration's package resolves to its importers");

  // And the same declaration with no importer anywhere is refused, not assumed covered.
  const refused = classifyLockfileDelta(
    { packageJson: { base: JSON.stringify(pkg), tip: JSON.stringify(declared) } },
    { coreSuites: CORE, closureFor: closureStub({}) },
  );
  assertEquals(refused.kind, "full");
  assertStringIncludes(refused.reason, "zod");
});

Deno.test("lezl0: an unattributed VERSION change is certified only by a declared reader that asserts it", () => {
  // Review round 1, finding 2: the old blanket "no importer -> the guard certifies it" was not earned —
  // the guard asserts its OWN tables. So an unattributed entry now needs a declared reader that names it.
  // undici IS in the readers' tables (the behrd patch table, with a fix floor), @types/node is NOT.
  const undici = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ npm: { "undici@7.29.1": { integrity: "sha512-u" } } }) } },
    { coreSuites: CORE, closureFor: closureStub({}) },
  );
  assertEquals(undici.kind, "subset", "a table entry has a suite that asserts its version");
  assertStringIncludes(undici.notes.join("\n"), "inspected by tests/security-dependency-locks.test.ts");

  const typesOnly = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ npm: { "@types/node@24.13.3": { integrity: "sha512-t" } } }) } },
    { coreSuites: CORE, closureFor: closureStub({}) },
  );
  assertEquals(typesOnly.kind, "full", "an entry no suite inspects is refused, not assumed covered");
  assertStringIncludes(typesOnly.reason, "@types/node");
});

Deno.test("lezl0: a transitive pin is attributed to the suite that executes its DEPENDENT", () => {
  // (b) of the inspection rule: the lock's own dependency edges are the evidence. `zod` here has no
  // importer, but `agent-tools` depends on it and IS imported — so the change is covered by that code.
  const lock = npmLock();
  const withDependent = JSON.parse(lock);
  withDependent.packages["node_modules/agent-tools"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/agent-tools/-/agent-tools-1.0.0.tgz",
    integrity: "sha512-agent",
    dependencies: { zod: "^3.24.0" },
  };
  const tip = JSON.parse(JSON.stringify(withDependent));
  tip.packages["node_modules/zod"] = { ...tip.packages["node_modules/zod"], version: "3.25.0", integrity: "sha512-3.25.0" };

  const verdict = classifyLockfileDelta(
    { packageLock: { base: JSON.stringify(withDependent), tip: JSON.stringify(tip) } },
    { coreSuites: CORE, closureFor: closureStub({ "agent-tools": ["extension/lib/agent-loop.js"] }) },
  );
  assertEquals(verdict.kind, "subset", "the dependent's importers cover the transitive pin");
  assertEquals(verdict.viaDependent.zod, "agent-tools");
  assertStringIncludes(verdict.notes.join("\n"), "reached through its dependent agent-tools");
  assert(verdict.suites.includes("tests/closure.test.ts"), "the dependent's closure is selected");
});

Deno.test("lezl0: a remote URL or jsr entry with no importer is FULL — no guard reads those bytes", () => {
  for (const [label, tip] of [
    ["remote", denoLock({ extra: { remote: { "https://deno.land/x/thing@1/mod.ts": "deadbeef" } } })],
    ["jsr", denoLock({ extra: { jsr: { "@std/unused@1.0.0": { integrity: "abc" } } } })],
  ] as const) {
    const verdict = classifyLockfileDelta(
      { denoLock: { base: denoLock(), tip } },
      { coreSuites: CORE, closureFor: closureStub({}) },
    );
    assertEquals(verdict.kind, "full", `${label}: an unattributable edge section must refuse`);
    assertStringIncludes(verdict.reason, "no suite in a subset would inspect");
    assert(verdict.unresolved.length > 0, "the refusal names what could not be resolved");
  }
});

// ── 4. refusals, named ──────────────────────────────────────────────────────────────────────
Deno.test("lezl0: an unparseable, conflicted, one-sided or format-changed lock is FULL with the side named", () => {
  const cases: Array<[string, object, RegExp]> = [
    ["unparseable base", { denoLock: { base: "{", tip: denoLock() } }, /base side is unparseable/],
    ["unparseable tip", { packageLock: { base: npmLock(), tip: '{"packages":' } }, /tip side is unparseable/],
    ["merge-marked", { denoLock: { base: denoLock(), tip: "<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> x\n" } }, /merge-conflict markers/],
    ["deleted", { denoLock: { base: denoLock(), tip: null } }, /deleted in this delta/],
    ["added", { packageLock: { base: null, tip: npmLock() } }, /added in this delta/],
    ["format version", { denoLock: { base: denoLock(), tip: denoLock({ extra: { version: "6" } }) } }, /format version/],
  ];
  for (const [label, delta, pattern] of cases) {
    const verdict = classifyLockfileDelta(delta, { coreSuites: CORE });
    assertEquals(verdict.kind, "full", `${label} must refuse`);
    assert(pattern.test(verdict.reason), `${label}: reason must name the cause: ${verdict.reason}`);
    assertEquals(verdict.suites, [], `${label}: a refusal selects nothing`);
  }
});

Deno.test("lezl0: a manifest delta beyond the version counter, and a package.json field beyond deps/version, stay FULL", () => {
  const manifest = { manifest_version: 3, version: VERSION, permissions: ["storage"] };
  const widened = { ...manifest, permissions: ["storage", "tabs"] };
  const manifestVerdict = classifyLockfileDelta(
    { manifest: { base: JSON.stringify(manifest), tip: JSON.stringify(widened) } },
    { coreSuites: CORE },
  );
  assertEquals(manifestVerdict.kind, "full", "v1 does not widen the manifest class");
  assertStringIncludes(manifestVerdict.reason, "permissions");

  const pkg = { name: "chrome-agent-platform", version: VERSION, scripts: { test: "deno test" } };
  const scripts = { ...pkg, scripts: { test: "rm -rf /" } };
  const scriptsVerdict = classifyLockfileDelta(
    { packageJson: { base: JSON.stringify(pkg), tip: JSON.stringify(scripts) } },
    { coreSuites: CORE },
  );
  assertEquals(scriptsVerdict.kind, "full", "a scripts change is not a dependency delta");
  assertStringIncludes(scriptsVerdict.reason, "scripts");
});

// ── 5. mutants: prove the pins above bite ───────────────────────────────────────────────────
Deno.test("lezl0 MUTANT: dropping a closure edge or the declared-reader guard is caught here", () => {
  const base = { packageLock: { base: npmLock(), tip: npmLock({ zodVersion: "3.25.0" }) } };

  // The live verdict selects the closure edge.
  const live = classifyLockfileDelta(base, { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) });
  assert(live.suites.includes("tests/closure.test.ts"), "the live verdict carries the closure edge");

  // MUTANT 1: the closure resolves the package to nothing (a dropped reverse-import edge). The pin
  // above asserts the suite IS selected, so this mutant is red exactly there.
  const droppedEdge = classifyLockfileDelta(base, { coreSuites: CORE, closureFor: closureStub({}) });
  assert(!droppedEdge.suites.includes("tests/closure.test.ts"), "a dropped edge loses the suite — the pin catches it");

  // MUTANT 2: the guard is dropped from the selection. Both the npm and the integrity-only pins assert
  // it is present, so this mutant is red there.
  const noGuard = classifyLockfileDelta(base, {
    coreSuites: CORE,
    dependencyGuards: [],
    closureFor: closureStub({ zod: ["extension/lib/agent.js"] }),
  });
  for (const guard of DEPENDENCY_LOCK_GUARDS) {
    assert(!noGuard.suites.includes(guard), `dropping the readers loses ${guard} — the pins catch it`);
  }

  // MUTANT 3: the guard is not smuggled in through core either, so the pins are pinning the CLASSIFIER
  // and not an accident of the always-on set.
  for (const guard of DEPENDENCY_LOCK_GUARDS) {
    assert(!CORE.includes(guard), `${guard} is not always-on: the classifier must select it`);
  }
});

Deno.test("lezl0 MUTANT: a real dependency change can never be read as a version-counter stamp", () => {
  const lock = JSON.parse(npmLock());
  const realChange = {
    ...lock,
    packages: {
      ...lock.packages,
      "node_modules/zod": { ...lock.packages["node_modules/zod"], version: "3.25.0" },
    },
  };
  assertEquals(
    isVersionCounterOnly("package-lock.json", { base: JSON.stringify(lock), tip: JSON.stringify(realChange) }),
    false,
    "a version change inside packages[] is a dependency change, not a stamp",
  );

  // A declaration change in the root entry is a dependency change too.
  const rangeChange = JSON.parse(npmLock({ rootRange: "^3.25.0" }));
  assertEquals(
    isVersionCounterOnly("package-lock.json", { base: JSON.stringify(lock), tip: JSON.stringify(rangeChange) }),
    false,
  );

  // And a package.json scripts change is never a stamp (the whole file would have to match).
  const pkg = { version: VERSION, scripts: { a: "b" } };
  assertEquals(
    isVersionCounterOnly("package.json", { base: JSON.stringify(pkg), tip: JSON.stringify({ ...pkg, version: "9.9.9", scripts: { a: "c" } }) }),
    false,
  );

  // The classifier agrees end-to-end: a stamp classifier that had gone blind would return passive.
  const verdict = classifyLockfileDelta(
    { packageLock: { base: JSON.stringify(lock), tip: JSON.stringify(realChange) } },
    { coreSuites: CORE, closureFor: closureStub({ zod: ["extension/lib/agent.js"] }) },
  );
  assertEquals(verdict.passive, false);
  assertEquals(verdict.kind, "subset");
});

// ── 6. the selector wiring ──────────────────────────────────────────────────────────────────
Deno.test("lezl0: the certifying set adds the DIRECT READERS computed by referrersFor (amendment 2026-10-31)", () => {
  // The architect's amendment: for an ATTRIBUTABLE delta the certifying set is enumerable by
  // construction — always-on + the direct readers the repo can compute + the attributed closure. The
  // declared readers are the pinned core; referrersFor finds the rest (every suite that names the path),
  // which is exactly the population review round 1 had to find by hand.
  const verdict = classifyLockfileDelta(
    { packageLock: { base: npmLock(), tip: npmLock({ zodVersion: "3.25.0" }) } },
    {
      coreSuites: CORE,
      referrerSuites: ["tests/owed-changelog-ledger.test.ts"],
      closureFor: closureStub({ zod: ["extension/lib/agent.js"] }),
    },
  );
  assert(verdict.suites.includes("tests/owed-changelog-ledger.test.ts"), "a computed reader is selected");
  assertStringIncludes(verdict.notes.join("\n"), "direct readers");

  // The population is COMPUTED, so it cannot be a hand-written list that rots: planLockfileDelta with
  // the real tree must select the suites that really read these files.
  const plan = planLockfileDelta(["package-lock.json"], {
    mergeBase: "cafebabe",
    readBase: () => npmLock(),
    readTip: () => npmLock({ zodVersion: "3.25.0" }),
    reverse: null,
    coreSuites: CORE,
    closureFor: closureStub({ zod: ["extension/lib/agent.js"] }),
  });
  for (const reader of [
    DEPENDENCY_LOCK_GUARDS[0],
    "tests/bundle-budget.test.ts",
    "tests/first-run-onboarding-composition.test.ts",
  ]) {
    assert(plan!.mapped[0].tests.includes(reader), `${reader} reads package-lock.json and must be selected`);
  }
});

Deno.test("lezl0: planLockfileDelta turns bytes into the same mapped/unmappable rows every class uses", () => {
  const lock = npmLock();
  const bumped = npmLock({ zodVersion: "3.25.0" });

  const stamped = JSON.parse(lock);
  const passiveTip = {
    ...stamped,
    version: "9.9.9",
    packages: { ...stamped.packages, "": { ...stamped.packages[""], version: "9.9.9" } },
  };
  const passive = planLockfileDelta(["package-lock.json"], {
    mergeBase: "cafebabe",
    referrers: () => [],
    readBase: () => lock,
    readTip: () => JSON.stringify(passiveTip),
    reverse: null,
    coreSuites: CORE,
    closureFor: closureStub({}),
  });
  assert(passive, "a lockfile change produces a plan");
  assertEquals(passive!.unmappable, [], "an unchanged lock certifies to a subset");
  assertEquals(passive!.mapped.length, 1, "the lockfile is mapped, not unmappable");
  assertEquals(passive!.mapped[0].file, "package-lock.json");
  assertEquals(
    passive!.mapped[0].tests,
    [...CORE, RELEASE_IDENTITY_GUARD].sort(),
    "a passive stamp maps to the always-on set plus its release-identity reader",
  );

  const subset = planLockfileDelta(["package-lock.json"], {
    mergeBase: "cafebabe",
    referrers: () => [],
    readBase: () => lock,
    readTip: () => bumped,
    reverse: null,
    coreSuites: CORE,
    closureFor: closureStub({ zod: ["extension/lib/agent.js"] }),
  });
  for (const guard of DEPENDENCY_LOCK_GUARDS) assert(subset!.mapped[0].tests.includes(guard), `${guard} is in the mapped row`);
  assert(subset!.ledger.some((line) => line.startsWith(LOCKFILE_DELTA_LEDGER_PREFIX)), "the ledger trail is emitted");

  const refused = planLockfileDelta(["deno.lock"], {
    mergeBase: "cafebabe",
    readBase: () => "{",
    readTip: () => "{}",
    reverse: null,
    coreSuites: CORE,
  });
  assertEquals(refused!.mapped, []);
  assertEquals(refused!.unmappable.length, 1);
  assert(
    refused!.unmappable[0].mechanism.startsWith(LOCKFILE_DELTA_REFUSAL),
    `the refusal must say it is a coverage policy, not a test failure: ${refused!.unmappable[0].mechanism}`,
  );
  assertStringIncludes(refused!.unmappable[0].mechanism, "unparseable");

  assertEquals(planLockfileDelta(["extension/lib/agent.js"], { mergeBase: "cafebabe" }), null, "no lockfile, no cost");
});

Deno.test("lezl0 REGRESSION: a lockfile refusal survives the row merge even with no import-graph rows", () => {
  // The exact fail-open this pin exists for: the class files are removed from `uncovered`, so a
  // lockfile REFUSAL arrives with an empty import-graph row list. A conditional merge dropped it and
  // the plan reported `kind: "subset"` with no rows at all — a fail-open on the one case the class
  // exists to refuse (found in end-to-end verification, 2026-10-28).
  const refused = planLockfileDelta(["deno.lock"], {
    mergeBase: "cafebabe",
    readBase: () => "{",
    readTip: () => "{}",
    reverse: null,
    coreSuites: CORE,
  });
  const merged = planRows({ importRows: { mapped: [], unmappable: [] }, lockfile: refused });
  assertEquals(merged.mapped, []);
  assertEquals(merged.unmappable.length, 1, "the refusal must survive an empty import-graph list");
  assertEquals(merged.unmappable[0].file, "deno.lock");

  // And the happy path still merges both sides.
  const subset = planLockfileDelta(["package-lock.json"], {
    mergeBase: "cafebabe",
    readBase: () => npmLock(),
    readTip: () => npmLock({ zodVersion: "3.25.0" }),
    reverse: null,
    coreSuites: CORE,
    closureFor: closureStub({ zod: ["extension/lib/agent.js"] }),
  });
  const both = planRows({
    importRows: { mapped: [{ file: "scripts/x.mjs", mechanism: "m", tests: ["tests/x.test.ts"] }], unmappable: [] },
    lockfile: subset,
  });
  assertEquals(both.mapped.length, 2, "import-graph rows and the lockfile row both survive");
  assertEquals(both.unmappable, []);
});

Deno.test("lezl0: planSelection EXECUTES the lockfile refusal path (subset vs FULL, end to end)", () => {
  // This pin exists because a branch of this very change shipped a ReferenceError inside the refusal
  // branch: every unit pin above passed, and `node --check` cannot see an undefined variable, so the
  // assembly that decides subset-vs-refusal had never RUN in a test. The git-bound steps are injectable
  // precisely so this path is executed without depending on the tree another agent has open.
  const blocked = planSelection({
    base: "HEAD",
    changedFiles: () => ["deno.lock"],
    reverseGraph: () => new Map(),
    lockfileOptions: { mergeBase: "cafebabe", readBase: () => "{", readTip: () => "{}" },
  });
  assertEquals(blocked.kind, "full", "an unparseable lockfile REFUSES the subset");
  assertEquals(blocked.files, null);
  assertEquals(blocked.unmappable.map((u: { file: string }) => u.file), ["deno.lock"]);
  assertStringIncludes(blocked.reason, "lockfile delta not certifiable");
  assertStringIncludes(blocked.failClosedHeader!, "dependency-lock delta");
  assert(blocked.lockfileDelta.length > 0, "the refusal carries its ledger trail");

  // The certifiable direction through the SAME assembly: a passive stamp is a subset, mapped.
  const stamped = `{"name":"chrome-agent-platform","version":"9.9.9","lockfileVersion":3,"packages":{"":{"name":"chrome-agent-platform","version":"9.9.9"}}}`;
  const base = `{"name":"chrome-agent-platform","version":"0.0.1","lockfileVersion":3,"packages":{"":{"name":"chrome-agent-platform","version":"0.0.1"}}}`;
  const certified = planSelection({
    base: "HEAD",
    changedFiles: () => ["package-lock.json"],
    reverseGraph: () => new Map(),
    lockfileOptions: { mergeBase: "cafebabe", readBase: () => base, readTip: () => stamped },
  });
  assertEquals(certified.kind, "subset", "a version stamp certifies to a subset");
  assertEquals(certified.unmappable, []);
  assertEquals(certified.mapped.map((m: { file: string }) => m.file), ["package-lock.json"]);
  // Amendment 2026-10-31: the certifying set is always-on + the DIRECT READERS computed by referrersFor
  // + the closure. tests/security-dependency-locks.test.ts names package-lock.json, so it is a computed
  // reader of a stamp too — the class does not have to hand-list it, and it is not the full suite.
  assert(certified.files!.includes(RELEASE_IDENTITY_GUARD), "a stamp is certified by its release-identity reader");
  assert(
    certified.files!.length < 200,
    `a stamp must stay a subset, not a sweep: ${certified.files!.length} files`,
  );
  assert(certified.files!.length > 0, "the always-on set still runs");
});

Deno.test("lezl0: a real package bump resolves real repo importers through the bare-specifier index", () => {
  clearBareSpecifierCache();
  const lock = readFileSync(join(ROOT, "package-lock.json"), "utf8");
  const doc = JSON.parse(lock);
  assert(doc.packages["node_modules/zod"], "zod is a direct dependency this pin can bump");
  const bumped = JSON.parse(lock);
  bumped.packages["node_modules/zod"] = {
    ...bumped.packages["node_modules/zod"],
    version: "3.25.0",
    resolved: "https://registry.npmjs.org/zod/-/zod-3.25.0.tgz",
    integrity: "sha512-lezl0-fixture",
  };

  // The index finds REAL importers of a bare specifier. This is the half the reverse graph cannot
  // supply: it records only relative edges, so without this index a package bump resolves to nothing
  // and the closure would be a fiction.
  const importers = packageImporters(["zod"]);
  assert(importers.zod.length > 0, "zod is imported by repo source");
  assert(
    importers.zod.includes("extension/lib/agent.js"),
    `expected extension/lib/agent.js among ${importers.zod.slice(0, 5).join(", ")}`,
  );
  assert(bareSpecifierIndex().size > 0, "the index is populated from the tree");
  // A package nobody imports is not attributed, so the fail-open rule (guard only) stays honest.
  const unattributed = packageImporters(["@levl0/never-imported"]);
  assertEquals(unattributed["@levl0/never-imported"], [], "a package nobody imports has no importer");

  // The reverse-import closure half, over a one-edge graph of REAL files (extension/lib/agent.js is
  // imported by tests/agent-abort.test.ts). Deliberately not the whole graph: buildReverseGraph costs
  // ~26s on a loaded fleet box and tests/select-tests.test.ts already pins the walk itself.
  const reverse = new Map<string, Set<string>>([
    [resolve(ROOT, "extension/lib/agent.js"), new Set([resolve(ROOT, "tests/agent-abort.test.ts")])],
  ]);
  const plan = planLockfileDelta(["package-lock.json"], {
    mergeBase: "cafebabe",
    readBase: () => lock,
    readTip: () => JSON.stringify(bumped),
    reverse,
    coreSuites: CORE,
  });
  assertEquals(plan!.verdict.packages, ["zod"]);
  assert(plan!.verdict.importers.zod.length > 0, "the real closure is resolved");
  for (const guard of DEPENDENCY_LOCK_GUARDS) assert(plan!.mapped[0].tests.includes(guard), `${guard} is selected`);
  assert(
    plan!.mapped[0].tests.includes("tests/agent-abort.test.ts"),
    `the reverse-import closure reaches the importer's test: ${plan!.mapped[0].tests.slice(0, 6).join(", ")}`,
  );
  for (const suite of plan!.mapped[0].tests) {
    assert(existsSync(join(ROOT, suite)), `${suite} is a real suite`);
    assert(suite.endsWith(".test.ts"), `${suite} is a test file`);
  }
});

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
  DEPENDENCY_LOCK_GUARD,
  LOCKFILE_CLASS_FILES,
  LOCKFILE_DELTA_LEDGER_PREFIX,
  classifyLockfileDelta,
  isLockfileClassFile,
  isVersionCounterOnly,
  lockfileDeltaLedgerLines,
  packageNameFromLockPath,
  packageNameFromNpmKey,
  packageNameFromSpecifier,
  specifierNamesPackage,
} from "../scripts/lib/lockfile-delta.mjs";
import { SELECTOR_INFRASTRUCTURE } from "../scripts/lib/changed-file-mapping.mjs";
import {
  LOCKFILE_DELTA_REFUSAL,
  ROOT,
  bareSpecifierIndex,
  clearBareSpecifierCache,
  packageImporters,
  planLockfileDelta,
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

function denoLock({ integrity = "sha512-aa", resolved = "3.24.0", npmKey = "zod@3.24.0", extra = {} } = {}): string {
  return JSON.stringify({
    version: "5",
    specifiers: { "npm:zod@^3": resolved },
    npm: { [npmKey]: { integrity } },
    workspace: { packageJson: { dependencies: ["npm:zod@^3.24.0"] } },
    ...extra,
  }, null, 2);
}

/** A closure that attributes every name to one importer and one suite. */
const closureStub = (importers: Record<string, string[]> = {}, suites: string[] = ["tests/closure.test.ts"]) =>
  (names: string[]) => ({
    importers: Object.fromEntries(names.map((name) => [name, importers[name] ?? []])),
    suites: names.every((name) => (importers[name] ?? []).length) ? suites : [],
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
  assert(existsSync(join(ROOT, DEPENDENCY_LOCK_GUARD)), `${DEPENDENCY_LOCK_GUARD} is the declared reader and must exist`);
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
  assertEquals(verdict.suites, CORE, "the always-on set alone certifies the stamp");
  assert(!verdict.suites.includes(DEPENDENCY_LOCK_GUARD), "no dependency reader is owed for a stamp");
  assertStringIncludes(verdict.notes.join("\n"), "version-counter-only");
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
  for (const suite of [...CORE, DEPENDENCY_LOCK_GUARD, "tests/closure.test.ts"]) {
    assert(verdict.suites.includes(suite), `the verdict must select ${suite}: ${verdict.suites.join(", ")}`);
  }
  assertEquals(verdict.suites.length, CORE.length + 2, "guard + closure, nothing invented");
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
Deno.test("lezl0: a deno.lock integrity-only change selects the guard + core and no closure", () => {
  const verdict = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ integrity: "sha512-bb" }) } },
    { coreSuites: CORE, closureFor: () => ({ importers: {}, suites: ["tests/never.test.ts"], unattributed: [] }) },
  );
  assertEquals(verdict.kind, "subset");
  assertEquals(verdict.integrityOnly, true, "the resolved set did not move");
  assertEquals(verdict.packages, [], "a hash-only change names no package");
  assertEquals(verdict.suites, [...CORE, DEPENDENCY_LOCK_GUARD].sort());
  assert(!verdict.suites.includes("tests/never.test.ts"), "no import graph moved, so no closure is invented");
  assertStringIncludes(verdict.notes.join("\n"), "integrity-only");
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
  assert(verdict.suites.includes(DEPENDENCY_LOCK_GUARD));
});

Deno.test("lezl0: a changed dependency entry with NO repo importer stays a subset WITH the guard (stated fail-open)", () => {
  // STATED AND PINNED, per the ADR: most declared dependencies legitimately have no importer (types,
  // CLIs, peer-transitive pins), and the guard is the declared reader of those declarations. Review is
  // invited to attack this: flip it and every devDependency bump goes back to a 760-file sweep.
  const verdict = classifyLockfileDelta(
    { denoLock: { base: denoLock(), tip: denoLock({ npmKey: "@types/node@24.13.3" }) } },
    { coreSuites: CORE, closureFor: closureStub({}) },
  );
  assertEquals(verdict.kind, "subset", "an unattributable DECLARED name is still certified by its reader");
  assertEquals(verdict.suites, [...CORE, DEPENDENCY_LOCK_GUARD].sort());
  assertStringIncludes(verdict.notes.join("\n"), "no repo importer");
  assertStringIncludes(verdict.notes.join("\n"), DEPENDENCY_LOCK_GUARD);
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
    assertStringIncludes(verdict.reason, "no repo importer");
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
  assert(!noGuard.suites.includes(DEPENDENCY_LOCK_GUARD), "dropping the guard loses it — the pins catch it");

  // MUTANT 3: the guard is not smuggled in through core either, so the pins are pinning the CLASSIFIER
  // and not an accident of the always-on set.
  assert(!CORE.includes(DEPENDENCY_LOCK_GUARD), "the guard is not always-on: the classifier must select it");
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
  assertEquals(passive!.mapped[0].tests, CORE, "a passive stamp maps to the always-on set");

  const subset = planLockfileDelta(["package-lock.json"], {
    mergeBase: "cafebabe",
    readBase: () => lock,
    readTip: () => bumped,
    reverse: null,
    coreSuites: CORE,
    closureFor: closureStub({ zod: ["extension/lib/agent.js"] }),
  });
  assert(subset!.mapped[0].tests.includes(DEPENDENCY_LOCK_GUARD), "the guard is in the mapped row");
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
  assert(plan!.mapped[0].tests.includes(DEPENDENCY_LOCK_GUARD), "the declared reader is selected");
  assert(
    plan!.mapped[0].tests.includes("tests/agent-abort.test.ts"),
    `the reverse-import closure reaches the importer's test: ${plan!.mapped[0].tests.slice(0, 6).join(", ")}`,
  );
  for (const suite of plan!.mapped[0].tests) {
    assert(existsSync(join(ROOT, suite)), `${suite} is a real suite`);
    assert(suite.endsWith(".test.ts"), `${suite} is a test file`);
  }
});

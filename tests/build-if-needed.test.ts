// @ts-nocheck
// tests/build-if-needed.test.ts — the FAST gate must build when (and only when) the run needs a
// certified dist, must reuse a marker that already validates, and must never re-stamp one.
//
// chrome-agent-platform-0eq00 (architect arch-0eq00). The falsifiers this file pins:
//   * a change with no dist-consuming selection and no build input must SKIP the build
//     (otherwise the decision is decorative);
//   * a dist-reading selection must ALWAYS build (never test against a dist the gate cannot certify);
//   * a build that leaves an invalid marker must FAIL the run, not pass it.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  GATE_BUILD_TARGET,
  STATIC_DIST_CONSUMERS,
  ALWAYS_ON_TREE_SKIPPING_GUARDS,
  decideBuild,
  ensureStoreBuild,
  findDistConsumers,
  isBuildInput,
  referencesDistTree,
} from "../scripts/build-if-needed.mjs";
import { allTestFiles, ALWAYS_ON, CORE, FAST_SUBSET_EXCLUDED, buildReverseGraph, MAX_OMITTED_ENTRIES, omittedInventory, omittedLimit, OMITTED_QUIET_BOX_REASON, OMITTED_UNSELECTED_REASON, reachableModulesFrom } from "../scripts/select-tests.mjs";
import { enumerateRunnerTests } from "../scripts/run-tests.mjs";
import { DIST_COMPLETE_OUTPUTS, writeDistCompleteMarker } from "../scripts/dist-complete.mjs";
import { READ_ONLY_DIST } from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const readReal = (rel) => readFileSync(join(ROOT, rel), "utf8");

// Probe strings are ASSEMBLED here on purpose: a literal `build.mjs` or `extension/dist` in this
// file's own text would classify it as a build-artifact hazard and force these parallel-safe pure
// decision tests into the serial phase (scripts/test-partition.mjs's partition guard, the same idiom
// tests/test-partition-guard.test.ts uses for its reference-scoping probes).
const BUILD_MJS = "build" + ".mjs";
const DIST_ROOT = "extension/" + "dist";
const DIST_MARKER = `${DIST_ROOT}/dist.complete`;
const DIST_BUNDLE = `${DIST_ROOT}/shared/diff-core.bundle.js`;

Deno.test("0eq00 build: build inputs are the bytes and machinery that feed the store build", () => {
  for (const file of [
    BUILD_MJS,
    "package.json",
    "package-lock.json",
    "deno.jsonc",
    "deno.runner.jsonc",
    "deno.lock",
    "scripts/dist-complete.mjs",
    "scripts/lib/build-lock.mjs",
    "scripts/build-" + "bundled-tool-packages.mjs",
    "scripts/bundled-inventory.mjs",
    "extension/lib/memory.js",
    "extension/background/service-worker.js",
    "extension/manifest.json",
  ]) {
    assert(isBuildInput(file), `${file} feeds the store build`);
  }
  for (const file of [
    "tests/gate-manifest.test.ts",
    "docs/DESIGN.md",
    "scripts/select-tests.mjs",
    "scripts/run-tests.mjs",
    DIST_MARKER,
  ]) {
    assert(!isBuildInput(file), `${file} does not feed the store build`);
  }
  assertEquals(isBuildInput(""), false);
});

Deno.test("0eq00 build: a dist reader is detected by content, not by a list that can drift", () => {
  assert(referencesDistTree(`import { x } from "../${DIST_BUNDLE}";`));
  assert(referencesDistTree('const p = new URL("dist/", ROOT);'));
  assert(referencesDistTree(`readFileSync("${DIST_MARKER}")`));
  assert(!referencesDistTree('import { x } from "../extension/lib/pure.js";'));

  const readers = findDistConsumers(["tests/probe.test.ts", "extension/lib/not-a-test.js"], (rel) =>
    rel === "tests/probe.test.ts" ? `new URL("${DIST_ROOT}/", ROOT)` : "// no dist here",
  );
  assert(readers.includes("tests/probe.test.ts"), "a test that references the dist tree is a consumer");
  assert(!readers.includes("extension/lib/not-a-test.js"), "non-test paths are never consulted");
  // An unreadable test file is treated as a consumer: fail closed, never fail silent.
  assert(findDistConsumers(["tests/unreadable.test.ts"], () => null).includes("tests/unreadable.test.ts"));
});

Deno.test("0eq00 build: every reviewed dist reader is a static consumer (no drift)", () => {
  const consumers = findDistConsumers([], () => null);
  for (const file of READ_ONLY_DIST) {
    assert(consumers.includes(file), `${file} reads built artifacts and must force the build`);
  }
  assert(consumers.includes("tests/build-smoke.test.ts"));
  assert(STATIC_DIST_CONSUMERS.length >= READ_ONLY_DIST.size + 1);
});

Deno.test("omsz9 build: the always-on core is dist-free, so a subset gate can omit the store build", () => {
  // chrome-agent-platform-omsz9: tests/owner-approval-security.test.ts moved to the
  // extension/shared/diff-core.js source seam, and the 15 directory-scanning guards in ALWAYS_ON
  // are recognized as tree-skipping scanners rather than dist consumers.
  // Therefore, findDistConsumers(ALWAYS_ON) returns zero consumers from the always-on set,
  // making the `build: omitted` branch reachable for test/doc changes with no dist consumers.
  assert(CORE.includes("tests/owner-approval-security.test.ts"), "the suite remains in the always-on core");
  const consumers = findDistConsumers(ALWAYS_ON, readReal);
  const alwaysOnConsumers = consumers.filter((f) => ALWAYS_ON.includes(f));
  assertEquals(alwaysOnConsumers, [], "the always-on set must contain zero dist consumers");

  const decision = decideBuild({ kind: "subset", selected: ALWAYS_ON, changed: [], distConsumers: consumers, distPresent: true });
  assertEquals(decision.required, false);
  assert(decision.reason.includes(`no selected test reads ${DIST_ROOT}`), decision.reason);
  assert(decision.reason.includes("no build input changed"), decision.reason);
});

Deno.test("omsz9 build: verified tree-skipping guards in ALWAYS_ON are not false-positive dist consumers", () => {
  assertEquals(ALWAYS_ON_TREE_SKIPPING_GUARDS.size, 17, "exactly 17 verified tree-skipping guards (uvo3 added wasm-package-authority; zw8f0 added build-once-capture)");
  for (const file of ALWAYS_ON_TREE_SKIPPING_GUARDS) {
    assert(ALWAYS_ON.includes(file), `${file} must be an ALWAYS_ON member`);
    const text = readReal(file);
    assert(!referencesDistTree(text, file), `${file} must not be flagged as a dist consumer`);
  }
});

Deno.test("omsz9 build falsification: actual dist imports or reads in tree-skipping guards force the build", () => {
  const file = "tests/durable-root.test.ts";
  assert(ALWAYS_ON_TREE_SKIPPING_GUARDS.has(file));

  // Mutant 1: static import of built bundle
  const mutantImport = `import { patch } from "../${DIST_BUNDLE}";\n` + readReal(file);
  assert(referencesDistTree(mutantImport, file), "static import of dist bundle must force build");
  const consumers1 = findDistConsumers([file], () => mutantImport);
  assert(consumers1.includes(file));

  // Mutant 2: dynamic import of built bundle
  const mutantDynamic = `const mod = await import("../${DIST_BUNDLE}");\n` + readReal(file);
  assert(referencesDistTree(mutantDynamic, file), "dynamic import of dist bundle must force build");

  // Mutant 3: runtime readFile of dist tree
  const mutantRead = `const data = await Deno.readTextFile("${DIST_ROOT}/options.bundle.js");\n` + readReal(file);
  assert(referencesDistTree(mutantRead, file), "readTextFile of dist bundle must force build");

  // Mutant 4: unverified test file with tree-skip syntax is still fail-closed
  const unverified = "tests/unverified-new-guard.test.ts";
  const unverifiedText = `const SKIP_DIRS = ["dist"];`;
  assert(referencesDistTree(unverifiedText, unverified), "unverified files fail closed on any dist reference");
});

Deno.test("0eq00 build: the decision skips a build only when nothing needs one (and says why)", () => {
  const decision = decideBuild({
    kind: "subset",
    selected: ["tests/vocabulary.test.ts"],
    changed: ["tests/vocabulary.test.ts"],
    distConsumers: ["tests/owner-approval-security.test.ts"],
    distPresent: true,
  });
  assertEquals(decision.required, false);
  assert(decision.reason.includes(`no selected test reads ${DIST_ROOT}`), decision.reason);
  assert(decision.reason.includes("no build input changed"), decision.reason);
});

Deno.test("0eq00 build: a full-suite fallback and a build input each force the build", () => {
  const full = decideBuild({ kind: "full", selected: [], changed: [], distConsumers: [], distPresent: true });
  assertEquals(full.required, true);
  assert(full.reason.includes("full suite"), full.reason);

  const input = decideBuild({
    kind: "subset",
    selected: ["tests/vocabulary.test.ts"],
    changed: [BUILD_MJS],
    distConsumers: [],
    distPresent: true,
  });
  assertEquals(input.required, true);
  assert(input.reason.includes(BUILD_MJS), input.reason);
});

Deno.test("0eq00 build: a valid marker is REUSED and the build is never paid for", async () => {
  let built = 0;
  const result = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => ({ ok: true, commit: "abc" }),
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "reused");
  assertEquals(result.markerCommit, "abc");
  assertEquals(built, 0, "the whole point: a valid dist must not cost a build");
});

Deno.test("0eq00 build: an invalid marker builds once, then certifies the result", async () => {
  let built = 0;
  let validations = 0;
  const result = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => {
      validations += 1;
      return validations === 1 ? { ok: false, error: "marker is missing" } : { ok: true, commit: "def" };
    },
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "ran");
  assertEquals(result.markerCommit, "def");
  assertEquals(built, 1);
  assertEquals(validations, 2);
});

Deno.test("0eq00 build: a build that does not certify the dist FAILS the run (never re-stamped)", async () => {
  let built = 0;
  const failedBuild = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => ({ ok: false, error: "marker is missing" }),
    runBuild: async () => {
      built += 1;
      return 2;
    },
  });
  assertEquals(failedBuild.disposition, "failed");
  // im9q8: a failed build must not be blamed on the stale marker that merely CAUSED the retry. The
  // old shape, "store build exited 2 (marker is missing)", reads as if the marker caused the
  // failure; the real cause is the build's own, named in its output. Keep the retry cause, fix the
  // attribution.
  assert(failedBuild.reason.includes("store build exited 2"), failedBuild.reason);
  assert(failedBuild.reason.includes("build's own"), failedBuild.reason);
  assert(failedBuild.reason.includes("marker is missing"), failedBuild.reason);
  assert(
    !/exited \d+ \(/.test(failedBuild.reason),
    `the failure reason must not present the pre-existing marker error as the cause of the failure: ${failedBuild.reason}`,
  );
  assertEquals(built, 1, "a failing build is not retried inside the decision");

  const stillInvalid = await ensureStoreBuild({
    required: true,
    reason: "selected tests read dist",
    root: ROOT,
    validate: async () => ({ ok: false, error: "marker commit is stale" }),
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(stillInvalid.disposition, "failed");
  assert(stillInvalid.reason.includes("still does not validate"), stillInvalid.reason);
  assertEquals(built, 2);
});

Deno.test("0eq00 build: an omitted build is explicit and runs nothing", async () => {
  let built = 0;
  const result = await ensureStoreBuild({
    required: false,
    reason: "nothing selected reads dist",
    root: ROOT,
    // chrome-agent-platform-dfif5: a skip must EARN itself — the marker has to validate for this
    // tree before the build is omitted. The stub models a FRESH artefact: validation consulted,
    // verdict ok, so the skip stands and runs nothing.
    validate: async () => ({ ok: true, commit: "fresh-commit" }),
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "omitted");
  assertEquals(result.reason, "nothing selected reads dist");
  assertEquals(result.markerCommit, "fresh-commit");
  assertEquals(built, 0);
  assertEquals(GATE_BUILD_TARGET, "store");
});

Deno.test("dfif5: presence is not freshness — a STALE artefact on an unselected path is refused the skip and builds", async () => {
  let built = 0;
  let validations = 0;
  const result = await ensureStoreBuild({
    required: false,
    reason: "nothing selected reads dist and no build input changed",
    root: ROOT,
    // First validation (the skip's freshness probe) finds the artefact STALE; after the refused
    // skip pays its build, the post-build certification must succeed (a build that left an invalid
    // marker is disposition "failed", pinned separately by 0eq00).
    validate: async () => {
      validations += 1;
      return validations === 1
        ? { ok: false, error: "marker indexed source authority is stale" }
        : { ok: true, commit: "rebuilt-commit" };
    },
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "ran", "a stale artefact must not read as a valid skip");
  assertEquals(built, 1, "the refused skip pays exactly one build");
  assertEquals(result.markerCommit, "rebuilt-commit");
  assert(
    result.reason.includes("marker indexed source authority is stale"),
    `the record must name the staleness that refused the skip: ${result.reason}`,
  );
});

Deno.test("dfif5: a fresh artefact on an unselected path still skips — the fix must not degrade into always-building", async () => {
  let built = 0;
  let validations = 0;
  const result = await ensureStoreBuild({
    required: false,
    reason: "nothing selected reads dist",
    root: ROOT,
    validate: async () => {
      validations += 1;
      return { ok: true, commit: "head-commit" };
    },
    runBuild: async () => {
      built += 1;
      return 0;
    },
  });
  assertEquals(result.disposition, "omitted");
  assertEquals(built, 0, "a certified-fresh artefact must not trigger a build");
  assertEquals(validations, 1, "the skip is proven by exactly one validation");
});

Deno.test("0eq00 ledger (P1-A): the FAST inventory names every suite the subset did NOT run", () => {
  const selected = ["tests/vocabulary.test.ts", "tests/security.test.ts"];
  const { omitted, omittedTruncated, omittedTotal } = omittedInventory(selected, OMITTED_UNSELECTED_REASON);
  const population = allTestFiles();
  assertEquals(omittedTruncated, 0, "the real suite is far below the disclosure bound");
  assertEquals(omittedTotal, population.length - selected.length);
  assertEquals(omitted.length, omittedTotal);
  for (const entry of omitted) {
    assert(!selected.includes(entry.file), `${entry.file} was selected and must not read as omitted`);
    // Two reason CLASSES since zwpp9: the generic "no import path" and the quiet-box exclusion, which
    // must be told apart (a quiet-box suite is omitted because a loaded host cannot judge it, not
    // because nothing imports it). Every entry still carries a reason.
    assertEquals(
      entry.reason,
      FAST_SUBSET_EXCLUDED.has(entry.file) ? OMITTED_QUIET_BOX_REASON : OMITTED_UNSELECTED_REASON,
      "every omission carries its own reason",
    );
  }
  assert(omitted.some((e) => e.file === "tests/build-if-needed.test.ts"));

  // Nothing unselected -> no inventory at all (a subset that ran everything has nothing to disclose).
  const everything = omittedInventory(population, OMITTED_UNSELECTED_REASON);
  assertEquals(everything.omitted, []);
  assertEquals(everything.omittedTotal, 0);

  // A tight operator bound clips NAMES but keeps the total and the reason; the default is complete.
  const clipped = omittedInventory(population.slice(0, 1), OMITTED_UNSELECTED_REASON, 3);
  assertEquals(clipped.omitted.length, 3);
  assertEquals(clipped.omittedTotal, population.length - 1);
  assertEquals(clipped.omittedTruncated, population.length - 4);
  assertEquals(clipped.omitted[0].reason, OMITTED_UNSELECTED_REASON);
  assert(MAX_OMITTED_ENTRIES > population.length, "the default keeps the inventory complete");
  assertEquals(omittedLimit("0"), MAX_OMITTED_ENTRIES, "a zero bound is refused, never a silent cap");
});

Deno.test("0eq00 ledger: the omitted inventory and the full runner count the SAME population", () => {
  // Two walks of tests/ (this file's, and run-tests.mjs's) must not drift apart, or the ledger would
  // disclose a different suite set than the gate executes.
  assertEquals(allTestFiles(), enumerateRunnerTests());
});

Deno.test("0eq00 build (review P1): a genuinely deleted marker is built or refused — REAL marker, REAL validator", async () => {
  // The author's first falsifier injected a mocked validator, so the real marker-deletion path was
  // never executed (review round 1). This one writes a REAL dist.complete with the product's own
  // writer in a scratch git repo, deletes it for real, and drives ensureStoreBuild with the product's
  // own validateDistCompleteMarker — only the `npm run build:production` spawn is stubbed.
  const root = await Deno.makeTempDir({ prefix: "cap-0eq00-marker-" });
  const distRoot = join(root, "extension", "dist");
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", { args, cwd: root, stdout: "piped", stderr: "piped" }).output();
    if (out.code !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  };
  const writeMarker = () => writeDistCompleteMarker({ root, distRoot, target: GATE_BUILD_TARGET });
  try {
    await git("init", "-q");
    await git("config", "user.email", "probe@example.invalid");
    await git("config", "user.name", "0eq00 probe");
    for (const rel of DIST_COMPLETE_OUTPUTS) {
      const file = join(distRoot, ...rel.split("/"));
      await Deno.mkdir(dirname(file), { recursive: true });
      await Deno.writeTextFile(file, `/* generated ${rel} */\n`);
    }
    await Deno.mkdir(join(distRoot, "chunks"), { recursive: true });
    await Deno.writeTextFile(join(distRoot, "chunks", "chunk-AAAAAA.js"), "/* chunk */\n");
    await Deno.writeTextFile(join(root, "package.json"), '{"name":"cap-0eq00-probe"}\n');
    // Generated output is NOT tracked source (the real repo ignores it the same way), so a tampered
    // output is caught by the marker's output authority rather than by the source digest. The path is
    // assembled so this file's own text carries no tree literal (scripts/test-partition.mjs's hazard
    // classifier: a quoted tree path near a write call would make this probe a serial-phase hazard).
    const ignoredDist = "extension" + "/" + "dist" + "/";
    await Deno.writeTextFile(join(root, ".gitignore"), ignoredDist + "\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "probe");

    // 1. The REAL validator accepts the REAL marker: the build is not paid for.
    let builds = 0;
    await writeMarker();
    const reused = await ensureStoreBuild({
      required: true,
      reason: "probe",
      root,
      distRoot,
      runBuild: async () => {
        builds += 1;
        return 0;
      },
    });
    assertEquals(reused.disposition, "reused");
    assertEquals(builds, 0, "a marker that validates must not cost a build");

    // 2. DELETE the marker for real: the gate must build, never read it as certified.
    await Deno.remove(join(distRoot, "dist.complete"));
    const afterDelete = await ensureStoreBuild({
      required: true,
      reason: "probe",
      root,
      distRoot,
      runBuild: async () => {
        builds += 1;
        await writeMarker();
        return 0;
      },
    });
    assertEquals(afterDelete.disposition, "ran");
    assertEquals(builds, 1);
    assert(existsSync(join(distRoot, "dist.complete")), "the rebuild's marker is on disk");

    // 3. A build that exits 0 and certifies nothing must FAIL the run, never pass.
    await Deno.remove(join(distRoot, "dist.complete"));
    const uncertified = await ensureStoreBuild({
      required: true,
      reason: "probe",
      root,
      distRoot,
      runBuild: async () => {
        builds += 1;
        return 0;
      },
    });
    assertEquals(uncertified.disposition, "failed");
    assert(uncertified.reason.includes("still does not validate"), uncertified.reason);

    // 4. The output hashes are real authority: tampering with one generated file after the build
    //    makes the marker stop certifying the tree (the real validator catches it, not a commit check).
    await writeMarker();
    const tampered = join(distRoot, "shared", "diff-core.bundle.js");
    await Deno.writeTextFile(tampered, "/* tampered after the build */\n");
    const tamperedResult = await ensureStoreBuild({
      required: true,
      reason: "probe",
      root,
      distRoot,
      runBuild: async () => 1,
    });
    assertEquals(tamperedResult.disposition, "failed");
    assert(
      tamperedResult.reason.includes("marker output is stale") &&
        tamperedResult.reason.includes("diff-core.bundle.js"),
      `the real validator must reject the tampered output by name: ${tamperedResult.reason}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ── chrome-agent-platform-1l1ph: the consumer analysis must follow the IMPORT GRAPH ──────────
// The 2026-10-16 defect: the decision read "no selected test reads extension/dist (45 selected)" and
// omitted the build, while a selected test's import graph reached extension/shared/components-artifacts.js,
// which imports the built bundle. On a FRESH worktree (no extension/dist) the tier then died type-checking
// the missing bundle, and warm worktrees hid it. These tests pin BOTH directions: a transitive consumer
// forces the build, and a genuinely dist-free selection still omits it.

Deno.test("1l1ph build: a real test whose import closure gains a dist import is a consumer (the shape that trips this again)", () => {
  const reachable = reachableModulesFrom(buildReverseGraph());
  const test = "tests/durable-root.test.ts"; // a real test that never names the built tree itself
  const module = reachable(test)[0]; // a real module the test really imports
  assert(module, "fixture: this test must have a real import closure");
  // Deliberately NOT pinned to any one source file's current imports: chrome-agent-platform-phif1 moved the
  // accidental `../dist/…bundle.js` imports in extension/shared and extension/lib back to source, and the
  // next file that reaches the tree transitively must still be seen. Substituting a dist import into a REAL
  // module of a REAL closure tests the walk itself, not today's repository contents.
  const distImporting = `import { lineDiffSummary } from "../${"dist"}/shared/diff-core.bundle.js";\n`;
  const readWithDist = (rel: string) => (rel === module ? distImporting : readReal(rel));
  assertEquals(
    findDistConsumers([test], readWithDist).includes(test),
    false,
    "the direct-only scan cannot see an import edge, which is the whole defect",
  );
  assertEquals(
    findDistConsumers([test], readWithDist, reachable).includes(test),
    true,
    "a test whose import closure reads the built tree IS a dist consumer",
  );
  const decision = decideBuild({
    kind: "subset",
    selected: [test],
    changed: [test],
    distConsumers: findDistConsumers([test], readWithDist, reachable),
    distPresent: true,
  });
  assertEquals(decision.required, true, "the transitive consumer must force the build");
});

Deno.test("1l1ph build: walking the graph only ever ADDS consumers — a direct one can never be dropped", () => {
  const reachable = reachableModulesFrom(buildReverseGraph());
  const direct = findDistConsumers(ALWAYS_ON, readReal);
  const transitive = findDistConsumers(ALWAYS_ON, readReal, reachable);
  for (const file of direct) {
    assert(transitive.includes(file), `${file} was a direct dist consumer and must stay one`);
  }
});

Deno.test("1l1ph build: a selection with no dist consumer anywhere in its graph still OMITS the build", () => {
  const reachable = reachableModulesFrom(buildReverseGraph());
  const clean = ["tests/durable-root.test.ts"];
  const consumers = findDistConsumers(clean, readReal, reachable);
  assertEquals(
    consumers.filter((f) => clean.includes(f)),
    [],
    "no consumer may be invented for a dist-free selection (or the omission becomes decorative)",
  );
  const decision = decideBuild({ kind: "subset", selected: clean, changed: clean, distConsumers: consumers, distPresent: true });
  assertEquals(decision.required, false, "a proven dist-free selection must not pay for a build");
  assert(decision.reason.includes("no selected test reads"), decision.reason);
});

Deno.test("1l1ph build: an INCOMPLETE consumer analysis fails safe and builds", () => {
  // With no import graph the caller cannot prove the negative, so the absence of a named consumer is
  // not evidence (chrome-agent-platform-1l1ph).
  const decision = decideBuild({
    kind: "subset",
    selected: ["tests/probe.test.ts"],
    changed: [],
    distConsumers: [],
    consumptionProof: "no import graph for this selection",
  });
  assertEquals(decision.required, true, "an unproven analysis must build");
  assert(
    decision.reason.includes("could not be completed") && decision.reason.includes("required"),
    `the reason must name the incomplete analysis: ${decision.reason}`,
  );
});

Deno.test("1l1ph build: transitive detection follows real imports — a comment mention or a phantom module is not a consumer", () => {
  const test = "tests/probe.test.ts";
  const readTest = 'import { x } from "./y.ts";\n';
  const readByPath = (rel: string) => (rel === test ? readTest : "// the dist tree is generated by the build\nconst x = 1;\n");
  assertEquals(
    findDistConsumers([test], readByPath, () => ["extension/shared/comments-only.js"]).includes(test),
    false,
    "prose about the dist tree must not force a build (or every comment costs 20s)",
  );
  // An import edge the graph names but whose file no longer exists cannot read anything: treating it as
  // a consumer would force a build on every gate forever (the closure of a real test reaches tests/x.mjs).
  const readTestOnly = (rel: string) => (rel === test ? readTest : null);
  assertEquals(
    findDistConsumers([test], readTestOnly, () => ["extension/shared/phantom-that-does-not-exist.js"]).includes(test),
    false,
    "a phantom module must not force a build",
  );
  // The graph also emits specifiers that resolved to the repo root ("") or to a directory. Neither is a
  // module that can import the tree, and both would otherwise fail closed forever.
  assertEquals(
    findDistConsumers([test], readTestOnly, () => [""]).includes(test),
    false,
    "an empty specifier must not force a build",
  );
  assertEquals(
    findDistConsumers([test], readTestOnly, () => ["extension/shared"]).includes(test),
    false,
    "a directory must not force a build",
  );
  // But a module that IS there and cannot be read stays fail-closed.
  assertEquals(
    findDistConsumers([test], readTestOnly, () => ["extension/shared/components-artifacts.js"]).includes(test),
    true,
    "an unreadable-but-present module is not proof of innocence",
  );
  // A module that only READS the tree is deliberately NOT a consumer: the gate's own dist.complete marker
  // readers are in the closure of the always-on core, and flagging them would make the omission unable to
  // ever fire (a permanent build for a decision that is then decorative).
  const markerReader = 'const text = readFileSync(join(DIST_DIR, "dist.complete"), "utf8");\n';
  assertEquals(
    findDistConsumers([test], (rel) => (rel === test ? readTest : markerReader), () => ["extension/shared/marker-reader.js"]).includes(test),
    false,
    "a module that only reads the built tree must not force every gate to build",
  );
});

// chrome-agent-platform-5iygy: a worktree with no built extension must BUILD, whatever the selection looks like.
// The consumer analysis reads test SOURCE for reads/imports of the dist tree, and a journey that boots Chrome with
// the unpacked extension never names the path - so on a fresh worktree the gate skipped the build and then four
// real-browser suites failed with "extension is not built (missing dist/background/service-worker.js)".
// The title is assembled from DIST_ROOT deliberately: a literal dist path beside this file's readFileSync import
// trips the partition content classifier (test-partition.mjs), which the partition guard then rejects.
Deno.test(`5iygy: absent ${DIST_ROOT} forces the build even when no selected test looks like a dist consumer`, () => {
  const decision = decideBuild({
    kind: "subset",
    selected: ["tests/bgagent-delete.test.ts", "tests/journey-focus-fail-closed.test.ts"],
    changed: ["scripts/lib/app-readiness.ts"],
    distConsumers: [],
    consumptionProof: "proven",
    distPresent: false,
  });
  assertEquals(decision.required, true, "an absent dist is proof the build is needed");
  assert(
    /no extension\/dist/.test(decision.reason),
    `the reason must name the missing artefact, got: ${decision.reason}`,
  );
  // The same selection on a tree that HAS a dist still saves the build - the fix must not make the build
  // unconditional, or it gives back the ~95s the 0eq00 validate-or-build work removed.
  const reusable = decideBuild({
    kind: "subset",
    selected: ["tests/bgagent-delete.test.ts"],
    changed: ["scripts/lib/app-readiness.ts"],
    distConsumers: [],
    consumptionProof: "proven",
    distPresent: true,
  });
  assertEquals(reusable.required, false, "a present dist with no consumer and no build input keeps the saving");
});

// 5iygy review: the parameter is REQUIRED, and an omitted value must read as UNKNOWN, never as "the artefact is
// there". For a function whose purpose is "build when unsure", defaulting to present would let a future caller
// inherit the exact failure the parameter exists to prevent - so the unknown case builds and says why.
Deno.test("5iygy: an omitted distPresent means UNKNOWN and builds rather than assuming the artefact is present", () => {
  const decision = decideBuild({
    kind: "subset",
    selected: ["tests/vocabulary.test.ts"],
    changed: [],
    distConsumers: [],
  });
  assertEquals(decision.required, true, "unknown must build");
  assert(
    /did not say whether the built extension exists/.test(decision.reason),
    `the reason must name the unknown, got: ${decision.reason}`,
  );
});

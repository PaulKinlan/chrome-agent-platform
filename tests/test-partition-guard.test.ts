// tests/test-partition-guard.test.ts — the drift guard for the two-phase test
// partition (76hu). The partition lives in scripts/test-partition.mjs (shared
// by run-tests.mjs, select-tests.mjs, and this guard).
//
// Invariant guarded: every test file whose CONTENT is a shared build-artifact
// hazard — it spawns the build script or the bundled-tool generator, writes
// under the shipped extension or packages trees, or reads the built dist —
// MUST be in the SERIAL set (or the reviewed EXEMPTIONS list with a reason).
// Without this guard a new hazard test could silently join the parallel phase
// and race the rebuilders (the vj4s par1 failure mode: 9 false reds).
//
// Falsification is in the bead record: a planted hazard file NOT in SERIAL
// failed this guard RED; with it in SERIAL the guard went GREEN again.
//
// NOTE: the detector probe strings below are ASSEMBLED at runtime so this
// file's own text never matches the hazard patterns it scans for.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  BUILD_GATE,
  BUILD_GATE_FILES,
  BUILD_GATE_REASONS,
  classifyHazards,
  EXEMPTIONS,
  isReviewedReadOnlySpawn,
  partition,
  PRODUCTION_BUILD_TIMEOUT_MS,
  READ_ONLY_DIST,
  READ_ONLY_DIST_REASONS,
  realDriverRefs,
  SERIAL,
  SERIAL_FILE_TIMEOUTS,
  SERIAL_REASONS,
  unserialisedHazards,
} from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Recursive walk matching run-tests.mjs (deno test walks subdirectories too).
// Returns repo-relative paths ("tests/...").
async function allTestFiles(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for await (const ent of Deno.readDir(dir)) {
      const p = `${dir}/${ent.name}`;
      if (ent.isDirectory) await walk(p);
      else if (ent.name.endsWith(".test.ts")) out.push(p.slice(ROOT.length));
    }
  }
  await walk(`${ROOT}tests`);
  return out.sort();
}

// A test that SPAWNS or IMPORTS a local tests/*.mjs|*.ts driver inherits the
// driver's classification (the hazard may live in the driver — e.g. the
// package-extension-freshness driver writes the dist-complete marker).
// REFERENCE-SCOPED (8b8w/f94p): a PROSE mention of a driver is not a
// reference — a comment explaining a test must not make this file inherit
// that test's hazards.
async function contentWithDrivers(rel: string): Promise<string> {
  const text = await Deno.readTextFile(`${ROOT}${rel}`);
  const parts = [text];
  for (const driver of realDriverRefs(text)) {
    if (driver === rel) continue;
    try {
      parts.push(await Deno.readTextFile(`${ROOT}${driver}`));
    } catch {
      // Driver not on disk right now; the test's own text still classifies.
    }
  }
  return parts.join("\n");
}

Deno.test("partition guard: every build-artifact hazard test is serial (or reviewed-exempt with a reason)", async () => {
  const files = await allTestFiles();
  assert(files.length > 100, "the walk must see the real suite");
  // The SAME invariant the fresh-instance gate applies to its scratch tree, so the two cannot drift.
  const violations = unserialisedHazards(
    await Promise.all(files.map(async (rel) => [rel, await contentWithDrivers(rel)] as [string, string])),
  );
  assertEquals(
    violations,
    [],
    `build-artifact hazard(s) would run in the PARALLEL phase — add each to SERIAL_REASONS in scripts/test-partition.mjs with its reason, or to EXEMPTIONS with a proof of parallel-safety:\n  ${violations.join("\n  ")}`,
  );
});

Deno.test("partition guard: a driver reference is a LOAD or a SPAWN, never a mention (8b8w/f94p)", async () => {
  // Probe strings are ASSEMBLED at runtime so this file's own text never
  // carries a literal tests/* reference for its own inheritance scan.
  const DRIVER = "tests/" + "wasm-tree-shaking" + ".test.ts"; // a REAL serial hazard file (reads extension/dist)
  const driverText = await Deno.readTextFile(`${ROOT}${DRIVER}`);
  const own = `Deno.test("synthetic wrapper", () => { assertEquals(1, 1); });\n`;

  // 1. COMMENT-ONLY mention: no reference, no inheritance. Before the fix a
  // comment naming the driver pulled its whole hazard text into this file's
  // classification (measured: inherited "reads extension/dist").
  const commentOnly = `${own}// see also ${DRIVER} for the tree-shaking property\n`;
  assertEquals(realDriverRefs(commentOnly), [], "a comment naming a driver is prose, not a reference");
  const merged = commentOnly;
  assertEquals(
    classifyHazards(merged).filter((c) => classifyHazards(driverText).includes(c)),
    [],
    "a comment-only mention inherits NONE of the driver's hazard classes",
  );

  // 2. A real MODULE SPECIFIER still inherits: importing runs the driver.
  const importRef = `${own}import { x } from "../${DRIVER}";\n`;
  assert(realDriverRefs(importRef).includes(DRIVER), "an import specifier is a real driver reference");
  const dynRef = `${own}await import("../" + "wasm-tree-shaking" + ".test.ts");\n`;
  // runtime-assembled specifier stays invisible to any text detector (residue,
  // unchanged from the old rule — recorded, not hidden):
  assertEquals(realDriverRefs(dynRef), [], "a runtime-assembled specifier is invisible to text detection (documented residue)");
  const requireRef = `${own}const m = require("./${DRIVER}");\n`;
  assert(realDriverRefs(requireRef).includes(DRIVER), "a require call is a real driver reference");

  // 3. A real SPAWN ARGUMENT still inherits: spawning runs the driver.
  const spawnRef = `${own}new Deno.Command("deno", { args: ["test", "-A", "${DRIVER}"] }).output();\n`;
  assert(realDriverRefs(spawnRef).includes(DRIVER), "a spawn argument is a real driver reference");
  const execRef = `${own}execFileSync("deno", ["test", "${DRIVER}"]);\n`;
  assert(realDriverRefs(execRef).includes(DRIVER), "an exec argument is a real driver reference");

  // 3b. TEMPLATES THAT CAN LOAD are references too (audiofeed-astra review):
  // a no-substitution template specifier loads exactly like a quoted one —
  // the shape that cost the generator taxonomy round 5 — and a template quote
  // inside a spawn argument list must not end the spawn window.
  const templateImport = `import(\`../${DRIVER}\`);\n`;
  assert(realDriverRefs(templateImport).includes(DRIVER), "a no-substitution template specifier is a real driver reference");
  const templateSpawn = `${own}new Deno.Command("deno", { args: [\`test\`, "${DRIVER}"] }).output();\n`;
  assert(realDriverRefs(templateSpawn).includes(DRIVER), "a spawn window crosses template quotes to the path argument");
  // A SUBSTITUTING template stays invisible (runtime assembly — residue, unchanged):
  const substituting = "await import(`../tests/" + "${name}`);\n";
  assertEquals(realDriverRefs(substituting), [], "a substituting template is runtime assembly (documented residue)");

  // The inheritance END-TO-END through the merged classifier: a wrapper that
  // genuinely spawns the hazard driver sees its classes; the comment-only
  // wrapper does not.
  const withSpawn = [own, `const cmd = new Deno.Command("deno", { args: ["test", "${DRIVER}"] });`, driverText].join("\n");
  assertStringIncludes(
    classifyHazards(withSpawn).join("|"),
    "reads extension/" + "dist",
    "spawning the driver inherits its reads-dist hazard",
  );

  // 4. Prose in a STRING (not a load/spawn context) is still not a reference.
  const prose = `${own}const note = "mirrors the approach of ${DRIVER}";\n`;
  assertEquals(realDriverRefs(prose), [], "a doc string naming a driver is prose, not a reference");
});

Deno.test("partition guard: SERIAL membership is pinned with reasons and exists on disk", async () => {
  assertEquals(new Set(Object.keys(SERIAL_REASONS)), SERIAL, "SERIAL is exactly the reasoned set");
  for (const [rel, reason] of Object.entries(SERIAL_REASONS)) {
    assert(reason.trim().length > 0, `${rel}: every serial entry states WHY it is a hazard`);
    const st = await Deno.stat(`${ROOT}${rel}`).catch(() => null);
    assert(st !== null, `${rel}: serial entry must exist on disk`);
  }
  for (const [rel, reason] of Object.entries(EXEMPTIONS)) {
    assert(reason.trim().length > 0, `${rel}: every exemption states why the hazard does not apply`);
    const st = await Deno.stat(`${ROOT}${rel}`).catch(() => null);
    assert(st !== null, `${rel}: exemption must name a file that exists on disk`);
    assert(!SERIAL.has(rel), `${rel}: a file is serial OR exempt, never both`);
    // An exemption whose file no longer classifies as ANY hazard is dead
    // weight that hides its own reason from review (audiofeed-astra, 8b8w
    // review: durable-root's entry survived its own obsolescence silently).
    const own = await Deno.readTextFile(`${ROOT}${rel}`);
    assert(
      classifyHazards(own).length > 0 || realDriverRefs(own).length > 0,
      `${rel}: exemption is DEAD — the file classifies with no hazard classes and no driver refs; delete the entry`,
    );
  }
});

// Pinned literal list of reviewed READ_ONLY_DIST files (P1a: 323kf).
// Prevents silent removal of readers from the post-build batch.
const EXPECTED_READ_ONLY_DIST = [
  "tests/diff-core.test.ts",
  "tests/wasm-tree-shaking.test.ts",
  "tests/bundle-budget.test.ts",
  "tests/bundled-tool-packages.test.ts",
  "tests/tool-exec-preview.test.ts",
  "tests/owner-approval-security.test.ts",
];

Deno.test("partition guard: READ_ONLY_DIST membership is pinned with reasons, exists on disk, and is disjoint from SERIAL", async () => {
  assertEquals(
    new Set(EXPECTED_READ_ONLY_DIST),
    READ_ONLY_DIST,
    "READ_ONLY_DIST must match the reviewed pinned list of read-only dist consumers",
  );
  assertEquals(new Set(Object.keys(READ_ONLY_DIST_REASONS)), READ_ONLY_DIST, "READ_ONLY_DIST is exactly the reasoned set");
  assert(READ_ONLY_DIST.size === 6, "READ_ONLY_DIST must contain exactly 6 reviewed files");
  for (const [rel, reason] of Object.entries(READ_ONLY_DIST_REASONS)) {
    assert(reason.trim().length > 0, `${rel}: every read-only dist entry states why it runs in the post-build batch`);
    const st = await Deno.stat(`${ROOT}${rel}`).catch(() => null);
    assert(st !== null, `${rel}: read-only dist entry must exist on disk`);
    assert(!SERIAL.has(rel), `${rel}: read-only dist entry must be disjoint from SERIAL`);
  }
});

Deno.test("323kf: build.mjs spawn or tree write in an exempted READ_ONLY_DIST file is flagged as an unserialised hazard", async () => {
  const target = "tests/diff-core.test.ts";
  assert(READ_ONLY_DIST.has(target), "target must be in READ_ONLY_DIST");

  // 1. Normal read-only usage (reading dist) is exempted
  const normalUsage = [
    [target, `const bundle = await Deno.readTextFile("extension/dist/diff-core.js");`],
  ] as [string, string][];
  assertEquals(unserialisedHazards(normalUsage), [], "normal read-only dist access is exempted");

  // 2. Gaining a build.mjs spawn must be flagged, not forgiven by EXEMPTIONS
  const spawnBuild = [
    [
      target,
      `
      const bundle = await Deno.readTextFile("extension/dist/diff-core.js");
      new Deno.Command("deno", { args: ["run", "-A", "scripts/build.mjs"] }).output();
      `,
    ],
  ] as [string, string][];
  const spawnViolations = unserialisedHazards(spawnBuild);
  assertEquals(
    spawnViolations,
    [`${target} — new build-spawn hazard in the read-only post-build batch`],
    "spawn of build.mjs in a READ_ONLY_DIST file must be flagged",
  );

  // 3. Gaining a write under extension/ must also be flagged
  const writeExtension = [
    [
      target,
      `
      const bundle = await Deno.readTextFile("extension/dist/diff-core.js");
      await Deno.writeTextFile("extension/dist/temp.js", "foo");
      `,
    ],
  ] as [string, string][];
  const writeViolations = unserialisedHazards(writeExtension);
  assertEquals(
    writeViolations,
    [`${target} — new write hazard in the read-only post-build batch`],
    "write under extension/ in a READ_ONLY_DIST file must be flagged",
  );

  // 4. Preceding variable binding for build.mjs must also be flagged (P1b)
  const precedingBinding = [
    [
      target,
      `
      const bundle = await Deno.readTextFile("extension/dist/diff-core.js");
      const builder = "scripts/build.mjs";
      new Deno.Command("node", { args: [builder] }).output();
      `,
    ],
  ] as [string, string][];
  const bindingViolations = unserialisedHazards(precedingBinding);
  assertEquals(
    bindingViolations,
    [`${target} — new build-spawn hazard in the read-only post-build batch`],
    "spawn of bound builder variable in a READ_ONLY_DIST file must be flagged",
  );

  // 5. Unresolved spawn in a READ_ONLY_DIST file must be flagged
  const unresolvedSpawn = [
    [
      target,
      `
      const bundle = await Deno.readTextFile("extension/dist/diff-core.js");
      const runner = getRunner();
      runner.spawn();
      `,
    ],
  ] as [string, string][];
  const unresolvedViolations = unserialisedHazards(unresolvedSpawn);
  assertEquals(
    unresolvedViolations,
    [`${target} — unreviewed spawn in the read-only post-build batch`],
    "unresolved spawn in a READ_ONLY_DIST file must be flagged",
  );

  // 6. Array-join build spawn in bundled-tool-packages.test.ts must be flagged (P1: 323kf)
  const arrayJoinBuild = [
    [
      "tests/bundled-tool-packages.test.ts",
      `
      const baseline = JSON.parse(await Deno.readTextFile("./fixtures/bundled-inventory-baseline.json"));
      const provenance = await new Deno.Command("git", {
        args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`],
        cwd: repoRoot, stdout: "null", stderr: "piped",
      }).output();

      const selected = ["scripts/", "build.mjs"].join("");
      new Deno.Command("node", { args: [selected] }).output();
      `,
    ],
  ] as [string, string][];
  const arrayJoinViolations = unserialisedHazards(arrayJoinBuild);
  assertEquals(
    arrayJoinViolations,
    ["tests/bundled-tool-packages.test.ts — new build-spawn hazard in the read-only post-build batch"],
    "array-join build spawn in tests/bundled-tool-packages.test.ts must be flagged",
  );

  // 7. Any other unreviewed spawn in bundled-tool-packages.test.ts must be flagged
  const unreviewedSpawn = [
    [
      "tests/bundled-tool-packages.test.ts",
      `
      const baseline = JSON.parse(await Deno.readTextFile("./fixtures/bundled-inventory-baseline.json"));
      const provenance = await new Deno.Command("git", {
        args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`],
        cwd: repoRoot, stdout: "null", stderr: "piped",
      }).output();

      new Deno.Command("ls", { args: ["-la"] }).output();
      `,
    ],
  ] as [string, string][];
  const unreviewedViolations = unserialisedHazards(unreviewedSpawn);
  assertEquals(
    unreviewedViolations,
    ["tests/bundled-tool-packages.test.ts — unreviewed spawn in the read-only post-build batch"],
    "unreviewed spawn in tests/bundled-tool-packages.test.ts must be flagged",
  );

  // 8. Spoofed-signature unreviewed spawn in bundled-tool-packages.test.ts must be flagged
  const spoofedSpawn = [
    [
      "tests/bundled-tool-packages.test.ts",
      `
      const baseline = JSON.parse(await Deno.readTextFile("./fixtures/bundled-inventory-baseline.json"));
      const provenance = await new Deno.Command("git", {
        args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`],
        cwd: repoRoot, stdout: "null", stderr: "piped",
      }).output();

      // Spoofed signature in unrelated argument text (env var)
      new Deno.Command("node", {
        env: { SPOOF: '"git", { args: ["cat-file", "-e"' },
        args: ["worker.js"],
      }).output();
      `,
    ],
  ] as [string, string][];
  const spoofedViolations = unserialisedHazards(spoofedSpawn);
  assertEquals(
    spoofedViolations,
    ["tests/bundled-tool-packages.test.ts — unreviewed spawn in the read-only post-build batch"],
    "spawn with spoofed git-cat-file signature in unrelated argument text must be flagged",
  );

  // 9. A second git cat-file call in bundled-tool-packages.test.ts must be rejected (single reviewed site only)
  const duplicateGitSpawn = [
    [
      "tests/bundled-tool-packages.test.ts",
      `
      const baseline = JSON.parse(await Deno.readTextFile("./fixtures/bundled-inventory-baseline.json"));
      const provenance = await new Deno.Command("git", {
        args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`],
        cwd: repoRoot, stdout: "null", stderr: "piped",
      }).output();

      // Second git cat-file call (must be rejected - only exactly one reviewed spawn permitted)
      const secondCall = await new Deno.Command("git", {
        args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`],
        cwd: repoRoot, stdout: "null", stderr: "piped",
      }).output();
      `,
    ],
  ] as [string, string][];
  const duplicateViolations = unserialisedHazards(duplicateGitSpawn);
  assertEquals(
    duplicateViolations,
    ["tests/bundled-tool-packages.test.ts — unreviewed spawn in the read-only post-build batch"],
    "second git-cat-file call in tests/bundled-tool-packages.test.ts must be flagged",
  );

  // 10. git cat-file with different args (e.g. HEAD instead of baseline commit) must be rejected
  const differentArgsGitSpawn = [
    [
      "tests/bundled-tool-packages.test.ts",
      `
      const baseline = JSON.parse(await Deno.readTextFile("./fixtures/bundled-inventory-baseline.json"));
      const provenance = await new Deno.Command("git", {
        args: ["cat-file", "-e", "HEAD"],
        cwd: repoRoot, stdout: "null", stderr: "piped",
      }).output();
      `,
    ],
  ] as [string, string][];
  const differentArgsViolations = unserialisedHazards(differentArgsGitSpawn);
  assertEquals(
    differentArgsViolations,
    ["tests/bundled-tool-packages.test.ts — unreviewed spawn in the read-only post-build batch"],
    "git-cat-file call with unreviewed args (HEAD) must be flagged",
  );

  // 11. Real tests/bundled-tool-packages.test.ts on disk has only the reviewed git provenance spawn and no violations
  const realBundledContent = await Deno.readTextFile(`${ROOT}tests/bundled-tool-packages.test.ts`);
  assertEquals(
    unserialisedHazards([["tests/bundled-tool-packages.test.ts", realBundledContent]]),
    [],
    "real tests/bundled-tool-packages.test.ts on disk must pass with only its reviewed git provenance spawn",
  );
});

Deno.test("partition guard: isReviewedReadOnlySpawn requires anchored executable, pinned args, and rejects spoofed arg text", () => {
  assert(
    isReviewedReadOnlySpawn(
      "tests/bundled-tool-packages.test.ts",
      `"git", { args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`], cwd: repoRoot }`,
    ),
    "exact git cat-file invocation with baseline commit must be accepted",
  );
  assert(
    !isReviewedReadOnlySpawn(
      "tests/bundled-tool-packages.test.ts",
      `"git", { args: ["cat-file", "-e", "HEAD"], cwd: repoRoot }`,
    ),
    "git cat-file invocation with different args (HEAD) must be rejected",
  );
  assert(
    !isReviewedReadOnlySpawn(
      "tests/bundled-tool-packages.test.ts",
      `"node", { env: { FAKE: '"git", { args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`]' }, args: ["run.js"] }`,
    ),
    "spoofed signature in env var must be rejected",
  );
  assert(
    !isReviewedReadOnlySpawn(
      "tests/bundled-tool-packages.test.ts",
      `"sh", { args: ["-c", 'echo "git", { args: ["cat-file", "-e"'] }`,
    ),
    "spoofed signature in shell args must be rejected",
  );
  assert(
    !isReviewedReadOnlySpawn(
      "tests/other-file.test.ts",
      `"git", { args: ["cat-file", "-e", \`\${baseline.takenAt}^{commit}\`] }`,
    ),
    "other files must be rejected even with exact git cat-file invocation",
  );
});

// hso8: content hazards are re-derived from the tree by the detectors above; a wall-clock
// flake declaration is a review-time decision that nothing re-derives, so deleting the entry
// leaves the guard GREEN and silently returns the file to the parallel phase (drilled on
// 18f825dd6 during chrome-agent-platform-3vi7's review). Pin the reviewed declarations by
// name — extend this list when a new wall-clock flake is declared, never remove an entry
// without re-running that review.
const WALL_CLOCK_FLAKE_SERIAL = [
  "tests/serial-phase-timeout.test.ts", // 3vi7 + cihz: declared 5000 ms work vs 4000 ms flat / 12000 ms scaled bounds
  "tests/chrome-slot-semaphore-honesty.test.ts", // mee3: 1.5 s skip bound vs 2 s marker window
];

Deno.test("partition guard: reviewed wall-clock flake declarations are pinned by name", () => {
  for (const rel of WALL_CLOCK_FLAKE_SERIAL) {
    assert(
      SERIAL.has(rel),
      `${rel}: a reviewed wall-clock flake declaration was removed — re-run the review before returning it to the parallel phase`,
    );
    assert(
      ((SERIAL_REASONS as Record<string, string | undefined>)[rel] ?? "").trim().length > 0,
      `${rel}: a pinned serial entry must keep its reason`,
    );
  }
});

Deno.test("partition guard: the split is total, disjoint, and new safe files default to parallel", async () => {
  const files = await allTestFiles();
  const { serial, parallel } = partition(files);
  assertEquals(serial.length + parallel.length, files.length, "every file runs exactly once");
  assertEquals(serial.filter((f) => parallel.includes(f)), [], "no file in both phases");
  assertEquals(serial, [...files].filter((f) => SERIAL.has(f)).sort(), "serial phase is exactly SERIAL ∩ suite");
  // A brand-new test with no hazard content lands in the parallel phase with
  // no partition edit (the safe default this bead preserves).
  const probe = "tests/zz-hypothetical-new-safe.test.ts";
  const { serial: s2, parallel: p2 } = partition([...files, probe]);
  assert(p2.includes(probe), "a new hazard-free test defaults to parallel");
  assert(!s2.includes(probe), "a new hazard-free test never lands serial by default");
});

Deno.test("partition guard: Emscripten live preparation runs serially", () => {
  // Real preparation requires current Store artifacts and briefly mutates the
  // live extension; the indirect helper call escapes the textual detector.
  const file = "tests/emscripten-abi-loaded-harness.test.ts";
  assertEquals(partition([file]), { serial: [file], parallel: [] });
});

Deno.test("partition guard: the detectors classify the known hazards", async () => {
  // Self-test of the classifier on synthetic content — pins the detector
  // semantics independently of whichever real files happen to match. Every
  // trigger substring is assembled here so the guard's own text stays inert.
  const BUILD = "build" + ".mjs"; // the build script's file name
  const GEN = "scripts/build-bundled" + "-tool-packages.mjs"; // the bundled-tool generator
  const EXT = "extension" + "/";
  const PKG = "packages" + "/";
  const DIST = EXT + "dist";

  const spawnBuild = `const r = spawnSync("node", ["${BUILD}", "--target=store"]);`;
  assertStringIncludes(classifyHazards(spawnBuild).join("|"), "spawns " + BUILD);
  const spawnGen = `await new Deno.Command("node", { args: ["${GEN}", "--verify"] }).output();`;
  assertStringIncludes(classifyHazards(spawnGen).join("|"), "bundled-tool generator");
  const writeTree = "await Deno.writeText" + `File(ROOT + "${PKG}bundled/x.txt", "x");`;
  assertStringIncludes(classifyHazards(writeTree).join("|"), "writes under " + EXT + " or " + PKG);
  const readDist = `await Deno.readFile(new URL("${DIST}/shared/x.js", ROOT));`;
  assertStringIncludes(classifyHazards(readDist).join("|"), "reads " + DIST);
  // Plain reads of committed sources are NOT hazards.
  assertEquals(classifyHazards(`await Deno.readTextFile("${EXT}lib/agent.js");`), []);
  assertEquals(classifyHazards(`import { x } from "../${EXT}lib/pure.js";`), []);
  // READING build.mjs in code IS NOT LOADING IT — but the code-presence rule flags the name in code
  // anyway, and that is deliberate: over-declaring costs a declaration, while missing a load runs a
  // generator in the parallel phase. So this asserts the OVER-DECLARATION for code references rather
  // than pretending it away, and it is the same policy that EXEMPTS the four tests which read or cite
  // build.mjs in code strings (see EXEMPTIONS).
  assertStringIncludes(
    classifyHazards(`const src = await Deno.readTextFile("${BUILD}");`).join("|"),
    "names " + BUILD,
    "naming build.mjs in code is flagged even for a read — conservative, and the exemption list exists for those",
  );

  // 4lc0 round 5 + o4m2: any CODE reference (import, require, re-export, string or template literal)
  // naming the generator or build.mjs is flagged, while comment prose is stripped first with full JS
  // lexical awareness so explaining a build script in a comment never forces an EXEMPTIONS entry.
  const IMPORT_HAZARD = "names " + BUILD;
  const gen = `../${GEN}`;
  const flaggedByCodePresence: Record<string, string> = {
    quotedImport: `import { A } from "${gen}";`,
    templateNoSubstitution: "import(`" + gen + "`);",              // round 5's hole
    templateWithComment: "import(/* fixed */ `" + gen + "`);",
    minified: `import{A}from"${gen}";`,
    bare: `import "${gen}";`,
    requireLiteral: `const m = require("${gen}");`,
    reExport: `export * from "${gen}";`,
    proseInAString: `const docs = "the bundles come from ${GEN}";`,
  };
  for (const [label, text] of Object.entries(flaggedByCodePresence)) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: naming the generator in code is a hazard whatever the syntax carries it (over-declaring is the safe direction)`,
    );
  }
  // Negatives: another module's name, a path that merely LOOKS like a build file, and comment prose (o4m2).
  assertEquals(classifyHazards(`import { x } from "../extension/lib/pure.js";`), []);
  assertEquals(classifyHazards(`import { x } from "../scripts/other-packages.mjs";`), []);
  assertEquals(classifyHazards(`// generated by ${gen}`), [], "a comment naming the generator is prose, not a hazard (o4m2)");

  // LEXICAL CONTEXTS (cap-astra 4lc0 round 3 + o4m2): the comment stripper must respect strings,
  // regex literals (including `/\/\//`, `/"/`, `/[/*]/`, `/[//]/`, and `if (...) /.../`), and
  // `${...}` template interpolations so a comment-like sequence inside code never swallows a
  // real import that follows it.
  const lexicalCases: Record<string, string> = {
    urlThenImport: `const u = "https://example.com/a//b"; import { A } from "${gen}";`,
    regexSlashes: String.raw`const slashes = /\/\//; ` + `const m = await import("${gen}");`,
    regexQuote: `const quote = /"/;\nconst m = await import(/* fixed module */ "${gen}");`,
    regexCharClassBlock: `const r = /[/*]/; const m = await import("${gen}"); /* trailing */`,
    regexCharClassLine: `const r = /[//]/; const m = await import("${gen}");`,
    ifParenRegex: `if (true) /\\/\\//.test("x"); const m = await import("${gen}");`,
    templateInterp: 'const count = `${Object.keys((await import(/* fixed module */ "' + gen + '")).AGENT_DESCRIPTIONS).length}`;',
  };
  for (const [label, text] of Object.entries(lexicalCases)) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: a string, regex literal, or template interpolation must never hide a real import`,
    );
  }

  // LINE TERMINATORS (cap-astra): a JS line comment ends at CR, U+2028 and U+2029 as well as LF.
  // The reviewer's probe showed Node's VM reaching the generator specifier through all four, while
  // 2fd — whose STRIPPER deleted the rest of the "line" — saw only LF. The lexical scanner stops
  // `//` at all four ECMAScript LineTerminators.
  for (const [termName, term] of Object.entries({ LF: "\n", CR: "\r", LS: "\u2028", PS: "\u2029" })) {
    const beforeStatement = `// comment${term}const m = await import("${"../" + GEN}");`;
    const betweenTokens = `import // c${term}("${"../" + GEN}")`;
    assertStringIncludes(classifyHazards(beforeStatement).join("|"), IMPORT_HAZARD, `${termName}: comment before the statement`);
    assertStringIncludes(classifyHazards(betweenTokens).join("|"), IMPORT_HAZARD, `${termName}: comment between import and its paren`);
  }
  // o4m2: A COMMENT NAMING THE GENERATOR IS NOT A HAZARD — aligned with realDriverRefs (8b8w/f94p).
  assertEquals(
    classifyHazards(`// ${GEN} only`),
    [],
    "a comment naming the generator is prose, not a build-artifact hazard (o4m2)",
  );

  // PERF: the previous pattern-based attempt HUNG on this input (measured: killed at 60 s).
  const nasty = `import(${("/* a */".repeat(400) + " ".repeat(2000))}`;
  const t0 = Date.now();
  classifyHazards(nasty);
  classifyHazards(nasty + "x");
  const stripMs = Date.now() - t0;
  assert(stripMs < 2000, `two scans of a 6 kB comment run took ${stripMs} ms — the classifier must stay linear`);

  // A RE-EXPORT IS A LOAD TOO — `export * from "<generator>"` and `export { x } from "<generator>"`
  // evaluate the target module exactly as an import does.
  const exportStar = `export * from "../${GEN}";`;
  const exportNamed = `export { AGENT_DESCRIPTIONS } from "../${GEN}";`;
  const exportAliased = `export { AGENT_DESCRIPTIONS as D } from "../${GEN}";`;
  const exportDefault = `export { default } from "../${GEN}";`;
  const exportMinified = `export*from"../${GEN}";`;
  for (const [label, text] of Object.entries({ exportStar, exportNamed, exportAliased, exportDefault, exportMinified })) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: a re-export evaluates the module and must be a hazard`,
    );
  }
  assertEquals(classifyHazards(`export * from "../${EXT}lib/pure.js";`), [], "re-exporting another module is not a hazard");

  // Negatives: importing something else, and merely NAMING the generator in prose comments (o4m2).
  assertEquals(classifyHazards(`import { x } from "../${EXT}lib/pure.js";`), []);
  assertEquals(
    classifyHazards(`// the bundles are made by ${GEN}, see it for the details`),
    [],
    "naming the generator in a comment is prose, not a hazard (o4m2)",
  );
  // DOCUMENTED RESIDUE, pinned so a future detector that closes it fails this line and updates
  // the note rather than silently changing coverage: a specifier built at RUNTIME is invisible to
  // a text scan. This is a limit, not an invariant being asserted as desirable.
  assertEquals(classifyHazards(`const m = await import(somePath);`), []);
});

Deno.test("o4m2: prose comments naming build.mjs or the generator stay parallel-safe while code/load/spawn references classify as hazards", async () => {
  const { durableDir } = await import("../scripts/lib/durable-root.mjs");
  const BUILD = "build" + ".mjs";
  const GEN = "scripts/build-bundled" + "-tool-packages.mjs";

  // 1. Unit assertions in both directions:
  //    (a) Prose comments (line comments, block comments, doc comments, and comments in a file that
  //        spawns an unrelated process) must NOT classify as build-artifact hazards.
  const proseCases: Record<string, string> = {
    lineCommentBuild: `// ${BUILD}'s variable goes through the same parser (CAP_BUNDLED_TOOL_TIMEOUT_MS)\nDeno.test("pure", () => {});\n`,
    lineCommentGen: `// see ${GEN} for how tool packages are generated\nDeno.test("pure", () => {});\n`,
    blockCommentBoth: `/**\n * Explains ${BUILD} and ${GEN} without touching either.\n */\nDeno.test("pure", () => {});\n`,
    commentInsideInterp: "const msg = `${/* " + BUILD + " and " + GEN + " */ 42}`;\n",
    unrelatedSpawnWithComment: `// ${BUILD} and ${GEN} are only mentioned in this comment\nnew Deno.Command("node", { args: ["-e", "process.exit(0)"] });\n`,
  };
  for (const [label, text] of Object.entries(proseCases)) {
    assertEquals(
      classifyHazards(text),
      [],
      `${label}: a prose comment mentioning ${BUILD} / ${GEN} must not classify as a hazard`,
    );
  }

  //    (b) Real load/spawn/code references to build.mjs or build-bundled-tool-packages.mjs MUST
  //        still classify as hazards.
  const hazardCases: Record<string, { text: string; expected: string }> = {
    spawnBuild: {
      text: `// comment before\nspawnSync("node", ["${BUILD}", "--target=store"]);\n`,
      expected: "spawns " + BUILD,
    },
    spawnGen: {
      text: `/* block comment */\nnew Deno.Command("node", { args: ["${GEN}", "--verify"] });\n`,
      expected: "spawns " + BUILD,
    },
    staticImportGen: {
      text: `import { AGENT_DESCRIPTIONS } from "../${GEN}";\n`,
      expected: "names " + BUILD,
    },
    dynamicImportBuild: {
      text: `await import("../${BUILD}");\n`,
      expected: "names " + BUILD,
    },
    templateImportGen: {
      text: "await import(`../" + GEN + "`);\n",
      expected: "names " + BUILD,
    },
    codeReadBuild: {
      text: `const src = await Deno.readTextFile("${BUILD}");\n`,
      expected: "names " + BUILD,
    },
  };
  for (const [label, { text, expected }] of Object.entries(hazardCases)) {
    assertStringIncludes(
      classifyHazards(text).join("|"),
      expected,
      `${label}: a real load/spawn/code reference must still classify as a hazard`,
    );
  }

  // 2. End-to-end planted scratch tree check (unserialisedHazards + partition):
  //    A planted pure test with prose comments mentioning both build.mjs and
  //    build-bundled-tool-packages.mjs stays parallel-phase green with no EXEMPTIONS entry,
  //    while planted load/spawn files are caught as unserialised hazards.
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-o4m2-census-" });
  try {
    await Deno.mkdir(`${scratch}/tests`, { recursive: true });
    const planted: Record<string, string> = {
      "tests/planted-prose-only.test.ts":
        `// ${BUILD}'s variable (CAP_BUNDLED_TOOL_TIMEOUT_MS) and ${GEN} are described in prose only.\n` +
        `/* Neither ${BUILD} nor ${GEN} is loaded or spawned here. */\n` +
        `Deno.test("pure timeout parser", () => {});\n`,
      "tests/planted-spawn-build.test.ts":
        `import { spawnSync } from "node:child_process";\n` +
        `Deno.test("runs build", () => { spawnSync("node", ["${BUILD}"]); });\n`,
      "tests/planted-load-gen.test.ts":
        `import { AGENT_DESCRIPTIONS } from "../${GEN}";\n` +
        `Deno.test("loads gen", () => { void AGENT_DESCRIPTIONS; });\n`,
    };
    for (const [rel, body] of Object.entries(planted)) {
      await Deno.writeTextFile(`${scratch}/${rel}`, body);
    }
    const walked: Array<[string, string]> = [];
    for await (const entry of Deno.readDir(`${scratch}/tests`)) {
      if (!entry.name.endsWith(".test.ts")) continue;
      walked.push([`tests/${entry.name}`, await Deno.readTextFile(`${scratch}/tests/${entry.name}`)]);
    }
    assertEquals(walked.length, 3, "walk must see all three planted files");
    const violations = unserialisedHazards(walked);
    assertEquals(
      violations.map((v) => v.split(" — ")[0]).sort(),
      ["tests/planted-load-gen.test.ts", "tests/planted-spawn-build.test.ts"],
      `planted prose-only test must stay green while planted load/spawn tests fail the census: ${violations.join(" | ")}`,
    );
    const { serial, parallel } = partition(walked.map(([rel]) => rel));
    assertEquals(serial, []);
    assert(parallel.includes("tests/planted-prose-only.test.ts"), "planted prose-only test defaults to the parallel phase");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }

  // 3. The live repo files whose only mention of build.mjs is comment prose
  //    (tests/bounded-child.test.ts and tests/zod-jitless-fallback.test.ts)
  //    need no EXEMPTIONS entry and stay in the parallel phase.
  for (const rel of ["tests/bounded-child.test.ts", "tests/zod-jitless-fallback.test.ts"]) {
    assert(!(rel in EXEMPTIONS), `${rel}: prose-only comment file must not need an EXEMPTIONS entry`);
    assert(!SERIAL.has(rel), `${rel}: prose-only comment file must stay in the parallel phase`);
    const text = await Deno.readTextFile(`${ROOT}${rel}`);
    assertEquals(classifyHazards(text), [], `${rel}: classifies with zero hazards`);
  }
});

Deno.test("4lc0 fresh-instance gate: a NEW file that would bypass the census is caught by the census RULE", async () => {
  // The reviews were about NEW instances, and the first version of this gate only proved the
  // CLASSIFIER on a path it claimed: with census enforcement bypassed, all six guard tests stayed
  // green (cap-astra, 2026-09-24). So this plants REAL files in a scratch tree, walks it the way the
  // census walks tests/, and applies the SAME exported invariant the census applies — a scratch tree
  // rather than the repo because a transient `*.test.ts` importer in the real tree could be selected
  // by a concurrent run and regenerate the CAS dir inside its parallel phase, which is the very
  // hazard this whole bead is about.
  const { durableDir } = await import("../scripts/lib/durable-root.mjs");
  const GEN_NAME = "scripts/build-bundled" + "-tool-packages.mjs";
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-4lc0-census-" });
  try {
    await Deno.mkdir(`${scratch}/tests`, { recursive: true });
    const planted: Record<string, string> = {
      "tests/fresh-compact.test.ts": `import{AGENT_DESCRIPTIONS}from"../${GEN_NAME}";\nDeno.test("x", () => {});\n`,
      "tests/fresh-wrapped.test.ts": `import {\n  AGENT_DESCRIPTIONS,\n} from "../${GEN_NAME}";\nDeno.test("x", () => {});\n`,
      "tests/fresh-safe.test.ts": `import { x } from "../extension/lib/pure.js";\nDeno.test("x", () => {});\n`,
    };
    for (const [rel, body] of Object.entries(planted)) await Deno.writeTextFile(`${scratch}/${rel}`, body);
    // Walk the scratch tree exactly as the census walks the real one (files ending in .test.ts).
    const walked: Array<[string, string]> = [];
    for await (const entry of Deno.readDir(`${scratch}/tests`)) {
      if (!entry.name.endsWith(".test.ts")) continue;
      walked.push([`tests/${entry.name}`, await Deno.readTextFile(`${scratch}/tests/${entry.name}`)]);
    }
    assertEquals(walked.length, 3, "the walk must see every planted file, or this gate is measuring nothing");
    const violations = unserialisedHazards(walked);
    // BOTH importers are violations, by name — and the safe file is not, so the rule is not just
    // "everything in this tree is a hazard".
    assertEquals(
      violations.map((v) => v.split(" — ")[0]).sort(),
      ["tests/fresh-compact.test.ts", "tests/fresh-wrapped.test.ts"],
      `a fresh build-module importer must be a census violation: ${violations.join(" | ")}`,
    );
    for (const v of violations) assertStringIncludes(v, "names " + "build" + ".mjs");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

Deno.test("4lc0: the DELIMITER CLASS is proved by LOADING, not by the predicate agreeing with itself", async () => {
  // cap-astra's round-5 objection, taken as the spec for this test: "add a LOAD-LEVEL assertion (Deno
  // must actually evaluate a marker module) rather than another class-string check, because every
  // round so far has been 'my predicate agrees with my predicate'". So this does not ask the
  // classifier whether a shape is dangerous — it RUNS the shape and checks whether the module was
  // really EVALUATED (the marker writes a file on evaluation, so resolution alone cannot satisfy it),
  // and then checks that the classifier covers every shape that loaded (and stays quiet on the
  // comment-only negative control that did not load).
  const { durableDir } = await import("../scripts/lib/durable-root.mjs");
  const scratch = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-4lc0-load-" });
  const marker = `${scratch}/marker.mjs`;
  const evaluated = `${scratch}/evaluated.txt`;
  await Deno.writeTextFile(
    marker,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(evaluated)}, "evaluated");\nexport const marker = true;\n`,
  );
  // Each shape is a real one-line program. `commentOnly` is the negative control: it NAMES the module
  // without loading it, so the loader must not evaluate the marker.
  const shapes: Record<string, string> = {
    quotes: `await import(${JSON.stringify(marker)});`,
    templateNoSubstitution: "await import(`" + marker + "`);", // ROUND 5'S HOLE: loads, looked safe
    templateWithComment: "await import(/* fixed path */ `" + marker + "`);",
    commentOnly: `// ${marker} is mentioned here and nothing loads it`,
  };
  // THE ENUMERATION IS ASSERTED, NOT CLAIMED (cap-astra): four shapes, and the predicate table must
  // cover exactly the same set — otherwise "the assertion enumerates what it claims" is itself an
  // unverified claim about the test.
  const predicateShapes: Record<string, string> = {
    quotes: `import(${JSON.stringify(generatorSpecForTest())});`,
    templateNoSubstitution: "import(`" + generatorSpecForTest() + "`);",
    templateWithComment: "import(/* fixed path */ `" + generatorSpecForTest() + "`);",
    commentOnly: `// ${generatorSpecForTest()} is mentioned here and nothing loads it`,
  };
  assertEquals(Object.keys(shapes).length, 4, "the loader table enumerates four shapes");
  assertEquals(Object.keys(predicateShapes).sort(), Object.keys(shapes).sort(), "the predicate table enumerates the SAME shapes as the loader table");
  function generatorSpecForTest(): string {
    return "../" + "scripts/build-bundled" + "-tool-packages.mjs";
  }
  try {
    for (const [name, body] of Object.entries(shapes)) {
      await Deno.remove(evaluated).catch(() => {});
      const child = `${scratch}/child-${name}.mjs`;
      await Deno.writeTextFile(child, body + "\n");
      const r = await new Deno.Command(Deno.execPath(), { args: ["run", "-A", child], stdout: "piped", stderr: "piped" }).output();
      const loaded = await Deno.stat(evaluated).then(() => true).catch(() => false);
      const expectLoad = name !== "commentOnly";
      assertEquals(
        loaded, expectLoad,
        `${name}: the LOADER ${expectLoad ? "must" : "must not"} have evaluated the marker (exit ${r.code}, stderr ${new TextDecoder().decode(r.stderr).slice(0, 200)}) — this is the observable the predicate only predicts`,
      );
      // AND THE PREDICATE MUST AGREE WITH THE LOADER ON EVERY SHAPE: every shape that loaded is
      // flagged as a hazard, and the comment-only negative control (which did not load) stays clean.
      const shapeText = predicateShapes[name];
      // A THROW rather than assert(): it narrows the type AND fails loudly, where a fallback let a
      // missing key pass by pointing the predicate at a different path.
      if (typeof shapeText !== "string") {
        throw new Error(`${name}: the predicate table must enumerate this shape too, got ${JSON.stringify(Object.keys(predicateShapes))}`);
      }
      if (expectLoad) {
        assertStringIncludes(
          classifyHazards(shapeText).join("|"), "names " + "build" + ".mjs",
          `${name}: the generator named through this shape must be flagged, got classes=${JSON.stringify(classifyHazards(shapeText))}`,
        );
      } else {
        assertEquals(
          classifyHazards(shapeText),
          [],
          `${name}: a comment-only mention does not load the module and must not be flagged (o4m2)`,
        );
      }
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

// ── chrome-agent-platform-kj9s: the per-file bound table stays honest ────────
// The table exists so a handful of build-heavy files get a window sized to MEASURED work. Two ways
// it could rot: an entry for a file that is not serial (a bound that governs nothing, silently
// accepting a stale filename), or an entry so large it stops being a bound. Both are checked here,
// and the count is capped so the table cannot quietly become a blanket exemption for the phase.
Deno.test("kj9s: every per-file serial bound names a SERIAL file, and no entry stops being a bound", () => {
  const entries = Object.entries(SERIAL_FILE_TIMEOUTS);
  assert(entries.length > 0, "the per-file table must name the files that need it");
  assert(entries.length <= 5, `the per-file table must stay targeted, got ${entries.length} entries`);
  for (const [file, ms] of entries) {
    assert(SERIAL.has(file), `${file} has a per-file bound but is not in the SERIAL phase`);
    assert(Number.isSafeInteger(ms) && ms > 0, `${file} must carry a positive integer bound, got ${ms}`);
    assert(ms <= 1_200_000, `${file}'s bound (${ms}ms) must stay a bound, not an essay-writing window`);
    // A single child build must be killed and NAMED by the child bound before the file window it
    // runs under expires — otherwise the only thing a reader learns is "the file timed out".
    assert(
      PRODUCTION_BUILD_TIMEOUT_MS < ms,
      `${file}'s window (${ms}ms) must outlast one child build (${PRODUCTION_BUILD_TIMEOUT_MS}ms)`,
    );
  }
  // The child bound is MEASURED (~72s store build) x ~4, so it must never fall back to a token value.
  assert(
    Number.isSafeInteger(PRODUCTION_BUILD_TIMEOUT_MS) && PRODUCTION_BUILD_TIMEOUT_MS >= 180_000,
    `the child build bound must stay above the measured build cost, got ${PRODUCTION_BUILD_TIMEOUT_MS}`,
  );
});

Deno.test("h65e: every BUILD_GATE file is enumerated, exists in SERIAL_REASONS, and exists on disk", () => {
  assert(BUILD_GATE_FILES.length >= 3, `BUILD_GATE_FILES must enumerate all build-behaviour tests, got ${BUILD_GATE_FILES.length}`);
  const reasons = BUILD_GATE_REASONS as Record<string, string>;
  for (const file of BUILD_GATE_FILES) {
    assert(SERIAL.has(file), `${file} must be declared in SERIAL_REASONS`);
    assert(typeof reasons[file] === "string" && reasons[file].length > 0, `${file} must have a non-empty reason in BUILD_GATE_REASONS`);
    assert(Deno.statSync(`${ROOT}${file}`).isFile, `${file} must exist on disk`);
  }
});

Deno.test("h65e: fast smoke assertion remains in SERIAL to catch broken builds in npm test", () => {
  const smoke = "tests/build-smoke.test.ts";
  assert(SERIAL.has(smoke), `${smoke} must be declared in SERIAL_REASONS`);
  assert(!BUILD_GATE.has(smoke), `${smoke} must stay in npm test, not in BUILD_GATE`);
  assert(Deno.statSync(`${ROOT}${smoke}`).isFile, `${smoke} must exist on disk`);
});

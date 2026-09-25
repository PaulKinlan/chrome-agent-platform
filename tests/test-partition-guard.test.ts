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
  classifyHazards,
  EXEMPTIONS,
  partition,
  realDriverRefs,
  SERIAL,
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
  // READING build.mjs IS NOT LOADING IT — but the round-5 presence rule flags the name anyway, and
  // that is deliberate: over-declaring costs a declaration, while missing a load runs a generator in
  // the parallel phase. So this asserts the OVER-DECLARATION rather than pretending it away, and it is
  // the same policy that EXEMPTS the five tests which only read or cite build.mjs (see EXEMPTIONS).
  assertStringIncludes(
    classifyHazards(`const src = await Deno.readTextFile("${BUILD}");`).join("|"),
    "names " + BUILD,
    "naming build.mjs is flagged even for a read — conservative, and the exemption list exists for those",
  );

  // 4lc0 round 5: THE TAXONOMY IS DELETED, SO ITS FORM MATRIX WENT WITH IT. Five rounds each found a
  // syntax the rule did not model (line shape, spacing, comments, quote delimiters, then a
  // no-substitution template), and every one of those rounds was protected by assertions of the form
  // "the classifier returns this string for this text" — which is the reviewer's "my predicate agrees
  // with my predicate". The rule is now a PRESENCE test (does the file name the generator at all), so
  // what is left here is the small table of shapes that must be flagged and the negatives that must
  // not; the shape that can actually LOAD a module is proved by the load-level test below, which runs
  // the code instead of asking the classifier about it.
  //
  // A side effect worth recording: the earlier regex-based rules needed PERF assertions (a
  // `*`-quantified `[\s\S]*?` once hung this classifier, and an ambiguous line-comment arm once made
  // it exponential in slash runs). A substring presence test has no backtracking to bound, so those
  // assertions are gone because the risk is gone, not because the protection was dropped.
  const IMPORT_HAZARD = "names " + BUILD;
  const gen = `../${GEN}`;
  const flaggedByPresence: Record<string, string> = {
    quotedImport: `import { A } from "${gen}";`,
    templateNoSubstitution: "import(`" + gen + "`);",              // round 5's hole
    templateWithComment: "import(/* fixed */ `" + gen + "`);",
    minified: `import{A}from"${gen}";`,
    bare: `import "${gen}";`,
    requireLiteral: `const m = require("${gen}");`,
    reExport: `export * from "${gen}";`,
    commentOnly: `// generated by ${gen}`,
    proseInAString: `const docs = "the bundles come from ${GEN}";`,
  };
  for (const [label, text] of Object.entries(flaggedByPresence)) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: naming the generator is a hazard whatever the syntax carries it (over-declaring is the safe direction)`,
    );
  }
  // Negatives: another module's name, and a path that merely LOOKS like a build file.
  assertEquals(classifyHazards(`import { x } from "../extension/lib/pure.js";`), []);
  assertEquals(classifyHazards(`import { x } from "../scripts/other-packages.mjs";`), []);

  // LINE TERMINATORS (cap-astra): a JS line comment ends at CR, U+2028 and U+2029 as well as LF.
  // The reviewer's probe showed Node's VM reaching the generator specifier through all four, while
  // 2fd — whose STRIPPER deleted the rest of the "line" — saw only LF. Matching across trivia is
  // immune for a comment before the statement; the class below keeps it immune BETWEEN tokens too.
  for (const [termName, term] of Object.entries({ LF: "\n", CR: "\r", LS: "\u2028", PS: "\u2029" })) {
    const beforeStatement = `// comment${term}const m = await import("${"../" + GEN}");`;
    const betweenTokens = `import // c${term}("${"../" + GEN}")`;
    assertStringIncludes(classifyHazards(beforeStatement).join("|"), IMPORT_HAZARD, `${termName}: comment before the statement`);
    assertStringIncludes(classifyHazards(betweenTokens).join("|"), IMPORT_HAZARD, `${termName}: comment between import and its paren`);
  }
  // A COMMENT NAMING THE GENERATOR IS FLAGGED TOO — the presence rule cannot tell a comment from code,
  // and the safe direction is "declare it". This reverses the stripper-era assertion deliberately: the
  // stripper that could tell them apart was deleted in round 3 because IT introduced a miss (a regex
  // literal read as a comment, swallowing a real import).
  assertStringIncludes(
    classifyHazards(`// ${GEN} only`).join("|"), IMPORT_HAZARD,
    "a comment naming the generator is reported rather than silently dropped — fail-closed",
  );

  // The in-process SCALING ceiling that used to live here is GONE with the regex it was
  // calibrated for: a presence test has no backtracking to bound, so the only perf guard that still
  // earns its place is the BOUNDED CHILD below, which turns a hang in any future rule into a red.
  // PERF: the previous pattern-based attempt HUNG on this input (measured: killed at 60 s).
  // WHAT THIS ASSERTS AND WHAT IT DOES NOT: it catches a regression that is slow but still
  // finishes; a true hang never reaches the assertion, and is caught by the runner's per-file
  // bound instead. The structural protection is the UNROLLED comment body in TRIVIA — an unrolled
  // `[^*]*\*+(?:[^/*][^*]*\*+)*` is linear, a `*`-quantified `[\s\S]*?` is not.
  const nasty = `import(${("/* a */".repeat(400) + " ".repeat(2000))}`;
  const t0 = Date.now();
  classifyHazards(nasty);
  classifyHazards(nasty + "x");
  const stripMs = Date.now() - t0;
  assert(stripMs < 2000, `two scans of a 6 kB comment run took ${stripMs} ms — the classifier must stay linear`);

  // A RE-EXPORT IS A LOAD TOO — found by the author after the reviewer's point that "the rule rewrites
  // nothing" does not prove "no false negatives". `export * from "<generator>"` and
  // `export { x } from "<generator>"` evaluate the target module exactly as an import does; five
  // forms missed until the export alternative existed, and each is pinned here.
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

  // Negatives: importing something else, and merely NAMING the generator in prose.
  assertEquals(classifyHazards(`import { x } from "../${EXT}lib/pure.js";`), []);
  // A comment that NAMES the generator is flagged (presence rule, round 5) — the same fail-closed
  // direction as the dead-comment case above. Only a mention of a DIFFERENT module stays clean.
  assertStringIncludes(
    classifyHazards(`// the bundles are made by ${GEN}, see it for the details`).join("|"), IMPORT_HAZARD,
    "naming the generator in a comment is reported, not silently dropped",
  );
  // DOCUMENTED RESIDUE, pinned so a future detector that closes it fails this line and updates
  // the note rather than silently changing coverage: a specifier built at RUNTIME is invisible to
  // a text scan. This is a limit, not an invariant being asserted as desirable.
  assertEquals(classifyHazards(`const m = await import(somePath);`), []);
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
  // and then checks that the classifier covers every shape that loaded.
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
      // AND THE PREDICATE MUST COVER THE SAME SHAPE the loader just proved. The loader half above used
      // a MARKER path (so evaluation is observable and the generator is never run); this half names
      // the GENERATOR through the same syntax, which is the property that matters: a shape that can
      // load must be flagged. Asking the classifier about the marker path was my own bug in the first
      // draft — it reported "quotes: got classes=[]" for exactly that reason.
      // Built rather than written as a literal, matching this file's style: the classifier looks for
      // the generator's NAME, and a test that names it is exempted above, but assembling it keeps the
      // intent visible to a reader.
      const shapeText = predicateShapes[name];
      // A THROW rather than assert(): it narrows the type AND fails loudly, where a fallback let a
      // missing key pass by pointing the predicate at a different path.
      if (typeof shapeText !== "string") {
        throw new Error(`${name}: the predicate table must enumerate this shape too, got ${JSON.stringify(Object.keys(predicateShapes))}`);
      }
      assertStringIncludes(
        classifyHazards(shapeText).join("|"), "names " + "build" + ".mjs",
        `${name}: the generator named through this shape must be flagged, got classes=${JSON.stringify(classifyHazards(shapeText))}`,
      );
    }
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

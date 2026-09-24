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
  DRIVER_REF_RE,
  EXEMPTIONS,
  partition,
  SERIAL,
  SERIAL_REASONS,
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

// A test that spawns a local tests/*.mjs|*.ts driver inherits the driver's
// classification (the hazard may live in the driver — e.g. the
// package-extension-freshness driver writes the dist-complete marker).
async function contentWithDrivers(rel: string): Promise<string> {
  const text = await Deno.readTextFile(`${ROOT}${rel}`);
  const parts = [text];
  for (const m of text.matchAll(DRIVER_REF_RE)) {
    const driver = m[0];
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
  const violations: string[] = [];
  for (const rel of files) {
    const classes = classifyHazards(await contentWithDrivers(rel));
    if (!classes.length) continue; // safe → defaults to the parallel phase
    if (SERIAL.has(rel)) continue;
    const reason = (EXEMPTIONS as Record<string, string>)[rel];
    if (reason && reason.trim().length > 0) continue;
    violations.push(`${rel} — ${classes.join("; ")}`);
  }
  assertEquals(
    violations,
    [],
    `build-artifact hazard(s) would run in the PARALLEL phase — add each to SERIAL_REASONS in scripts/test-partition.mjs with its reason, or to EXEMPTIONS with a proof of parallel-safety:\n  ${violations.join("\n  ")}`,
  );
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

Deno.test("partition guard: the detectors classify the known hazards", () => {
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
  // No spawn primitive → reading build-source text is not a spawn hazard.
  assertEquals(classifyHazards(`const src = await Deno.readTextFile("${BUILD}");`), []);

  // 4lc0 detector coverage: an independent review (cap-astra, 2026-09-24) split the SAME live
  // import over three lines and the guard went 5/0 while the real partition ran it in the
  // parallel phase, reproducing 8 CAS NotFound failures. One line shape is not a rule, so each
  // normal form below is pinned — and the negatives, so the fix cannot pass by matching anything.
  const IMPORT_HAZARD = "imports " + BUILD;
  const single = `import { A } from "../${GEN}";`;
  const multiline = `import {\n  AGENT_DESCRIPTIONS,\n} from "../${GEN}";`;
  const multilineWithComment = `import {\n  // the constant\n  A,\n} from "../${GEN}";`;
  const bareSideEffect = `import "../${GEN}";`;
  const dynamicLiteral = `const m = await import("../${GEN}");`;
  const requireLiteral = `const m = require("../${GEN}");`;
  const multilineBuild = `import {\n  meta,\n} from "../${BUILD}";`;
  for (const [label, text] of Object.entries({ single, multiline, multilineWithComment, bareSideEffect, dynamicLiteral, requireLiteral, multilineBuild })) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: the import of a build module must classify as a hazard, whatever its line shape`,
    );
  }
  // Negatives: importing something else, and merely NAMING the generator in prose.
  assertEquals(classifyHazards(`import { x } from "../${EXT}lib/pure.js";`), []);
  assertEquals(classifyHazards(`// the bundles are made by ${GEN}, see it for the details`), []);
  // DOCUMENTED RESIDUE, pinned so a future detector that closes it fails this line and updates
  // the note rather than silently changing coverage: a specifier built at RUNTIME is invisible to
  // a text scan. This is a limit, not an invariant being asserted as desirable.
  assertEquals(classifyHazards(`const m = await import(somePath);`), []);
});

Deno.test("4lc0 fresh-instance gate: a NEW file using the evasive import shape is detected on disk", async () => {
  // The review's finding was about a NEW instance, so this plants one: the same live import over
  // three lines, written to disk under tests/ (not a *.test.ts name, so the guard's own walk never
  // picks it up as a test), classified through the same predicate the guard uses, then removed.
  const ROOT_PATH = new URL("..", import.meta.url);
  const probe = new URL("./tmp-4lc0-fresh-instance-probe.ts", ROOT_PATH);
  const GEN_NAME = "scripts/build-bundled" + "-tool-packages.mjs";
  const rel = "tests/tmp-4lc0-fresh-instance-probe.ts";
  try {
    await Deno.writeTextFile(probe, `import {\n  AGENT_DESCRIPTIONS,\n} from "../${GEN_NAME}";\n`);
    const text = await Deno.readTextFile(probe);
    assertStringIncludes(
      classifyHazards(text).join("|"), "imports " + "build" + ".mjs",
      "a fresh file with the wrapped import must be classified as a build-module hazard",
    );
    // AND it must not be able to sit in the parallel phase: the guard's invariant is
    // hazard ⇒ SERIAL (or a reviewed EXEMPTIONS entry), and a new file is in neither.
    assertEquals(SERIAL.has(rel), false, "the probe is not declared serial — so the guard must red for it");
    const { parallel } = partition([rel]);
    assertEquals(parallel, [rel], "partition alone would run it in the parallel phase, which is why the guard is the check");
  } finally {
    await Deno.remove(probe).catch(() => {});
  }
});

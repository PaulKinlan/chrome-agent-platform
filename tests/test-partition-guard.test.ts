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
  // SPACING IS NOT A RULE EITHER (cap-astra re-review): a MINIFIED import went undetected while a
  // fresh instance of it ran in the parallel phase and reproduced 8 CAS NotFound failures. One
  // bypass per review round is one too many, so every spacing the language allows is pinned here:
  // none between `import` and the clause, none around `from`, and a bare import mid-line.
  const minifiedStatic = `import{AGENT_DESCRIPTIONS}from"../${GEN}";`;
  const minifiedNoSpaces = `import{A}from"../${GEN}";`;
  const minifiedMidLine = `const x=1;import{A}from"../${GEN}";console.log(x);`;
  const bareNoSpace = `import"../${GEN}";`;
  const bareMidLine = `const x=1;import"../${GEN}";`;
  const tabbed = `import\t{\n\tA,\n}\tfrom\t"../${GEN}";`;
  for (const [label, text] of Object.entries({ single, multiline, multilineWithComment, bareSideEffect, dynamicLiteral, requireLiteral, multilineBuild, minifiedStatic, minifiedNoSpaces, minifiedMidLine, bareNoSpace, bareMidLine, tabbed })) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: the import of a build module must classify as a hazard, whatever its line shape`,
    );
  }
  // COMMENTS ARE TOKENS TOO (cap-astra, 2026-09-24): `import(/* fixed local path */ "…")` was a
  // known predicate miss the static-spacing tolerance could not address — it is the dynamic form,
  // where the comment sits between the paren and the specifier. The first fix put comment runs INTO
  // the regex and hung the classifier on a pathological comment run (catastrophic backtracking), so
  // comments are stripped by a linear scan first. These pin the case, its variants, and the two
  // ways a stripper can be wrong: not respecting strings, and being quadratic.
  const c1 = `import(/* fixed local path */ "../${GEN}")`;
  const c2 = `const m = await import( // why\n  "../${GEN}")`;
  const c3 = `import { A } /* x */ from "../${GEN}";`;
  const c4 = `import { A } from /* x */ "../${GEN}";`;
  const c5 = `import /* x */ "../${GEN}";`;
  const c6 = `const m = require(/* x */ "../${GEN}")`;
  for (const [label, text] of Object.entries({ c1, c2, c3, c4, c5, c6 })) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: a comment between the tokens must not hide a build-module import`,
    );
  }
  // The string trap: a naive stripper treats the `//` inside this URL as a line comment and would
  // MISS the import on the same line — the stripper must respect string literals.
  const urlThenImport = `const u = "https://example.com/x"; import("${"../" + GEN}");`;
  assertStringIncludes(
    classifyHazards(urlThenImport).join("|"), IMPORT_HAZARD,
    "a // inside a string must not swallow the rest of the line (the stripper respects strings)",
  );
  // A COMMENTED-OUT import IS reported (fail-closed) — the rule no longer rewrites the input, so it
  // cannot tell a comment from code, and the safe direction is "declare it". This reverses the
  // stripper-era assertion deliberately; the stripper is gone because IT introduced a miss.
  assertStringIncludes(
    classifyHazards(`// import { A } from "../${GEN}";`).join("|"), IMPORT_HAZARD,
    "with no rewriting, a commented-out import is reported rather than silently dropped",
  );
  // THE REGRESSION THE STRIPPER CAUSED (cap-astra, lexically-parsed cases): `const slashes = /\/\//;`
  // followed by a real import. A stripper reads the regex literal as an escaped line comment and
  // DELETES the rest of the line — including the import. Matching across trivia cannot lose it, and
  // these three cases are pinned so no future "helpful" rewriting can reintroduce the loss.
  const regexSlashes = String.raw`const slashes = /\/\//; ` + `const m = await import("${"../" + GEN}");`;
  const regexQuote = `const quote = /"/;\nconst m = await import(/* fixed module */ "${"../" + GEN}");`;
  const templateInterp = 'const count = `${Object.keys((await import(/* fixed module */ "' + "../" + GEN + '")).AGENT_DESCRIPTIONS).length}`;';
  for (const [label, text] of Object.entries({ regexSlashes, regexQuote, templateInterp })) {
    assertStringIncludes(
      classifyHazards(text).join("|"), IMPORT_HAZARD,
      `${label}: a regex literal or a template interpolation must not hide an import`,
    );
  }
  // BOUNDED CLASSIFICATION (cap-astra): the perf ceiling above is evaluated AFTER a scan returns, so
  // it cannot fail a hang — and the runner's bound for this file is the shared 600000 ms parallel
  // phase timeout, so a hang here is a ten-minute stall for unrelated work. This spawns the same
  // classification in a CHILD and kills it at a bound, turning "the pattern is exponential" into a
  // failed assertion. It runs the reviewer's scaling fixture, which took 1473 ms at 24 slash-pairs
  // and more than 20 s at 48 with the ambiguous line-comment arm, and 0-1 ms at every size after it.
  const classifyBounded = async (texts: string[], boundMs = 5000): Promise<{ ms: number; classes: string[] } | "timed-out"> => {
    const { durableDir } = await import("../scripts/lib/durable-root.mjs");
    const dir = await Deno.makeTempDir({ dir: durableDir("scratch"), prefix: "cap-4lc0-bounded-" });
    const script = `${dir}/classify.mjs`;
    await Deno.writeTextFile(script, `import { classifyHazards } from ${JSON.stringify(new URL("../scripts/test-partition.mjs", import.meta.url).href)};
const texts = JSON.parse(await new Response(Deno.stdin.readable).text());
const t0 = Date.now();
const classes = texts.map((t) => classifyHazards(t).join("|"));
console.log(JSON.stringify({ ms: Date.now() - t0, classes }));
`);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", script], stdin: "piped", stdout: "piped", stderr: "piped", cwd: ROOT,
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(texts)));
    await writer.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      child.output().then((o) => ({ kind: "done" as const, o })),
      new Promise<{ kind: "timeout" }>((r) => { timer = setTimeout(() => r({ kind: "timeout" }), boundMs); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === "timeout") {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      try { await child.status; } catch { /* reaped */ }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      return "timed-out";
    }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    const line = new TextDecoder().decode(outcome.o.stdout).trim().split("\n").pop() ?? "{}";
    const parsed = JSON.parse(line) as { ms: number; classes: string[] };
    return parsed;
  };
  const slashCases = [8, 16, 24, 48, 96].map((pairs) => `const snippet = "import(${"/".repeat(pairs * 2)}";`);
  const boundedResult = await classifyBounded(slashCases, 5000);
  assert(
    boundedResult !== "timed-out",
    "the classification of five slash-run fixtures (up to 218 chars) did not finish inside 5000 ms — a hang here must fail THIS assertion, not stall the shared parallel phase",
  );
  assert(boundedResult.ms < 5000, `the five fixtures took ${boundedResult.ms} ms; they are inert text and must be sub-millisecond`);
  assertEquals(
    boundedResult.classes.every((c) => c === ""), true,
    `the slash-run fixtures contain no import, so no class: ${JSON.stringify(boundedResult.classes)}`,
  );

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
  // The dead-comment control: a comment that names the generator but imports nothing requests
  // nothing, so it must stay clean — the fail-closed direction is "report an import", not "report
  // the word".
  assertEquals(classifyHazards(`// ${GEN} only`), []);

  // SCALING, NOT JUST A CEILING (cap-astra, bounded-performance P2): their inert fixture at
  // increasing slash runs. With the AMBIGUOUS line-comment arm the classifier took 1 ms at 8
  // slash-pairs, 38 ms at 20, 1473 ms at 24 and more than 20 s at 48 — CPU-bound, not load. The
  // arms are disjoint now (a line comment consumes its terminator), so every size is sub-millisecond.
  // A ceiling rather than a per-size curve, with ~250x headroom over the measured 1 ms: enough to
  // fail an exponential regression while tolerating a loaded box.
  // CORRECTED (cap-astra): this file runs in the PARALLEL phase, so its bound is the SHARED
  // CAP_PARALLEL_TEST_TIMEOUT_MS phase timeout (600000 ms), not a serial per-file 180 s. A hang here
  // therefore burns ten minutes of the phase and can fail unrelated work — which is exactly why the
  // in-process ceiling above is NOT the protection, and the BOUNDED CHILD below is: it caps the
  // classification itself, so a hang is a RED assertion rather than a stalled phase.
  const slashFixture = (pairs: number) => `const snippet = "import(${"/".repeat(pairs * 2)}";`;
  const scaleStart = Date.now();
  for (const pairs of [8, 16, 24, 48, 96]) classifyHazards(slashFixture(pairs));
  const scaleMs = Date.now() - scaleStart;
  assert(scaleMs < 250, `five slash-run fixtures (up to 218 chars) took ${scaleMs} ms — the trivia arms must stay disjoint`);

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
  assertEquals(classifyHazards(`// the bundles are made by ${GEN}, see it for the details`), []);
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
    for (const v of violations) assertStringIncludes(v, "imports " + "build" + ".mjs");
  } finally {
    await Deno.remove(scratch, { recursive: true }).catch(() => {});
  }
});

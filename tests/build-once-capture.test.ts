// chrome-agent-platform-l3dc2: the build-once record's CAPTURE site is unpinned.
//
// build.mjs decides WHAT it records at the publish point - the record's key
// fields and the stdout it captures. Everything around it is pinned: rule B
// (tests/build-parallel-discipline.test.ts) pins the writer call and its
// arguments, tests/build-once-record.test.ts executes the writer's gate, and
// chrome-agent-platform-lsqay pinned the key computation itself
// (scripts/lib/build-once-key.mjs). NOTHING pinned the capture. A wrong key
// field (the commit alone, or a digest of the wrong thing) or stdout "" left
// every test green, and tests/build-smoke.test.ts asserts only exit 0 on the
// reused record.
//
// Three halves, one file, all mutation-checked:
//
//  1. BEHAVIOURAL (injected, no build): a schema-valid published marker plus the
//     build's own publish summary, captured exactly as the capture expression
//     prescribes, written through the REAL writer and read back through the REAL
//     score reader. The on-disk file NAME must equal the key computed
//     independently here (= the name the reader will compute for that marker),
//     and the recorded stdout must be the publish summary, non-empty.
//     SCOPE: this proves the capture shape pipes end to end. The tie to the real
//     build (that the text recorded is what the build itself would emit) is
//     section 3's job, and a real build is exercised by the serial tier
//     (build-smoke / store-doc-denial).
//  2. STRUCTURAL: build.mjs's capture must compute the key through
//     buildOnceKeyFromMarkerText(<the published marker text>) and must build its
//     stdout from the publish summary. Pinned on the AST, with a mutant drill
//     per field (wrong field, wrong source, old two-field key, constant stdout,
//     blank stdout, dropped newline) that must all be flagged, so the pin cannot
//     pass vacuously.
//  3. THE SUMMARY ITSELF (chrome-agent-platform-b7hti, from the first review of
//     this file): sections 1 and 2 both took the summary TEXT on trust - a build
//     whose `publishSummary` initializer was emptied (or hardcoded) still
//     recorded a bare newline and left every assertion green. So the summary
//     expression is EVALUATED here from build.mjs's own source with fixture
//     counts, and the capture template is evaluated with that value: the text
//     written through the real writer is then the build's own two expressions,
//     and it must be non-empty, name what was published, and carry the
//     INTERPOLATED counts (so a constant cannot pose as the summary).
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";
import { parse } from "npm:acorn";
import { createHash } from "node:crypto";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { buildOnceKeyFromMarkerText } from "../scripts/lib/build-once-key.mjs";
import { writeBuildOnceRecord } from "../scripts/lib/build-once-record.mjs";

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const BUILD_MJS = join(ROOT, "build.mjs");

// A marker of the shape dist-complete.mjs publishes (same field set the reader
// validates), so the key derivation under test is the real one.
const COMMIT = "a".repeat(40);
const SOURCE_DIGEST = "b".repeat(64);
const OUTPUT_HASH = "c".repeat(64);
const markerText = `${JSON.stringify({
  commit: COMMIT,
  outputs: [{ path: "background/service-worker.js", sha256: OUTPUT_HASH, size: 42 }],
  schema: "cap-dist-complete-v2",
  source: { digest: SOURCE_DIGEST, files: 1 },
  target: "store",
})}\n`;
const MARKER_FILENAME = ["dist", "complete"].join(".");

function readMarker(root: string) {
  try {
    const raw = Deno.readTextFileSync(join(root, "extension", "dist", MARKER_FILENAME));
    const key = buildOnceKeyFromMarkerText(raw);
    if (!key) return null;
    return { key };
  } catch {
    return null;
  }
}

// The real publish summary's shape is build.mjs's OWN expression (section 3
// evaluates it); this fixture is only the substring set section 1 asserts on.
const summaryMustMention = ["built ", "ATOMICALLY", MARKER_FILENAME + " marker", "rollback-fatal"];

// ── 1. behavioural: the captured record's NAME and STDOUT, through the real writer ──

Deno.test("l3dc2: the captured record's file name and stdout survive the real writer and reader", async () => {
  const root = durableDir("scratch", `l3dc2-capture-${crypto.randomUUID()}`);
  const recordDir = join(root, "records");
  const distDir = join(root, "extension", "dist");
  try {
    // The capture, exactly as build.mjs's capture expression prescribes: the key from the
    // published marker text, the stdout from the BUILD's own summary expression (section 3),
    // plus the newline the capture adds.
    const buildSource = await Deno.readTextFile(BUILD_MJS);
    const key = buildOnceKeyFromMarkerText(markerText);
    assert(key, "a schema-valid marker must yield a key");
    const record = {
      key,
      stdout: evaluateCaptureStdout(buildSource, evaluateSummary(buildSource)),
    };

    // The name computed INDEPENDENTLY of build.mjs and of the key helper: the
    // published marker's commit, its source digest and sha256 of its own bytes.
    const expectedName = `${COMMIT}-${SOURCE_DIGEST}-${createHash("sha256").update(markerText, "utf8").digest("hex")}`;
    assertEquals(record.key, expectedName, "the captured key must name the commit, the source digest AND the marker bytes");

    const written = await writeBuildOnceRecord({ record, buildSucceeded: true, exitCode: 0, recordDir });
    assertEquals(written, { written: true, reason: "written" });

    // (1) the on-disk file name is that key
    const body = JSON.parse(await Deno.readTextFile(join(recordDir, `${expectedName}.json`)));
    assertEquals(body.code, 0);
    // (2) the captured stdout is the publish summary: non-empty, with the
    //     newline the capture adds, and it says what was published
    assertEquals(body.stdout, record.stdout);
    assertEquals(body.stdout.length > 0, true, "a blank stdout silently weakens every consumer of the record");
    for (const marker of summaryMustMention) assertStringIncludes(body.stdout, marker);
    assertEquals(body.stdout.endsWith("\n"), true);
    assertEquals(body.stdout.trimEnd().split("\n").length, 1, "the real capture records the publish summary as one line");

    // The reader derives the same name from the live marker, so the record the
    // build wrote is the record a later serial file will find.
    await Deno.mkdir(distDir, { recursive: true });
    await Deno.writeTextFile(join(distDir, MARKER_FILENAME), markerText);
    assertEquals(readMarker(root)?.key, expectedName);

    // A DIFFERENT published output (same commit, same source digest) must not
    // resolve to the same record name the reader computes.
    const otherMarker = markerText.replace(OUTPUT_HASH, "d".repeat(64));
    await Deno.writeTextFile(join(distDir, MARKER_FILENAME), otherMarker);
    assert(readMarker(root)?.key !== expectedName, "a changed generated output must not reuse the record name");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ── 2. structural: build.mjs's capture expression, with a mutant drill ──

type Node = { type?: string; [key: string]: unknown };

function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type === "string") visit(n);
  for (const [key, value] of Object.entries(n)) {
    if (key !== "parent" && value && typeof value === "object") walk(value, visit);
  }
}

const isIdent = (node: Node | undefined, name: string) => node?.type === "Identifier" && node.name === name;

/** The object literal build.mjs assigns to storeBuildRecord, by property name. */
function captureProperties(source: string): Map<string, Node> {
  let capture: Node | undefined;
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), (n) => {
    if (
      n.type === "AssignmentExpression" &&
      isIdent(n.left as Node, "storeBuildRecord") &&
      (n.right as Node)?.type === "ObjectExpression"
    ) {
      capture = n.right as Node;
    }
  });
  assert(capture, "build.mjs must still assign an object literal to storeBuildRecord (the capture site)");
  const props = new Map<string, Node>();
  for (const prop of (capture as Node).properties as Node[]) {
    const name = ((prop.key as Node)?.name ?? (prop.key as Node)?.value) as string | undefined;
    if (typeof name === "string") props.set(name, prop.value as Node);
  }
  return props;
}

/** The cooked text of a template quasi: build.mjs's capture writes `\n` as an escape,
 *  so the raw text holds a backslash and an "n" while the cooked value holds the newline. */
const quasiText = (q: Node) => String(((q.value as Node)?.cooked ?? (q.value as Node)?.raw) ?? "");

/** Reasons the capture fields do not describe the PUBLISHED build. Empty = pinned. */
function captureProblems(source: string): string[] {
  const props = captureProperties(source);
  const problems: string[] = [];
  const key = props.get("key");
  const args = (key?.arguments ?? []) as Node[];
  if (key?.type !== "CallExpression" || !isIdent(key.callee as Node, "buildOnceKeyFromMarkerText") || !isIdent(args[0], "markerText")) {
    problems.push("the key must be buildOnceKeyFromMarkerText(<the published marker text>), not a hand-built field");
  }
  const stdout = props.get("stdout");
  const template = stdout?.type === "TemplateLiteral" ? (stdout as Node) : undefined;
  const expressions = (template?.expressions ?? []) as Node[];
  const quasis = (template?.quasis ?? []) as Node[];
  if (
    !template ||
    !expressions.some((e) => isIdent(e, "publishSummary")) ||
    !quasis.some((q) => quasiText(q).includes("\n"))
  ) {
    problems.push("stdout must be the publish summary plus its newline (`${publishSummary}\\n`), never a constant or an empty string");
  }
  return problems;
}

Deno.test("l3dc2: build.mjs's capture fields are pinned, and each field mutation is flagged", async () => {
  const clean = await Deno.readTextFile(BUILD_MJS);
  assertEquals(captureProblems(clean), [], "the real capture site must satisfy both pins");

  const keyCall = "buildOnceKeyFromMarkerText(markerText)";
  const stdoutTemplate = "`${publishSummary}\\n`";
  const mutants: Array<[string, string]> = [
    ["key uses the commit alone", clean.replace(keyCall, "writtenMarker.commit")],
    ["key rebuilt by hand (the pre-lsqay two-field shape)", clean.replace(keyCall, "`${writtenMarker.commit}-${writtenMarker.source.digest}`")],
    ["key computed from a different source (the marker object, not its text)", clean.replace(keyCall, "buildOnceKeyFromMarkerText(writtenMarker)")],
    ["stdout is an empty string", clean.replace(stdoutTemplate, '""')],
    ["stdout is a constant", clean.replace(stdoutTemplate, '"published"')],
    ["stdout drops the newline", clean.replace(stdoutTemplate, "`${publishSummary}`")],
  ];
  const flagged = new Map<string, string[]>();
  for (const [name, mutated] of mutants) {
    assert(mutated !== clean, `mutant "${name}" must actually change build.mjs (the pin is vacuous otherwise)`);
    const problems = captureProblems(mutated);
    assert(problems.length > 0, `mutant "${name}" must be flagged by captureProblems(), but nothing was reported`);
    flagged.set(name, problems);
  }
  assertEquals(flagged.size, mutants.length);
});

// ── 3. the summary the capture records is build.mjs's OWN expression (b7hti) ──

/** The source text of build.mjs's `const publishSummary = <expr>` initializer. */
function summaryInitializerSource(source: string): string {
  let init: Node | undefined;
  walk(parse(source, { ecmaVersion: "latest", sourceType: "module" }), (n) => {
    if (n.type === "VariableDeclarator" && isIdent(n.id as Node, "publishSummary")) init = n.init as Node;
  });
  assert(init, "build.mjs must still declare publishSummary — the text its capture records");
  const node = init as Node;
  return source.slice(node.start as number, node.end as number);
}

/** The build's own numbers, as fixtures: a real build's counts differ, and the point here is that the
 *  TEXT comes from build.mjs's expression, not from these values.
 *
 *  lf5vu: TWO sets, each carrying distinct multi-digit values, because ONE set cannot tell
 *  interpolation from a constant - "7" is a substring of "17", so a pasted log line with stale counts
 *  passed the old `includes` check. Two disjoint sets also let the pins require that swapping the
 *  counts CHANGES the emitted text, which no constant can do. */
const SUMMARY_COUNT_SETS: Array<Record<string, number>> = [
  { occurrences: 101, zodProbes: 202, zodDocCompiles: 303 },
  { occurrences: 404, zodProbes: 505, zodDocCompiles: 606 },
];
const SUMMARY_COUNTS = SUMMARY_COUNT_SETS[0];
/** build.mjs reaches `path.join` through the `path` binding it imports. */
const SUMMARY_PATH = { join: (...parts: string[]) => parts.join("/") };

/** Evaluate build.mjs's OWN summary expression with those fixtures: exactly the text a build
 *  prints and captures for those counts. An emptied or hardcoded initializer therefore yields
 *  empty or count-free text here, which is what makes the pins below non-vacuous. */
function evaluateSummary(source: string, counts: Record<string, number> = SUMMARY_COUNTS): string {
  const names = Object.keys(counts);
  const fn = new Function("path", ...names, `return (${summaryInitializerSource(source)});`) as (...a: unknown[]) => unknown;
  return String(fn(SUMMARY_PATH, ...names.map((n) => counts[n])));
}

/** Evaluate build.mjs's OWN capture template (the stdout field) with the summary bound to it:
 *  the exact bytes the capture records. */
function evaluateCaptureStdout(source: string, summary: string): string {
  const node = captureProperties(source).get("stdout");
  assert(node, "build.mjs's capture must still set a stdout field");
  const text = source.slice(node.start as number, node.end as number);
  const fn = new Function("publishSummary", `return (${text});`) as (s: string) => unknown;
  return String(fn(summary));
}

/** Reasons build.mjs's summary expression cannot be what the capture records. Empty = pinned.
 *
 *  lf5vu: every count set is evaluated, and the texts are required to DIFFER - a constant cannot
 *  answer two different count sets with two different summaries, and each set's own values must
 *  appear, so stale digits in a pasted line are no longer enough to pass. */
function summaryProblems(source: string): string[] {
  const problems: string[] = [];
  const emittedBySet: string[] = [];
  for (const counts of SUMMARY_COUNT_SETS) {
    let emitted: string;
    try {
      emitted = evaluateSummary(source, counts);
    } catch (e) {
      return [`the summary expression did not evaluate with the known fixtures (${String((e as Error)?.message ?? e)})`];
    }
    if (typeof emitted !== "string" || emitted.trim().length === 0) {
      return ["the summary expression must produce text: an emptied initializer records a bare newline"];
    }
    emittedBySet.push(emitted);
    for (const marker of summaryMustMention) {
      if (!emitted.includes(marker)) problems.push(`the summary must name what was published: missing ${JSON.stringify(marker)}`);
    }
    for (const [name, value] of Object.entries(counts)) {
      if (!emitted.includes(String(value))) {
        problems.push(`the summary must interpolate the build's own ${name} (${value}), not a hardcoded constant`);
      }
    }
  }
  if (new Set(emittedBySet).size !== emittedBySet.length) {
    problems.push("the summary must be built from its counts: two different count sets produced the same text");
  }
  return problems;
}

Deno.test("b7hti: the recorded stdout is build.mjs's own summary expression, with its interpolated counts", async () => {
  const source = await Deno.readTextFile(BUILD_MJS);
  assertEquals(summaryProblems(source), [], "the real summary expression must satisfy every pin");

  const emitted = evaluateSummary(source);
  const captured = evaluateCaptureStdout(source, emitted);
  assertEquals(captured, `${emitted}\n`, "the capture must record the summary plus the newline it adds");
  assertEquals(captured.trimEnd().split("\n").length, 1, "the recorded summary is one line");

  // Through the REAL writer, onto disk: a consumer reads back that text — not a manufactured
  // sample, and never the bare newline an emptied summary would produce.
  const root = durableDir("scratch", `b7hti-summary-${crypto.randomUUID()}`);
  const recordDir = join(root, "records");
  try {
    const key = buildOnceKeyFromMarkerText(markerText);
    assert(key, "a schema-valid marker must yield a key");
    await writeBuildOnceRecord({ record: { key, stdout: captured }, buildSucceeded: true, exitCode: 0, recordDir });
    const body = JSON.parse(await Deno.readTextFile(join(recordDir, `${key}.json`)));
    assertEquals(body.stdout, captured);
    assert(body.stdout.trim().length > 0, "the recorded stdout must not be only the newline an emptied summary yields");
    for (const marker of summaryMustMention) assertStringIncludes(body.stdout, marker);
    for (const value of Object.values(SUMMARY_COUNTS)) assertStringIncludes(body.stdout, String(value));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("b7hti: an emptied or hardcoded summary initializer is flagged, not silently captured", async () => {
  const clean = await Deno.readTextFile(BUILD_MJS);
  const initializer = summaryInitializerSource(clean);
  const mutants: Array<[string, string]> = [
    ["the summary initializer is emptied", clean.replace(initializer, '""')],
    [
      "the summary is a hardcoded constant with no interpolation",
      clean.replace(initializer, `"built dist ATOMICALLY (seam scan clean; ${MARKER_FILENAME} marker; rollback-fatal)"`),
    ],
    [
      // lf5vu: the reviewer's exact probe - a PASTED log line carrying stale counts. It passed the
      // old single-set `includes` check because 7/3/2 are substrings of 17/13/12.
      "the summary is a pasted log line with stale counts (lf5vu)",
      clean.replace(
        initializer,
        `"built extension/dist/background/service-worker.js + dist/options.bundle.js ATOMICALLY (serialized owner-token lock; one dist dir; removed 17 new-Function + 13 probes + 12 pinned Doc.compile methods; seam scan clean; ${MARKER_FILENAME} marker; rollback-fatal)"`,
      ),
    ],
  ];
  for (const [name, mutated] of mutants) {
    assert(mutated !== clean, `mutant "${name}" must actually change build.mjs (the pin is vacuous otherwise)`);
    const problems = summaryProblems(mutated);
    assert(problems.length > 0, `mutant "${name}" must be flagged by summaryProblems(), but nothing was reported`);
  }
});

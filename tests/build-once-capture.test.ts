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
// Two halves, one file, both mutation-checked:
//
//  1. BEHAVIOURAL (injected, no build): a schema-valid published marker plus the
//     build's own publish summary, captured exactly as the capture expression
//     prescribes, written through the REAL writer and read back through the REAL
//     score reader. The on-disk file NAME must equal the key computed
//     independently here (= the name the reader will compute for that marker),
//     and the recorded stdout must be the publish summary, non-empty.
//     SCOPE: this proves the capture shape pipes end to end. It does NOT prove
//     that a REAL build's stdout is what lands in publishSummary - that tie is
//     the structural half's job, and the real build itself is exercised by the
//     serial tier (build-smoke / store-doc-denial).
//  2. STRUCTURAL: build.mjs's capture must compute the key through
//     buildOnceKeyFromMarkerText(<the published marker text>) and must build its
//     stdout from the publish summary. Pinned on the AST, with a mutant drill
//     per field (wrong field, wrong source, old two-field key, constant stdout,
//     blank stdout, dropped newline) that must all be flagged, so the pin cannot
//     pass vacuously.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl, join } from "jsr:@std/path@1";
import { parse } from "npm:acorn";
import { createHash } from "node:crypto";
import { durableDir } from "../scripts/lib/durable-root.mjs";
import { buildOnceKeyFromMarkerText } from "../scripts/lib/build-once-key.mjs";
import { writeBuildOnceRecord } from "../scripts/lib/build-once-record.mjs";
import { readMarker } from "./fixtures/build-once.mjs";

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
// The real publish summary's shape (build.mjs prints it before capturing it):
// one line, no trailing newline; the capture adds the newline.
const publishSummary = `built ${join("extension", "dist", "background", "service-worker.js")} + dist/options.bundle.js ATOMICALLY (serialized owner-token lock; one dist dir; seam scan clean; dist.complete marker; rollback-fatal)`;

// ── 1. behavioural: the captured record's NAME and STDOUT, through the real writer ──

Deno.test("l3dc2: the captured record's file name and stdout survive the real writer and reader", async () => {
  const root = durableDir("scratch", `l3dc2-capture-${crypto.randomUUID()}`);
  const recordDir = join(root, "records");
  const distDir = join(root, "extension", "dist");
  try {
    // The capture, exactly as build.mjs's capture expression prescribes.
    const key = buildOnceKeyFromMarkerText(markerText);
    assert(key, "a schema-valid marker must yield a key");
    const record = {
      key,
      stdout: `${publishSummary}\n`,
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
    assertStringIncludes(body.stdout, "ATOMICALLY");
    assertEquals(body.stdout.endsWith("\n"), true);
    assertEquals(body.stdout.trimEnd().split("\n").length, 1, "the real capture records the publish summary as one line");

    // The reader derives the same name from the live marker, so the record the
    // build wrote is the record a later serial file will find.
    await Deno.mkdir(distDir, { recursive: true });
    await Deno.writeTextFile(join(distDir, "dist.complete"), markerText);
    assertEquals(readMarker(root)?.key, expectedName);

    // A DIFFERENT published output (same commit, same source digest) must not
    // resolve to the same record name the reader computes.
    const otherMarker = markerText.replace(OUTPUT_HASH, "d".repeat(64));
    await Deno.writeTextFile(join(distDir, "dist.complete"), otherMarker);
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

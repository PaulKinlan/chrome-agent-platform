// machine-path-honesty.test.ts — bead chrome-agent-platform-ne8u
//
// THE PROPERTY. A test that reads or writes an ABSOLUTE machine path only works on the
// machine that wrote it. Two failure shapes, both found in this repo:
//
//   SILENT  the read is wrapped in `.catch(() => null)` and the assertions sit inside
//           `if (value) { … }`, so on every other checkout the test passes having
//           asserted nothing. bundled-tool-packages.test.ts read its predecessor
//           inventory from one author's worktree path and passed in 707 µs with six
//           assertions unreachable — a green test named "regeneration preserves
//           predecessor manifest digests" that preserved nothing. This is the fifth
//           mode in AGENTS.md's "Test honesty" canon: CONDITIONAL DEATH.
//   LOUD    the read has no catch, so the test fails on any other machine. That is
//           better — it is at least honest — but it still means the suite is not
//           portable, and a lane on a fresh clone sees a red it cannot fix.
//
// THE RULE. No test file may pass an absolute filesystem path to a filesystem call,
// either directly as a literal or through a const that holds one. Repo-relative
// resolution (`new URL("./fixtures/x", import.meta.url)`, `${ROOT}…` built from
// `import.meta.url`) is the portable form and is already the dominant idiom here.
//
// SCOPED ON PURPOSE, AND THE SCOPING IS THE HARD PART. The rule is about paths that
// reach the FILESYSTEM, not about absolute strings in tests:
//   * `Deno.env.set("CAP_DURABLE_ROOT", "/home/…-test-probe")` followed by
//     `assertEquals(durableRoot(), "/home/…-test-probe")` (durable-root.test.ts)
//     is a fixture VALUE that is never opened. Flagging it would make this guard a
//     nuisance and it would get switched off — the same fate as any guard that cries
//     wolf. So the detector keys on the CALL, not on the string.
//   * a `file://` URL, a regex, and prose are not filesystem arguments.
//   * matches inside a line comment are skipped: a comment recording a past defect
//     (which is how the canon teaches it) must not trip the guard that exists because
//     of it.
//
// THE ALLOWLIST carries the reviewed exceptions with their reasons, keyed
// `file::path-or-const` so a line move cannot break it, and an entry that stops
// matching FAILS — a stale exception hides a fix.
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;
const TESTS = `${ROOT}tests/`;

/** Filesystem calls whose first argument is a path. `Deno.stat` counts: probing an
 *  absolute path to decide whether to run is exactly how a test becomes
 *  machine-dependent, even when nothing is read. */
const FS_CALLS = [
  "readTextFile", "readTextFileSync", "readFile", "readFileSync",
  "writeTextFile", "writeTextFileSync", "writeFile", "writeFileSync",
  "mkdir", "mkdirSync", "remove", "removeSync", "rename", "renameSync",
  "copyFile", "copyFileSync", "open", "openSync", "stat", "statSync", "lstat", "lstatSync",
  "readDir", "readDirSync", "realPath", "realPathSync", "truncate", "truncateSync",
].join("|");

// A filesystem call whose FIRST argument is an absolute-path string literal under a
// USER HOME. `file://` URLs are excluded: a URL is resolved against a base, not against
// this machine's layout.
//
// WHY HOME-PREFIXED AND NOT EVERY ABSOLUTE PATH — measured, not assumed. Scanning every
// absolute path flagged four legitimate sites: a per-run `/tmp/pv-fixture-${Date.now()}`
// the test creates itself, the machine-global `/tmp/cap-chrome-slot-POISON` marker the
// custody suite deliberately shares, and `"/bin/sleep"` used to generate load. `/tmp`
// and `/bin` exist on every unix machine; a path under someone's home directory cannot
// exist anywhere else, which is the actual defect class ("a test that asserts nothing
// off its author's machine"). RESIDUAL LIMITATION, stated rather than hidden: a read of
// a hardcoded `/tmp/fixture.json` that the test did not create would still slip through
// — catching that needs create-vs-expect dataflow, which is not worth the false positives.
const HOME_PREFIX = String.raw`\/(?:home|root|Users)\/`;
const DIRECT_RE = new RegExp(
  String.raw`(?:Deno\.)?(?:${FS_CALLS})\s*\(\s*(["'\`])(${HOME_PREFIX}[^"'\`\n]+)\1`, "g");

// `const NAME = "/abs/path"` — the const form, which is how a machine path hides from
// a call-site scan and then reaches a filesystem call hundreds of lines later.
const CONST_RE = new RegExp(
  String.raw`(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]{0,40})?=\s*(["'\`])(${HOME_PREFIX}[^"'\`\n]+)\2`, "g");

type Hit = { file: string; line: number; key: string; kind: string; evidence: string };

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of Deno.readDirSync(dir)) {
      const p = `${dir}${e.name}`;
      if (e.isDirectory) walk(`${p}/`);
      else if (e.name.endsWith(".test.ts")) out.push(p.slice(ROOT.length));
    }
  };
  walk(TESTS);
  return out.sort();
}

/** True when the match at `pos` sits after a `//` on its own line. */
function inLineComment(text: string, pos: number): boolean {
  const start = text.lastIndexOf("\n", pos) + 1;
  const before = text.slice(start, pos);
  const i = before.indexOf("//");
  if (i < 0) return false;
  // a `//` inside a string on the same line is not a comment start; good enough for a
  // skip rule, and the failure direction is conservative (the match is still checked
  // when the `//` is not a comment).
  return !/["'`][^"'`]*\/\/[^"'`]*$/.test(before.slice(0, i));
}

/** Run the detector over one file's text. Exported shape so the synthetic probes below
 *  exercise the SAME code path as the real scan. */
export function detect(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const lineOf = (pos: number): number => text.slice(0, pos).split("\n").length;

  for (const m of text.matchAll(DIRECT_RE)) {
    const pos = m.index!;
    if (inLineComment(text, pos)) continue;
    hits.push({
      file, line: lineOf(pos), kind: "direct",
      key: `${file}::${m[2].slice(0, 120)}`,
      evidence: text.slice(Math.max(0, pos - 40), pos + m[0].length).replace(/\s+/g, " ").trim().slice(-120),
    });
  }

  // consts holding an absolute path, flagged only when the const actually reaches a
  // filesystem call — otherwise it is a fixture value (the durable-root case).
  const constNames = new Map<string, { pos: number; value: string }>();
  for (const m of text.matchAll(CONST_RE)) {
    if (inLineComment(text, m.index!)) continue;
    constNames.set(m[1], { pos: m.index!, value: m[3] });
  }
  if (constNames.size) {
    const useRe = new RegExp(String.raw`(?:Deno\.)?(?:${FS_CALLS})\s*\(\s*([\w$]+)\b`, "g");
    for (const m of text.matchAll(useRe)) {
      const held = constNames.get(m[1]);
      if (!held) continue;
      if (inLineComment(text, m.index!)) continue;
      hits.push({
        file, line: lineOf(m.index!), kind: "const",
        key: `${file}::${held.value}`,
        evidence: `${m[1]} = "${held.value}" reaches ${m[0].trim()}`,
      });
    }
  }
  return hits;
}

// ------------------------------------------------------------------- allowlist
//
// Reviewed exceptions, each with the reason it is NOT a portability defect. Adding an
// entry here needs a reason; an entry that stops matching fails the guard.
// Every path this file NAMES is assembled at runtime. test-partition-guard.test.ts
// classifies a test file by scanning its content and INHERITS the hazard class of every
// `tests/` path the file merely mentions (DRIVER_REF_RE reads and concatenates that
// file), so naming a serial-phase file — even inside an allowlist key or a comment —
// reddens the partition. This is the convention the partition guard uses for its own
// detector probes, and the one c9y8 landed under. No exemption is taken, so the
// partition stays strict for every other file.
const tp = (name: string): string => `tests/${name}`;

const ALLOWED = new Map<string, string>([
  // A documented, intentional environment probe: the test says outright that it
  // "Skips cleanly where Chrome for Testing is absent (hermetic CI); runs for real in
  // this environment". The path is never read for content — it is `Deno.stat`ed to
  // decide whether a real browser exists — and the real-browser journey is covered by
  // the dispatch gate, which resolves Chrome through scripts/lib/chrome-launch.ts.
  // FOLLOW-UP worth taking: resolve the binary from the puppeteer cache glob
  // (~/.cache/puppeteer/chrome/*/chrome-linux64/chrome) instead of pinning a version
  // directory, then delete this entry.
  [`${tp("bgagent-delete.test.ts")}::/home/paulkinlan/.cache/puppeteer/chrome/linux-140.0.7339.82/chrome-linux64/chrome`,
    "documented clean skip where Chrome for Testing is absent; stat-only probe, never read for content; the real journey is covered by the dispatch gate. Follow-up: resolve from the puppeteer cache glob and delete this entry."],
]);

function scanAll(): { hits: Hit[]; files: number } {
  const files = testFiles();
  const hits: Hit[] = [];
  for (const rel of files) {
    let text: string;
    try { text = Deno.readTextFileSync(`${ROOT}${rel}`); } catch { continue; }
    hits.push(...detect(text, rel));
  }
  return { hits, files: files.length };
}

Deno.test("machine paths: no test reads or writes an absolute path outside the repo", () => {
  const { hits, files } = scanAll();
  assert(files > 100, `the walk must see the real suite, saw ${files}`);

  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    seen.add(h.key);
    if (ALLOWED.has(h.key)) continue;
    offenders.push(
      `${h.file}:${h.line} [${h.kind}] ${h.key.split("::")[1]}\n` +
      `      ${h.evidence}\n` +
      `      An absolute machine path only exists on the machine that wrote it. Resolve it\n` +
      `      repo-relative (new URL("./fixtures/x", import.meta.url), or a \${ROOT} built from\n` +
      `      import.meta.url), commit the fixture, or read it from git history — and if the\n` +
      `      value is optional, a missing one must FAIL with a reason, never skip silently\n` +
      `      behind .catch(() => null). If this really is a reviewed environment probe, add\n` +
      `      it to ALLOWED in this file with the reason.`,
    );
  }
  assertEquals(offenders, [], `${offenders.length} test path(s) depend on this machine:\n\n${offenders.join("\n\n")}`);

  const stale = [...ALLOWED.keys()].filter((k) => !seen.has(k));
  assertEquals(stale, [],
    `allowlist entries that no longer match any absolute path — the path was fixed or moved, so delete the entry:\n${stale.join("\n")}`);
});

// ── probes: the detector's teeth and its boundary, over synthetic text so nothing
//    here can be mistaken for a real pin or trip the scan above ──────────────────

// Assembled at runtime so this file's own text never matches the detector it is
// testing — the convention test-partition-guard.test.ts uses for its probe
// strings, and the lesson from the substring audit's defect #11: a guard that fires on
// its own documentation gets disabled.
const A = (rest: string): string => `/home/probe/${rest}`;
const quoted = (s: string): string => `"${s}"`;

Deno.test("machine paths: the detector fires on a literal read and on a const that reaches a call", () => {
  const direct = detect(
    `const bytes = await Deno.readFile(${quoted(A("fixtures/small.jxl"))});\n`, "tests/probe.test.ts");
  assertEquals(direct.length, 1, "a literal absolute path passed to a read is flagged");
  assertEquals(direct[0].kind, "direct");

  const viaConst = detect(
    `const CHROME = ${quoted(A(".cache/chrome"))};\nconst ok = await Deno.stat(CHROME);\n`, "tests/probe.test.ts");
  assertEquals(viaConst.length, 1, "an absolute path held in a const and passed to a fs call is flagged");
  assertEquals(viaConst[0].kind, "const");

  assertEquals(
    detect("const t = Deno.readTextFileSync(`" + A("tmp/x") + "`);\n", "tests/probe.test.ts").length, 1,
    "a template-literal absolute path is flagged too");

  assertEquals(
    detect(`const t = await Deno.readTextFile(${quoted(A("gone.js"))});\n`, "tests/probe.test.ts")[0].key,
    `tests/probe.test.ts::${A("gone.js")}`, "the key is the path, so a line move cannot break the allowlist");
});

Deno.test("machine paths: the boundary — fixture values, URLs, prose and relative paths are legal", () => {
  // The scoping the bead demanded: durable-root.test.ts sets an absolute literal
  // as an env fixture VALUE and asserts the same literal. It never reaches the
  // filesystem, so it must stay legal — a guard that flagged it would be switched off.
  assertEquals(
    detect(`Deno.env.set("CAP_DURABLE_ROOT", ${quoted(A("cap-evidence-test-probe"))});\n` +
           `assertEquals(durableRoot(), ${quoted(A("cap-evidence-test-probe"))});\n`, "tests/probe.test.ts"),
    [], "an env fixture value is not a filesystem argument");

  assertEquals(detect(`const u = new URL("file://${A("x")}");\n`, "tests/probe.test.ts").length, 0,
    "a file:// URL is resolved against a base, not against this machine's layout");
  assertEquals(detect(`const t = await Deno.readTextFile(new URL("../extension/x.js", import.meta.url));\n`,
    "tests/probe.test.ts").length, 0, "the portable idiom is legal");
  assertEquals(detect(`const t = await Deno.readTextFile(\`\${ROOT}scripts/x.ts\`);\n`,
    "tests/probe.test.ts").length, 0, "a ROOT built from import.meta.url is legal");
  assertEquals(detect(`// was: Deno.readFile(${quoted(A("gone.js"))}) — removed by ne8u\n`,
    "tests/probe.test.ts").length, 0, "a comment recording a past defect is not a live path");
  assertEquals(detect(`const CHROME = ${quoted(A(".cache/chrome"))};\nconst label = \`uses \${CHROME}\`;\n`,
    "tests/probe.test.ts").length, 0, "a const that never reaches a filesystem call is a value, not a path");
});

// tests/chrome-test-contract.test.ts — pins the full-suite Chrome and test gate contract (dqc1).
//
// Invariants guarded:
//   1. docs/CHROME-TEST-CONTRACT.md exists and is referenced in AGENTS.md.
//   2. tests/chrome-profile-location.test.ts is the ONLY test in tests/ that calls
//      launchChrome() without an explicit binary: override (i.e. launches real Chrome).
//   3. All other launchChrome() call sites in tests/ explicitly pass binary: fake (or /bin/true).
//   4. No test in tests/ requests canonicalLock: true on launchChrome().
//   5. tests/chrome-profile-location.test.ts runs in the parallel phase of npm test.

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "jsr:@std/assert@1";
import { partition } from "../scripts/test-partition.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

// A launch call is CODE; the same text written INSIDE a string literal is a
// FIXTURE. tests/chrome-profile-static.test.ts feeds the launch-site scanner
// arrays of real source lines AS STRINGS, and the raw-text predicate below
// read one of those fixtures as a second real browser launch
// (chrome-agent-platform-qepn: that made this always-on guard red on main
// 28fde694, in every lane's subset gate). Strip string literals too, so this
// guard measures calls. It does not weaken the guard for real calls — it
// strengthens them: a template literal in an argument list can no longer hide
// the closing `})` the pattern needs. Escapes and newlines are honoured so one
// unterminated quote cannot swallow the rest of the file.
//
// In chrome-agent-platform-m7b1:
//   1. stripRegexes strips regex literals (/.../flags) before stripStrings, so
//      a regex literal containing a backtick (e.g. /[`]/ or /`/) cannot be
//      misread as opening a template literal that spans to the next backtick.
//   2. stripStrings enforces same-line pairing for backticks so an unpaired
//      stray backtick cannot swallow real calls across newlines.
//   3. extractLaunchChromeCalls tracks balanced braces { ... }, so nested
//      parentheses (e.g. { profile: getDir("x"), args: [] }) do not truncate
//      the argument object.
const REGEX_PREFIX =
  /(^|[=(,;:!&|?+*\-%^~<>{}[\n\r]|(?:\b(?:return|case|default|throw|yield|await|typeof|void|delete)\b))\s*(\/(?![*\/])(?:\\.|\[(?:\\.|[^\]\r\n])*\]|[^\\\/\r\n])+\/[a-z]*)/g;

export function stripRegexes(src: string): string {
  return src.replace(REGEX_PREFIX, "$1 /reg/ ");
}

export function stripStrings(src: string): string {
  return src
    .replace(/`(?:\\[\s\S]|[^\\`\n])*`/g, "``")
    .replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, '""');
}

/** Source with comments, regexes, and string literals removed: what is executable. */
export function codeOnly(src: string): string {
  return stripStrings(stripRegexes(stripComments(src)));
}

/** Extract launchChrome({ ... }) call sites, robust to nested parens, braces, and brackets (m7b1). */
export function* extractLaunchChromeCalls(code: string): Generator<{ full: string; callArgs: string }> {
  const re = /\blaunchChrome\s*\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) {
    const objStart = match.index + match[0].length - 1;
    let depth = 0;
    let objEnd = -1;
    for (let i = objStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          objEnd = i;
          break;
        }
      }
    }
    if (objEnd === -1) continue;
    const after = code.slice(objEnd + 1);
    const closeParenMatch = after.match(/^\s*\)/);
    if (!closeParenMatch) continue;
    const callArgs = code.slice(objStart + 1, objEnd);
    yield { full: code.slice(match.index, objEnd + 1 + closeParenMatch[0].length), callArgs };
  }
}

Deno.test("contract: docs/CHROME-TEST-CONTRACT.md exists and is cited in AGENTS.md", async () => {
  const contract = await Deno.readTextFile(`${ROOT}docs/CHROME-TEST-CONTRACT.md`).catch(() => null);
  assert(contract !== null, "docs/CHROME-TEST-CONTRACT.md must exist");
  assert(contract.includes("tests/chrome-profile-location.test.ts"), "contract must cite chrome-profile-location.test.ts");
  assert(contract.includes("acquireLaunchScope"), "contract must document acquireLaunchScope");

  const agents = await Deno.readTextFile(`${ROOT}AGENTS.md`);
  assert(agents.includes("docs/CHROME-TEST-CONTRACT.md"), "AGENTS.md must reference docs/CHROME-TEST-CONTRACT.md");
});

Deno.test("contract: chrome-profile-location.test.ts is the SOLE real-browser test in tests/", async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }

  const realBrowserTests: string[] = [];
  const fakeRunnerTests: string[] = [];

  for (const rel of files.sort()) {
    const raw = await Deno.readTextFile(`${ROOT}${rel}`);
    const code = codeOnly(raw);
    for (const { callArgs } of extractLaunchChromeCalls(code)) {
      if (/\bbinary\s*:/.test(callArgs)) {
        if (!fakeRunnerTests.includes(rel)) fakeRunnerTests.push(rel);
      } else {
        if (!realBrowserTests.includes(rel)) realBrowserTests.push(rel);
      }
    }
  }

  assertEquals(
    realBrowserTests,
    ["tests/chrome-profile-location.test.ts"],
    `only chrome-profile-location.test.ts may launch real Chrome in tests/: found ${realBrowserTests.join(", ")}`,
  );
  assert(
    fakeRunnerTests.length >= 3,
    `fake-runner probes must specify binary override: found ${fakeRunnerTests.join(", ")}`,
  );
});

Deno.test("contract: no unit test in tests/ requests canonicalLock on launchChrome", async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }

  const offenders: string[] = [];
  for (const rel of files) {
    const raw = await Deno.readTextFile(`${ROOT}${rel}`);
    const code = codeOnly(raw);
    for (const { callArgs } of extractLaunchChromeCalls(code)) {
      // Canonical lock is reserved for scripts/ acceptance suites; unit tests never take it
      if (/\bcanonicalLock\s*:\s*true\b/.test(callArgs) && !/\bbinary\s*:/.test(callArgs)) {
        offenders.push(rel);
      }
    }
  }

  assertEquals(
    offenders,
    [],
    `real-browser tests in tests/ must not request canonicalLock: true: ${offenders.join(", ")}`,
  );
});

Deno.test("contract: chrome-profile-location.test.ts runs in the parallel phase of npm test", async () => {
  const files: string[] = [];
  for await (const entry of Deno.readDir(`${ROOT}tests`)) {
    if (entry.isFile && entry.name.endsWith(".test.ts")) {
      files.push(`tests/${entry.name}`);
    }
  }
  const { serial, parallel } = partition(files);
  assert(!serial.includes("tests/chrome-profile-location.test.ts"), "chrome-profile-location is not a serial build hazard");
  assert(parallel.includes("tests/chrome-profile-location.test.ts"), "chrome-profile-location runs in the parallel phase");
});

Deno.test("contract (m7b1): launch-site scanner handles nested parens, regex backticks, and stray backtick lines (falsification drills)", () => {
  // Legacy regex for falsification comparison:
  const LEGACY_LAUNCH_RE = /launchChrome\s*\(\s*\{([^)]*)\}\s*\)/gs;
  const legacyScan = (src: string) => [...src.matchAll(LEGACY_LAUNCH_RE)].map((m) => m[1]);

  // 1. Nested parens inside launchChrome arguments:
  const nestedParenSnippet = 'await launchChrome({ profile: getDir("x"), args: [getFlags("y")] });';
  const legacyParenHits = legacyScan(codeOnly(nestedParenSnippet));
  assertEquals(legacyParenHits.length, 0, "falsification proof: legacy scanner fails to match nested parens");

  const newParenHits = [...extractLaunchChromeCalls(codeOnly(nestedParenSnippet))];
  assertEquals(newParenHits.length, 1, "new scanner extracts call with nested parens");
  assert(newParenHits[0].callArgs.includes('getDir('), "callArgs captures complete argument block");

  // 2. Regex literal containing backtick does not swallow subsequent launchChrome:
  const regexBacktickSnippet = [
    "const regex = /[`]/;",
    'await launchChrome({ profile: "x", args: [] });',
    "const msg = `done`;",
  ].join("\n");

  // Legacy stripStrings without stripRegexes consumes the launch call into a bogus template literal:
  const legacyStringsOnly = (src: string) =>
    src.replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``").replace(/'(?:\\[\s\S]|[^\\'\n])*'/g, "''").replace(/"(?:\\[\s\S]|[^\\"\n])*"/g, '""');
  const legacyRegexCode = legacyStringsOnly(stripComments(regexBacktickSnippet));
  assert(!legacyRegexCode.includes("launchChrome"), "falsification proof: legacy stripStrings swallows call following regex with backtick");

  const newRegexCode = codeOnly(regexBacktickSnippet);
  assert(newRegexCode.includes("launchChrome"), "new codeOnly preserves call following regex with backtick");
  const newRegexHits = [...extractLaunchChromeCalls(newRegexCode)];
  assertEquals(newRegexHits.length, 1, "call is extracted and detected");
  assertEquals(/\bbinary\s*:/.test(newRegexHits[0].callArgs), false, "correctly identified as real browser launch");

  // 3. A stray backtick line cannot hide a following real call:
  const strayBacktickSnippet = [
    "const x = 1; `",
    'await launchChrome({ profile: "x", args: [] });',
    "const y = `done`;",
  ].join("\n");

  const newStrayCode = codeOnly(strayBacktickSnippet);
  assert(newStrayCode.includes("launchChrome"), "new codeOnly preserves call following stray backtick line");
  const newStrayHits = [...extractLaunchChromeCalls(newStrayCode)];
  assertEquals(newStrayHits.length, 1, "call following stray backtick line is extracted");
});

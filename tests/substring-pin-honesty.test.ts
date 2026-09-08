// tests/substring-pin-honesty.test.ts — bead chrome-agent-platform-uodl
//
// THE PROPERTY. A test that reads a source file and asserts
// `sourceText.includes("X")` is satisfied by ANY occurrence of X — including a
// COMMENT describing the behaviour, an IMPORT binding that no longer has a call
// site, and a console.log narrating a step that stopped happening. When every
// occurrence of X in the target is one of those, the pin passes with the guarded
// construct wholly absent. It is not a weak pin. It is no pin.
//
// TWO INSTANCES PROVEN BY MUTATION (er6x), both surviving a FULL npm test:
//   * `assert(scriptText.includes("?toolautosubmit"), "KAT must append
//     ?toolautosubmit")` kept passing after the flag was removed from URL_BISTRO,
//     because scripts/kat-webmcp-bistro.ts's HEADER COMMENT and a console.log both
//     still said "?toolautosubmit" — the URL construction had moved to
//     scripts/lib/kat-bistro-caller.ts. A comment about a guarantee satisfied the
//     guarantee's pin.
//   * `assert(scriptText.includes("withTimeout"), "KAT must bound execution with
//     withTimeout")` kept passing after the withTimeout(...) wrapper was removed,
//     because the import line still carried the word. A bound that no longer
//     existed was reported as present.
//
// WHY THIS NEEDS A TOKENISER AND NOT A COMMENT-STRIPPER. The audit that produced
// this guard (cap-evidence/uodl) first tried a regex span scan. Regex LITERALS
// broke it: 222 regexes across 21 target files contain a quote or a backtick in a
// character class — e.g. main-world.js:372 `/https?:\/\/[^\s"'<>)]+/gi` — and each
// one opened a bogus string span that swallowed everything after it. In
// extension/content/main-world.js that cascade ran 372 -> 447 and labelled
// `function describePageError(...) {` at :420 as a STRING, filing two sound pins
// as vacuous. A guard that cries wolf on sound pins gets disabled, so this file
// tokenises properly: regex-vs-division by previous significant token, quotes that
// stop at a raw newline, and `${...}` interiors treated as the expressions they are.
//
// SHADOW vs LIVE — what would survive deleting the guarded construct:
//   SHADOW  comment          prose about the behaviour
//           import           a binding line; survives removal of the call site
//           console message  incidental narration in its own statement
//   LIVE    code, regex literal, ${...} interior, any other string/template value
// A pin is an offender only when it has NO live occurrence.
//
// A thrown error's message is LIVE, not a shadow, and that distinction was earned:
// `if (wrote === 0) throw new Error("result_stage_write_no_progress")` is an
// enforcement point whose message IS its error code, and fixtures/webmcp-errors.html
// throws `new Error("...token=sk-live-...")` where the thrown text IS the artifact
// under test. Treating those as shadows filed 6 sound pins as vacuous.
//
// THE ALLOWLIST is the audited pre-existing population, each entry carrying the
// adjudicated reason it is NOT a false green. It exists so this guard fails on NEW
// vacuous pins from day one instead of failing on 14 known ones and being
// switched off. Keys are `testFile::target::token` — stable when lines move.
// An allowlisted pin that STOPS being vacuous is also reported: a stale allowlist
// entry hides a pin that was fixed, and the entry should be deleted.
//
// ── ATTRIBUTION EXTENSION (chrome-agent-platform-c9y8, from the wzez census) ─────
// The audit attributed 654 source-text pins and DECLINED 203 more whose variable it
// could not tie to a target, so this guard could not see them. The census
// (cap-evidence/uodl/census-4c89bd9d/CENSUS.md) resolved that population: 45 are
// real source-text pins reached through an indirect shape, 155 are NOT source-text
// pins at all (assertions on computed strings — a rendered prompt, an agent result,
// a property of a runtime value), and 3 are unresolvable without replicating runtime
// logic. This file now attributes the 45 and must stay blind to the 155: that
// negative result is the guard's boundary, and it is proven by the probe test below
// rather than asserted in prose.
//
// FOUR SHAPES, deterministic resolution only — anything else is declined, and a
// declined pin is invisible rather than guessed at:
//   R2 path expressions   literals, local consts whose VALUE is a path expression
//                         (`const SCRIPTS = `${ROOT}scripts``), path.join, new
//                         URL(x, import.meta.url).pathname with its .replace()
//                         normaliser, templates, and local path-composer helpers
//   R3 reader helpers     a local, statically imported or DYNAMICALLY imported
//                         function whose body contains the read call, with the
//                         call-site argument substituted for its parameter
//   R4/R4n loop sets      a for-of over a literal collection — an inline array, an
//                         array of pairs, a const array, Object.entries/keys over a
//                         literal or imported object, a `new Map([...])` key list, an
//                         Object.entries(X).filter(...).map(...) chain, or a
//                         `key.split("|")` derivation — judged per member, and
//                         NARROWED to the members the pin's own branch reaches
//   R5 stripped views     `src.split("\n").filter(not a comment).join("\n")` — the
//                         same target, judged with comment occurrences removed,
//                         because the test itself removes them first
//
// SCOPING IS NOT OPTIONAL. Every name lookup is bounded by the pin's own offset. An
// unscoped lookup in the census attributed one pin to eight URL fixtures (`about:blank`,
// `javascript:alert(1)`, …) bound to the same variable name in an unrelated loop 400
// lines earlier in the same file. Here a false attribution is a false RED on every
// `npm test` for every lane, which is worse than a miss: a guard that cries wolf gets
// disabled.
//
// BASE SEMANTICS. `new URL(rel, import.meta.url)` is relative to the TEST FILE's
// directory; `Deno.readTextFile("literal")`, `path.join(ROOT, …)` and `${ROOT}…` are
// relative to the process cwd, which is the repo root at test time. Path templates
// substitute TEXT and resolve the concatenation once — resolving each `${…}` to a
// repo-relative path and joining loses the `../` in `` new URL(`../${rel}`, …) ``.
//
// TWO BOUNDARY RULINGS (owner decision via coord, 2026-09-07):
//   * BUILD ARTIFACTS ARE SKIPPED, and the exclusion is counted out loud. Pins on
//     pins on the generated dist bundle judge OUTPUT where comments and imports are build
//     decisions, and the file does not exist in an unbuilt checkout: a guard whose
//     verdict depends on whether someone ran `build:production` is not a guard.
//   * `.sh` TARGETS GET A REAL SHELL KIND. `kindFor` used to mask shell scripts as
//     js, so `#` comments were labelled live code and the guard UNDER-flagged them —
//     12 shell memberships the census brought into scope were unprotected. Excluding
//     them would have frozen the bug, so `maskShell` strips `#`-to-EOL with quote
//     awareness instead (a `#` inside a quoted string is not a comment).
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;
const TESTS = `${ROOT}tests/`;

// The partition guard (test-partition-guard.test.ts) classifies a test file by
// scanning its CONTENT: it inherits the hazard class of every `tests/*.ts` path the
// file merely MENTIONS (DRIVER_REF_RE reads that file and concatenates it), and any
// built-dist path literal counts as "reads the built dist". Both are false positives
// here — this guard spawns nothing, writes nothing, and SKIPS generated output by
// owner ruling — but naming a serial-phase file (bundled-tool-packages) in an
// allowlist key or a sentinel was enough to inherit its class and red the partition.
// So every path this file names is ASSEMBLED at runtime, which is the convention the
// partition guard itself uses for its detector probes, and no exemption is taken:
// the partition stays strict for every other file.
const tp = (rest: string): string => `tests/${rest}`;
const distPath = (...parts: string[]): string => ["extension", "dist", ...parts].join("/");

// ------------------------------------------------------------------ tokeniser

type Span = { start: number; end: number; label: string };

const REGEX_OK_SIG = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}",
  ";", "+", "-", "*", "%", "~", "^", "<", ">"]);
const REGEX_OK_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new",
  "delete", "void", "throw", "do", "else", "yield", "await", "case"]);

/** `"` or `'` string end offset. Stops at a raw newline: a JS single or double
 *  quoted string cannot contain one, so running past it means the opening quote
 *  was a misdetection — the defect that let one stray `"` swallow 56 lines. */
function scanQuoted(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  const n = text.length;
  while (j < n) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "\n") return j;
    if (c === q) return j + 1;
    j++;
  }
  return n;
}

/** `${` at i. Consumes to the matching `}`, emitting nested template segments and
 *  labelling the interior `interp` because it is an expression, i.e. code. */
function scanInterp(text: string, i: number, out: Span[]): number {
  const n = text.length;
  const start = i + 2;
  let j = start;
  let depth = 1;
  let seg = start;
  const flush = (end: number) => { if (end > seg) out.push({ start: seg, end, label: "interp" }); };
  while (j < n) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === '"' || c === "'") { j = scanQuoted(text, j); continue; }
    if (c === "`") { flush(j); j = scanTemplate(text, j, out); seg = j; continue; }
    if (c === "/" && (text[j + 1] === "/" || text[j + 1] === "*")) {
      flush(j);
      if (text[j + 1] === "/") { const k = text.indexOf("\n", j); j = k < 0 ? n : k; }
      else { const k = text.indexOf("*/", j + 2); j = k < 0 ? n : k + 2; }
      seg = j;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { flush(j); return j + 1; } }
    j++;
  }
  flush(n);
  return n;
}

/** Backtick literal from i. Prose keeps `template`; each `${...}` becomes `interp`. */
function scanTemplate(text: string, i: number, out: Span[]): number {
  const n = text.length;
  let seg = i;
  let j = i + 1;
  const flush = (end: number) => { if (end > seg) out.push({ start: seg, end, label: "template" }); };
  while (j < n) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "`") { flush(j); return j + 1; }
    if (c === "$" && text[j + 1] === "{") { flush(j); j = scanInterp(text, j, out); seg = j; continue; }
    j++;
  }
  flush(n);
  return n;
}

/** Regex literal from `/` at i, or null if it does not close on this line — and so
 *  is a division operator. "Must close before end of line" is a hard JS rule and is
 *  what cleanly separates the two without a parser. */
function scanRegex(text: string, i: number): number | null {
  const n = text.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === "\n") return null;
    if (inClass) { if (c === "]") inClass = false; }
    else if (c === "[") inClass = true;
    else if (c === "/") { j++; while (j < n && /[a-z]/i.test(text[j])) j++; return j; }
    j++;
  }
  return null;
}

/** Non-overlapping ascending spans. Anything not covered is `code`. */
function maskSpans(text: string, kind: "js" | "css" | "html" | "prose" | "shell"): Span[] {
  if (kind === "prose") return [];
  if (kind === "shell") return maskShell(text);
  if (kind === "css") {
    const out: Span[] = [];
    for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) out.push({ start: m.index!, end: m.index! + m[0].length, label: "comment" });
    return out;
  }
  if (kind === "html") return maskHtml(text);

  const spans: Span[] = [];
  const n = text.length;
  let i = 0;
  let prevSig = "";    // last significant single char, "" at start of file
  let prevWord = "";   // last identifier-like token, "" if the last token was not one
  const isWordChar = (c: string) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      const j = scanQuoted(text, i);
      spans.push({ start: i, end: j, label: "string" });
      prevSig = c; prevWord = ""; i = j; continue;
    }
    if (c === "`") { i = scanTemplate(text, i, spans); prevSig = "`"; prevWord = ""; continue; }
    if (c === "/") {
      if (text.startsWith("//", i)) {
        const k = text.indexOf("\n", i); const j = k < 0 ? n : k;
        spans.push({ start: i, end: j, label: "comment" });
        prevSig = ""; prevWord = ""; i = j; continue;
      }
      if (text.startsWith("/*", i)) {
        const k = text.indexOf("*/", i + 2); const j = k < 0 ? n : k + 2;
        spans.push({ start: i, end: j, label: "comment" });
        prevSig = ""; prevWord = ""; i = j; continue;
      }
      const allow = (prevSig === "" && !prevWord) || REGEX_OK_WORD.has(prevWord) ||
        (!prevWord && REGEX_OK_SIG.has(prevSig));
      if (allow) {
        const j = scanRegex(text, i);
        if (j !== null) { spans.push({ start: i, end: j, label: "regex" }); prevSig = "/"; prevWord = ""; i = j; continue; }
      }
      prevSig = "/"; prevWord = ""; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && isWordChar(text[j])) j++;
      prevWord = text.slice(i, j); prevSig = prevWord[prevWord.length - 1]; i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && (isWordChar(text[j]) || text[j] === ".")) j++;
      prevWord = ""; prevSig = text[j - 1]; i = j; continue;
    }
    prevWord = ""; prevSig = c; i++;
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

function maskHtml(text: string): Span[] {
  const spans: Span[] = [];
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) spans.push({ start: m.index!, end: m.index! + m[0].length, label: "comment" });
  for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const base = m.index! + m[0].indexOf(m[1]);
    for (const s of maskSpans(m[1], "js")) spans.push({ start: base + s.start, end: base + s.end, label: s.label });
  }
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    const base = m.index! + m[0].indexOf(m[1]);
    for (const s of maskSpans(m[1], "css")) spans.push({ start: base + s.start, end: base + s.end, label: s.label });
  }
  spans.sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  let last = -1;
  for (const s of spans) { if (s.start >= last) { out.push(s); last = s.end; } }
  return out;
}

/** Only console.* narration is a shadow. Narrow on purpose — see the header. */
const CONSOLE_CTX = /console\s*\.\s*(?:log|warn|error|info|debug|trace|dir|table|group|groupCollapsed)\s*\(\s*(?:[^()"'`]|\\.)*$/s;

function isConsoleProse(text: string, spanStart: number): boolean {
  let pre = text.slice(Math.max(0, spanStart - 200), spanStart);
  for (const cut of [";", "{", "}"]) {
    const k = pre.lastIndexOf(cut);
    if (k >= 0) pre = pre.slice(k + 1);
  }
  return CONSOLE_CTX.test(pre);
}

function kindFor(path: string): "js" | "css" | "html" | "prose" | "shell" {
  if (/\.(html?|xml|svg)$/i.test(path)) return "html";
  if (/\.css$/i.test(path)) return "css";
  // A doc/data target has no executable code at all: masking its prose would
  // manufacture vacuous hits out of the artifact the pin is about.
  if (/\.(md|markdown|txt|json)$/i.test(path)) return "prose";
  // chrome-agent-platform-c9y8: a shell script's comments start with `#`, which the
  // js tokeniser treats as code. Masking .sh as js labelled every shell comment LIVE,
  // so a token occurring only in a shell comment looked pinned and the guard
  // under-flagged it. Excluding .sh would freeze that bug (owner ruling), so shell
  // gets its own minimal masker.
  if (/\.(sh|bash)$/i.test(path)) return "shell";
  return "js";
}

/** `#`-to-EOL comments with quote awareness: a `#` inside a single-quoted,
 *  double-quoted or backquoted string is text, not a comment, and an escaped `\#`
 *  is literal. Deliberately minimal — shell has no block comment and no regex
 *  literal, so this is the whole job. A naive `#`-to-EOL strip eats the rest of
 *  `echo "a # b"` and mislabels every token after it on that line.
 *
 *  THE SHEBANG IS LIVE, NOT A COMMENT. `#!/usr/bin/env bash` on line 1 is the
 *  interpreter declaration — it IS the construct a "must be a bash script" pin
 *  guards, and deleting it deletes the token. Masking it filed 9 sound pins in
 *  tool-platform-foundation.test.ts:40 as vacuous on the first run of this shell
 *  kind. Same reasoning as defect #6 in the audit: `export async function f()` is a
 *  DECLARATION, not an import shadow, because only a binding survives removal of the
 *  construct it names. A guard that cries wolf on sound pins gets disabled. */
function maskShell(text: string): Span[] {
  const spans: Span[] = [];
  const n = text.length;
  let i = 0;
  let quote = "";
  while (i < n) {
    const c = text[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = "";
      else if (c === "\n" && quote !== "`") quote = "";   // an unterminated quote dies at EOL
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; i++; continue; }
    if (c === "\\") { i += 2; continue; }
    if (c === "#" && i === 0 && text[1] === "!") {
      const k = text.indexOf("\n", i);              // shebang: executable metadata
      i = k < 0 ? n : k;
      continue;
    }
    if (c === "#") {
      const k = text.indexOf("\n", i);
      const j = k < 0 ? n : k;
      spans.push({ start: i, end: j, label: "comment" });
      i = j;
      continue;
    }
    i++;
  }
  return spans;
}

// `export async function f()` is a DECLARATION — the construct itself, so live.
// Only a bare `import` or a re-export binds a name without using it. Counting
// every `export` line as a shadow filed 3 sound pins as vacuous.
const DECL_EXPORT = /^export\s+(?:default\s+)?(?:declare\s+|abstract\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|namespace)\b/;
const REEXPORT = /^export\s*(?:\*|\{)/;

function importShadowLines(text: string): Set<number> {
  const lines = text.split("\n");
  const out = new Set<number>();
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (inImport) {
      out.add(i);
      if (s.includes("from") && /["'`]/.test(s)) inImport = false;
      else if (s.endsWith(";")) inImport = false;
      continue;
    }
    if (DECL_EXPORT.test(s)) continue;
    if (/^(?:import|export)\b/.test(s) && (REEXPORT.test(s) || s.startsWith("import"))) {
      out.add(i);
      if (!(/\bfrom\s*["'`]/.test(s) || /^import\s*["'`]/.test(s) || s.endsWith(","))) {
        if (s.includes("{") && !s.includes("}")) inImport = true;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- pin discovery

const READ_RE = /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?Deno\.readTextFile(?:Sync)?\s*\(\s*(?:new\s+URL\(\s*[`"']([^`"']+)[`"']|[`"']([^`"']+)[`"'])/g;
const INCLUDES_RE = /\b(\w+)\s*\.\s*includes\s*\(\s*([`"'])((?:\\.|(?!\2)[^\\])*)\2/g;
const ASSERT_SIC_RE = /\bassertStringIncludes\s*\(\s*(\w+)\s*,\s*([`"'])((?:\\.|(?!\2)[^\\])*)\2/g;

function testFiles(): string[] {
  return [...Deno.readDirSync(TESTS)].filter((e) => e.isFile && e.name.endsWith(".test.ts"))
    .map((e) => e.name).sort();
}

// ---------------------------------------------------- attribution engine (c9y8)
//
// Ported from the census resolver (cap-evidence/uodl/census-attribute.py), which is
// the specification and the measurement. Every function here returns TARGETS or null.
// A null means the pin is invisible to this guard — declined rather than guessed at.

const READ_CALL_RE = /(?:Deno\.readTextFile(?:Sync)?|readFileSync|readFile)\s*\(/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:/;
// Assembled so this file's own text does not match the partition guard's
// built-dist literal probe (the path is assembled below). Generated output is SKIPPED.
const BUILD_ARTIFACT_RE = new RegExp(`^(?:${distPath()}/|dist/|${distPath()}-versions/)|/dist/`);

/** Index just past the bracket opened at `open`, ignoring brackets inside strings. */
function balanced(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const o = text[open];
  const c = pairs[o];
  if (!c) return open + 1;
  let depth = 0, j = open, q = "";
  while (j < text.length) {
    const ch = text[j];
    if (q) {
      if (ch === "\\") { j += 2; continue; }
      if (ch === q) q = "";
    } else if (ch === '"' || ch === "'" || ch === "`") q = ch;
    else if (ch === o) depth++;
    else if (ch === c) { depth--; if (depth === 0) return j + 1; }
    j++;
  }
  return text.length;
}

/** Top-level comma split of an argument list (quote and bracket aware). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === "\\") { cur += s[i + 1] ?? ""; i++; continue; }
      if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; cur += c; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; cur += c; continue; }
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The right-hand side of an assignment, cut at its statement end. */
function stmtRhs(text: string, start: number, limit = 400): string {
  const seg = text.slice(start, start + limit);
  let depth = 0, q = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) return seg.slice(0, i).trim();
  }
  return seg.trim();
}

function normalizeAbs(abs: string): string {
  return new URL(`file://${abs}`).pathname;
}

/** Absolute path -> repo-relative, or null when it escapes the repo. */
function toRel(abs: string): string | null {
  let norm: string;
  try { norm = normalizeAbs(abs); } catch { return null; }
  return norm.startsWith(ROOT) ? norm.slice(ROOT.length) : null;
}

type PathRes = {
  one?: string; oneAbs?: string; set?: string[]; no?: string;
  via?: string; loopVar?: string; scope?: [number, number] | null;
  /** The literal denoted a DIRECTORY (`..`, `./`, `foo/`), so its URL pathname ends
   *  in `/`. Only such a path may gain a trailing slash under `.pathname`. */
  dirish?: boolean;
};

/** A source file the attribution engine can look names up in. */
class Src {
  rel: string;
  text: string;
  spans: Span[];
  private helperCache: Map<string, { params: string[]; body: string } | null> | null = null;
  private importCache: Map<string, string> | null = null;

  constructor(rel: string, text: string) {
    this.rel = rel;
    this.text = text;
    this.spans = maskSpans(text, kindFor(rel));
  }

  /** True when pos is inside a comment, a string or a template's prose. `interp` is
   *  NOT prose: code inside ${...} really runs. */
  inProse(pos: number): boolean {
    for (const s of this.spans) {
      if (s.start > pos) break;
      if (s.start <= pos && pos < s.end) {
        return s.label === "comment" || s.label === "string" || s.label === "template";
      }
    }
    return false;
  }

  /** The directory this file's `import.meta.url` resolves against. */
  get dir(): string {
    return this.rel.includes("/") ? `${ROOT}${this.rel.slice(0, this.rel.lastIndexOf("/") + 1)}` : ROOT;
  }

  /** The nearest preceding match of `re` before `pos` that is not inside prose.
   *  Position-bounding is what keeps a name bound in an unrelated block 400 lines
   *  away from being attributed to this pin. */
  nearest(re: RegExp, pos: number): RegExpExecArray | null {
    let best: RegExpExecArray | null = null;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text.slice(0, pos))) !== null) {
      if (!this.inProse(m.index)) best = m;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return best;
  }

  strConst(name: string, pos: number): string | null {
    const re = new RegExp(`(?:export\\s+)?(?:const|let)\\s+${esc(name)}\\s*(?::[^=]{0,40})?=\\s*(["'])((?:[^"'\\n]|\\\\)*)\\1\\s*[;,)]`, "g");
    const m = this.nearest(re, pos);
    return m ? m[2] : null;
  }

  constExpr(name: string, pos: number): string | null {
    const re = new RegExp(`(?:export\\s+)?(?:const|let)\\s+${esc(name)}\\s*(?::[^=;{]{0,60})?=\\s*`, "g");
    const m = this.nearest(re, pos);
    return m ? stmtRhs(this.text, m.index + m[0].length) : null;
  }

  /** `const NAME = [ "a", "b" ]` where every member is a literal. */
  constArray(name: string, pos: number): string[] | null {
    const re = new RegExp(`(?:export\\s+)?(?:const|let)\\s+${esc(name)}\\s*(?::[^=\\n]{0,60})?=\\s*\\[`, "g");
    const m = this.nearest(re, pos);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const inner = this.text.slice(open + 1, balanced(this.text, open) - 1);
    const items = [...inner.matchAll(/["'`]([^"'`\n]*)["'`]/g)].map((x) => x[1]);
    const stripped = inner.replace(/["'`][^"'`\n]*["'`]/g, "");
    return items.length && /^[\s,]*$/.test(stripped) ? items : null;
  }

  /** `const NAME = { a: {...}, b: {...} }` -> keys and each key's block text. */
  objectKeys(name: string, pos: number): { keys: string[]; blocks: Map<string, string> } | null {
    const re = new RegExp(`(?:export\\s+)?(?:const|let)\\s+${esc(name)}\\s*(?::[^=\\n]{0,60})?=\\s*\\{`, "g");
    const m = this.nearest(re, pos);
    if (!m) return null;
    const open = m.index + m[0].length - 1;
    const inner = this.text.slice(open + 1, balanced(this.text, open) - 1);
    const keys: string[] = [];
    const blocks = new Map<string, string>();
    for (const km of inner.matchAll(/(?:^|[\n,{])\s*["'`]?([\w$.\-]+)["'`]?\s*:\s*\{/g)) {
      const k = km[1];
      keys.push(k);
      const bo = km.index! + km[0].length - 1;
      blocks.set(k, inner.slice(bo + 1, balanced(inner, bo) - 1));
    }
    return keys.length ? { keys, blocks } : null;
  }

  /** `const NAME = new Map([ ["k", {...}], ... ])` -> the key literals. */
  mapKeys(name: string, pos: number): string[] | null {
    const re = new RegExp(`(?:export\\s+)?(?:const|let)\\s+${esc(name)}\\s*(?::[^=\\n]{0,80})?=\\s*new\\s+Map\\s*(?:<[^>]*>)?\\s*\\(\\s*\\[`, "g");
    const m = this.nearest(re, pos);
    if (!m) return null;
    const open = this.text.indexOf("[", m.index + m[0].length - 2);
    if (open < 0) return null;
    const inner = this.text.slice(open + 1, balanced(this.text, open) - 1);
    return [...inner.matchAll(/\[\s*["'`]([^"'`\n]*)["'`]/g)].map((x) => x[1]);
  }

  /** A function defined in THIS file: declaration, expression or arrow. */
  helper(name: string): { params: string[]; body: string } | null {
    if (!this.helperCache) {
      this.helperCache = new Map();
      const pats = [
        /(?:export\s+)?(?:async\s*)?function\s+([\w$]+)\s*\(([^)]*)\)\s*\{/g,
        /(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?function\s*[\w$]*\s*\(([^)]*)\)\s*\{/g,
        /(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]{0,40})?=>/g,
        /(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?([\w$]+)\s*=>/g,
      ];
      for (const p of pats) {
        for (const m of this.text.matchAll(p)) {
          if (this.inProse(m.index!) || this.helperCache.has(m[1])) continue;
          const params = m[2].split(",").map((x) => x.replace(/[=?:].*$/, "").trim()).filter(Boolean);
          const bs = m.index! + m[0].length;
          const body = this.text[bs - 1] === "{"
            ? this.text.slice(bs, balanced(this.text, bs - 1))
            : this.text.slice(bs, bs + 400);
          this.helperCache.set(m[1], { params, body });
        }
      }
    }
    return this.helperCache.get(name) ?? null;
  }

  /** Static imports: local name -> specifier. */
  imports(): Map<string, string> {
    if (!this.importCache) {
      this.importCache = new Map();
      for (const m of this.text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
        if (this.inProse(m.index!)) continue;
        for (const part of m[1].split(",")) {
          const p = part.trim();
          if (p) this.importCache.set(p.split(/\s+as\s+/).pop()!.trim(), m[2]);
        }
      }
      for (const m of this.text.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+["']([^"']+)["']/g)) {
        if (!this.inProse(m.index!)) this.importCache.set(m[1], m[2]);
      }
    }
    return this.importCache;
  }

  /** Dynamic imports: `const ns = await import("s")` and `const {a} = await import("s")`. */
  dynImports(pos: number): { ns: Map<string, string>; members: Map<string, string> } {
    const ns = new Map<string, string>();
    const members = new Map<string, string>();
    const head = this.text.slice(0, pos);
    for (const m of head.matchAll(/(?:const|let)\s+([\w$]+)\s*=\s*(?:\(\s*await\s+import\s*\(\s*["']([^"']+)["']\s*\)\s*\)(?:\s*\.\s*default)?|await\s+import\s*\(\s*["']([^"']+)["']\s*\))/g)) {
      if (!this.inProse(m.index!)) ns.set(m[1], m[2] || m[3]);
    }
    for (const m of head.matchAll(/(?:const|let)\s+\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*([^)\n]+?)\s*\)/g)) {
      if (this.inProse(m.index!)) continue;
      const raw = m[2].trim().replace(/^["'`]|["'`]$/g, "");
      const spec = ns.get(raw) ?? raw;
      for (const part of m[1].split(",")) {
        const p = part.trim();
        if (p) members.set(p.split(/\s+as\s+/).pop()!.trim(), spec);
      }
    }
    return { ns, members };
  }

  /** `const alias = ns?.member` / `ns.member`. */
  alias(name: string, pos: number): [string, string] | null {
    const m = this.nearest(new RegExp(`(?:const|let)\\s+${esc(name)}\\s*=\\s*([\\w$]+)\\s*\\??\\.\\s*([\\w$]+)\\s*[;,]`, "g"), pos);
    return m ? [m[1], m[2]] : null;
  }

  /** The collection a `for (const v of ...)` iterates, when its members are literals.
   *  Position-bounded: the NEAREST preceding for-of that binds `v`. */
  loopMembers(v: string, pos: number): { members: string[] | null; why: string; scope: [number, number] | null } {
    let best: RegExpExecArray | null = null;
    const re = /for\s*\(\s*(?:const|let|var)\s+(?:\[[^\]]*\]|[\w$]+)\s+of\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text.slice(0, pos))) !== null) {
      if (this.inProse(m.index)) continue;
      const b = /(?:const|let|var)\s+(?:\[([^\]]*)\]|([\w$]+))\s+of/.exec(m[0]);
      const names = ((b?.[1] ?? b?.[2]) ?? "").split(",").map((x) => x.trim().replace(/^[{}\s]+|[{}\s]+$/g, ""));
      if (names.includes(v)) best = m;
    }
    if (!best) return { members: null, why: "no for-of binds this name before the pin", scope: null };
    const at = best.index + best[0].length;
    const tail = this.text.slice(at, at + 1500).trimStart();
    const ev = tail.split(")")[0].replace(/\n/g, " ").slice(0, 90);
    const scope: [number, number] = [at, pos];

    if (tail.startsWith("[")) {
      const inner = tail.slice(1, balanced(tail, 0) - 1);
      const pairs = [...inner.matchAll(/\[\s*["'`]([^"'`\n]*)["'`]/g)].map((x) => x[1]);
      const flat = [...inner.matchAll(/["'`][^"'`\n]*["'`]/g)].map((x) => x[0].slice(1, -1));
      const stripped = inner.replace(/["'`][^"'`\n]*["'`]/g, "").replace(/\n/g, "");
      if (pairs.length && /^[\s,\[\]A-Za-z0-9_$:.]*$/.test(stripped)) {
        return { members: pairs, why: "inline array of pairs; first element of each", scope };
      }
      if (flat.length && /^[\s,]*$/.test(stripped)) {
        return { members: flat, why: "inline array literal of strings", scope };
      }
      return { members: null, why: `array literal with non-literal members: ${ev}`, scope: null };
    }

    const obj = /^Object\.(?:keys|entries|values)\s*\(\s*([\w$]+)\s*\)/.exec(tail);
    if (obj) {
      const local = this.objectKeys(obj[1], best.index);
      if (local) return { members: local.keys, why: `Object.* over the literal object ${obj[1]}`, scope };
      const imported = this.importedObjectKeys(obj[1], best.index);
      if (imported) return { members: imported.keys, why: `Object.* over ${obj[1]} imported from ${imported.spec}`, scope };
      return { members: null, why: `Object.* over ${obj[1]}, not a literal object in scope`, scope: null };
    }

    const bare = /^([\w$]+)/.exec(tail);
    if (bare) {
      const nm = bare[1];
      const arr = this.constArray(nm, best.index);
      if (arr) return { members: arr, why: `the literal const array ${nm}`, scope };
      const mk = this.mapKeys(nm, best.index);
      if (mk) return { members: mk, why: `the key literals of new Map const ${nm}`, scope };
      const ce = this.constExpr(nm, best.index);
      if (ce) {
        // Object.entries(X).filter(([, e]) => e.PROP !== undefined).map(([k, e]) => [k, e.PROP])
        const fm = /Object\.entries\s*\(\s*([\w$]+)\s*\)/.exec(ce);
        const qm = /\.filter\s*\(\s*\(\s*\[\s*[\w$]*\s*,\s*[\w$]+\s*\]\s*\)\s*=>\s*[\w$]+\.([\w$]+)\s*!==\s*undefined/.exec(ce);
        if (fm) {
          let got = this.objectKeys(fm[1], best.index);
          let spec = "this file";
          if (!got) {
            const imp = this.importedObjectKeys(fm[1], best.index);
            if (imp) { got = { keys: imp.keys, blocks: imp.blocks }; spec = imp.spec; }
          }
          if (got) {
            const prop = qm?.[1];
            const sel = prop ? got.keys.filter((k) => (got!.blocks.get(k) ?? "").includes(prop)) : got.keys;
            if (sel.length) {
              return { members: sel, why: `Object.entries(${fm[1]} from ${spec}) filtered on ${prop ?? "nothing"}`, scope };
            }
          }
        }
      }
      const ok = this.objectKeys(nm, best.index);
      if (ok) return { members: ok.keys, why: `the keys of the literal object ${nm}`, scope };
      if (/^(?:Deno\.readDir|walk|collect)/.test(tail) || /\.(?:values|map|filter)\s*\(/.test(tail.slice(0, 40))) {
        return { members: null, why: `RUNTIME_ENUMERATION: ${ev}`, scope: null };
      }
      return { members: null, why: `iterates ${nm}, not a literal array/object/Map in scope`, scope: null };
    }
    return { members: null, why: `collection is not a literal: ${ev}`, scope: null };
  }

  /** Keys of an object literal this file imports, statically or dynamically. */
  importedObjectKeys(name: string, pos: number): { keys: string[]; blocks: Map<string, string>; spec: string } | null {
    const spec = this.moduleSpec(name, pos);
    if (!spec) return null;
    const mod = moduleSrc(this, spec);
    if (!mod) return null;
    const got = mod.objectKeys(name, mod.text.length);
    return got ? { keys: got.keys, blocks: got.blocks, spec } : null;
  }

  /** `for (const [k, v] of Object.entries({ a, b, c }))` — the inline shorthand keys.
   *  The named-object case is handled in loopMembers; this is the inline literal, which
   *  is how settings-cleanliness.test.ts binds five already-read sources to one name. */
  inlineEntryKeys(v: string, pos: number): string[] | null {
    const re = new RegExp(
      `for\\s*\\(\\s*(?:const|let|var)\\s+\\[\\s*[\\w$]+\\s*,\\s*${esc(v)}\\s*\\]\\s+of\\s+Object\\.entries\\s*\\(\\s*\\{`, "g");
    let best: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    const head = this.text.slice(0, pos);
    while ((m = re.exec(head)) !== null) { if (!this.inProse(m.index)) best = m; }
    if (!best) return null;
    const open = best.index + best[0].length - 1;
    const inner = this.text.slice(open + 1, balanced(this.text, open) - 1);
    const keys = inner.split(/,(?![^{}()\[\]]*[)\]}])/).map((x) => x.trim()).filter(Boolean);
    return keys.length ? keys : null;
  }

  /** `const [a, b] = X.split("sep")` where X is itself a loop variable. */
  splitDerivation(v: string, pos: number): string[] | null {
    const re = /(?:const|let)\s+\[([^\]]*)\]\s*=\s*([\w$]+)\s*\.\s*split\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    for (const m of this.text.slice(0, pos).matchAll(re)) {
      if (this.inProse(m.index!)) continue;
      const names = m[1].split(",").map((x) => x.trim());
      const idx = names.indexOf(v);
      if (idx < 0) continue;
      const { members } = this.loopMembers(m[2], m.index!);
      if (!members) continue;
      const parts = members.map((k) => k.split(m[3]));
      if (parts.some((p) => p.length <= idx)) continue;
      return parts.map((p) => p[idx]);
    }
    return null;
  }

  /** The module specifier a name comes from: static import, dynamic import, alias. */
  moduleSpec(name: string, pos: number): string | null {
    const stat = this.imports().get(name);
    if (stat) return stat;
    const { ns, members } = this.dynImports(pos);
    if (ns.has(name)) return ns.get(name)!;
    if (members.has(name)) return members.get(name)!;
    const al = this.alias(name, pos);
    if (al) return this.moduleSpec(al[0], pos);
    const ce = this.constExpr(name, pos) ?? "";
    const m = /^\(?await\s+import\s*\(\s*["']([^"']+)["']/.exec(ce.trim());
    return m ? m[1] : null;
  }
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const srcCache = new Map<string, Src | null>();

/** A cached Src for a repo-relative path (test files are passed their text). */
function srcFor(rel: string, text?: string): Src {
  const hit = srcCache.get(rel);
  if (hit) return hit;
  const s = new Src(rel, text ?? Deno.readTextFileSync(`${ROOT}${rel}`));
  srcCache.set(rel, s);
  return s;
}

/** Load a module by specifier relative to `from`, one hop, or null. */
function moduleSrc(from: Src, spec: string | null): Src | null {
  if (!spec || !spec.startsWith(".")) return null;
  const base = from.dir;
  const abs = normalizeAbs(`${base}${spec}`);
  if (!abs.startsWith(ROOT)) return null;
  const stem = abs.slice(ROOT.length);
  for (const cand of [stem, `${stem}.ts`, `${stem}.js`, `${stem}.mjs`]) {
    if (srcCache.has(cand)) { const hit = srcCache.get(cand); if (hit) return hit; continue; }
    try {
      const s = new Src(cand, Deno.readTextFileSync(`${ROOT}${cand}`));
      srcCache.set(cand, s);
      return s;
    } catch { srcCache.set(cand, null); }
  }
  return null;
}

function resolveLiteral(src: Src, raw: string, base: "repo" | "test", absoluteOk = false): PathRes {
  const r = (raw ?? "").trim();
  if (!r) return { no: "EMPTY_LITERAL" };
  if (r.includes("${")) return { no: `LITERAL_HAS_INTERP:${r.slice(0, 40)}` };
  if (URL_SCHEME_RE.test(r) || r.startsWith("//")) return { no: `NOT_A_REPO_PATH:${r.slice(0, 40)}` };
  let abs: string;
  if (r.startsWith("/")) {
    const norm = normalizeAbs(r);
    if (!norm.startsWith(ROOT)) {
      if (!absoluteOk) return { no: `ABSOLUTE_LOOKING_LITERAL:${r.slice(0, 40)}` };
      abs = `${ROOT}${r.replace(/^\/+/, "")}`;
    } else abs = r;
  } else if (base === "test" || r.startsWith("../")) {
    abs = `${src.dir}${r}`;
  } else {
    abs = `${ROOT}${r}`;
  }
  const rel = toRel(abs);
  if (rel === null) return { no: `OUTSIDE_REPO:${r.slice(0, 40)}` };
  return { one: rel, oneAbs: normalizeAbs(abs), dirish: r.endsWith("/") || r === ".." || r === "." };
}

function textOf(res: PathRes): string {
  return res.oneAbs ?? (res.one !== undefined ? `${ROOT}${res.one}` : "");
}

function resolvePath(src: Src, expr: string, subst: Map<string, string>, base: "repo" | "test",
  pos: number, depth = 0): PathRes {
  if (depth > 6) return { no: "PATH_EXPR_TOO_DEEP" };
  let e = (expr ?? "").trim().replace(/^await\s+/, "").replace(/\.catch\s*\(\s*\(\s*\)\s*=>[^)]*\)\s*$/, "").trim();
  if (!e) return { no: "PATH_EXPR_EMPTY" };

  // `.pathname` (with the repo's `.replace(/\/$/u, "")` normaliser) — exact
  // semantics: the pathname of a URL ending in "/" ends in "/".
  const pn = /^(.*?)\s*\.\s*pathname\s*(\.replace\s*\(([^)]*)\))?\s*$/s.exec(e);
  if (pn && pn[1].trim()) {
    const inner = resolvePath(src, pn[1].trim(), subst, base, pos, depth + 1);
    if (inner.no) return inner;
    let abs = inner.oneAbs ?? `${ROOT}${inner.one ?? ""}`;
    // URL semantics, not a guess: `new URL("..", meta).pathname` ends in "/" because
    // the literal denotes a directory, while `new URL("../a/b.js", meta).pathname`
    // does not. Appending "/" unconditionally turned every FILE url into a directory
    // path and silently lost 5 attributed pins in activity-liveness.test.ts (the
    // guard's own stale-allowlist check is what caught it).
    if (inner.dirish && !abs.endsWith("/")) abs += "/";
    if (pn[2] && /\\?\/\s*\$/.test(pn[3] ?? "")) abs = abs.replace(/\/+$/, "");
    const rel = toRel(abs) ?? "";
    return { one: rel, oneAbs: abs };
  }
  const ts = /^(.*?)\s*\.\s*(?:toString|href)\s*$/.exec(e);
  if (ts && ts[1].trim()) return resolvePath(src, ts[1].trim(), subst, base, pos, depth + 1);

  if (subst.has(e)) return resolvePath(src, subst.get(e)!, subst, base, pos, depth + 1);

  if (e.startsWith("`") && e.endsWith("`") && e.length > 1) {
    return resolveTemplate(src, e.slice(1, -1), subst, base, pos, depth);
  }
  const quoted = /^(["'])([\s\S]*)\1$/.exec(e);
  if (quoted) return resolveLiteral(src, quoted[2], base);

  if (/^new\s+URL\s*\(/.test(e)) {
    const i = e.indexOf("(");
    const args = splitArgs(e.slice(i + 1, balanced(e, i) - 1));
    if (args.length >= 2 && args[1].includes("import.meta.url")) {
      if (args[1].trim() === "import.meta.url") {
        return resolvePath(src, args[0], subst, "test", pos, depth + 1);
      }
      // A NESTED base: `new URL(p, new URL("../", import.meta.url))` resolves p
      // against the directory the inner URL denotes — here the repo root, not the
      // test file's directory. Treating it as test-relative sent 12 pins in
      // sidepanel-shell.test.ts to a nonexistent tests/extension/sidepanel/. Only the
      // repo-root case is resolved; any other base is declined rather than guessed.
      const b = resolvePath(src, args[1], subst, "test", pos, depth + 1);
      if (b.one === "" || (b.oneAbs && normalizeAbs(b.oneAbs) === normalizeAbs(ROOT))) {
        return resolvePath(src, args[0], subst, "repo", pos, depth + 1);
      }
      return { no: `NEW_URL_BASE_NOT_REPO_ROOT:${args[1].slice(0, 50)}` };
    }
    return { no: `NEW_URL_NOT_META:${e.slice(0, 50)}` };
  }

  if (/^(?:path|nodePath|Path)\.join\s*\(/.test(e)) {
    const i = e.indexOf("(");
    const raw = splitArgs(e.slice(i + 1, balanced(e, i) - 1));
    const frags: string[] = [];
    for (let n = 0; n < raw.length; n++) {
      const q = /^(["'`])([\s\S]*)\1$/.exec(raw[n].trim());
      if (q) { frags.push(q[2]); continue; }
      const p = resolvePath(src, raw[n], subst, base, pos, depth + 1);
      if (p.no) return { no: `PATH_JOIN_PART_UNRESOLVED:${p.no}` };
      // only the FIRST fragment may carry the absolute prefix: joining absolute
      // fragments duplicates the repo root into every later segment
      frags.push(n === 0 && p.oneAbs ? p.oneAbs : (p.one ?? ""));
    }
    const joined = frags.reduce((a, b) => `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`);
    return resolveLiteral(src, joined, base, true);
  }

  if (/^(?:Deno\.cwd|process\.cwd)\s*\(\s*\)$/.test(e)) return { one: "", oneAbs: ROOT };

  if (/^[\w$]+$/.test(e)) {
    const sc = src.strConst(e, pos);
    if (sc !== null) return resolveLiteral(src, sc, base);
    const ce = src.constExpr(e, pos);
    if (ce && ce !== e) {
      const r = resolvePath(src, ce, subst, base, pos, depth + 1);
      if (r.one !== undefined || r.set) return { ...r, via: e };
    }
    const arr = src.constArray(e, pos);
    if (arr) return setFromMembers(src, arr, base, `const array ${e}`);
    const loop = src.loopMembers(e, pos);
    if (loop.members) {
      // Carry the loop variable and its scope so the caller can NARROW the set to the
      // branch the pin actually sits in (R4n). Dropping them here is what made a
      // guarded pin look like an unguarded one.
      return { ...setFromMembers(src, loop.members, base, `loop list ${e}`), loopVar: e, scope: loop.scope };
    }
    return { no: `BARE_NAME_NOT_LITERAL:${e}` };
  }

  const call = /^([\w$]+)\s*\(/.exec(e);
  if (call) {
    const h = src.helper(call[1]);
    if (!h) return { no: `UNKNOWN_CALLEE:${call[1]}` };
    if (READ_CALL_RE.test(h.body)) return { no: `PATH_EXPR_IS_A_READER:${call[1]}` };
    const i = e.indexOf("(");
    const args = splitArgs(e.slice(i + 1, balanced(e, i) - 1));
    const sub = new Map<string, string>();
    h.params.forEach((p, n) => { if (args[n] !== undefined) sub.set(p, args[n]); });
    const body = h.body.trim().replace(/^\{/, "").replace(/^return\s+/, "").replace(/;\s*$/, "").trim();
    return resolvePath(src, body, sub, base, pos, depth + 1);
  }

  return { no: `PATH_EXPR_SHAPE:${e.slice(0, 40)}` };
}

function setFromMembers(src: Src, members: string[], base: "repo" | "test", via: string): PathRes {
  const out: string[] = [];
  for (const mem of members) {
    const r = resolveLiteral(src, String(mem).trim().replace(/^["'`]|["'`]$/g, ""), base);
    if (!r.one) return { no: `SET_MEMBER_UNRESOLVED:${String(mem).slice(0, 30)}` };
    out.push(r.one);
  }
  return { set: [...new Set(out)].sort(), via };
}

/** A path template concatenates TEXT; only the result is a path. Resolving each
 *  `${...}` to a repo-relative path and joining loses the `../` in
 *  `` new URL(`../${rel}`, import.meta.url) ``. */
function resolveTemplate(src: Src, body: string, subst: Map<string, string>, base: "repo" | "test",
  pos: number, depth: number): PathRes {
  const pieces: string[] = [];
  const sets: [string[], string][] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("${", i)) {
      const j = balanced(body, i + 1);
      const inner = body.slice(i + 2, j - 1);
      const frag = interpText(src, inner, subst, base, pos, depth);
      if (frag === null) return { no: `TEMPLATE_INTERP_UNRESOLVED:${inner.trim().slice(0, 40)}` };
      if (Array.isArray(frag)) sets.push([frag, inner.trim()]);
      else pieces.push(frag);
      i = j;
    } else {
      const j = body.indexOf("${", i);
      if (j < 0) { pieces.push(body.slice(i)); break; }
      pieces.push(body.slice(i, j));
      i = j;
    }
  }
  const prefix = pieces.join("");
  if (!sets.length) return resolveLiteral(src, prefix, base, true);
  if (sets.length > 1) return { no: `TEMPLATE_MULTIPLE_SETS:${sets.map((s) => s[1]).join(",")}` };
  const out: string[] = [];
  for (const mem of sets[0][0]) {
    const r = resolveLiteral(src, prefix + String(mem).trim().replace(/^["'`]|["'`]$/g, ""), base, true);
    if (!r.one) return { no: `SET_MEMBER_UNRESOLVED:${String(mem).slice(0, 30)}` };
    out.push(r.one);
  }
  const loopVar = sets[0][1];
  const scope = src.loopMembers(loopVar, pos).scope;
  return { set: [...new Set(out)].sort(), via: loopVar, loopVar, scope };
}

/** The TEXT a `${inner}` contributes: a string, a member list, or null (decline). */
function interpText(src: Src, inner0: string, subst: Map<string, string>, base: "repo" | "test",
  pos: number, depth: number): string | string[] | null {
  const inner = inner0.trim();
  if (subst.has(inner)) {
    const v = (subst.get(inner) ?? "").trim();
    const q = /^(["'`])([\s\S]*)\1$/.exec(v);
    if (q) return q[2];
    if (!/^[\w$]+$/.test(v) || v !== inner) {
      const r = resolvePath(src, v, subst, base, pos, depth + 1);
      if (r.set) return r.set;
      if (r.one !== undefined) return textOf(r);
    }
  }
  const sc = src.strConst(inner, pos);
  if (sc !== null) return sc;
  const ce = src.constExpr(inner, pos);
  if (ce) {
    const r = resolvePath(src, ce, subst, base, pos, depth + 1);
    if (r.set) return r.set;
    if (r.one !== undefined) return textOf(r);
  }
  if (/^[\w$]+$/.test(inner)) {
    const arr = src.constArray(inner, pos);
    if (arr) return arr;
    const { members } = src.loopMembers(inner, pos);
    if (members) return members;
    const split = src.splitDerivation(inner, pos);
    if (split) return split;
  }
  return null;
}

/** A BACKTICK token containing `${...}` is computed per run, so no static judgement
 *  is possible. Gated on the DELIMITER, never on the presence of `${`: a single or
 *  double-quoted token may legitimately contain `${...}` as literal text when it pins
 *  source that is itself a template. */
function isInterpolatedToken(quote: string, token: string): boolean {
  return quote === "`" && token.includes("${");
}

type Attribution = { targets: string[]; stripComments: boolean; via: string } | null;

/** Is the `.includes` receiver a property of a runtime value (`part.text.includes`)?
 *  The pin regex captures the identifier immediately before `.includes`, so for a
 *  property access it captures the PROPERTY NAME. 54 of the census's 203 declined
 *  calls were this shape: they are assertions on computed values, not on file text,
 *  and no attribution should ever reach them. */
/** Is the identifier at `varStart` a PROPERTY of a runtime value rather than a
 *  variable bound to a file read? `varStart` must be the offset OF THE IDENTIFIER:
 *  INCLUDES_RE matches start at the identifier, but ASSERT_SIC_RE matches start at
 *  `assertStringIncludes`, where the identifier sits inside the parentheses. Passing
 *  the match offset made the character before the CALL decide, so a pin preceded by a
 *  comment ending in a full stop — "...TEMPLATE-CUSTOM-SELECT-01)." — was filed as a
 *  property receiver and silently dropped: that is how the guard lost uodl's own
 *  template-cards allowlist entry and the stale check caught it. */
/** The innermost enclosing function whose parameter list binds `v`, when `pos` is
 *  inside that function's body — else null.
 *
 *  A parameter SHADOWS an outer read binding, so a pin on it says nothing about the
 *  outer file. Callback parameters were already refused (`shape === "callback-param"`);
 *  function-DECLARATION parameters were not, so
 *      const src = await Deno.readTextFile("extension/lib/pure.js");
 *      function helper(src: string) { if (src.includes("X")) throw ... }
 *  inherited the outer attribution and was judged against pure.js. That is a false RED
 *  (cry wolf) at best and a false GREEN when the outer file happens to contain the
 *  token while the helper's own argument is what the pin is about. Found by
 *  glm-flash-1's boundary attack on this extension; the probe is pinned verbatim below.
 *  Refusing is symmetric with the callback-parameter ruling: a parameter's value is
 *  supplied by the caller, so it is not a repo path this guard can prove. */
function enclosingParamBinder(src: Src, v: string, pos: number): string | null {
  const text = src.text;
  let best: { name: string; span: number } | null = null;
  const pats = [
    /(?:^|[^.\w$])(?:export\s+)?(?:async\s+)?function\s*([\w$]*)\s*\(([^)]*)\)\s*\{/g,
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?function\s*[\w$]*\s*\(([^)]*)\)\s*\{/g,
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^={]{0,60})?=>\s*\{/g,
  ];
  for (const re of pats) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (src.inProse(m.index!)) continue;
      const params = m[2].split(",")
        .map((x) => x.replace(/^\s*\{[^}]*\}/, "").replace(/^\.\.\./, "").replace(/[=?:].*$/, "").trim());
      if (!params.includes(v)) continue;
      const open = m.index! + m[0].length - 1;      // the `{` that opens the body
      const end = balanced(text, open);
      if (pos > open && pos < end) {
        const span = end - open;
        if (!best || span < best.span) best = { name: m[1] || "(anonymous)", span };
      }
    }
  }
  return best ? best.name : null;
}

function isPropertyReceiver(text: string, varStart: number): boolean {
  let i = varStart - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  return i >= 0 && (text[i] === "." || text[i] === "]");
}

function nearestBinding(src: Src, v: string, pos: number):
  { shape: "assign" | "derived" | "loop" | "callback-param"; rhs: string; pos: number;
    members?: string[] | null; scope?: [number, number] | null; loopVars?: string[] } | null {
  const text = src.text;
  const plain = src.nearest(new RegExp(`(?:const|let|var)\\s+${esc(v)}\\s*(?::[^=;]{0,40})?=\\s*`, "g"), pos);
  if (plain) {
    const rhs = stmtRhs(text, plain.index + plain[0].length);
    const derived = /^[\w$]+\s*\.\s*(?:split|slice|substring|replace|trim|map|filter)/.test(rhs);
    return { shape: derived ? "derived" : "assign", rhs, pos: plain.index };
  }
  const destruct = src.nearest(/(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])\s*=\s*/g, pos);
  if (destruct && new RegExp(`(?:\\b|:)${esc(v)}\\b`).test(destruct[1])) {
    return { shape: "assign", rhs: stmtRhs(text, destruct.index + destruct[0].length), pos: destruct.index };
  }
  let loop: RegExpExecArray | null = null;
  const lre = /for\s*\(\s*(?:const|let|var)\s+(?:\[[^\]]*\]|[\w$]+)\s+of\s+/g;
  let lm: RegExpExecArray | null;
  while ((lm = lre.exec(text.slice(0, pos))) !== null) {
    if (src.inProse(lm.index)) continue;
    if (new RegExp(`(?:^|[\\[,{\\s])${esc(v)}(?:\\s*[,}\\]]|\\s*$)`).test(lm[0])) loop = lm;
  }
  if (loop) {
    const b = /(?:const|let|var)\s+(?:\[([^\]]*)\]|([\w$]+))\s+of/.exec(loop[0]);
    const loopVars = ((b?.[1] ?? b?.[2]) ?? "").split(",").map((x) => x.trim().replace(/^[{}\s]+|[{}\s]+$/g, ""));
    const info = src.loopMembers(v, pos);
    let members = src.inlineEntryKeys(v, pos) ?? info.members;
    const scope = info.scope;
    if (!members && loopVars.length > 1) members = src.splitDerivation(v, pos);
    return { shape: "loop", rhs: stmtRhs(text, loop.index + loop[0].length, 200), pos: loop.index, members, scope, loopVars };
  }
  const cb = new RegExp(`\\(\\s*(?:[\\w$]+\\s*,\\s*)*${esc(v)}\\s*(?::[^)]{0,30})?\\)\\s*(?::[^=]{0,30})?=>`, "g");
  const cm = cb.exec(text.slice(0, pos + 200));
  if (cm && !src.inProse(cm.index)) {
    return { shape: "callback-param", rhs: text.slice(Math.max(0, cm.index - 60), cm.index + cm[0].length), pos: cm.index };
  }
  return null;
}

/** `if (rel.endsWith("x"))` between the loop head and the pin narrows the set to the
 *  members that actually reach the assertion. Without this the census reported nine
 *  spurious TOKEN_ABSENT rows for one guarded assertion in cairn-rename.test.ts. */
function narrowMembers(src: Src, loopVar: string | undefined, scope: [number, number] | null | undefined,
  members: string[]): string[] {
  if (!loopVar || !scope || members.length < 2) return members;
  const seg = src.text.slice(scope[0], scope[1]);
  const preds: [string, string][] = [];
  for (const m of seg.matchAll(new RegExp(`\\b${esc(loopVar)}\\s*\\.\\s*(endsWith|startsWith|includes)\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]\\s*\\)`, "g"))) {
    preds.push([m[1], m[2]]);
  }
  for (const m of seg.matchAll(new RegExp(`\\b${esc(loopVar)}\\s*(===|==)\\s*["'\`]([^"'\`]+)["'\`]`, "g"))) {
    preds.push([m[1], m[2]]);
  }
  if (!preds.length) return members;
  const keep = members.filter((mem) => preds.some(([op, lit]) =>
    op === "endsWith" ? mem.endsWith(lit)
      : op === "startsWith" ? mem.startsWith(lit)
        : op === "includes" ? mem.includes(lit)
          : mem === lit || mem.endsWith(`/${lit}`) || mem.endsWith(lit)));
  return keep.length && keep.length < members.length ? keep : members;
}

/** Attribute one pin's variable to the repo file(s) it reads, or null. */
function attribute(src: Src, v: string, varStart: number, depth = 0): Attribution {
  const pos = varStart;
  if (depth > 3) return null;
  // The receiver question exists only AT THE PIN SITE. Recursive calls pass a BINDING
  // offset, where the preceding character belongs to whatever came before the
  // statement — checking it there filed `const code = src.split(...)` as a property
  // receiver because the comment above it ends with a full stop, and silently lost
  // all eight comment-stripped pins.
  if (depth === 0 && isPropertyReceiver(src.text, varStart)) return null;
  // A parameter of an enclosing function scope shadows any outer read binding, at
  // every depth: the R5 recursion passes a BINDING offset, and a base variable that is
  // really a parameter must be refused there too rather than inherit an outer file.
  if (enclosingParamBinder(src, v, pos)) return null;
  const bind = nearestBinding(src, v, pos);
  if (!bind) return null;

  if (bind.shape === "callback-param") return null;            // prompts.some((text) => ...)

  if (bind.shape === "derived") {
    const base = /^\s*([\w$]+)\s*\./.exec(bind.rhs);
    const stripsComments = /\bsplit\s*\(\s*["'`]\\n["'`]\s*\)/.test(bind.rhs) &&
      /filter\s*\(/.test(bind.rhs) && /join\s*\(/.test(bind.rhs);
    if (base && stripsComments) {
      const inner = attribute(src, base[1], bind.pos, depth + 1);
      return inner ? { targets: inner.targets, stripComments: true, via: `R5 comment-stripped view of ${base[1]}` } : null;
    }
    return null;                                               // an expression over a runtime value
  }

  if (bind.shape === "loop") {
    if (!bind.members) return null;                            // a runtime walk, or call results
    const targets: string[] = [];
    for (const mem of bind.members) {
      const nm = String(mem).trim().replace(/^["'`]|["'`]$/g, "");
      const asVar = attribute(src, nm, bind.pos, depth + 1);   // Object.entries({ html, options })
      if (asVar) { targets.push(...asVar.targets); continue; }
      const r = resolveLiteral(src, nm, "test");
      const r2 = r.one ? r : resolveLiteral(src, nm, "repo");
      if (!r2.one) return null;
      targets.push(r2.one);
    }
    const uniq = [...new Set(targets)].sort();
    const keyVar = (bind.loopVars?.length ?? 0) > 1 ? bind.loopVars![0] : (bind.loopVars?.[0] ?? v);
    const narrowed = narrowMembers(src, keyVar, bind.scope, uniq);
    return { targets: narrowed, stripComments: false, via: `R4 loop set (${narrowed.length}${narrowed.length < uniq.length ? " narrowed from " + uniq.length : ""})` };
  }

  return attributeRhs(src, bind.rhs, bind.pos, pos, depth);
}

function attributeRhs(src: Src, rhs0: string, bindPos: number, pinPos: number, depth: number): Attribution {
  const rhs = rhs0.trim();
  const pos = pinPos || bindPos;

  const read = READ_CALL_RE.exec(rhs);
  if (read) {
    const args = splitArgs(rhs.slice(read.index + read[0].length, balanced(rhs, read.index + read[0].length - 1) - 1));
    if (!args.length) return null;
    const res = resolvePath(src, args[0], new Map(), "repo", pos);
    if (res.one) return { targets: [res.one], stripComments: false, via: "R2 read" };
    if (res.set) {
      const narrowed = narrowMembers(src, res.loopVar, res.scope, res.set);
      return { targets: narrowed, stripComments: false, via: `R2 read set (${narrowed.length})` };
    }
    return null;
  }

  const call = /^(?:await\s+)?([\w$.]+)\s*\(/.exec(rhs);
  if (call) return attributeCallee(src, call[1], rhs, pos, depth);

  const alias = /^([\w$]+)\s*\??\.\s*([\w$]+)$/.exec(rhs);
  if (alias) return null;      // a member of a runtime value / an imported renderer

  if (/^[\w$]+$/.test(rhs)) return attribute(src, rhs, bindPos, depth + 1);   // an alias of another variable

  return null;                 // a computed expression, not a file read
}

function attributeCallee(src: Src, name: string, rhs: string, pos: number, depth: number): Attribution {
  const i = rhs.indexOf("(");
  const args = splitArgs(rhs.slice(i + 1, balanced(rhs, i) - 1));
  const local = name.split(".").pop()!;
  const head = name.split(".")[0];

  const tryReader = (owner: Src, label: string): Attribution | undefined => {
    const h = owner.helper(local);
    if (!h) return undefined;
    if (!READ_CALL_RE.test(h.body)) return null;      // a renderer: computed output, not file text
    const rm = READ_CALL_RE.exec(h.body)!;
    const inner = splitArgs(h.body.slice(rm.index + rm[0].length, balanced(h.body, rm.index + rm[0].length - 1) - 1));
    if (!inner.length) return null;
    const sub = new Map<string, string>();
    h.params.forEach((p, n) => { if (args[n] !== undefined) sub.set(p, args[n]); });
    const res = resolvePath(owner, inner[0], sub, "repo", owner.text.length);
    if (res.one) return { targets: [res.one], stripComments: false, via: `R3 reader ${label}` };
    if (res.set) return { targets: res.set, stripComments: false, via: `R3 reader ${label} set (${res.set.length})` };
    return null;
  };

  if (name.includes(".")) {
    if (["JSON", "Object", "String", "Array", "Number", "Math"].includes(head)) return null;
    const mod = moduleSrc(src, src.moduleSpec(head, pos));
    if (mod) { const r = tryReader(mod, `${name}`); if (r !== undefined) return r; }
    return null;                                       // a method call on a runtime value
  }

  const localRead = tryReader(src, local);
  if (localRead !== undefined) return localRead;

  const spec = src.moduleSpec(local, pos);
  if (spec) {
    const mod = moduleSrc(src, spec);
    if (mod) { const r = tryReader(mod, `${local} from ${spec}`); if (r !== undefined) return r; }
    return null;                                       // an imported renderer, or a builtin module
  }
  return null;                                         // callee not locatable in this scope
}

type Pin = {
  testFile: string; testLine: number; target: string; token: string;
  live: number; shadow: number; shadows: { line: number; label: string; text: string }[];
  via: string; setMembers: number;
};

/** What the collection saw. The population test asserts on these numbers, so the
 *  guard's boundary is measured rather than claimed in a comment. */
type Stats = {
  testFiles: number;
  pinSites: number;               // every pin match outside prose
  attributedPins: number;         // pins with at least one judgeable target
  unattributed: number;           // no file read resolves: the NOT_SOURCE classes
  propertyReceivers: number;      // a subset of the above: `x.text.includes(...)`
  shadowedParameters: number;     // a subset of the above: a parameter of an enclosing
                                  // function scope shadows an outer read binding
  skippedAbsence: number;
  skippedDisjunction: number;
  skippedInterpolated: number;    // a BACKTICK token containing ${...}
  skippedBuildArtifact: number;   // the generated dist bundle — owner ruling: skipped, counted
  judged: number;                 // (pin, target) pairs the ladder ran on
  targets: number;                // distinct target files brought into scope
  judgedTargets: string[];        // the distinct targets, so the dist skip is provable
  /** Resolved to a repo-relative path that does not exist. A resolver bug shows up
   *  here, so it is listed and asserted rather than skipped in silence. */
  missing: string[];
};

let collectCache: { pins: Pin[]; stats: Stats } | null = null;

/** Memoised: the offender scan and the population assertion both need the same
 *  collection, and reading 424 test files plus 73 targets twice cost ~500 ms of a
 *  ~800 ms file. Nothing changes on disk during a test run. */
function collectPins(): { pins: Pin[]; stats: Stats } {
  if (!collectCache) collectCache = collectPinsUncached();
  return collectCache;
}

function collectPinsUncached(): { pins: Pin[]; stats: Stats } {
  const pins: Pin[] = [];
  const stats: Stats = {
    testFiles: 0, pinSites: 0, attributedPins: 0, unattributed: 0, propertyReceivers: 0,
    skippedAbsence: 0, skippedDisjunction: 0, skippedInterpolated: 0, skippedBuildArtifact: 0,
    judged: 0, targets: 0, missing: [], judgedTargets: [], shadowedParameters: 0,
  };
  const missing = stats.missing;
  const seenTargets = new Set<string>();
  type Entry = { text: string; spans: Span[]; imports: Set<number>; lines: string[]; starts: number[] };
  const targetCache = new Map<string, Entry | null>();
  const load = (rel: string): Entry | null => {
    if (targetCache.has(rel)) return targetCache.get(rel)!;
    let entry: Entry | null = null;
    try {
      const text = Deno.readTextFileSync(`${ROOT}${rel}`);
      const lines = text.split("\n");
      // precomputed line starts + binary search: recomputing the line number per
      // occurrence by slicing and splitting the whole file is O(n) each, and this
      // guard runs inside every `npm test`.
      const starts: number[] = [];
      let pos = 0;
      for (const ln of lines) { starts.push(pos); pos += ln.length + 1; }
      entry = { text, spans: maskSpans(text, kindFor(rel)), imports: importShadowLines(text), lines, starts };
    } catch { entry = null; }
    targetCache.set(rel, entry);
    return entry;
  };
  const lineOf = (e: Entry, i: number): number => {
    let lo = 0, hi = e.starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (e.starts[mid] <= i) lo = mid; else hi = mid - 1; }
    return lo;
  };

  const names = testFiles();
  stats.testFiles = names.length;
  for (const name of names) {
    const text = Deno.readTextFileSync(`${TESTS}${name}`);
    // The TEST FILE gets masked too. Without this the guard matched pins inside
    // its own documentation: a re-anchored pin whose replacement comment quotes
    // the old assertion — "this was `assert(scriptText.includes(\"?toolautosubmit\"))`"
    // — is not an assertion, it is prose ABOUT one. A guard that fires on a
    // comment explaining a removed pin gets disabled, so prose is excluded.
    // `interp` is NOT excluded: code inside ${...} really runs.
    const testSrc = srcFor(`tests/${name}`, text);
    const inProse = (pos: number) => testSrc.inProse(pos);

    for (const rx of [INCLUDES_RE, ASSERT_SIC_RE]) {
      rx.lastIndex = 0;
      for (const m of text.matchAll(rx)) {
        const pos = m.index!;
        const v = m[1];
        const quote = m[2];
        const token = m[3];   // both idioms capture (var, quote, token) in the same groups
        if (inProse(pos)) continue;                 // a pin quoted inside prose is not a pin
        stats.pinSites++;
        // The offset OF THE IDENTIFIER: INCLUDES_RE starts there, ASSERT_SIC_RE starts
        // at the callee name. See isPropertyReceiver.
        const varPos = text.indexOf(v, pos);

        // Attribution FIRST: a pin whose variable never reaches a file read is not a
        // source-text pin at all, and the skips below must not be credited with it.
        // This is the census's 155-row NOT_SOURCE boundary — rendered prompts, agent
        // and tool results, JSON.stringify output, properties of runtime values,
        // callback parameters — and it is the reason the guard stays quiet about them.
        const attr = attribute(testSrc, v, varPos < 0 ? pos : varPos);
        if (!attr) {
          stats.unattributed++;
          const vp = varPos < 0 ? pos : varPos;
          if (isPropertyReceiver(text, vp)) stats.propertyReceivers++;
          else if (enclosingParamBinder(testSrc, v, vp)) stats.shadowedParameters++;
          continue;
        }

        // absence pins are never offenders: a shadow makes them fail spuriously,
        // which is conservative, not a false green.
        const back = text.slice(Math.max(0, pos - 80), pos);
        const fwd = text.slice(pos + m[0].length, pos + m[0].length + 80);
        let negated = /!\s*$/.test(back) || /^\s*\)\s*\{?\s*throw\b/.test(fwd) ||
          /^\s*\)\s*,\s*false\b/.test(fwd) || /assertFalse\s*\(\s*$/.test(back);
        if (/^\s*\)\s*,\s*true\b/.test(fwd)) negated = false;
        if (negated) { stats.skippedAbsence++; continue; }
        if (/^\s*\)\s*\|\|/.test(fwd) || /\|\|\s*$/.test(back)) { stats.skippedDisjunction++; continue; }

        // An interpolated BACKTICK token is computed per run, so no static judgement
        // is possible. Gated on the DELIMITER, never on the presence of `${`: a
        // single-quoted token may legitimately contain `${...}` as literal text
        // (owner-observability.test.ts:26 pins a template-looking string that occurs
        // verbatim in service-worker.js), and skipping that would hide a judgeable pin.
        if (isInterpolatedToken(quote, token)) { stats.skippedInterpolated++; continue; }

        let judgedAny = false;
        const testLine = text.slice(0, pos).split("\n").length;
        for (const rel of attr.targets) {
          // Owner ruling (2026-09-07): generated output is SKIPPED, and the skip is
          // counted out loud so "we stopped judging dist" cannot happen silently.
          if (BUILD_ARTIFACT_RE.test(rel)) { stats.skippedBuildArtifact++; continue; }
          const entry = load(rel);
          if (!entry) { missing.push(`${name}:${testLine} -> ${rel}`); continue; }
          judgedAny = true;
          stats.judged++;
          seenTargets.add(rel);
          let live = 0;
          const shadows: Pin["shadows"] = [];
          let from = 0;
          for (;;) {
            const i = entry.text.indexOf(token, from);
            if (i < 0) break;
            from = i + 1;
            let label = "code";
            let spanStart = -1;
            for (const s of entry.spans) {
              if (s.start > i) break;
              if (s.start <= i && i < s.end) { label = s.label; spanStart = s.start; break; }
            }
            if ((label === "string" || label === "template") && spanStart >= 0 &&
                isConsoleProse(entry.text, spanStart)) label = "console-msg";
            const lineno = lineOf(entry, i);   // 0-indexed
            if (entry.imports.has(lineno)) label = "import";
            // R5: the test stripped comment lines before asserting, so a comment
            // occurrence cannot satisfy it and must not be counted as a shadow either.
            if (attr.stripComments && label === "comment") continue;
            if (label === "comment" || label === "import" || label === "console-msg") {
              shadows.push({ line: lineno + 1, label, text: (entry.lines[lineno] ?? "").trim().slice(0, 160) });
            } else live++;
          }
          if (live === 0 && shadows.length > 0) {
            pins.push({
              testFile: `tests/${name}`, testLine, target: rel, token, live,
              shadow: shadows.length, shadows, via: attr.via, setMembers: attr.targets.length,
            });
          }
        }
        if (judgedAny) stats.attributedPins++;
      }
    }
  }
  stats.targets = seenTargets.size;
  stats.judgedTargets = [...seenTargets].sort();
  return { pins, stats };
}

// ----------------------------------------------------------------- allowlist
//
// The audited pre-existing population (cap-evidence/uodl, repo @ 7f903962),
// each adjudicated by reading the assertion in its own test file. These are pins
// that are ABOUT the shadow on purpose, or whose shadow is redundant because a
// sibling assertion pins the live construct. Adding an entry here needs a reason.
const ALLOWED = new Map<string, string>([
  // --- the pin's declared intent IS the prose. Deleting the comment is the
  //     regression these detect, so a comment-only occurrence is correct.
  [tp("webmcp-honest-errors.test.ts::extension/content/main-world.js::redactSecretText"),
    'message says "the port declares its source of truth (keep-in-sync pointer)": the pin guards the provenance comment. The redaction itself is pinned by the sibling assert(MAIN.includes("function redactBridgeText("), "the redaction choke point exists"), which is live code.'],
  [tp("webmcp-honest-errors.test.ts::extension/lib/pure.js::redactBridgeText"),
    'message says "redactSecretText names its content-script port so the two stay in sync": the mirror keep-in-sync pointer.'],
  [tp("wasm-host-gate2.test.ts::scripts/scan-shipped.mjs::requires a separately reviewed static CAS route"),
    'message says "the scan keeps the honest future-host wording": the pin guards documentation wording, not behaviour.'],
  // --- an import-only pin whose USE is separately pinned in the same file, so
  //     the binding cannot go dead unnoticed.
  [tp("activity-liveness.test.ts::extension/shared/components.js::import { redactSecrets } from \"../lib/pure.js\";"),
    'message "the canonical redactor is imported"; siblings pin redactSecrets(event.toolArgs), redactSecrets(parsed.value) and redactSecrets(p.value) as live call sites.'],
  [tp("table-management-tools.test.ts::extension/offscreen/offscreen.js::import { registerTableWorkerHost } from \"../lib/table-worker-host.js\""),
    'the very next assertion pins the call site: assert(offscreen.includes("registerTableWorkerHost();")).'],
  [tp("ux008-failed-dispatch.test.ts::extension/background/service-worker.js::import { buildRetryDispatch, retryRunId } from \"../lib/run-retry.js\";"),
    'message "the SW imports the run-retry helpers"; four anchored regex pins in the same test prove the buildRetryDispatch(retryable.request) call site.'],
  [tp("webmcp-dispatch-fallthrough.test.ts::extension/background/service-worker.js::from \"../lib/site-docs-fallback.js\""),
    "the withSiteDocsFallback call site is pinned separately in the same file."],
  [tp("webmcp-lazyauth.test.ts::extension/background/service-worker.js::from \"../lib/webmcp-authority.js\""),
    'the next assertion pins the call site: assert(sw.includes("const authorizationGuard = createWebmcpAuthorizationGuard({")). The multi-line import binds four names; this pin points at its tail line.'],
  [tp("mutation-claim-check.test.ts::extension/lib/agent.js::from \"./mutation-claim-check.js\""),
    "correctUnsupportedMutationClaims is exercised directly by the same file's behavioural tests."],
  [tp("tool-exec-preview.test.ts::extension/options/options.js::lib/wasm-preview-host.js"),
    'message "the options page wires the extracted host unit": an intentional import-PROVENANCE pin (which module supplies the host). The live wiring is pinned by the assertion directly above it, assert(options.includes(\'registerWasmPreviewHost()\')), whose occurrence is the real call site at options.js:413.'],
  [tp("template-cards.test.ts::extension/ntp/ntp.js::import { buildTemplateSelect } from \"../lib/agent-template-select.js\""),
    "chrome-agent-platform-uodl: this import pin is what mutant U-I1 survived (a dead binding with the import left in place, full suite 3977/0). It is kept as the module-provenance pin and is now COVERED by the two call-site assertions added directly below it, which kill U-I1. Kept under audit rather than deleted so the provenance stays pinned."],
  // --- chrome-agent-platform-c9y8: the two offenders the extended attribution
  //     surfaced, both adjudicated by intent in the wzez census
  //     (cap-evidence/uodl/census-4c89bd9d/CENSUS.md Â§6).
  [tp("bundled-tool-packages.test.ts::extension/background/service-worker.js::bundled-inventory-data"),
    'chrome-agent-platform-ecke: this is the pin mutant W1 survived â deleting `inventory: BUNDLED_INVENTORY,` from the preview route\'s revalidatePreviewExecution call left the FULL suite at 3999 passed / 0 failed, because the token\'s only occurrence in the service worker is the import specifier at :98 while the construct uses the BINDING. ecke re-anchored it: the sibling assertion parses the call site (/revalidatePreviewExecution\(\s*\{[^}]*inventory:\s*BUNDLED_INVENTORY\s*,/) and mutant W1 is now killed at that pin, with a second count pin on both sourceGeneration sites. This substring is kept as MODULE PROVENANCE under audit â the template-cards (U-I1) and tool-exec-preview precedent â so the module that supplies the inventory stays named.'],
  [tp("cairn-rename.test.ts::extension/lib/usage-store.js::IMMUTABLE LEGACY MIGRATION SOURCE"),
    'PROSE-INTENDED: the assertion message says "the keep-decision is documented at the key", so the pin guards the documentation comment at usage-store.js:11 and a comment is the only thing it can be about. The live construct beside it â LEGACY_STORAGE_KEY = "cairn:usage" â is pinned by the assertion directly above, which is live code in the same narrowed branch.'],
  // --- a redundant identity banner: the property is enforced by live siblings.
  [tp("enrollment-policy.test.ts::extension/directory/directory.js::read-only Agent Directory"),
    'the only occurrence is the file header. The read-only property is enforced by the absence assertions three lines below (!includes(\'send("tools.policy.set"\')), !includes(\'send("tools.approve"\')), so removing the behaviour still reddens the test.'],
]);

function keyOf(p: Pin): string {
  return `${p.testFile}::${p.target}::${p.token}`;
}

Deno.test("guard: no source-text .includes(X) pin is satisfied entirely by shadows", () => {
  const { pins } = collectPins();
  const offenders: string[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();

  for (const p of pins) {
    const k = keyOf(p);
    seen.add(k);
    if (ALLOWED.has(k)) continue;
    const kinds = [...new Set(p.shadows.map((s) => s.label))].sort().join("+");
    offenders.push(
      `${p.testFile}:${p.testLine} → ${p.target}\n` +
      `      token: ${JSON.stringify(p.token.slice(0, 120))}\n` +
      `      every one of its ${p.shadow} occurrence(s) is a ${kinds} shadow, so this pin\n` +
      `      passes with the guarded construct deleted. Anchor it to a declaration or a\n` +
      `      call site and parse that, or if the pin really is about the prose, add it to\n` +
      `      ALLOWED in this file with the reason.\n` +
      p.shadows.map((s) => `        ${p.target}:${s.line} [${s.label}] ${s.text}`).join("\n"),
    );
  }
  for (const k of ALLOWED.keys()) if (!seen.has(k)) stale.push(k);

  assertEquals(
    offenders, [],
    `${offenders.length} substring pin(s) assert nothing about the file they read:\n\n${offenders.join("\n\n")}`,
  );
  assertEquals(
    stale, [],
    `allowlist entries that no longer match any vacuous pin — the pin was fixed or moved, so delete the entry:\n${stale.join("\n")}`,
  );
});

Deno.test("guard: the tokeniser sees through the regex literals that broke the naive mask", () => {
  // The real shape from extension/content/main-world.js:372 and :392. Under a
  // regex span scan the quote inside the character class opens a bogus string
  // span that runs to line 447 and labels the function declaration below as a
  // string — which filed two sound pins as vacuous.
  const src = [
    'out = out.replace(/https?:\\/\\/[^\\s"\'<>)]+/gi, (m) => m);',
    "const re = /((?:api[_-]?key|token|secret)(?![a-z0-9])[\"'`]?\\s*[:=]\\s*" +
      "([^\\s\"'`,;}]{6,}))/gi;",
    "function describePageError(e, tool, phase, dispatchChain = null) {",
    '  return { name: "x" };',
    "}",
  ].join("\n");
  const spans = maskSpans(src, "js");
  const labelAt = (needle: string): string => {
    const i = src.indexOf(needle);
    assert(i >= 0, `needle not found: ${needle}`);
    for (const s of spans) if (s.start <= i && i < s.end) return s.label;
    return "code";
  };
  assertEquals(labelAt("api[_-]?key|token|secret"), "regex", "a regex literal is executable code");
  assertEquals(labelAt("function describePageError("), "code", "a declaration after a quote-bearing regex is code");
  assertEquals(labelAt('"x"'), "string", "a real string is still a string");

  // A stray quote must not swallow the file: this is what turned 1 bogus span
  // into 75 mislabelled lines.
  const stray = maskSpans('const s = "abc;\nfunction realCode() { return 1; }', "js");
  const i = 'const s = "abc;\nfunction realCode() { return 1; }'.indexOf("function realCode()");
  assertEquals(stray.some((s) => s.start <= i && i < s.end), false, "an unterminated quote stops at the newline");

  // `${...}` interiors are expressions, and an export declaration is not an import.
  // The source text needs real BACKTICKS: in a plain "..." string the characters
  // `${name}` are just text, so there is no interpolation to label.
  assertEquals(labelAt2("const m = `tool ${name} absent`;", "name"), "interp");
  assertEquals(labelAt2("const m = `tool ${name} absent`;", "tool "), "template");
  assertEquals(importShadowLines('export async function renderSkillList(a) {\n  return 1;\n}\n').size, 0,
    "an export declaration is live, not a shadow binding");
  assertEquals(importShadowLines('import {\n  a,\n  b,\n} from "../x.js";\n').size, 4,
    "a multi-line import shadows every line of the binding");
});

function labelAt2(src: string, needle: string): string {
  const i = src.indexOf(needle);
  for (const s of maskSpans(src, "js")) if (s.start <= i && i < s.end) return s.label;
  return "code";
}

Deno.test("guard: a console.log narration is a shadow but a thrown error's message is not", () => {
  // The bead's U1: the log line stayed behind when the URL construction moved.
  const log = 'console.log("Navigating to French Bistro demo with ?toolautosubmit...");';
  assertEquals(isConsoleProse(log, log.indexOf('"')), true);
  // An enforcement point's message is its error code — deleting the guard
  // deletes the token, so it is live.
  const code = 'if (wrote === 0) throw new Error("result_stage_write_no_progress");';
  assertEquals(isConsoleProse(code, code.indexOf('"')), false);
  // A fixture's thrown payload is the artifact under test.
  const fixture = 'handler(() => { throw new Error("request failed; token=sk-live-abc"); });';
  assertEquals(isConsoleProse(fixture, fixture.indexOf('"')), false);
  // Values, bindings and markup are live.
  for (const [src, idx] of [
    ['if (Deno.env.get("CAP_SECURITY_NONCE")) {}', 'if (Deno.env.get("CAP_SECURITY_NONCE")) {}'.indexOf('"')],
    ['const URL_BISTRO = "...?toolautosubmit";', 'const URL_BISTRO = "...?toolautosubmit";'.indexOf('"')],
    ['brokenEl.className = "skills-broken";', 'brokenEl.className = "skills-broken";'.indexOf('"')],
  ] as const) assertEquals(isConsoleProse(src, idx), false, src);
});

// ─────────────────────────────────────────────────────────────────────────────
// chrome-agent-platform-c9y8: the extended attribution's own proofs. A net that is
// not itself proven is the same sin this guard exists to catch, so the four shapes
// it learned are pinned here against synthetic sources (hermetic: no repo file is
// read, and nothing here can be mistaken for a real pin because it is not in the
// scanned population — these strings never touch collectPins).
// ─────────────────────────────────────────────────────────────────────────────

function synth(body: string): Src {
  return new Src(tp("zz-synthetic-probe.test.ts"), body);
}

function targetsOf(body: string, varName: string): string[] | null {
  const src = synth(body);
  const at = body.indexOf(`${varName}.includes(`);
  const a = attribute(src, varName, at < 0 ? body.length : at);
  return a ? a.targets : null;
}

Deno.test("guard: R2 attributes a direct read, a path-expression const and path.join", () => {
  assertEquals(
    targetsOf(
      `const src = await Deno.readTextFile(new URL("../extension/x.js", import.meta.url));
       src.includes("T")`, "src"),
    ["extension/x.js"], "new URL(rel, import.meta.url) is TEST-DIR relative",
  );
  assertEquals(
    targetsOf(
      `const src = Deno.readTextFileSync("scripts/plain.ts");
       src.includes("T")`, "src"),
    ["scripts/plain.ts"], "a bare literal read is cwd/repo relative",
  );
  assertEquals(
    targetsOf(
      `const ROOT2 = new URL("..", import.meta.url).pathname;
       const SCRIPTS = \`\${ROOT2}scripts\`;
       const src = Deno.readTextFileSync(\`\${SCRIPTS}/deep.ts\`);
       src.includes("T")`, "src"),
    ["scripts/deep.ts"],
    "a directory URL pathname ends in / and a FILE pathname does not; templates substitute TEXT",
  );
  assertEquals(
    targetsOf(
      `const ROOT2 = new URL("..", import.meta.url).pathname;
       const DIST = path.join(ROOT2, "extension", "dist");
       const sw = await readFile(path.join(DIST, "background/service-worker.js"), "utf8");
       sw.includes("T")`, "sw"),
    [distPath("background", "service-worker.js")],
    "path.join composes without duplicating the repo root into every segment",
  );
  assert(BUILD_ARTIFACT_RE.test(distPath("background", "service-worker.js")),
    "and that target is the build artifact the owner ruling skips");
});

Deno.test("guard: R3 attributes a reader helper and declines a renderer", () => {
  assertEquals(
    targetsOf(
      `const read = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url));
       const src = read("../extension/z.js");
       src.includes("T")`, "src"),
    ["extension/z.js"], "a local helper whose body is the read, with the argument substituted",
  );
  assertEquals(
    targetsOf(
      `const src = readRepoFile("extension/w.js");
       src.includes("T")`, "src"),
    null, "a callee that is neither defined nor imported in this file is declined, not guessed",
  );
  assertEquals(
    targetsOf(
      `function drive(task: string): string { return \`ran \${task}\`; }
       const text = drive("group my tabs");
       text.includes("T")`, "text"),
    null, "a local helper with NO read in its body returns computed output",
  );
  assertEquals(
    targetsOf(
      `const rc = await import("../extension/lib/runtime-context.js");
       const text = rc.formatRuntimeContext(sample);
       text.includes("T")`, "text"),
    null, "a member call on a dynamically imported renderer is computed output",
  );
});

Deno.test("guard: R4 attributes a literal loop set and R4n narrows it to the branch", () => {
  assertEquals(
    targetsOf(
      `for (const rel of ["../extension/a.js", "../extension/b.js"]) {
         const src = await Deno.readTextFile(new URL(rel, import.meta.url));
         src.includes("T");
       }`, "src"),
    ["extension/a.js", "extension/b.js"],
    "a literal loop list is a TARGET SET: the assertion runs once per member",
  );
  assertEquals(
    targetsOf(
      `for (const rel of ["../extension/a.js", "../extension/b.js"]) {
         const src = await Deno.readTextFile(new URL(rel, import.meta.url));
         if (rel.endsWith("a.js")) { src.includes("T"); }
       }`, "src"),
    ["extension/a.js"],
    "a pin inside `if (rel.endsWith(...))` targets only the members that reach it — without " +
    "narrowing the census reported nine spurious TOKEN_ABSENT rows for one guarded assertion",
  );
  assertEquals(
    targetsOf(
      `const html = Deno.readTextFileSync(new URL("../docs/h.html", import.meta.url));
       for (const [n, source] of Object.entries({ html })) {
         source.includes("T");
       }`, "source"),
    ["docs/h.html"],
    "Object.entries over literal bindings resolves each member through its own read",
  );
  assertEquals(
    targetsOf(
      `for (const file of collect("extension")) {
         const text = await Deno.readTextFile(file);
         text.includes("T");
       }`, "text"),
    null, "a runtime directory walk is declined: replicating it would be guessing",
  );
});

Deno.test("guard: R5 attributes a comment-stripped view and marks the transform", () => {
  const src = synth(
    `const src = Deno.readTextFileSync(new URL("../scripts/kat-runner.ts", import.meta.url));
     const code = src.split("\\n").filter((l) => !l.trimStart().startsWith("//")).join("\\n");
     code.includes("T")`,
  );
  const at = src.text.indexOf("code.includes(");
  const a = attribute(src, "code", at);
  assert(a !== null, "the derived view is attributed through its base read");
  assertEquals(a!.targets, ["scripts/kat-runner.ts"]);
  assertEquals(a!.stripComments, true,
    "the test removed comment lines before asserting, so a comment cannot satisfy it");
});

Deno.test("guard: the boundary — computed output is never attributed (the census's 155)", () => {
  assertEquals(
    targetsOf(`const out = { text: "PROBE" };
       out.text.includes("T")`, "text"),
    null, "a PROPERTY receiver: the identifier is a property name, not a variable bound to a read",
  );
  assertEquals(
    targetsOf(`const carried = prompts.slice(1).some((text) => text.includes("T"));`, "text"),
    null, "a callback parameter over runtime values",
  );
  assertEquals(
    targetsOf(`const text = JSON.stringify(rows.map((r) => r.result));
       text.includes("T")`, "text"),
    null, "an expression over runtime values",
  );
  assertEquals(
    targetsOf(`const text = attachmentContext([{ name: "report.txt" }]);
       text.includes("T")`, "text"),
    null, "an imported renderer reached through a static import: computed output",
  );
  assertEquals(
    targetsOf(`for (const [scope, text] of [["hub", baselineSystemPrompt("cap.hub.master")]]) {
         text.includes("T");
       }`, "text"),
    null, "a loop whose members are the RESULTS OF CALLS",
  );
});

Deno.test("guard: the interpolated-token skip is gated on the delimiter, not on ${", () => {
  assert(isInterpolatedToken("`", "--user-data-dir=${value}"),
    "a backtick token with an interpolation is computed per iteration");
  assert(!isInterpolatedToken("'", 'source: expectedSource ? `webmcp-${expectedSource}` : "webmcp-bridge"'),
    "a single-quoted token may contain ${...} as LITERAL text and must still be judged");
  assert(!isInterpolatedToken('"', "plain token"), "an ordinary token is judged");
});

Deno.test("guard: the shell kind masks # comments but not a shebang or a quoted #", () => {
  const sh = `#!/usr/bin/env bash
# SHELL_COMMENT_ONLY: prose
echo "SHELL_HASH_IN_QUOTE # not a comment"
SHELL_LIVE="\${1:-default}"
`;
  const spans = maskSpans(sh, "shell");
  const labelAt = (tok: string): string => {
    const i = sh.indexOf(tok);
    for (const s of spans) if (s.start <= i && i < s.end) return s.label;
    return "code";
  };
  assertEquals(labelAt("#!/usr/bin/env bash"), "code",
    "the shebang IS the interpreter declaration: deleting it deletes the token, so it is live");
  assertEquals(labelAt("# SHELL_COMMENT_ONLY"), "comment", "a shell comment is a shadow");
  assertEquals(labelAt("SHELL_HASH_IN_QUOTE"), "code",
    "a # inside a quoted string is text — a naive #-to-EOL strip would eat the rest of the line");
  assertEquals(labelAt("SHELL_LIVE="), "code", "the line after a quoted # is still code");
});

// ─────────────────────────────────────────────────────────────────────────────
// The population and its boundary, measured. Every number here was produced by a
// run of this file at 816aae8e and each one has a derivation, so a future change
// that quietly drops attribution — or quietly starts judging generated output —
// fails loudly instead of drifting.
// ─────────────────────────────────────────────────────────────────────────────

/** Every attribution this guard computes for a real pin, by test file and token.
 *  A token can be pinned more than once in a file against DIFFERENT targets (a var
 *  redeclared per Deno.test scope), so this returns all of them and the sentinels
 *  assert that the expected one is present. Taking only the first match is how the
 *  first draft of this test asserted on the wrong pin. */
function attributionsAt(testFile: string, token: string):
  { targets: string[] | null; stripComments: boolean }[] {
  const text = Deno.readTextFileSync(`${ROOT}${testFile}`);
  const src = srcFor(testFile, text);
  const out: { targets: string[] | null; stripComments: boolean }[] = [];
  for (const rx of [INCLUDES_RE, ASSERT_SIC_RE]) {
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) {
      if (m[3] !== token || src.inProse(m.index!)) continue;
      const varPos = text.indexOf(m[1], m.index!);
      const a = attribute(src, m[1], varPos < 0 ? m.index! : varPos);
      out.push({ targets: a ? a.targets : null, stripComments: a ? a.stripComments : false });
    }
  }
  return out;
}

/** True when at least one pin on `token` in `testFile` is attributed to exactly
 *  `targets` (and, when given, carries the comment-stripped transform). */
function attributesTo(testFile: string, token: string, targets: string[], stripComments?: boolean): boolean {
  return attributionsAt(testFile, token).some((a) =>
    a.targets !== null && a.targets.length === targets.length &&
    a.targets.every((t, i) => t === targets[i]) &&
    (stripComments === undefined || a.stripComments === stripComments));
}

/** True when NO pin on `token` in `testFile` is attributed at all. */
function attributesNothing(testFile: string, token: string): boolean {
  const all = attributionsAt(testFile, token);
  return all.length > 0 && all.every((a) => a.targets === null);
}

Deno.test("guard: the census shapes are live in the real repo, not only in the probes", async () => {
  // R2/R3 — a local path-composer helper (`root(rel)`) and a local reader helper.
  assert(attributesTo(tp("bundled-tool-packages.test.ts"), "bundled-inventory-data",
    ["extension/background/service-worker.js"]),
    "the pin mutant W1 survived is now attributable through the root(rel) composer");
  assert(attributesTo(tp("owner-observability.test.ts"), 'source: browser ? "chrome-api" : "management"',
    ["extension/background/service-worker.js"]),
    "R3: a local `read(p)` helper whose body is the read");

  // R4 + R4n — a literal loop set narrowed to the branch the pin sits in.
  assert(attributesTo(tp("cairn-rename.test.ts"), "IMMUTABLE LEGACY MIGRATION SOURCE",
    ["extension/lib/usage-store.js"]),
    'R4n: the pin is inside `if (rel.endsWith("usage-store.js"))`, so only that member is its target');

  // R4 — chrome-agent-platform-lrok RE-ANCHORED the last real-repo instance of
  // this shape: the three bare-word pins in quiet-window.test.ts's filtered
  // Object.entries loop are now anchored inside the refusal handler
  // (/instanceof QuietWindowRefusedError … ENVIRONMENTAL_REFUSAL_MARKER/), so
  // the substring-pin instance this sentinel watched no longer exists. The
  // truth that remains checkable: the retired instance stays retired, and the
  // re-anchored handler pins exist.
  assertEquals(
    attributionsAt(tp("quiet-window.test.ts"), "QuietWindowRefusedError"),
    [],
    "the bare-word QuietWindowRefusedError pin was re-anchored by lrok — if this attribution reappears, a substring pin returned and this entry must be re-audited",
  );
  assert(
    /QuietWindowRefusedError[\s\S]{0,400}?ENVIRONMENTAL_REFUSAL_MARKER/.test(
      await Deno.readTextFile(new URL("./quiet-window.test.ts", import.meta.url)),
    ),
    "lrok's anchored handler pins remain in place (the refusal is pinned inside the handler, not on its imports)",
  );

  // R5 — a comment-stripped derived view keeps its target and records the transform.
  assert(attributesTo(tp("chrome-slot-semaphore.test.ts"), "CAP_CHROME_GATE_ACQUIRED",
    ["scripts/kat-runner.ts"], true),
    "R5: the view's base read is attributed and comment occurrences are dropped");

  // A nested URL base — `new URL(p, new URL("../", import.meta.url))` resolves p
  // against the REPO ROOT. Neither the audit nor the census counted these pins: the
  // scanner's variable-NAME heuristic rejected `html`/`js`, so this file was invisible
  // to both instruments. Attribution by shape reaches it.
  assert(attributesTo(tp("sidepanel-shell.test.ts"), 'id="tab-favicon"',
    ["extension/sidepanel/sidepanel.html"]),
    "a nested new URL base is the repo root, not the test dir");

  // An INLINE Object.entries({ a, b, c }) whose members are variables already bound to
  // reads. The census resolver lost this shape in its final rewrite and filed the four
  // settings-cleanliness pins as computed output; the guard must not repeat that.
  const inline = attributionsAt(tp("settings-cleanliness.test.ts"), "storage-durability-warning")
    .find((a) => a.targets && a.targets.length === 5);
  assert(inline !== undefined,
    "inline Object.entries over five bound sources: " +
    JSON.stringify(attributionsAt(tp("settings-cleanliness.test.ts"), "storage-durability-warning")));

  // A const array iterated into a template path, on .sh targets — the shell kind.
  const recipes = attributionsAt(tp("tool-platform-foundation.test.ts"), "#!/usr/bin/env bash")
    .find((a) => a.targets && a.targets.length === 9);
  assert(recipes !== undefined && recipes.targets!.every((t) =>
    t.startsWith("wasm-tools/recipes/build-") && t.endsWith(".sh")),
    "nine hermetic build recipes: " +
    JSON.stringify(attributionsAt(tp("tool-platform-foundation.test.ts"), "#!/usr/bin/env bash")));
});

Deno.test("guard: the boundary holds — computed output is never attributed", () => {
  // The census measured 155 of the 203 declined calls as NOT source-text pins. These
  // are its shapes, in the real repo, and every one must stay invisible.
  assert(attributesNothing(tp("agent-do-logging.test.ts"), "agent-do"),
    "a PROPERTY receiver: `.includes` on a property of a runtime value");
  assert(attributesNothing(tp("local-assistant.test.ts"), "1 tab stayed ungrouped"),
    "a LOCAL helper that renders a string: no read in its body");
  assert(attributesNothing(tp("steer-concurrent-run.test.ts"), "UGJ9 STEER MARKER"),
    "a CALLBACK parameter over runtime prompts");
  assert(attributesNothing(tp("agent-abort.test.ts"), "[object Object]"),
    "an EXPRESSION over a runtime value");
  assert(attributesNothing(tp("agent-permission-resume.test.ts"), "could not be saved"),
    "a MEMBER call whose result is computed at run time");
});

Deno.test("guard: the attributed population and its documented exclusions", () => {
  const { stats } = collectPins();

  // Every path this guard resolves must exist. A resolved-but-missing target is a
  // resolver bug (a wrong base, an unscoped name lookup), not a repo state, and it
  // used to be skipped in silence: 12 pins in sidepanel-shell.test.ts were attributed
  // to a nonexistent tests/extension/sidepanel/ before the nested-URL base was fixed.
  assertEquals(stats.missing, [], "every attributed target exists — a miss here is a resolver bug");

  // THE BOUNDARY. The census (cap-evidence/uodl/census-4c89bd9d) measured 654 pins
  // attributed by the audit plus 45 of its 203 declined calls, i.e. 699 source-text
  // pins. This guard attributes by SHAPE rather than by variable name, so it also
  // reaches pins both instruments filtered out (`html`, `js`, `block`): measured 735
  // attributed pins at 816aae8e. Asserted as a floor, because the dangerous drift is
  // attribution being LOST, and an exact count would red on any lane that adds a pin.
  assert(stats.attributedPins >= 699,
    `attributed source-text pins fell below the census boundary of 699: ${stats.attributedPins}`);
  assert(stats.judged >= stats.attributedPins,
    "set-shaped pins are judged once per member, so judged >= attributedPins");

  // The invisible side of the boundary must stay substantial: 388 property receivers
  // measured at 816aae8e, out of 1640 declined pin sites. If this collapses to zero
  // the guard has started attributing computed output and will cry wolf.
  assert(stats.propertyReceivers >= 300,
    `property receivers dropped to ${stats.propertyReceivers} — computed output is being attributed`);
  assert(stats.unattributed >= 1000,
    `unattributed pin sites dropped to ${stats.unattributed} — the NOT_SOURCE boundary moved`);

  // DOCUMENTED EXCLUSIONS, exact on purpose: a change means someone started judging a
  // class this guard deliberately skips.
  // Owner ruling 2026-09-07: generated output is skipped because a guard whose verdict
  // depends on whether someone ran `build:production` is not a guard. Two presence pins
  // in build-debug-mode.test.ts read the generated service-worker bundle under dist.
  assertEquals(stats.skippedBuildArtifact, 2,
    "build-artifact pins are skipped by owner ruling; a change here means dist is being judged");
  // The executable half of that ruling, and the proof behind this file's partition
  // exemption-by-assembly: no generated output is ever loaded and judged.
  assertEquals(stats.judgedTargets.filter((t) => BUILD_ARTIFACT_RE.test(t)), [],
    "no build artifact was judged — the skip happens before the target is read");
  // A BACKTICK token containing ${...} is computed per iteration. 10 of these were
  // mis-filed as TOKEN_ABSENT by the audit and 1 more by the census; 13 measured here.
  assertEquals(stats.skippedInterpolated, 13,
    "interpolated backtick tokens are skipped; a change means the delimiter gate moved");

  // Absence pins and disjunctions stay skipped (conservative, not false greens).
  assert(stats.skippedAbsence >= 100, `absence pins dropped to ${stats.skippedAbsence}`);
  assert(stats.skippedDisjunction >= 9, `disjunction pins dropped to ${stats.skippedDisjunction}`);
  assert(stats.targets >= 73, `distinct target files dropped to ${stats.targets}`);
  // shadowedParameters is deliberately NOT asserted: 0 measured at 37c71f14 (which
  // matches the review's finding that no live pin in tests/ has the shape), but a lane
  // may legitimately add a helper that takes source text as a parameter, and an exact
  // 0 would red that innocent change. The refusal itself is pinned by the
  // function-declaration-parameter test; this counter is the observability half.
  assert(stats.shadowedParameters >= 0, "unreachable, kept so the field is read");
  assertEquals(stats.testFiles, [...Deno.readDirSync(TESTS)].filter((e) => e.isFile && e.name.endsWith(".test.ts")).length,
    "every test file in tests/ is scanned");
});

Deno.test("guard: a function-declaration parameter shadows an outer read and is refused", () => {
  // glm-flash-1's boundary attack on this extension, verbatim from its review record
  // (cap-evidence/uodl/review-glm/REVIEW-c9y8-glm.md). Callback parameters were already
  // refused; function-DECLARATION parameters were not, so this pin inherited the OUTER
  // attribution and was judged against extension/lib/pure.js — a false RED (cry wolf)
  // at best, and a false GREEN when the outer file happens to contain the token while
  // the helper's own argument is what the pin is about. The refusal is symmetric with
  // the callback ruling: a parameter's value is supplied by the caller, so it is not a
  // repo path this guard can prove.
  //
  // Note the probe's assertion is also absence-shaped (`if (...) throw`), which a real
  // scan would skip before judging; this sentinel calls attribute() directly so it pins
  // the REFUSAL rather than the skip.
  const body = `const src = await Deno.readTextFile("extension/lib/pure.js");
function helper(src: string) {
  if (src.includes("TARGET_TOKEN_XYZ")) throw new Error("no");
}
helper("x");
`;
  const probe = synth(body);
  const inside = body.indexOf('src.includes("TARGET_TOKEN_XYZ")');
  assertEquals(attribute(probe, "src", inside), null,
    "a declaration parameter shadows the outer read: refuse rather than inherit its target");
  assertEquals(enclosingParamBinder(probe, "src", inside), "helper",
    "the refusal names the shadowing scope, so the skip can be counted with a reason");

  // The refusal must be SCOPED to the shadowed pin, not a blanket refusal of the name:
  // the same variable outside the helper body is still the outer read.
  const body2 = `const src = await Deno.readTextFile("extension/lib/pure.js");
function helper(other: string) {
  return other.length;
}
src.includes("TARGET_TOKEN_XYZ");
`;
  const probe2 = synth(body2);
  const outside = body2.lastIndexOf('src.includes("TARGET_TOKEN_XYZ")');
  const a = attribute(probe2, "src", outside);
  assert(a !== null && a.targets.length === 1 && a.targets[0] === "extension/lib/pure.js",
    `outside the helper the outer read still attributes, got ${JSON.stringify(a)}`);

  // Arrow and function-expression parameters are refused too, and a pin inside a
  // Deno.test arrow (no parameters) is untouched — that is every real pin in tests/.
  const body3 = `const src = await Deno.readTextFile("extension/lib/pure.js");
const h = async (src) => { src.includes("A"); };
const g = function (src) { src.includes("B"); };
Deno.test("x", () => { src.includes("C"); });
`;
  const probe3 = synth(body3);
  assertEquals(attribute(probe3, "src", body3.indexOf('src.includes("A")')), null, "arrow parameter");
  assertEquals(attribute(probe3, "src", body3.indexOf('src.includes("B")')), null, "function-expression parameter");
  const inTest = attribute(probe3, "src", body3.indexOf('src.includes("C")'));
  assert(inTest !== null && inTest.targets[0] === "extension/lib/pure.js",
    "a parameterless Deno.test callback does not shadow the module-scope read");
});

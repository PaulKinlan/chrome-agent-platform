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
import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;
const TESTS = `${ROOT}tests/`;

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
function maskSpans(text: string, kind: "js" | "css" | "html" | "prose"): Span[] {
  if (kind === "prose") return [];
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

function kindFor(path: string): "js" | "css" | "html" | "prose" {
  if (/\.(html?|xml|svg)$/i.test(path)) return "html";
  if (/\.css$/i.test(path)) return "css";
  // A doc/data target has no executable code at all: masking its prose would
  // manufacture vacuous hits out of the artifact the pin is about.
  if (/\.(md|markdown|txt|json)$/i.test(path)) return "prose";
  return "js";
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

function resolveTarget(raw: string, testFile: string): string | null {
  if (!raw) return null;
  let r = raw.trim().replace(/\$\{(?:root|ROOT|repoRoot|REPO_ROOT)\}/g, "");
  if (r.includes("${")) return null;              // an interpolation we will not guess
  let abs: string;
  if (r.startsWith("../")) abs = `${ROOT}tests/${r}`;
  else if (r.startsWith("/")) abs = `${ROOT}${r.replace(/^\/+/, "")}`;
  else abs = `${ROOT}${r}`;
  const norm = new URL(`file://${abs}`).pathname;
  if (!norm.startsWith(ROOT)) return null;
  return norm.slice(ROOT.length);
}

type Pin = {
  testFile: string; testLine: number; target: string; token: string;
  live: number; shadow: number; shadows: { line: number; label: string; text: string }[];
};

function collectPins(): Pin[] {
  const pins: Pin[] = [];
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

  for (const name of testFiles()) {
    const text = Deno.readTextFileSync(`${TESTS}${name}`);
    // The TEST FILE gets masked too. Without this the guard matched pins inside
    // its own documentation: a re-anchored pin whose replacement comment quotes
    // the old assertion — "this was `assert(scriptText.includes(\"?toolautosubmit\"))`"
    // — is not an assertion, it is prose ABOUT one. A guard that fires on a
    // comment explaining a removed pin gets disabled, so prose is excluded.
    // `interp` is NOT excluded: code inside ${...} really runs.
    const testSpans = maskSpans(text, "js");
    const inProse = (pos: number): boolean => {
      for (const s of testSpans) {
        if (s.start > pos) break;
        if (s.start <= pos && pos < s.end) {
          return s.label === "comment" || s.label === "string" || s.label === "template";
        }
      }
      return false;
    };
    // Nearest-preceding assignment, not last-wins: these tests redeclare
    // `const src = await Deno.readTextFile(...)` inside each Deno.test scope, so
    // one file legitimately binds the same name to several targets. Last-wins
    // manufactured 82 bogus hits in the audit.
    const assigns: { pos: number; v: string; rel: string }[] = [];
    for (const m of text.matchAll(READ_RE)) {
      if (inProse(m.index!)) continue;              // a commented-out read binds nothing
      const rel = resolveTarget(m[2] || m[3] || "", name);
      if (rel) assigns.push({ pos: m.index!, v: m[1], rel });
    }
    const targetFor = (v: string, pos: number): string | null => {
      let best: { pos: number; rel: string } | null = null;
      for (const a of assigns) if (a.v === v && a.pos < pos && (!best || a.pos > best.pos)) best = a;
      return best ? best.rel : null;
    };

    for (const rx of [INCLUDES_RE, ASSERT_SIC_RE]) {
      rx.lastIndex = 0;
      for (const m of text.matchAll(rx)) {
        const pos = m.index!;
        const v = m[1];
        const token = m[3];   // both idioms capture (var, quote, token) in the same groups
        if (inProse(pos)) continue;                 // a pin quoted inside prose is not a pin
        const rel = targetFor(v, pos);
        if (!rel) continue;
        // absence pins are never offenders: a shadow makes them fail spuriously,
        // which is conservative, not a false green.
        const back = text.slice(Math.max(0, pos - 80), pos);
        const fwd = text.slice(pos + m[0].length, pos + m[0].length + 80);
        let negated = /!\s*$/.test(back) || /^\s*\)\s*\{?\s*throw\b/.test(fwd) ||
          /^\s*\)\s*,\s*false\b/.test(fwd) || /assertFalse\s*\(\s*$/.test(back);
        if (/^\s*\)\s*,\s*true\b/.test(fwd)) negated = false;
        if (negated) continue;
        if (/^\s*\)\s*\|\|/.test(fwd) || /\|\|\s*$/.test(back)) continue;  // disjunction: one pin, two spellings

        const entry = load(rel);
        if (!entry) continue;                          // unreadable/missing target
        const testLine = text.slice(0, pos).split("\n").length;
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
          if (label === "comment" || label === "import" || label === "console-msg") {
            shadows.push({ line: lineno + 1, label, text: (entry.lines[lineno] ?? "").trim().slice(0, 160) });
          } else live++;
        }
        if (live === 0 && shadows.length > 0) {
          pins.push({ testFile: `tests/${name}`, testLine, target: rel, token, live, shadow: shadows.length, shadows });
        }
      }
    }
  }
  return pins;
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
  ["tests/webmcp-honest-errors.test.ts::extension/content/main-world.js::redactSecretText",
    'message says "the port declares its source of truth (keep-in-sync pointer)": the pin guards the provenance comment. The redaction itself is pinned by the sibling assert(MAIN.includes("function redactBridgeText("), "the redaction choke point exists"), which is live code.'],
  ["tests/webmcp-honest-errors.test.ts::extension/lib/pure.js::redactBridgeText",
    'message says "redactSecretText names its content-script port so the two stay in sync": the mirror keep-in-sync pointer.'],
  ["tests/wasm-host-gate2.test.ts::scripts/scan-shipped.mjs::requires a separately reviewed static CAS route",
    'message says "the scan keeps the honest future-host wording": the pin guards documentation wording, not behaviour.'],
  // --- an import-only pin whose USE is separately pinned in the same file, so
  //     the binding cannot go dead unnoticed.
  ["tests/activity-liveness.test.ts::extension/shared/components.js::import { redactSecrets } from \"../lib/pure.js\";",
    'message "the canonical redactor is imported"; siblings pin redactSecrets(event.toolArgs), redactSecrets(parsed.value) and redactSecrets(p.value) as live call sites.'],
  ["tests/table-management-tools.test.ts::extension/offscreen/offscreen.js::import { registerTableWorkerHost } from \"../lib/table-worker-host.js\"",
    'the very next assertion pins the call site: assert(offscreen.includes("registerTableWorkerHost();")).'],
  ["tests/ux008-failed-dispatch.test.ts::extension/background/service-worker.js::import { buildRetryDispatch, retryRunId } from \"../lib/run-retry.js\";",
    'message "the SW imports the run-retry helpers"; four anchored regex pins in the same test prove the buildRetryDispatch(retryable.request) call site.'],
  ["tests/webmcp-dispatch-fallthrough.test.ts::extension/background/service-worker.js::from \"../lib/site-docs-fallback.js\"",
    "the withSiteDocsFallback call site is pinned separately in the same file."],
  ["tests/webmcp-lazyauth.test.ts::extension/background/service-worker.js::from \"../lib/webmcp-authority.js\"",
    'the next assertion pins the call site: assert(sw.includes("const authorizationGuard = createWebmcpAuthorizationGuard({")). The multi-line import binds four names; this pin points at its tail line.'],
  ["tests/mutation-claim-check.test.ts::extension/lib/agent.js::from \"./mutation-claim-check.js\"",
    "correctUnsupportedMutationClaims is exercised directly by the same file's behavioural tests."],
  ["tests/tool-exec-preview.test.ts::extension/options/options.js::lib/wasm-preview-host.js",
    'message "the options page wires the extracted host unit": an intentional import-PROVENANCE pin (which module supplies the host). The live wiring is pinned by the assertion directly above it, assert(options.includes(\'registerWasmPreviewHost()\')), whose occurrence is the real call site at options.js:413.'],
  ["tests/template-cards.test.ts::extension/ntp/ntp.js::import { buildTemplateSelect } from \"../lib/agent-template-select.js\"",
    "chrome-agent-platform-uodl: this import pin is what mutant U-I1 survived (a dead binding with the import left in place, full suite 3977/0). It is kept as the module-provenance pin and is now COVERED by the two call-site assertions added directly below it, which kill U-I1. Kept under audit rather than deleted so the provenance stays pinned."],
  // --- a redundant identity banner: the property is enforced by live siblings.
  ["tests/enrollment-policy.test.ts::extension/directory/directory.js::read-only Agent Directory",
    'the only occurrence is the file header. The read-only property is enforced by the absence assertions three lines below (!includes(\'send("tools.policy.set"\')), !includes(\'send("tools.approve"\')), so removing the behaviour still reddens the test.'],
]);

function keyOf(p: Pin): string {
  return `${p.testFile}::${p.target}::${p.token}`;
}

Deno.test("guard: no source-text .includes(X) pin is satisfied entirely by shadows", () => {
  const pins = collectPins();
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

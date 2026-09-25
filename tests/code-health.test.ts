// tests/code-health.test.ts — CAP-FB-20260830-CODE-HEALTH-01 (chrome-agent-platform-9do7).
//
// Two hygiene rules for the shipped extension tree, with falsification pins so a
// regression fails here instead of accumulating again:
//
//  1. No raw console.* call outside extension/lib/cap-log.js. Logging goes
//     through capLog(ns): levelled (silent by default in store builds),
//     redacted (scrubLogValue), and ring-buffered for the diagnostics surface.
//     Two files are EXEMPT, with the reason recorded below: the WebMCP
//     page-world diagnostics shims. content/main-world.js runs in the PAGE's
//     world — it cannot import modules and chrome.* is unavailable there — and
//     the entire point of those logs is to appear in the PAGE's DevTools
//     console when the owner enables Settings → Site agents → Diagnostics.
//     content/content-script.js is the isolated-world relay of the same
//     feature. Routing them through the extension's log buffer would break the
//     feature's contract.
//
//  2. No empty catch without a comment saying why. A bare `catch {}` swallows
//     an error with no record of intent; `catch { /* probe: a throw means X */
//     }` is a decision a reader can see.
//
// Scanning is string- and comment-aware (a mode-stack lexer, including nested
// template literals): injected sandbox scripts built as strings in
// shared/components.js contain `catch(e){}` text that is DATA, not extension
// control flow, and must not be flagged.

import { assertEquals } from "jsr:@std/assert@1";
import { join, relative } from "jsr:@std/path@1";

import { fileURLToPath } from "node:url";

const EXTENSION_DIR = fileURLToPath(new URL("../extension/", import.meta.url));

// ── the scanner ───────────────────────────────────────────────────────────

const CODE = 0, COMMENT = 1, STRING = 2;

type Frame = { kind: "code" | "tmpl-expr"; braceDepth: number };

// After these tokens a `/` opens a regex literal rather than dividing.
const REGEX_PRECEDER_KEYWORDS = new Set([
  "return", "typeof", "case", "in", "of", "new", "delete", "void", "throw",
  "instanceof", "yield", "await", "else", "do",
]);

/** Classify every character as code / comment / string, position-preserving.
 * Handles line + block comments, all three string forms, nested template
 * interpolations, and regex literals (a regex can contain an unbalanced quote
 * — e.g. /["']/ — so it must be lexed or every line after it flips polarity). */
export function classifySource(src: string): Uint8Array {
  const cls = new Uint8Array(src.length);
  const stack: Frame[] = [{ kind: "code", braceDepth: 0 }];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "regex" = "code";
  let regexClass = false; // inside a regex character class [...]
  let i = 0;
  const top = () => stack[stack.length - 1];
  // The last significant code character (whitespace, comments, strings excepted),
  // used to tell `/regex/` from division. Strings/regexes/templates close as operands.
  let lastSig: string | null = null;

  const regexAllowed = (): boolean => {
    if (lastSig === null) return true;
    if ("([{=,:;!&|?+-*%^~".includes(lastSig)) return true;
    if (lastSig === ">") {
      // `=>` opens an expression position; a bare `>` (comparison) does not.
      let k = i - 1;
      while (k >= 0 && (cls[k] !== CODE || /\s/.test(src[k]))) k--;
      // src[k] is the `>`; the significant code char before it decides:
      k--;
      while (k >= 0 && (cls[k] !== CODE || /\s/.test(src[k]))) k--;
      return k >= 0 && src[k] === "=";
    }
    if (/[A-Za-z0-9_$]/.test(lastSig)) {
      // identifier or keyword: keywords in the preceder set open an expression
      let k = i - 1;
      while (k >= 0 && (cls[k] !== CODE || /\s/.test(src[k]))) k--;
      let end = k + 1;
      while (k >= 0 && cls[k] === CODE && /[A-Za-z0-9_$]/.test(src[k])) k--;
      const word = src.slice(k + 1, end);
      return REGEX_PRECEDER_KEYWORDS.has(word);
    }
    return false; // `)`, `]`, `}`, literals: division
  };

  while (i < src.length) {
    const c = src[i];
    const two = src.slice(i, i + 2);

    if (mode === "line") {
      cls[i] = COMMENT;
      i++;
      if (c === "\n") mode = "code";
      continue;
    }
    if (mode === "block") {
      cls[i] = COMMENT;
      if (two === "*/") {
        cls[i + 1] = COMMENT;
        i += 2;
        mode = "code";
      } else {
        i++;
      }
      continue;
    }
    if (mode === "sq" || mode === "dq") {
      cls[i] = STRING;
      if (c === "\\") {
        if (i + 1 < src.length) cls[i + 1] = STRING;
        i += 2;
        continue;
      }
      i++;
      if (c === (mode === "sq" ? "'" : '"')) {
        mode = "code";
        lastSig = ")"; // a closed string is an operand
      }
      continue;
    }
    if (mode === "regex") {
      cls[i] = STRING;
      if (c === "\\") {
        if (i + 1 < src.length) cls[i + 1] = STRING;
        i += 2;
        continue;
      }
      i++;
      if (c === "[") regexClass = true;
      else if (c === "]") regexClass = false;
      else if (c === "/" && !regexClass) {
        mode = "code";
        lastSig = ")"; // a closed regex is an operand
      } else if (c === "\n") {
        mode = "code"; // unterminated regex: recover rather than poison the file
      }
      continue;
    }
    if (mode === "tmpl") {
      if (c === "\\") {
        cls[i] = STRING;
        if (i + 1 < src.length) cls[i + 1] = STRING;
        i += 2;
        continue;
      }
      if (c === "`") {
        cls[i] = STRING;
        i++;
        mode = "code";
        lastSig = ")"; // a closed template is an operand
        continue;
      }
      if (two === "${") {
        // The interpolation delimiters are code boundaries; the expression
        // itself is scanned as code.
        cls[i] = STRING;
        cls[i + 1] = STRING;
        i += 2;
        stack.push({ kind: "tmpl-expr", braceDepth: 0 });
        mode = "code";
        continue;
      }
      cls[i] = STRING;
      i++;
      continue;
    }

    // code mode
    if (two === "//") {
      cls[i] = COMMENT;
      cls[i + 1] = COMMENT;
      i += 2;
      mode = "line";
      continue;
    }
    if (two === "/*") {
      cls[i] = COMMENT;
      cls[i + 1] = COMMENT;
      i += 2;
      mode = "block";
      continue;
    }
    if (c === "'") {
      cls[i] = STRING;
      i++;
      mode = "sq";
      continue;
    }
    if (c === '"') {
      cls[i] = STRING;
      i++;
      mode = "dq";
      continue;
    }
    if (c === "`") {
      cls[i] = STRING;
      i++;
      mode = "tmpl";
      continue;
    }
    if (c === "/" && regexAllowed()) {
      cls[i] = STRING;
      i++;
      mode = "regex";
      regexClass = false;
      continue;
    }
    if (c === "{" && top().kind === "tmpl-expr") top().braceDepth++;
    if (c === "}" && top().kind === "tmpl-expr") {
      if (top().braceDepth === 0) {
        cls[i] = STRING; // the interpolation close: string context resumes
        stack.pop();
        mode = "tmpl";
        i++;
        continue;
      }
      top().braceDepth--;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return cls;
}

/** The source with comments and strings blanked (newlines preserved). */
function codeOnly(src: string, keepComments: boolean): string {
  const cls = classifySource(src);
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const drop = keepComments ? cls[i] === STRING : cls[i] !== CODE;
    out += drop && src[i] !== "\n" ? " " : src[i];
  }
  return out;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
}

const CONSOLE_CALL = /console\.(?:log|info|warn|error|debug)\s*\(/g;
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;

/** console.* calls at code positions: [line, ...] */
export function rawConsoleCalls(src: string): number[] {
  const code = codeOnly(src, false);
  return [...code.matchAll(CONSOLE_CALL)].map((m) => lineOf(code, m.index!));
}

/** Empty catches whose body holds neither code nor a comment: [line, ...].
 * Runs on string-stripped source with comments KEPT, so an annotated catch
 * passes and injected script text is not read as control flow. */
export function uncommentedEmptyCatches(src: string): number[] {
  const noStrings = codeOnly(src, true);
  const lines: number[] = [];
  for (const m of noStrings.matchAll(EMPTY_CATCH)) {
    const body = m[1];
    const withoutComments = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .trim();
    const hasComment = /\/\*|\/\//.test(body);
    if (withoutComments === "" && !hasComment) lines.push(lineOf(noStrings, m.index!));
  }
  return lines;
}

// ── the shipped-tree gate ─────────────────────────────────────────────────

const SKIP_DIRS = new Set(["dist", "dist-versions", "vendor", "node_modules"]);
const LOGGER = join("lib", "cap-log.js");

/** Deliberate raw-console files, with the reason each is exempt. */
const CONSOLE_EXEMPT = new Map<string, string>([
  [
    join("content", "main-world.js"),
    "MAIN-world page script: no module imports, no chrome.*; owner-gated WebMCP " +
      "diagnostics whose contract is to appear in the PAGE's DevTools console",
  ],
  [
    join("content", "content-script.js"),
    "isolated-world relay of the same owner-gated WebMCP page diagnostics",
  ],
]);

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path);
    } else if (entry.name.endsWith(".js")) {
      yield path;
    }
  }
}

Deno.test("no raw console.* calls in the shipped extension tree", async () => {
  const violations: string[] = [];
  for await (const path of walk(EXTENSION_DIR)) {
    const rel = relative(EXTENSION_DIR, path);
    if (rel === LOGGER || CONSOLE_EXEMPT.has(rel)) continue;
    const lines = rawConsoleCalls(await Deno.readTextFile(path));
    for (const line of lines) violations.push(`${rel}:${line}`);
  }
  assertEquals(
    violations,
    [],
    "route through capLog(ns) — levelled, redacted, ring-buffered — or record an exemption with its reason",
  );
});

Deno.test("no empty catch without a comment in the shipped extension tree", async () => {
  const violations: string[] = [];
  for await (const path of walk(EXTENSION_DIR)) {
    const rel = relative(EXTENSION_DIR, path);
    const lines = uncommentedEmptyCatches(await Deno.readTextFile(path));
    for (const line of lines) violations.push(`${rel}:${line}`);
  }
  assertEquals(
    violations,
    [],
    "an empty catch must carry a comment saying why the error is safe to swallow",
  );
});

// ── falsification: the rules must fire before they can be trusted ─────────

Deno.test("falsification: planted violations are reported, clean code is not", () => {
  const planted = [
    "const x = 1;",
    'console.log("noise");',
    "try { risky(); } catch {}",
    "try { fine(); } catch { /* probe: a throw means absent */ }",
    "capLog('ns').warn('routed');",
  ].join("\n");
  assertEquals(rawConsoleCalls(planted), [2]);
  assertEquals(uncommentedEmptyCatches(planted), [3]);

  const clean = [
    "const log = capLog('ns');",
    "log.info('routed');",
    "try { risky(); } catch { /* storage can throw in restricted modes */ }",
    'try { fine(); } catch (e) { log.warn("failed", e); }',
  ].join("\n");
  assertEquals(rawConsoleCalls(clean), []);
  assertEquals(uncommentedEmptyCatches(clean), []);
});

Deno.test("falsification: injected script text in strings is not control flow", () => {
  // The shared/components.js shape: sandbox-frame script lines as string
  // elements inside a template-literal interpolation, braces included.
  const generated = [
    'export function frameScript() {',
    '  return `<script>${[',
    '    "(function(){",',
    '    "try{window.open=function(){return null;};}catch(e){}",',
    '    "})();"].join("")}</script>`;',
    "}",
  ].join("\n");
  assertEquals(rawConsoleCalls(generated), []);
  assertEquals(uncommentedEmptyCatches(generated), []);

  // …while a real bare catch in the same file shape is still caught.
  const withReal = generated + "\ntry { boot(); } catch {}\n";
  assertEquals(uncommentedEmptyCatches(withReal), [7]);
});

Deno.test("falsification: comments mentioning console are not calls", () => {
  const comments = [
    "// console.error storms coalesce into one row",
    "/* console.log is wrapped by diagnostics.js */",
    'const s = "console.warn( not a call either";',
  ].join("\n");
  assertEquals(rawConsoleCalls(comments), []);
});

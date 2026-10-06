// scripts/test-partition.mjs — the single source of truth for the two-phase
// test partition (vj4s; hardened by 76hu). Imported by BOTH runners:
//   • scripts/run-tests.mjs (the full-suite merge gate, `npm test`)
//   • scripts/select-tests.mjs (per-commit subsets) and tests/test-partition-guard.test.ts
//
// Phase 1 (serial): tests that BUILD the extension or assert on shared build
//   artifacts in THIS worktree (extension/dist, dist-versions, bundled-tool
//   CAS, packages/bundled). They rewrite/verify the same paths; racing them
//   against each other or against dist readers failed 9 tests (vj4s par1 run).
// Phase 2 (parallel): everything else, `deno test --parallel`.
//   NOTE: Phase 2 includes real-browser execution (tests/chrome-profile-location.test.ts
//   unconditionally launches Chromium under a unit-scope lockPath; see docs/CHROME-TEST-CONTRACT.md).
//
// Coverage is complete by construction: every tests/*.test.ts runs exactly
// once, and NEW test files default to the parallel set. The guard test
// (tests/test-partition-guard.test.ts) scans every test file's content and
// fails RED when a build-artifact hazard (spawning build.mjs or the
// bundled-tool generator, writing under extension/ or packages/, or reading
// extension/dist) is NOT in SERIAL (or the reviewed EXEMPTIONS list), so a
// new hazard can never silently join the parallel phase.

// SERIAL membership is pinned WITH a reason: adding a file to the serial set
// means stating why it is a shared-build-artifact hazard. The guard test
// asserts every entry carries one.
export const SERIAL_REASONS = {
  "tests/build-bootstrap.test.ts": "runs node build.mjs in-place (dist/dist-versions rewrite)",
  "tests/store-doc-denial.test.ts": "runs node build.mjs in-place and reads the built extension/dist bundles (shared build artifacts)",
  "tests/build-debug-mode.test.ts": "runs node build.mjs in-place (debug+store bundles)",
  "tests/build-tool-bundling.test.ts": "runs build.mjs / the bundled-tool generator in-place and mutates packages/bundled",
  "tests/bundled-tool-packages.test.ts": "asserts the shipped CAS bytes (races with rebuilds)",
  "tests/reachability.test.ts": "asserts the repo tree's generated-artifact state",
  "tests/tool-exec-preview.test.ts": "revalidates the REAL shipped bytes (races with rebuilds)",
  "tests/package-extension-freshness.test.ts": "driver packages dist + writes the dist-complete marker",
  // nz2r: writes a stale build stage dir under extension/ to prove the
  // per-change gate is immune to killed-build residue (swept in its finally).
  "tests/select-tests-residue.test.ts": "plants build residue under extension/ to prove test:changed ignores it (removed in finally)",
  // elst: plants an untracked scripts/kat-*.ts probe in the real tree for its real-tree falsification;
  // races harness-registry's scripts/ census and residue on kill REDs two always-on guards.
  "tests/real-browser-teardown.test.ts": "plants an untracked scripts/kat-*.ts probe in the real tree for its real-tree falsification; races harness-registry's scripts/ census and residue on kill REDs two always-on guards",
  // mwz3/yx2h: the allowlist guard writes extension/lib/__probe_stray_gesture_reader.js
  // to the REAL repo tree for its end-to-end falsification, then removes it in finally.
  // A kill before finally leaves untracked shipped-path residue that poisons
  // the guard's own allowlist and makes test:changed fail closed to the full suite.
  "tests/requires-owner-gesture-column-allowlist.test.ts": "writes an untracked probe in the real repo extension/lib tree; killed-run residue trips its allowlist and changed-file selection",
  // 76hu guard caught this post-merge arrival from main (390b2b3a): it stats
  // the built SW bundle and the dist.complete marker — shared build artifacts.
  "tests/bundle-budget.test.ts": "reports the built dist bundle sizes + asserts the dist-complete marker integrity (races with rebuilds)",
  // 76hu: the guard's reads-extension/dist class pins these two (previously
  // parallel; both consume the built diff-core bundle, a shared artifact).
  "tests/diff-core.test.ts": "imports/reads the built extension/dist diff-core bundle (shared build artifact)",
  // cc18: reads the three built page bundles to assert they ship zero
  // WebAssembly API calls (the j6au tree-shaking property) — a rebuild mid-read
  // is exactly the race this phase exists to prevent.
  "tests/wasm-tree-shaking.test.ts": "reads the built extension/dist page bundles (shared build artifacts)",
  "tests/emscripten-abi-loaded-harness.test.ts": "requires current Store dist artifacts and prepares the live extension, briefly creating/removing its reserved probe directory",
  "tests/owner-approval-security.test.ts": "imports the built extension/dist diff-core bundle (shared build artifact)",
  "tests/chrome-launch-lock.test.ts": "tests process-global Chrome canonical lock and mutates CAP_CHROME_LOCK_PATH (races with other lock tests)",
  "tests/chrome-launch-lock-scope.test.ts": "tests Chrome lock scopes and mutates CAP_CHROME_SLOT_DIR (races with other lock tests)",
  "tests/chrome-slot-semaphore.test.ts": "tests Chrome bounded concurrency semaphore and mutates CAP_CHROME_SLOT_DIR (races with other lock tests)",
  // mee3: pins the four adjudicated survivors (S15 dead-holder accounting, S9
  // blocking probe, S16/S17 the unreported wait). Each test owns a unique
  // temporary slot dir so it cannot touch another lane's slots, but it still
  // mutates process-global CAP_CHROME_SLOT_DIR and asserts on wall-clock
  // queueing thresholds (a 1500 ms skip bound against a 2000 ms marker window),
  // which is exactly what the 32-worker parallel phase makes flaky.
  "tests/chrome-slot-semaphore-honesty.test.ts": "mutates CAP_CHROME_SLOT_DIR and makes wall-clock queueing assertions (races/flakes with other lock tests under the parallel phase)",
  // 3vi7 + cihz: tests/serial-phase-timeout.test.ts makes wall-clock kill/survive assertions
  // (a fixture that DECLARES 5000 ms of work, killed under a 4000 ms flat bound and surviving a
  // 12000 ms scaled one) which race and flake under the 32-worker parallel phase on a heavily
  // loaded fleet machine. cihz made the kill structural and the survive margin wide, but the
  // assertions are still real elapsed time, so the declaration stands.
  "tests/serial-phase-timeout.test.ts": "wall-clock kill/survive bounds assertions (declared 5000 ms work vs 4000 ms flat / 12000 ms scaled bounds) race the parallel phase",
};
export const SERIAL = new Set(Object.keys(SERIAL_REASONS));

/**
 * The bound for ONE child production build, used by the build-heavy serial files instead of a
 * hard-coded 180s/300s (chrome-agent-platform-kj9s). MEASURED on this 2-vCPU box at load ~5, warm
 * worktree: `node build.mjs --target=store` ~72s and `node build.mjs` (developer) ~59s (evidence:
 * the kj9s bead, which names the two timing gates and their per-file measurements; the raw log paths
 * are recorded THERE and deliberately not here, because a temp-path literal in this file trips the
 * always-on durable-root guard and reds every lane's subset gate — chrome-agent-platform-j3o1).
 * 300s is ~4x the measured store
 * build: enough that a loaded box does not SIGKILL a build (a killed build cannot release its lock,
 * which is how the old 180s bound seeded the zombie/stale-lock symptom), while a genuinely hung
 * build is still killed here and NAMED before the file window expires.
 */
export const PRODUCTION_BUILD_TIMEOUT_MS = 300_000;

/**
 * Per-file serial windows (chrome-agent-platform-kj9s). ONE global window for every serial file was
 * the mismatch that made a handful of build-heavy files look like a capacity problem: those files run
 * several REAL production builds, so their cost is a property of build COUNT, not of tree health.
 * Every value here is MEASURED WORK x ~3 — headroom for a loaded box that does not turn a hung file
 * into a 15-minute wait — and ONLY files that genuinely need it are listed; every other serial file
 * keeps the base window, so a hang there is still caught fast.
 *
 * MEASURED 2026-10-06 by gate kj9s-measure AFTER the 7->3 / 6->3 regroup (the box was deliberately
 * loaded: a merger gate was running concurrently, so these are pessimistic):
 *   build-bootstrap      278s  (3 production builds + 2 ZIP packagings; ~216s quiet at ~72s/build)
 *   build-debug-mode     173s  (developer + store + steady-state store)
 *   build-tool-bundling   10s  -> NEEDS NO BOUND. This corrects an UNMEASURED earlier estimate of
 *                               ~510s: the two generator "regenerations" are sub-second, and the
 *                               file's only build.mjs calls are fail-fast (bogus flag, disabled
 *                               target, drifted verify). It keeps the base window.
 *   store-doc-denial       6s  via the memoized record (97s when it really builds) -> base window.
 * A bound is MEASURED WORK x ~3, which is what the two entries below are.
 */
export const SERIAL_FILE_TIMEOUTS = Object.freeze({
  "tests/build-bootstrap.test.ts": 850_000, // 278s measured (contended) x 3.1
  "tests/build-debug-mode.test.ts": 550_000, // 173s measured (contended) x 3.2
});

// Files a content scan classifies as hazards but that are provably
// parallel-safe. Each exemption MUST state why the shared-artifact hazard
// does not apply; the guard test pins the reason. Keep this list tiny —
// membership is a review-time decision, never a default.
export const EXEMPTIONS = {
  "tests/evidence-durable.test.ts": "spawns the bundled-tool generator ONLY inside a pristine makeTempDir checkout materialization; every write goes to the temp dir, never to repo extension/ or packages/",
  // 4lc0 re-review: the fresh-instance gate plants `tests/*.test.ts` files in a makeTempDir scratch tree
  // and walks it. The write-hazard heuristic sees a write call near an `extension/` literal (the SAFE
  // fixture string it plants) and correctly flags the text — but every write goes to the scratch tree,
  // never to repo extension/ or packages/, and the file it writes is not in the real census at all.
  "tests/test-partition-guard.test.ts": "plants fixtures in a makeTempDir scratch tree; the extension/ literal is a fixture string, not a write target",
  // chrome-agent-platform-xru1: the note-contract test spawns dist-staleness-note.mjs with cwd set
  // to a durableDir scratch; its "extension/dist" literal is a path constructed INSIDE that scratch
  // (freshScratch wipes it per case) — the repo tree is never read or written. The assertions are
  // exit code 0 (the never-fail contract) and the note's wording.
  "tests/dist-note-contract.test.ts": "runs the note script inside a durableDir scratch; extension/dist is a scratch-relative path, not a repo write",
  // 4lc0 round 5 + o4m2: naming the generator in CODE (including string/template literals) is a
  // hazard, while comment prose is stripped before scanning (o4m2 aligned the build-artifact
  // detector with 8b8w's comment-ignoring driver rule). Each remaining entry was read before being
  // exempted: none of these four loads or executes anything — they read the build script's TEXT,
  // list it as a path to scan, or assert that package scripts or documents mention it in a string
  // literal. (tests/zod-jitless-fallback.test.ts and tests/bounded-child.test.ts were exempted
  // here until o4m2 stripped comments before scanning; with comment prose no longer classified as
  // a hazard, both files classify with NO hazard classes and their dead exemptions were retired.)
  "tests/changelog-shipping.test.ts": "reads ../build.mjs as TEXT to check what the changelog ships; never loads or runs it",
  "tests/file-url-root-guard.test.ts": "lists ROOT/build.mjs as a path to scan and pins the generator path as a STRING; no import, require or execution",
  "tests/package-scripts-exist.test.ts": "asserts a package.json script REFERENCE to build.mjs resolves; it never imports the generator",
  "tests/risk-register-contract.test.ts": "asserts the risk register CITES build.mjs for the bundle budget; documentation text only",
  // (tests/durable-root.test.ts was exempted here until 8b8w reference-scoped
  // the driver inheritance: with prose mentions no longer inheriting, the file
  // classifies with NO hazard classes and there is nothing left to exempt —
  // measured by audiofeed-astra's review and re-measured on the widened
  // delimiters.)
  // i1i9 removed the 4lc0 hazard AT THE SOURCE instead of working around it: the
  // generator's top-level work now lives in main(), called only under the existing
  // isMain guard. Measured on this tree — a fresh-process import yields
  // AGENT_DESCRIPTIONS (38 entries), prints no `OK: 38 packages …` generation line, and
  // leaves the per-file mtime fingerprint of extension/wasm/cas unchanged, where before
  // the same import rewrote all 38 files. So the import and the child probe below are
  // reads: they cannot race a rebuild because they do not cause one. tests/
  // tool-descriptions.test.ts pins that purity, so a regression re-serialises this file
  // the moment the child probe reds.
  "tests/tool-descriptions.test.ts": "imports the bundled-tool generator for its one pure export and spawns a no-write child that does the same; since chrome-agent-platform-i1i9 the generation work runs only under isMain, so neither the import nor the probe writes extension/wasm/cas — measured (CAS mtime fingerprint unchanged, no generation line on stdout)",
  // chrome-agent-platform-3337: the browser-dependencies test bundles agent-do and the REAL
  // agent-worker entry to MEMORY (esbuild write:false) and executes them under fakes; it names
  // build.mjs only as a STRING in a consumer list which it then reads as TEXT, to prove the
  // process.env define+banner pair cannot be split. Nothing is imported or spawned from build.mjs, and
  // the only file written is a makeTempDir it removes — no read or write touches repo extension/ or
  // packages/.
  "tests/browser-dependencies.test.ts": "names build.mjs only inside a consumer list read as TEXT (never spawned or loaded); all bundles are in-memory (write:false) and the one written file is a removed temp dir",
};

// A test that SPAWNS or IMPORTS one of these local drivers inherits the
// driver's hazard classification (the hazard lives in the driver, not the test
// wrapper). 8b8w/f94p: the first version of this rule keyed on the bare path
// SHAPE and matched any mention — a comment explaining a test made the
// explaining file inherit that test's hazards (measured 2026-09-25: a
// synthetic wrapper whose only mention of tests/wasm-tree-shaking.test.ts is
// inside a comment inherited "reads extension/dist" through DRIVER_REF_RE, and
// the live cc18 workaround was an evasive comment that refused to name its
// subject). The rule is now REFERENCE-SCOPED: only a module specifier
// (import/from/require/dynamic import) or a spawn/exec argument list can carry
// a driver reference, because those are the shapes that actually LOAD or RUN
// the driver. RESIDUE, stated so it is not implied away: a path assembled at
// runtime ("tests/" + name, or a SUBSTITUTING template `../tests/${n}`) is
// invisible to every text detector here — it was equally invisible to the old
// mention rule, so the fix does not widen that hole; a hoisted-const path
// (const D = "tests/x.mjs" … spawned later) is equally dataflow-invisible;
// within a spawn argument region the window also ends at the first `;`, so a
// driver path AFTER a semicolon inside the args escapes the same way; and a
// COMMENTED-OUT import still matches its shape (fail-closed: the cost is
// an inheritance a lane did not need, never a silent parallel writer).
// NO-SUBSTITUTION TEMPLATES ARE NOT RESIDUE (audiofeed-astra's review of this
// fix): `import(`../tests/x.mjs`)` loads the module exactly like a quoted
// specifier — the shape that cost the generator taxonomy round 5 — so the
// delimiter classes include the backtick and the spawn window crosses it.
const DRIVER_LOAD_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`][^"'`\n]*?(tests\/[\w.-]+\.(?:mjs|ts))["'`]/g;
const DRIVER_SPAWN_RE = /(?:Deno\.Command\s*\(|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|\.spawn(?:Sync)?\s*\()[^;]{0,400}?(tests\/[\w.-]+\.(?:mjs|ts))/g;

/** The tests/* drivers a file's text actually loads or spawns — the ONLY
 * references whose hazard classification a mentioning file inherits. A prose
 * mention (comment, doc string, explanatory note) is not a reference. */
export function realDriverRefs(text) {
  const refs = new Set();
  for (const re of [DRIVER_LOAD_RE, DRIVER_SPAWN_RE]) {
    for (const m of text.matchAll(re)) refs.add(m[1]);
  }
  return [...refs];
}

// o4m2: strip JS comments (`//` to any ECMAScript LineTerminator: LF, CR, U+2028,
// U+2029; and `/* ... */` block comments) with full lexical awareness of single/double
// quoted strings, template literals, `${...}` template interpolations, and regex
// literals (including `\/` escapes, `[...]` character classes, and `if/while/for/with (...)`
// condition parens). A naive regex comment-stripper in 4lc0 round 2/3 failed when a regex
// literal `/\/\//` or `/"/` was misread as a comment/string or when CR/LS/PS terminated a
// line comment; this single-pass O(n) scanner handles all four ECMAScript LineTerminators
// and preserves strings, templates, interpolations, and regex literals verbatim while
// replacing comment spans with whitespace so comment prose mentioning `build.mjs` or
// `build-bundled-tool-packages.mjs` never forces a pure test into SERIAL or EXEMPTIONS.
const REGEX_OK_SIG = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}",
  ";", "+", "-", "*", "/", "%", "~", "^", "<", ">",
]);
const REGEX_OK_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "new",
  "delete", "void", "throw", "do", "else", "yield", "await", "case",
]);
const REGEX_PAREN_WORDS = new Set(["if", "while", "for", "with"]);

function isLineTerminator(c) {
  return c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
}

function scanQuoted(text, i) {
  const q = text[i];
  let j = i + 1;
  const n = text.length;
  while (j < n) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (isLineTerminator(c)) return j;
    if (c === q) return j + 1;
    j++;
  }
  return n;
}

function scanRegex(text, i) {
  const n = text.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = text[j];
    if (isLineTerminator(c)) return null;
    if (c === "\\") {
      if (j + 1 < n && isLineTerminator(text[j + 1])) return null;
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      j++;
      while (j < n && /[a-z]/i.test(text[j])) j++;
      return j;
    }
    j++;
  }
  return null;
}

function stripTemplate(text, i) {
  const n = text.length;
  const parts = ["`"];
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === "\\") {
      parts.push(text.slice(j, j + 2));
      j += 2;
      continue;
    }
    if (c === "`") {
      parts.push("`");
      return { out: parts.join(""), next: j + 1 };
    }
    if (c === "$" && text[j + 1] === "{") {
      const inner = stripCodeRange(text, j + 2, true);
      parts.push("${", inner.out);
      j = inner.next;
      continue;
    }
    parts.push(c);
    j++;
  }
  return { out: parts.join(""), next: n };
}

function stripCodeRange(text, start, stopAtClosingBrace) {
  const n = text.length;
  const parts = [];
  let i = start;
  let braceDepth = stopAtClosingBrace ? 1 : 0;
  let prevSig = "";
  let prevWord = "";
  let afterRegexParen = false;
  let noRegexBefore = -1;
  const parenStack = [];
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      parts.push(c);
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const j = scanQuoted(text, i);
      parts.push(text.slice(i, j));
      prevSig = c;
      prevWord = "";
      afterRegexParen = false;
      i = j;
      continue;
    }
    if (c === "`") {
      const tpl = stripTemplate(text, i);
      parts.push(tpl.out);
      prevSig = "`";
      prevWord = "";
      afterRegexParen = false;
      i = tpl.next;
      continue;
    }
    if (c === "/") {
      if (text[i + 1] === "/") {
        let j = i + 2;
        while (j < n && !isLineTerminator(text[j])) j++;
        parts.push(" ");
        i = j;
        continue;
      }
      if (text[i + 1] === "*") {
        const k = text.indexOf("*/", i + 2);
        const j = k < 0 ? n : k + 2;
        const raw = text.slice(i + 2, k < 0 ? n : k);
        parts.push(/[\n\r\u2028\u2029]/.test(raw) ? "\n" : " ");
        i = j;
        continue;
      }
      const allow =
        afterRegexParen ||
        (prevSig === "" && !prevWord) ||
        REGEX_OK_WORD.has(prevWord) ||
        (!prevWord && REGEX_OK_SIG.has(prevSig));
      if (allow && i >= noRegexBefore) {
        const j = scanRegex(text, i);
        if (j !== null) {
          parts.push(text.slice(i, j));
          prevSig = "/";
          prevWord = "";
          afterRegexParen = false;
          i = j;
          continue;
        }
        let eol = i + 1;
        while (eol < n && !isLineTerminator(text[eol])) eol++;
        noRegexBefore = eol;
      }
      parts.push("/");
      prevSig = "/";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (c === "(") {
      parenStack.push(REGEX_PAREN_WORDS.has(prevWord));
      parts.push("(");
      prevSig = "(";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (c === ")") {
      afterRegexParen = parenStack.pop() === true;
      parts.push(")");
      prevSig = ")";
      prevWord = "";
      i++;
      continue;
    }
    if (c === "{") {
      if (stopAtClosingBrace) braceDepth++;
      parts.push("{");
      prevSig = "{";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (c === "}") {
      if (stopAtClosingBrace) {
        braceDepth--;
        if (braceDepth === 0) {
          parts.push("}");
          return { out: parts.join(""), next: i + 1 };
        }
      }
      parts.push("}");
      prevSig = "}";
      prevWord = "";
      afterRegexParen = false;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && isWordChar(text[j])) j++;
      prevWord = text.slice(i, j);
      prevSig = prevWord[prevWord.length - 1];
      afterRegexParen = false;
      parts.push(prevWord);
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && (isWordChar(text[j]) || text[j] === ".")) j++;
      const num = text.slice(i, j);
      prevWord = "";
      prevSig = num[num.length - 1];
      afterRegexParen = false;
      parts.push(num);
      i = j;
      continue;
    }
    parts.push(c);
    prevWord = "";
    prevSig = c;
    afterRegexParen = false;
    i++;
  }
  return { out: parts.join(""), next: n };
}

export function stripComments(text) {
  return stripCodeRange(text, 0, false).out;
}

const SPAWN_RE = /Deno\.Command\s*\(|spawnSync\s*\(|execFileSync\s*\(|execSync\s*\(|\.spawn\s*\(|\bspawn\s*\(/;
const BUILD_REF_RE = /build\.mjs|build-bundled-tool-packages/;
// 4lc0 + o4m2: a test that IMPORTS or SPAWNS a build module runs it — module side effects are the
// same hazard as spawning it, and the SPAWN_RE rule above cannot see an import/re-export/require
// (including a no-substitution template specifier `import(`../scripts/build-bundled-tool-packages.mjs`)`).
// Rather than modelling every JS import syntax, any CODE reference to `build.mjs` or
// `build-bundled-tool-packages` (after stripping comments via `stripComments(text)`) is flagged and
// must be declared SERIAL or exempted with a reason. Stripping comments first (o4m2) aligns this
// detector with `realDriverRefs` (8b8w/f94p): prose comments explaining how `build.mjs` works no
// longer force pure unit tests into `EXEMPTIONS`.
const GENERATOR_NAME_RE = /(?:build\.mjs|build-bundled-tool-packages)/;
const WRITE_CALL_RE = /(?:writeTextFile|writeFileSync|writeFile|mkdirSync|mkdir|removeSync|remove|copyFile|rename)\s*\(/g;
const TREE_LITERAL_RE = /["'`][^"'`\n]*(?:extension|packages)\/[^"'`\n]*["'`]/;
const READ_RE = /readTextFile|readFile|readFileSync|readDir|readdir|import\s*\(|\bfrom\s*["']/i;
const DIST_LITERAL_RE = /extension\/dist/;

// Write hazard = a write/remove call with a tree literal NEAR the call site
// (same statement or the assignment feeding it). A file that merely mentions
// extension/ paths for reads while writing elsewhere (a temp dir, an in-memory
// fake, a DOM stub) is not a write hazard — the near-miss list of 16 parallel
// files in 76hu proved the coarse any-write + any-literal scan far too broad.
function writesTree(text) {
  for (const m of text.matchAll(WRITE_CALL_RE)) {
    const around = text.slice(Math.max(0, m.index - 300), m.index + 300);
    if (TREE_LITERAL_RE.test(around)) return true;
  }
  return false;
}

// Classify one test file's content (optionally merged with the text of local
// drivers it spawns). Returns the matched hazard class names; empty = safe,
// defaults to the parallel phase. Comments are stripped first (o4m2) so prose
// comments never trigger hazard classes.
export function classifyHazards(text) {
  const code = stripComments(text);
  const classes = [];
  if (SPAWN_RE.test(code) && BUILD_REF_RE.test(code)) classes.push("spawns build.mjs or the bundled-tool generator");
  if (GENERATOR_NAME_RE.test(code)) classes.push("names build.mjs or the bundled-tool generator (a load hazard whatever the syntax)");
  if (writesTree(code)) classes.push("writes under extension/ or packages/");
  if (READ_RE.test(code) && DIST_LITERAL_RE.test(code)) classes.push("reads extension/dist");
  return classes;
}

/**
 * THE GUARD'S INVARIANT, as a pure function (4lc0 re-review): every content hazard must be in SERIAL
 * or carry a reviewed EXEMPTIONS reason. Extracted so the real census check and the fresh-instance
 * gate test the SAME rule — the first version of the gate proved the classifier on a path it only
 * claimed, and bypassing the census left all six guard tests green (cap-astra, 2026-09-24).
 * `entries` are [repoRelativePath, content] pairs; the result is the hazard files that would run in
 * the PARALLEL phase, so an empty result is the safe answer.
 */
export function unserialisedHazards(entries) {
  const violations = [];
  for (const [rel, text] of entries) {
    const classes = classifyHazards(text);
    if (!classes.length) continue; // safe → defaults to the parallel phase
    if (SERIAL.has(rel)) continue;
    const reason = EXEMPTIONS[rel];
    if (typeof reason === "string" && reason.trim().length > 0) continue;
    violations.push(`${rel} — ${classes.join("; ")}`);
  }
  return violations;
}

// Split a list of test files (repo-relative) into the two phases, preserving
// the full-run invariant: serial hazards first (never parallel), everything
// else parallel. Deterministic ordering for stable logs.
export function partition(files) {
  const sorted = [...files].sort();
  return {
    serial: sorted.filter((f) => SERIAL.has(f)),
    parallel: sorted.filter((f) => !SERIAL.has(f)),
  };
}

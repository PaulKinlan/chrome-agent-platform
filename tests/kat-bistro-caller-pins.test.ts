// tests/kat-bistro-caller-pins.test.ts — bead er6x.
//
// scripts/kat-webmcp-bistro.ts is a TOP-LEVEL script with side effects: nothing
// imports it, so no test can execute it, and `npm run test:changed` fails closed
// to the full suite whenever it changes. Its guards can therefore only be pinned
// by reading its source — but the existing pins are SUBSTRING pins, and a
// mutation sweep of 26 guards found 22 that survive the entire suite. Two root
// causes, both general:
//
//   1. `scriptText.includes(X)` is satisfied by a COMMENT or an IMPORT. Dropping
//      `?toolautosubmit` from the URL survives because the file's own header
//      comment mentions it; removing the `withTimeout` wrapper around the
//      success invocation survives because the import line and the teardown
//      field still contain the word.
//   2. Nothing pins the CALL SITES at all — the check() predicates that decide
//      whether WebMCP actually works, the receipt announcement guard, the
//      run-error capture, the report's identity fields, and the teardown wiring
//      are all unasserted.
//
// Every pin here is anchored to a DECLARATION or CALL SITE and parses the
// construct where it can, so a comment or an import can never satisfy it.
//
// HONEST LIMIT, stated rather than hidden: a source pin proves the text is
// present and well-formed. It does NOT prove the code executes, nor that a
// predicate is the RIGHT predicate. The durable answer is extraction with
// injectable seams — the same treatment that produced lib/kat-finalizer.ts,
// whose header says it was "extracted from scripts/kat-webmcp-bistro.ts verbatim
// so the committed tests execute the REAL caller". That refactor is filed
// separately; these pins are what is available today and they are strictly
// better than substring matching.
// @ts-nocheck

import { assert, assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = `${ROOT}scripts/kat-webmcp-bistro.ts`;
const text = await Deno.readTextFile(SCRIPT);

/** Every check(...) call's second argument (its condition), as raw source. */
function checkConditions(src: string) {
  const out = [];
  const re = /\bcheck\(\s*"((?:[^"\\]|\\.)*)"\s*,/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // walk forward from the comma, tracking nesting, to the comma that ends the
    // condition argument (or the closing paren)
    let i = m.index + m[0].length;
    let depth = 0;
    let start = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    out.push({ name: m[1], cond: src.slice(start, i).trim() });
  }
  return out;
}

const CONDITIONS = checkConditions(text);
function conditionOf(namePart) {
  const hit = CONDITIONS.find((c) => c.name.includes(namePart));
  assert(hit, `no check() named like ${JSON.stringify(namePart)}; found: ${CONDITIONS.map((c) => c.name).join(" | ")}`);
  return hit.cond;
}

// ── 0. the general anti-vacuity guard ───────────────────────────────────────
// U10 made the falsification check `true` and U13 made the screenshot check
// `true`; both survived the whole suite. No check may have a constant condition.
Deno.test("caller pins: no check() has a constant or vacuous condition (U10/U13)", () => {
  assert(CONDITIONS.length >= 5, `expected the KAT's checks to be enumerable, found ${CONDITIONS.length}`);
  const vacuous = CONDITIONS.filter((c) => /^(true|false|1|0|!\s*0|!\s*1)$/.test(c.cond));
  assertEquals(vacuous.map((c) => `${c.name} => ${c.cond}`), [], "a check with a constant condition can never fail");
  // and every condition must actually reference the value it is checking
  for (const c of CONDITIONS) {
    assert(c.cond.length > 8, `condition for ${JSON.stringify(c.name)} is too weak to be meaningful: ${c.cond}`);
  }
});

// ── 1. the ?toolautosubmit binding ──────────────────────────────────────────
Deno.test("caller pins: URL_BISTRO's own literal carries ?toolautosubmit (U1)", () => {
  const m = text.match(/const\s+URL_BISTRO\s*=\s*"([^"]+)"/);
  assert(m, "URL_BISTRO must be a string literal declaration");
  const url = new URL(m[1]);
  assert(url.searchParams.has("toolautosubmit"),
    `the demo URL must carry ?toolautosubmit so the tool step submits itself; got ${m[1]}`);
  assert(url.pathname.includes("french-bistro"), `wrong demo: ${url.pathname}`);
});

// ── 2. the WebMCP feature flag ──────────────────────────────────────────────
Deno.test("caller pins: Chromium is launched with --enable-features=WebMCP (U2)", () => {
  const m = text.match(/launchChrome\(\{([\s\S]*?)\n\s*\}\);/);
  assert(m, "the launchChrome call site must be findable");
  assert(/"--enable-features=WebMCP"/.test(m[1]),
    `the launch args must enable WebMCP; got: ${m[1].replace(/\s+/g, " ").slice(0, 200)}`);
  assert(!/--disable-features=WebMCP/.test(m[1]), "WebMCP must not be disabled");
});

// ── 3. the receipt-announcement rule ────────────────────────────────────────
Deno.test("caller pins: a receipt path is announced ONLY behind the returned receiptPath guard (U5)", () => {
  const m = text.match(/if\s*\(\s*outcome\.receiptPath\s*\)\s*console\.log\(\s*`KAT receipt:[\s\S]{0,80}?\);/);
  assert(m, "the KAT receipt announcement must be guarded by `if (outcome.receiptPath)`");
  const unguarded = text.match(/^\s*console\.log\(\s*`KAT receipt:/m);
  assertEquals(unguarded, null, "an unguarded receipt announcement would print `KAT receipt: null` on a failed publication");
});

Deno.test("caller pins: the announced locator is the RETURNED authority, not a path the caller rebuilds (U6)", () => {
  const m = text.match(/`KAT receipt:\s*\$\{([^}]+)\}`/);
  assert(m, "the announcement must interpolate something");
  assertEquals(m[1].trim(), "outcome.receiptPath",
    "the locator must be the finalizer's returned receiptPath — rebuilding it from OUT would announce a path that was never verified");
});

// ── 4. the run-error capture (the highest-severity gap) ─────────────────────
Deno.test("caller pins: a crash inside the run becomes runError, never null (U7)", () => {
  const m = text.match(/catch\s*\(err\)\s*\{([\s\S]*?)\n\}\s*finally\s*\{/);
  assert(m, "the run's catch block must be findable");
  assert(/runError\s*=\s*err\s+instanceof\s+Error\s*\?/.test(m[1]),
    `runError must be derived from the caught error; got: ${m[1].replace(/\s+/g, " ").slice(0, 200)}`);
  assert(!/runError\s*=\s*null/.test(m[1]), "assigning null to runError in the catch turns a crash into a GREEN receipt");
  assert(/err\.stack\s*\?\?\s*err\.message/.test(m[1]), "the receipt keeps the bounded stack-or-message");
});

// ── 5. the ll7q console rule ────────────────────────────────────────────────
Deno.test("caller pins: the console gets the SANITIZED error, never raw run paths (U8)", () => {
  const m = text.match(/console\.error\(\s*"KAT Execution Error:",\s*(.+?)\s*\)\s*;/);
  assert(m, "the KAT Execution Error console call must be findable");
  assertEquals(m[1].trim(), "sanitizeKatLogError(err)",
    "ll7q: the console must carry the sanitized class, never the raw stack, which contains run paths");
});

// ── 6. the four substantive check predicates ────────────────────────────────
Deno.test("caller pins: the falsification check requires the NATIVE JSON parse error (U9)", () => {
  const cond = conditionOf("falsification: unstringified object args");
  assert(/ok\s*===\s*false/.test(cond), `it must require the object-arg call to fail: ${cond}`);
  assert(/Failed to parse input string as JSON/i.test(cond),
    `it must require the specific WebIDL/JSONReader failure, not any failure: ${cond}`);
});

Deno.test("caller pins: the success check requires the booking confirmation text (U11)", () => {
  const cond = conditionOf("JSON-string arguments settle successfully");
  assert(/ok\s*===\s*true/.test(cond), `it must require success: ${cond}`);
  assert(/typeof[\s\S]*===\s*"string"/.test(cond), `the result must be a string: ${cond}`);
  assert(/We look forward to welcoming you/.test(cond),
    `it must require the demo's actual confirmation copy, or any string passes: ${cond}`);
});

Deno.test("caller pins: the DOM check compares EVERY booking field, not just that a dialog opened (U12)", () => {
  const cond = conditionOf("the real page visibly reflects the exact booking");
  for (const field of ["dialogOpen", "name", "phone", "date", "time", "guests", "seating"]) {
    assert(cond.includes(`visible?.${field}`), `the DOM check must compare ${field}: ${cond}`);
    assert(new RegExp(`visible\\?\\.${field}\\s*===`).test(cond), `${field} must be compared for equality, not merely read`);
  }
  assert(/modalText\.includes\(/.test(cond), `the confirmation dialog's text must be verified: ${cond}`);
});

Deno.test("caller pins: the screenshot check requires real captured bytes (U13)", () => {
  const cond = conditionOf("post-invocation screenshot captured");
  assert(/!\s*!\s*shot\?\.length/.test(cond), `an empty capture must fail: ${cond}`);
});

Deno.test("caller pins: the captured screenshot is persisted into THIS run's evidence dir (U14)", () => {
  const m = text.match(/Deno\.writeFile\(\s*`\$\{OUT\}\/([^`]+)`\s*,\s*shot\s*\)/);
  assert(m, "the screenshot must be written under ${OUT} — evidence outside the run dir is not attributable");
  assert(m[1].endsWith(".png"), `expected a png artifact, got ${m[1]}`);
  assert(/if\s*\(\s*shot\s*\)/.test(text), "the write must stay guarded so an absent capture cannot throw in the run body");
});

Deno.test("caller pins: the service-worker check requires THIS extension's scheme (U15)", () => {
  const cond = conditionOf("registered its service worker");
  assert(/startsWith\(\s*"chrome-extension:\/\/"\s*\)/.test(cond),
    `a worker merely existing proves nothing about the fresh profile: ${cond}`);
});

// ── 7. bounds ───────────────────────────────────────────────────────────────
Deno.test("caller pins: the success invocation is bounded by withTimeout at its CALL SITE (U16)", () => {
  // NOTE: the source writes its bounds with numeric separators (30_000), so the
  // capture is [\d_]+, not \d+.
  const m = text.match(/const\s+strRes\s*=\s*await\s+withTimeout\(([\s\S]*?),\s*([\d_]+)\s*\)\s*;/);
  assert(m, "the success eval must be wrapped in withTimeout(...) — the word appearing in an import does not bound anything");
  assert(m[1].includes("cdp.eval("), `withTimeout must wrap the actual eval call: ${m[1].slice(0, 120)}`);
  const bound = Number(m[2].replace(/_/g, ""));
  assert(bound > 0 && bound <= 60_000, `the bound must be sane, got ${m[2]}`);
});

Deno.test("caller pins: the load wait requires document.modelContext.getTools, not just readyState (U17)", () => {
  const m = text.match(/await\s+waitFor\(\s*cdp\s*,\s*page\.sessionId\s*,\s*`([^`]*)`\s*,\s*([\d_]+)\s*\)/);
  assert(m, "the waitFor call site must be findable");
  assert(/document\.readyState\s*===\s*"complete"/.test(m[1]), `load must be complete: ${m[1]}`);
  assert(/typeof\s+document\.modelContext\?\.getTools\s*===\s*"function"/.test(m[1]),
    `waiting only for readyState races the WebMCP registration: ${m[1]}`);
  assert(Number(m[2].replace(/_/g, "")) > 0, "the wait must be bounded");
});

// ── 8. evidence identity and durability ─────────────────────────────────────
Deno.test("caller pins: the receipt's outDir is THIS invocation's run child, never the shared parent (U18)", () => {
  const m = text.match(/outDir:\s*([A-Za-z_][\w.]*)\s*,/);
  assert(m, "the report's outDir field must be findable");
  assertEquals(m[1], "OUT",
    "outDir must be the allocator's fresh child; the shared parent is the reused-directory aliasing z6xw exists to prevent");
  assert(!/outDir:\s*OUT_PARENT/.test(text), "the parent must never be the receipt directory");
});

Deno.test("caller pins: the receipt carries the sha256 of the REAL content-script bytes (U21)", () => {
  const m = text.match(/mainWorldSha256\s*=\s*createHash\(\s*"sha256"\s*\)\.update\(\s*(\w+)\s*\)\.digest\(\s*"hex"\s*\)/);
  assert(m, "mainWorldSha256 must be a real sha256 over the bytes that were read");
  assertEquals(m[1], "mwBytes", "it must hash the content script that was actually read from disk");
  assert(/readFile\(\s*`\$\{EXT\}\/content\/main-world\.js`\s*\)/.test(text), "the bytes must come from the real extension content script");
});

Deno.test("caller pins: the receipt records whether the tree was dirty (U22)", () => {
  const m = text.match(/const\s+dirty\s*=\s*\(([\s\S]*?)\)\.length\s*>\s*0\s*;/);
  assert(m, `dirty must be derived from git status --porcelain; got: ${(text.match(/const dirty = .*;/) || ["<none>"])[0]}`);
  assert(/git\(\s*"status"\s*,\s*"--porcelain"\s*\)/.test(m[1]), `it must call git status --porcelain: ${m[1]}`);
});

Deno.test("caller pins: the receipt's expected identity is the commit under test (U23)", () => {
  const m = text.match(/expected:\s*([A-Za-z_][\w.]*)\s*,/);
  assert(m, "the report's expected field must be findable");
  assertEquals(m[1], "head", "expected must be the HEAD the run was executed against");
});

// ── 9. teardown wiring ──────────────────────────────────────────────────────
Deno.test("caller pins: teardown receives the live cdp AND chrome handles (U25)", () => {
  const m = text.match(/teardown:\s*\{([\s\S]*?)\n\s*\},/);
  assert(m, "the teardown object passed to the finalizer must be findable");
  assert(/(^|\n)\s*cdp\s*,/.test(m[1]), `cdp must be passed through, or the browser is never closed: ${m[1].replace(/\s+/g, " ")}`);
  assert(/(^|\n)\s*chrome\s*,/.test(m[1]), `chrome must be passed through, or the process is never killed: ${m[1].replace(/\s+/g, " ")}`);
  assert(!/cdp:\s*null/.test(m[1]) && !/chrome:\s*null/.test(m[1]), "nulling a teardown handle leaks the browser");
});

Deno.test("caller pins: teardown receives the profile path so the profile is cleaned (U24)", () => {
  const m = text.match(/teardown:\s*\{([\s\S]*?)\n\s*\},/);
  assert(m, "the teardown object must be findable");
  assert(/profilePath:\s*PROFILE\s*,/.test(m[1]), `profilePath must be the real profile dir: ${m[1].replace(/\s+/g, " ")}`);
  assert(!/profilePath:\s*null/.test(m[1]), "nulling profilePath leaks a full browser profile per run");
});

Deno.test("caller pins: the receipt records the lock wait the launcher reported (U26)", () => {
  const m = text.match(/lockWaitMs:\s*([^,\n]+),/);
  assert(m, "the report's lockWaitMs field must be findable");
  assertEquals(m[1].trim(), "chrome?.lockWaitMs ?? null",
    "lockWaitMs must carry the launcher's measured wait — serialization evidence lives in the receipt");
});

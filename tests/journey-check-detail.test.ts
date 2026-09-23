// tests/journey-check-detail.test.ts — chrome-agent-platform-ady6
//
// The regression test for a defect that a GREEN suite was fully consistent with:
// scripts/chrome-journeys.ts's check() took two parameters, so the detail object
// handed to it by NINE pre-existing call sites (plus one this branch added) was
// discarded. Those checks computed provider request counts, overflow, envelope and
// run phase, passed them to a function that dropped them, and printed only
// "FAIL: <name>". TypeScript reported every one as "Expected 2 arguments, but got
// 3" — inside a 627-error baseline nobody read as a delta.
//
// So this test EXECUTES the real check() rather than asserting on its text: a
// substring pin on `detail?` would pass with the printing removed, which is the
// exact failure mode this repo's test-honesty canon catalogue calls a shadow.
// Extraction follows the house pattern in tests/journey-cdp-timeout.test.ts.
//
// The safety property under test is as important as the feature: a diagnostics
// change that alters ANY verdict has changed what the gate decides rather than what
// it reports. So the PASS output, the `results` element shape, the EXPECTED_RED /
// UNEXPECTED-GREEN paths and the duplicate-name throw are all pinned here too.
//
// FALSIFICATION (required — an assertion never observed failing is not evidence):
// revert check() to `function check(name, cond)` and drop the `shown` suffix, and
// "prints the detail on failure" goes RED while the PASS/results/EXPECTED_RED
// assertions stay green. Restored, 8 passed / 0 failed.
import { assert, assertEquals } from "jsr:@std/assert@1";

const source = await Deno.readTextFile(
  new URL("../scripts/chrome-journeys.ts", import.meta.url),
);
const start = source.indexOf("function check(name, cond");
const end = source.indexOf("\n/** The exact, ordered set of assertions", start);
assert(start >= 0 && end > start, "the real check() must be found in chrome-journeys.ts");
const checkSource = source.slice(start, end);
assert(
  checkSource.includes("console.log"),
  "extracted check() must still be the printing implementation",
);
// new Function() compiles JavaScript, not TypeScript, so the one type annotation in
// the signature has to go — the same step tests/journey-cdp-timeout.test.ts takes
// with `sessionId?`. Asserted rather than assumed: if the signature changes, this
// fails loudly instead of silently testing a different function.
const JS_CHECK_SOURCE = checkSource.replace(
  "function check(name, cond, detail?: unknown) {",
  "function check(name, cond, detail) {",
);
assert(
  JS_CHECK_SOURCE !== checkSource && !JS_CHECK_SOURCE.includes("?: unknown"),
  `check()'s signature drifted from the expected shape; update the annotation strip. Got: ${checkSource.split("\n")[0]}`,
);

/** Build the REAL check() with its module-scope state and console injected. */
function fixture(expectedRed: Map<string, string> = new Map()) {
  const ran = new Set<string>();
  const results: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const fakeConsole = { log: (s: unknown) => lines.push(String(s)) };
  const check = new Function(
    "ran",
    "results",
    "EXPECTED_RED",
    "console",
    `${JS_CHECK_SOURCE}\nreturn check;`,
  )(ran, results, expectedRed, fakeConsole) as (
    name: string,
    cond: unknown,
    detail?: unknown,
  ) => void;
  return { check, ran, results, lines };
}

Deno.test("ady6: a failing check PRINTS the detail it was handed", () => {
  const { check, lines } = fixture();
  const detail = { requests: 3, overflow: 0, runPhase: "terminal", env: { ok: true } };
  check("the probe reached the model", false, detail);
  assertEquals(lines.length, 1);
  assert(lines[0].startsWith("FAIL: the probe reached the model"), lines[0]);
  // The whole point: the measured values a next lane needs are in the output.
  for (const fragment of ['"requests":3', '"overflow":0', '"runPhase":"terminal"']) {
    assert(lines[0].includes(fragment), `detail fragment ${fragment} missing from: ${lines[0]}`);
  }
});

Deno.test("ady6: a detail that is not JSON-serialisable still reaches the output", () => {
  const { check, lines } = fixture();
  const cyclic: Record<string, unknown> = { name: "cyclic" };
  cyclic.self = cyclic;
  check("cyclic detail", false, cyclic);
  assert(lines[0].startsWith("FAIL: cyclic detail"), lines[0]);
  // Must not throw away the verdict because the detail could not be stringified.
  assert(lines[0].length > "FAIL: cyclic detail".length, lines[0]);
});

Deno.test("ady6: PASS output is byte-identical with and without a detail", () => {
  const withDetail = fixture();
  withDetail.check("a passing check", true, { requests: 3 });
  const without = fixture();
  without.check("a passing check", true);
  assertEquals(withDetail.lines, ["PASS: a passing check"]);
  assertEquals(without.lines, ["PASS: a passing check"]);
});

Deno.test("ady6: a failing check with NO detail prints no separator or undefined", () => {
  const { check, lines } = fixture();
  check("plain failure", false);
  assertEquals(lines, ["FAIL: plain failure"]);
});

Deno.test("ady6: the results element shape is unchanged — {name, pass} only", () => {
  const { check, results } = fixture();
  check("shape probe", false, { requests: 3 });
  check("shape probe 2", true, { requests: 3 });
  assertEquals(results.length, 2);
  // A detail key leaking into results would change what the suite's own summary
  // and FINAL_CHECK consume.
  assertEquals(Object.keys(results[0]).sort(), ["name", "pass"]);
  assertEquals(Object.keys(results[1]).sort(), ["name", "pass"]);
  assertEquals(results[0], { name: "shape probe", pass: false });
  assertEquals(results[1], { name: "shape probe 2", pass: true });
});

Deno.test("ady6: a long detail is truncated rather than flooding the transcript", () => {
  const { check, lines } = fixture();
  check("huge detail", false, { blob: "x".repeat(5000) });
  assert(lines[0].length < 600, `printed line was ${lines[0].length} chars`);
  assert(lines[0].startsWith("FAIL: huge detail"), lines[0]);
});

Deno.test("ady6: EXPECTED_RED and UNEXPECTED-GREEN verdicts are unchanged by the detail parameter", () => {
  const red = fixture(new Map([["owned failure", "CAP-FB-OWNER-01"]]));
  red.check("owned failure", false, { requests: 0 });
  assertEquals(red.lines, ["EXPECTED-RED (CAP-FB-OWNER-01): owned failure"]);
  assertEquals(red.results, [{ name: "owned failure", pass: false, expectedRed: "CAP-FB-OWNER-01" }]);

  const green = fixture(new Map([["owned failure", "CAP-FB-OWNER-01"]]));
  green.check("owned failure", true, { requests: 3 });
  assertEquals(green.lines.length, 1);
  assert(green.lines[0].startsWith("UNEXPECTED-GREEN: owned failure"), green.lines[0]);
  assertEquals(green.results, [{ name: "owned failure", pass: false, unexpectedGreen: "CAP-FB-OWNER-01" }]);
});

Deno.test("ady6: a duplicate assertion name still throws", () => {
  const { check } = fixture();
  check("once", true);
  let threw = "";
  try {
    check("once", true, { detail: 1 });
  } catch (error) {
    threw = String((error as Error)?.message ?? error);
  }
  assert(threw.includes("duplicate assertion: once"), `expected a duplicate-assertion throw, got: ${threw}`);
});

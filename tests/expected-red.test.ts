// CAP-FB-20260830-SUITE-HONESTY-01 — an owned, expected failure is printed
// with its owner every run and never counted as green; the moment it passes
// the run FAILS so the list gets pruned. A harness that silently skips a known
// failure is exactly the dishonesty this entry exists to remove.
import { assertEquals } from "jsr:@std/assert@1";
import { makeChecker } from "../scripts/lib/expected-red.ts";

Deno.test("an expected-red check that fails is reported as owned, not as a failure", () => {
  const lines: string[] = [];
  const c = makeChecker({ expectedRed: { "settings: contrast": "CAP-FB-X" }, log: (l) => lines.push(l) });
  c.check("settings: contrast", false, { ratio: 2.39 });
  assertEquals(c.counts(), { pass: 0, fail: 0, expectedRed: 1, unexpectedGreen: 0 });
  assertEquals(c.exitCode(), 0);
  assertEquals(lines[0].startsWith("EXPECTED-RED (CAP-FB-X): settings: contrast"), true);
});

Deno.test("an expected-red check that PASSES fails the run so the list is pruned", () => {
  const lines: string[] = [];
  const c = makeChecker({ expectedRed: { "settings: contrast": "CAP-FB-X" }, log: (l) => lines.push(l) });
  c.check("settings: contrast", true);
  assertEquals(c.counts(), { pass: 0, fail: 0, expectedRed: 0, unexpectedGreen: 1 });
  assertEquals(c.exitCode(), 1);
  assertEquals(lines[0].startsWith("UNEXPECTED-GREEN: settings: contrast"), true);
});

Deno.test("ordinary checks count as before and a real failure still exits 1", () => {
  const c = makeChecker({ log: () => {} });
  c.check("a", true);
  c.check("b", false);
  assertEquals(c.counts(), { pass: 1, fail: 1, expectedRed: 0, unexpectedGreen: 0 });
  assertEquals(c.exitCode(), 1);
  assertEquals(c.summary(), "RESULT: 1 passed, 1 failed");
});

Deno.test("the summary names the owned reds so a log reader sees them", () => {
  const c = makeChecker({ expectedRed: { x: "CAP-FB-Y" }, log: () => {} });
  c.check("x", false);
  c.check("y", true);
  assertEquals(c.summary(), "RESULT: 1 passed, 0 failed, 1 expected-red (owned: CAP-FB-Y)");
});

Deno.test("an expected-red entry whose check never ran is reported as stale", () => {
  const c = makeChecker({ expectedRed: { "gone": "CAP-FB-Z" }, log: () => {} });
  c.check("y", true);
  assertEquals(c.stale(), ["gone"]);
  assertEquals(c.exitCode(), 1);
});

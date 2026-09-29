// tests/chrome-journeys-check.test.ts — bead chrome-agent-platform-55o8.
//
// Executes the REAL `formatCheckDetail`, `checkShutdown`, and `check` functions
// extracted from `scripts/chrome-journeys.ts` (the house pattern from
// `tests/journey-cdp-timeout.test.ts` and `tests/journey-scripted-probe.test.ts`
// so importing never launches Chrome).
//
// Invariants pinned:
// 1. When `cond` is truthy and `detail` is provided, output is `PASS: <name>`
//    with NO detail printed.
// 2. When `cond` is falsy and `detail` is provided, output includes `FAIL: <name>`
//    and the JSON-formatted `detail` (with safe fallback when unserializable).
// 3. When `cond` is falsy and `detail` is omitted or `undefined`, output is
//    `FAIL: <name>` without trailing `undefined` or separator noise.
// 4. The duplicate `[co35 undo leg]` per-leg compensation `console.log` is reaped
//    now that `check()` prints its `detail` argument on failure.
// 5. Falsification: the pre-55o8 mutant (`function check(name, cond)` dropping
//    `detail`) fails the detail-on-failure check.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

const source = await Deno.readTextFile(new URL("../scripts/chrome-journeys.ts", import.meta.url));
const start = source.indexOf("function formatCheckDetail(");
const end = source.indexOf("\n/** The exact, ordered set", start);
assert(start >= 0 && end > start, "the real formatCheckDetail/check block in scripts/chrome-journeys.ts must be found");
const checkBlockSource = source.slice(start, end);

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: unknown;
  expectedRed?: string;
  unexpectedGreen?: string;
}

function buildHarness(blockSrc = checkBlockSource, expectedRedEntries: Array<[string, string]> = []) {
  const ran = new Set<string>();
  const shutdownRan = new Set<string>();
  const results: CheckResult[] = [];
  const EXPECTED_RED = new Map<string, string>(expectedRedEntries);
  const logs: string[] = [];
  const fakeConsole = {
    log: (...args: unknown[]) => logs.push(args.map((a) => String(a)).join(" ")),
  };
  const fns = new Function(
    "ran",
    "shutdownRan",
    "results",
    "EXPECTED_RED",
    "console",
    `${blockSrc}\nreturn { check, checkShutdown, formatCheckDetail };`,
  )(ran, shutdownRan, results, EXPECTED_RED, fakeConsole) as {
    check: (name: string, cond: unknown, detail?: unknown) => void;
    checkShutdown: (name: string, cond: unknown, detail?: unknown) => void;
    formatCheckDetail?: (detail: unknown) => string;
  };
  return { ...fns, ran, shutdownRan, results, logs };
}

Deno.test("55o8: when cond is true and detail is provided, output is PASS: <name> with NO detail printed", () => {
  const h = buildHarness();
  const detail = {
    undoClicked: true,
    agentGone: true,
    rowUndone: true,
    agentIdsAfter: [],
    rowAfter: { id: "act-seed-create", undone: true },
  };
  h.check("Activity ledger: a real Undo deletes the agent and marks the row undone", true, detail);

  assertEquals(h.logs, [
    "PASS: Activity ledger: a real Undo deletes the agent and marks the row undone",
  ]);
  assert(
    !h.logs[0].includes("undoClicked") && !h.logs[0].includes("—"),
    `passing check must never print diagnostic detail, got: ${h.logs[0]}`,
  );
  assertEquals(h.results, [
    { name: "Activity ledger: a real Undo deletes the agent and marks the row undone", pass: true },
  ]);
});

Deno.test("55o8: when cond is false and detail is provided, output includes FAIL: <name> and JSON-formatted detail", () => {
  const h = buildHarness();
  const detail = {
    undoClicked: true,
    agentGone: false,
    rowUndone: false,
    createdAgentId: "named:undo-journey-agent",
    agentIdsAfter: ["named:undo-journey-agent"],
    rowAfter: { id: "act-seed-create", undone: false },
  };
  h.check("Activity ledger: a real Undo deletes the agent and marks the row undone", false, detail);

  assertEquals(h.logs.length, 1);
  assertEquals(
    h.logs[0],
    `FAIL: Activity ledger: a real Undo deletes the agent and marks the row undone — ${JSON.stringify(detail)}`,
  );
  assertEquals(h.results, [
    {
      name: "Activity ledger: a real Undo deletes the agent and marks the row undone",
      pass: false,
      detail,
    },
  ]);
});

Deno.test("55o8: when cond is false and detail is omitted or undefined, output is FAIL: <name> without trailing undefined or noise", () => {
  const h = buildHarness();
  h.check("extension loaded", false);
  h.check("SW Runtime.enable succeeded", false, undefined);

  assertEquals(h.logs, [
    "FAIL: extension loaded",
    "FAIL: SW Runtime.enable succeeded",
  ]);
  for (const line of h.logs) {
    assert(!line.includes("undefined"), `omitted/undefined detail must not print 'undefined': ${line}`);
    assert(!line.includes("—"), `omitted/undefined detail must not print a trailing separator: ${line}`);
  }
  assertEquals(h.results, [
    { name: "extension loaded", pass: false },
    { name: "SW Runtime.enable succeeded", pass: false },
  ]);
});

Deno.test("55o8: EXPECTED_RED, checkShutdown, and unserializable detail fallbacks format cleanly on failure only", () => {
  const h = buildHarness(checkBlockSource, [["owned check", "chrome-agent-platform-0000"]]);
  h.check("owned check", false, { groups: ["Browsing", "Content"] });
  assertEquals(
    h.logs[0],
    `EXPECTED-RED (chrome-agent-platform-0000): owned check — {"groups":["Browsing","Content"]}`,
  );

  // Circular object fallback: must not throw during failure reporting.
  const circular: Record<string, unknown> = { label: "cyc" };
  circular.self = circular;
  h.check("circular detail check", false, circular);
  assertEquals(h.logs[1], "FAIL: circular detail check — [object Object]");

  // Shutdown checks print detail only on failure.
  h.checkShutdown("Temp profile directory removed", true, { leftover: ["Default"] });
  h.checkShutdown("No orphan chromium processes remain", false, { pids: [12345] });
  assertEquals(h.logs[2], "PASS: Temp profile directory removed (shutdown)");
  assertEquals(h.logs[3], 'FAIL: No orphan chromium processes remain (shutdown) — {"pids":[12345]}');

  // Duplicate check name still throws.
  assertThrows(
    () => h.check("owned check", true),
    Error,
    "duplicate assertion: owned check",
  );
});

Deno.test("55o8: duplicate co35 per-leg failure compensation console.log is reaped and falsification catches pre-55o8 check()", () => {
  assert(
    !source.includes('console.log("[co35 undo leg]"'),
    "duplicate [co35 undo leg] failure-only compensation console.log must be reaped",
  );
  assert(
    source.includes('"Activity ledger: a real Undo deletes the agent and marks the row undone"'),
    "the co35 undo check() assertion must remain in scripts/chrome-journeys.ts",
  );

  // Falsification control: restore the pre-55o8 check() body that dropped `detail`.
  const mutantBlock = checkBlockSource.replace(
    'console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : formatCheckDetail(detail)}`);',
    'console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);',
  );
  assert(mutantBlock !== checkBlockSource, "mutant replacement must alter the real check() source");
  const mutant = buildHarness(mutantBlock);
  mutant.check("mutant check", false, { groups: ["Browsing"] });
  assertEquals(
    mutant.logs[0].includes('{"groups":["Browsing"]}'),
    false,
    "pre-55o8 mutant drops the detail payload, which the test above requires",
  );
});
